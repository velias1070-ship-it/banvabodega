---
sprint: 7
title: Cerrar deuda Sprint 6 + protección Flex + DIO (Fase 0 + Fase 1 + Fase 2)
date: 2026-05-05
owner: Vicente Elías
tags: [batch:20260505-sprint-7-fase0] [batch:20260505-sprint-7-fase1] [batch:20260505-sprint-7-fase2] [sprint:7] [feature]
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
---

# Sprint 7 — Fase 0 + Fase 1

## TL;DR

Dos bloques (~9.5 h) que cierran deuda Sprint 6 + bug crítico mandar_full_uds:

| Bloque | Cambio | Impacto |
|---|---|---|
| **0.A** | Lane `bodega_to_full` lee componentes en estado `PICKEADO` (no PENDIENTE). `stock_bodega` ya descontó esos uds vía `registrar_movimiento_stock motivo='envio_full'`; ML aún no confirma como recibidos en `meli_facility`. | 426 uds en tránsito visibles al motor (antes invisibles). 21 SKUs con picking activo descontado correctamente. |
| **0.B** | `mandar_full_uds` rediseñado: nunca reduce `stock_bodega` por debajo de `reserva_flex_target`. `deficit_full` descuenta `in_transit_picking_full` para evitar double-shipping. Excepción: lote inicial `is_new_sku`. | TXTPBL20200SK (bodega=2 < flex=15) ya NO sugiere mandar Full. 11 SKUs con flex protegido. |
| **1.1** | URGENTE override por cobertura cruda: `stock_total < vel_pond_semanal` (paridad motor viejo Bug B Sprint 6). | ALPCMPRBO4575 (vel=5.97, stock=4) y TXSBAF144VT20 (vel=2.04, stock=1) → URGENTE. Motor nuevo: 11 URGENTE total. |
| **1.2** | Cell default + bypass blocked_no_cost para `is_new_sku`: SKUs nuevos sin costo/historia ABC×XYZ → `cell='BY'` + `policy_status='active'`. | 4 huérfanos (JSCNAE190P15W, JSCNAE190P20W, SPAFE30E10W26, SPAFE40O15W26) ahora visibles en `v_compras_pendientes`. |
| **2** | DIO en motor nuevo: `dio = stock_total / d_avg_dia` (centinela 999 si vel=0). Expuesto en `v_safety_stock` y `v_reposicion_explain`. | Caso testigo JSAFAB422P20S: 2.5 días paridad exacta. Paridad masiva 91.6% en SKUs con stock alineado. |

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
