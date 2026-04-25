# Fase 1 — Inventario estructural

> Generado el 2026-04-25 desde `main` (último commit `c1fd40a`). Excluye `node_modules/`, `.next/`, `.git/`, `dist/`.

## Árbol de directorios (hasta nivel 3)

```
banvabodega/
├── .claude/                   # Reglas + agentes para Claude Code
│   ├── agents/
│   ├── commands/
│   └── rules/                 # 7 archivos: supabase, ui-ux, meli-api, security, testing, agents, app-etiquetas, inventory-policy, whatsapp
├── .github/
│   └── workflows/             # CI (TODO: confirmar contenido)
├── .vercel/                   # Vercel project link
├── docs/                      # Docs operativos + auditorías + manuales
│   ├── auditorias/
│   ├── codebase/              # ← Esta documentación
│   ├── manuales/
│   │   ├── inventarios/
│   │   └── pricing/
│   └── meli/
├── public/
│   └── wasm/                  # Scanbot SDK (copiado en postinstall)
├── scripts/                   # Scripts ad-hoc (.ts/.mjs/.sh) — backfills, benchmarks, sync-meli-docs
├── src/
│   ├── app/                   # Next.js App Router
│   │   ├── admin/             # Panel admin (page.tsx 12k LOC, mapa, qr-codes)
│   │   ├── api/               # ~110 route handlers
│   │   │   ├── admin/
│   │   │   ├── agents/
│   │   │   ├── costos/
│   │   │   ├── debug/  debug-fix/  debug-query/
│   │   │   ├── diagnostico-recepcion/
│   │   │   ├── intelligence/
│   │   │   ├── ml/            # Más grande: ~50 endpoints
│   │   │   ├── mp/
│   │   │   ├── orders/
│   │   │   ├── picking/
│   │   │   ├── profitguard/
│   │   │   ├── proveedor-catalogo/
│   │   │   ├── proveedores/
│   │   │   ├── recepciones/
│   │   │   ├── reclasificar-stock/
│   │   │   ├── semaforo/
│   │   │   ├── sheet/
│   │   │   └── sii/
│   │   ├── conciliacion/
│   │   ├── mapa/
│   │   └── operador/          # PWA mobile (picking, recepciones, conteos, facturas)
│   ├── components/            # 33 componentes admin/operador
│   └── lib/                   # 30 archivos de lógica + __tests__
└── supabase/
    ├── archived/
    └── pending-mov/
```

### Carpetas de primer nivel — descripción

| Carpeta | Propósito |
|---|---|
| `.claude/` | Reglas, comandos y agentes para sesiones de Claude Code. `rules/` documenta convenciones del repo (supabase, UI, ML, security, etc.). |
| `.github/` | Workflows de GitHub Actions. TODO: confirmar contenido con owner. |
| `.vercel/` | Link al proyecto Vercel. No editar manualmente. |
| `docs/` | Auditorías, manuales operativos, snapshots de inteligencia, este inventario. Es la "memoria larga" del producto. |
| `public/` | Estáticos (manifest icons, wasm de Scanbot Web SDK). `public/wasm/` se rellena en `postinstall`. |
| `scripts/` | Tareas one-off: backfills (`backfill-*.ts`), clonado data prod→test, benchmarks (`benchmark-tsb.ts`), sync de docs ML (`sync-meli-docs.ts`). |
| `src/app/` | Next.js 14 App Router. UI (`/operador`, `/admin`, `/conciliacion`, `/mapa`) + ~110 API routes. |
| `src/components/` | Componentes React reutilizables (mayoría son tabs del panel admin: `Admin*.tsx`). |
| `src/lib/` | Toda la lógica de negocio: `store.ts`, `db.ts`, `ml.ts`, `intelligence*`, `agents-*`, `forecast-*`, `tsb`, `pricing`, etc. + `__tests__/` con Vitest. |
| `supabase/` | Carpeta auxiliar — `archived/` (migraciones viejas) y `pending-mov/` (helpers SQL pendientes). NO confundir con las migraciones reales que viven en la raíz como `supabase-v*.sql`. |

## Archivos de configuración raíz

| Archivo | Rol |
|---|---|
| `package.json` | Dependencias + scripts. Sin `engines`, sin lint config. |
| `package-lock.json` | Lock npm. |
| `tsconfig.json` | TS strict, `target: es5`, paths `@/* → src/*`, excluye `scripts/`. |
| `tsconfig.tsbuildinfo` | Caché incremental TS. |
| `next.config.js` | Mínimo: solo `reactStrictMode: true`. |
| `next-env.d.ts` | Tipos generados por Next. No editar. |
| `vercel.json` | 19 cron jobs (ver Fase 3). Sin más config (no rewrites, headers, ni functions overrides). |
| `manifest.json` | PWA: theme color `#0a0e17`, orientation portrait, standalone. |
| `.env.local` | Credenciales (Supabase prod + test, SII server). **No commiteado** (por `.gitignore`). |
| `.env.test` | Variables del modo test. |
| `.mcp.json` | Configuración de MCP servers. |
| `.gitignore` | (100B — minimalista) |
| `CLAUDE.md` | Guía para Claude Code en el repo. |
| `README.md` | Resumen ultra corto. |
| `plan.md` | Plan histórico (8.8KB, marzo). TODO: confirmar si sigue vigente. |
| `manifest.json` | Web App Manifest (PWA). |
| `template-catalogo-proveedores.xlsx` | Template Excel para carga masiva de catálogo. |
| `supabase-setup.sql` | Bootstrap inicial (anterior a v2). |
| `supabase-v2-setup.sql` … `supabase-v74-*.sql` | 111 migraciones manuales numeradas. Se ejecutan a mano en SQL Editor (no hay CLI de migrations). |

## Conteo de archivos por tipo (excluye `node_modules/`, `.next/`, `.git/`)

| Extensión | Cantidad |
|---|---:|
| `.ts` | 161 |
| `.tsx` | 45 |
| `.sql` | 111 |
| `.md` | 51 |
| `.json` | 11 |
| `.js` | 6 |

## Notas

- El repo no tiene linter configurado (`npm run build` valida tipos vía Next).
- `scripts/` está fuera del `tsconfig` (excluido), por eso usa `tsx` para ejecutar.
- Hay 2 versiones del archivo de migrations en algunos números (p. ej. `v15-sku-intelligence.sql` y `v15-ventas-razon-social.sql`): el numerado sufre colisiones porque dos PRs distintos usaron el mismo `vN`. Confirmar con owner si esto es intencional o convención.
