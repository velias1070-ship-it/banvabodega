# Frontera Reposición / Pricing — Policy vinculante

> **Status:** Vinculante (Sprint 1, 2026-05-02). Owner: Vicente Elías.
> Si código contradice este doc, corregir código (per `feedback_disonancia_policy_vs_manual`).

## Decisión

**H5 Camino C** — separar el modelo de datos de **Reposición** (qué pedir, cuánto pedir, a qué nodo) del modelo de **Pricing/Markdown** (a qué precio liquidar, cuándo bajar precio, cuándo congelar) **ahora** (Sprint 1) **sin moverlos a tablas distintas todavía**.

- **Reposición v2** lee desde `sku_node_policy` + `policy_templates` + nuevas vistas `v_stock_por_nodo` + `v_in_transit_por_nodo` (Sprint 2 implementa el motor).
- **Pricing/Markdown** sigue leyendo `sku_intelligence` (campos como `accion_pricing`, `markdown_pct`, etc.) hasta Sprint 6.

La frontera es **lógica**, no física. Ambas pueden tocar `sku_intelligence` en lecturas, pero las **escrituras autoritativas** quedan separadas:
- Reposición decide → `sku_node_policy.*_override` o `policy_templates`.
- Pricing decide → `sku_intelligence.markdown_*`, `sku_intelligence.accion_pricing`.

## Por qué Camino C (y no A ni B)

| Camino | Qué propone | Por qué se descartó |
|---|---|---|
| **A** | Mover Pricing a tablas separadas YA (Sprint 1) | Demasiado scope. Pricing toca paneles (`AdminMargenes`, `AdminInteligencia#pricing`), agentes, exports. Romper UI antes de tener el motor multi-bodega andando es alto blast radius. |
| **B** | Dejar todo junto en `sku_intelligence` indefinidamente | El cache de `sku_intelligence` se vuelve un God-table. Reposición v2 + multi-bodega va a necesitar `(sku, node_id)` como clave; `sku_intelligence` es PK por `sku` solo. Camino B nos lleva a re-migrar todo en 6 meses. |
| **C** ✅ | Separar lógicamente **ahora**, físicamente en Sprint 6 | Permite construir Reposición v2 (Sprint 2) sin tocar Pricing. Pricing migra cuando tenga sus propios consumers cohesionados (Sprint 6 cuando se rediseñe el panel de markdown). |

## Reglas operativas

### 1. Escrituras

| Concepto | Tabla autoritativa | Quién escribe |
|---|---|---|
| Stock canónico | `stock` | RPC `registrar_movimiento_stock` (única vía). |
| Política reposición por celda | `policy_templates` | Migration manual (revisión humana). |
| Snapshot SKU×Nodo (reposición) | `sku_node_policy` | Cron weekly `/api/policy/sync-from-templates` (Sprint 2). UI admin reposición Sprint 4 escribe `manual_override=true`. |
| Cache cálculos reposición | `sku_intelligence` (campos `pedir_*`, `mandar_full`, `dias_*`) | `intelligence.ts:recalcularTodo`. Cache reconstruible. |
| Cache pricing/markdown | `sku_intelligence` (campos `accion_pricing`, `markdown_*`) | `pricing.ts` + crons pricing. **No tocar desde Reposición.** |

### 2. Lecturas

- **Reposición v2** (Sprint 2+) puede leer cualquier campo de `sku_intelligence`, pero **no puede escribir** los campos de pricing/markdown.
- **Pricing** puede leer `sku_intelligence` y los nuevos views (`v_stock_por_nodo`, `v_in_transit_por_nodo`) si los necesita para informar markdown decisions, pero **no puede escribir** `sku_node_policy` ni `policy_templates`.

### 3. Resolución de política (Reposición v2)

**Cambio Sprint 2 (2026-05-02):** `sku_node_policy` pasó de **override-only** (vacía por default + columnas `*_override` nullables) a **snapshot completo** (una fila por cada `(sku, node)` activo, valores concretos copiados del template). El cambio se hizo porque la tabla quedó vacía durante semanas en Sprint 1 (proceso "escribir override sólo cuando hay razón" no escaló) y porque agentes downstream (Sprint 4) necesitan un read consistente sin tener que aplicar la lógica de fallback en cada query.

Lookup actual:

```sql
SELECT cell, service_level, z_value, target_dias_full, action,
       xyz_confidence, policy_status, manual_override
  FROM sku_node_policy
 WHERE sku_origen=$1 AND node_id=$2;
```

Estados de fila:

| `policy_status` | Significado |
|---|---|
| `active` | Política aplicable. Lookup ya resolvió template + mitigaciones. |
| `blocked_no_cost` | Falta `costo_promedio`. No reordenar hasta cargar costo (per `feedback_no_inferir_costos`). |
| `blocked_no_history` | Falta clasificación ABC×XYZ. Sprint 3 puede mejorar este branch. |
| `blocked_no_template` | Celda inválida (no debería ocurrir con seed Sprint 0). |

Mitigación H2 (estacionalidad): si la categoría está en `seasonal_categories` (active) y `xyz IN ('Y','Z')`, `xyz_confidence='low_confidence_seasonal'` y `z_value=1.88` (conservador) en lugar del z bajo de la celda. Sprint 7+ reemplaza por CV52 deseasonalizado.

**Cron weekly** `/api/policy/sync-from-templates` (lunes 11:30 UTC) recalcula la tabla preservando filas con `manual_override=true`.

### 4. Sprint 6 — Migración Pricing fuera de `sku_intelligence`

Cuando llegue Sprint 6 (rediseño del panel markdown, ETA Q3 2026):

1. Crear tabla `markdown_state(sku, accion_pricing, markdown_pct, fecha_decision, ...)`.
2. Backfill desde `sku_intelligence`.
3. Migrar lectores (`AdminMargenes`, `AdminInteligencia#pricing`, agente pricing) a la nueva tabla.
4. Dropear los campos pricing de `sku_intelligence` (con `[non-reversible:pricing-moved-to-markdown_state]` per Atlas runbook).

Hasta Sprint 6 los campos siguen donde están.

## Casos límite

- **Q: ¿Y si Reposición necesita el `markdown_pct` para calcular cuánto pedir?**
  R: Léelo de `sku_intelligence` como cualquier otro field. La frontera prohíbe escritura cruzada, no lectura.

- **Q: ¿Y si Pricing decide que un SKU debe pasar a "no_recompra"?**
  R: Esa señal se expresa hoy vía `policy_templates.reorder_action='no_recompra'` para la celda CZ, o vía `sku_node_policy.reorder_action_override='no_recompra'` para overrides puntuales. Pricing no escribe ahí; el agente Pricing levanta una alerta y un humano (o Sprint 4 agente Reposición autónomo) decide aplicar el override.

- **Q: ¿Qué pasa con `inteligencia_full` (estado FlexFull)?**
  R: Se mantiene como cache derivada de stock + composición + estado pricing. Lectura libre, escritura sólo desde `calcularEstadoFlexFull` (P-INV-1).

## Casos históricos relacionados

- **2026-04-28 (Adendum A — Op Limpieza híbrida)**: precedente de coexistencia velocidad-semanal vs ST-diario sin colapsar uno en el otro. Misma lógica acá: dos motores conviven sin escribir el mismo cache.
- **`feedback_movimientos_stock`**: principio "todo cambio de stock pasa por RPC" — la frontera replica esta idea: todo cambio de política pasa por su tabla autoritativa.
- **Regla 5 inventory-policy.md**: "fuente única canónica + lecturas derivadas" — `sku_intelligence` es **cache** del motor de inteligencia, no canónica para pricing ni para reposición. Las canónicas son `policy_templates` + `sku_node_policy` (Reposición) y, post-Sprint 6, `markdown_state` (Pricing).

## Ver también

- `/atlas.hcl` y `/docs/atlas-runbook.md` — cómo el drift detection vigila este modelo.
- `/CONVENTIONS.md` §3 (SSoT) y §4 (CDMP).
- `/docs/sprints/sprint-1-nodes-lanes-policy.md` — sprint que crea las tablas referenciadas acá.
- `/ssot-registry.yml` — `politica_reposicion_por_celda` (owner_table=policy_templates) y nuevo `politica_reposicion_por_sku_nodo` (owner_table=sku_node_policy).
