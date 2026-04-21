# Bug — `ordenes_compra_lineas.cantidad_recibida` no se actualiza al vincular recepción

**Fecha detección:** 2026-04-21
**Severidad:** Alta en recepciones parciales / multi-entrega. Baja-Media si toda la OC llega en un solo camión.
**Scope:** sólo investigación. Sin fix aplicado.

---

## Síntoma

Al apretar **Vincular recepción** en `/admin/compras`, se seta `recepciones.orden_compra_id` pero **nada actualiza** `ordenes_compra_lineas.cantidad_recibida`. La columna queda en `0` (default al crear la línea) hasta siempre.

## Evidencia

### Código

`src/components/AdminCompras.tsx:440-449` — handler `vincular`:

```ts
const vincular = useCallback(async (recId: string) => {
  if (!selectedOC) return;
  setProcesando(true);
  await vincularRecepcionOC(recId, selectedOC.id!);  // ← sólo seta orden_compra_id en recepciones
  await insertAdminActionLog("vincular_recepcion_oc", ...);
  setModalVincular(false);
  setProcesando(false);
  openDetail(selectedOC);
}, [selectedOC, openDetail]);
```

`src/lib/db.ts:3053`:

```ts
export async function vincularRecepcionOC(recepcionId: string, ordenCompraId: string) {
  const sb = getSupabase(); if (!sb) return;
  await sb.from("recepciones").update({ orden_compra_id: ordenCompraId }).eq("id", recepcionId);
}
```

### Cálculo in-memory en UI

`AdminCompras.tsx:340-353` — `recibidoPorSku` Map que agrega `recepcion_lineas.qty_recibida` de las recepciones vinculadas. **Nunca se persiste** a `ordenes_compra_lineas`. Sólo sirve para mostrar el % de progreso en pantalla.

### Cálculo del motor

`src/app/api/intelligence/recalcular/route.ts:168-180`:

```ts
for (const linea of ocLineas) {
  const pendiente = (linea.cantidad_pedida || 0) - (linea.cantidad_recibida || 0);
  if (pendiente > 0) {
    stockEnTransito.set(linea.sku_origen,
      (stockEnTransito.get(linea.sku_origen) || 0) + pendiente);
  }
}
```

Con `cantidad_recibida = 0` siempre: `pendiente = cantidad_pedida`. El motor ve siempre el tránsito original hasta que la OC se cierra.

### Query de validación

OC-005 tiene 49 líneas, todas con `cantidad_recibida = 0` (correcto porque la mercadería aún no llegó). El problema emergerá en cuanto Joaquín registre la primera recepción y la vincule — las líneas seguirán en 0 aunque la UI muestre "X% recibido".

### Sin triggers en DB

Query ejecutada 2026-04-21:

```sql
SELECT trigger_name, event_manipulation, action_statement
FROM information_schema.triggers
WHERE event_object_table IN (
  'recepciones', 'recepcion_lineas', 'ordenes_compra', 'ordenes_compra_lineas'
);
-- → 0 filas
```

Búsqueda en migraciones: sólo `supabase-v15-sku-intelligence.sql:295` (DEFAULT 0 al crear) y `supabase-v28-qty-reserved.sql:271` (lectura en una vista). Ningún INSERT/UPDATE de la columna.

## Impacto por escenario

### A. OC llega toda en un solo camión

- Secuencia: vinculo 1 recepción → UI auto-calcula `estado = RECIBIDA` → admin aprieta **Cerrar OC**.
- Al cerrar: `estado = CERRADA` → motor deja de leer esas líneas (filtro `.in(PENDIENTE/EN_TRANSITO/RECIBIDA_PARCIAL)`).
- `stock_en_transito` pasa correcto 663 → 0 en el recálculo siguiente.
- **Impacto: bajo.** El usuario nunca ve el estado intermedio inconsistente.

### B. OC llega en 2+ camiones parciales

- Secuencia: vinculo recepción #1 (300 uds de 20 SKUs) → `estado = RECIBIDA_PARCIAL`.
- Motor sigue leyendo líneas porque filtro incluye `RECIBIDA_PARCIAL`. Con `cantidad_recibida = 0`, el motor ve `stock_en_transito = 663` **aunque 300 ya estén físicamente en bodega**.
- Joaquín/Vicho pueden pasar días esperando el segundo camión con el motor en este estado falso.
- El motor puede recomendar **pedir otra OC** porque "663 en tránsito pero SKU X en AGOTADO_SIN_PROVEEDOR" es matemáticamente inconsistente con que ya haya stock físico.
- **Impacto: alto**. Potencial compra duplicada al proveedor.

### C. OC llega incompleta definitivamente (Idetex no mandó X uds)

- Secuencia: vinculo recepción única (45 uds de SKU X con `cantidad_pedida = 50`) → admin aprieta **Cerrar OC**.
- `estado = CERRADA`, `pct_cumplimiento = 90` pero `cantidad_recibida` en la línea sigue en 0.
- Motor deja de leer → `stock_en_transito` = 0 para SKU X, correcto en lo que respecta al tránsito.
- El faltante de 5 uds queda registrado sólo en `ordenes_compra.pct_cumplimiento` como métrica de cumplimiento del proveedor, no en la línea específica.
- **Impacto: bajo** (el motor ve la realidad al final), **pero perdemos trazabilidad por SKU** de qué SKU falló y por cuánto.

## Origen del bug

Arqueología del código sugiere que el flujo original fue pensado como:

1. Vincular recepción (sólo linkea la referencia).
2. Admin **cierra OC** al final (único evento que mueve el estado a terminal).
3. `pct_cumplimiento` calculado sobre `recepcion_lineas.qty_recibida` sumado (lo hace `cerrarOC`).

Esto es **suficiente para caso A**. Se rompe cuando se agregó el estado `RECIBIDA_PARCIAL` via `calcEstadoAuto` (que corre en `useEffect`) sin completar la lógica correspondiente de propagar `cantidad_recibida` al mismo tiempo. Resultado: el estado intermedio existe pero es cosmético — los números por SKU no bajan.

## Fix propuesto (no aplicado)

Dos opciones equivalentes:

### Opción 1 — En `vincular()` (frontend)

Tras `vincularRecepcionOC`, agregar un UPDATE que propague los `qty_recibida` de `recepcion_lineas` a `ordenes_compra_lineas.cantidad_recibida`. El SQL exacto ya está documentado en `docs/banva-bodega-procedimiento-recepcion-oc005.md` § Parte B.3 — sólo hay que trasladar al handler.

**Estimación:** 30 min (nuevo helper `propagarCantidadRecibidaACompra(ordenId)` en `db.ts` + 2 líneas en handler).
**Pro:** fix localizado, se puede probar fácil en dev.
**Contra:** si se agrega otra ruta de vinculación (API externa, trigger desde app Etiquetas), el bug vuelve.

### Opción 2 — Trigger en DB (backend)

Trigger `AFTER INSERT OR UPDATE` en `recepcion_lineas` que, si su `recepciones.orden_compra_id IS NOT NULL`, recalcula `ordenes_compra_lineas.cantidad_recibida` sumando `recepcion_lineas.qty_recibida` de todas las recepciones vinculadas a esa OC con mismo SKU.

**Estimación:** 20-30 min (función PL/pgSQL + trigger) + migración v57.
**Pro:** cubre cualquier ruta de vinculación. Garantía fuerte.
**Contra:** lógica invisible en UI, requiere migración manual en prod.

### Recomendación

**Opción 2 (trigger)** porque la app Etiquetas algún día podría escribir `orden_compra_id` directo (Opción B de pre-auditoría PR7) y el trigger lo soporta sin cambios en código. Además va alineado con Regla 5 del `inventory-policy.md`: fuente única canónica + lecturas derivadas — el trigger convierte `cantidad_recibida` en derivada automática de `recepcion_lineas`.

## Mitigación hasta que el fix esté en prod

El procedimiento OC-005 (`docs/banva-bodega-procedimiento-recepcion-oc005.md` actualizado) explica que:

- Si OC-005 llega toda junta → flujo normal, cerrar OC, el motor se recalcula solo.
- Si OC-005 llega en 2+ camiones → después de cada vinculación, correr manualmente el SQL de Parte B.3 para propagar `cantidad_recibida`. Sin este paso, el motor sigue viendo las 663 en tránsito aunque ya haya llegado parte.

## Tickets a abrir

1. **Aplicar Opción 2** (trigger) → migración v57 + función + RLS policies. Scope: 1 commit en banvabodega.
2. **Test de regresión:** agregar `src/lib/__tests__/ordenes-compra-trigger.test.ts` con fixture que crea OC, vincula recepción parcial, valida que `cantidad_recibida` subió solo.
3. **Actualizar Regla 5** de `.claude/rules/inventory-policy.md` con este caso histórico.
