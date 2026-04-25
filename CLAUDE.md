# CLAUDE.md — BANVA Bodega

## Qué es esto

WMS (Warehouse Management System) custom para BANVA Chile — operación de e-commerce textil que vende en MercadoLibre. Cubre inventario, recepciones, picking Flex, conteos cíclicos, despacho y módulos financieros (ProfitGuard, SII, MercadoPago). Sistema multi-agente IA persistente acompaña al admin.

## Stack

- **Next.js 14 App Router** + React 18 + TypeScript 5 (strict, target es5)
- **Supabase Postgres** — cliente con anon key, sin auth server-side
- **Vercel** — hosting + 19 cron jobs (`vercel.json`)
- **Vitest** — tests del motor de inteligencia (11 archivos, `src/lib/__tests__/`)
- **Sin component library** — CSS custom dark theme en `globals.css`, fuentes Outfit + JetBrains Mono
- **Scanbot Web SDK** (barcodes), pdfjs-dist, jsPDF, qrcode, jsbarcode, jszip, xlsx

## Cómo correr local

```bash
npm install              # postinstall copia wasm de Scanbot a public/wasm/
npm run dev              # http://localhost:3000
npm run build            # build + valida tipos (única validación pre-deploy)
npm run test             # vitest run
npm run test:watch       # vitest watch
```

No hay linter. `next build` es la validación de tipos.

## Mapa rápido

- **Frontend (UI)**
  - `src/app/operador/*` — PWA mobile (max-width 480px). Picking, recepciones, conteos, facturas.
  - `src/app/admin/page.tsx` — panel admin de **12 201 LOC** con 5 grupos sidebar (OPERACIONES, INVENTARIO, INTELIGENCIA, COMERCIAL, SISTEMA) y 22 sub-vistas.
  - `src/app/conciliacion/page.tsx` — vista financiera (~2 900 LOC).
  - `src/components/Admin*.tsx` — tabs grandes del admin (Inteligencia 3.1k, Reposicion 2.9k, Comercial 2.5k, Margenes, Compras, VentasML, Agentes, …).
- **API** — `src/app/api/**/route.ts` (~110 routes)
  - `api/ml/*` (~50): OAuth, sync órdenes, stock-sync (push Flex), sync-stock-full (lectura Full), webhook, ads, billing, margen.
  - `api/agents/*`: chat/run/cron/feedback (sistema multi-agente IA con Anthropic).
  - `api/intelligence/*`: motor de velocidad / forecast / pendientes.
  - `api/sii/*`, `api/mp/*`, `api/profitguard/*`, `api/proveedores/*`, `api/proveedor-catalogo/*`, `api/orders/*`, `api/recepciones/*`, `api/semaforo/*`, `api/sheet/*`.
- **Lógica de negocio** — `src/lib/*`
  - `store.ts` (~3 100 LOC) — estado en memoria + bridge a `db.ts`. Composición de ventas, cálculo de stock, discrepancias.
  - `db.ts` (~3 100 LOC) — todas las queries Supabase. Interfaces `DB*`.
  - `ml.ts` (~2 600 LOC) — integración MercadoLibre (server-only).
  - `intelligence.ts` (~2 200 LOC) — motor: velocidad, gap, cobertura, ABC, forecast, estacionalidad, días en quiebre. Función `recalcularTodo` = 1 491 líneas.
  - `agents-*.ts`, `forecast-accuracy.ts`, `ml-metrics.ts`, `ml-shipping.ts`, `tsb.ts`, `pricing.ts`, `reposicion.ts`, `costos.ts`, `flex-full.ts`, `rampup.ts`, `snapshot-costo.ts`, `ventas-cache.ts`, `admin-users.ts`.
- **Datos**
  - **107 archivos `supabase-v*.sql`** en la raíz (migraciones manuales, ejecutadas en SQL Editor).
  - 17 RPCs invocadas desde el código (la única vía autorizada para cambiar stock es `registrar_movimiento_stock`).
  - Bucket de storage: `banva` (fotos de facturas + documentos).
- **Integraciones** (resumen — detalle en `/docs/codebase/05_integraciones.md`)
  - **MercadoLibre** (crítica): server-side en `src/lib/ml.ts`. Webhook entrante (sin firma). 8 tópicos.
  - **Anthropic** (agentes IA). Modelo hardcodeado `claude-sonnet-4-20250514` (desactualizado).
  - **MercadoPago** (sync MP → movimientos_banco).
  - **ProfitGuard** (rentabilidad por orden, cron 5 min).
  - **SII Chile** vía proxy Railway (`SII_SERVER_URL`) + acceso directo a `herculesr.sii.cl` / `www4.sii.cl`.
  - **Google Sheets** (lectura de costos via service account).
  - **App Etiquetas (`banva1`)**: repo hermano que escribe **directo** a `recepciones`, `recepcion_lineas`, storage `banva` — única fuente de recepciones en producción.
  - **Viki (droplet DigitalOcean)**: agente operativo 24/7 con crons WhatsApp y memoria persistente. Detalle: `.claude/rules/agents.md`.

## Documentación detallada

Ver `/docs/codebase/` para inventario completo. Empezar por:

1. `01_estructura.md` — árbol y conteos.
2. `02_stack.md` — versiones, dependencias, env vars.
3. **`03_arquitectura.md` ← lectura obligatoria** — rutas, API, crons, webhooks.
4. `04_datos.md` — migraciones, tablas, RPCs, RLS.
5. `05_integraciones.md` — clientes externos por servicio.
6. `06_ui.md` — páginas y componentes.
7. `07_convenciones.md` — naming, patrones, estilo.
8. `08_deuda_tecnica.md` — riesgos y deuda.

Reglas de dominio (a respetar al escribir código): `.claude/rules/*.md`
- `inventory-policy.md` — **6 antipatrones documentados con casos históricos** (centinelas numéricos, errores silenciosos, fuentes duplicadas, autoheal sobre respuesta parcial). Lectura obligatoria al tocar `intelligence`, `ml.ts`, reposición, movimientos.
- `supabase.md` — esquema, queries, proveedor canónico, RLS.
- `meli-api.md` — flujo OAuth, stock distribuido, modelo shipment-centric.
- `ui-ux.md` — design system y mobile-first.
- `security.md` — modelo de auth (PIN client-side).
- `testing.md` — **desactualizada**: dice "no hay tests" pero hay 11 Vitest. Tomar con escepticismo.
- `agents.md` — setup multi-máquina (Viki en droplet).
- `app-etiquetas.md` — repo hermano `banva1`, contrato de escritura directa.
- `whatsapp.md` — UX en el canal WhatsApp.

## Reglas para agentes IA trabajando en este repo

1. **Antes de crear una tabla**, verificar en `/docs/codebase/04_datos.md` si ya existe el concepto. Hay ~70 tablas; confundir conceptos genera duplicación zombi (Regla 5 de `inventory-policy.md`).
2. **Antes de crear un endpoint**, verificar en `/docs/codebase/03_arquitectura.md`. Hay ~110 routes — gran chance de que ya exista algo similar.
3. **Antes de crear una función helper en `src/lib/`**, invocar el subagente `reuse-scout` (regla del CLAUDE.md histórico). Aplica si el cambio agrega ≥20 LOC nuevas.
4. **Antes de cambiar lógica de inventario o pricing**, leer los manuales en `/docs/manuales/` (memoria `feedback_banva_manuales_fuente_verdad`) y citarlos en commit/PR.
5. **Naming**: tablas y columnas SQL en `snake_case` español; TS funciones/vars en `camelCase` español; tipos `PascalCase` (con prefijo `DB` si mapean filas Supabase). Nombres del API ML se mantienen en inglés (`inventory_id`, `user_product_id`, `listing_id`).
6. **Stock**: TODO cambio de stock pasa por `registrar_movimiento_stock` RPC — nunca `updateStock` silencioso.
7. **Supabase devuelve `PromiseLike` no `Promise`**: usar `try/catch` o `void`, **nunca `.catch()`** sobre `sb.from(...)` (regla del CLAUDE.md histórico — más detalles en `inventory-policy.md` Regla 3).
8. **Errores de Supabase**: nunca tragar con destructuring parcial. Loguear con `[contexto]` mínimo.
9. **Endpoints con branches**: exponer en el response qué rama corrió (`enqueue_all_ran: bool`, `rows_affected: number`). Regla 4 de inventory-policy.
10. **Git**: trabajo directo a `main`, sin feature branches (regla del repo). Commit message en formato `area(detalle): descripcion`. Modo autonomía habilitado (memoria `feedback_banva_app_autonomy`, `feedback_banvabodega_autonomy`): commits/deploys/restores sin pedir confirmación rutinaria.
11. **Cambios cross-repo**: si algo en banvabodega afecta a App Etiquetas (`banva1`, sibling clone en `~/banva1/`), modificar AMBOS en la misma sesión y etiquetar `(afecta banva1)` en el commit.

## Tablas críticas (SSoT)

> TODO completar manualmente con el owner. Estado actual de duplicaciones conocidas:

- **"Stock Full por SKU"**: SSoT = tabla `stock_full_cache`. Columna zombi `ml_items_map.stock_full_cache` deprecada en v58 (todavía existe físicamente, sync espejo).
- **"Pedido Flex"**: SSoT pendiente de declarar. `pedidos_flex` (legacy, 1 fila por order+sku_venta) coexiste con `ml_shipments` + `ml_shipment_items` (shipment-centric, nuevo).
- **"Proveedor"**: SSoT en transición. `proveedores.id` (FK `proveedor_id`) es canónico; columnas `proveedor: text` se mantienen como cache legible. Apps externas todavía no llaman a `/api/proveedores/resolve` — hay backfill periódico.
- **"Costo de un SKU"**: SSoT = `productos.costo_promedio` (WAC desde recepciones). Para precio de OC: `proveedor_catalogo.precio_neto`. **No inferir costos de promedios de familia** (memoria `feedback_no_inferir_costos`).
- **"Recepción"**: SSoT = tabla `recepciones`. Única fuente de inserción en prod = App Etiquetas (`banva1`).
- **"Velocidad / forecast por SKU"**: SSoT = `sku_intelligence`. Histórico en `sku_intelligence_history`.
- **"Tokens MercadoLibre"**: SSoT = tabla `ml_config` (singleton `id='main'`). RLS permisivo — riesgo conocido.

## Tablas deprecadas / a evitar

- `productos.codigo_ml` — DROP en v74 (derivable vía `composicion_venta` + `ml_items_map`).
- `productos.sku_venta` — DROP en v73 (columna 100% vacía).
- `ml_items_map.stock_full_cache` — DEPRECADA en v58. Leer desde tabla `stock_full_cache` (LEFT JOIN).
- `pedidos_flex` (cuando termine la migración a `ml_shipments`).

## Variables de entorno requeridas

Detalle completo en `/docs/codebase/02_stack.md` sección "Variables de entorno". Resumen:

- **Supabase**: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (+ variantes `*_TEST_*`, `NEXT_PUBLIC_TEST_MODE`, opcional `SUPABASE_SERVICE_ROLE_KEY`).
- **MercadoLibre**: `ML_SYNC_SECRET` (tokens viven en tabla `ml_config`).
- **MercadoPago**: `MP_ACCESS_TOKEN`.
- **ProfitGuard**: `PROFITGUARD_API_KEY`.
- **SII**: `SII_SERVER_URL`, `SII_API_KEY`.
- **Anthropic**: `ANTHROPIC_API_KEY`.
- **Google Sheets**: `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `GOOGLE_SHEET_ID`, `GOOGLE_SHEET_NAME`, `GOOGLE_COST_COLUMN`.
- **Crons**: `CRON_SECRET`, `AGENTS_CRON_SECRET`.

> **No existe `.env.example`** — ítem de deuda. Crearlo a partir de la lista anterior.

## Hygiene

- `/hygiene` — barrido periódico de duplicación / código muerto.
- `reuse-scout` subagente — invocar antes de crear recursos nuevos (`src/lib/*`, route, interface, RPC, hook, componente).
