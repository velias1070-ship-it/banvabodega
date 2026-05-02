# Sprint 4.1 — Fix bug `pre_full_target` en `v_compras_pendientes`

**Owner:** Vicente Elías
**Fecha:** 2026-05-03
**Branch:** `sprint-4.1-fix-pre-full`
**Tag:** `[batch:20260503-5]`
**Migración:** `supabase/migrations/20260503210000_sprint41_fix_pre_full.sql`
**Tests:** `tests/sprint41_validation.sql` (5/5 PASS)

## Bug

`v_safety_stock` (Sprint 4) genera 2 filas por SKU activo: una por
`bodega_central` y una por `full_ml`. La columna `pre_full_target` solo
es `>0` en la fila `full_ml` (porque la lógica es `node_id = 'full_ml'
THEN ...`). `v_compras_pendientes` filtraba `WHERE ss.node_id = 'bodega_central'`
y se quedaba con `pre_full_target = 0`. Resultado: `stock_objetivo` no
incluía lo que hay que pre-posicionar a Full → `qty_a_comprar` al
proveedor sub-pedía sistemáticamente.

### Caso testigo: LITAF400G4PCL (Set 4 Toallas A. Family Celeste)

| Campo | Pre-fix | Post-fix |
|---|---|---|
| `cell` | AX | AX |
| `d_avg_dia` | 0.697 | 0.697 |
| `cycle_stock` (bodega) | 3 | 3 |
| `safety_stock` (bodega) | 1 | 1 |
| `pre_full_target` (bodega) | **0** | **29** |
| `stock_objetivo` | 4 | **33** |
| `qty_a_comprar` | **4** | **33** |

29 unidades = `round(0.697 × 42)` (target_dias_full=42 para AX en
`policy_templates`).

## Cambio

Reescritura de `v_compras_pendientes` con `CREATE OR REPLACE VIEW`
agregando CTE:

```sql
pre_full_por_sku AS (
  SELECT sku_origen, pre_full_target
  FROM v_safety_stock
  WHERE node_id = 'full_ml'
)
```

`stock_objetivo`, `qty_a_comprar` y `bajo_rop` ahora usan
`COALESCE(pf.pre_full_target, 0)` proveniente del CTE en vez del campo
de la fila bodega.

`v_safety_stock` no cambia. `v_alertas_quiebre` y `v_reposicion_dashboard`
heredan el fix automáticamente porque consumen `v_compras_pendientes`.

## Antes → Después

| Métrica | Pre-fix (Sprint 4) | Post-fix (Sprint 4.1) |
|---|---|---|
| SKUs en `v_compras_pendientes` | 14 | **43** (+29) |
| Total CLP sugerido | $786.900 | **$6.762.389** (×8.6) |
| LITAF400G4PCL `qty_a_comprar` | 4 | **33** |
| Banner `QUIEBRE_TOTAL` | 10 | 13 |
| Banner `CRITICO` | 1 | 1 |
| Banner `URGENTE` | 0 | 1 |
| Banner `ATENCION` | 3 | 4 |

La spec estimaba +50–100% (×1.5–2). Real fue ×8.6 — el bug afectaba
mucho más SKUs de lo previsto. Razón: para SKUs A/B en Full, el
`pre_full_target` (cycle de 42 días en Full) suele ser dominante frente
al `cycle_stock + safety_stock` de bodega (cycle de LT días).

## Tests (5/5 PASS)

| # | Check | Resultado |
|---|---|---|
| T01 | LITAF qty_a_comprar >= 30 | PASS (qty=33, pre_full=29) |
| T02 | AX/AY rápidos con pre_full_target > 0 | PASS (17 SKUs) |
| T03 | stock_objetivo > cycle+SS cuando pre_full > 0 | PASS (43 SKUs) |
| T04 | CLP total >> baseline pre-fix | PASS ($6.762.389 vs $786.900) |
| T05 | Cero CZ en compras_pendientes | PASS |

## Alcance

- **Solo afecta UI** (`/admin/reposicion-suggestions`). Agentes AI siguen
  apagados (Sprint 4 Camino 1).
- Sin cambios en `v_safety_stock`, `sku_node_policy`, `pricing.ts`.
- No agrega ni quita métricas en `metrics.yaml`.

## Rollback

```sql
-- Restaurar v_compras_pendientes Sprint 4 (sin CTE pre_full_por_sku):
-- ver supabase/migrations/20260503180100_sprint4_reposicion_views.sql
```

## Referencias

- Sprint 4: `/docs/sprints/sprint-4-camino-1-manual.md`
- Migration Sprint 4 (vistas originales): `supabase/migrations/20260503180100_sprint4_reposicion_views.sql`
- Runbook humano: `/docs/operations/reposicion-manual.md`
