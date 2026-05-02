# Sprint 4 — Camino 1: humanos + dashboards

**Owner:** Vicente Elías
**Fecha:** 2026-05-03
**Branch:** `sprint-4-camino-1-manual`
**Tag:** `[batch:20260503-4]`
**Decisión owner mayor (2026-05-03):** apagar agentes AI, operar Camino 1.

## Decisión y motivación

Pre-Sprint 4, agent_runs tenía **46.637 corridas en 30 días, todas en
`estado='error'`** (API key apagada para no gastar). Cero decisiones reales
estaban siendo tomadas por agentes — el sistema operaba 100% por dashboards
de Inteligencia + decisiones humanas. Continuar con la fachada de "agentes
activos" era ruido sin valor.

Owner eligió Camino 1 (humanos + fórmulas + dashboards) por:

- Volumen actual: 425 SKUs activos, manejable manualmente.
- Foundation IA (Sprints 0–3) queda lista: reactivación es revertir un
  commit + restaurar API key cuando volumen lo requiera.
- Costo: $0/mes vs $5-100/mes de Camino 2/3.

## Cambios

### 1. Apagar crons rotos (`vercel.json`)

Removida única entrada de agentes:

```json
{ "path": "/api/agents/cron", "schedule": "0 8 * * *" }
```

Quedan 25 crons activos (motor recalcular, policy sync, ML, pricing, etc.).

### 2. Marcar endpoints como DEPRECATED (sin eliminar)

6 archivos con header DEPRECATED + `console.warn` al cold-start:

- `src/app/api/agents/chat/route.ts`
- `src/app/api/agents/cron/route.ts`
- `src/app/api/agents/feedback/route.ts`
- `src/app/api/agents/rules/route.ts`
- `src/app/api/agents/run/route.ts`
- `src/app/api/agents/status/route.ts`

Código se mantiene dormante para reactivación futura.

### 3. Migration: archivar errores

`supabase/migrations/20260503180000_sprint4_archive_agent_errors.sql`

- Crea `_sprint4_archive_agent_runs_pre_2026_05` (`LIKE agent_runs`).
- Mueve filas con `created_at < now() - INTERVAL '1 day'`.
- **45.515 filas archivadas, 2.225 activas** (las del último día con cron
  vivo). Tras deploy + remoción del cron las 2.225 quedan estáticas y un
  futuro re-archive las moverá.

Tag `[non-reversible:agent-runs-pre-2026-05-archived-46k-error-rows]`.

### 4. Migration: vistas SQL para reposición

`supabase/migrations/20260503180100_sprint4_reposicion_views.sql`

4 vistas (`CREATE OR REPLACE`, idempotentes):

- **`v_safety_stock`** — SS + cycle_stock + ROP + pre_full_target. Lee
  `sku_node_policy` + `sku_intelligence` + `proveedores`. Fórmula
  combinada cuando `σ_LT >= 2` (importados China), simple cuando `< 2`
  (Idetex local). Margen 7.5% por return rate. Excluye CZ y blocked.
- **`v_compras_pendientes`** — solo `bodega_central`, solo bajo ROP.
  `clp_estimado=NULL` cuando sin costo (`feedback_no_inferir_costos`).
- **`v_alertas_quiebre`** — solo bajo ROP, con `nivel_alerta` y
  `prioridad`.
- **`v_reposicion_dashboard`** — master para `/admin/reposicion-suggestions`.

**Adaptaciones spec → schema real:**
- `policy_action` → `action`
- `z_score` → `z_value`
- `sigma_demand_sem` → `desviacion_std` (semanal)
- `on_hand` → `qty_on_hand`
- `in_transit` → `qty_in_transit` + `to_node_id`

### 5. Página y endpoint

- `src/app/admin/reposicion-suggestions/page.tsx` — tabla ordenable,
  filtros (alerta, celda, proveedor, bajo_rop), columnas opcionales,
  CSV export, "Copiar para OC" (clipboard SKU\tQty\tProveedor),
  banner KPIs.
- `src/app/api/admin/reposicion-suggestions/route.ts` — GET sirve
  `data + summary` ordenado por `prioridad ASC, clp_estimado DESC`.

### 6. Docs

- `docs/operations/reposicion-manual.md` — runbook humano (diario,
  semanal, mensual; cómo crear OC; override manual; reactivación
  agentes).
- `docs/sprints/sprint-4-camino-1-manual.md` — este doc.
- `CONVENTIONS.md` §6 — Operación Camino 1.
- `metrics.yaml` — métricas safety_stock, reorder_point, cycle_stock,
  pre_full_target, qty_a_comprar, dias_cobertura_actual.

## Estado al deploy

| Métrica | Valor |
|---|---|
| Crons removidos | 1 (`/api/agents/cron`) |
| Endpoints marcados DEPRECATED | 6 |
| Filas archivadas | 45.515 |
| `agent_runs` activas restantes | 2.225 (último día pre-deploy) |
| Vistas creadas | 4 |
| Filas en `v_safety_stock` | 370 |
| Filas en `v_compras_pendientes` | 14 |
| Tests `tests/sprint4_validation.sql` | 10/10 PASS |
| Golden tests `tests/sprint4_golden_tests.sql` | 5/5 PASS |

### Banner real al cierre del sprint

- **10** SKUs en `QUIEBRE_TOTAL`
- **1** SKU `CRITICO` (≤3d cobertura)
- **0** SKUs `URGENTE` (≤7d)
- **3** SKUs `ATENCION` (≤14d)
- **14** SKUs total bajo ROP
- **CLP $788.300** total sugerido a comprar

## Tests

### Validación (10/10 PASS)

| # | Check |
|---|---|
| T01 | Archive populated (>=40k) |
| T02 | `agent_runs` activa con margen razonable |
| T03 | 4 vistas creadas |
| T04 | `v_safety_stock` >50 rows |
| T05 | `v_compras_pendientes` 1-300 rows |
| T06 | Prioridades válidas en `v_alertas_quiebre` |
| T07 | Cero CZ en `v_compras_pendientes` |
| T08 | Dashboard rowcount = compras_pendientes |
| T09 | `nivel_alerta` solo whitelist 5 valores |
| T10 | `pre_full_target=0` cuando node_id != full_ml |

### Golden tests (5/5 PASS)

| # | Check |
|---|---|
| GT01 | Invariante ROP = round(d_avg×LT + z×σ_dia×√LT) en LITAF AX |
| GT02 | AZ con `xyz_confidence=high` tiene z=1.28 (10 SKUs; los seasonal mantienen 1.88, correcto) |
| GT03 | CY con `policy_action=reorder_minimo` (22 SKUs) |
| GT04 | CZ excluido de `v_safety_stock` (cero filas) |
| GT05 | Seasonal con z=1.88 (118 SKUs, Sprint 2.5 fallback) |

## Coordinación con sesión paralela pricing

- Sprint 4 NO toca: `pricing.ts`, `pricing-config/`, P17 de
  `intelligence.ts`, Op Limpieza, fórmulas de velocidad,
  `sku_intelligence` schema (sólo SELECT vía vistas).
- Sí toca: `agent_runs` (archive), `vercel.json` (cron removido),
  endpoints `/api/agents/*` (warn), nuevas vistas, nuevo dashboard
  admin, nuevo endpoint `/api/admin/reposicion-suggestions`.

## Próximos sprints

- **Sprint 5** (cleanup final): drop columnas zombi (`ml_items_map.stock_full_cache`),
  FKs, deprecated endpoints — TBD.
- **Sprint 6** (post-julio): migración markdown.
- **Reactivación agentes AI**: decisión futura cuando volumen lo
  requiera. Procedimiento: `/docs/operations/reposicion-manual.md` §
  "Reactivar agentes AI en el futuro".

## Rollback

```sql
-- 1. Restaurar agent_runs (si necesario):
INSERT INTO agent_runs SELECT * FROM _sprint4_archive_agent_runs_pre_2026_05
ON CONFLICT (id) DO NOTHING;

-- 2. Drop vistas:
DROP VIEW IF EXISTS v_reposicion_dashboard;
DROP VIEW IF EXISTS v_alertas_quiebre;
DROP VIEW IF EXISTS v_compras_pendientes;
DROP VIEW IF EXISTS v_safety_stock;

-- 3. Drop archive (si decisión irreversible):
DROP TABLE _sprint4_archive_agent_runs_pre_2026_05;
```

Y `git revert` del commit Sprint 4 para restaurar `vercel.json` y los
endpoints sin DEPRECATED.

## Referencias

- Migration archive: `supabase/migrations/20260503180000_sprint4_archive_agent_errors.sql`
- Migration views: `supabase/migrations/20260503180100_sprint4_reposicion_views.sql`
- Tests: `tests/sprint4_validation.sql` + `tests/sprint4_golden_tests.sql`
- Runbook: `docs/operations/reposicion-manual.md`
- Sprint 2 (política): `/docs/sprints/sprint-2-populate-policy.md`
- Sprint 2.5 (seasonal): `/docs/sprints/sprint-2.5-h2-name-fallback.md`
- Sprint 3 (trazabilidad): `/docs/sprints/sprint-3-traceability-guardrails.md`
