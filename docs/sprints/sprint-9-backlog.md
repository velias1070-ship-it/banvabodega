---
sprint: 9
title: Cierre del sync cell_efectiva ↔ visibilidad + alertas operativas perdidas
status: backlog
date: 2026-05-05
owner: Vicente Elías
tags: [sprint:9] [milestone:sprint-9-cell-sync-canon] [audit:post-sprint-8.5]
related:
  - docs/sprints/sprint-8.5-fix-ui.md
  - docs/policies/motor-canonico.md
  - .claude/rules/inventory-policy.md
---

# Sprint 9 — Cierre del sync cell_efectiva ↔ visibilidad

## Resumen ejecutivo

Auditoría post Sprint 8.5 detectó tres gaps materiales en el motor nuevo:

1. **Gap 1 (urgente operativo financiero)** — Trend detection actualiza `cell_efectiva`
   pero no reconcilia `snp.action`. Resultado: SKUs degradados siguen comprables
   bajo política de la celda original. **$667.776 CLP verificados en compras
   sobre 7 SKUs degradados en últimos 30d** (proyección $8M–$15M anuales si
   la cadencia se mantiene). Pieza más grave del estado actual.

2. **Gap 2 (segunda prioridad operativa)** — 8 SKUs cell=CZ con vel ≥1/sem
   invisibles en motor nuevo. Incluye 4 SKUs en `AGOTADO_SIN_PROVEEDOR`
   con vel ~1.27–1.7/sem que el motor viejo grita y el nuevo silencia.

3. **Gap 3 (cosmético)** — Render de columna ABC y badges de tendencia
   pendientes del Sprint 8.5 v1.

Cerrados:
- Gap is_new_sku (62 SKUs originales → 2 outliers residuales legítimos)
- Sprint 8.5 v1: cob_full 99.5% paridad, full_dispatch, UI leaks principales

## Estado del motor post Sprint 8.5

| Métrica | Valor |
|---|---:|
| SKUs visibles en motor nuevo | 281 |
| SKUs en motor viejo | 509 |
| Cobertura motor nuevo | 55% |
| SKUs operativamente útiles invisibles | ~30 (Gap 2) |
| SKUs degradados aún comprables | 176 (Gap 1) |
| OCs últimos 30d sobre degradados | 2 (OC-005, OC-006) |
| CLP comprometido en sobrecompras 30d | $667.776 |

Datos numéricos llegan al backend correctamente para los visibles.
La UI muestra `cuadrante` (motor viejo) en columna ABC y no renderiza
badges de promoción/degradación aunque el motor los calcula.

## Paso 0 — Decisión owner sobre OC-005/OC-006 antes de Sprint 9

OC-005 (20-abr) y OC-006 (28-abr) tienen líneas sobre SKUs JSAFAB
degradados. Ambas RECIBIDA_PARCIAL — hay ventana parcial.

**Daño consumado** (líneas ya recibidas con degradación BY→CZ, 2 grados):

| SKU | OC | Uds recibidas | CLP |
|---|---|---:|---:|
| JSAFAB432P20S (CY→CZ) | OC-006 | 4 | $44.000 |
| JSAFAB435P20W (BY→CZ) | OC-006 | 4 | $44.000 |
| JSAFAB437P15W (BY→CZ) | OC-005 | 6 | $88.776 |
| JSAFAB440P20W (BY→CZ) | OC-006 | 8 | $88.000 |
| JSAFAB441P20W (BY→CZ) | OC-006 | 10 | $110.000 |
| **Total recibido (degradación severa)** | | **32 uds** | **$374.776** |

**Ventana rescatable** (líneas pendientes, anulables o renegociables
con proveedor):

| SKU | OC | Uds pendientes | CLP rescatable |
|---|---|---:|---:|
| JSAFAB437P20W (BY→CZ) | OC-006 | 5 | $55.000 |
| JSAFAB440P15W (BY→BZ, leve) | OC-006 | 12 | $114.000 |
| **Total rescatable** | | **17 uds** | **$169.000** |

**Daño leve** (BY→BZ, 1 grado de degradación, recibido):
36 uds en 4 SKUs (436, 438, 439, 440P20W) ≈ $308.000 — operativamente
defendible si vel se sostiene; revisar caso por caso.

**Decisión owner requerida antes de Sprint 9**:
- (a) Coordinar con proveedor para anular las 17 uds pendientes ($169K
  rescatable) — reduce inventario muerto futuro.
- (b) Recibir todo, asumir el costo, y apostar a que vel se recupere.
- (c) Caso por caso: anular JSAFAB437P20W (degradación severa BY→CZ,
  $55K) y recibir JSAFAB440P15W (degradación leve BY→BZ, $114K).

Sprint 9 técnico arranca en paralelo. Decisión OC-005/OC-006 corre por
carril separado con timing propio del owner (ventana proveedor ≈ 24–48h
antes de despacho). El bug del sync es independiente; el daño consumado
ya pasó y el rescatable depende del proveedor, no del backend.

## Prioridad 1 — Gap 1: sync cell_efectiva ↔ snp.action

### Problema

`calc_sku_node_policy_row` lee `snp.cell` (no `cell_efectiva`) cuando
computa template+action. Quien actualiza `cell_efectiva` (cron de trend
detection, Sprint 4.3b) no dispara reconciliación de `action`. Resultado:

- **Promociones rotas**: 8–10 SKUs con cell_efectiva mejor pero invisibles
  (action sigue `no_reorder`). Ej: TXSB144IUN15P (CZ→BZ, vel 0.86),
  AFCFD380X120R (CZ→BZ, vel 0.19), ALPCMPRCA4060 (CZ→CY, vel 0.43).
- **Degradaciones rotas**: 176 SKUs con cell_efectiva peor pero
  comprables (action sigue `reorder_normal`/`reorder_periodic`). Ej:
  JSAFAB433P10W (BY→CZ), JSAFAB437P20W (BY→CZ — caso de OC-006).

Las degradaciones rotas son más graves: $667K en compras stale en 30d.

### Opciones evaluadas

**(a) RPC cambia a `COALESCE(cell_efectiva, cell)` cuando computa template**

Mantiene `snp.action` como fuente de verdad. Requiere que el cron de
trend detection dispare `refresh_sku_node_policy_from_templates` después
de cambiar `cell_efectiva`. Más mecanismos en movimiento. Riesgo de
desfase si los crons no se ordenan.

**(d) `v_safety_stock` filtra por `pt.action` resolviendo `cell_efectiva`
en JOIN — VOTO**

```sql
LEFT JOIN policy_templates pt
  ON pt.cell = COALESCE(snp.cell_efectiva, snp.cell)
WHERE pt.action <> 'no_reorder' OR snp.is_new_sku = true
```

Ventajas:
- Elimina el problema de sincronización a nivel arquitectónico.
- `snp.action` queda como cache informativo (auditable, no autoritativo).
- Trend cambia `cell_efectiva` mañana → vista lo refleja al instante.
- Cero estado mutable que mantener.

Desventajas:
- `snp.action` deja de ser fuente de verdad. Documentar como
  `snp.action_persisted` o renombrar.
- Cualquier código aplicación que lea `snp.action` directo queda stale
  (grep necesario antes de mergear).

### Trabajo

1. Migración: reescribir cláusula final de `v_safety_stock` con JOIN a
   `policy_templates` resolviendo `cell_efectiva`.
2. Grep `snp.action` en `src/`, decidir si renombrar columna o agregar
   comentario en SQL.
3. Verificar que `v_compras_pendientes` no quede con doble filtro (ya
   filtra por `policy_action` indirectamente vía `v_safety_stock`).

### Casos testigo

- **Promovido invisible** debe pasar a visible: TXSB144IUN15P, ALPCMPRCA4060
- **Degradado comprable** debe pasar a no comprable: JSAFAB437P20W,
  JSAFAB433P10W, JSAFAB441P20W

### Tests de regresión (invariantes del sync)

```sql
-- Test 1: SKUs degradados NO deben aparecer comprables
SELECT COUNT(*) FROM v_compras_pendientes vcp
JOIN sku_node_policy snp ON snp.sku_origen = vcp.sku_origen
WHERE substring(snp.cell_efectiva,1,1) > substring(snp.cell,1,1)
  AND vcp.qty_a_comprar > 0;
-- Expected: 0

-- Test 2: SKUs promovidos deben ser visibles
SELECT COUNT(*) FROM sku_node_policy snp
LEFT JOIN v_safety_stock vss ON vss.sku_origen = snp.sku_origen
WHERE substring(snp.cell_efectiva,1,1) < substring(snp.cell,1,1)
  AND vss.sku_origen IS NULL;
-- Expected: 0
```

Pin a 0. Si en el futuro el trend degrada/promueve un SKU y el sync se
rompe, los tests fallan inmediatamente.

### Cierre P1 (2026-05-05, commit 58d17f2)

Aplicado en migración `20260505190000_sprint9_p1_v_safety_stock_resolve_cell_efectiva.sql`:

- `v_safety_stock.politica_efectiva` resuelve `action`/`z_value`/`target_dias_full` vía
  `policy_templates` por `COALESCE(snp.cell_efectiva, snp.cell)`.
- `v_compras_pendientes` agrega CTE `pol_efectiva_compras` + filtro
  `WHERE action_efectiva <> 'no_reorder'` para garantizar T28 incluso
  cuando `is_new_sku=true` rescata visibilidad en `v_safety_stock`.
- T28: 24 → 0 PASS · T29: 4 → 0 PASS.
- 4 casos testigo verificados (TXSB144IUN15P, ALPCMPRCA4060 visibles;
  JSAFAB437P20W, JSAFAB433P10W invisibles en compras).
- `docs/policies/motor-canonico.md` P-MOT-1 declara
  `policy_templates.action` resuelto vía `cell_efectiva` como SSoT.

### Sub-issue P1.5 — Rescate is_new_sku para SKUs degradados

**Problema detectado durante validación P1:** la condición Sprint 8.5 P2
`is_new_sku := dias_de_vida<60 AND uds_90d<15` activa el rescate en SKUs
que NO son nuevos (191 días de vida) pero vendieron poco últimamente.
Si además el trend los degrada, el motor les da lote inicial — comportamiento
opuesto al deseado (lote inicial es para acelerar SKUs con poca data, no
para los que están perdiendo velocidad).

Caso testigo: `JSAFAB437P20W` (191 días, BY→CZ degradado) entra en
`v_safety_stock` por `is_new_sku=true` y recibiría lote inicial vía
`mandar_full_uds` (rama de `is_new_sku=true AND stock_full=0 AND stock_bodega>0`).
P1 hace que NO aparezca en `v_compras_pendientes` (filtro action_efectiva).
Pero queda visible en panel y la rama `mandar_full_uds` puede activarse.

**Regla propuesta:**
```
is_new_sku := dias_de_vida < 60
              AND uds_90d < 15
              AND substring(cell_efectiva,1,1) <= substring(cell,1,1)
```
(o equivalente: `cell_efectiva NOT WORSE THAN cell`).

**No bloqueante de Sprint 9 P1.** Abrir como sub-issue para resolver
post-validación 24h en producción. Probable migración:
`refresh_sku_node_policy_from_templates` o `calc_sku_node_policy_row`.

### Sub-issue P1.6 — Trend detector con confianza estadística mínima

**Detectado mientras Vicente validaba P1 con caso testigo `JSAFAB437P20W`:**

```
Edad: 33 días (NUEVO, is_new_sku=true)
Quiebre: 11 días (es_quiebre_proveedor=true)
Vel pre-quiebre: 1.03/sem (era B)
Últimos 28d: 2 ventas en 18 días con stock disponibles
Vel actual: 0.78/sem (ajustada por exposure)
cell_efectiva: BY → CZ (degradado por trend detector)
```

**Problema:** el trend detector degrada `cell_efectiva` mirando velocidad
absoluta + ratios. Pero NO pondera confianza estadística: con 2 ventas
en 18 días un par de órdenes más vuelven al SKU a B. La degradación
está al borde del ruido.

**Impacto operativo:** SKU nuevo + quiebre + venta marginal cae a
no_reorder. Vicente lo deja agotar y NO lo recompra → SKU se
descontinúa por inercia, aún cuando puede ser un winner futuro.

**Regla propuesta:**
```
Bloquear degradación de cell_efectiva si:
  (uds_28d < N_min  OR  dias_stock_recent < X_dias)
  AND (es SKU nuevo OR viene de quiebre reciente)
```
Valores tentativos: N_min=10, X_dias=20. Calibrar contra fixture.

**Dimensión adicional:** considerar usar `vel_pre_quiebre` como floor
de la cell_efectiva durante los primeros 30 días post-quiebre.

**No bloqueante de Sprint 9 P1.** Abrir como sub-issue separado
porque toca lógica de `v_trend_detection`, no de
`refresh_trend_in_sku_node_policy` (que es lo que P1.5 propone).

### Sub-issue P1.7 — `vel_drift_high` no gatilla acción operativa

**Detectado durante validación P1 con caso `XYCMN405` "Botella Kit Niña Manualidades" (Container):**

```
vel_real_sem:           4.90  (últimos 30d real, 21 uds en 21 órdenes)
vel_decl_sem:           3.23  (declarada motor viejo, ponderada)
vel_drift_pct:         +51.7%  drift_high
stock_bodega:           0      ⚠️
stock_full:             28
es_quiebre_proveedor:   true
vel_pre_quiebre:        0     (otro gap: memoria pre-quiebre se perdió)
qty_a_comprar:          0     (motor dice "stock_total 28 > objetivo 26")
```

**Problema:** el motor calcula `vel_drift_pct` y lo etiqueta `drift_high`,
pero **NO usa esa señal para nada operativo**. La columna queda solo
informativa en el panel "Explicar SKU". El cálculo de targets sigue
confiando ciegamente en `vel_decl_sem`.

**Resultado:** SKU con vel real +51% que la declarada, bodega en 0,
quiebre proveedor activo, y el motor lo deja pasar silenciosamente.

**Regla propuesta:**
```
Si vel_drift_status = 'drift_high'
   AND vel_real_sem > vel_decl_sem
   AND (stock_bodega = 0 OR es_quiebre_proveedor = true)
THEN
  - Generar alerta visible en panel
  - O recalcular targets con vel_real (opt-in)
  - O al menos forzar inclusión en lista de revisión
```

Caso testigo: `XYCMN405` debería aparecer en pedido a proveedor con
qty ~13 (calculado con vel real). Hoy queda invisible por confiar
en vel declarada.

**No bloqueante.** Toca el cálculo en `sku_intelligence` (motor viejo)
o agrega CTE en `v_safety_stock` para usar `vel_real_sem` cuando
drift_high.

### Sub-issue P1.8 — `in_transit_picking_full` no cuenta picking PENDIENTE

**Detectado durante validación P1, 2026-05-06:**

Picking session `5ef84040-657d-4b71-9c5c-fa574589fb61` creado por owner
con 41 componentes, todos en estado `PENDIENTE` (recién creado, sin
escanear). `v_in_transit_por_nodo` filtra `componente.estado = 'PICKEADO'`,
así que **el motor no ve esas 41 líneas como "en tránsito"**.

**Impacto operativo:** mientras el picking esté entre creado y completado
(1-3 días en operación normal), el motor calcula con stock desactualizado:

- `stock_bodega` todavía incluye uds que están "comprometidas" al picking
  (no se descontaron físicamente).
- `in_transit_picking_full` = 0 → motor cree que no hay nada en camino a Full.
- `stock_full` actual (sin las uds del picking) → motor sugiere mandar
  más a Full.

**Caso testigo más claro:** `LITAF400G4PNG` (Toallas Naranja) tiene 16 uds
en picking pendiente; motor sugiere mandar +19 más a Full. Si owner
confirma, terminás con 35 uds en tránsito cuando probablemente alcanzaba
con las 16 originales.

**Análisis correcto del scope (revisión 2026-05-06):** la primera versión
de este sub-issue proponía ampliar `v_in_transit_por_nodo` a
`estado IN ('PENDIENTE', 'PICKEADO')`. **Esa propuesta es incorrecta** —
causa double counting que rompe `qty_a_comprar`.

Razón del double counting: en estado PENDIENTE, las uds **siguen físicamente
en `stock` table** (no se ejecutó `registrar_movimiento_stock` aún). Si las
sumamos también a `in_transit_total`:

```
qty_raw = stock_objetivo − stock_total − in_transit_total
                          (incluye uds)   (incluye uds)
                              ↑               ↑
                          double count, sub-pedido al proveedor
```

`stock_total + in_transit_total` se mantiene constante durante PENDIENTE →
PICKEADO → COMPLETADA, por eso `qty_a_comprar` ya está bien calculado en
cualquier estado. No tocar.

**Solución correcta:** columna nueva `qty_picking_pendiente_full` que
**se descuenta de AMBOS sub-cálculos** (`deficit_full` y
`disponible_para_full`), NO se suma a `in_transit_total` ni a
`stock_total`. Razón de aplicarlo en ambos:

- `deficit_full` mide "cuánto falta a Full". Un picking PENDIENTE ya
  está cubriendo parte de ese gap → si no se descuenta, el motor
  sigue calculando déficit como si nada estuviera por llegar.
- `disponible_para_full` mide "cuánto puedo sacar de bodega". Un
  picking PENDIENTE ya está comprometido → si no se descuenta,
  el motor cree que tiene más bodega libre de la real.

Aplicarlo solo en `disponible_para_full` no resuelve el caso testigo
porque el bottleneck del `LEAST` sigue siendo el `deficit_full` no
ajustado.

```sql
WITH picking_pendiente AS (
  SELECT
    UPPER(TRIM(comp.value->>'skuOrigen')) AS sku_origen,
    SUM((comp.value->>'unidades')::int) AS qty_picking_pendiente_full
  FROM picking_sessions ps,
       jsonb_array_elements(ps.lineas) linea(value),
       jsonb_array_elements(linea.value->'componentes') comp(value)
  WHERE ps.tipo = 'envio_full'
    AND ps.estado IN ('ABIERTA', 'EN_PROCESO')
    AND comp.value->>'estado' = 'PENDIENTE'
  GROUP BY UPPER(TRIM(comp.value->>'skuOrigen'))
)
-- En v_compras_pendientes (cambios en AMBOS):
deficit_full = GREATEST(0, pre_full_target
                          - stock_full
                          - in_transit_picking_full
                          - COALESCE(pp.qty_picking_pendiente_full, 0))

disponible_para_full = GREATEST(0, stock_bodega
                                  - reserva_flex_target
                                  - COALESCE(pp.qty_picking_pendiente_full, 0))

mandar_full_uds = LEAST(deficit_full, disponible_para_full)
```

`qty_a_comprar` queda intacto. Solo `mandar_full_uds` deja de ser ciego.

**Caso testigo verificado numéricamente con LITAF400G4PNG (Toallas A.Family Negro):**

```
Datos crudos hoy:
  pre_full_target:           77
  stock_full:                58
  in_transit_picking_full:    0
  qty_picking_pendiente_full:16
  stock_bodega:              46
  reserva_flex_target:       13

Sin fix (hoy):
  deficit_full        = 77 - 58 - 0     = 19
  disponible_para_full = 46 - 13        = 33
  mandar_full_uds     = LEAST(19, 33)   = 19  ⚠️ overshoot

Fix incompleto (solo disponible_para_full):
  deficit_full        = 19  (sin cambio)
  disponible_para_full = 46 - 13 - 16   = 17
  mandar_full_uds     = LEAST(19, 17)   = 17  ⚠️ insuficiente

Fix doble (correcto):
  deficit_full        = 77 - 58 - 0 - 16 = 3
  disponible_para_full = 46 - 13 - 16    = 17
  mandar_full_uds     = LEAST(3, 17)     = 3   ✅
```

**Verificación invariante:** total que llega a Full = 16 (picking) + 3
(nuevo) = 19 uds → stock_full final = 58+19 = 77 = pre_full_target.
Cero overshoot, exactamente al target.

**Test invariante T30 (`tests/sql/regression_sprint9_picking_pendiente.sql`):**

```sql
-- T30: con picking PENDIENTE, mandar_full + ya_comprometido
-- nunca debe exceder el deficit pre-pickeo
SELECT COUNT(*) AS skus_overshoot_picking_pendiente
FROM v_compras_pendientes vcp
WHERE qty_picking_pendiente_full > 0
  AND (mandar_full_uds + qty_picking_pendiente_full)
      > GREATEST(0, pre_full_target - stock_full);
-- Expected: 0 post-fix
-- Pre-fix: ≥1 (caso LITAF400G4PNG: 19+16=35 > 19, FAIL)
```

**Alternativa UI (sin migración SQL):** badge en columna MANDAR cuando
hay picking activo del mismo SKU pendiente, indicando "ya hay X uds
en picking, vas a mandar +Y más". Decisión queda en el owner.

**No bloqueante.** Toca `v_compras_pendientes` (agregar CTE
`picking_pendiente` + ajuste en AMBOS sub-cálculos
`deficit_full` y `disponible_para_full`). Riesgo bajo, scope acotado.

### Sub-issue P2.bis-followup — Rule 0 INACTIVO antes de Rule 1 URGENTE

**Detectado 2026-05-06 post-fix P2.bis.** Sprint 10, no bloqueante.

**Síntoma:** 8 SKUs antes en `accion='INACTIVO'` (motor viejo:
`vel=0 + velPreQuiebre=0 + stock_total=0`) ahora caen en `NUEVO`
(`is_new_sku=true` heurística amplia) o `EXCESO` (`dio>60`). Las 10
reglas P2.bis no incluyen INACTIVO — pierde el filtro operativo
"skus muertos" en `/admin Inteligencia`.

**Propuesta:** agregar Rule 0 antes de Rule 1 URGENTE:

```sql
-- Rule 0: INACTIVO — sin venta + sin stock + sin movimiento
WHEN COALESCE(vsf.d_avg_dia, 0::numeric) = 0::numeric
  AND COALESCE(stock_total, 0::numeric) = 0::numeric
  AND COALESCE(uds_180d, 0::numeric) = 0::numeric
  AND NOT COALESCE(vcp.is_new_sku, false)
  THEN 'INACTIVO'::text
```

**Caso testigo:** los 8 SKUs originales en INACTIVO pre-P2.bis
(capturar lista en query antes de moverlos para snapshot).

**Estimado:** ~5 LOC en `v_reposicion_explain` (override en CASE
expression). No requiere migración nueva — recreación de la view.

**Cuándo:** Sprint 10 o post-validación P2.bis 24h.

## Prioridad 2 — Gap 2: política CZ + alertas operativas

### Problema

Template CZ tiene `action='no_reorder'`. SKUs con cell=CZ que SÍ tienen
velocidad real quedan invisibles en motor nuevo. 4 de ellos están en
`AGOTADO_SIN_PROVEEDOR` y el motor viejo los grita pero el nuevo los
silencia.

### Universo CZ (verificado)

| Banda | SKUs | vel avg | con alerta crítica |
|---|---:|---:|---:|
| CZ_muy_alta (≥1.5) | 2 | 1.69 | 2 |
| CZ_alta (1.0–1.5) | 6 | 1.19 | 1 |
| **Subtotal ≥1/sem** | **8** | | **3** |
| CZ_media (0.5–1.0) | 17 | 0.72 | 4 |
| CZ_baja (>0) | 56 | 0.14 | 6 |
| CZ_cero | 63 | 0.00 | 3 |

8 SKUs ≥1/sem confirma que crear 1 template específico vale
(<20 SKUs, criterio satisfecho). 25 SKUs si se baja a CZ_media.

### Decisión

Crear template `CZ_alta_vel` con `action='reorder_minimo'`,
`target_dias_full=20`, aplicable cuando `cell='CZ' AND vel_ponderada >= 1`.

Implementación: nueva fila en `policy_templates` y branch en
`calc_sku_node_policy_row` que usa esta cell cuando la condición se
cumple. No requiere cambio de XYZ classifier.

### Casos testigo

- TEXCCWTILL10P (vel 1.7, AGOTADO_SIN_PROVEEDOR) → debe ser visible.
- JSAFAB400P20X (vel 1.27, AGOTADO_SIN_PROVEEDOR) → debe ser visible.
- TXV23QLAT20NG (vel 1.67, AGOTADO_SIN_PROVEEDOR) → debe ser visible.

### Trabajo

1. Migración: insertar fila `policy_templates` para `CZ_alta_vel`.
2. Migración: extender `calc_sku_node_policy_row` para asignar la cell
   nueva cuando aplica.
3. Refresh `sku_node_policy`.
4. Validar tres casos testigo aparecen en `v_reposicion_explain`.

### Coordinación con Prioridad 1

Si Prioridad 1 implementa opción (d) — vista resuelve `cell_efectiva` en
JOIN —, Prioridad 2 se simplifica: basta con que el RPC asigne
`cell_efectiva = 'CZ_alta_vel'` cuando `cell='CZ' AND vel_ponderada >= 1`.
La vista ya lo respeta automáticamente y `policy_templates` resuelve
action via JOIN. No requiere cambio adicional en `v_safety_stock`.

Implicación: una sola fuente de verdad sobre por qué cambia `cell_efectiva`
(trend detection o velocidad real sobre CZ). Si ambas razones aplican
simultáneamente, la más conservadora gana (más volumen → cell mejor).

Si Prioridad 1 termina siendo (a), Prioridad 2 sí necesita branch propio
en el RPC. Por eso conviene cerrar Prioridad 1 antes de Prioridad 2.

## Prioridad 3 — Gap 4: render UI cosmético

### Pendiente del Sprint 8.5 v1

- Columna ABC en tabla principal: muestra `cuadrante` (motor viejo) en
  vez de `cell_efectiva` (motor nuevo). Tooltip con `cell_original`
  cuando difieran.
- Badge `↗ acelerando` / `↘ desacelerando` / `↻ recuperación` cuando
  `tendencia` lo amerite.
- Verificación cross-component: `admin/page.tsx:11391` y `:7666`
  ya cubiertos por Sprint 8.5 v1, pero confirmar con grep final que
  no quedó ningún `si.mandar_full` (legacy) sin convertir a
  `mandar_full_uds`.

### Trabajo

1 PR, ~30 min. Bajo riesgo, alto impacto en percepción.

## Cerrados

- **Gap 3 (is_new_sku)**: 62 → 2 outliers legítimos. Hotfix
  `34aacdb` (`hotfix/is-new-sku-gap`) cambió condición a `uds_90d<15`.
- **Sprint 8.5 v1**:
  - cob_full restored, 99.5% paridad (`hotfix/cob-full-restored`)
  - is_new_sku relax (`hotfix/is-new-sku-gap`)
  - full_dispatch fix (`hotfix/full-dispatch-gap`)
  - UI leaks principales (mandar_full_uds, accion, alertas, dio,
    in_transit_picking_full vía SQL aliases)

## Resumen del trabajo (estimación owner)

| # | Tarea | Estimado | Riesgo |
|---|---|---|---|
| 0 | Decisión OC-005/OC-006 + query familia JSAFAB pre-Sprint | owner: ~30 min (WhatsApp proveedor + decisión interna sobre 17 uds rescatables) | 0 |
| 1 | Migration: v_safety_stock con JOIN cell_efectiva (opción d) | 1–2h con tests | medio (vista crítica) |
| 2 | Migration: template CZ_alta_vel + branch calc_row | 1h | bajo |
| 3 | UI: columna ABC, badges tendencia, verificación grep | 30 min | bajo |
| 4 | Tests regresión: 4 casos testigo + 2 invariantes | 1h | 0 |

Total: ~5h focales + 1h buffer arqueológico = **6h**.

El buffer cubre el grep cross-repo de `snp.action` directo (este repo
suele tener lecturas legacy en `agents-data.ts`, `pricing/*.ts`, etc.).
Si no aparecen, el margen queda. Si aparecen, el sprint no descalibra.

Sprint 9 cerrable en 1 sesión.

### Sub-issue P5 — Bodega vacía con SKU activo (caso XYCMN405)

**Detectado durante validación P1, 2026-05-06:**

`XYCMN405` "Botella Kit Niña Manualidades" (Container) tiene
`stock_bodega=0`, `stock_full=28`, vendiendo 21 uds/30d (vel real
4.9/sem). El motor lo da por OK porque `stock_total (28) ≥ stock_objetivo (26)`,
pero operativamente:

- Si Full quiebra (cob ~5.7 sem) no hay buffer en Bodega para reabastecer.
- Lead time Container ~5d → ventana de quiebre 7-12 días.
- Alerta `flex_no_publicado` activa: SKU sin publicación Flex hoy.

**Causa raíz:** la fórmula `qty_raw` trata `stock_total` como **fungible
entre Bodega y Full**. No distingue:

```
Caso A: bodega=14, full=14   → motor OK
Caso B: bodega=0,  full=28   → motor OK (mismo total, peor operativamente)
```

El filtro WHERE de `v_compras_pendientes` tampoco lo captura porque las
3 ramas existentes (bajo_rop, is_new_sku, full<pre_full AND bodega>flex)
se cumplen todas falso.

**Solución (fix doble: filtro + fórmula):**

**1. Extender qty_raw** para incluir piso de Bodega:

```sql
target_bodega_minimo = reserva_flex_target + ROUND(d_avg_dia × lt_decl)
                       ↑ flex                ↑ cycle stock cubrir LT proveedor

deficit_bodega = GREATEST(0,
  target_bodega_minimo - stock_bodega - in_transit_oc_bodega)

qty_raw = GREATEST(
  stock_objetivo - stock_total - in_transit_total,    -- formula original
  deficit_bodega                                       -- nuevo: piso bodega
)
```

**2. Extender filtro WHERE** sin condición `pct_flex > 0`:

```sql
OR (stock_bodega < target_bodega_minimo
    AND uds_30d_real > 0)
```

**Doctrina del fix:** "tener stock en Bodega es para reabastecer Full
cuando se vacíe, NO solo para Flex". Aplica a todos los SKUs activos.
Si `pct_flex=0`, `reserva_flex_target=0` automáticamente, sin necesidad
de condicionar el filtro.

**Verificación numérica con XYCMN405:**

```
d_avg_dia    = 3.23/7 = 0.46
lt_decl      = 5
cycle_bodega = round(0.46 × 5) = 2
flex_target  = 2
target_bodega_minimo = 2 + 2 = 4

deficit_bodega = MAX(0, 4 - 0 - 0) = 4

qty_raw = MAX(stock_objetivo - stock_total, deficit_bodega)
       = MAX(-3, 4)
       = 4

inner_pack = 1
qty_a_comprar = 4 uds
```

**CLP estimado correcto:**
- `productos.costo_promedio` (XYCMN405) = $4.370 NETO
- 4 uds × $4.370 = **$17.480 neto**
- Con IVA (1.19): **$20.801 bruto**

`clp_estimado` en `v_compras_pendientes` usa `costo_promedio × qty`
(neto). Para reportes de gasto bruto, multiplicar por 1.19. (Mi
estimación previa de $44K era error mío, mezclé con costo de Sabana
Daloa $11K/uds.)

**Test invariante T32 (propuesto):**

```sql
-- T32: SKUs activos con bodega bajo target_bodega_minimo deben aparecer
-- en v_compras_pendientes con qty_a_comprar > 0
SELECT COUNT(*) AS skus_bodega_vacia_invisible
FROM v_safety_stock vss
JOIN sku_intelligence si ON si.sku_origen = vss.sku_origen
LEFT JOIN v_compras_pendientes vcp ON vcp.sku_origen = vss.sku_origen
WHERE vss.node_id = 'bodega_central'
  AND si.uds_30d_real > 0
  AND vss.policy_status = 'active'
  -- Bodega bajo target mínimo (cycle + flex):
  AND (SELECT qty_on_hand - COALESCE(qty_reserved, 0)
       FROM v_stock_por_nodo
       WHERE sku_origen = vss.sku_origen
         AND node_id = 'bodega_central') < (vss.reserva_flex_target + ROUND(vss.d_avg_dia × vss.lt_dias))
  AND (vcp.sku_origen IS NULL OR vcp.qty_a_comprar IS NULL OR vcp.qty_a_comprar = 0);
-- Expected post-fix: 0
-- Pre-fix: ≥1 (caso XYCMN405)
```

**No bloqueante de P1.** Toca `v_compras_pendientes` (extender CTE
`qty_calc` con `deficit_bodega` + extender WHERE final).

### Sub-issue P1.9 — `pct_flex_efectivo` cuando `flex_no_publicado` (DECISIÓN OWNER PENDIENTE)

**Detectado durante análisis P5, 2026-05-06:**

Hay contradicción de datos en SKUs con alerta `flex_no_publicado`:

```
XYCMN405:
  pct_flex = 0.2     (histórico: 20% ventas vía Flex)
  alerta   = flex_no_publicado  (HOY no se publica Flex)
```

`pct_flex` se calcula del histórico de ventas y NO se ajusta por la
publicación Flex actual. El motor lo trata como si Flex estuviera vivo,
calculando `reserva_flex_target` > 0 → cuando bodega < flex_target,
el motor pide stock para una reserva que nunca se va a usar (porque
Flex está apagado).

**Fix técnico simple:**
```sql
pct_flex_efectivo = CASE WHEN flex_no_publicado THEN 0 ELSE pct_flex END
```

**PERO la decisión es doctrinal, no técnica.** Trade-off:

**Opción A — apagar `pct_flex` cuando `flex_no_publicado`:**
- Motor se adapta al statu quo "Flex apagado".
- `reserva_flex_target = 0` para esos SKUs.
- Alerta queda vacía operativamente (no genera presión por uds reservadas).
- XYCMN405 pediría qty=2 (solo cycle_stock_bodega) en vez de qty=4.

**Opción B — mantener `pct_flex` histórico:**
- Motor reserva stock como si Flex estuviera activo.
- Alerta `flex_no_publicado` tiene "carne": uds reservadas que no se
  publican = oportunidad perdida visible.
- Presiona al owner a reactivar publicación Flex (o aceptar que
  pct_flex caiga naturalmente con el tiempo si nunca se reactiva).

**Argumentos a favor de B (mantener):**
- La alerta queda con peso real, no decorativa.
- Owner ve costo de oportunidad cada vez que mira esos SKUs.
- Reflexión forzada: "publico Flex o asumo el ajuste".

**Argumentos a favor de A (apagar):**
- Motor más coherente con la realidad operativa.
- Menos sobre-pedidos al proveedor.
- Cálculos más limpios.

**Decisión owner pendiente.** No implementar sin discusión.

**Importante para secuenciamiento:** si P1.9 se aplica ANTES que P5,
XYCMN405 quedaría con qty=2 (solo cycle_stock_bodega). Eso es
matemáticamente coherente pero operativamente perverso — el motor
coopera con el statu quo en vez de presionar a reactivar Flex.

**Recomendación:** documentar P1.9 acá pero NO implementar antes de P5
(y posiblemente nunca, si la doctrina de "alerta con peso" gana).

### Sub-issue P1.10 — Pickings COMPLETADA fantasma entre cierre y inbound ML

**Detectado durante análisis P5, 2026-05-06:**

Sesión `ae0547bc-c7e9-44c5-a815-e13e60bc2236` (Envío a Full 04-may):

```
Estado:                COMPLETADA
Lineas:                58 (49 SKUs distintos)
Componentes pickeados: 58 / 58 (100%)
Uds pickeadas:         426
Created:               2026-05-04 01:39
Completed:             2026-05-05 18:15
```

Esas 426 uds están en limbo:
- `stock_bodega` ya descontó (RPC al pickear).
- `in_transit_picking_full` = 0 (sesión COMPLETADA queda fuera del
  filtro `estado IN ('ABIERTA','EN_PROCESO')` de `v_in_transit_por_nodo`).
- `stock_full` aún puede no reflejarlas (lag inbound ML 1-3d, a veces
  más en alta demanda).

**Resultado:** durante la ventana 1-5 días post-completar y antes de
que ML reporte el inbound, las uds son **invisibles para el motor**.
Decisiones de `mandar_full_uds` y `qty_a_comprar` quedan
**subestimando inventario disponible** (tanto en Bodega como en Full).

**Doctrina actual** (Sprint 7 Fase 0.A, `v_in_transit_por_nodo`):
```sql
WHERE ps.estado IN ('ABIERTA','EN_PROCESO')
```
Asume que cuando `ps.estado = 'COMPLETADA'`, `stock_full` ya las refleja.
**Asunción incorrecta** dado el lag ML.

**Opciones de fix evaluadas:**

**(a) Extender filtro a `estado IN ('ABIERTA','EN_PROCESO','COMPLETADA')` con TTL:**

```sql
WHERE (
  ps.estado IN ('ABIERTA','EN_PROCESO')
  OR (ps.estado = 'COMPLETADA' AND ps.completed_at >= NOW() - INTERVAL '5 days')
)
```

- ✅ Simple, una línea de cambio.
- ✅ Cubre el lag típico de ML (1-3d con margen).
- ❌ TTL=5d arbitrario (calibrar contra incidencias reales).
- ❌ Falsa visibilidad si el shipment ya fue recibido pero la sesión
  no se cerró en sistema (raro, pero pasa).

**(b) Cruzar con `ml_shipments` inbound:**

```
COMPLETADA cuenta como in_transit MIENTRAS no haya shipment ML asociado
(matched por SKU + cantidad).
```

- ✅ Deriva del estado real ML, no del calendario.
- ❌ Matching complejo (shipments parciales, splits por bodega ML, IDs
  no siempre asociados al picking).
- ❌ Más superficie de bug.

**(c) Nuevo estado intermedio `RECEPCIONADO_ML`:**

Operador o cron transiciona `COMPLETADA → RECEPCIONADO_ML` cuando
detecta el inbound en `stock_full_cache`. Filtro queda
`estado IN ('ABIERTA','EN_PROCESO','COMPLETADA')` y `RECEPCIONADO_ML`
se excluye.

- ✅ Más robusto, refleja el flujo real.
- ❌ Cambia el modelo (migración, UI, app móvil de operador).
- ❌ Requiere cron de auto-transición o intervención manual.

**Recomendación:** **(a) con TTL=5d como primer fix.** Simple, atajo
inmediato. (b) o (c) como Sprint 10+ si el TTL se queda corto en
incidencias reales.

**Sección UI propuesta — "Envíos a Full"** (en `/admin` tab Inteligencia
o sub-tab nueva):

- Pickings activos (`ABIERTA` / `EN_PROCESO`) con SKUs y uds.
- Pickings `COMPLETADA` recientes (últimos 14d) con detección de
  descuadres `uds_enviadas` vs `uds_recibidas_ml`.
- Alerta cuando `COMPLETADA` lleva >5d sin reflejarse en `stock_full`
  (posible pérdida en tránsito o error en el envío).

**Casos testigo:**
- Sesión `ae0547bc` (04-may, 49 SKUs, 426 uds, completada 2026-05-05 18:15)
  → debería estar en `in_transit_picking_full` con TTL=5d hoy. Hoy
  está invisible (commit fix la haría visible inmediatamente).
- Sesión `5ef84040` (06-may, 41 SKUs, todas PENDIENTE) → ya cubierto
  por sub-issue P1.8 (picking pendiente).

**Test invariante T31 (propuesto):**

```sql
-- T31: SKUs en pickings COMPLETADA recientes (<5d) deben aparecer
-- en in_transit_picking_full hasta TTL/confirmación inbound ML
WITH completada_reciente AS (
  SELECT
    UPPER(TRIM(comp.value->>'skuOrigen')) AS sku_origen,
    SUM((comp.value->>'unidades')::int) AS uds_completadas
  FROM picking_sessions ps,
       jsonb_array_elements(ps.lineas) linea(value),
       jsonb_array_elements(linea.value->'componentes') comp(value)
  WHERE ps.tipo = 'envio_full'
    AND ps.estado = 'COMPLETADA'
    AND ps.completed_at >= NOW() - INTERVAL '5 days'
    AND comp.value->>'estado' = 'PICKEADO'
  GROUP BY UPPER(TRIM(comp.value->>'skuOrigen'))
)
SELECT COUNT(*) AS skus_completada_invisible
FROM completada_reciente cr
LEFT JOIN v_in_transit_por_nodo v ON v.sku_origen = cr.sku_origen
                                  AND v.to_node_id = 'full_ml'
WHERE COALESCE(v.qty_in_transit, 0) < cr.uds_completadas;
-- Expected post-fix: 0 (todas las COMPLETADA <5d cuentan como in_transit)
-- Pre-fix: ≥1 (caso ae0547bc, 426 uds invisibles)
```

**No bloqueante de P1.** Toca `v_in_transit_por_nodo` (una línea de
WHERE).

## Tags de cierre Sprint 9

- `[milestone:sprint-9-cell-sync-canon]` — sync cell_efectiva canónico
- `[hotfix:cz-alta-vel]` — template CZ con vel real
- `[hotfix:ui-cell-render]` — render columna ABC + badges
- `[hotfix:bodega-vacia-buffer]` — P5 fix doble qty_raw + filtro
- `[hotfix:picking-completada-ttl]` — P1.10 TTL en v_in_transit_por_nodo
- `[decision-pending:flex-no-publicado-pct]` — P1.9 decisión owner
