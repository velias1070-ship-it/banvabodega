# Policy — Motor canónico de inteligencia

> **Reglas vinculantes** sobre qué motor calcula qué. El motor nuevo es la
> fuente de verdad operativa desde Sprint 8 (2026-05-05). Esta policy
> declara, para cada dominio, **qué objeto SQL/función es la SSoT** y de
> dónde la consume el código.
>
> Si el código contradice una regla declarada acá, se corrige el código.
> Para fundamento histórico (por qué se hizo el refactor) ver
> `/docs/sprints/sprint-7.md` y `/docs/sprints/sprint-8-cleanup.md`.

## P-MOT-0 — Definiciones

- **Motor nuevo:** vistas SQL `v_safety_stock`, `v_compras_pendientes`,
  `v_reposicion_explain`, `v_sku_alertas`, `v_sku_explanation`, alimentadas
  por `sku_node_policy` (overrides) + datos crudos de `sku_intelligence` /
  `stock_full_cache` / `composicion_venta` / `ordenes_compra*` /
  `picking_sessions`.
- **Motor viejo:** `src/lib/intelligence.ts` (~2.2k LOC) + cron
  `/api/intelligence/recalcular`. Marcado `@deprecated` en Sprint 8.
- **Default operativo:** `INTEL_USE_NEW_ENGINE=true` (invertido Sprint 8
  Fase 1, 2026-05-05). Resolución: `localStorage > NEXT_PUBLIC_*` env >
  hardcoded fallback.

## P-MOT-1 — Tabla SSoT por dominio

Cada concepto de inteligencia tiene **una sola fuente de verdad** que el
código debe leer. Cualquier otra columna que comparta nombre es **cache
legacy** o **alimento** del motor nuevo, no SSoT.

| Dominio | SSoT canónica | Lectura | Notas |
|---|---|---|---|
| Acción operativa (`URGENTE`, `AGOTADO_SIN_PROVEEDOR`, `LIQUIDACION`, `MANDAR_FULL`, `PEDIR_PROVEEDOR`, `EN_TRANSITO`, `PLANIFICAR`, `NUEVO`, `EXCESO`, `OK`) | `v_reposicion_explain.accion` | `/api/intelligence/sku-venta-v2`, `AdminInteligencia.tsx` | Sprint 9 P2.bis: 10 reglas evaluadas en orden, primera que matchea gana. Desplaza `sku_intelligence.accion` (motor viejo, expuesto como `accion_motor_viejo` para auditoría). **`URGENTE` = "operativamente urgente", NO "compra disponible"**: SKUs con `vel>0 + stock=0 + tiene_stock_prov=false` caen en `URGENTE` (Rule 1) antes que `AGOTADO_SIN_PROVEEDOR` (Rule 2) — el quiebre está pasando aunque no haya proveedor. Para distinguir casos accionables, cruzar `accion='URGENTE'` con `tiene_stock_prov` o con la alerta `sin_stock_proveedor`. |
| Cobertura Full (`cob_full`) | `v_reposicion_explain.cob_full` | mismo endpoint | Calculada con `d_avg_sem` efectivo (rampup-aware). |
| Velocidad efectiva (`d_avg_sem`) | `v_safety_stock.d_avg_sem` | vistas downstream | Aplica `factor_rampup_aplicado` y `vel_pre_quiebre` cuando `dias_en_quiebre >= 14`. Ver `feedback_velocidad_efectiva`. |
| Safety stock (`safety_stock_uds`) | `v_safety_stock.safety_stock_uds` | `v_compras_pendientes`, `v_reposicion_explain` | King method por ABC×XYZ. |
| Punto de reorden (`reorder_point`) | `v_safety_stock.reorder_point` | `v_reposicion_explain` | `safety + d_avg_sem × lead_time/7`. |
| Cantidad a comprar (`qty_a_comprar`) | `v_compras_pendientes.qty_a_comprar` | UI compras + `accion` derivada | Considera `stock_total_efectivo` (incluye `in_transit_picking_full`). |
| Mandar a Full (`mandar_full_uds`) | `v_compras_pendientes.mandar_full_uds` | UI inteligencia + `accion` | Decision tree: `lote inicial new_sku → operativo → 0`. Descuenta `in_transit_picking_full` para evitar double-shipping. |
| Reserva Flex (`reserva_flex_target`) | `v_compras_pendientes.reserva_flex_target` | mandar_full_uds | `ROUND(d_avg_sem/7 × target_dias_flex)` con override por `sku_node_policy`. |
| Picking activo bodega→Full (`in_transit_picking_full`) | `v_safety_stock.in_transit_picking_full` | downstream | Cuenta `picking_sessions` activos para bodega→Full (Sprint 7 Fase 0.A). Motor viejo NO la ve. |
| Liquidación (`liquidacion_accion`, `liquidacion_descuento`) | `v_reposicion_explain.liquidacion_*` | UI mark-down | Bandas DIO declaradas en `sku_node_policy`. Override `liquidacion_override`. |
| Alertas autónomas | `v_sku_alertas` | UI + cron WhatsApp | 5 alertas mínimas: `sin_costo`, `sin_stock_proveedor`, `quiebre_largo`, `flex_no_publicado`, `stock_danado_full`. |
| Narrativa explicación | `v_sku_explanation` | botón ⓘ en UI | 7 secciones JSONB + texto plano. |
| Política por nodo | `sku_node_policy` (tabla) | overrides en vistas | Columnas `*_override` (target_dias_full_override, target_dias_flex_override, liquidacion_override). |
| **Acción canónica de policy** (`buy`, `no_reorder`, etc.) | `policy_templates.action` resuelto vía `COALESCE(snp.cell_efectiva, snp.cell)` | `v_safety_stock.policy_action`, `v_compras_pendientes` filtra por la misma resolución (Sprint 9 P1, 2026-05-05) | `sku_node_policy.action` queda como **cache informativo, NO autoritativo**: se desincroniza cuando `refresh_trend_in_sku_node_policy` actualiza `cell_efectiva`. Toda lectura de la acción aplicable debe pasar por las vistas. T28 (`tests/sql/regression_sprint9_cell_sync.sql`) pin-to-0: SKUs degradados (cell_efectiva con primera letra peor que cell) NO deben aparecer en `v_compras_pendientes`. **Sprint 9 P2 (2026-05-06)**: sub-cuadrante `CZ_alta_vel` (action=reorder_normal, target=CY-like, sl/z=NULL) rescata SKUs CZ con histórico ≥10/180d (o ≥20/365d) ult_venta≤120d, o uds_30d≥1 ult_venta≤7d ("vendió esta semana"). Ver P-MOT-4 abajo. |
| Factor rampup post-quiebre | `sku_intelligence.factor_rampup_aplicado` (motor viejo escribe, motor nuevo consume) | `v_safety_stock.d_avg_sem` | **Excepción**: el cron `recalcular` del motor viejo sigue escribiendo este campo hasta Sprint 9+. Doctrina: `src/lib/rampup.ts` (deprecated). |
| Stock Full por SKU | `stock_full_cache` (tabla canónica) | todas las vistas | Columna zombi `ml_items_map.stock_full_cache` deprecada (v58). |

## P-MOT-2 — Doctrina autónoma

> El motor nuevo decide. El admin valida y desactiva o sobreescribe en
> casos puntuales. La doctrina es: **autopilot con humano en el loop por
> excepción, no por default**.

- **No se reabre el debate de cuál motor manda** sin caso testigo
  reproducible que muestre divergencia operativamente errada del nuevo.
- **No se agregan políticas hardcoded en código TypeScript.** Toda
  política nueva (umbrales, factores, bandas) entra como columna en
  `sku_node_policy` o como tabla referenciada por las vistas.
- **5 alertas mínimas** que el sistema debe levantar autónomamente
  (`v_sku_alertas`). Si una alerta tiene >5% de overrides manuales en un
  mes, se replantea el umbral, no se desactiva la alerta.
- **Overrides son trazables.** Cada override en `sku_node_policy` pasa
  por la UI `/admin/inteligencia` (target_dias_full_override, etc.). No
  hay UPDATEs manuales sin auditoría.
- **Motor viejo en cooldown.** `intelligence.ts` sigue corriendo el cron
  `/api/intelligence/recalcular` para alimentar columnas legacy
  (`forecast_accuracy`, `margen_*`, `vel_objetivo`, `dias_sin_conteo`,
  `stock_danado_full`, `gmroi`, `factor_rampup_aplicado`). NO se le agrega
  lógica nueva. Borrar tras Sprint 9+ (~30d cooldown).

## P-MOT-4 — Sub-cuadrante `CZ_alta_vel` (Sprint 9 P2, 2026-05-06)

**Problema:** Sprint 9 P1 hizo que `v_safety_stock` filtre por
`policy_templates.action ∈ {buy, ...}`, excluyendo `no_reorder`. La celda
CZ (`action='no_reorder'`) silencia ~150 SKUs en bodega_central. Pero
varios CZ tienen venta histórica relevante o vendieron esta semana — el
motor los borra del radar y la UI no los muestra.

**Solución:** sub-cuadrante `CZ_alta_vel` con `action='reorder_normal'`
y target chico (CY-like: 7d Full, 2d Flex). `service_level=NULL` y
`z_value=NULL` → safety_stock=0 (cycle_stock cubre LT, no inflar buffer
en SKUs erráticos).

**Reglas de promoción** (en `refresh_trend_in_sku_node_policy()` Step C):

```
SKU cell='CZ' AND cell_efectiva='CZ' (no promovido por trend) Y:
  ((uds_180d >= 10 OR uds_365d >= 20) AND ult_venta <= 120d)
  OR
  (uds_30d >= 1 AND ult_venta <= 7d)  -- rescate "vendió esta semana"
THEN cell_efectiva = 'CZ_alta_vel'
```

**Decisiones doctrinales:**

- **`promocion_activa = true`** para los rescatados, con `promocion_motivo`
  que cita las uds que motivaron el rescate (auditable).
- **`v_safety_stock` tiene rama de visibilidad ampliada**: SKUs con
  `cell_efectiva LIKE '%_alta_vel'` y `vel_pre_quiebre > 0` entran al
  CTE `demand_stats` aunque `vel_ponderada=0`. Sin esta rama, casos como
  JSAFAB397P20X (25 uds en 180d, vendió hace 80d, vel_30d=0) quedan
  fuera del cálculo de SS/ROP/cycle.
- **El check `policy_templates.cell ~ '^[ABC][XYZ](_[a-z_]+)?$'`** acepta
  sub-cuadrantes con sufijo. Patrón abierto a futuros _liquidar,
  _seasonal, _new_launch, etc.
- **No conflicto con trend detector**: el rescate solo aplica si
  `cell_efectiva = 'CZ'` (no fue promovido por aceleración). Si después
  el trend detector promueve a B/A, sobrescribe `CZ_alta_vel`.

**Tests pin** (`tests/sql/regression_sprint9_p2_cz_alta_vel.sql`):

- T35 ≥1: count CZ_alta_vel rescatados (post-fix: 57).
- T36 =0: JSAFAB408P20Z (5 ventas, última 100+d) NO rescatado (abandono real).
- T37 ≥3: 3 testigos visibles en `v_safety_stock`.
- T38 =1: JSCNAE138P25B en `v_reposicion_explain`.

## P-MOT-3 — Cómo cambiar una política

1. **Identificar el dominio** en la tabla P-MOT-1 (qué vista/columna
   gobierna el comportamiento).
2. **Si la política aplica a algunos SKUs**: agregar/usar override en
   `sku_node_policy` (ej. `target_dias_full_override`). UI: `/admin/inteligencia`.
3. **Si la política aplica globalmente**: modificar la vista SQL
   correspondiente vía migración Atlas (`supabase/migrations/`). Re-hash
   con `atlas migrate hash --dir file://supabase/migrations`.
4. **Documentar la política nueva** en `/docs/policies/inventario.md` (o
   pricing/markdown según corresponda) con:
   - Regla en una línea.
   - Implementación canónica (vista + columna).
   - Fundamento (manual o caso testigo).
5. **Test de regresión** en `tests/sql/regression_*.sql` que fije la
   política con un fixture conocido.
6. **Promover desde el sprint doc**, NO desde un commit silencioso.

**Prohibido**: meter umbrales nuevos como constantes en `.ts`. Si se ve
una constante mágica relacionada a inteligencia en TypeScript, es bug
heredado del motor viejo y entra al backlog Sprint 9+.

## P-MOT-4 — Métricas de salud (revisión cada 3 meses)

El motor canónico se considera saludable si todas estas métricas se
sostienen durante un trimestre. Revisión obligatoria del owner cada 3
meses (próxima: 2026-08-05).

| Métrica | Meta | Cómo medir |
|---|---|---|
| Hay **una forma** de averiguar la `accion` de un SKU | 100% | `v_reposicion_explain.accion` único entrypoint. Si aparece otra columna `accion` en lectura productiva → bug. |
| Hay **una forma** de cambiar una política | 100% | `sku_node_policy` overrides + migración Atlas. UI bloquea inputs ad-hoc. |
| Hay **una pantalla operativa** principal | `/admin` tab Inteligencia | Si emergen vistas alternativas con números distintos para el mismo SKU → divergencia, abrir incident. |
| Hay **un cron** que mantiene los datos al día | `/api/intelligence/recalcular` (legacy, alimenta motor nuevo via `sku_intelligence`) | Cuando termine cooldown Sprint 9+, refactorizar a job que solo refresque dependencias. |
| Tasa de overrides manuales | **<5%** del universo SKU activo | Query: `COUNT(*) FILTER (WHERE liquidacion_override IS NOT NULL OR target_dias_*_override IS NOT NULL) / COUNT(*)`. >5% sostenido = umbral mal calibrado, replantear policy. |

Si alguna métrica falla en revisión trimestral, se abre sprint dedicado
para realinear (no parche).

---

## Pendiente — Sprint 9+

- Borrar `src/lib/intelligence.ts` (cooldown 30d post-Sprint 8).
- Portar columnas legacy (`gmroi`, `margen_*`, `forecast_accuracy`,
  `dias_sin_conteo`, `stock_danado_full`) a vistas o a un job dedicado
  fuera del motor viejo.
- Reconciliación periódica `picking_sessions` ↔ `ml_shipments` (gap
  identificado Sprint 7 cierre).
- Refactorizar el cron `recalcular` para que NO contenga lógica de
  inteligencia, solo refresco de campos derivados.
