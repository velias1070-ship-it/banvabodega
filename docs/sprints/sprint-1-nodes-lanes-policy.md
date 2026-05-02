# Sprint 1 — Multi-bodega foundation

**Fecha:** 2026-05-02
**Owner:** Vicente Elías
**Branch:** `sprint-1-nodes-lanes-policy`
**Migration:** `supabase/migrations/20260502120000_sprint1_nodes_lanes_policy.sql`
**Decisiones cerradas:** H5 Camino C, plural inglés (3A), CDMP (1A), YYYYMMDDHHMMSS (4B).

---

## Qué se construyó

Foundation multi-bodega para el motor de reposición v2 (Sprint 2). **Sin cambiar Reposición v1 todavía** — sólo se agregan tablas y vistas; los cálculos siguen leyendo `sku_intelligence` hasta que Sprint 2 reescriba `intelligence.ts` para apuntar a `sku_node_policy`.

### Tablas nuevas

| Tabla | PK | Rol |
|---|---|---|
| `nodes` | `id text` | Catálogo de nodos logísticos (warehouse / fulfillment / supplier_ref). 3 seeds: `bodega_central`, `full_ml`, `supplier_generic`. |
| `lanes` | `id text` | Arcos del grafo logístico. 2 seeds: `supplier_to_bodega` (LT 21d), `bodega_to_full` (LT 5d). |
| `sku_node_policy` | `(sku_origen, node_id)` | Overrides por SKU×Nodo sobre `policy_templates`. Sprint 1 deja la tabla vacía. |
| `_deprecated_column_reads` | `id bigserial` | Audit append-only para futuras instrumentaciones de columnas legacy. |

### Vistas nuevas

| Vista | Devuelve | Reglas |
|---|---|---|
| `v_stock_por_nodo` | `(sku_origen, node_id, qty_on_hand, qty_reserved, as_of)` | Lee SOLO de fuentes canónicas: `stock` + `stock_full_cache`. NO toca `ml_items_map.stock_full_cache` (deprecada v58). Composición trivial expandida a `sku_origen`. |
| `v_in_transit_por_nodo` | `(sku_origen, to_node_id, from_node_id, lane_id, qty_in_transit, earliest_eta, earliest_fecha_emision)` | Suma OCs abiertas (estados `PENDIENTE/EN_TRANSITO/RECIBIDA_PARCIAL` per `intelligence-queries.ts:384`). Sólo líneas con saldo (`cantidad_pedida > cantidad_recibida`). |

### Enums nuevos

- `node_type_enum`: `warehouse | fulfillment | supplier_ref`
- `lane_type_enum`: `inbound | transfer | outbound`

### Documento de policy nuevo

- `/docs/policies/frontera-reposicion-pricing.md` — frontera lógica Reposición/Pricing (H5 Camino C). Vinculante.

---

## Validación post-deploy

`tests/sprint1_validation.sql` — 12 tests, **12/12 PASS** en la corrida 2026-05-02.

| # | Test | Cobertura |
|---|---|---|
| T01 | enums creados | `node_type_enum`, `lane_type_enum` existen |
| T02 | nodes seedeados | 3 filas con tipos correctos |
| T03 | lanes seedeados | 2 filas con FKs válidas y `lead_time > 0` |
| T04 | constraint `from <> to` | Insert con loop rechazado |
| T05 | FK `sku_node_policy → productos` | Insert con SKU inexistente rechazado |
| T06 | view dual-node | `v_stock_por_nodo` retorna ambos nodos |
| T07 | sólo fuentes canónicas | `full_ml` ≥ `stock_full_cache.cantidad` (el ≥ permite expansión por `unidades` de composición) |
| T08 | filtros in-transit | Sin filas con `qty_in_transit ≤ 0` |
| T09 | insert+delete policy | Smoke test escritura |
| T10 | composite PK | Duplicado rechazado |
| T11 | COMMENT presente | Todas las nuevas tablas/vistas/types comentadas |
| T12 | snake_case | Sin violaciones a CONVENTIONS.md §1 |

### Métricas observadas

- `v_stock_por_nodo`: 981 filas (bodega_central + full_ml).
- `v_in_transit_por_nodo`: 94 filas (líneas OC abiertas con saldo).
- `full_ml.qty_on_hand` total = 4173 (vs 4010 en `stock_full_cache.cantidad` directo). El delta de 163 viene de `composicion_venta.unidades > 1` (combos textiles), comportamiento esperado.

---

## Lo que NO cambió en este sprint

- **`intelligence.ts`** sigue calculando como antes. Ningún consumer lee `v_stock_por_nodo` ni `v_in_transit_por_nodo` aún.
- **Panel admin**: sin cambios visibles.
- **`policy_templates`**: sin cambios (Sprint 0 ya seedeó las 9 celdas ABC×XYZ).
- **`sku_intelligence`**: sin cambios.
- **Pricing/markdown**: queda en `sku_intelligence` hasta Sprint 6 (per `frontera-reposicion-pricing.md`).

---

## Decisiones tomadas durante la implementación

1. **Estados OC para `v_in_transit_por_nodo`** — el spec original mencionaba `('emitida','parcial','en_camino')` (lowercase, novedosos). El motor real usa `('PENDIENTE','EN_TRANSITO','RECIBIDA_PARCIAL')` (uppercase, ya canónicos en `intelligence-queries.ts:384`). Adoptamos los canónicos para que la nueva vista coincida con el motor existente. La DB hoy sólo tiene `ANULADA` (4) y `RECIBIDA_PARCIAL` (2), lo que valida que `RECIBIDA_PARCIAL` cuelga del filtro como esperamos.
2. **`fecha_esperada` como ETA** — el spec mencionaba `fecha_estimada`, columna que no existe. La columna real nullable es `fecha_esperada`. Sprint 2 podrá derivar ETA de `fecha_emision + lane.lead_time_days` cuando `earliest_eta IS NULL`.
3. **`stock_full_directo` en `v_stock_por_nodo`** — adicionamos un branch para SKUs Full que NO tienen composición (no debería suceder post-`autoheal_composicion` PR6c, pero defensivo). Si llega un orphan, lo contamos como `sku_origen=sku_venta`.
4. **`_deprecated_column_reads`** — tabla audit para Sprint 2+; queda preparada y excluida del Atlas drift via `atlas.hcl` `_deprecated_*` (ya excluido).

---

## Próximos pasos

- **Sprint 2** (multi-bodega motor): reescribir `intelligence.ts:resolverPedirProveedor` y `resolverMandarFull` para leer `v_stock_por_nodo` + `v_in_transit_por_nodo` + resolver políticas vía `sku_node_policy → policy_templates` (lookup de la frontera, ver `/docs/policies/frontera-reposicion-pricing.md` §3). Panel admin gana columna "Política aplicada" y permite crear overrides desde UI.
- **Sprint 3** (forecast ROP): introducir `forecast_accuracy` y reorder point dinámico per cell.
- **Sprint 6** (Pricing migration): mover campos pricing de `sku_intelligence` a `markdown_state`.

---

## Referencias

- `/CONVENTIONS.md` §1, §2, §3, §4.
- `/atlas.hcl` y `/docs/atlas-runbook.md`.
- `/docs/policies/frontera-reposicion-pricing.md` (H5 Camino C).
- `/concept-registry.yml` — concepts `nodo_logistico`, `lane_logistica`, `politica_sku_nodo`.
- `/ssot-registry.yml` — `politica_reposicion_por_sku_nodo` y `stock_unificado_por_nodo`.
- `/domain-registry.yml` — Logística (nuevo bounded context).
- `/.claude/rules/inventory-policy.md` Regla 5 — fuentes canónicas, lecturas derivadas.
