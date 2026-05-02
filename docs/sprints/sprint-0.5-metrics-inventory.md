# Sprint 0.5 — Inventario de métricas + metrics.yaml inicial

**Estado:** En branch `sprint-0.5-metrics-inventory` (no merge a main hasta revisión humana).
**Fecha:** 2026-05-02.
**Owner:** Vicente Elías.
**Bloquea:** Sprint 3 (refactor de velocidades) — sin metrics.yaml los agentes pueden seguir reinventando fórmulas.

---

## Por qué este sprint

Sprint 0 dejó la fundación arquitectónica (CDMP, SSoT registry, conventions). Sin embargo, las **fórmulas** que producen las métricas siguen viviendo dispersas en `intelligence.ts` (~2200 LOC), `reposicion.ts`, `tsb.ts`, `ads.ts`, etc. Cada agente que escribe código nuevo riesgo a duplicar o reinventar.

Este sprint produce el catálogo central `/metrics.yaml` con **38 métricas + 6 decisiones binarias**, documentando para cada una: fórmula exacta, tablas input, filtros, granularidad, consumidores, función SSoT pura, y referencia a doctrina.

**No modifica fórmulas ni código de runtime.** Es un sprint de discovery + documentación.

---

## Resumen de output

| Artefacto | Líneas | Path |
|---|---|---|
| Catálogo de métricas | ~700 | `/metrics.yaml` |
| Inconsistencias detectadas | ~180 | `/docs/metrics-inconsistencies-2026-05-02.md` |
| Concept registry actualizado | +60 | `/concept-registry.yml` (v2) |
| SSoT registry actualizado | +90 | `/ssot-registry.yml` (v2) |
| CONVENTIONS.md §3 actualizado | +5 | `/CONVENTIONS.md` |
| Sprint doc | este | `/docs/sprints/sprint-0.5-metrics-inventory.md` |

---

## Discovery — coverage del grep

### Archivos barridos
- `src/lib/intelligence.ts` (2200 LOC, núcleo)
- `src/lib/tsb.ts` (249 LOC)
- `src/lib/reposicion.ts` (200 LOC)
- `src/lib/costos.ts` (150 LOC)
- `src/lib/ads.ts` (121 LOC)
- `src/lib/intelligence-queries.ts`
- `src/lib/forecast-accuracy-queries.ts`
- `src/lib/ml.ts` (selectivo)
- `src/lib/ventas-cache.ts`, `store.ts`
- `src/app/api/agents/{chat,run,cron,status}/route.ts`
- `src/app/api/intelligence/{recalcular,sku/[],pendientes,sku-venta,vista-venta}/route.ts`

### Métricas inventariadas: 38 + 6 decisiones

| Categoría | Cantidad | Métricas representativas |
|---|---|---|
| Velocidad | 12 | vel_7d, vel_30d, vel_60d, vel_ponderada, vel_full, vel_flex, vel_total, vel_ajustada_evento, vel_pre_quiebre, vel_flex_pre_quiebre, vel_objetivo, vel_ponderada_tsb |
| Stock | 7 | stock_full, stock_bodega, stock_total, stock_en_transito, stock_proyectado, stock_proveedor, stock_sin_etiquetar |
| Cobertura | 3 | cob_full, cob_flex, cob_total |
| Clasificación | 7 | abc_margen, abc_ingreso, abc_unidades, xyz, cv, cuadrante, celda |
| Margen / Rentabilidad | 10 | margen_full_30d, margen_flex_30d, margen_neto_30d, margen_unitario_pre_quiebre, gmroi, dio, precio_promedio, costo_neto, costo_bruto, costo_inventario_total |
| Quiebre | 5 | dias_en_quiebre, dias_en_quiebre_flex, venta_perdida_uds, venta_perdida_pesos, ingreso_perdido |
| Reposición / Decisiones | 8 | pedir_proveedor, pedir_proveedor_sin_rampup, pedir_proveedor_bultos, factor_rampup_aplicado, mandar_full, target_dias_full, necesita_pedir, liquidacion_accion |
| Safety stock / ROP | 4 | safety_stock_completo, safety_stock_simple, rop_calculado, nivel_servicio |
| Lead time | 5 | lead_time_usado_dias, lead_time_real_dias, lead_time_real_sigma, lead_time_fuente, lt_muestras |
| Ads | 3 | ads_cost_asignado, acos, roas |
| Tendencias / Eventos | 5 | tendencia_vel, tendencia_vel_pct, es_pico, pico_magnitud, multiplicador_evento |
| Forecast | 4 | forecast_wmape_8s, forecast_bias_8s, forecast_tracking_signal_8s, forecast_es_confiable_8s |
| Actividad / Dead stock | 3 | dias_sin_movimiento, dias_sin_conteo, primera_venta |
| **Decisiones binarias** | **6** | en_quiebre_full, dead_stock, requiere_ajuste_precio, es_quiebre_proveedor, es_estacional, es_holdout |

> Nota: el total nominal (38 métricas + 6 decisiones) cuenta cada elemento del YAML una sola vez. Algunas categorías comparten métricas conceptualmente (ej. vel_pre_quiebre cae en velocidad y se referencia desde quiebre), pero en el YAML aparece bajo una categoría.

### Tabla `sku_intelligence`: 139 columnas inspeccionadas

Composición:
- ~75 columnas son **métricas/decisiones** (cubiertas en metrics.yaml)
- ~30 son **metadata** (id, sku_origen, nombre, categoria, proveedor, skus_venta, updated_at, datos_desde/hasta, primera_venta, etc.)
- ~25 son **flags / overrides** manuales (es_estacional, es_holdout, vel_objetivo, holdout_asignado_at, estacional_motivo, etc.)
- ~10 columnas tienen `COMMENT` SQL — el resto sigue sin documentación inline (deuda técnica menor; metrics.yaml es ahora la fuente de verdad).

### Materialized views: 0
Hay **0 materialized views** en producción. Hay 16 vistas planas (`v_*`):
- Inventario: `v_stock_disponible`, `v_stock_proyectado`, `v_timeline_sku`, `v_evolucion_sku`, `v_skus_vencidos_conteo`, `v_skus_mejoraron`, `v_tendencia_mensual`, `v_impacto_acciones`
- IRA: `v_ira_semanal_global`, `v_ira_semanal_abc`
- Pricing: `v_precio_lowest_30d`, `v_precio_piso_actual`, `v_precio_piso_por_canal`, `pricing_changes_audit` (NO TOCAR — sesión paralela)
- Otros: `vista_venta`, `ml_campaigns_monthly_summary`

Sprint 3 evalúa migrar las vistas más costosas (v_timeline_sku, v_evolucion_sku) a MVs si la latencia justifica.

---

## Inconsistencias detectadas

**Total: 10** (`docs/metrics-inconsistencies-2026-05-02.md` tiene el detalle).

| ID | Métrica | Tipo | Sprint que resuelve |
|---|---|---|---|
| I1 | `xyz` (bandas 0.5/1.0 vs 0.25/0.60 H2) | Divergencia código ↔ decisión | **3** |
| I2 | `cob_*` y `dio` centinela 999 | Excepción admitida sin documentar columna | 4 |
| I3 | `stock_full` doble fuente | Legacy column ↔ tabla canónica | 3 |
| I4 | Filtro `anulada` divergente (`.eq` vs `.neq`) | Normalización | 3 |
| I5 | `stock_en_transito` no derivado runtime | Trigger-dependiente | 5 (monitor) |
| I6 | `vel_objetivo` sin guardrails | Validation gap | 3 |
| I7 | `nivel_servicio` hardcoded | Hardcoded ↔ policy_templates | **1** |
| I8 | `target_dias_full` cascada | intel_config ↔ policy_templates | **1** |
| I9 | Imputación `margen_neto_30d` quiebre | Sin marker explícito | 3 |
| I10 | `vel_ponderada_tsb` shadow | No consumida aún | 5 (Fase C) |

**Bloquean Sprint 1:** I7, I8 (consumir `policy_templates`).
**Bloquean Sprint 3:** I1, I3, I4, I6, I9.
**Backlog:** I2, I5, I10.

Ninguna inconsistencia es production-breaking hoy. Ninguna requiere hotfix.

---

## Métricas que no tenían fórmula clara (dependencia de cache only)

- **`xyz`** (I1) — fórmula existe en `intelligence.ts:1192-1196` pero **diverge** de decisión H2. Documentar en YAML la real (con nota explícita) y resolver en Sprint 3.
- **`stock_proveedor`** — agregación implícita, no se vio fórmula explícita en grep. Documentado en YAML como "suma de proveedor_catalogo.stock_disponible filtrado por SKU"; Sprint 3 verifica.
- **`stock_sin_etiquetar`** — concepto claro pero implementación dispersa. Documentado a alto nivel en YAML; Sprint 3 unifica.
- **`liquidacion_accion`** — pendiente cierre H5 (Camino A/B/C). Marcada en YAML como "no modificar".

---

## Updates en registries

### concept-registry.yml (v2)
Agregados 7 meta-conceptos derivados:
- `velocidad`, `cobertura`, `clasificacion`, `rentabilidad`, `quiebre_metrics`, `decision_reposicion`, `ads_metrics`

Cada meta-concepto lista sus sub-métricas y enlaza al YAML.

### ssot-registry.yml (v2)
Agregados 6 SSoTs de métricas:
- `velocidad_sku`, `clasificacion_abc_xyz`, `decision_reposicion`, `rentabilidad_sku`, `quiebre_metrics_sku`, `ads_attribution`

Cada uno incluye: `owner_table` (cache), `ssot_function` (función pura), `consumers`, `last_audited`.

Sección nueva `external_references` apunta a `/metrics.yaml`, inconsistencias doc, CONVENTIONS, policies, manuales.

### CONVENTIONS.md §3
Sección SSoT actualizada para mencionar `metrics.yaml` como tercer artefacto SSoT (junto con `COMMENT ON COLUMN` y `ssot-registry.yml`).

---

## Definition of Done

- [x] `/metrics.yaml` creado con 38 métricas + 6 decisiones documentadas
- [x] Cada entrada tiene name, formula_sql/text, input_tables, filters, grain, unit, consumed_by, ssot_table, fuente_doctrina
- [x] Inconsistencias documentadas en `/docs/metrics-inconsistencies-2026-05-02.md` (10 hallazgos)
- [x] `/concept-registry.yml` actualizado con 7 meta-conceptos métrica (>6)
- [x] `/ssot-registry.yml` actualizado con 6 entradas métrica
- [x] `/CONVENTIONS.md` §3 menciona `metrics.yaml`
- [x] Este sprint doc commiteado
- [x] Branch separado `sprint-0.5-metrics-inventory` (no merge a main)
- [x] Commit con tag `[batch:20260502-2]`

---

## Lo que NO se hizo (alcance explícito)

- ❌ Modificar fórmulas existentes — sólo se documentaron, sin tocar código de runtime.
- ❌ Crear materialized views nuevas — Sprint 3+.
- ❌ Refactorizar agentes para que lean `metrics.yaml` — Sprint 3+.
- ❌ Resolver las 10 inconsistencias — sólo se documentaron; resolución en Sprints 1, 3, 4 según prioridad.
- ❌ Tocar archivos de pricing — sesión paralela, fuera de scope.

---

## Próximos sprints

| Sprint | Enfoque | Inconsistencias que resuelve |
|---|---|---|
| **1** | Consumir `policy_templates` en intelligence.ts (z, service_level, target_dias_full por celda) | I7, I8 |
| **2** | (placeholder) ROP forecasting integration | — |
| **3** | Refactor de velocidades + alineación XYZ con H2 + filtros uniformes + guardrails vel_objetivo | I1, I3, I4, I6, I9 |
| **4** | Cleanup centinelas → NULL (cob_*, dio) | I2 |
| **5** | Monitor stock_en_transito + Fase C TSB activación condicional | I5, I10 |

---

## Tiempo invertido

- Discovery (grep + SQL inspection): ~10 min (parallel agents)
- Construcción metrics.yaml: ~12 min
- Inconsistencies doc: ~5 min
- Registries update: ~5 min
- Sprint doc + CONVENTIONS: ~3 min
- **Total: ~35 min** (descubrimiento + redacción).
