# Plan: Integración ML API → stock_full_cache (Eliminar carga manual ProfitGuard)

## Análisis del estado actual

### Lo que ya existe:
1. **`ml_items_map`** (v3): Tabla existente con campos `sku, item_id, variation_id, activo, ultimo_sync, ultimo_stock_enviado`. Usada para stock sync de WMS→ML. **No tiene** `inventory_id`, `sku_venta`, `titulo`, `available_quantity`, `sold_quantity`.
2. **`stock_full_cache`** (v15): Tabla con `sku_venta, cantidad, updated_at, nombre, vel_promedio`. Se llena manualmente vía upload Excel en AdminReposicion.
3. **`ml.ts`**: Funciones `mlGet`, `mlPut`, `mlPost`, `ensureValidToken`, `getMLConfig` ya implementadas. Seller ID en `ml_config.seller_id`.
4. **`productos.codigo_ml`**: Campo texto con item_id(s) de ML (puede ser comma-separated). Esto es el mapeo item→SKU.
5. **`intelligence.ts`**: Lee `stock_full_cache` via `queryStockFullCache()` para obtener stock Full por SKU Venta. Genera alerta `agotado_full` cuando `stock_full === 0 && vel_full > 0`.
6. **Cron** (`/api/agents/cron`): Ejecuta recálculo de inteligencia + snapshot entre 6-8am Chile. No sincroniza stock Full.
7. **Webhook ML** (`/api/ml/webhook`): Maneja `orders_v2` y `shipments`. No maneja `marketplace_fbm_stock`.

### Lo que falta:
- API route para sincronizar stock Full desde ML
- Campos de detalle (dañado, perdido, transferencia) en `stock_full_cache`
- Columnas adicionales en `ml_items_map` (`inventory_id`, `sku_venta`, `titulo`)
- Webhook para cambios de stock fulfillment
- Integración con cron diario
- Botón y UI en admin
- Alerta `stock_danado_full` en inteligencia

---

## Plan de implementación (6 pasos)

### Paso 1: Migración SQL — Extender tablas existentes
**Archivo:** `supabase-v17-ml-stock-full.sql` (nuevo)

```sql
-- Extender ml_items_map con campos de inventario
ALTER TABLE ml_items_map ADD COLUMN IF NOT EXISTS inventory_id text;
ALTER TABLE ml_items_map ADD COLUMN IF NOT EXISTS sku_venta text;
ALTER TABLE ml_items_map ADD COLUMN IF NOT EXISTS titulo text;
ALTER TABLE ml_items_map ADD COLUMN IF NOT EXISTS available_quantity integer DEFAULT 0;
ALTER TABLE ml_items_map ADD COLUMN IF NOT EXISTS sold_quantity integer DEFAULT 0;
ALTER TABLE ml_items_map ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_ml_items_inventory ON ml_items_map(inventory_id);
CREATE INDEX IF NOT EXISTS idx_ml_items_sku_venta ON ml_items_map(sku_venta);

-- Extender stock_full_cache con detalle de stock no disponible
ALTER TABLE stock_full_cache ADD COLUMN IF NOT EXISTS stock_no_disponible integer DEFAULT 0;
ALTER TABLE stock_full_cache ADD COLUMN IF NOT EXISTS stock_danado integer DEFAULT 0;
ALTER TABLE stock_full_cache ADD COLUMN IF NOT EXISTS stock_perdido integer DEFAULT 0;
ALTER TABLE stock_full_cache ADD COLUMN IF NOT EXISTS stock_transferencia integer DEFAULT 0;
```

**Decisión:** Extender `ml_items_map` existente en vez de crear tabla nueva, porque ya tiene `item_id` y `sku` y está integrada con el stock sync existente. La constraint UNIQUE existente `(sku, item_id)` se mantiene.

---

### Paso 2: Lógica de sincronización en `src/lib/ml.ts`
**Archivo:** `src/lib/ml.ts` (agregar funciones)

Nueva función `syncStockFull()`:

1. **Obtener config** con `getMLConfig()` → `seller_id`, token
2. **Listar items** del seller: `GET /users/{SELLER_ID}/items/search` paginando (scroll_id)
3. **Obtener detalle** de cada item: `GET /items/{ITEM_ID}` — extraer `inventory_id`, `title`, `available_quantity`, `sold_quantity`, variaciones
4. **Mapear a SKU Venta**: Buscar en tabla `productos` por `codigo_ml` LIKE `%{ITEM_ID}%` para encontrar el `sku_venta` correspondiente
5. **Obtener stock fulfillment**: Para items con `inventory_id`, consultar `GET /inventories/{INVENTORY_ID}/stock/fulfillment?seller_id={SELLER_ID}`
6. **Upsert `ml_items_map`**: Actualizar con `inventory_id`, `sku_venta`, `titulo`, cantidades
7. **Upsert `stock_full_cache`**: Para cada SKU Venta, actualizar `cantidad` = `available_quantity` del fulfillment, más campos de stock dañado/perdido/transferencia
8. **Rate limiting**: Batches de 5 requests con 500ms delay entre batches

Retorna: `{ items_sincronizados, stock_actualizado, sin_inventory_id, errores, tiempo_ms }`

**Detalle del mapeo item→SKU:** La tabla `productos` tiene `codigo_ml` que contiene el item_id de ML (ej: "MLC123456"). Si es un producto con variaciones, cada variación puede tener su propio `seller_sku`. El mapeo es:
- Buscar `productos` donde `codigo_ml` contiene el `item_id`
- Usar el `sku_venta` de ese producto
- Si el item tiene variaciones con `seller_sku`, esos ya están en `ml_items_map.sku`

---

### Paso 3: API Route `/api/ml/sync-stock-full`
**Archivo:** `src/app/api/ml/sync-stock-full/route.ts` (nuevo)

- `POST`: Ejecuta `syncStockFull()` y retorna resultado JSON
- `export const maxDuration = 120` para permitir hasta 2 minutos
- Opción `{ recalcular: boolean }` para disparar recálculo de inteligencia al final
- Si `recalcular: true`, llama a `/api/intelligence/recalcular` con `{ full: false, skus: [skus_cambiados] }` para recálculo incremental

---

### Paso 4: Webhook `/api/ml/webhook-stock`
**Archivo:** Integrar en webhook existente `src/app/api/ml/webhook/route.ts`

Agregar handler para topic `marketplace_fbm_stock`:
1. Extraer `resource` del payload (contiene inventory_id o item_id)
2. Consultar stock fulfillment del inventory_id
3. Buscar en `ml_items_map` para encontrar el `sku_venta`
4. Actualizar `ml_items_map` y `stock_full_cache`
5. Disparar recálculo incremental de inteligencia solo para ese SKU

**Decisión:** Agregar al webhook existente en vez de crear ruta separada, porque ML envía todas las notificaciones al mismo endpoint. Solo se agrega un `case` para el nuevo topic.

---

### Paso 5: Integración con cron diario
**Archivo:** `src/app/api/agents/cron/route.ts` (editar)

En el bloque del snapshot diario (6-8am Chile), agregar **antes** del recálculo de inteligencia:
1. Llamar a `/api/ml/sync-stock-full` con `{ recalcular: false }`
2. Loguear resultado
3. Luego ejecutar el recálculo de inteligencia como ya hace

Así el stock Full está fresco antes del snapshot diario.

---

### Paso 6: UI en Admin — Botón Sync y tooltips
**Archivo:** `src/components/AdminInteligencia.tsx` (editar)

1. **Botón "Sync Stock ML"** en la barra superior junto a "Recalcular":
   - Llama a `POST /api/ml/sync-stock-full` con `{ recalcular: true }`
   - Muestra spinner mientras sincroniza
   - Muestra resultado: items sincronizados, stock actualizado, errores
   - Muestra última sincronización (timestamp del último sync)

2. **Tooltip en columna ST.FULL**: Si un SKU tiene `stock_danado > 0` o `stock_perdido > 0`, mostrar detalle:
   - "43 disponibles + 5 dañados + 2 perdidos = 50 totales en Full"
   - Esto requiere que la vista de inteligencia tenga acceso a los campos de `stock_full_cache` (se agregan al query de vista-venta)

3. **Alerta `stock_danado_full`** en `intelligence.ts`:
   - Si un SKU tiene stock dañado o perdido en Full, agregar alerta
   - Mostrar en filtro de alertas de AdminInteligencia

---

## Archivos a crear/modificar

| Archivo | Acción | Descripción |
|---|---|---|
| `supabase-v17-ml-stock-full.sql` | Crear | Migración SQL para extender tablas |
| `src/lib/ml.ts` | Editar | Agregar `syncStockFull()` y helper de fulfillment |
| `src/app/api/ml/sync-stock-full/route.ts` | Crear | API route de sincronización |
| `src/app/api/ml/webhook/route.ts` | Editar | Agregar handler para `marketplace_fbm_stock` |
| `src/app/api/agents/cron/route.ts` | Editar | Agregar sync antes del snapshot diario |
| `src/components/AdminInteligencia.tsx` | Editar | Botón sync + tooltip stock dañado |
| `src/lib/intelligence.ts` | Editar | Alerta `stock_danado_full` |
| `src/lib/intelligence-queries.ts` | Editar | Query de stock_full_cache con campos nuevos |
| `src/app/api/intelligence/vista-venta/route.ts` | Editar | Incluir datos de stock dañado en respuesta |

## Riesgos y consideraciones

1. **API ML de marketplace/inventories**: Verificar que la app de ML tenga scope para estas rutas. Si no, habrá 403 y se necesita reconfigurar la app en ML Developers.
2. **Mapeo codigo_ml → item_id**: El campo `codigo_ml` puede tener múltiples valores separados por coma. La lógica debe buscar en cada valor.
3. **Items sin inventory_id**: Items que no están en Fulfillment no tendrán inventory_id. Estos se registran pero no generan stock Full.
4. **Rate limiting**: Con ~345 items y batches de 5, son ~70 requests en ~35 segundos. Dentro del límite de Vercel con `maxDuration = 120`.
5. **vel_promedio de ProfitGuard**: El campo `vel_promedio` en `stock_full_cache` sigue llenándose vía upload manual. La sync de ML solo actualiza `cantidad` y campos de stock detallado, NO toca `vel_promedio`.
