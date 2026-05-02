# Sprint 2 — Populate sku_node_policy

**Fecha:** 2026-05-02
**Owner:** Vicente Elías
**Branch:** `sprint-2-populate-policy`
**Migration:** `supabase/migrations/20260503090000_sprint2_populate_sku_node_policy.sql`
**Decisiones cerradas:** H1, H2, H3, H5 (Camino C), H11. Opción A (todos los SKUs activos × 2 nodos).

---

## Qué se construyó

Sprint 2 puebla la tabla `sku_node_policy` (Sprint 1 la dejó vacía con schema overrides-only) usando un **lookup desde policy_templates por celda ABC×XYZ** para cada SKU activo × nodo de inventario. Sin tocar el motor de reposición todavía (Sprint 4 lo consume).

### Cambio de diseño vs Sprint 1

`sku_node_policy` pasó de **override-only** (vacía por default, fila escrita sólo cuando había razón documentada de desviarse) a **snapshot completo**: una fila por cada `(sku_origen, node_id)` con valores concretos copiados del template. Para preservar excepciones contra el cron de re-sync, se introdujo un flag boolean `manual_override`.

Como la tabla estaba vacía (0 rows pre-migration), el reshape (DROP de las 7 columnas `*_override` + ADD de 12 columnas snapshot) fue safe sin pérdida de datos. Tag commit: `[non-reversible:sprint1-empty-table-redesigned-snapshot-model]`.

Frontera Reposición/Pricing actualizada en `/docs/policies/frontera-reposicion-pricing.md` para reflejar el nuevo modelo.

### Tablas/funciones nuevas

| Objeto | Rol |
|---|---|
| `seasonal_categories` (TABLE) | Mitigación H2: marca categorías con estacionalidad fuerte. Match contra `LOWER(productos.categoria)`. Active flag distingue alias reales vs aspiracionales. |
| `calc_sku_node_policy_row(sku, node)` (FUNCTION STABLE) | Pura: dado un SKU+nodo, devuelve la fila candidata. Lee `productos`, `sku_intelligence`, `policy_templates`, `seasonal_categories`. |
| `refresh_sku_node_policy_from_templates()` (RPC) | Aplica `INSERT ... ON CONFLICT DO UPDATE` con la salida de `calc_sku_node_policy_row` para cada combinación. Preserva `manual_override=true`. Idempotente. |
| `v_sku_policy_diff` (VIEW) | Auditoría: por cada fila compara contra `policy_templates`. `diff_status` ∈ {override_manual, fallback_seasonal, blocked, aligned, drift_unexpected}. |

### API + cron

- `GET /api/policy/sync-from-templates` — auth Vercel cron / dev / `?run=1`. Llama a la RPC, audita en `audit_log`, retorna `{ok, rows_affected, duration_ms}`.
- `vercel.json`: `"30 11 * * 1"` (lunes 11:30 UTC = 08:30 Chile, post motor 11:00).

---

## Resultados de la corrida 2026-05-02

### Validación (13/13 PASS)

| # | Test | Resultado |
|---|---|---|
| T01 | `seasonal_categories` seedeada (≥5) | PASS |
| T02 | función `calc_sku_node_policy_row` existe | PASS |
| T03 | `sku_node_policy` poblada | PASS (974 rows) |
| T04 | cobertura completa (487 activos × 2 nodos) | PASS (974) |
| T05 | AX `high` z=2.05 exacto (golden SPM:713) | PASS (38) |
| T06 | AZ `high` z=1.28 (lean H3) | PASS (20) |
| T07 | CZ action=`no_reorder` | PASS (432) |
| T08 | SKUs sin costo bloqueados | PASS |
| T09 | seasonal × XYZ ∈ Y/Z → low_confidence flag | PASS |
| T10 | low_confidence_seasonal → z=1.88 | PASS (188) |
| T11 | `v_sku_policy_diff` retorna filas | PASS (974) |
| T12 | cero `drift_unexpected` post-backfill | PASS |
| T13 | refresh idempotente (hash igual entre corridas) | PASS |

### Métricas observadas

**Total filas:** 974 (= 487 SKUs activos × 2 nodos `bodega_central` y `full_ml`).

**Distribución por celda (rows; SKUs por nodo entre paréntesis):**

| Celda | rows | SKUs/nodo |
|---|---:|---:|
| AX  | 38  | 19 |
| AY  | 118 | 59 |
| AZ  | 28  | 14 |
| BX  | 2   | 1  |
| BY  | 78  | 39 |
| BZ  | 84  | 42 |
| CY  | 22  | 11 |
| CZ  | 432 | 216 |
| NULL (blocked) | 172 | 86 |
| **Total** | **974** | **487** |

**Distribución por `policy_status`:**

| Status | rows |
|---|---:|
| active | 802 |
| blocked_no_cost | 172 |
| blocked_no_history | 0 |
| blocked_no_template | 0 |

**Distribución por `xyz_confidence`:**

| Confidence | rows |
|---|---:|
| high | 614 |
| low_confidence_seasonal | 188 |
| NULL (blocked) | 172 |

**Distribución por `v_sku_policy_diff.diff_status`:**

| diff_status | rows | Comentario |
|---|---:|---|
| aligned | 614 | El SKU está alineado con el template canónico de su celda. |
| fallback_seasonal | 188 | Categoría seasonal + XYZ Y/Z → z=1.88 (mitigación H2). |
| blocked | 172 | Sin costo (`costo_promedio` NULL o 0). |
| override_manual | 0 | Ningún SKU con override manual aún. |
| drift_unexpected | 0 | ✅ Sin drift no explicado. |

### Observaciones

- **86 SKUs activos sin `costo_promedio`** → 172 rows blocked. Per `feedback_no_inferir_costos`, el motor NO debe rellenar con promedios de familia; estos SKUs quedan visibles pero NO se reordenan hasta que se cargue costo via recepción/OC/catálogo.
- **94 SKUs activos en `quilt`** clasificados Y/Z reciben fallback z=1.88 en lugar del z bajo de su celda. Esto evita undershoot durante baja temporada cuando el CV crudo distorsiona la clasificación. H2 backlog en Sprint 7+ reemplaza esta heurística por CV52 deseasonalizado.
- **CZ tiene 216 SKUs/nodo (mayoría del catálogo)**. Per H3+SPM:683, no se recompra. Quedan visibles con `action=no_reorder` explícito; el panel Reposición v2 (Sprint 4) los excluirá del flujo de sugerencias.

### Top 5 SKUs activos por celda en `bodega_central` (snapshot inicial para Sprint 4 testing)

| Celda | Top-5 sku_origen |
|---|---|
| AX | TXV23QLAT20BE, LITAF400G4PGR, JSAFAB421P20S, LITAF400G4PNG, 9788471511348 |
| AY | LICAAFVIS5746, TXTPBL20200SK, TX2ALMPL15507, RAPAC50X70AFA, TEXCCWTILL20P |
| AZ | ALPCMPRKZ4575, ALPCMPRCL4575, TXV25QLBRRS20, TXV23QLAT25GR, JSAFAB436P20W |
| BX | TXSB144ISY15P |
| BY | TXV25QLRM20NG, TXV25QLRM30MD, ALPCMPLNA6012, TXV23QLAT30NG, TXTLILL4G4PLM |
| BZ | JSAFAB438P20W, TXV23QLRM25CF, TXV25QLBRRS25, ALPCMPRBO4575, JSCNAE148P20Z |
| CY | 9788499451114, TXTLLPY1018SH, ALPCMPRPS4060, LIB-ES-12, TXSB144IRK15P |
| CZ | JSAFAB439P20W, ALPCMPRDG4575, TXV25QLBRGR25, TXSBAF144VT20, AFCFD380X120C |

---

## Flujo de datos

```
┌─────────────┐      ┌──────────────────┐      ┌──────────────────────┐
│ productos   │      │ sku_intelligence │      │ policy_templates     │
│ (sku, costo,│      │ (sku_origen,     │      │ (cell, SL, z_value,  │
│  categoria, │      │  abc_unidades,   │      │  target_dias, action)│
│  estado_sku)│      │  xyz, vel_pond)  │      │                      │
└──────┬──────┘      └────────┬─────────┘      └──────────┬───────────┘
       │                      │                            │
       └──────────────────────┼────────────────────────────┘
                              │
                  ┌───────────▼───────────┐      ┌─────────────────────┐
                  │ calc_sku_node_policy_ │ ←——— │ seasonal_categories │
                  │ row(sku, node)        │      │ (mitigación H2)     │
                  └───────────┬───────────┘      └─────────────────────┘
                              │
                  ┌───────────▼───────────┐
                  │ INSERT ... ON CONFLICT│
                  │ DO UPDATE             │
                  │ WHERE NOT manual_     │
                  │   override            │
                  └───────────┬───────────┘
                              │
                  ┌───────────▼───────────┐
                  │ sku_node_policy       │ → consumed by Sprint 4
                  │ (snapshot)            │   (agente Reposición v2)
                  └───────────────────────┘
                              │
                              ▼
                  ┌───────────────────────┐
                  │ v_sku_policy_diff     │ → auditoría (drift_unexpected=0)
                  └───────────────────────┘
```

---

## Lo que NO cambió

- `intelligence.ts` — agente Reposición sigue calculando desde `sku_intelligence` directamente. Sprint 4 lo refactoriza para que lea de `sku_node_policy`.
- `policy_templates` — input canónico inmutable; nadie lo escribe.
- `sku_intelligence` — sólo lectura desde `calc_sku_node_policy_row`.
- Pricing/markdown — sigue en `sku_intelligence` hasta Sprint 6 (frontera H5 Camino C).

---

## Próximos pasos

- **Sprint 3**: poblar `velocidad_censurada` y `dias_quiebre_window_30d` (hoy NULL). Refactor de fórmulas de velocidad para censurar semanas con ≥3 días en quiebre.
- **Sprint 4**: agente Reposición v2 lee `sku_node_policy` (no más `sku_intelligence` directo para política). Panel admin gana columna "Política aplicada" + UI para crear `manual_override`.
- **Sprint 6**: migrar pricing/markdown de `sku_intelligence` a tabla dedicada (`markdown_state`).
- **Sprint 7+** (~2027-04): cuando ≥80% del catálogo tenga 52 semanas, reemplazar `seasonal_categories` por `v_cv_52sem` deseasonalizada + `xyz_confidence` derivado.

---

## Referencias

- `/CONVENTIONS.md` §1, §2, §3, §4.
- `/atlas.hcl` y `/docs/atlas-runbook.md`.
- `/docs/policies/frontera-reposicion-pricing.md` (vinculante, H5 Camino C, actualizada Sprint 2).
- `/concept-registry.yml` — `politica_sku_nodo`.
- `/ssot-registry.yml` — `politica_reposicion_por_sku_nodo`.
- `/metrics.yaml` — z_efectivo, target_dias_full, policy_action_per_sku, xyz_confidence (agregadas Sprint 2).
- `/.claude/rules/inventory-policy.md` — Reglas 3, 5; `feedback_no_inferir_costos`.
