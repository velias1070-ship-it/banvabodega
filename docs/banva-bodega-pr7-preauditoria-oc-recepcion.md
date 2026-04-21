# PR7 Pre-auditoría — Vinculación OC ↔ Recepción

**Fecha:** 2026-04-21
**Motivador:** OC-005 (EN_TRANSITO, Idetex, 49 SKUs, 663 uds, $8.44M) llega el 2026-04-23. Si la app Etiquetas la ingresa sin vincular a OC-005, el motor seguirá contando 663 uds como en tránsito aunque ya estén físicamente en bodega → decisiones distorsionadas por semanas.

**Scope:** solo investigación. Sin código de fix.

---

## 1. Cómo funciona la app Etiquetas HOY

Fuente: `~/.claude/memory/reference_factura_etiquetas_app.md` + validación en DB 2026-04-21.

**Servicio separado** (no vive en banvabodega). Código en repo externo, web app con Gemini Vision. Habla directo contra Supabase de banvabodega usando anon key — **no pasa por ningún endpoint del WMS**.

Contrato exacto al apretar "Enviar recepción al WMS" (ref app externa `index.html:128-196`):

1. Upload foto a Storage `banva/facturas/{folio}_{ts}.jpg`.
2. `INSERT INTO recepciones` con:
   ```
   folio, proveedor, imagen_url, estado='CREADA',
   costo_neto, iva, costo_bruto, notas='',
   created_by='App Etiquetas'
   ```
   **`orden_compra_id` no se setea — queda NULL siempre.**
3. `INSERT INTO recepcion_lineas` (una por SKU) con `estado='PENDIENTE'`, `qty_factura>0`, `qty_recibida=0` (banvabodega la llena al etiquetar/ubicar), `orden_compra_linea_id=NULL`.

División de responsabilidades: la app sólo crea `CREADA` + `PENDIENTE`. Banvabodega ejecuta contar → etiquetar → ubicar → cerrar vía `/operador/recepciones` + RPC `registrar_movimiento_stock`.

**Validación en DB 2026-04-21:** 14 recepciones en últimos 21 días, 13/14 son de Idetex. **Todas tienen `orden_compra_id = NULL`**. Costo total ~$28M.

## 2. Identificación de OC desde factura

Una factura Idetex típica **no tiene número de OC impreso** — sólo folio SII (p.ej. 528547, 528229). La OC es interna de banvabodega (`OC-005`), Idetex no la conoce.

**Heurística viable**: cruzar `recepcion_lineas.sku` con `ordenes_compra_lineas.sku_origen` de OCs `EN_TRANSITO | PENDIENTE | RECIBIDA_PARCIAL` del mismo proveedor. Query de validación 2026-04-21:

| Recepción | Fecha | SKUs totales | SKUs que están en OC-005 |
|---|---|---|---|
| 528547 | 04-16 | 15 | **0** ← compra "suelta" |
| 528229 | 04-16 | 20 | **6** |
| 527489 | 04-13 | 16 | **4** |
| 527488 | 04-13 | 17 | **5** |
| 527492 | 04-13 | 16 | **4** |
| 527163 | 04-09 | 18 | **6** |
| 526987 | 04-09 | 12 | **5** |

**Hallazgo crucial:** OC-005 emitida 2026-04-20 pero los SKUs de su pedido ya aparecían en recepciones de 1-2 semanas antes. Dos interpretaciones:
- La OC se escribe **después** de que llega la mercadería (documentación ex-post), no antes.
- Los SKUs son recurrentes y Idetex los despacha en múltiples facturas parciales.

En cualquier caso, el matching 1-a-1 recepción ↔ OC será ruidoso. El match exacto por `sum(qty)` por SKU raramente va a ser 100%.

## 3. Código actual que ya existe

**Sorpresa buena:** el WMS **ya tiene UI + backend para vincular manualmente** (commit previo):

- `src/lib/db.ts:3053` → `vincularRecepcionOC(recepcionId, ordenCompraId)` hace `UPDATE recepciones SET orden_compra_id = ? WHERE id = ?`.
- `src/lib/db.ts:3066` → `fetchRecepcionesSinOC(proveedor)` devuelve recepciones sin OC del mismo proveedor.
- `src/components/AdminCompras.tsx:433-449` → botón "Vincular recepción" en detalle de OC. Lista las recepciones del proveedor sin OC y el admin apretá una.
- Al vincular, `AdminCompras.tsx:493-519` auto-calcula el estado de la OC (`RECIBIDA_PARCIAL`/`RECIBIDA`) comparando `recibidoPorSku` vs `cantidad_pedida`.
- Al **cerrar** la OC (botón manual), calcula `lead_time_real = fecha_ultima_recepcion - fecha_emision` y `pct_cumplimiento`.

**Lo que el flujo actual no hace:**
- La app Etiquetas desconoce por completo este flujo → vinculación nunca sucede en automático.
- No hay cron ni trigger que intente el match.
- El motor de inteligencia lee `ordenes_compra_lineas.cantidad_pedida − cantidad_recibida` para calcular `stock_en_transito`. **Nada aumenta `cantidad_recibida` hasta que alguien cierra la OC vía `AdminCompras`**.

## 4. Las 3 opciones — evaluación

### Opción A — Matching automático fuzzy al crear la recepción

**Quién implementa:** la app Etiquetas (código externo).
Al confirmar recepción, hace query a `ordenes_compra` con `estado IN ('EN_TRANSITO','PENDIENTE','RECIBIDA_PARCIAL')` y `proveedor = X`. Si hay exactamente una OC y ≥60% de SKUs de la factura están en sus líneas, auto-setea `orden_compra_id`.

| Dimensión | Evaluación |
|---|---|
| Esfuerzo | Medio — ~50 LOC en app externa + 1 query. ½ día. |
| Tasa de éxito | **Media** (~40%). El histórico muestra overlaps de 0 a 6 SKUs sobre 15-20. Muchas facturas parciales sin OC clara. |
| Riesgos | Falsos positivos (vincular a OC equivocada) en período con 2+ OCs Idetex abiertas. Difícil de deshacer. |

### Opción B — Selector manual en app Etiquetas

**Quién implementa:** la app Etiquetas.
Después de OCR y antes de confirmar, muestra dropdown "¿a qué OC corresponde? [OC-005 / OC-004 / sin OC]".

| Dimensión | Evaluación |
|---|---|
| Esfuerzo | Bajo — ~30 LOC. Una query + dropdown + pasar el id en el INSERT. 1-2 h. |
| Tasa de éxito | **Alta** (~95%) si el operador sabe cuál OC corresponde. El operador Joaquín ve las facturas físicas y conoce qué pedido llegó. |
| Riesgos | Operador apura y selecciona "sin OC" por default. Mitigación: validación soft (si hay OC abierta, pedir confirmación). |

### Opción C — Post-processing cron en BANVA

**Quién implementa:** banvabodega (código interno, no toca app externa).
Cron diario (/api/intelligence/vincular-recepciones-sin-oc) revisa recepciones sin OC de últimos 14 días. Para cada una, busca OCs abiertas del mismo proveedor, calcula % overlap de SKUs + deltas de `sum(qty_factura) vs cantidad_pedida`. Si hay exactamente un match con overlap ≥70% y delta ≤20%, vincula automático + logea en `admin_actions_log`.

| Dimensión | Evaluación |
|---|---|
| Esfuerzo | Medio-alto — ~150 LOC + nueva ruta + cron. 1-2 días. |
| Tasa de éxito | **Media-baja** (~35%). Mismo problema de overlaps bajos del histórico. Muchos casos van a quedar sin vincular igual. |
| Riesgos | Vincula OC equivocada si Idetex tiene 2 OCs abiertas con SKUs parcialmente solapados. Auditable, reversible. |

## 5. Recomendación

**Opción B** (selector manual en app Etiquetas) + una mejora interna chica en banvabodega:

1. **App Etiquetas (repo externo)** — agregar dropdown que consulte `ordenes_compra` con estado abierto. Joaquín elige manualmente al momento de registrar. Le toma 5 segundos por factura. Esfuerzo 1-2 h.

2. **Banvabodega (este repo)** — agregar badge/aviso en `AdminCompras` que destaque recepciones sin OC del mismo proveedor cuando se abre una OC `EN_TRANSITO`. Ya existe `fetchRecepcionesSinOC` (`db.ts:3066`) y el botón "Vincular" (`AdminCompras.tsx:433`). Sólo hace falta hacerlo más visible y auto-abrir el modal al llegar a una OC con 0 recepciones vinculadas. Esfuerzo 1 h.

**Por qué no A ni C:** el overlap histórico (0-6 SKUs de 15-20, o sea <40%) hace que cualquier algoritmo automático se equivoque más de lo que acierta. El operador humano que ve la factura sabe identificarla con >95% de precisión y le toma segundos.

## 6. Solución puente para OC-005

Cuando llegue el 2026-04-23 (o cuando Joaquín reciba la mercadería y la pase por app Etiquetas):

1. Joaquín registra la recepción vía app Etiquetas como siempre → queda con `orden_compra_id = NULL`.
2. Vicente entra a `/admin` → pestaña Compras → abre OC-005 → botón "Vincular recepción" → selecciona la recepción Idetex que corresponda.
3. El WMS auto-calcula `cantidad_recibida` por SKU y dispara estado = `RECIBIDA_PARCIAL` o `RECIBIDA`.
4. Cuando se vincule todo lo que vino, Vicente aprieta "Cerrar OC" → calcula `lead_time_real` y `pct_cumplimiento`.

**Script SQL de emergencia** (usar sólo si el botón de UI falla):

```sql
-- Paso 1: ver recepciones Idetex sin OC de últimos 7 días
SELECT r.id, r.folio, r.created_at, r.costo_bruto,
       COUNT(rl.id) AS lineas,
       COUNT(DISTINCT rl.sku) FILTER (
         WHERE rl.sku IN (
           SELECT sku_origen FROM ordenes_compra_lineas
           WHERE orden_id = '34abb464-2dbf-4edb-bd88-8214da237192'
         )
       ) AS skus_match_oc005
FROM recepciones r
LEFT JOIN recepcion_lineas rl ON rl.recepcion_id = r.id
WHERE r.proveedor ILIKE '%idetex%'
  AND r.orden_compra_id IS NULL
  AND r.created_at >= now() - interval '7 days'
GROUP BY r.id
ORDER BY r.created_at DESC;

-- Paso 2: vincular (reemplazar <REC_ID> por el id de arriba)
UPDATE recepciones
SET orden_compra_id = '34abb464-2dbf-4edb-bd88-8214da237192'
WHERE id = '<REC_ID>';

-- Paso 3: al cerrar, marcar OC como recibida y setear métricas
UPDATE ordenes_compra
SET estado = 'CERRADA',
    fecha_recepcion = CURRENT_DATE,
    lead_time_real = (CURRENT_DATE - fecha_emision),
    total_recibido = (
      SELECT COALESCE(SUM(cantidad_recibida), 0)
      FROM ordenes_compra_lineas
      WHERE orden_id = '34abb464-2dbf-4edb-bd88-8214da237192'
    ),
    pct_cumplimiento = (
      SELECT COALESCE(ROUND(SUM(cantidad_recibida)::numeric * 100 / NULLIF(SUM(cantidad_pedida), 0), 1), 0)
      FROM ordenes_compra_lineas
      WHERE orden_id = '34abb464-2dbf-4edb-bd88-8214da237192'
    )
WHERE id = '34abb464-2dbf-4edb-bd88-8214da237192';

-- Paso 4: disparar recálculo del motor (no baja stock_en_transito hasta que no corra)
-- POST https://banvabodega.vercel.app/api/intelligence/recalcular
```

**Limitación conocida:** `cantidad_recibida` en `ordenes_compra_lineas` la llena banvabodega **sólo cuando el operario completa el ciclo recepción (conteo → etiquetado → ubicación)**. Si Joaquín solo registra la factura pero no la etiqueta ese día, `cantidad_recibida` queda en 0 y el motor sigue viendo las 663 uds en tránsito. El flujo actual requiere cerrar físicamente la recepción para que los números cuadren.

---

## Resumen ejecutivo

1. **App Etiquetas** es externa, habla directo con Supabase via anon key, no pasa por API del WMS. Siempre escribe `orden_compra_id = NULL` en `recepciones`. 14/14 recepciones últimos 21 días sin vincular.
2. **El WMS ya tiene el flujo de vinculación manual** (`AdminCompras.tsx:433-449` + `vincularRecepcionOC`). Nadie lo está usando.
3. **Matching automático no es viable** — overlap histórico factura ↔ OC es <40%. Falsos positivos seguros.
4. **Recomendación: Opción B** — dropdown en app Etiquetas para que Joaquín elija OC al registrar. ~1-2 h de esfuerzo, >95% éxito.
5. **Mejora complementaria:** en `AdminCompras`, destacar recepciones sin OC del mismo proveedor. ~1 h.
6. **Puente OC-005:** usar botón "Vincular recepción" en `/admin/compras` cuando llegue la mercadería. Script SQL de emergencia armado en §6 si el botón falla.
7. **Limitación estructural:** `cantidad_recibida` sólo baja cuando se completa el ciclo bodega (contar/etiquetar/ubicar). Hasta entonces el motor sigue viendo el tránsito.
8. **Deuda:** 66 recepciones históricas huérfanas — no se pueden vincular retroactivamente a OCs porque no existían OCs en esas fechas. Sólo vale el esfuerzo vincular OC-005 en adelante.
