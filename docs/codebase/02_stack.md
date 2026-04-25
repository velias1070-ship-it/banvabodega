# Fase 2 — Stack y dependencias

## Versiones detectadas

| Componente | Versión |
|---|---|
| Node.js (entorno actual) | v24.13.0 |
| Next.js | 14.2.35 (instalada) — declarada `^14.2.0` |
| React | 18.3.1 — declarada `^18.2.0` |
| TypeScript | 5.9.3 — declarada `^5.0.0` |
| `@supabase/supabase-js` | 2.97.0 — declarada `^2.97.0` |
| Vitest | 4.0.18 — declarada `^4.0.18` |

> No hay campo `engines` en `package.json` — versión de Node oficial no declarada. TODO: confirmar con owner cuál es la versión target en Vercel (Vercel default actual: Node 24 LTS).

## Dependencias

### `dependencies`

| Categoría | Paquete | Para qué se usa |
|---|---|---|
| **Framework** | `next` | App Router, API routes, ISR, deploy en Vercel. |
| | `react`, `react-dom` | UI client-side. Sin RSC (todo es `"use client"`). |
| **Data** | `@supabase/supabase-js` | Cliente Supabase. Único acceso a la DB (no hay ORM, no hay otro driver). Singleton lazy en `src/lib/supabase.ts` (client) y `src/lib/supabase-server.ts` (server). |
| **UI / Hardware** | `scanbot-web-sdk` | Lectura de códigos de barras desde la cámara del móvil. Wasm copiado en `postinstall` a `public/wasm/`. Usado en `src/components/BarcodeScanner.tsx`. |
| | `jsbarcode` | Genera SVGs de códigos de barras (etiquetas). Usado en `src/app/admin/page.tsx`. |
| | `qrcode` | Genera QR codes (impresión de etiquetas/posiciones). Usado en `src/app/admin/qr-codes/page.tsx`. |
| **Documentos** | `jspdf` | Genera PDFs de etiquetas en cliente. Usado en `src/app/admin/page.tsx`. |
| | `jszip` | Empaqueta múltiples PDFs en `.zip` para descargar. `src/app/admin/page.tsx`. |
| | `pdfjs-dist` | Renderiza PDFs (probablemente preview de etiquetas/facturas ML). `src/app/admin/page.tsx`. Worker se copia en `postinstall` a `public/pdf.worker.min.js`. |
| | `xlsx` | Lectura/escritura de Excel: importar liquidaciones MP, importar template proveedor catálogo, exportar flujo de caja. `MpLiquidacionUpload.tsx`, `FlujoCaja.tsx`, `api/proveedor-catalogo/import-template`. |

### `devDependencies`

| Categoría | Paquete | Para qué se usa |
|---|---|---|
| **Tipos** | `@types/node`, `@types/react`, `@types/qrcode`, `@types/turndown` | Definiciones TS. |
| **Testing** | `vitest` | Único framework de tests. 11 archivos en `src/lib/__tests__/`. |
| **E2E (no usado en CI)** | `playwright` | Listado pero TODO: confirmar si está en uso. No hay tests `.spec.ts` ni `playwright.config.*` detectados. |
| **Scripting** | `tsx` | Ejecuta los scripts `.ts` de `scripts/` (que están fuera del tsconfig). |
| **Otros** | `turndown` | Convierte HTML→Markdown. Usado en `scripts/sync-meli-docs.ts` para bajar la doc de MercadoLibre y guardarla en `docs/meli/`. |
| **Lenguaje** | `typescript` | Compilador TS. |

> **Nota**: el archivo `.claude/rules/testing.md` afirma "no hay infraestructura de testing", pero el repo SÍ tiene Vitest configurado y 11 tests bajo `src/lib/__tests__/`. La regla está desactualizada (anterior a la incorporación de tests). Documentar como hallazgo en Fase 7/8.

## Scripts de `package.json`

| Script | Comando | Qué hace |
|---|---|---|
| `dev` | `next dev` | Servidor Next.js de desarrollo en :3000. |
| `build` | `next build` | Build de producción (también valida tipos TS — única validación pre-deploy). |
| `start` | `next start` | Sirve el build de producción. |
| `test` | `vitest run` | Corre la suite Vitest una vez. |
| `test:watch` | `vitest` | Vitest en modo watch. |
| `sync-meli-docs` | `tsx scripts/sync-meli-docs.ts` | Descarga la doc de la API MercadoLibre (HTML), la convierte a markdown con `turndown` y la guarda bajo `docs/meli/`. |
| `postinstall` | (ver abajo) | Copia el wasm de Scanbot y el worker de pdfjs a `public/`. |

```bash
postinstall: mkdir -p public/wasm \
  && cp -r node_modules/scanbot-web-sdk/bundle/bin/barcode-scanner/* public/wasm/ \
  && cp node_modules/pdfjs-dist/build/pdf.worker.min.mjs public/pdf.worker.min.js
```

> No hay scripts de `lint`, `format`, `typecheck` ni de migrations.

## Variables de entorno detectadas

Encontradas con `grep 'process\.env\.' src/ scripts/`. Inferencia del rol leyendo el contexto.

### Supabase

| Variable | Rol | Dónde se usa |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | URL del proyecto Supabase prod. | `src/lib/supabase.ts`, `supabase-server.ts`. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Anon key Supabase prod (pública por diseño). | Idem. |
| `NEXT_PUBLIC_SUPABASE_TEST_URL` | URL del proyecto Supabase test (cuando `NEXT_PUBLIC_TEST_MODE=true`). | Idem. |
| `NEXT_PUBLIC_SUPABASE_TEST_ANON_KEY` | Anon key Supabase test. | Idem. |
| `NEXT_PUBLIC_TEST_MODE` | `"true"` → cliente Supabase apunta al proyecto de test. | Selector dual de cliente. |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role (bypass RLS) — server-only. | TODO: confirmar dónde se usa exactamente; presente en `.env.local` aunque la regla `supabase.md` dice "no hay service role" (contradicción a documentar en Fase 8). |

### MercadoLibre + Ads

| Variable | Rol |
|---|---|
| `ML_SYNC_SECRET` | Secret esperado por endpoints ML disparados por crons (auth simple). |
| `ANTHROPIC_API_KEY` | Claude API. Lo usa el sistema de agentes (`src/lib/agents-*` o `src/app/api/agents/`). |

### Pagos / ERP externo

| Variable | Rol |
|---|---|
| `MP_ACCESS_TOKEN` | Access token MercadoPago. Reportes, sync de movimientos. |
| `PROFITGUARD_API_KEY` | API key del SaaS ProfitGuard (rentabilidad por orden). |

### SII (Servicio de Impuestos Internos Chile)

| Variable | Rol |
|---|---|
| `SII_SERVER_URL` | URL de un microservicio externo (Railway según `.env.local` cuando es local: `http://localhost:8080`) que actúa de proxy al SII para BHE / RCV. |
| `SII_API_KEY` | API key del mismo microservicio. |

### Google Sheets

| Variable | Rol |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Service account para leer/escribir Sheet de costos. |
| `GOOGLE_PRIVATE_KEY` | Llave privada del SA. |
| `GOOGLE_SHEET_ID` | ID de la planilla de costos. |
| `GOOGLE_SHEET_NAME` | Nombre de la pestaña. |
| `GOOGLE_COST_COLUMN` | Letra de columna donde está el costo. |

### Crons / seguridad

| Variable | Rol |
|---|---|
| `CRON_SECRET` | Auth para endpoints disparados por Vercel Cron. |
| `AGENTS_CRON_SECRET` | Auth específica para `/api/agents/cron`. |

### Vercel runtime (auto-inyectadas)

| Variable | Rol |
|---|---|
| `NODE_ENV` | `production` / `development`. |
| `VERCEL_ENV` | `production` / `preview` / `development`. |
| `VERCEL_URL` | URL del deploy actual. |
| `VERCEL_PROJECT_PRODUCTION_URL` | URL canónica de producción. |
| `VERCEL_BRANCH_URL` | URL de preview de la branch. |

> **No existe `.env.example` en el repo** (revisado). Recomendación para Fase 8: crearlo a partir de esta tabla.

## Hallazgos
- Service role key referenciada en `process.env.SUPABASE_SERVICE_ROLE_KEY`. La regla `.claude/rules/supabase.md` dice "misma anon key (no service role)". Hay drift entre la regla y la realidad. **TODO: confirmar con el owner** dónde se usa y si la regla debe actualizarse.
- `playwright` declarado pero no se detectaron specs ni config. TODO: confirmar si fue removido o aún en uso para algún script suelto.
- El script `postinstall` asume layout interno de `scanbot-web-sdk` y `pdfjs-dist` — un upgrade de cualquiera puede romper el build silenciosamente.
