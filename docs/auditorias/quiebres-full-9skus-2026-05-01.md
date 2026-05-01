# Auditoría — 9 SKUs en Full=0 al 2026-05-01

> Análisis cronológico de cómo se vaciaron del Full y dónde está la falla
> (interna vs externa). Hecha sobre el snapshot de `sku_intelligence_history`
> y los registros de OCs / recepciones / ventas.

## TL;DR (revisado tras descartar OCs anuladas como ruido)

Las únicas OCs reales a Idetex en este período son **OC-005 (20-abr, llegó 23-abr,
3 días LT)** y **OC-006 (28-abr, esperada 11-may, 13 días LT, en curso)**. Las
OC-002/003/004 anuladas el 18-24 mar nunca se ejecutaron y no son comparables
con un pipeline real.

**Causas reales del quiebre, en orden de impacto:**

1. **Bug v6 `flex-full.ts`** — bodega disponible no se mandaba al Full porque
   reservaFlex la consumía. Motor decía PLANIFICAR cuando debía decir MANDAR.
   ✅ fixeado en commit `34c53e8`.
2. **Catch-22 vel_pre_quiebre** — JSAFAB436 quebrado desde marzo, OC-005 le
   pidió solo 4 uds porque vel medida había caído a 1.0 (Flex residual). Lead
   time cubría 6 días → re-quiebre inmediato.
3. **OC-005 dejó fuera 8 de 9 SKUs porque ese día no estaban en alerta**. El
   motor recién los marcó AGOTADO/MANDAR/URGENTE entre 23-29 abril → entraron
   en OC-006. Esa semana de demora fue donde se vaciaron del Full.
4. **OC-005 llegó parcial: 509/663 = 77%**. Idetex no entregó 154 uds. Falla
   externa.
5. **JSAFAB415**: 30-abr `bodega=0` real, Idetex sin stock confirmado por flag
   `es_quiebre_proveedor=true`. Falla externa puntual.

**Gap de tracking grave: NO guardamos las decisiones del motor.**
`sku_intelligence_history` no almacena `mandar_full`, `pedir_proveedor`,
`pedir_proveedor_sin_rampup`, `factor_rampup_aplicado`. Solo guardamos el
**estado** (stock, vel, abc) y la **etiqueta** (`accion`). Eso impide auditar
después qué cantidades recomendaba el motor cada día. Esta auditoría tuvo que
reconstruir las decisiones aplicando la fórmula al estado.

## Pipeline real de OCs a Idetex (anuladas excluidas)

| OC | Emisión | Esperada | Real | Estado | Pedidas | Recibidas |
|----|---------|----------|------|--------|---------|-----------|
| OC-005 | 2026-04-20 | 2026-04-23 (3d) | parcial 22-23 abr | RECIBIDA_PARCIAL | 663 | 509 (77%) |
| OC-006 | 2026-04-28 | 2026-05-11 (13d) | en curso | RECIBIDA_PARCIAL | 1 399 | 162 (12%) |

**Tiempo de respuesta humano (alerta motor → emisión OC):**

| SKU | Primera alerta | OC | Días alerta→OC |
|-----|----------------|----|----------------:|
| TXV23QLAT25GR | 27-Abr URGENTE | OC-006 28-Abr | **1d** ✅ |
| JSECBQ006P20A | 26-Abr MANDAR_FULL | OC-006 | 2d ✅ |
| JSAFAB440P20W | 26-Abr | OC-006 | 2d ✅ |
| JSAFAB415P20W | 24-Abr URGENTE | OC-006 | 4d ✅ |
| JSAFAB436P20W | 16-Abr AGOTADO_PEDIR | OC-005 20-Abr | 4d ✅ |
| JSAFAB441P20W | 23-Abr | OC-006 | 5d ⚠️ |
| JSAFAB437P20W | 16-Abr AGOTADO_PEDIR | OC-006 28-Abr | **12d** ❌ |
| JSAFAB435/439 | 29-Abr | OC-006 | -1d (preemptiva) ✅ |

**Falla específica: JSAFAB437P20W estuvo 12 días en AGOTADO_PEDIR antes de
entrar a OC.** Se quedó fuera de OC-005 a pesar de estar en el mismo estado
que JSAFAB436 (que sí entró). Hipótesis: vel reportada=0.19 (ruido por
quiebre prolongado) lo dejó debajo del umbral de pedido al armar OC-005.

**Falla por cantidad: OC-005 pidió solo 4 uds de JSAFAB436P20W** con demanda
real ~2/día y LT 3d. Cubrió 6 días, después re-quebró. Causa: vel_pre_quiebre
no estaba poblada cuando se armó OC-005 (la regla rampup del intelligence
recién se aplicó después).

**Falla externa: OC-005 entregó 77%.** Las 154 uds faltantes son
responsabilidad de Idetex, no del WMS.

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

**Diagnóstico:** SKU venía quebrado desde marzo (no tenemos histórico antes
del 16-abr para confirmar inicio exacto). OC-005 (20-abr, 4 uds, recibidas
4) cubrió 6 días de demanda. Re-quebró. OC-006 ya pidió 16 uds.
**Falla:** cantidad pedida en OC-005 muy chica por vel degradada
(catch-22 vel_pre_quiebre). El humano pidió correctamente lo que el motor
recomendó; el motor recomendó mal.

### JSAFAB435/437/439/440/441P20W — Resto de Sarah/familia

Todos del mismo proveedor (Idetex), todos en cuadrante REVISAR. Patrón:
- Antes del 16-abr: sin histórico (probablemente OK).
- 16-22 abr: oscilación EXCESO/PLANIFICAR con vel reportada muy baja
  (0.1-0.5) por venta esporádica.
- 23-29 abr: cobertura cayó a 0; motor pasó a AGOTADO_PEDIR / MANDAR_FULL.
  Día de la Madre activado el ~25-abr disparó velocidades x1.3.
- **JSAFAB437 caso especial**: 12 días en AGOTADO_PEDIR antes de entrar a
  OC. Quedó fuera de OC-005 a pesar de estar en el mismo estado que
  JSAFAB436. Razón probable: vel=0.19 lo dejó debajo del umbral de pedido.
- 28-abr: OC-006 los cubre a todos.
- 1-May: recepción + motor propone MANDAR_FULL.

## Causas raíz consolidadas (revisadas)

| # | Causa | Impacto | Tipo |
|---|-------|---------|------|
| 1 | Motor `flex-full.ts v6` reservaba targetFlexUds antes de `mandar_full` | Bodega disponible no se mandaba al Full → Full se vaciaba | **Interno técnico** (fixeado en commit `34c53e8`) |
| 2 | Catch-22 `vel_pre_quiebre`: SKU quebrado → vel medida cae → OC pide poco → re-quiebra | OC-005 pidió 4 uds de JSAFAB436 con demanda real ~2/día | **Interno técnico** (parcialmente cubierto por rampup PR #261-264, pero JSAFAB436 no lo recibió en OC-005) |
| 3 | JSAFAB437P20W quedó fuera de OC-005 a pesar de estar AGOTADO_PEDIR junto a JSAFAB436 | 12 días en quiebre antes de OC-006 | **Interno técnico** (umbral de pedido cuando vel reportada < 0.2) |
| 4 | Motor solo gatilla MANDAR_FULL cuando Full=0; no es proactivo con cob bajando | SKUs caían 5→4→3→2→1→0 sin acción intermedia | **Interno técnico** (sin fix aún) |
| 5 | Día de la Madre infló velocidad x1.3 | Aceleró quiebre desde 25-abr | **Externo amplificado por #4** |
| 6 | OC-005 entregó 77% (Idetex 154 uds short) | Algunos SKUs llegaron menos uds de lo esperado | **Externo** (Idetex) |
| 7 | JSAFAB415: 30-abr Idetex sin stock confirmado | 1 SKU 30-abr `bodega=0 + proveedor=0` | **Externo** (1 caso, 1 día) |
| 8 | ABC oscilando día a día (C↔A↔B en 24h) | Inestabilidad de `target_dias_full` y `pct_full` | **Interno técnico** (memoria `project_banva_abc_xyz_state` lo documenta) |

**Nota sobre OCs anuladas (OC-002/003/004 mar-18/24):** Vicente confirma que
no se cuentan como pipeline real — nunca se ejecutaron. Probablemente fueron
borradores armados desde inteligencia que se descartaron. El cálculo del
"tiempo sin OC" parte desde la primera OC real (OC-005 20-abr).

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
