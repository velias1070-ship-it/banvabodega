# Sprint 3 — Trazabilidad y guardrails (I4, I6, I9)

**Owner:** Vicente Elías
**Fecha:** 2026-05-03
**Branch:** `sprint-3-traceability-guardrails`
**Tag:** `[batch:20260503-3]`
**Migración:** `supabase/migrations/20260503150000_sprint3_traceability_guardrails.sql`
**Tests:** `tests/sprint3_validation.sql` (10/10 PASS)

## Contexto

Sprint 3 cierra 3 inconsistencias detectadas en el inventario Sprint 0.5
sin tocar fórmulas de velocidad. Decisión owner Opción C: censoring de
`vel_7d` se posterga a post-Sprint 4 (shadow mode A/B comparará v1 vs v2).
Acá solo se agregan **trazabilidad** y **guardrails** para que decisiones
posteriores (Reposición v2, Pricing v2) tengan datos confiables.

## Inconsistencias resueltas

### I4 — Filtro `anulada` divergente

- **Antes:** `src/lib/store.ts:1205` usaba `.neq("anulada", true)` mientras
  el resto del codebase ya estaba unificado en `.eq("anulada", false)` (12
  hits ya correctos).
- **Riesgo de datos:** 0 (audit Sprint 0.5 confirmó `anulada IS NULL = 0`).
- **Cambio:** unificación a `.eq("anulada", false)` + lint en CI.
- **Anti-regresión:** workflow `lint-banned-patterns.yml` corre script
  `scripts/lint-banned-patterns.sh` en cada PR que toque `src/**`. Falla
  con `::error::` si reaparece `.neq("anulada", true)` o variante con
  comilla simple. Registry canónico: tabla `lint_forbidden_patterns`.

### I6 — `vel_objetivo` sin guardrails

- **Antes:** la columna admitía cualquier valor numérico. UI o RPC podía
  setear `-1`, `999999`, etc., contaminando `sku_intelligence_history` y
  rompiendo cálculos de forecast.
- **Estado al deploy:** `min=max=0` en 509 SKUs. Sin outliers. CHECK
  aplica directo, no se reseteó nada.
- **Cambio 1:** CHECK `sku_intelligence_vel_objetivo_sane` que rechaza:
  - valores negativos
  - valores > `vel_ponderada × 100` (cuando `vel_ponderada > 0`)
  - permite NULL y permite cualquier valor cuando `vel_ponderada IS NULL`
    o `0` (defensivo: sin baseline, no se puede comparar)
- **Cambio 2:** RPC `validate_vel_objetivo_input(sku_origen, vel_objetivo)`
  que retorna `(is_valid, reason, vel_ponderada_actual, max_aceptable)`.
  Razones: `negativo_no_permitido`, `demasiado_alto_vs_vel_real`,
  `sku_no_existe`, `null_aceptable`, `ok`. La UI debe llamarla **antes**
  del UPDATE y mostrar `reason` al usuario en caso de fallo.

### I9 — `margen_neto_30d` imputado en quiebre sin marker

- **Antes:** cuando un SKU está >=14 días en quiebre y `vel_pre_quiebre>2`,
  `intelligence.ts:1681-1683` calcula `imputado = vel_pq × margen_unit ×
  4.3` y guarda `max(real, imputado)`. Sin flag, no era posible distinguir
  margen observado de margen imputado al consumirlo aguas abajo.
- **Cambio schema:** columnas `margen_neto_30d_imputed boolean NOT NULL
  DEFAULT false` en `sku_intelligence` y `sku_intelligence_history`.
- **Cambio código:** `intelligence.ts` ahora setea
  `r.margen_neto_30d_imputed = imputado > margenReal` exactamente cuando
  el `Math.max()` tomó el imputado. Persiste vía `recalcular/route.ts:499`
  y `intelligence.ts:2273`.
- **Backfill histórico:** se marca `imputed=true` en cada fila de
  `sku_intelligence_history` cuya ventana 30d anterior tenga >=15 días con
  `en_quiebre_full=true OR en_quiebre_bodega=true` en `stock_snapshots`.
  Mismo criterio en la fila viva de `sku_intelligence`.
- **Resultado backfill:** 22 SKUs en `sku_intelligence` y 37 snapshots en
  `sku_intelligence_history` (de 6391 totales = 0.6%) marcados.

## Tests (10/10 PASS)

| # | Check | Resultado |
|---|---|---|
| T01 | `sku_intelligence.margen_neto_30d_imputed` columna NOT NULL bool | PASS |
| T02 | `sku_intelligence_history.margen_neto_30d_imputed` columna | PASS |
| T03 | CHECK `sku_intelligence_vel_objetivo_sane` existe | PASS |
| T04 | CHECK rechaza UPDATE con valor negativo | PASS |
| T05 | RPC `validate_vel_objetivo_input` existe | PASS |
| T06 | RPC retorna `negativo_no_permitido` para valor < 0 | PASS |
| T07 | RPC retorna `null_aceptable` para NULL | PASS |
| T08 | RPC retorna `sku_no_existe` para SKU inválido | PASS |
| T09 | Backfill consistente (22 SKUs marcados = 22 con >=15 días quiebre) | PASS |
| T10 | `lint_forbidden_patterns` tiene los 2 patrones registrados | PASS |

## Coordinación con sesión paralela pricing

Sin conflicto:
- Sprint 3 toca `sku_intelligence` (ADD COLUMN + CHECK), `sku_intelligence_history` (ADD COLUMN), tabla nueva `lint_forbidden_patterns`, RPC nuevo `validate_vel_objetivo_input`, `intelligence.ts` márgen imputed wiring (sin tocar P17), `store.ts:1205`.
- Sprint 3 NO toca: `pricing.ts`, `pricing-config/`, P17 de `intelligence.ts`, fórmulas de velocidad, agente Reposición, motor ABC/XYZ.
- Numeración migration: `20260503150000` (track main, +2h sobre Sprint 2.5).

## Fuera de alcance (explícito)

- Censoring de `vel_7d` (Opción C aplaza a post-Sprint 4).
- `v_cv_52sem` deseasonalizada (Sprint 7+).
- DROP de `ml_items_map.stock_full_cache` (Sprint 5).
- Granularidad diaria (Adendum A.2.2: opcional, no acordado).

## Decisiones futuras habilitadas por Sprint 3

1. **Sprint 4 Reposición v2:** puede consumir `margen_neto_30d_imputed`
   para descontar el peso del margen imputado en decisiones de compra
   (un SKU con margen alto pero `imputed=true` no es "rentable observado",
   es "rentable proyectado").
2. **Sprint 4+ UI vel_objetivo:** debe llamar
   `validate_vel_objetivo_input` antes de cualquier UPDATE manual.
3. **Sprint 6 Pricing v2:** puede filtrar por `imputed=false` cuando
   necesita margen "realmente observado" para elasticidad.

## Referencias

- Migration: `supabase/migrations/20260503150000_sprint3_traceability_guardrails.sql`
- Tests: `tests/sprint3_validation.sql`
- Lint script: `scripts/lint-banned-patterns.sh`
- CI workflow: `.github/workflows/lint-banned-patterns.yml`
- Registry SQL: `lint_forbidden_patterns` (no usar en runtime)
- Adendum A.2.2 (granularidad semanal/diaria, decisión owner)
- H27 (filtro anulada unificado, Sprint 0.5)
