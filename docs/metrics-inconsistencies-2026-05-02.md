# Métricas — Inconsistencias detectadas (Sprint 0.5)

**Fecha:** 2026-05-02
**Generado por:** Sprint 0.5 — Inventario de métricas
**Última revisión:** 2026-05-02 (post-confirmación owner sobre H2)
**Estado:** Documentado, sin resolver. Resolución prevista en Sprints 1, 3, 4, 5 según prioridad.

Cada hallazgo tiene un ID `I<n>`. Sprint que resuelve está indicado al final de cada entrada.

> **Revisión 2026-05-02:** I1 originalmente flagueada como divergencia código ↔ H2.
> Vicente confirmó (revisión post-Sprint-0) que H2 cerró ratificando el **status quo**:
> bandas 0.5 / 1.0, CV crudo, deseasonalización al backlog, flag `xyz_confidence` pendiente.
> El código actual está alineado con la decisión vinculante. I1 movido a sección
> "Alineadas (false positives)" abajo. **Total inconsistencias reales: 9.**

---

## I2 — Centinelas numéricos 999 en `cob_full` y `dio` cuando velocidad ≤ 0

**Métricas afectadas:** `cob_full`, `cob_flex`, `cob_total`, `dio`.

**Sitio A — código:** `src/lib/intelligence.ts:1944` y similares (`reposicion.ts:107-110`)
```typescript
cob_full = vel_full > 0 ? round2((stock_full / vel_full) * 7) : 999
```

**Sitio B — política:** `docs/policies/inventory-policy.md` regla 1 prohíbe centinelas numéricos para enmascarar NULL. Adendum hace excepción explícita para `cob_full`.

**Sitio C — código alterno:** `dias_sin_conteo` y `dias_sin_movimiento` SÍ usan NULL (correcto). Comentarios en columnas confirman: *"Regla 1 inventory-policy.md (no usar centinela 999)."*

**Diff:** Tres columnas similares con contratos opuestos en el mismo modelo.

**Recomendación canónica:**
- **Mantener 999 en cob_full/cob_flex/cob_total/dio por ahora** (excepción ya aprobada en adendum).
- **Documentar el contrato explícitamente** en COMMENT ON COLUMN para cada uno (4 columnas).
- **Sprint 4** evalúa migración a NULL si el costo de actualizar consumidores (UI ordena/filtra) es asumible.

**Razón:** El centinela 999 viaja por la UI sin colisionar con valores reales (un SKU jamás tendría 999d de cobertura legítima). Cambiar a NULL requiere `COALESCE`/`NULLS LAST` en todos los SELECT/ORDER BY que tocan estas columnas.

**Sprint que resuelve:** **4** (cleanup) — sólo COMMENT en Sprint 1; migración real en Sprint 4 si vale la pena.

---

## I3 — `stock_full` doble fuente (cache + columna legacy `ml_items_map.stock_full_cache`)

**Métrica afectada:** `stock_full`.

**Sitio A — canónica (post v58):** tabla `stock_full_cache`, lectura via `intelligence-queries.ts:queryStockFullCache`.

**Sitio B — legacy:** `ml_items_map.stock_full_cache` (columna), deprecada en migration v58.

**Estado actual:** Sync espejo activo. La UI `/stock-compare` detecta divergencias. Motor lee la canónica.

**Recomendación canónica:** Tabla `stock_full_cache`. Sprint 3 dropea la columna legacy de `ml_items_map` previo a confirmar que ningún consumer la lee desde código (grep ya hecho — todos los lectores apuntan a la tabla, no a la columna).

**Sprint que resuelve:** **3** (refactor + DROP columna legacy).

---

## I4 — Filtros divergentes en lecturas de `ventas_ml_cache`

**Métrica afectada:** Cualquier agregación sobre `ventas_ml_cache` (vel_*, abc_*, margen_*).

**Sitios:**
- `src/lib/intelligence-queries.ts:189`: `.eq("anulada", false)` ✓
- `src/lib/forecast-accuracy-queries.ts:139`: `.eq("anulada", false)` ✓
- `src/lib/store.ts:1205`: `.neq("anulada", true)` ⚠ (semánticamente distinto si hay NULLs)

**Diff:** `.eq("anulada", false)` excluye filas con `anulada=NULL`; `.neq("anulada", true)` las incluye.

**Recomendación canónica:** `.eq("anulada", false)` en TODA lectura analítica (per `feedback_ventas_anuladas_filter` y H27 cerrado).

**Razón:** Garantizar uniformidad. Verificar primero si hay filas con `anulada=NULL` en prod — si las hay, decidir su semántica (probablemente inválidas y requieren backfill a `false`).

**Sprint que resuelve:** **3** (alineación de queries) — junto con auditoría de NULLs en `anulada` y backfill si aplica.

---

## I5 — `stock_en_transito` no se deriva de `ordenes_compra_lineas` en runtime

**Métrica afectada:** `stock_en_transito`.

**Sitio A — comportamiento esperado:** Cálculo desde `ordenes_compra_lineas.cantidad_pedida − cantidad_recibida` filtrado por estado de OC.

**Sitio B — comportamiento real:** Se carga como campo directo, vía query agregada que depende de un trigger RPC `trg_recepcion_lineas_sync_ocl` que mantiene `cantidad_recibida` actualizado.

**Riesgo:** Si el trigger falla o lag de sync, `stock_en_transito` diverge del estado real. Inventory-policy regla 5 documenta el riesgo.

**Recomendación canónica:** Mantener trigger pero agregar **monitor diario** que compare `stock_en_transito` calculado vs persistido. Si delta > X% → alerta.

**Sprint que resuelve:** **5** (cleanup) — monitor opcional, no es bloqueante.

---

## I6 — `vel_objetivo` sin validación de rango

**Métrica afectada:** `vel_objetivo`, downstream `gap_vel_pct`.

**Sitio:** Endpoint `POST /api/intelligence/sku/_bulk` y `PATCH /api/intelligence/sku/[sku_origen]/vel-objetivo`. Acepta cualquier número positivo.

**Riesgo:** `vel_objetivo=999` con `vel_ponderada=2` → `gap_vel_pct = -99.8%`. Confunde la UI sin error claro.

**Recomendación canónica:** Validar `vel_objetivo > 0 AND vel_objetivo < 100 × max(vel_ponderada, 1)` en el endpoint. Mensaje de error claro. Audit log para overrides extremos.

**Sprint que resuelve:** **3** (alineación de queries y validators).

---

## I7 — `nivel_servicio` hard-coded por ABC en código vs lookup en `policy_templates` (Sprint 1+)

**Métrica afectada:** `nivel_servicio`, downstream `safety_stock_completo`, `rop_calculado`, `pedir_proveedor`.

**Sitio A — código actual:** `intelligence.ts:1846` y similares.
```typescript
const Z = abc === "A" ? 1.88 : abc === "C" ? 1.28 : 1.65;
const nivel_servicio = abc === "A" ? 0.97 : abc === "C" ? 0.90 : 0.95;
```

**Sitio B — decisión H3 cerrada:** `policy_templates` con 9 valores distintos por celda ABC×XYZ (creada en Sprint 0).

**Diff:** Hoy hay 3 valores distintos (A=0.97, B/default=0.95, C=0.90). H3 prescribe 8 valores no-NULL distintos (CZ=NULL, no_reorder).

**Recomendación canónica:** Refactor a `LEFT JOIN policy_templates ON cell = abc_margen || xyz` y leer `service_level`/`z_value`. Si `service_level=NULL` (CZ), `pedir_proveedor=0`.

**Sprint que resuelve:** **1** (consumir `policy_templates`).

---

## I8 — `target_dias_full` cascada por `abc` vs `policy_templates` por celda (post H11)

**Métrica afectada:** `target_dias_full`, downstream `pedir_proveedor`, `mandar_full`.

**Sitio A — código actual:** `intelligence.ts:1774-1779`. Lee `intel_config.targetDiasA/B/C`. 3 valores.

**Sitio B — decisión H11 cerrada:** `policy_templates.target_dias_full` con 5 valores no triviales (A=42, B=28, CX=15, CY=7, CZ=0).

**Recomendación canónica:** Refactor análogo a I7 — lookup en `policy_templates` por celda. Sprint 1.

**Sprint que resuelve:** **1**.

---

## I9 — Imputación de `margen_neto_30d` en quiebre prolongado: lógica especial sin marcador explícito en Pareto

**Métrica afectada:** `margen_neto_30d`, downstream `abc_margen`.

**Sitio:** `intelligence.ts` (~línea 1650+). Para SKUs en quiebre prolongado (≥14d, vel_pre>2), `margen_neto_30d` se imputa como `vel_pre × margen_unitario_pre × 4.3`.

**Riesgo:** Pareto se calcula sobre la columna mixta (real + imputado). Si los flags se desfasan o la imputación se actualiza sin la velocidad pre, ABC mostraría números falsos.

**Recomendación canónica:**
- Agregar columna `margen_neto_30d_es_imputado boolean` para auditoría.
- Validar en cada recalc que `vel_pre_quiebre × margen_unitario_pre_quiebre × 4.3` ≥ `margen_real_30d` (de lo contrario, hay desincronización).

**Sprint que resuelve:** **3** (alineación con auditoría explícita).

---

## I10 — `vel_ponderada_tsb` shadow ya está en `sku_intelligence` pero fórmula no consumida

**Métrica afectada:** `vel_ponderada_tsb`, `tsb_alpha`, `tsb_beta`, `tsb_modelo_usado`.

**Sitio:** `tsb.ts` calcula y persiste en cada recalc. Ningún consumer lo lee productivamente.

**Recomendación canónica:** Mantener shadow hasta que `forecast_es_confiable_8s` tenga ≥4 semanas de data acumulada con WMAPE bajo. Sprint 5 evalúa Fase C (consumo condicional).

**Sprint que resuelve:** **5** (Fase C condicional).

---

## Tabla resumen — inconsistencias activas

| ID | Métrica | Tipo | Sprint |
|---|---|---|---|
| I2 | `cob_*` y `dio` centinela 999 | Excepción admitida sin documentar columna | 4 (cleanup) |
| I3 | `stock_full` doble fuente | Legacy column ↔ tabla canónica | 3 |
| I4 | Filtro `anulada` divergente | `.eq` vs `.neq` ↔ NULLs | 3 |
| I5 | `stock_en_transito` no derivado runtime | Trigger-dependiente | 5 (monitor) |
| I6 | `vel_objetivo` sin guardrails | Validation gap | 3 |
| I7 | `nivel_servicio` hardcoded | Hardcoded ↔ policy_templates | **1** |
| I8 | `target_dias_full` cascada | intel_config ↔ policy_templates | **1** |
| I9 | Imputación `margen_neto_30d` quiebre | Sin marker explícito | 3 |
| I10 | `vel_ponderada_tsb` shadow | No consumida aún | 5 (Fase C) |

**Conteo activas:** 9 inconsistencias.
**Bloquean Sprint 1:** I7, I8 (consumo de `policy_templates`).
**Bloquean Sprint 3:** I3, I4, I6, I9.
**Backlog:** I2, I5, I10.

Ninguna inconsistencia es production-breaking hoy. Ninguna requiere hotfix. Todas se resuelven en orden cuando el sprint correspondiente lo dicte.

---

## Alineadas (false positives)

Hallazgos que en la primera pasada del Sprint 0.5 se clasificaron como divergencia
y resultaron ser status quo intencional (decisión owner). Se mantienen documentados
acá para que un futuro lector no vuelva a re-flaguearlos.

### I1 — Alineamiento: bandas xyz crudo (status quo confirmado H2)

**Métrica afectada:** `xyz`.

**Sitio A — código actual:** `src/lib/intelligence.ts:1192-1196`
```typescript
const cv = mean > 0 ? std / mean : 0;
let xyz: ClaseXYZ = "Z";
if (cv < 0.5) xyz = "X";
else if (cv < 1.0) xyz = "Y";
```

**Sitio B — decisión cerrada H2:** Vicente revisó las dos opciones (CV crudo 0.5/1.0
vs CV deseasonalizado 0.25/0.60) y cerró H2 manteniendo el **status quo del código**:
- Bandas 0.5 / 1.0
- CV crudo sobre semanas sin quiebre
- Deseasonalización **NO** se adopta ahora
- Flag `xyz_confidence` queda pendiente como item de backlog

**Estado:** El código y la decisión coinciden. **NO es inconsistencia operativa.**

**Razón del cierre status quo:**
- Sin 52 semanas de historia para el ≥80% del catálogo, una decomposición STL/naive es ruidosa.
- BANVA es relativamente joven; muchos SKUs no tienen un ciclo anual completo aún.
- Cambiar las bandas sin tener confianza en la deseasonalización movería SKUs a Z/Y por ruido, no por variabilidad real.

**Backlog real (NO es I1, es un sprint futuro distinto):**
- Implementar vista materializada `v_cv_52sem` que calcule CV sobre 52 semanas
  con deseasonalización (STL o estacionalidad mensual naive).
- Agregar columna `xyz_confidence` a `sku_intelligence` derivada del N de semanas
  disponibles (alta si ≥52, media 26-51, baja <26).
- **Sprint estimado: 7+** (cuando ≥80 % del catálogo tenga 52 semanas, ETA aprox. **2027-04**).
- **Bloqueante:** historia de ventas. No depende del motor.

**Sprint que resuelve:** N/A (no requiere resolución hoy). Backlog Sprint 7+.

---
