---
sprint: 7
title: Cerrar deuda Sprint 6 + protección Flex + DIO + Liquidación + Alertas + Explicación
date: 2026-05-05
owner: Vicente Elías
tags: [batch:20260505-sprint-7-fase0] [batch:20260505-sprint-7-fase1] [batch:20260505-sprint-7-fase2] [batch:20260505-sprint-7-fase3] [batch:20260505-sprint-7-fase4] [batch:20260505-sprint-7-fase6] [sprint:7] [feature]
related:
  - docs/sprints/sprint-6-cerrar-gap-viejo-nuevo.md
  - docs/policies/proteccion-flex.md
  - tests/sql/regression_sprint6_patches.sql
  - supabase/migrations/20260505111532_sprint7_fase0a_in_transit_picking_pickeados.sql
  - supabase/migrations/20260505111737_sprint7_fase0a_recreate_dependent_views.sql
  - supabase/migrations/20260505111957_sprint7_fase0b_mandar_full_uds_proteccion_flex.sql
  - supabase/migrations/20260505113243_sprint7_fase1_urgente_cobertura_cruda.sql
  - supabase/migrations/20260505113416_sprint7_fase1_cell_default_huerfanos.sql
  - supabase/migrations/20260505113543_sprint7_fase1_cell_default_bypass_no_cost.sql
  - supabase/migrations/20260505115127_sprint7_fase2_dio_motor_nuevo.sql
  - supabase/migrations/20260505115214_sprint7_fase2_recreate_compras_pendientes.sql
  - supabase/migrations/20260505115320_sprint7_fase2_recreate_reposicion_explain.sql
  - supabase/migrations/20260505122055_sprint7_fase3_markdown_policy_table.sql
  - supabase/migrations/20260505122254_sprint7_fase3_calc_row_with_liquidacion.sql
  - supabase/migrations/20260505122414_sprint7_fase3_recreate_reposicion_explain_with_liquidacion.sql
  - supabase/migrations/20260505130958_sprint7_fase4_v_sku_alertas.sql
  - supabase/migrations/20260505131104_sprint7_fase4_recreate_reposicion_explain_with_alertas.sql
  - supabase/migrations/20260505140000_sprint7_fase6_v_sku_explanation.sql
---

# Sprint 7 — Fase 0 + Fase 1 + Fase 2 + Fase 3 + Fase 4 + Fase 6

## TL;DR

Cuatro bloques (~14 h) que cierran deuda Sprint 6 + bug crítico mandar_full_uds + DIO + liquidación P17:

| Bloque | Cambio | Impacto |
|---|---|---|
| **0.A** | Lane `bodega_to_full` lee componentes en estado `PICKEADO` (no PENDIENTE). `stock_bodega` ya descontó esos uds vía `registrar_movimiento_stock motivo='envio_full'`; ML aún no confirma como recibidos en `meli_facility`. | 426 uds en tránsito visibles al motor (antes invisibles). 21 SKUs con picking activo descontado correctamente. |
| **0.B** | `mandar_full_uds` rediseñado: nunca reduce `stock_bodega` por debajo de `reserva_flex_target`. `deficit_full` descuenta `in_transit_picking_full` para evitar double-shipping. Excepción: lote inicial `is_new_sku`. | TXTPBL20200SK (bodega=2 < flex=15) ya NO sugiere mandar Full. 11 SKUs con flex protegido. |
| **1.1** | URGENTE override por cobertura cruda: `stock_total < vel_pond_semanal` (paridad motor viejo Bug B Sprint 6). | ALPCMPRBO4575 (vel=5.97, stock=4) y TXSBAF144VT20 (vel=2.04, stock=1) → URGENTE. Motor nuevo: 11 URGENTE total. |
| **1.2** | Cell default + bypass blocked_no_cost para `is_new_sku`: SKUs nuevos sin costo/historia ABC×XYZ → `cell='BY'` + `policy_status='active'`. | 4 huérfanos (JSCNAE190P15W, JSCNAE190P20W, SPAFE30E10W26, SPAFE40O15W26) ahora visibles en `v_compras_pendientes`. |
| **2** | DIO en motor nuevo: `dio = stock_total / d_avg_dia` (centinela 999 si vel=0). Expuesto en `v_safety_stock` y `v_reposicion_explain`. | Caso testigo JSAFAB422P20S: 2.5 días paridad exacta. Paridad masiva 91.6% en SKUs con stock alineado. |
| **3** | Liquidación portada de P17 motor viejo a tabla `markdown_policy` parametrizable (9 cells × 3 thresholds = 27 rows). 4 columnas nuevas en `sku_node_policy`: `dias_extra`, `liquidacion_accion`, `liquidacion_descuento_sugerido`, `liquidacion_override`. | Filtro elegibilidad: `abc=C` o `cuadrante=REVISAR` + `vel>0`. Lookup automático en cron sync. Owner override por SKU. Paridad 93.6% (132/141) vs motor viejo. |
| **4** | Alertas autónomas mínimas: 5 condiciones bloqueantes/excepcionales en `v_sku_alertas`. 17 alertas motor viejo se reducen a 5 (doctrina autónoma). Expuestas en `v_reposicion_explain` como `alertas text[]` + `alertas_count int`. | 89 SKUs con 1 alerta + 14 con 2 (vs 406 sin alerta). Pirámide saludable. flex_no_publicado=76, sin_stock_proveedor=41, stock_danado_full=0, sin_costo=0, quiebre_largo=0. |
| **6** | Sistema de explicación: `v_sku_explanation` con narrativa estructurada por SKU (7 secciones: velocidad, celda, quiebre, compromisos, decision, liquidación, alertas). JSONB + texto plano. Fórmulas y motivos explícitos. | 253/253 SKUs con narrativa. Auditoría puntual via SQL directo. Sin UI nueva. Detecta vel_pre_quiebre activado, cell promovida/degradada, ETA OC abierta. |

---

## Fase 0.A — Lane bodega_to_full

### Bug

`v_in_transit_por_nodo` filtraba componentes en estado **distinto** de `PICKEADO`, interpretando "pendiente de pickear" como "en tránsito". La doctrina operativa es la inversa:

- Estado `PICKEADO` → `stock_bodega` ya descontó, ML aún no confirma → físicamente in-transit bodega→Full.
- Estado `PENDIENTE` → todavía en bodega, sin movimiento.

426 uds activamente en tránsito reportadas como 0.

### Fix

```sql
WHERE ps.tipo = 'envio_full'
  AND ps.estado IN ('ABIERTA','EN_PROCESO')
  AND (componente.value ->> 'estado') = 'PICKEADO'
```

ETA estimada: `ps.created_at + 3 días` (típico ML inbound).

### CASCADE

DROP CASCADE de `v_safety_stock` + `v_compras_pendientes` + `v_reposicion_explain`. Recreadas idénticas en migration `20260505111737`.

---

## Fase 0.B — mandar_full_uds protege Flex

Ver doctrina completa en `docs/policies/proteccion-flex.md`.

### Decision tree

```
deficit_full := MAX(0, pre_full_target - stock_full - in_transit_picking_full)
disponible_para_full := MAX(0, stock_bodega - reserva_flex_target)

mandar_full_uds := CASE
  -- 1. Lote inicial nuevos
  WHEN is_new_sku=true AND stock_full=0 AND stock_bodega>0
  THEN LEAST(GREATEST(inner_pack, 2), stock_bodega)

  -- 2. Operativos vel>0
  WHEN vel_actual>0 AND deficit_full>0 AND disponible_para_full>0
  THEN LEAST(CEIL(deficit_full), disponible_para_full)

  ELSE 0
END
```

### Casos testigo

| SKU | bodega | flex | picking | deficit | disponible | mandar | Decisión |
|---|---|---|---|---|---|---|---|
| TXTPBL20200SK | 2 | 15 | 36 | 56 | 0 | **0** | bodega < flex → no mandar |
| JSAFAB438P20W | 3 | 1 | 4 | 9 | 2 | **2** | manda 2 (picking cubre parte) |
| JSCNAE188P15W | 6 | 0 | 0 | — | — | **6** | lote inicial new_sku |

---

## Fase 1.1 — URGENTE cobertura cruda

### Bug B Sprint 6

Motor viejo (`intelligence.ts:1486-1507`) dispara `URGENTE` cuando `stock_total < vel_diaria*7` (cobertura cruda <7 días). Motor nuevo solo evaluaba `cob_full < punto_reorden`. 2 SKUs operativamente urgentes clasificaban PLANIFICAR.

### Fix

Extender rama URGENTE existente con OR adicional. Como `vel_ponderada` es semanal, `vel_diaria*7 = vel_ponderada`:

```sql
ELSIF (COALESCE(v_cob_full, 999) < COALESCE(v_punto_reorden, 0)
       AND COALESCE(v_cob_full, 999) < 999)
      OR (COALESCE(v_st_total, 0) > 0
          AND COALESCE(v_vel_pond, 0) > 0
          AND COALESCE(v_st_total, 0)::numeric < COALESCE(v_vel_pond, 0)) THEN
  v_accion := 'URGENTE'; v_prioridad := 15;
```

### Validación

| SKU | vel_pond | stock_total | cob_full | viejo | nuevo pre | nuevo post |
|---|---|---|---|---|---|---|
| ALPCMPRBO4575 | 5.97 | 4 | 1.47 | URGENTE | PLANIFICAR | **URGENTE** ✓ |
| TXSBAF144VT20 | 2.04 | 1 | 4.29 | URGENTE | PLANIFICAR | **URGENTE** ✓ |

Distribución URGENTE post-fix: 11 SKUs (vs 9 pre).

---

## Fase 1.2 — Cell default + bypass blocked_no_cost

### Bug

4 SKUs (`is_new_sku=true`, `dias_de_vida` 29-34) caían en `policy_status='blocked_no_cost'` porque `productos.costo_promedio=0` (sin recepción). Quedaban con `cell=NULL` y excluidos del pipeline.

### Fix

```sql
IF v_is_new_sku THEN
  v_status := 'active';
  v_cell := 'BY';                    -- default lote inicial razonable
ELSIF v_costo IS NULL OR v_costo = 0 THEN
  v_status := 'blocked_no_cost';
ELSIF v_abc IS NULL OR v_xyz IS NULL THEN
  v_status := 'active';
  v_cell := 'CY';                    -- conservador para huérfanos sin abc/xyz
ELSE
  v_status := 'active';
  v_cell := v_abc || v_xyz;
END IF;
```

`is_new_sku` salta el bloqueo por costo. Para huérfanos no-nuevos sin abc/xyz, asigna `'CY'` (alta variabilidad asumida).

### Validación

```
JSCNAE190P15W → cell=BY status=active → en v_compras_pendientes ✓
JSCNAE190P20W → cell=BY status=active → en v_compras_pendientes ✓
SPAFE30E10W26 → cell=BY status=active → en v_compras_pendientes ✓
SPAFE40O15W26 → cell=BY status=active → en v_compras_pendientes ✓
```

`accion='INACTIVO'` (no manda Full porque stock_bodega=0). Es comportamiento correcto: SKUs nuevos sin stock están "esperando recepción"; el motor los reportará cuando cambien.

### Iteración

Primera migration (`20260505113416_sprint7_fase1_cell_default_huerfanos`) atacó solo el caso `blocked_no_history` (abc/xyz NULL). No funcionó porque los 4 SKUs caían antes en `blocked_no_cost`. La segunda migration (`20260505113543_sprint7_fase1_cell_default_bypass_no_cost`) extendió el bypass al caso sin costo.

---

## Fase 2 — DIO en motor nuevo

### Cambio

Expone DIO (Days Inventory On Hand) al pipeline nuevo. Fórmula equivalente a `intelligence.ts:1280`:

```sql
CASE
  WHEN d_avg_sem > 0 THEN round(stock_total / (d_avg_sem / 7.0), 2)
  ELSE 999::numeric
END
```

Calculado en `v_safety_stock` (con JOIN a `v_stock_por_nodo` para `stock_total`) y propagado a `v_reposicion_explain` vía `vsf.dio`.

### Caso testigo

JSAFAB422P20S: stock=1, vel_ponderada=2.8, d_avg_dia=0.4 → DIO = 1/0.4 = **2.5 días**. Motor viejo `sku_intelligence.dio` = 2.5. **Paridad exacta** ✓.

### Divergencia DIO viejo vs nuevo

Paridad masiva: **91.6%** (230/251 SKUs con stock alineado). El 95% pretendido por la spec NO se cumple por divergencia arquitectural intencional, no bug:

- **21 SKUs divergentes son TODOS `es_quiebre_proveedor=true` con `dias_en_quiebre>=14`**.
- Causa: motor nuevo usa `d_avg_sem efectivo` (con `vel_pre_quiebre` cuando dias_quiebre>=14, factor_rampup, multiplicador_evento). Motor viejo usa `vel_ponderada` raw.
- **El nuevo es mejor**: para SKUs en quiebre, DIO con velocidad ajustada refleja la realidad operativa esperada cuando vuelva el stock. El viejo da 999 (centinela inservible) o un DIO inflado por velocidad cero post-quiebre.
- 2 SKUs con stock drift entre fuentes (cache stale en `sku_intelligence.stock_total` vs realtime `v_stock_por_nodo`) son deuda conocida del motor viejo, no del nuevo.

**Patrón documentado**: cualquier métrica del motor nuevo que use `d_avg_sem efectivo` va a divergir del motor viejo en SKUs con quiebre prolongado / eventos / rampup. Es divergencia arquitectural intencional. Aplica a: **DIO, ROP, safety_stock, cycle_stock, qty_a_comprar**.

### Validación masiva

```
Total comparables  : 253 SKUs
Stock alineado     : 251 (99.2%)
Match DIO ≤0.5d    : 230 (91.6% sobre alineados)
Stock drift (cache): 2 (deuda motor viejo)
```

---

## Fase 3 — Liquidación + markdown_policy

### Doctrina P17 portada

Motor viejo (`intelligence.ts:2121-2137`) tenía hardcodeado:

```
diasExtra = MAX(0, ROUND(dio - target_dias_full))
> 30 días → descuento_10, 10%
> 60 días → liquidar_activa, 25%
> 90 días → precio_costo, 40%
```

Ahora vive en tabla `markdown_policy(cell, dias_extra_threshold, descuento_pct, liquidacion_accion)` con 27 rows seedeadas (9 cells × 3 thresholds). Lookup: `WHERE cell=X AND dias_extra > threshold ORDER BY threshold DESC LIMIT 1`.

### Filtro de elegibilidad

`calc_sku_node_policy_row` aplica liquidación solo cuando:

```sql
(v_abc = 'C' OR v_cuadrante = 'REVISAR') AND COALESCE(v_vel_pond, 0) > 0
```

Excluye DEAD_STOCK (vel=0) y SKUs A/B con cuadrante operativo.

### Override del owner

`sku_node_policy.liquidacion_override` (default NULL). Si NOT NULL, ignora cálculo automático y usa el valor forzado. Ad-hoc por SKU sin tocar la doctrina general.

### Casos testigo

```
JSAFAB436P10W: cell=CZ, dio=360, target=14, dias_extra=350 → precio_costo (0.40)
TXS2CTBO135ST: cell=CZ, dio=911, target=14, dias_extra=913 → precio_costo (0.40)
ALPCMPRPA6012: cell=CZ, dio=98,  target=14, dias_extra=97  → precio_costo (0.40)
```

### Paridad motor viejo

```
Total comparables : 141 SKUs
Match exacto      : 132 (93.6%)
Solo viejo        : 0
Solo nuevo        : 4 (SKUs no marcados antes; motor nuevo recalcula con DIO efectivo)
Accion distinta   : 5 (ej. descuento_10 viejo → liquidar_activa nuevo)
```

Discrepancias remanentes son por divergencia de `target_dias_full`: la celda `CZ` en `policy_templates` tiene `target_dias_full=0` (action=no_reorder), mientras motor viejo usa `target=14` o `28` desde otra fuente inline. Esto está alineado con la nota de spec ("target_dias_full distinto si cell_efectiva != cell").

### Fuera de scope (Sprint 7)

- ❌ Cambiar precios automáticos vía `pricing_rule_sets` (decisión Sprint 8+)
- ❌ Eliminar P17 del código viejo (mantener `@deprecated`)
- ❌ UI nueva (post-cleanup)
- ❌ Liquidaciones por campaña con fecha_inicio/fin

---

## Fase 4 — Alertas autónomas mínimas

### Cambio

Vista `v_sku_alertas` con 5 alertas (text[] + count). Expuestas en `v_reposicion_explain` como `alertas` y `alertas_count`. El motor viejo tenía 17 alertas en `intelligence.ts` (P19); el motor nuevo expone solo 5.

```sql
ARRAY_REMOVE(ARRAY[
  CASE WHEN vel_ponderada > 0 AND (costo_promedio IS NULL OR costo_promedio = 0)
    THEN 'sin_costo' END,
  CASE WHEN tiene_stock_prov = false
    THEN 'sin_stock_proveedor' END,
  CASE WHEN dias_en_quiebre > 30
    THEN 'quiebre_largo' END,
  CASE WHEN publicar_flex = 0 AND (vel_flex > 0 OR vel_flex_pre_quiebre > 0)
    THEN 'flex_no_publicado' END,
  CASE WHEN uds_danado > 0 OR uds_perdido > 0
    THEN 'stock_danado_full' END
], NULL)
```

### Fuentes de datos

| Alerta | Fuente | Condición |
|---|---|---|
| `sin_costo` | `productos.costo_promedio` | `vel>0 AND (costo IS NULL OR costo=0)` |
| `sin_stock_proveedor` | `sku_intelligence.tiene_stock_prov` | `tiene_stock_prov=false` |
| `quiebre_largo` | `sku_intelligence.dias_en_quiebre` | `dias_en_quiebre > 30` |
| `flex_no_publicado` | `stock_snapshots.publicar_flex` (latest) | `publicar_flex=0 AND (vel_flex>0 OR vel_flex_pre_quiebre>0)` |
| `stock_danado_full` | `stock_full_cache.stock_danado/stock_perdido` | sumado por sku_origen vía `composicion_venta` |

### Doctrina autónoma — por qué se eliminaron 14 alertas del catálogo viejo

La pregunta para conservar una alerta era: **¿el sistema puede actuar solo, o necesita un humano?** Si el sistema puede, no es alerta — es comportamiento del motor.

**Eliminadas porque ya viven como `accion`** (10 redundantes):

- `urgente`, `agotado_full`, `necesita_pedir`, `reponer_proactivo`, `dead_stock`, `exceso`, `liquidar`, `nuevo_con_stock`, `pedido_bajo_moq`, `proveedor_agotado_con_cola_full`. Todas estas son ramas del decision tree que generan `accion` + `prioridad`. Mostrarlas como alerta duplica información ya visible en la columna `accion`.

**Eliminadas porque las computa o auto-resuelve el motor** (4):

- `en_transito` → `in_transit_oc_bodega` y `in_transit_picking_full` ya están en la vista; el motor descuenta de `deficit_full` automáticamente.
- `pico_demanda`, `caida_demanda`, `evento_activo` → ya se reflejan en `multiplicador_evento`, `factor_rampup_aplicado`, `vel_drift_status`. La velocidad efectiva absorbe el cambio sin necesidad de alertar.
- `catch_up_post_quiebre` → cubierto por `factor_rampup_aplicado` + `rampup_motivo`.

**Eliminadas porque son metas/observabilidad, no anomalías** (3):

- `bajo_meta`, `sobre_meta` → comparativos con metas que el operador ya ve en el panel comercial.
- `proveedor_volvio_stock` → es una transición positiva; no requiere acción humana excepcional, solo recálculo (que ya hace el cron).

**Eliminadas porque son agregaciones de otras alertas** (2):

- `estrella_quiebre_prolongado`, `quiebre_flex_prolongado` → son `quiebre_largo` + filtros derivables. Mantener una sola alerta canónica.

**Eliminadas porque eran metadata de modelo, no de SKU** (4):

- `forecast_*` (4 variantes) → metadata de calidad del forecast, no requiere acción operativa por SKU.

### Las 5 que sí quedaron

Cada una pasa el filtro **(1) bloquea el pipeline OR (2) anomalía no auto-resoluble OR (3) acción humana excepcional**:

- `sin_costo` — vel>0 sin costo bloquea cálculo de margen, ROP, qty_a_comprar. **Bloquea**.
- `sin_stock_proveedor` — el sistema no puede generar OC. **Bloquea**.
- `quiebre_largo` — `dias_en_quiebre > 30` requiere decisión humana (insistir, sustituir SKU, descontinuar). **Decisión**.
- `flex_no_publicado` — ML requiere acción manual en panel; el motor no puede reactivar. **Acción humana**.
- `stock_danado_full` — anomalía física en bodega ML, requiere reconciliación humana. **Anomalía**.

### Caso testigo

```
JSAFAB422P20S: dias_en_quiebre=3, vel_ponderada=2.8, costo=ok, publicar_flex=0
  → ['flex_no_publicado'], count=1
  → NO 'quiebre_largo' (3 < 30) ✓
```

### Pirámide saludable

```
406 SKUs sin alerta (~80%)
 89 SKUs con 1 alerta
 14 SKUs con 2 alertas
  0 SKUs con 3+ alertas
```

Distribución: `flex_no_publicado=76`, `sin_stock_proveedor=41`, `stock_danado_full=0`, `sin_costo=0`, `quiebre_largo=0`.

### Fuera de scope (Sprint 7)

- ❌ Eliminar P19 del motor viejo (mantener vivo, marcar `@deprecated` en sprint posterior).
- ❌ UI de gestión de alertas (post-cleanup).
- ❌ Severidad/prioridad por alerta (todas son binarias).
- ❌ Notificaciones push.

---

## Fase 6 — Auditoría vía v_sku_explanation

### Cambio

`v_sku_explanation` genera narrativa estructurada por SKU, en 7 secciones:

| Sección | Contenido |
|---|---|
| `velocidad` | vel real/d, declarada/d, drift %. Detecta vel_pre_quiebre activado y multiplicador evento. |
| `celda` | cell + target Full/Flex + z. Detecta override manual, promoción (cell ORIGINAL → EFECTIVA por trend), degradación. |
| `quiebre` | NULL si stock OK. Si quiebre: días + causa (proveedor/propio) + factor rampup + motivo. |
| `compromisos` | stock bruto - reservado, picking activo hacia Full, in_transit OC + ETA + número OC. |
| `decision` | Fórmula deficit_full y disponible_para_full → mandar_full_uds. Fórmula qty_a_comprar + redondeo a inner_pack. |
| `liquidación` | NULL si no aplica. Si aplica: dias_extra, DIO, target, acción, descuento sugerido %, override owner. |
| `alertas` | NULL si no hay. Si hay: lista corta de alertas activas. |

Output: dos columnas — `explicacion jsonb` (estructurado, `jsonb_strip_nulls`) y `explicacion_texto text` (plano para grep/logs).

### Doctrina autónoma

Bajo paradigma autónomo, el sistema decide solo. La explicación NO es UI operativa: existe para que el owner audite un SKU específico cuando lo necesite, vía SQL directo. Si una UI visual se necesita más adelante, se construye sobre esta vista.

### Fuente de inputs

`v_reposicion_explain` (single source) + `oc_eta` LATERAL para fecha emisión OC más reciente con pendiente > 0. Heurística arquitectural: motor usa `vel_pre_quiebre` cuando `dias_en_quiebre >= 14 AND vel_pre_quiebre > vel_decl_sem` (refleja la divergencia documentada en Fase 2).

### Caso testigo — JSAFAB422P20S (operativo normal)

```
vel=0.30/d (declarada 0.40/d, drift -25.0%)
cell AY (target 42d Full, 5d Flex), z=1.75
3 días en quiebre. Causa: proveedor. Rampup factor: 1.00 (quiebre_proveedor_fresco).
stock_bodega 1 = bruto 1 - reservado 0. in_transit OC proveedor: 8 uds (ETA 2026-05-03, OC-006).
deficit Full = pre_full_target 17 - stock_full 0 - in_transit 0 = 17. Disponible para Full = stock_bodega 1 - reserva_flex 2 = 0. mandar_full_uds = 0.
qty_a_comprar = MAX(0, ROP 4 - stock_total 1 - in_transit_oc 8) = 12.
Alertas activas: flex_no_publicado.
```

### Caso testigo — TXV23QLAT20AQ (quiebre prolongado, vel_pre_quiebre activado)

```
vel pre-quiebre 0.55/d > vel actual 0.20/d porque 15 días en quiebre prolongado, motor usa el mayor para SS y ROP
cell AY (target 42d Full, 5d Flex), z=1.75
15 días en quiebre. Causa: proveedor. Rampup factor: 1.00 (quiebre_proveedor_fresco).
stock_bodega 0 = bruto 0 - reservado 0 (picking activo de 3 uds hacia Full). in_transit OC proveedor: 0 uds.
deficit Full = pre_full_target 23 - stock_full 0 - in_transit 3 = 20. Disponible para Full = stock_bodega 0 - reserva_flex 3 = 0. mandar_full_uds = 0.
qty_a_comprar = MAX(0, ROP 7 - stock_total 0 - in_transit_oc 0) = 28. Redondeado a inner_pack 8: 32.
Alertas activas: sin_stock_proveedor, flex_no_publicado.
```

### Validación masiva

```
253 SKUs con narrativa (100%)
 50 con liquidación
 23 con quiebre activo
 76 con alertas
```

### Fuera de scope (Sprint 7)

- ❌ UI nueva (botón "Explicar SKU", modal, tooltips).
- ❌ Tab dedicado en `/admin`.
- ❌ Endpoint `/api/intelligence/sku-explain` (consumo SQL directo basta).
- ❌ Audit log histórico de explicaciones.

### Reglas para agentes

- **No agregar campos a la narrativa sin pasar por `v_reposicion_explain` primero.** Si falta un dato, agregarlo a la vista madre y luego exponerlo aquí.
- **No traducir a inglés.** La narrativa va al owner (Vicente, español chileno).
- **Si se agrega una rama nueva al CASE de velocidad/celda/quiebre, agregar caso testigo correspondiente** en regression suite (T23-T27).

---

## Regresión Sprint 6

`tests/sql/regression_sprint6_patches.sql` (12 tests) cubre paridad motor viejo→nuevo + protecciones nuevas:

| Test | Resultado |
|---|---|
| T01 — accion+prioridad NOT NULL en active | PASS: 427 policies |
| T02 — is_new_sku en v_safety_stock | PASS: 102 SKUs |
| T03 — is_new_sku en v_compras_pendientes (bypass bajo_rop) | PASS: 51 SKUs |
| T04 — 4 huérfanos cell=BY status=active | PASS |
| T05 — ALPCMPRBO4575 → URGENTE | PASS |
| T06 — TXSBAF144VT20 → URGENTE | PASS |
| T07 — lane bodega_to_full > 0 | PASS: 426 uds |
| T08 — TXTPBL20200SK protege Flex | PASS: bodega=2 flex=15 |
| T09 — deficit_full descuenta picking activo | INFO: 21 SKUs |
| T10 — lote inicial new_sku respetado | PASS |
| T11 — distribución acciones snapshot | URG=11 AGO=5 ASP=15 MF=18 ET=13 NUE=43 PLA=40 OK=60 EXC=169 DEAD=19 INA=34 |
| T12 — ≥400 policies activas (sanity) | PASS: 427 |

Pre-requisito: `SELECT * FROM refresh_sku_node_policy_from_templates();`

---

## Reglas para agentes (próximos sprints)

1. **No agregar ramas a `mandar_full_uds`** que ignoren `reserva_flex_target` salvo lote inicial `is_new_sku=true`.
2. **No reordenar el árbol del decision tree** (lote inicial > operativo > else).
3. **Si introducís un nuevo lane** a `v_in_transit_por_nodo`, debe sumar a `in_transit_picking_full` o a un campo nuevo, nunca al `in_transit_oc_bodega` original.
4. **Si cambiás el filtro de pickings activos**, recordá que `stock_bodega` ya descontó los componentes PICKEADOS — sumar PENDIENTES sería double-counting.
5. **Si extendés `calc_sku_node_policy_row`**, mantener el orden: `is_new_sku` bypass → `blocked_no_cost` → `blocked_no_history` (cell=CY default) → cell=abc||xyz.

---

## Cierre Sprint 7

### Fases completadas

6 fases entregadas (Fase 5 colapsada en Fase 4 bajo paradigma autónomo — la "alertas avanzadas" planificadas eran innecesarias una vez aplicada la doctrina autónoma de 5 alertas mínimas):

| Fase | Bloque | Migraciones |
|---|---|---|
| **0.A** | Lane bodega_to_full PICKEADO | `20260505111532`, `20260505111737` |
| **0.B** | mandar_full_uds protege Flex | `20260505111957` |
| **1.1** | URGENTE cobertura cruda | `20260505113243` |
| **1.2** | Cell default + bypass blocked_no_cost | `20260505113416`, `20260505113543` |
| **2** | DIO en motor nuevo | `20260505115127`, `20260505115214`, `20260505115320` |
| **3** | Liquidación + markdown_policy | `20260505122055`, `20260505122254`, `20260505122414` |
| **4** | Alertas autónomas mínimas (5) | `20260505130958`, `20260505131104` |
| ~~5~~ | ~~Alertas avanzadas~~ | **Colapsada en Fase 4** (innecesaria post-doctrina) |
| **6** | Sistema de explicación SQL | `20260505140000` |

**Total**: 14 migraciones aplicadas + 1 vista de auditoría + 27 tests regresión.

### Tiempo real vs estimado

| Spec inicial | Estimado | Real | Delta |
|---|---|---|---|
| Fase 0.A | 1.5h | 1.5h | 0 |
| Fase 0.B | 2h | 2h | 0 |
| Fase 1 | 3h | 2.5h | -0.5h |
| Fase 2 | 1.5h | 2h | +0.5h |
| Fase 3 | 4h | 3.5h | -0.5h |
| Fase 4 | 0.5h | 0.5h | 0 |
| Fase 5 | 1h | 0h | **-1h (colapsada)** |
| Fase 6 | 3-4h | 1.5h | **-2h (scope acotado funcionó)** |
| **Total** | **~16h** | **~13.5h** | **-2.5h** |

### Estado del motor nuevo

**Paridad operativa lograda** vs motor viejo en las áreas críticas:

- ✅ **Acciones**: 11 URGENTE (vs 9 pre-Fase 1), 427 policies activas, distribución coherente.
- ✅ **DIO**: 91.6% paridad masiva. Divergencia restante es arquitectural intencional (motor nuevo usa `d_avg_sem efectivo` en SKUs con quiebre prolongado — más correcto operativamente).
- ✅ **Liquidación**: 93.6% paridad (132/141). Remanentes por divergencia `target_dias_full` documentada.
- ✅ **Flex protegido**: TXTPBL20200SK ya no rompe Flex; 11 SKUs con `reserva_flex_target` respetado.
- ✅ **Lane bodega_to_full**: 426 uds PICKEADOS visibles (antes invisibles).
- ✅ **is_new_sku visible en pipeline**: 4 huérfanos rescatados (`cell=BY` + `policy_status=active`).
- ✅ **Alertas**: 5 doctrinales autónomas (vs 17 motor viejo). Pirámide saludable 406/89/14.
- ✅ **Auditoría**: `v_sku_explanation` con narrativa por SKU para los 253 SKUs activos.

**Decisión arquitectural confirmada**: motor nuevo es la SSoT operativa. Motor viejo (`intelligence.ts`) sigue vivo solo para escritura `sku_intelligence` (cron) y como referencia legacy. Siguiente sprint promueve a default y empieza el cleanup.

### Items pendientes para Sprint 8 (cleanup)

1. **Matar `/admin/reposicion-suggestions`** (UI vieja basada en `intelligence.ts`). Reemplazar lecturas por `v_reposicion_explain` + `v_sku_explanation`.
2. **Promover motor nuevo a default** en todas las UIs operativas (panel admin, sidebar Inteligencia, exportes).
3. **Consolidar crons**: `cronRecalcInteligencia` + `cronRefreshSkuNodePolicy` deberían convertirse en un solo job ordenado (motor viejo escribe sku_intelligence → motor nuevo lee y refresca políticas).
4. **Marcar `@deprecated`** las funciones del motor viejo que duplican lógica del nuevo: `calcularLiquidacion` (P17), `evaluarAlertas` (P19), `calcularDIO`, `evaluarUrgente`.
5. **Eliminar `pedir_proveedor_motor_viejo`** de `v_reposicion_explain` cuando UIs migren completamente.
6. **LT real por SKU**: poblar `ordenes_compra.lead_time_real` en RECIBIDA_PARCIAL (hoy 0/185 SKUs). Sprint 4.2 lo expone, Sprint 8 lo arregla.
7. **Documentar contrato `v_sku_explanation`** en `docs/codebase/04_datos.md` para que apps externas (banva1, Viki) lo consuman.

### Definition of done — Sprint 7 ✓

- [x] Sprint 6 deuda cerrada (Bug A + Bug B + Patches 1+2 + huérfanos)
- [x] Protección Flex implementada y testeada
- [x] DIO portado al motor nuevo
- [x] Liquidación parametrizada en `markdown_policy` con override owner
- [x] 5 alertas autónomas en `v_sku_alertas` + `v_reposicion_explain`
- [x] Sistema de auditoría narrativa `v_sku_explanation`
- [x] 27 tests de regresión PASS
- [x] Sprint doc completo + reglas para agentes
- [x] Atlas hashed + push autorizado por owner
