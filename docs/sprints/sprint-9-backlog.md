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

## Tags de cierre Sprint 9

- `[milestone:sprint-9-cell-sync-canon]` — sync cell_efectiva canónico
- `[hotfix:cz-alta-vel]` — template CZ con vel real
- `[hotfix:ui-cell-render]` — render columna ABC + badges
