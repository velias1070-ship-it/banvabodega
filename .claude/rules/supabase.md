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

## Proveedor: esquema canónico (v72+)

Plan de migración gradual hacia FK `proveedor_id`. El estado hoy es **transicional**: coexisten `proveedor` (text) y `proveedor_id` (uuid FK nullable) en 5 tablas (`recepciones`, `ordenes_compra`, `productos`, `proveedor_catalogo`, `rcv_compras`).

### Fuente de verdad

Tabla `proveedores`:
- `id uuid PK`
- `nombre_canonico text` ← nombre que se muestra en UI (fuente de verdad)
- `nombre text` ← legacy, mantener sincronizado con nombre_canonico
- `rut text` con UNIQUE index parcial (ignora NULL) ← match canónico, viene del DTE
- `razon_social text` ← razón social completa según SII
- `aliases text[]` ← aliases aprendidos automáticamente

### Cómo resolver un proveedor (desde cualquier flujo)

Llamar `POST /api/proveedores/resolve` con `{ rut?, razon_social?, nombre? }`:
1. Match por RUT (prioridad — es único e invariable entre apps del SII).
2. Match por alias (razón social vista antes).
3. Match por `nombre_canonico` / `nombre` case-insensitive (normaliza sufijos SA/SPA/LTDA).
4. Si nada matchea → crea el proveedor y aprende el alias.

Devuelve `{ id, nombre_canonico, created }`. Idempotente. Race-safe (UNIQUE en rut).

### Regla para escrituras nuevas

Cuando insertás en `recepciones`, `ordenes_compra`, `productos`, `proveedor_catalogo`, `rcv_compras`:

1. **Llamar resolve ANTES** del insert (si venís de un flujo externo como App Etiquetas o SII sync).
2. **Escribir AMBOS**: `proveedor_id` (FK) + `proveedor` (nombre_canonico legible como cache).
3. Nunca escribir solo el string sin el FK.

Para apps externas que no pueden/deben llamar el endpoint: insertan solo el string → el cron/backfill completa `proveedor_id` después (ver siguiente sección).

### Backfill histórico

`POST /api/proveedores/backfill?dry_run=1` recorre las 5 tablas, por cada fila con `proveedor_id=NULL` llama resolve y escribe el FK.

- Idempotente (solo toca NULLs).
- Usa `proveedor` (o `rut_proveedor` en rcv_compras) como input del resolve.
- Dry-run primero, ver estadísticas, después correr sin dry_run.

### Reglas para agentes

- **Preferir `proveedor_id`** para joins/filtros. El FK es la fuente de verdad.
- **`proveedor` (text) queda como cache legible** — no borrar, pero no confiar en él para lógica crítica.
- **Nunca comparar strings** de proveedor directamente. Si tenés dos rows y querés saber si son el mismo proveedor → comparar `proveedor_id`. Si todavía NULL, llamar resolve.
- **Apps externas (App Etiquetas)** deben migrar a llamar el endpoint de resolve antes de insertar. Mientras tanto, el backfill cierra el gap periódicamente.

### Distinción `productos.proveedor` vs `proveedor_catalogo`

Dos conceptos distintos (ambos con FK a proveedores(id) vía `proveedor_id`):

- **`productos.proveedor_id`** (1:1): el proveedor **habitual/principal** del SKU. Responde "¿a quién le compro normalmente este producto?".
- **`proveedor_catalogo(proveedor_id, sku_origen)`** (N:N, unique): **lista de precios pactados**. Permite el mismo SKU con múltiples proveedores, cada uno con su `precio_neto`.

### Cuándo usar cuál (matriz de decisión)

| Necesito… | Uso |
|---|---|
| "¿De quién es este SKU?" (filtro UI, reporte simple) | `productos.proveedor_id` |
| "Al generar OC a proveedor X, ¿qué precio?" | `proveedor_catalogo` WHERE proveedor_id=X |
| "¿Qué proveedores venden este SKU y a cuánto?" | `proveedor_catalogo` WHERE sku_origen=X |
| "NC esperada del proveedor por discrepancia" | `proveedor_catalogo` (precio pactado), fallback WAC |
| "Inferir proveedor desde SKUs de una recepción" | Score `proveedor_catalogo` por cuántos SKUs matchean, fallback `productos.proveedor_id` |

Dos tablas, dos roles distintos. No borrar una por la otra.

---

## Proveedor: dos tablas, usos distintos (legacy — v71 y anteriores)

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
