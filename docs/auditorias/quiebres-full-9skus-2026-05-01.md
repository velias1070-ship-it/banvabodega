# Auditoría — 9 SKUs en Full=0 al 2026-05-01

> Análisis cronológico de cómo se vaciaron del Full y dónde está la falla
> (interna vs externa). Hecha sobre el snapshot de `sku_intelligence_history`
> y los registros de OCs / recepciones / ventas.

## TL;DR

**8 de 9 quiebres son falla nuestra.** La causa dominante es **una brecha de
33 días entre OCs activas (24-mar → 28-abr)** combinada con que el motor
v6 de `flex-full.ts` no proponía mandar al Full cuando bodega ≤ reservaFlex.
Solo 1 SKU (JSAFAB415P20W) tiene componente externo real (quiebre de Idetex).

**Y un gap de tracking grave: NO guardamos las decisiones del motor.**
`sku_intelligence_history` no almacena `mandar_full`, `pedir_proveedor`,
`pedir_proveedor_sin_rampup`. Solo guardamos el **estado** (stock, vel, abc) y
la **etiqueta** (`accion`). Eso impide auditar después qué cantidades
recomendaba el motor cada día.

## Cronología de OCs a Idetex (proveedor único de los 9 SKUs)

| OC | Emisión | Esperada | Estado | Pedidas | Recibidas | Lead time |
|----|---------|----------|--------|---------|-----------|-----------|
| OC-002 | 2026-03-18 | — | **ANULADA** | 1 543 | 0 | — |
| OC-003 | 2026-03-18 | — | **ANULADA** | 726 | 0 | — |
| OC-004 | 2026-03-24 | — | **ANULADA** | 1 016 | 0 | — |
| OC-005 | 2026-04-20 | 2026-04-23 | RECIBIDA_PARCIAL | 663 | 509 (77%) | ~3 días promedio |
| OC-006 | 2026-04-28 | 2026-05-11 | RECIBIDA_PARCIAL | 1 399 | 162 (12%) | en curso |

**Brecha crítica:** del 24-mar al 20-abr (27 días) **no hubo OC activa a
Idetex**. Las 3 OCs del 18-24 marzo se anularon (motivo no registrado en
`notas`). La siguiente OC útil recién entró el 20-abr. Para SKUs ABC=A con
cycle stock de 3-6 semanas, eso garantizaba el quiebre.

Las recepciones de Idetex en abril (folios 525*-527* en `recepciones`) **no
estaban vinculadas a OC** (`orden_compra_id IS NULL`) — eran entregas
inerciales del proveedor sin OC formal en banvabodega.

## Cronología SKU por SKU

### TXV23QLAT25GR — Quilt Atenas 25P Gris (ABC=A, ESTRELLA)

| Fecha | Full | Bodega | Vel | cob_full | Acción motor | Venta del día |
|-------|------|--------|-----|----------|--------------|---------------|
| 16-Abr | 10 | 8 | 1.53 | 57.2d | OK | — |
| 17-Abr | 10 | 6 | 2.13 | 47.0d | OK | 2 Full |
| 18-Abr | 8 | 6 | 2.82 | 28.4d | PLANIFICAR | 1 Full |
| 19-Abr | 7 | 5 | 2.78 | 25.2d | PLANIFICAR | — |
| 21-Abr | 6 | 5 | 4.07 | 14.7d | PLANIFICAR | 1 Full |
| 22-Abr | 5 | 5 | 4.67 | 10.7d | PLANIFICAR | — |
| 24-Abr | 5 | 5 | 3.49 | 14.3d | PLANIFICAR | 1 Full |
| 26-Abr | 4 | 5 | 2.59 | 11.9d | PLANIFICAR | 1 Full |
| 27-Abr | 3 | 5 | 3.19 | 7.2d | URGENTE | — |
| 29-Abr | 1 | 5 | 2.79 | 2.8d | EN_TRANSITO | 2 Full |
| 30-Abr | **0** | 5 | 3.38 | 0d | MANDAR_FULL | — |
| 01-May | 0 | 21 | 2.81 | 0d | MANDAR_FULL=14 ✅ | — (recepción 16 uds) |

**Diagnóstico:** del 18 al 28-abr el motor vio que cobertura caía de 28d a 7d
con bodega disponible (5 uds), y propuso PLANIFICAR (no MANDAR). El bug v6
calculaba `reservaFlex = ceil(4.07 × 0.3 × 6) = 8 uds` > bodega 5 →
`disponibleParaFull = 0` → no propuso mandar. **Falla 100% interna del
motor v6**, fix en commit `34c53e8`.

### JSECBQ006P20A — Sábanas EC Liso Arena (ABC=A, ESTRELLA)

| Fecha | Full | Bodega | Vel | cob_full | Acción |
|-------|------|--------|-----|----------|--------|
| 16-Abr | 4 | 2 | 2.27 | 15.4d | PLANIFICAR |
| 19-Abr | 3 | 2 | 1.77 | 14.8d | PLANIFICAR |
| 23-Abr | 2 | 2 | 1.87 | 9.4d | PLANIFICAR |
| 25-Abr | 1 | 2 | 1.96 | 4.5d | PLANIFICAR |
| 26-Abr | **0** | 2 | 2.46 | 0d | MANDAR_FULL |
| 30-Abr | 0 | 1 | 2.85 | 0d | MANDAR_FULL |
| 01-May | 0 | 9 | 2.35 | 0d | MANDAR_FULL=7 ✅ |

**Diagnóstico:** mismo patrón que TXV23QLAT25GR. Bodega 2 uds, reservaFlex
~4 uds → motor bloqueado. **Falla interna**.

### JSAFAB415P20W — Jgo Sábanas Sarah Aqua (ABC=A, ESTRELLA)

| Fecha | Full | Bodega | Vel | Acción |
|-------|------|--------|-----|--------|
| 22-Abr | 4 | 2 | 1.67 | PLANIFICAR |
| 24-Abr | 1 | 2 | 3.46 | URGENTE |
| 25-Abr | **0** | 2 | 4.06 | MANDAR_FULL |
| 28-Abr | 0 | 1 | 3.97 | MANDAR_FULL |
| 30-Abr | 0 | **0** | 3.10 | **AGOTADO_SIN_PROVEEDOR** ⚠️ |
| 01-May | 0 | 4 | 3.10 | MANDAR_FULL=2 |

**Diagnóstico:** 30-abr es el único día donde llegamos a `bodega=0 +
proveedor=0`. Es **falla mixta**:
- Interna: motor v6 no propuso mandar al Full del 22-25 abril (mismo bug).
- Externa: Idetex sin stock del SKU el 30-abr (el flag `es_quiebre_proveedor=true`
  hoy lo confirma). La OC-006 (28-abr) lo pidió pero no cubrió a tiempo.

### JSAFAB436P20W — Sábanas Campine (ABC=A en quiebre largo)

| Fecha | Full | Bodega | Acción |
|-------|------|--------|--------|
| 16-25 Abr | 0 | 0 | AGOTADO_PEDIR / EN_TRANSITO |
| 26-Abr | 3 | 0 | PLANIFICAR (llegaron 3 al Full directo) |
| 27-Abr | 2 | 0 | PLANIFICAR |
| 28-30 Abr | 1 | 0 | EN_TRANSITO |
| 01-May | 0 | 16 | MANDAR_FULL=12 ✅ (recepción 16 uds) |

**Diagnóstico:** SKU pasó **TODO marzo** sin stock (desde el 16-mar al menos).
Bodega=0 + Full=0 desde abril. La OC-005 (20-abr, 4 uds pedidas) llegó parcial.
Las 16 uds del 1-may son OC-006. **Falla compuesta:**
- OC-002/003 anuladas el 18-mar pidieron este SKU → si no se anulaban, llegaba
  a tiempo.
- OC-005 (20-abr) pidió solo 4 uds (motor estimaba `vel=1.0` por estar
  quebrado — clásico catch-22 de quiebre prolongado).

### JSAFAB435/437/439/440/441P20W — Resto de Sarah/familia

Todos del mismo proveedor (Idetex), todos en cuadrante REVISAR. Patrón:
- Marzo: quebraron por anulación de OC-002/003.
- Abril: motor osciló entre EXCESO (cuando había 2-3 uds y vel=0.1) y
  AGOTADO_PEDIR/PLANIFICAR.
- Día Madre activado el ~25-abr disparó velocidades; cobertura cayó a 0 en
  pocos días.
- 1-May llegan recepciones y motor propone mandar al Full.

## Causas raíz consolidadas

| # | Causa | Impacto | Tipo |
|---|-------|---------|------|
| 1 | OC-002, OC-003, OC-004 anuladas (mar 18-24) sin OC de reemplazo | 33d sin pipeline a Idetex | **Interno operacional** |
| 2 | Motor `flex-full.ts v6` reservaba targetFlexUds antes de `mandar_full` | 8 SKUs no recibieron MANDAR aunque tenían bodega disponible | **Interno técnico** (fixeado en commit `34c53e8`) |
| 3 | Motor solo manda al Full cuando Full=0; nunca proactivo si cob_full > 0 | SKUs llegaban a 0 antes de gatillar acción | **Interno técnico** (sin fix aún) |
| 4 | Día de la Madre infló velocidad x1.3 | Aceleró quiebre, motor reactivo no alcanzó | Externo amplificado por #3 |
| 5 | Idetex sin stock JSAFAB415 | 1 SKU 30-abr tocó cero total | **Externo** (1 caso) |
| 6 | OCs en quiebre piden cantidad muy chica (vel degradada) | OC-005 pidió 4 uds de JSAFAB436 con vel real ~2 uds/día | **Interno técnico** (catch-22 vel_pre_quiebre, parcialmente cubierto por `feedback_dual_route_sync` y rampup) |
| 7 | ABC oscilando día a día (C↔A↔B en 24h) | Inestabilidad de `target_dias_full` y `pct_full` | **Interno técnico** (memoria `project_banva_abc_xyz_state` lo documenta) |

**Nota sobre OCs anuladas:** los 3 registros tienen el mismo texto `Anulada: `
en `notas` (sin razón). No hay log de quién anuló, cuándo, ni por qué. Esto
también es un gap de auditoría.

## Gap de tracking — qué NO guardamos hoy

`sku_intelligence_history` columnas:
```
fecha, sku_origen, vel_ponderada, vel_full, vel_flex, stock_full, stock_bodega,
stock_total, cob_full, cob_total, margen_full, margen_flex, abc, cuadrante,
gmroi, dio, accion, alertas, venta_perdida_pesos, vel_objetivo, gap_vel_pct,
margen_unitario_pre_quiebre, xyz, margen_neto_30d, abc_margen, abc_ingreso,
abc_unidades, uds_30d, lead_time_usado_dias, safety_stock_completo, rop_calculado
```

**Faltan:**
- `mandar_full` ← decisión operativa diaria del motor
- `pedir_proveedor` y `pedir_proveedor_sin_rampup` ← decisión de OC
- `stock_en_transito` ← contexto de la decisión
- `factor_rampup_aplicado`, `rampup_motivo` ← qué reglas se aplicaron
- `dias_sin_stock_full`, `fecha_entrada_quiebre` ← duración del quiebre
- `oc_pendientes` ← cuántas OCs vivas tenía el SKU al momento

**Consecuencia:** no podemos hacer este análisis sin pelear con el código.
Tuvimos que reconstruir `mandar_full` mentalmente con la fórmula v6 y los
datos de `stock_full + stock_bodega + vel_ponderada`. Si la fórmula cambia
(como hoy de v6 a v7) se pierde la trazabilidad.

`admin_actions_log` tiene 4 columnas (`accion, entidad, entidad_id, detalle
jsonb`) — se podría usar pero no se está poblando con decisiones del motor,
solo con acciones manuales (envío Full por operador).

`ordenes_compra_lineas` SÍ guarda snapshot al momento de pedir
(`stock_full_al_pedir`, `stock_bodega_al_pedir`, `accion_al_pedir`,
`vel_ponderada`, `cob_total_al_pedir`, `abc`). Eso está bien — pero solo
para el momento del pedido, no día a día.

## Recomendaciones (decisiones que requieren tu visto bueno)

### Fix técnico ya hecho
- ✅ `flex-full.ts` v7 prioridad Full > Flex (commit `34c53e8`).

### Pendientes que recomiendo, en orden:

1. **Agregar columnas a `sku_intelligence_history`** (P-INV-5 nuevo en policy):
   `mandar_full`, `pedir_proveedor_sin_rampup`, `factor_rampup_aplicado`,
   `rampup_motivo`, `stock_en_transito`, `dias_sin_stock_full`,
   `fecha_entrada_quiebre`, `oc_pendientes`. Migración SQL + ajustar el
   upsert en `intelligence.ts:1583`. **Costo: chico, 30 min.**

2. **Mandar al Full proactivo cuando cobertura cae** (regla nueva en motor):
   gatillar `MANDAR_FULL` cuando `cob_full < target_dias_full × 0.4` (no
   esperar a que llegue a 0). Lo discutimos antes — falta tu OK.

3. **Razón obligatoria al anular OC**: hoy `notas` se escribe `Anulada: `
   sin texto. Forzar input no vacío en UI + log a `admin_actions_log`.
   Evita que se anulen 3 OCs grandes sin trazabilidad.

4. **Alerta cuando proveedor lleva > 14 días sin OC activa** y tiene SKUs
   ABC=A bajo target_dias_full. Hubiese gritado el 6-abr (24-mar + 13d) que
   Idetex no tenía pipeline.

5. **Estabilizar ABC**: la oscilación día-a-día C↔A es ruido (memoria
   `project_banva_abc_xyz_state` ya lo nota). Aplicar histéresis (no
   cambiar ABC si llevaba < 7 días en el cuadrante anterior, p.ej.).

¿Cuáles avanzamos hoy?
