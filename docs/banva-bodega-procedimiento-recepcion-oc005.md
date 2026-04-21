# Procedimiento recepción OC-005 (Idetex)

**Emitida:** 2026-04-20 · **Esperada:** 2026-04-23
**Proveedor:** Idetex · **Neto:** $7.097.896 · **Bruto:** $8.446.496
**49 SKUs · 663 unidades**

Este documento está pensado para ser impreso y colgado al lado del computador de bodega. Lo puede ejecutar Joaquín o Vicho sin programador al costado.

**Tiempo estimado total para 49 SKUs:** 2.5 a 4 horas (contar + etiquetar + ubicar). El vincular la OC son 30 segundos al final.

---

## Parte A — Manual imprimible (1 página)

### Cuando llega el camión de Idetex

#### Paso 1. Registrar la factura con la app "Factura a Etiquetas"

1. Abrir la app en el celular / tablet.
2. Foto a la factura física.
3. Esperar que Gemini extraiga los SKUs y cantidades (~30 seg).
4. **Verificar** que los SKUs/cantidades leídos coincidan con la factura.
5. Botón **"Enviar recepción al WMS"**.
6. Imprimir las etiquetas que genera la app.

La app crea automáticamente:
- 1 registro en `recepciones` (estado CREADA).
- N líneas en `recepcion_lineas` (estado PENDIENTE).

En este punto el stock aún **NO** subió — solo quedó registrada la factura.

---

#### Paso 2. Ciclo de bodega (contar → etiquetar → ubicar)

Entrar al celular a `banvabodega.vercel.app` → **Operador** → PIN → **Recepciones**.

Aparece la recepción recién creada. Por cada SKU de la lista:

a. **Contar** la cantidad física que bajó del camión → registrar en el celular.
b. **Etiquetar** (pegar la etiqueta impresa en cada unidad).
c. **Ubicar** — escanear la posición de bodega donde lo guardan (B-5, A-3, etc.).

Al terminar el último SKU, la app marca la recepción como **COMPLETADA** y el stock físico queda sumado automáticamente en bodega.

---

#### Paso 3. Vincular la recepción a la OC-005

Esta es la parte **nueva** que hay que hacer.

1. Desde el computador de la oficina, abrir `banvabodega.vercel.app/admin`.
2. PIN admin (1234) → pestaña **Compras**.
3. Click sobre la fila **OC-005** (Idetex, EN_TRANSITO).
4. Arriba a la derecha, botón **"Vincular recepción"** (azul).
5. Modal muestra las recepciones Idetex **sin OC**. Seleccionar la recepción recién cerrada (buscar por folio SII de la factura).
6. Confirmar.

El sistema:
- Escribe `orden_compra_id` en la recepción.
- Recalcula `cantidad_recibida` línea por línea de OC-005.
- Si todo llegó → estado pasa a **RECIBIDA**. Si faltó algo → **RECIBIDA_PARCIAL**.

---

#### Paso 4. Cerrar la OC

Sólo si llegó **todo** lo pedido o si Vicente decide aceptar un parcial como cerrado:

1. En el detalle de OC-005, botón **"Cerrar OC"**.
2. Confirmar en el diálogo.
3. Sistema calcula `lead_time_real` (días entre emisión 2026-04-20 y hoy) y `pct_cumplimiento`.
4. Dispara recálculo del motor de inteligencia automáticamente.

Si **NO** llegó todo y esperamos más mercadería: NO cerrar. La OC queda en `RECIBIDA_PARCIAL`. Cuando llegue el segundo despacho, repetir Paso 1-3 con la nueva factura.

---

### Si algo falla

#### La app Etiquetas no lee bien la factura
Registrar manualmente los SKUs/cantidades en la app antes de enviar al WMS. Si insiste, llamar a Vicente antes de hacer otra cosa.

#### El botón "Vincular recepción" no muestra la recepción
Verificar que la recepción tenga `proveedor = "Idetex"` exacto. Algunas vienen con "IDETEX S.A.". Si es el caso → usar script SQL de emergencia (Parte B abajo).

#### El botón "Vincular recepción" da error
Llamar a Vicente. Mientras tanto **no tocar nada más** — el stock físico ya está en bodega si se completó el ciclo del Paso 2, así que no hay urgencia operativa.

#### Llegó más mercadería que la pedida
Al etiquetar/ubicar en Paso 2, el operador puede ingresar la cantidad real (aunque sea más). El sistema registra el exceso. Al vincular con OC-005 queda la diferencia visible en el detalle.

#### Llegó menos mercadería que la pedida (parcial)
Flujo normal. El ciclo del Paso 2 se cierra con lo que llegó. Al vincular en Paso 3, OC-005 queda en `RECIBIDA_PARCIAL`. Cuando llegue el resto con otra factura, repetir el proceso (crea una segunda recepción, se vincula a la misma OC-005, cuando cubre todo cambia a `RECIBIDA` y se puede cerrar).

---

## Parte B — Script SQL de emergencia

Usar **solo si** el botón "Vincular recepción" falla. Ejecutar en Supabase SQL Editor (proyecto banvabodega).

### B.1 — Identificar la recepción a vincular

```sql
SELECT
  r.id,
  r.folio,
  r.created_at::timestamp(0) AS creada,
  r.proveedor,
  r.costo_bruto,
  r.estado,
  COUNT(rl.id) AS lineas,
  SUM(rl.qty_factura) AS uds_factura,
  SUM(rl.qty_recibida) AS uds_recibidas
FROM recepciones r
LEFT JOIN recepcion_lineas rl ON rl.recepcion_id = r.id
WHERE r.proveedor ILIKE '%idetex%'
  AND r.orden_compra_id IS NULL
  AND r.created_at >= now() - interval '7 days'
GROUP BY r.id, r.folio, r.created_at, r.proveedor, r.costo_bruto, r.estado
ORDER BY r.created_at DESC;
```

Anotar el `id` de la recepción (UUID) → **`<REC_ID>`**.

### B.2 — Vincular recepción a OC-005

```sql
UPDATE recepciones
SET orden_compra_id = '34abb464-2dbf-4edb-bd88-8214da237192'
WHERE id = '<REC_ID>';
```

### B.3 — Rellenar `cantidad_recibida` en las líneas de OC-005

El motor lee `cantidad_pedida − cantidad_recibida` para el tránsito. Este UPDATE cruza lo que quedó en `recepcion_lineas.qty_recibida` contra las líneas de OC-005:

```sql
UPDATE ordenes_compra_lineas ocl
SET cantidad_recibida = COALESCE(rec.qty, 0)
FROM (
  SELECT rl.sku, SUM(rl.qty_recibida) AS qty
  FROM recepcion_lineas rl
  JOIN recepciones r ON r.id = rl.recepcion_id
  WHERE r.orden_compra_id = '34abb464-2dbf-4edb-bd88-8214da237192'
  GROUP BY rl.sku
) rec
WHERE ocl.orden_id = '34abb464-2dbf-4edb-bd88-8214da237192'
  AND UPPER(ocl.sku_origen) = rec.sku;
```

### B.4 — Cambiar estado de OC-005 y calcular métricas

Si llegó **todo** lo pedido:

```sql
UPDATE ordenes_compra
SET
  estado = 'CERRADA',
  fecha_recepcion = CURRENT_DATE,
  lead_time_real = (CURRENT_DATE - fecha_emision),
  total_recibido = (
    SELECT COALESCE(SUM(cantidad_recibida), 0)
    FROM ordenes_compra_lineas
    WHERE orden_id = '34abb464-2dbf-4edb-bd88-8214da237192'
  ),
  pct_cumplimiento = (
    SELECT ROUND(
      SUM(cantidad_recibida)::numeric * 100 / NULLIF(SUM(cantidad_pedida), 0),
      1
    )
    FROM ordenes_compra_lineas
    WHERE orden_id = '34abb464-2dbf-4edb-bd88-8214da237192'
  )
WHERE id = '34abb464-2dbf-4edb-bd88-8214da237192';
```

Si llegó **parcial** y se espera más en otra fecha:

```sql
UPDATE ordenes_compra
SET estado = 'RECIBIDA_PARCIAL'
WHERE id = '34abb464-2dbf-4edb-bd88-8214da237192';
```

### B.5 — Disparar recálculo del motor

Desde navegador u otro cliente (no requiere auth):

```
POST https://banvabodega.vercel.app/api/intelligence/recalcular
```

O desde la terminal de Vicente:

```bash
curl -X POST https://banvabodega.vercel.app/api/intelligence/recalcular
```

Toma ~2 minutos. Cuando termina, los 49 SKUs deberían tener `stock_en_transito` reducido y `stock_bodega` aumentado.

---

## Parte C — Verificación post-recepción

Ejecutar cada query en el SQL Editor y validar resultados.

### C.1 — Estado de la OC cambió

```sql
SELECT
  numero, estado, fecha_emision, fecha_recepcion, lead_time_real,
  total_recibido, pct_cumplimiento
FROM ordenes_compra
WHERE id = '34abb464-2dbf-4edb-bd88-8214da237192';
```

**Esperado:**
- `estado` = `CERRADA` (total) o `RECIBIDA_PARCIAL`.
- `fecha_recepcion` = fecha de hoy.
- `lead_time_real` = 3 días (si llega al 2026-04-23 en tiempo).
- `pct_cumplimiento` = 100 si completo, `<100` si parcial.

### C.2 — Líneas de OC con cumplimiento por SKU

```sql
SELECT
  sku_origen,
  nombre,
  cantidad_pedida,
  cantidad_recibida,
  (cantidad_pedida - cantidad_recibida) AS faltante,
  ROUND(cantidad_recibida::numeric * 100 / NULLIF(cantidad_pedida, 0), 1) AS pct
FROM ordenes_compra_lineas
WHERE orden_id = '34abb464-2dbf-4edb-bd88-8214da237192'
ORDER BY faltante DESC, cantidad_pedida DESC;
```

**Esperado:** todos `faltante = 0` si completo. Si parcial, identifica qué SKUs no llegaron.

### C.3 — Motor recalculó `stock_en_transito` a 0

```sql
SELECT
  sku_origen,
  nombre,
  stock_bodega,
  stock_full,
  stock_total,
  stock_en_transito,
  accion
FROM sku_intelligence
WHERE sku_origen IN (
  SELECT sku_origen
  FROM ordenes_compra_lineas
  WHERE orden_id = '34abb464-2dbf-4edb-bd88-8214da237192'
)
ORDER BY stock_en_transito DESC, sku_origen;
```

**Esperado post-recálculo:**
- `stock_en_transito = 0` en todos (si OC cerrada).
- `stock_bodega` aumentó respecto al snapshot previo.
- `accion` ya no debería ser `EN_TRANSITO` (pasan a `OK` / `PLANIFICAR` / lo que corresponda por cobertura).

### C.4 — Velocidad se mantiene (no se borra por recalcular)

```sql
SELECT
  sku_origen,
  vel_ponderada,
  vel_pre_quiebre,
  clase_abc,
  xyz,
  datos_hasta
FROM sku_intelligence
WHERE sku_origen IN (
  SELECT sku_origen
  FROM ordenes_compra_lineas
  WHERE orden_id = '34abb464-2dbf-4edb-bd88-8214da237192'
)
ORDER BY vel_ponderada DESC;
```

**Esperado:**
- `datos_hasta` = fecha de hoy.
- `vel_ponderada` similar a la pre-recepción (la velocidad se calcula con ventas, no con stock).

### C.5 — Recepción quedó vinculada

```sql
SELECT id, folio, proveedor, estado, orden_compra_id, created_at
FROM recepciones
WHERE orden_compra_id = '34abb464-2dbf-4edb-bd88-8214da237192';
```

**Esperado:** una (o varias si parcial) filas con `estado = COMPLETADA` o `CERRADA`, `orden_compra_id` seteado.

---

## Resumen ejecutivo

| Fase | Responsable | Tiempo | Herramienta |
|---|---|---|---|
| 1. Registrar factura | Joaquín | 5 min | App Etiquetas |
| 2. Ciclo bodega (49 SKUs) | Joaquín | 2-3 h | `/operador/recepciones` móvil |
| 3. Vincular a OC-005 | Vicho / Vicente | 30 seg | `/admin/compras` botón |
| 4. Cerrar OC | Vicente | 30 seg | `/admin/compras` botón |
| 5. Verificar (C.1 a C.5) | Vicente | 5 min | Supabase SQL Editor |

**Total estimado:** 2.5 a 4 horas, casi todo es el ciclo físico de bodega (contar/etiquetar/ubicar). La parte administrativa (vincular + cerrar) toma 1 minuto.

**Contacto de emergencia:** Vicente → escalar cualquier error del SQL o comportamiento extraño del sistema.

---

## Cómo imprimir

Abrir este archivo en cualquier visor Markdown (VS Code con preview, o el viewer de GitHub) → `Cmd+P` → imprimir. La Parte A cabe en una página. Opcionalmente se puede convertir a PDF con `Print → Save as PDF`.

No se generó PDF automático en este commit porque no hay herramienta instalada para hacerlo sin agregar dependencias. Si se necesita formalmente, ejecutar una vez:

```bash
cd ~/banvabodega
npx md-to-pdf docs/banva-bodega-procedimiento-recepcion-oc005.md
```

Eso genera `docs/banva-bodega-procedimiento-recepcion-oc005.pdf`.
