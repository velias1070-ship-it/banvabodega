# PR6b-pivot — Pre-auditoría: sync BANVA↔ML (stock)

Fecha: 2026-04-20. Sin código escrito. Reemplaza a `pr6b-preauditoria.md` (pausa ads)
tras el diagnóstico empírico que mostró que el mecanismo `hold` de ML ya congela spend
en los casos críticos, y que el gap real es **desincronización de stock BANVA↔ML**.

---

## 1. Tamaño del problema

### 1.1 Universo total (query 1a, 533 SKUs activos en `sku_intelligence`)

| Métrica | Valor |
|---|---:|
| SKUs vinculados (con `ml_items_map` activo) | 533 |
| **BANVA=0 y ML>0 (fantasma en ML)** | **23 SKUs** |
| BANVA>0 y ML=0 (no publicado en ML) | 15 SKUs |
| Ambos >0, distintos (diferencia positiva) | 222 SKUs |
| Iguales | 273 SKUs |
| **Unidades fantasma en ML** | **225 uds** |
| Unidades no publicadas en ML (BANVA tiene, ML no) | 267 uds |
| Unidades BANVA mayor (BANVA > ML, ambos > 0) | **2 162 uds** |
| Unidades ML mayor (ML > BANVA, ambos > 0) | 3 uds |

**Hallazgo gordo no pedido**: el problema dominante no es "fantasmas en ML" (225 uds)
sino **"stock que BANVA tiene y ML no está publicando"** (267 no publicado + 2 162 BANVA-mayor =
**2 429 uds subexpuestas**). Ventas perdidas potenciales significativamente mayores que los
ahorros de ads evaluados ayer. Fuera de scope PR6b-pivot pero a documentar para Sprint 7.

### 1.2 Top 20 BANVA=0 / ML>0 (los "fantasmas")

| # | sku_origen | ML | status_ml | último_push | edad_cache |
|---|---|---:|---|---|---|
| 1 | LICAAFVIS5746X1 | 58 | active | 2026-04-17 | 3 d |
| 2 | LA-BIB-9 | 36 | active | 2026-04-17 | 3 d |
| 3 | LA-BIB-29 | 23 | active | 2026-04-19 | 1 d |
| 4 | LA-LA-8 | 20 | active | 2026-04-17 | 3 d |
| 5 | TXALMILLVIS46X2 | 15 | active | 2026-04-13 | 7 d |
| 6 | LA-LA-13 | 13 | active | 2026-04-17 | 3 d |
| 7 | BI-BIB-10 | 10 | active | 2026-04-17 | 3 d |
| 8 | RAPAC50X70AFAX4 | 9 | active | 2026-04-20 | 1 h |
| 9 | TXV24QLBRMA20 | 8 | active | **NULL** | 21 d |
| 10 | TXV24QLBRAM20 | 6 | active | **NULL** | 21 d |
| 11 | TXV23QLRM15PR | 5 | active | **NULL** | 21 d |
| 12 | 9788490734599 | 4 | active | **NULL** | 21 d |
| 13 | TXV23QLRM15OV | 4 | active | **NULL** | 21 d |
| 14 | 9788490731307 | 4 | active | **NULL** | 21 d |
| 15 | JSAFAB438P10W | 2 | active,closed | 2026-04-06 | 14 d |
| 16-20 | JSCNAE*/SPAFE40… | 1 × 5 | paused | NULL | NULL |

**Dos sub-grupos evidentes:**

- **Nunca sincronizados** (`ultimo_sync=NULL`, 11 filas): items que se mapearon en
  `ml_items_map` y jamás entraron a `syncStockToML`. Confirmado por query extra:
  los 6 del grupo 9-14 tienen **0 entries en `audit_log` con `accion LIKE 'stock_sync%'`**.
  El cron nunca los vio.

- **Sincronizados antes del último movimiento de stock** (edad_cache 1-7 d): el item sí
  se sincronizó alguna vez, pero el cambio de stock posterior (venta, recepción,
  ajuste) no volvió a encolar → ML mantuvo la foto vieja.

### 1.3 Oversell real últimos 30 d (ventas a SKUs BANVA=0)

| Métrica | Valor |
|---|---:|
| Órdenes a SKUs con `stock_total=0` hoy | **96** |
| SKUs origen distintos afectados | 18 |
| Unidades totales vendidas | 97 |

Nota: muchas de esas ventas pueden haberse cumplido desde Full (ML tenía el stock
real, BANVA lo perdió en algún desync) o estar en cola Flex. La query no distingue
entre "oversell real cancelable" y "venta Full que BANVA no registra". Para
cuantificar el daño efectivo hay que cruzar con `ml_shipments.status`: fuera de
scope de esta pre-auditoría (1-2 h extra).

---

## 2. Mecanismo actual de sync

### 2.1 Código relevante

| Archivo:línea | Responsabilidad |
|---|---|
| `vercel.json` | Cron `/api/ml/stock-sync` **cada 1 min** |
| `src/app/api/ml/stock-sync/route.ts:48` | `SELECT sku FROM stock_sync_queue ORDER BY created_at`. Si vacío → `queue empty`. |
| `src/app/api/ml/stock-sync/route.ts:116-150` | Loop por SKU (55 s time limit), batch max ~275 SKUs/ejecución |
| `src/app/api/ml/stock-sync/route.ts:140` | `syncStockToML(sku, available)` — PUT a ML con x-version |
| `src/lib/ml.ts:1354` | `syncStockToML`: PUT `/user-products/{id}/stock/type/{tipo}`, optimistic locking |
| `src/lib/db.ts:2010` | `enqueueAndSync(skus)`: upsert a `stock_sync_queue` + fetch inmediato al endpoint |
| `src/lib/ml.ts:847` | Webhook shipments → upsert cola para SKUs afectados |
| `src/app/api/ml/stock-sync/route.ts:41` | Manual `?enqueue_all=1`: encola todos los activos (cubre gap temporal) |

### 2.2 Puntos de entrada a la cola

| Callsite | Disparador |
|---|---|
| `store.ts:684,755,964,1209,1437,1473,1641,1787,2157,2528,2571,2615,2658,2741` | Operaciones del motor / UI (entrada, salida, transferencia, reparación de composición, ajustes) |
| `operador/page.tsx:655` | Escaneos del operador |
| `admin/page.tsx:4721,5037` | Acciones del admin (stock manual, edición de producto) |
| `AdminInteligencia.tsx:1172` | Reconciliar reservas manual |
| `ml.ts:847` | Webhook shipments de ML (tras procesar) |
| `stock-sync/route.ts:41` | `?enqueue_all=1` manual one-shot |

### 2.3 Estado actual de la cola

| Métrica | Valor |
|---|---:|
| Entries en `stock_sync_queue` ahora | **0** |
| Entries viejas (>1 h) | 0 |
| Últimas 24 h audit_log `stock_sync:entry` | 35 |
| Últimas 24 h audit_log `stock_sync:debug` | 38 |

El cron corre limpio (35 syncs las últimas 24 h). Cuando la cola tiene SKUs, los
procesa sin error. **El problema no es el cron — es que la cola no se alimenta
para cambios que no pasan por UI/webhook**.

---

## 3. Causa raíz

**Confirmada: Hipótesis B — "Push no se dispara en todos los casos".**

Puntos que NO encolan hoy (y por eso generan fantasmas):

1. **Alta inicial de items en `ml_items_map`**: cuando un SKU se mapea (manual o via
   `items-sync`), no se encola automáticamente. Los 6 SKUs con `ultimo_sync=NULL`
   llevan 21 días mapeados sin haber enviado su stock real a ML. ML publica el valor
   con el que el item se creó en su lado (típicamente 1 unidad de prueba).

2. **Recepciones desde app externa factura-etiquetas**: escribe directo a Supabase
   (`stock` / `recepciones`), no pasa por `store.ts:entrada`, no encola.

3. **Cambios por cron `sync-stock-full`**: actualiza `stock_full_cache` pero no
   encola. Si `stock_total = stock_bodega + stock_full` cambia, el item no vuelve a
   sincronizar.

4. **Anulaciones / webhook de shipment "not_delivered"**: el webhook sí encola
   (ml.ts:847) pero solo si el `shipmentId` se reprocesa. Casos donde el stock se
   libera por otro path (RPC `liberar_reserva` manual, reconciliación) no encolan.

5. **Divergencias por `stock_version` mismatch**: `syncStockToML` reintenta una
   vez en VERSION_CONFLICT (ml.ts:1342), después deja el item desincronizado
   silenciosamente. No hay alerta.

No hay **reconciliador periódico** que encole "todos los activos" para garantizar
convergencia. El diseño es puramente event-driven, y los eventos que lo alimentan
cubren solo una fracción de los paths que mutan el stock.

Hipótesis alternativas (descartadas):

- **A (cron falla)**: descartada. Últimas 24 h: 35 syncs OK.
- **C (ML rechaza updates)**: descartada para los `NULL`. No hay entries en
  `audit_log` stock_sync para esos SKUs — ni siquiera llegaron a intentar.
  Puede existir como problema secundario en los de 1-7 d edad, pero no es causa raíz.
- **D (cálculo mal)**: descartada como causa dominante. El cálculo
  `FLOOR((disponible - buffer) / unidades_pack)` es razonable. Puede tener edge
  cases (ver §6) pero no explica 21 días sin ningún intento.

---

## 4. Escenarios de scope del PR

### Tamaño S — Reconciliador periódico (~120 LOC, 1 día)

Opción mínima que arregla el gap dominante sin tocar lógica de cálculo ni
trigger de DB:

1. Nuevo cron `/api/ml/stock-reconcile` cada 1 h (o 6 h):
   - Selecciona SKUs de `ml_items_map` WHERE `activo=true`
   - Filtra por `ultimo_sync IS NULL OR ultimo_sync < now() - interval '6 hours'`
     OR `stock_flex_cache <> disponible calculado`
   - Upsert a `stock_sync_queue`
2. No hace push directo — deja que el cron `/api/ml/stock-sync` existente procese
   como siempre.
3. Observabilidad: `audit_log` entry `stock_reconcile:summary` con
   `{candidatos, encolados, edad_max_dias}`.
4. Tests unitarios del selector (5 casos: NULL, fresco, stale, mismatch, inactivo).

**Ventaja**: bajo riesgo, toca solo un endpoint nuevo, no altera el cálculo ni el
path de encolado existente. Elimina el bug de "nunca sincronizados" en ≤1 h tras
deploy.

### Tamaño M — Reconciliador + cobertura encolado + observabilidad (~350 LOC, 2 días)

Incluye S más:

5. Trigger en `ml_items_map` INSERT → encolar automáticamente al mapear (elimina
   el caso "21 días sin sync").
6. Hook en `sync-stock-full` post-update: encolar SKUs que cambiaron cantidad.
7. Alerta + panel en AdminInteligencia: "N SKUs con divergencia BANVA↔ML > X"
   con link a `stock-health`.
8. Retry con backoff en VERSION_CONFLICT: de 1 retry a 3 con 100/500/2000 ms.

### Tamaño L — Rearquitectura (~800 LOC, 3-5 días)

No lo quiero. Sería trigger de DB en tabla `stock`, subscription realtime,
debounce, batching… overkill para un reconciliador cada 1 h.

### Recomendado

**S para PR6b-pivot**. Si después de 1 semana sigue habiendo fantasmas residuales,
subir a M en PR6c. La hipótesis es que el 80-90 % del gap lo cierra el
reconciliador periódico solo.

---

## 5. Quick wins (<1 h) para los casos críticos de hoy

### Quick win A — One-shot manual ya

```
POST https://banvabodega.vercel.app/api/ml/stock-sync?enqueue_all=1
```

Encola los 533 activos. El mismo endpoint los procesa en batches de ~275 en
55 s cada uno → ≤2 ejecuciones del cron (2 min) para limpiar. Cero código,
cero riesgo nuevo, resuelve los 23 SKUs fantasma + los 15 no publicados **hoy**.

### Quick win B — Encolar solo los 23 fantasmas + 15 no publicados

Más quirúrgico. Query directa:

```sql
INSERT INTO stock_sync_queue (sku, created_at)
SELECT DISTINCT mim.sku, now()
FROM ml_items_map mim
JOIN sku_intelligence si ON si.sku_origen = mim.sku
WHERE mim.activo = true
  AND ((si.stock_total = 0 AND mim.available_quantity > 0)
       OR (si.stock_total > 0 AND mim.available_quantity = 0))
ON CONFLICT (sku) DO NOTHING;
```

38 filas encoladas, el cron las procesa en la próxima ejecución. Mismo efecto
para los casos auditados, menor churn sobre los 495 ya alineados.

**Recomendación**: ejecutar **A** una vez (full reconciliation) tras el fix, y
dejar el cron nuevo tamaño S haciendo B automáticamente cada 1 h de ahí en
adelante.

---

## 6. Riesgos de tocar el sync

| # | Riesgo | Prob. | Mitigación |
|---|---|---|---|
| 1 | **Over-push rate limit**: encolar 533 SKUs cada 1 h podría saturar el cron de 1 min (máx ~275/ejecución) | Baja | Frecuencia 6 h en vez de 1 h; o batching explícito en el reconciliador con `limit=150` |
| 2 | **Race con encolado reactivo**: un cambio real por UI + reconciliador en el mismo minuto puede causar doble push con versiones stale | Media | `ON CONFLICT(sku) DO NOTHING` ya lo colapsa. El cálculo es idempotente (lee `v_stock_disponible` al push). Riesgo residual: x-version conflict → ya se maneja con 1 retry. |
| 3 | **Safety block activado masivo**: si un SKU tenía `stock_flex_cache=50` y hoy está en 0 real por una venta que BANVA sí registró pero cache stale, el bloque de seguridad (ml.ts:1377) puede saltar y dejarlo desincronizado para siempre | Media | Revisar el check de `recent_movimientos` en una ventana > 2 h para los casos de reconciliación. O flag `skip_safety=true` solo para el cron reconciler (riesgoso). |
| 4 | **Item closed/paused en ML**: push a item cerrado puede fallar con 400 | Baja | `syncStockToML` ya hace `.or("activo.eq.true,sku_venta.not.is.null")`. Filtrar también `status_ml NOT IN ('closed')` en el selector. |
| 5 | **Pausar publicación sin querer**: ninguna pieza del cambio altera `status_ml` del item. Solo tocamos stock. | Muy baja | N/A — no estamos cambiando el write path de ML. |

---

## 7. Tests necesarios

Mínimos para mergear PR tamaño S:

| # | Escenario | Fixture | Assert |
|---|---|---|---|
| 1 | SKU con `ultimo_sync=NULL` | item mapeado, sin audit entries | encolado |
| 2 | SKU con `ultimo_sync < now()-6h` | audit entry hace 10 h | encolado |
| 3 | SKU fresco (`ultimo_sync` < 6 h) | audit entry hace 30 min | **no** encolado |
| 4 | SKU inactivo | `activo=false` | **no** encolado |
| 5 | Divergencia actual con sync fresco | `stock_flex_cache=5, v_stock_disponible.disponible=0, ultimo_sync=now()-1h` | encolado (mismatch supera freshness) |
| 6 | Cola duplicada | SKU ya está en `stock_sync_queue` | upsert idempotente, no crea entry duplicada |
| 7 | Rate limit safety | 600 candidatos | encola máx 150 y loggea `remaining=450` |

Los tests del path de sync real (6/6 de Vicente) están fuera del scope S: van en M.

---

## 8. Resumen ejecutivo

| Dimensión | Valor |
|---|---|
| Total SKUs auditados | 533 |
| Fantasmas en ML (BANVA=0, ML>0) | **23 SKUs / 225 uds** |
| Subexpuestos (BANVA>0, ML=0 o menor) | **237 SKUs / 2 429 uds** (fuera de scope) |
| Oversell últimos 30 d | 96 órdenes / 97 uds |
| Nunca sincronizados | ≥6 SKUs, 21 d sin ningún intento |
| Causa raíz | Sync event-driven sin reconciliador periódico. Alta de `ml_items_map` no encola. Cambios fuera de UI/webhook no encolan. |
| Tamaño PR sugerido | **S** (~120 LOC, 1 día). Cron reconciliador cada 1 h. |
| Quick win hoy | `POST /api/ml/stock-sync?enqueue_all=1`. 0 LOC, resuelve los 38 casos en 2 min. |
| Riesgo principal a mitigar | Safety block `stock_flex_cache>10 && availableQty=0` puede dejar fantasmas pegados. Revisar ventana. |
