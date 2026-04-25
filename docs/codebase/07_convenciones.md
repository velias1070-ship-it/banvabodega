# Fase 7 — Convenciones detectadas

## Naming

### Tablas y columnas SQL — `snake_case` español
Todas las tablas en `public.*` usan `snake_case` y nombres en español: `productos`, `recepcion_lineas`, `movimientos_banco`, `composicion_venta`, `stock_full_cache`, `vel_objetivo_historial`. Sin excepciones detectadas (verificado con `grep "CREATE TABLE [A-Z]"` → cero matches).

Columnas igual: `sku_origen`, `sku_venta`, `qty_reserved`, `created_at`, `nombre_canonico`. Estados como `text` con `CHECK` constraint en mayúsculas: `'PENDIENTE' | 'CONTADA' | 'CERRADA'`.

### TypeScript — `camelCase` para variables/funciones, `PascalCase` para tipos
- Funciones: `getStore`, `upsertProducto`, `crearRecepcion`, `findProduct`. Todo en español/camelCase.
- Tipos/interfaces: `PascalCase` con prefijo `DB` para los que mapean filas Supabase: `DBProduct`, `DBRecepcion`, `DBRecepcionLinea`, `DBMovimiento`, `DBComposicionVenta`. Tipos de dominio sin prefijo: `Product`, `Movement`, `Position`.
- Constantes globales: `SCREAMING_SNAKE_CASE`: `ML_API`, `ML_AUTH`, `SITE_ID`, `ADMIN_PIN`, `AUTH_KEY`.

### Archivos
- `src/lib/`: `kebab-case.ts` con prefijos por dominio (`agents-db.ts`, `agents-triggers.ts`, `forecast-accuracy.ts`, `ml-shipping.ts`).
- `src/components/`: `PascalCase.tsx` (`AdminInteligencia.tsx`, `BarcodeScanner.tsx`).
- `src/app/api/.../route.ts`: convención Next.js obligatoria.
- Migraciones: `supabase-v{N}-{kebab-descripcion}.sql`. Numeración por feature; permite colisiones (dos `v15`, dos `v17`, etc.).

## Estructura de carpetas

**Por tipo, no por feature.** No hay carpetas tipo `features/inventory/`, sino:
- `src/lib/` con un archivo por dominio (`store.ts`, `intelligence.ts`, `ml.ts`, `tsb.ts`, `pricing.ts`, …).
- `src/components/` plana (33 archivos sueltos).
- `src/app/api/{dominio}/{accion}/route.ts` agrupa por dominio externo (`api/ml`, `api/sii`, `api/mp`, `api/proveedores`).

**Excepción**: `src/app/operador/{conteos|facturas|picking|recepciones}/page.tsx` agrupa por flujo de operario (más feature-oriented).

## Server vs Client

- **`"use client"`** en 48 archivos. Toda la UI es client-side.
- **No hay `"use server"`** en el repo. Server Actions no se usan.
- **Server-only** queda implícito en archivos importados desde `route.ts`: `src/lib/ml.ts`, `src/lib/supabase-server.ts`, `src/lib/agents-triggers-server.ts`, `src/lib/forecast-accuracy-queries.ts`. No usan directiva — convención de import.

## Acceso a datos

- **Sin ORM**. Todo es `sb.from("tabla").select/insert/update/upsert/delete`.
- Patrón estándar:
  ```ts
  export async function fetchX(): Promise<X[]> {
    const sb = getSupabase(); if (!sb) return [];
    const { data } = await sb.from("tabla").select("*").order("campo");
    return data || [];
  }
  ```
- **Upserts en chunks de 500**: `for (let i = 0; i < items.length; i += 500) { await sb.from(...).upsert(items.slice(i, i+500), { onConflict: "..." }); }`.
- **Operaciones atómicas via RPC**: `sb.rpc("nombre_funcion", { ... })` (17 RPCs detectadas — ver Fase 4).
- **Movimientos de stock**: regla obligatoria — toda variación pasa por `registrar_movimiento_stock` (memoria `feedback_movimientos_stock`).

## Manejo de errores

Predominante: **`try/catch` con `console.error` con prefijo `[contexto]`**. 83 archivos `route.ts` con `try {`.

Patrones detectados:
- API routes: `try { ... } catch (e) { return NextResponse.json({ error: ... }, { status: 500 }) }`.
- Helpers de DB: muchos retornan `data || []` y silencian errores. **Esto es exactamente el antipatrón de la Regla 3** de `inventory-policy.md`. La regla está documentada porque ya causó incidentes reales (3 271 filas perdidas).
- 62 archivos con `console.error`, 28 con `console.log`. Sin logger estructurado.
- 21 `throw new Error(...)` en todo el repo — error throwing es excepcional, no la norma.

> **Antipatrones documentados en `.claude/rules/inventory-policy.md`** (a respetar al escribir código nuevo en `intelligence`, `ml.ts`, reposición, movimientos):
> 1. Centinelas numéricos (999, -1, 2071) → preferir `null` + branch explícito.
> 2. Sub-bugs detectados durante un PR → fixear en el mismo sprint, no diferir.
> 3. Tragar errores de Supabase con destructuring parcial / `void` / `.catch(()=>{})`.
> 4. Endpoints con branches sin output observable (responder `enqueue_all_ran: bool`, etc.).
> 5. Fuentes duplicadas del mismo dato sin canónica declarada.
> 6. Autoheal sobre respuesta parcial de API externa en vez de fuente canónica local.

## Validación de inputs

- **No se usa Zod, Yup, ni librerías de schema**. Búsqueda directa: `grep -rln "zod"` → 0 matches.
- Validación inline ad-hoc en endpoints: chequeos manuales de `if (!body.x) return 400`.
- Inputs UI: validación inline con `useState`. Sin `react-hook-form`.

## Tests

> La regla `.claude/rules/testing.md` dice "no hay infraestructura de testing" — **desactualizada**. Realidad actual:

- Framework: **Vitest 4.0.18**.
- Comando: `npm run test` (run) / `npm run test:watch`.
- Ubicación: `src/lib/__tests__/*.test.ts`.
- 11 tests existentes:
  - `autoheal-composicion.test.ts`
  - `flex-full.test.ts`
  - `forecast-accuracy.test.ts`
  - `intelligence-flex.test.ts`
  - `intelligence-nuevo.test.ts`
  - `intelligence-quiebre.test.ts`
  - `quiebre-flex.test.ts`
  - `reposicion.test.ts`
  - `snapshot-costo.test.ts`
  - `sync-stock-full.test.ts`
  - `tsb.test.ts`
- También: `src/app/api/ml/__tests__/` (TODO: confirmar cuántos archivos).
- **Todo lo testeado es lógica pura** del motor de inteligencia/reposición. UI no se testea.

## Comentarios y documentación

- Convención general: **comentarios escasos**. Lead con identificadores parlantes.
- Comentarios en español, casuales (`// DESACTIVADO 2026-04-24:`, `// Por que: …`).
- Headers de versión a veces (`/* v3.1 — conteos + pedidos ML */`).
- TODO/FIXME: **3 totales** en todo `src/`:
  - `src/app/api/ml/auto-postular/route.ts:358` — TODO ejecutar join a ML.
  - `src/app/api/semaforo/refresh/route.ts:156` — TODO send Telegram alert.
  - `src/lib/intelligence.ts:1480` — TODO etiquetado.
- Documentación de dominio fuera del código: `docs/manuales/` (inventarios, pricing) son fuente de verdad para el motor (memoria `feedback_banva_manuales_fuente_verdad` — leer antes de cambiar lógica).

## Estilo CSS / UI

- Inline styles con `style={{}}` y camelCase.
- CSS classes solo para patrones repetidos.
- Iconos = emojis nativos.
- Sin `clsx`/`classnames` — concatenación manual de strings.

## Convenciones git/commits

- Trabajo directo sobre `main` (regla en `CLAUDE.md`). Sin feature branches.
- Estilo de commit (de `git log -5`): `area: descripcion en minusculas`.
  - `refactor(productos): drop codigo_ml, derivar via composicion_venta + ml_items_map`
  - `db(v73): drop productos.sku_venta — columna duplicada y vacia`
  - `docs(auditorias): README con indice + estado de cada doc`
- Etiquetas habituales: `db(vN)`, `refactor(area)`, `docs(area)`, `fix(area)`, `feat(area)`.

## Inconsistencias detectadas

1. **Doble fuente de auth admin**: `ADMIN_PIN = "1234"` hardcodeado en `/admin/page.tsx` y `/conciliacion/page.tsx`, pero a la vez existe sistema `admin_users` (v61, `loginAdminUser`, `canAccessTab`). Conviven — la sesión del PIN antiguo todavía funciona.
2. **Service role key**: solo en `/api/ml/setup-tables` y `scripts/debug-shipping.mjs`. Resto del código usa anon. La regla `supabase.md` dice "no service role".
3. **Modelo dual de ML pedidos**: `pedidos_flex` (legacy) vs `ml_shipments + ml_shipment_items`. Ambos consultados desde el código.
4. **Modelo dual de proveedor**: columna `proveedor: text` vs FK `proveedor_id` (v72). Migración en proceso.
5. **Numeración de migraciones colisiona**: dos `v15`, dos `v17`, dos `v19`, dos `v20`, dos `v28`, dos `v29`, dos `v30`, dos `v31`, dos `v32`, dos `v33`, dos `v34`, dos `v36`, dos `v39`, dos `v40`, dos `v45`, dos `v51`, dos `v64`, dos `v65`, dos `v67`, dos `v68`. Indica numeración por feature paralela, no global. Convención implícita.
6. **Regla testing desactualizada**: el archivo `.claude/rules/testing.md` afirma "no tests" pero hay 11 tests Vitest. Actualizar.
7. **Modelo Anthropic hardcoded** `claude-sonnet-4-20250514` en 2 endpoints. Más reciente disponible: `claude-sonnet-4-6`.
8. **Naming en español pero algunos campos en inglés**: `created_at`, `updated_at`, `inventory_id`, `user_product_id`, `stock_version`, `listing_id`, `status_ml` (mezcla — se mantiene porque vienen del API ML).
9. **`store.ts` exporta ~80 funciones** — el archivo es el cuello de botella de imports (`/admin/page.tsx` importa más de 60 desde él). Refactor candidato pero alto riesgo.
