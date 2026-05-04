---
sprint: 5.5.4
title: Completar revert agotar en v_trend_detection
date: 2026-05-04 PM (post 5.5.2)
owner: Vicente Elías
tags: [batch:20260504-revert-trend-agotar] [sprint:5.5.4] [reversal] [sub-bug]
related:
  - docs/sprints/sprint-5.5.2-revert-agotar-filter.md (sprint padre — revert AM)
  - docs/discovery/cell-efectiva-tendencia-null-2026-05-04.md (discovery del subbug)
  - .claude/rules/inventory-policy.md (Regla 2 — sub-bugs no son para después)
  - supabase/migrations/20260504200000_sprint554_revert_agotar_trend.sql
---

# Sprint 5.5.4 — Completar revert `agotar` en `v_trend_detection`

## Decisión owner (2026-05-04 PM)

**Aplicar Regla 2 inventory-policy: el revert sprint 5.5.2 (mismo día AM) tenía
un sub-bug en una superficie distinta. Se atiende en el mismo día, sprint
separado, no como ticket diferido.**

## Contexto — el sub-bug

Sprint 5.5.2 AM corrigió `refresh_sku_node_policy_from_templates()` cambiando
el filtro:

```sql
-- antes (excluía agotar)
WHERE estado_sku = 'activo' OR estado_sku IS NULL

-- después (sprint 5.5.2)
WHERE estado_sku IS DISTINCT FROM 'descontinuado'
```

Pero **olvidó la copia espejo del mismo filtro en la vista `v_trend_detection`**:

```sql
WHERE p.estado_sku = 'activo' OR p.estado_sku IS NULL
```

Resultado:

- 22 SKUs `agotar` reincorporados a `sku_node_policy` esta mañana **sin
  tendencia/cell_efectiva** (NULL en bodega_central y full_ml).
- Sin fix mañana 12:00 UTC, el cron `sync-trend-detection` los marca como
  `'insuficiente_data'` (mentira: tienen `vel_ponderada > 0`).
- Pierden promoción BZ→AZ doctrina Sprint 4.3b.
- Aceleradores entre `agotar` (LITAF400G4PMT con drift -53.1%, JSAFAB433P20W
  con drift -48.6%, etc.) quedan invisibles a trend detection.

Detectado por discovery comparativo motor viejo vs motor nuevo
(`docs/discovery/cell-efectiva-tendencia-null-2026-05-04.md`).

## Cambios aplicados

### 1. Migration `20260504200000_sprint554_revert_agotar_trend.sql`

- `DROP VIEW v_reposicion_explain CASCADE` (depende de v_trend_detection).
- `DROP VIEW v_trend_detection CASCADE`.
- `CREATE VIEW v_trend_detection AS [...]` con última línea cambiada:
  - Antes: `WHERE p.estado_sku = 'activo' OR p.estado_sku IS NULL`
  - Después: `WHERE p.estado_sku IS DISTINCT FROM 'descontinuado'`
- `CREATE VIEW v_reposicion_explain AS [...]` definición exacta del Sprint 5.5
  v3 (sin cambios funcionales — recreada solo por la cascada).
- `COMMENT ON VIEW v_trend_detection` actualizado con razón del Sprint 5.5.4.
- `COMMENT ON VIEW v_reposicion_explain` con nota del rebuild por CASCADE.

### 2. Backfill inmediato

Ejecución de `refresh_trend_in_sku_node_policy()` post-migration:

```
rows_affected: 846
summary: {
  estable: 262,
  acelerando: 42, acelerando_fuerte: 60,
  desacelerando: 32, desacelerando_fuerte: 40,
  recuperacion_post_quiebre: 90,
  insuficiente_data_matched: 126,
  orphans_no_sales_90d: 194,
  promovidos: 56
}
```

## Validación post-deploy

### Test 1 — vista incluye agotar

```sql
SELECT COUNT(*) FILTER (WHERE p.estado_sku = 'agotar') AS agotar_en_vista
FROM v_trend_detection vtd JOIN productos p ON p.sku = vtd.sku_origen;
```

**PASS**: 22 ✓

### Test 2 — descontinuados siguen excluidos

```sql
SELECT COUNT(*) FROM v_trend_detection vtd
JOIN productos p ON p.sku = vtd.sku_origen
WHERE p.estado_sku = 'descontinuado';
```

**PASS**: 0 ✓

### Test 3 — distribución de tendencia en los 22 agotar

| tendencia | SKUs | promovidos |
|---|---|---|
| acelerando | 2 | 1 |
| acelerando_fuerte | 6 | 2 |
| desacelerando | 1 | 0 |
| desacelerando_fuerte | 1 | 0 |
| estable | 8 | 0 |
| recuperacion_post_quiebre | 4 | 0 |
| **TOTAL** | **22** | **3** |

0 con `tendencia=NULL` ✓
0 con `tendencia='insuficiente_data'` ✓ (sí tienen ventas)
3 promovidos a celda más exigente vía cell_efectiva ✓

### Test 4 — caso testigo JSAFAB422P20S

```
sku=JSAFAB422P20S, node=bodega_central
tendencia='recuperacion_post_quiebre'
cell='AY', cell_efectiva='AY', promocion_activa=false
tendencia_updated_at=2026-05-04 23:53:51 UTC
```

**PASS**. La etiqueta `recuperacion_post_quiebre` es exactamente la doctrina
Sprint 4.3b.1: el SKU venía de quiebre (motivo de OC-006) y está en período
de no-promoción hasta sostener 4 sem con stock.

## Sub-bug adicional detectado en `v_safety_stock` — NO MODIFICADO

Durante el grep de candidatos equivalentes, encontré que `v_safety_stock`
tiene la **misma firma del filtro viejo** en su CTE `supplier_lt`:

```sql
-- v_safety_stock líneas internas:
supplier_lt AS (
  SELECT p.sku, p.proveedor_id,
         COALESCE(pr.lead_time_dias, p.lead_time_dias::numeric, 14::numeric) AS lt_dias_avg,
         COALESCE(pr.lead_time_sigma_dias, 2::numeric) AS sigma_lt
  FROM productos p
  LEFT JOIN proveedores pr ON pr.id = p.proveedor_id
  WHERE p.estado_sku = 'activo'::text OR p.estado_sku IS NULL  -- ← BUG ESPEJO
)
```

**Impacto medido HOY**: los 22 SKUs `agotar` no aparecen en la CTE
`supplier_lt`, por lo que el LEFT JOIN externo cae a defaults:

- `lt_dias_avg = 14` (en lugar de los 5 días reales del proveedor Idetex).
- `sigma_lt = 2` (default, en lugar del valor del proveedor).

Esto **infla `safety_stock` y `reorder_point`** para los 22 SKUs. Los SKUs
agotar reciben recompra como si su proveedor demorara 14 días cuando demora 5.

Verificación (2026-05-04 PM, post-sprint 5.5.4):

| SKU | estado | vss.lt_dias | LT real esperado |
|---|---|---|---|
| JSAFAB422P20S, JSAFAB433P20W, ... (22 SKUs) | agotar | 14 | 5 |

NO se aplicó fix porque la instrucción del sprint 5.5.4 fue explícita:
*"Reportar cualquier otro candidato. NO modificar (cada caso requiere análisis
dominio-específico)."*

Recomendación: Sprint 5.5.5 dedicado a `v_safety_stock`. Es el mismo patrón de
fix (DROP CASCADE → recreate con filtro corregido), pero la cascada incluye
`v_compras_pendientes` y `v_reposicion_explain`, ambas críticas. Antes de
ejecutar es prudente:

1. Confirmar con el owner que el filtro `supplier_lt` se cambia a
   `IS DISTINCT FROM 'descontinuado'`.
2. Considerar si `descontinuado` también necesita LT default (probablemente
   irrelevante porque `policy_status='blocked'` o el motor los skipea).
3. Backfill: tras el fix, los 22 SKUs agotar tendrán safety_stock y
   reorder_point recalculados (probablemente más bajos).

## Lección operativa (Lesson Learned)

**Cualquier `WHERE` con `estado_sku = 'activo' OR IS NULL` en código SQL es
candidato a misma corrección que sprint 5.5.2.** El filtro estaba copiado en 4
superficies distintas:

1. `refresh_sku_node_policy_from_templates()` — corregida sprint 5.5.2 ✓
2. `v_trend_detection` — corregida sprint 5.5.4 ✓
3. `v_safety_stock` — **PENDIENTE** (Sprint 5.5.5 propuesto)
4. Migrations históricas (sprint 2, 2.5, 4, 4.3a, 4.3b, 4.3b.1) — inmutables;
   el estado actual lo definen las correcciones más recientes.

Recomendación de proceso: cuando se haga revert de un filtro de tabla con
copia espejo en vista, hacer grep de `pg_get_viewdef` por el mismo patrón
ANTES de cerrar el sprint padre.

## Lo que NO cambia

- `refresh_trend_in_sku_node_policy()` (el cron RPC) — sigue intacta. El
  bloque "orphans" (línea 137-148 de la migration 20260504160000) sigue
  marcando como `insuficiente_data` los SKUs que no aparecen en la vista,
  comportamiento correcto.
- `/api/policy/sync-trend-detection` route — sin cambios. Próxima corrida
  Vercel: mañana 12:00 UTC.
- `refresh_sku_node_policy_from_templates()` — sin cambios.
- `/api/ml/stock-sync` y `/api/ml/activate-with-stock` — sin cambios. La
  doctrina `agotar = buffer Flex 0` se mantiene intacta.

## Reversibilidad

Si la doctrina vuelve a "agotar bloquea trend":

1. Re-aplicar el filtro `estado_sku = 'activo' OR IS NULL` en
   `v_trend_detection`. CASCADE recreate de `v_reposicion_explain`.
2. Las filas agotar en `sku_node_policy` mantendrán su tendencia última
   conocida hasta que el cron las marque `insuficiente_data` por orphan.

Sin tag `[non-reversible]` — revert puro de un cambio reciente.

## Archivos tocados

- `supabase/migrations/20260504200000_sprint554_revert_agotar_trend.sql` (nueva).
- `docs/sprints/sprint-5.5.4-revert-trend-agotar.md` (este doc).
- `docs/sprints/sprint-5.5.2-revert-agotar-filter.md` (adendum al pie).

## Definition of done

- [x] Migration aplicada (vía MCP supabase)
- [x] `v_trend_detection` y `v_reposicion_explain` recreadas sin errores
- [x] Tests SQL 1-4 PASS
- [x] Cron `refresh_trend_in_sku_node_policy()` ejecutado manualmente
- [x] Sprint doc + adendum 5.5.2
- [x] Grep de otros filtros equivalentes reportado (1 hallazgo: `v_safety_stock`)
- [ ] Atlas CI pendiente del commit

---

*Sprint ejecutado por Claude Opus 4.7 (1M context) el 2026-05-04 PM bajo
`feedback_banvabodega_autonomy`. Aplica Regla 2 inventory-policy: el sub-bug
del revert sprint 5.5.2 (mismo día AM) se atiende inmediatamente, no diferido.
Adicionalmente reporta sub-bug pendiente en `v_safety_stock` para Sprint 5.5.5.*
