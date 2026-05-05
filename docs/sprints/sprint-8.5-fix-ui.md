---
sprint: 8.5
title: Hotfix UI — leak de columnas legacy del motor viejo
date: 2026-05-05
owner: Vicente Elías
tags: [hotfix:sprint-8.5-ui-leak] [hotfix:cob-full-restored] [sprint:8.5]
related:
  - docs/sprints/sprint-8-cleanup.md
  - docs/policies/motor-canonico.md
---

# Sprint 8.5 — Fix UI lee motor nuevo

## TL;DR

Auditoría externa post-Sprint 8 Fase 1 detectó que la rama
`useNewEngine=true` seguía leyendo columnas operativas de
`sku_intelligence` (motor viejo) en lugar de `v_reposicion_explain`.
Drift confirmado en SKUs reales:

| SKU | UI mostraba | Motor nuevo | Δ |
|---|---|---|---|
| TXV24QLBRBA15 | mandar_full=14 | 12 | −2 (Sprint 7 Fase 0.B protege Flex) |
| TXV24QLBRDN20 | liquidacion=NULL | descuento_10 | spec Sprint 7 Fase 3 |

3 superficies actualizadas. Tests SQL PASS. Sin migración. Sin push.

## Cambios

### 1. `src/components/AdminInteligencia.tsx` — `cargarOrigen()` (líneas 526-602)

**Query A** (`v_reposicion_explain`) ahora trae 14 columnas canónicas:

- `mandar_full:mandar_full_uds` (Sprint 7 Fase 0.B con protección Flex)
- `accion`, `prioridad:prioridad_nueva` (Sprint 6 Fase 2)
- `liquidacion_accion`, `liquidacion_descuento_sugerido` (Sprint 7 Fase 3)
- `dio` (Sprint 7 Fase 2)
- `alertas`, `alertas_count` (Sprint 7 Fase 4)
- `is_new_sku` (Sprint 6 Fase 3)
- `in_transit_picking_full` (Sprint 7 Fase 0.A)
- `inner_pack`, `d_avg_sem`, `deficit_full`, `disponible_para_full`

Removidas de Query A: `mandar_full` legacy, `pedir_proveedor_motor_viejo`,
`pedir_proveedor_sin_rampup`.

**Query B** (caso C `sku_intelligence`) reducida — quitadas 8 columnas
ahora canónicas en Query A. Mantiene Tier 1 no portado:
`abc/xyz/cuadrante`, `gmroi`, `vel_objetivo+gap`, `venta_perdida_*`,
`vel_full/flex+pct`, `margen_*`, `forecast_*_8s`, etc.

**Merge**: agregada conversión `liquidacion_descuento_sugerido` decimal
0..1 → entero 0..100 (motor nuevo guarda fracción, UI espera porcentaje).

Aliases SQL `mandar_full:mandar_full_uds` y `prioridad:prioridad_nueva`
mantienen el shape `IntelRow` v1 sin tocar componentes downstream.

### 2. `src/app/api/intelligence/sku-venta-v2/route.ts` (líneas 60-78, 326-330)

Mismo patrón que AdminInteligencia. Query A canónica con aliases.
Query B reducida. Conversión escala 0..1→0..100 en `result.push`.

### 3. `src/app/admin/page.tsx` — tab stock disponible (línea 11386)

Migrado de `sku_intelligence.select(...)` a parallel split:

- **Query principal**: `v_reposicion_explain` con aliases
  `vel_ponderada:vel_decl_sem` y `mandar_full:mandar_full_uds`,
  `dias_cobertura_actual` reemplaza `cob_full`, `accion` directo.
- **Query secundaria**: `sku_intelligence` solo para `vel_full`
  (Tier 1 no portado — `vel_full` no existe en motor nuevo).

`fullMap.vel` usa `velFullMap.get(sku) || vel_ponderada` (mismo fallback
que antes).

### 4. `src/app/admin/page.tsx` — SKU drawer (línea 7666)

Split paralelo: `sku_intelligence` para `vel_30d/dias_sin_movimiento/abc/stock`
+ `v_reposicion_explain` solo para `accion`.

## ⚠️ Hallazgos durante el fix

### `dias_cobertura_actual` ≠ `cob_full` (semántica distinta) — RESUELTO en v3

La spec asumía rename 1:1, pero los conceptos divergen:

| SKU | `v_reposicion_explain.dias_cobertura_actual` | `sku_intelligence.cob_full` | Δ |
|---|---|---|---|
| TXV24QLBRMA15 | 30 | 5.37 | +24.63 |
| ALPCMPRKZ4575 | 28 | 4.03 | +23.97 |
| JSECBQ001P20Z | 31 | 7.81 | +23.19 |
| TXV24QLBRBA15 | 36 | 19.2 | +16.80 |

`cob_full` mide días de cobertura **solo del nodo Full** (stock_full / vel_full × 7).
`dias_cobertura_actual` mide días totales (stock_total / d_avg_dia).

**Decisión owner (Opción 2)**: agregar `cob_full` a `v_reposicion_explain`
y revertir Fix 6. Migración `20260505150000_sprint85_cob_full_in_reposicion_explain.sql`.

#### Iteraciones del fix

- **v1** (descartado, 12.9% paridad): `stock_full / (d_avg_dia * 7)`. Falla porque
  `d_avg_dia` mide demanda total, no full-only.
- **v2** (descartado, 18.1% paridad): `stock_full / (vel_full / 7)` con `vel_full`
  almacenado en `sku_intelligence`. Falla porque `vel_full` está `round2()` y para
  velocidades bajas (<1 uds/sem) el round pierde precisión.
- **v3** (vigente, 99.5% paridad): `stock_full / ((vel_ponderada * pct_full) / 7)`
  con branch evento (`vel_ajustada_evento * pct_full` si `multiplicador_evento>1`).
  Mirror exacto del motor viejo `intelligence.ts:1218,1221` — full precision antes
  del round. TXV24QLBRBA15: cob_full=19.20 ✓ matches legacy 19.2.

#### Tests v3 (sobre la view nueva)

- Paridad: 220/221 (99.5%), delta promedio 0.30, delta max 66.67 (1 outlier).
- Outlier: drift real-time stock_full (132) vs snapshot sku_intelligence (42).
  Fórmula correcta, datos divergentes por timing del recompute legacy.
- TXV24QLBRBA15: cob_full=19.20 (esperado 19.2) ✓
- Edge case: 5+ SKUs con vel_ponderada*pct_full=0 y stock_full>0 retornan
  cob_full=999 (centinela admisible, doc en `inventory-policy.md` Regla 1).

### Fix 6 revertido

`src/app/admin/page.tsx:11396` SELECT vuelve a usar `cob_full` directo desde
`v_reposicion_explain` (en vez de `dias_cobertura_actual`). `vel_full` (Tier 1)
sigue en split paralelo desde `sku_intelligence` hasta Sprint 9+.

### `vel_full` no portada — Tier 1 scope Sprint 9+

La spec de Fix 6 incluía `vel_full` en el SELECT a `v_reposicion_explain`,
pero esa columna no existe en el motor nuevo (es split por canal Full).
Aplicado parallel-split (mismo patrón que Fix 7) para preservar la
funcionalidad sin regresar.

## Tests SQL ejecutados

```sql
-- T1 mandar_full drift TXV24QLBRBA15
mandar_full_uds=12 vs sku_intelligence.mandar_full=14 ✓

-- T2 liquidación TXV24QLBRDN20
liquidacion_accion=descuento_10
liquidacion_descuento_sugerido=0.100 → escala UI 10 ✓

-- T3 TXTPBL20200SK in_transit_picking_full ahora expuesto en vista ✓

-- T4 TXV23QLAT20AQ
d_avg_sem=3.57 (= vel_pre_quiebre, vs vel_ponderada=2.11)
rama Sprint 6 Fase 1 activa ✓
```

## Tier 1 NO portado en este sprint (scope Sprint 9+)

Estas columnas siguen consumiéndose desde `sku_intelligence` vía
parallel-fetch (Query B en AdminInteligencia / sku-venta-v2, o split
paralelo en admin/page.tsx):

- `vel_objetivo`, `gap_vel_pct` (único campo editable inline)
- `gmroi`, `gmroi_potencial`
- `cob_full` (cobertura solo Full — distinta de `dias_cobertura_actual`)
- `vel_full`, `vel_flex`, `pct_full`, `pct_flex`
- `margen_full_30d`, `margen_flex_30d`, `margen_neto_30d_imputed`
- `venta_perdida_pesos`, `oportunidad_perdida_es_estimacion`
- `canal_mas_rentable`, `precio_promedio`, `costo_neto`, `costo_bruto`,
  `ingreso_30d`
- `forecast_*_8s`, `es_estacional`
- `abc_pre_quiebre`, `es_catch_up`
- `dias_sin_stock_full`, `dias_sin_movimiento`
- `stock_proveedor`, `tiene_stock_prov`

Ver `/docs/policies/motor-canonico.md` "Pendiente Sprint 9+".

## Definition of done

- [x] Fix 1 — Query A con 14 columnas canónicas
- [x] Fix 2 — Query B sin redundancias (8 columnas movidas a Query A)
- [x] Fix 3 — Conversión decimal→entero en `liquidacion_descuento`
- [x] Fix 4 — Merge usa `mandar_full_uds` (vía SQL alias)
- [x] Fix 5 — `sku-venta-v2` actualizado
- [x] Fix 6 — admin/page.tsx tab stock (revertido a `cob_full` post v3)
- [x] Fix 7 — SKU drawer con accion del motor nuevo
- [x] Fix 8 — `cob_full` agregado a `v_reposicion_explain` (mig v3, 99.5% paridad)
- [x] Tests 1-4 PASS + tests cob_full v3 PASS
- [x] Build OK
- [x] Sprint doc (este archivo)
- [x] Commit local
- [x] Push a main

## Gap doctrinal pendiente Sprint 9

Identificado durante v3:

1. **`vel_full_pre_quiebre`**: SKU con quiebre Full prolongado + Flex vendiendo
   tiene `vel_ponderada*pct_full=0` → `cob_full=999`. Ningún motor cubre este caso.
   Sprint 9 candidato: agregar `vel_full_pre_quiebre` en `sku_intelligence` análogo
   a `vel_pre_quiebre` (Sprint 6 Fase 1).

2. **`vel_full` precision drift**: Almacenar `vel_full` con `round2()` causa
   drift en cualquier reverse-derive. Sprint 9 candidato: cambiar a `round4()`
   o computar on-the-fly desde `vel_ponderada * pct_full` en queries.

3. **Tier 1 columnas no portadas** (siguen en `sku_intelligence` vía split):
   `vel_objetivo`, `gap_vel_pct`, `gmroi`, `gmroi_potencial`, `vel_flex`,
   `pct_full`, `pct_flex`, `margen_*`, `venta_perdida_*`, `forecast_*_8s`,
   `abc_pre_quiebre`, `dias_sin_stock_full`, `dias_sin_movimiento`,
   `stock_proveedor`, `tiene_stock_prov`. Ver `/docs/policies/motor-canonico.md`.

## NO tocado

- `/admin/reposicion-suggestions` (DebugBanner intencional, scope Sprint 9+)
- Pricing / Ads / Agentes (siguen consumiendo `sku_intelligence`,
  scope Sprint 9+)
- Columnas Tier 1 (vel_objetivo, gmroi, etc.) — pass-through Query B
- Columnas de `sku_intelligence` siguen activas en BD
