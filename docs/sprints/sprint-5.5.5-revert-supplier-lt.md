---
sprint: 5.5.5
title: Completar revert agotar en v_safety_stock.supplier_lt
date: 2026-05-04 PM (post 5.5.4)
owner: Vicente Elías
tags: [batch:20260504-revert-supplier-lt] [sprint:5.5.5] [reversal] [sub-bug] [final-sweep]
related:
  - docs/sprints/sprint-5.5.2-revert-agotar-filter.md (sprint padre AM)
  - docs/sprints/sprint-5.5.4-revert-trend-agotar.md (sprint hermano PM)
  - .claude/rules/inventory-policy.md (Regla 2 — sub-bugs no son para después)
  - supabase/migrations/20260504210000_sprint555_revert_agotar_supplier_lt.sql
---

# Sprint 5.5.5 — Cierre del revert `agotar` (4ta superficie del filtro espejo)

## TL;DR

Episodio cerrado. **4 superficies** del mismo filtro `WHERE estado_sku = 'activo' OR IS NULL` corregidas en el día:

| Sprint | Superficie | Hora | Impacto |
|---|---|---|---|
| 5.5.2 | `refresh_sku_node_policy_from_templates()` | AM | 22 SKUs entran a `sku_node_policy` |
| 5.5.4 | `v_trend_detection` | PM | 22 SKUs reciben tendencia/cell_efectiva |
| **5.5.5** | `v_safety_stock` (CTE supplier_lt) | **PM** | **22 SKUs reciben LT real del proveedor** |
| ✓ | Auditoría grep final | PM | 0 ocurrencias remanentes en prod |

Además del fix puntual, el sprint deja la **lección operativa cerrada**: cualquier
`WHERE estado_sku = 'activo' OR IS NULL` en SQL queda como antipatrón documentado
en `inventory-policy.md`.

## Contexto — el sub-bug

`v_safety_stock` tiene un CTE `supplier_lt` que hace LEFT JOIN externo:

```sql
supplier_lt AS (
  SELECT p.sku, p.proveedor_id,
         COALESCE(pr.lead_time_dias, p.lead_time_dias::numeric, 14::numeric) AS lt_dias_avg,
         COALESCE(pr.lead_time_sigma_dias, 2::numeric) AS sigma_lt
  FROM productos p
  LEFT JOIN proveedores pr ON pr.id = p.proveedor_id
  WHERE p.estado_sku = 'activo'::text OR p.estado_sku IS NULL  -- ← BUG
)
...
LEFT JOIN supplier_lt slt ON slt.sku = pe.sku_origen
COALESCE(slt.lt_dias_avg, 14::numeric) AS lt_dias  -- ← default 14d
COALESCE(slt.sigma_lt, 2::numeric) AS sigma_lt
```

Para los 22 SKUs `agotar`, la CTE no devolvía fila → LEFT JOIN producía NULLs
→ el motor usaba LT default 14 días en lugar de los 5 días del proveedor real
(Idetex). Como `safety_stock`, `cycle_stock` y `reorder_point` dependen de
`sqrt(LT) * sigma`, un LT inflado infla todos los estimados.

## Cambios aplicados

### Migration `20260504210000_sprint555_revert_agotar_supplier_lt.sql`

- `DROP VIEW v_reposicion_explain CASCADE`
- `DROP VIEW v_compras_pendientes CASCADE`
- `DROP VIEW v_safety_stock CASCADE`
- `CREATE VIEW v_safety_stock AS [...]` con CTE supplier_lt corregida:
  - Antes: `WHERE p.estado_sku = 'activo' OR p.estado_sku IS NULL`
  - Después: `WHERE p.estado_sku IS DISTINCT FROM 'descontinuado'`
- `CREATE VIEW v_compras_pendientes AS [...]` definición exacta Sprint 5.5 v3.
- `CREATE VIEW v_reposicion_explain AS [...]` definición exacta Sprint 5.5.4.
- `COMMENT ON VIEW v_safety_stock` con razón + cierre del barrido (4 superficies).

## Validación post-deploy

### Test 1 — los 22 SKUs `agotar` ahora usan LT real del proveedor

| status | SKUs | %  |
|---|---|---|
| OK (lt_motor = lt_proveedor) | **22/22** | 100% ✓ |
| BUG (sigue usando default 14) | 0 | — |

Todos los 22 son Idetex (`lead_time_dias=5`).

### Test 2 — caso testigo JSAFAB422P20S

| Métrica | Pre-fix | Post-fix | Esperado |
|---|---|---|---|
| `lt_dias` | 14 | **5** | 5 ✓ |
| `cycle_stock` | 6 | **2** | ≤3 ✓ |
| `safety_stock` | 4 | **3** | ≤3 ✓ |
| `reorder_point` | 10 | **4** | ≤6 ✓ |

### Test 3 — descontinuados siguen excluidos

`v_safety_stock` con `estado_sku='descontinuado'`: **0 filas** ✓.

### Test 4 — qty_a_comprar agregado de los 22 agotar

| Métrica | Pre-fix | Post-fix | Δ |
|---|---|---|---|
| LT promedio | 14.00 | **5.00** | -64% |
| safety_stock promedio | 4.64 | **4.50** | -3% |
| Σ qty_a_comprar | 179 uds | **156 uds** | **-13% (-23 uds)** |

Reducción real de 23 unidades en la cola de OC para los SKUs agotar de Idetex
— recursos antes destinados a buffer-fantasma de un LT inflado.

## Auditoría final del barrido

### En Postgres prod (estado actual)

```sql
SELECT objeto FROM pg_class WHERE pg_get_viewdef ILIKE '%activo%OR%IS NULL%'
SELECT objeto FROM pg_proc WHERE pg_get_functiondef ILIKE '%activo%OR%IS NULL%'
```

**0 ocurrencias** en vistas y funciones activas. Episodio cerrado al nivel de DB.

### En código TypeScript (legítimas, no requieren revert)

| Archivo:línea | Contexto | Acción |
|---|---|---|
| `src/app/api/proveedor-catalogo/faltantes/route.ts:77` | `(p.estado_sku as string) !== "descontinuado"` — ya filtro correcto | Ninguna |
| `src/lib/intelligence-queries.ts:167` | `(p.estado_sku as string) \|\| "activo"` — default cuando NULL | Ninguna (correcto: trata NULL como activo) |
| `src/lib/__tests__/intelligence-nuevo.test.ts:109` | Fixture de test con `estado_sku: "activo"` | Ninguna |
| `src/lib/__tests__/intelligence-flex.test.ts:34` | Fixture de test | Ninguna |

### En migrations históricas (inmutables)

| Migration | Línea | Contexto | Estado |
|---|---|---|---|
| `20260503090000_sprint2_populate_sku_node_policy.sql:255` | `refresh_sku_node_policy_from_templates` v1 | Superada por sprint 5.5.2 |
| `20260503130000_sprint25_h2_name_fallback.sql:196` | RPC iteración 2 | Superada por sprint 5.5.2 |
| `20260503180100_sprint4_reposicion_views.sql:53` | Vista | Superada por 5.5.4/5.5.5 |
| `20260504100000_sprint43a_target_dias_flex.sql:214` | RPC iteración 3 | Superada por 5.5.2 |
| `20260504100100_sprint43a_views_with_old_logic.sql:100` | Vista | Superada por 5.5.4/5.5.5 |
| `20260504130000_sprint43b_trend_detection.sql:108,313` | v_trend_detection original | Superada por 5.5.4 |
| `20260504160000_sprint43b1_fix_trend_quiebre.sql:293` | v_trend_detection iter | Superada por 5.5.4 |

Las migraciones son inmutables. El estado actual lo definen las correcciones más recientes (5.5.2, 5.5.4, 5.5.5).

## Lección operativa documentada

**Antipatrón**: cualquier `WHERE estado_sku = 'activo' OR IS NULL` en SQL es
candidato a misma corrección que los sprints 5.5.x. Por instinto el filtro se
ve "razonable" (excluye SKUs no operativos), pero **excluye `agotar`** que es
operativo aunque marcado para vender al máximo.

**Regla canónica** post-revert: el filtro correcto es
`WHERE estado_sku IS DISTINCT FROM 'descontinuado'`. Solo `descontinuado`
queda fuera de catálogo (sin policy, sin pricing, sin publicación).

**Recomendación de proceso**: cuando se modifique un filtro `estado_sku` en
una superficie, hacer grep canónico ANTES de cerrar el sprint:

```bash
grep -rn "estado_sku.*=.*'activo'" supabase/migrations/ src/
# Y consulta a Postgres:
SELECT relname FROM pg_class
 WHERE relkind = 'v'
   AND pg_get_viewdef(oid) ILIKE '%estado_sku = ''activo''%OR%IS NULL%';
```

**Lint candidato (futuro)**: regla en CI que bloquee migrations nuevas con esa
firma. Hoy no existe; queda como item de deuda técnica.

## Lo que NO cambia

- `/api/ml/stock-sync` — buffer Flex=0 para `agotar` sigue activo.
- Lógica de cálculo SS / cycle / ROP — misma fórmula, solo cambia el input LT.
- `refresh_sku_node_policy_from_templates()` — sprint 5.5.2 sigue correcto.
- `v_trend_detection` — sprint 5.5.4 sigue correcto.
- `refresh_trend_in_sku_node_policy()` (cron RPC) — intacta.

## Reversibilidad

Si la doctrina vuelve a "agotar = no recompra", re-aplicar el filtro
`estado_sku = 'activo' OR IS NULL` en las 4 superficies. El revert es de un
día, todo recreado limpio.

## Definition of done

- [x] Migration aplicada (vía MCP supabase apply_migration)
- [x] `v_safety_stock`, `v_compras_pendientes`, `v_reposicion_explain` recreadas en CASCADE
- [x] Tests SQL 1-4 PASS
- [x] Reporte grep con TODAS las superficies clasificadas (revert / legítimo / inmutable)
- [x] Auditoría Postgres prod: 0 ocurrencias remanentes
- [x] Sprint doc (este archivo) + adendum 5.5.2
- [ ] Atlas CI pendiente del commit

## Archivos tocados

- `supabase/migrations/20260504210000_sprint555_revert_agotar_supplier_lt.sql` (nueva)
- `docs/sprints/sprint-5.5.5-revert-supplier-lt.md` (este doc)
- `docs/sprints/sprint-5.5.2-revert-agotar-filter.md` (adendum final agregado)

---

*Sprint ejecutado por Claude Opus 4.7 (1M context) el 2026-05-04 PM bajo
`feedback_banvabodega_autonomy`. Cierre del barrido del filtro espejo
estado_sku activo OR IS NULL — episodio reversal-agotar completado en 4
sub-sprints del mismo día (5.5.2 AM + 5.5.4 PM + 5.5.5 PM).*
