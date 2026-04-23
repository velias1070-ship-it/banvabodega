# Supabase — Esquema y Patrones de Queries

## Cliente

- **Client-side:** `src/lib/supabase.ts` — singleton con `getSupabase()`, usa `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- **Server-side:** `src/lib/supabase-server.ts` — `getServerSupabase()`, misma anon key (no service role)
- Ambos usan patrón lazy singleton: `if (!_client) { _client = createClient(...) }`
- Siempre verificar null antes de usar: `const sb = getSupabase(); if (!sb) return [];`

## Esquema de tablas

Las migraciones están en archivos `supabase-v*.sql` en la raíz. Se ejecutan manualmente en Supabase SQL Editor.

### Tablas principales (v2)
| Tabla | PK | Descripción |
|---|---|---|
| `operarios` | `id` (text) | Usuarios con PIN y rol (operario/admin) |
| `productos` | `id` (uuid), unique `sku` | Diccionario maestro de productos |
| `posiciones` | `id` (text) | Ubicaciones físicas en bodega |
| `stock` | `id` (uuid), unique `(sku, posicion_id)` | Stock por SKU+posición |
| `movimientos` | `id` (uuid) | Log de entradas/salidas/transferencias |
| `recepciones` | `id` (uuid) | Recepciones de mercadería |
| `recepcion_lineas` | `id` (uuid) | Líneas de cada recepción |
| `mapa_config` | `id` (text='main') | Config visual del mapa de bodega |

### Tablas ML / Flex (v3)
| Tabla | PK | Descripción |
|---|---|---|
| `composicion_venta` | `id` (uuid), unique `(sku_venta, sku_origen)` | Packs/combos: mapeo SKU venta → SKUs físicos |
| `picking_sessions` | `id` (uuid) | Sesiones de picking con `lineas` (jsonb) |
| `conteos` | `id` (uuid) | Conteos cíclicos con `lineas` (jsonb) |
| `ml_config` | `id` (text='main') | Credenciales OAuth ML + config |
| `pedidos_flex` | `id` (uuid), unique `(order_id, sku_venta)` | Pedidos Flex legacy |
| `ml_items_map` | `id` (uuid), unique `(sku, item_id)` | Mapeo SKU → item ML para stock sync |
| `stock_sync_queue` | `sku` (text) | Cola de SKUs pendientes de sync |

### Tablas shipment-centric (nuevas)
| Tabla | Descripción |
|---|---|
| `ml_shipments` | Envíos ML con status, substatus, logistic_type, handling_limit |
| `ml_shipment_items` | Items dentro de cada shipment |

### Extensiones v4-v6
- `ml_items_map` tiene `user_product_id` y `stock_version` (stock distribuido)
- `recepcion_lineas` tiene `bloqueado_por` / `bloqueado_hasta` (concurrency locks)
- RPCs: `bloquear_linea(p_linea_id, p_operario, p_minutos)` y `desbloquear_linea(p_linea_id)` con `SELECT FOR UPDATE`

## Proveedor: dos tablas, usos distintos

Dos fuentes de "proveedor de un SKU" que NO son redundantes. Confundirlas produce inferencias y OCs incorrectas.

### `productos.proveedor` (campo escalar 1:1)

- Tipo: `text`, un proveedor por SKU.
- Rol: **el proveedor habitual/principal** de ese producto ("¿a quién le compro normalmente?").
- Se completa al crear el SKU (desde Sheet, App Etiquetas, o manual). Puede quedar en `"Otro"` o `"Desconocido"` si no se sabe.
- Es el único campo de proveedor que leen: reportes simples, filtros de inventario, el campo `proveedor` mostrado en productos.

### `proveedor_catalogo` (tabla relacional N:N)

- Unique: `(proveedor, sku_origen)`. Permite el mismo SKU con **múltiples proveedores**, cada uno con su `precio_neto` pactado.
- Rol: **lista de precios acordados por proveedor** ("¿qué proveedores me venden esto y a cuánto cada uno?").
- Se alimenta desde: carga masiva (Excel/bulk), flujo `aprobarNuevoCosto`/`marcarPendienteNC`/`congelarCostoDiscrepancia` (ver `alimentarCatalogoProveedor` en `store.ts`), y la UI de "Cargar Catálogo" en Admin → Compras.
- Es la fuente de verdad para: precio sugerido al crear OC (`AdminInteligencia.tsx#pedidoItems`), cálculo de NC esperada en Conciliación, inferencia de proveedor cuando un SKU es multi-proveedor.

### Cuándo usar cuál

| Necesito… | Uso |
|---|---|
| "¿De quién es este SKU?" (info general, filtro de UI) | `productos.proveedor` |
| "Al generar OC a Idetex, ¿qué precio?" | `proveedor_catalogo WHERE proveedor='Idetex'` |
| "¿Qué proveedores venden X y a cuánto?" | `proveedor_catalogo WHERE sku_origen=X` |
| "NC esperada del proveedor por discrepancia" | `proveedor_catalogo` (precio pactado), fallback `productos.costo_promedio` |
| "Inferir proveedor de una recepción RAPIDO" | `proveedor_catalogo` (scorear proveedores por cuántos SKUs matchean), fallback `productos.proveedor` |

### Reglas

- **No borrar `productos.proveedor`** al poblar catálogo — son roles distintos, ambos conviven.
- **Al resolver una discrepancia**, alimentar `proveedor_catalogo` con el costo resuelto (el loop lo hace automático en `store.ts`). Eso mantiene el precio pactado actualizado para futuras OCs.
- **Para inferir** proveedor probable a partir de una lista de SKUs: preferir `proveedor_catalogo` (más robusto) con fallback a `productos.proveedor`.
- **Productos con `productos.proveedor = "Otro"` o `"Desconocido"`** son los candidatos #1 a actualizarse cuando llega una recepción con factura real del SII.

## Patrones de queries

```typescript
// Patrón estándar: función async, guard de null, return data || []
export async function fetchX(): Promise<X[]> {
  const sb = getSupabase(); if (!sb) return [];
  const { data } = await sb.from("tabla").select("*").order("campo");
  return data || [];
}

// Upsert con onConflict
await sb.from("tabla").upsert(obj, { onConflict: "campo_unique" });

// Batch en chunks de 500
for (let i = 0; i < items.length; i += 500) {
  await sb.from("tabla").upsert(items.slice(i, i + 500), { onConflict: "..." });
}

// RPC para operaciones atómicas
const { data, error } = await sb.rpc("nombre_funcion", { param1: val });

// Storage (upload a bucket "banva")
await sb.storage.from("banva").upload(path, blob, { upsert: true });
```

## RLS

Todas las tablas tienen RLS habilitado con políticas permisivas (`USING (true)` / `WITH CHECK (true)`). No hay auth de usuarios — la app usa anon key directamente. La seguridad depende de que la anon key no se exponga más allá de la app.

## Convenciones

- Nombres de tablas y columnas en **español** (`productos`, `posicion_id`, `cantidad`)
- IDs generados con `gen_random_uuid()` (uuid) o text manual (`'main'`)
- Timestamps: `created_at timestamptz DEFAULT now()`
- Estados como `text` con `CHECK` constraints (`'PENDIENTE' | 'CONTADA' | ...`)
- Datos complejos anidados en columnas `jsonb` (`lineas` en picking_sessions, conteos)
- No se usan foreign keys en todas las relaciones — `stock.sku` tiene FK a `productos.sku`, pero otras relaciones son lógicas
