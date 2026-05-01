# Sprint 0 — Master cleanup + foundation IA

**Estado:** Aplicado en prod 2026-05-01.
**Owner:** Vicente Elías.
**Migration:** `supabase/migrations/20260501230000_sprint0_master_cleanup.sql`.

## Objetivo

1. Limpiar deuda técnica de master data (tabla zombi, columna zombi, SKUs case-inconsistent).
2. Establecer la fundación de Information Architecture (CDMP, SSoT, conventions).
3. Sembrar `policy_templates` con los valores cerrados por H3+H11+H2.

## Hallazgos cerrados

| Hallazgo | Resumen | Cierre |
|---|---|---|
| H3 | service_level por celda ABC×XYZ | Lean en Z (0.90, z=1.28); conservador en A (0.98, z=2.05). 9 valores distintos por celda. |
| H2 | Bandas XYZ | Deseasonalizadas 0.25 / 0.60 (textil hogar) — adoptado vs CV crudo 0.5/1.0. |
| H11 | target_dias_full por celda | A=42d, B=28d, CX=15d, CY=7d, CZ=0d. |

(Decisiones previas ya cerradas por Vicente: H1 Pareto 70/90, H27 anulada=false, modelo 3 nodos.)

## Cambios físicos aplicados

### Eliminaciones
- `DROP TABLE _deprecated_ml_velocidad_semanal_2026_05_09` (1633 filas backup en `backups/sprint0/20260501_233931/`).
- `ALTER TABLE productos DROP COLUMN precio` (511 filas backup, todas con precio NULL o 0).

### Normalizaciones SKU (UPPER+TRIM)
| Tabla.columna | Filas non-UPPER detectadas | Aplicado | Bloqueado por colisión |
|---|---|---|---|
| productos.sku | 7 | 5 (UPPER) | 2 (BAR-VIR-DUB-Bitter, BAR-VIR-DUB-Leche) → `_sprint0_dup_skus` |
| stock_full_cache.sku_venta | 7 | 0 (DELETE — todas con cantidad=0; cache rebuilds en next ML sync) | 7 colisionaban con la versión UPPER |
| composicion_venta.sku_venta | 7 | 7 (UPPER) | 0 |
| composicion_venta.sku_origen | 7 | 7 (UPPER) | 0 |
| ml_items_map.sku | 7 | 7 (UPPER) | 0 |
| ml_items_map.sku_venta | 7 | 7 (UPPER) | 0 |
| ml_items_map.sku_origen | 7 | 7 (UPPER) | 0 |
| stock.* | 0 | — | — |
| sku_intelligence.sku_origen | 0 | — | — |

### Auditoría de colisiones
Tabla `_sprint0_dup_skus` con 2 filas pendientes de merge humano:
- `BAR-VIR-DUB-Bitter` ↔ `BAR-VIR-DUB-BITTER`
- `BAR-VIR-DUB-Leche` ↔ `BAR-VIR-DUB-LECHE`

Ambos pares tienen 0 filas en `stock` (CASCADE-safe) y 0 ventas pendientes inmediatas. Próximo paso: Vicente decide cuál es el SKU canónico, se hace UPDATE de los join tables, y se borra la duplicada.

### Tipo + tabla nuevos
- `CREATE TYPE policy_action_enum` (6 valores: reorder_normal, reorder_lt_corto, reorder_periodic, reorder_bulk, reorder_minimo, no_reorder).
- `CREATE TABLE policy_templates` con 9 filas SEED (una por celda ABC×XYZ).

## Validación

11 tests en `tests/sprint0_validation.sql`. Resultados al aplicar:

| Test | Esperado | Obtenido |
|---|---|---|
| T1 zombie table dropped | 0 | 0 ✓ |
| T2 precio col dropped | 0 | 0 ✓ |
| T3 productos pending merge | 2 | 2 ✓ |
| T4 stock_full_cache clean | 0 | 0 ✓ |
| T5 composicion_venta clean | 0 | 0 ✓ |
| T6 ml_items_map clean | 0 | 0 ✓ |
| T7 policy_templates seeded | 9 | 9 ✓ |
| T8 enum values | 6 | 6 ✓ |
| T9 dup audit rows | 2 | 2 ✓ |
| T10 AX worked example | 0.98 / 2.05 / 42 / reorder_normal | ✓ |
| T11 CZ no_reorder | NULL / NULL / 0 / no_reorder | ✓ |

## Foundation IA creada en este sprint

- `/CONVENTIONS.md` — naming, migrations YYYYMMDDHHMMSS, SSoT, CDMP, anti-drift.
- `/ssot-registry.yml` — 5 SSoTs iniciales (stock_canonico, stock_full_ml, composicion_venta, velocidades_y_estado_sku, politica_reposicion_por_celda).
- `/concept-registry.yml` — 11 conceptos (producto, sku_venta, composicion, nodo, movimiento, velocidad, ABC×XYZ, política, déficit, quiebre, lane).
- `/domain-registry.yml` — 6 dominios (inventario, ventas, pricing, logistica, compras, reporteria).

## Backups

Directorio: `backups/sprint0/20260501_233931/`
- `_deprecated_ml_velocidad_semanal_2026_05_09.json` — 1633 rows, 374 KB.
- `productos_id_sku_precio.json` — 511 rows, 43 KB.
- `skus_pre_upper.json` — snapshot de los 7 SKUs case-inconsistent en 4 tablas + colisiones detectadas.

Script reproducible: `scripts/backup-pre-sprint-0.sh` (idempotente; nuevo timestamp por run).

## Pendiente para Sprint 1

- Decidir merge para los 2 SKUs colisionados en `_sprint0_dup_skus`.
- Crear tabla `lanes` y `proveedores` (concepto logística aún no físico).
- Introducir `policy_overrides` para excepciones por SKU.
- Comenzar consumo de `policy_templates` en `intelligence.ts` (cálculo SS King Method).

## Decisiones aún abiertas

- **H5 — Markdown frontier (Reposición vs Pricing)**: Camino A/B/C pendiente de Vicente. No bloquea Sprint 0; se retoma post-cierre de este sprint.

## Referencias

- `docs/auditorias/inteligencia_vs_manuales_2026-04-28.md` — origen H1-H43 + Adendum.
- `docs/policies/inventario.md` (P-INV-1, P-INV-2, P-INV-3).
- `docs/policies/inventario-formulas.md` (líneas 60-86 tablas canónicas; 208-211 censoring).
- `docs/manuales/inventarios/BANVA_SPM_Benchmark_Plan.md` (255-265 matriz Umbrex; 631-720 multi-echelon worked example).
- `docs/schema-audit-2026-05.md` — auditoría completa pre-sprint.
