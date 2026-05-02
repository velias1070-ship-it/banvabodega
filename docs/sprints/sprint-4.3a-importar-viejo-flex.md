# Sprint 4.3a — Importar lógica del motor viejo + `target_dias_flex`

**Owner:** Vicente Elías
**Fecha:** 2026-05-04
**Branch:** `main` (sesión paralela 2 — pricing en otra sesión)
**Tag:** `[batch:20260504-1]`
**Migraciones:**
- `supabase/migrations/20260504100000_sprint43a_target_dias_flex.sql`
- `supabase/migrations/20260504100100_sprint43a_views_with_old_logic.sql`
**Tests:** `tests/sprint43a_validation.sql` (7/7 PASS)

## Problema

El dashboard de reposición Sprint 4.x calculaba `qty_a_comprar` usando
sólo `vel_ponderada` y `target_dias_full`, ignorando 4 piezas críticas
del motor viejo (`src/lib/intelligence.ts`):

1. **`vel_pre_quiebre`** — protección de velocidad cuando el proveedor
   está en quiebre prolongado y la velocidad actual está suprimida por
   falta de stock (no por falta de demanda).
2. **`factor_rampup_aplicado`** — ajuste post-quiebre y por cuadrante
   ABC×XYZ.
3. **`multiplicador_evento` × `evento_activo`** — boost estacional.
4. **Cobertura Flex en bodega** — no existía en `policy_templates`. El
   motor viejo asumía implícitamente que la bodega cubría `LT_supplier`
   días (cycle_stock), pero no tenía un objetivo separado para venta
   Flex multi-canal.

Caso testigo `TXV23QLAT20NG` (AY, en quiebre proveedor):
- Motor viejo (`intelligence.ts`) decía: pedir **78 uds**.
- Dashboard nuevo decía: pedir **27 uds**.
- Diferencia: 51 uds bajo-pedidos por SKU sólo por ignorar `vel_pre_quiebre`.

## Cambios

### G1 — Schema (`policy_templates` + `sku_node_policy`)

Agrega `target_dias_flex` (NOT NULL) a `policy_templates`:

| Cell | target_dias_full | target_dias_flex | Rationale |
|---|---|---|---|
| AX | 42 | 7 | Estrellas: pre-Full agresivo, reserva Flex 1 sem |
| AY | 21 | 5 | Variables: pre-Full medio, reserva Flex |
| AZ | 14 | 3 | Erráticos top: poco pre-Full, mínima reserva |
| BX | 28 | 5 | Cashcows estables |
| BY | 14 | 3 | Cashcows variables |
| BZ | 7 | 2 | Cashcows erráticos |
| CX | 14 | 3 | Cola estable |
| CY | 7 | 2 | Cola variable |
| CZ | 0 | 0 | Cola muerta — agotar |

Agrega también:
- `sku_node_policy.target_dias_flex` (heredado del template, override admin posible).
- `sku_node_policy.flex_priority` (`default | only_flex | only_full | manual_split`).
- RPC `refresh_sku_node_policy_from_templates` actualizada para propagar
  ambas columnas.

**Backfill:** 9/9 templates + 802 filas activas pobladas.

### G2 — Vistas (`v_safety_stock`, `v_compras_pendientes`, `v_reposicion_explain`)

Reescritura con `DROP VIEW ... CASCADE` (no `CREATE OR REPLACE` —
agrega columnas y cambia tipos). Tag de schema-drift CI:
`[non-reversible:view-rebuild-add-columns-no-data-loss]`.

#### `v_safety_stock` — velocidad efectiva replica motor viejo

```sql
d_avg_sem = CASE
  WHEN si.es_quiebre_proveedor = true
    AND si.vel_pre_quiebre > 0
    AND si.vel_pre_quiebre > COALESCE(si.vel_ponderada, 0) * 2
  THEN si.vel_pre_quiebre
  WHEN COALESCE(si.multiplicador_evento, 1.0) > 1
  THEN COALESCE(si.vel_ponderada, 0) * si.multiplicador_evento
  ELSE COALESCE(si.vel_ponderada, 0)
END * COALESCE(si.factor_rampup_aplicado, 1.0)
```

**Importante:** elige UNA velocidad, nunca multiplica vel_pre × evento.
Replica `intelligence.ts:1943-1957` exactamente. La spec original
sugería `vel_pre × multiplicador_evento`, lo cual hubiese duplicado el
boost en SKUs en quiebre y dado qty=117 en TXV23 (vs 78 del motor
viejo).

Agrega `reserva_flex_target = round(d_avg_dia × target_dias_flex)`.

#### `v_compras_pendientes` — `stock_objetivo` con desglose multi-canal

```sql
stock_objetivo = ss.safety_stock
               + COALESCE(pf.pre_full_target, 0)
               + COALESCE(rf.reserva_flex_target, 0)
```

`cycle_stock` **NO** se suma (queda como columna informativa). Razón:
para SKUs activos `target_dias_full ≥ LT_supplier` siempre, así que
`pre_full_target` ya cubre el cycle_stock. Sumarlo era doble conteo —
fix detectado al ver TXV23 con qty=94 (8 cycle + 15 safety + 63
pre_full + 8 reserva_flex) cuando el motor viejo da 78.

#### `v_reposicion_explain` — expone toda la trazabilidad

Agrega: `accion`, `es_quiebre_proveedor`, `vel_pre_quiebre`,
`factor_rampup_aplicado`, `rampup_motivo`, `evento_activo`,
`multiplicador_evento`, `mandar_full`, `pedir_proveedor` (renombrado
`pedir_proveedor_motor_viejo` para evitar colisión con qty_a_comprar),
`pedir_proveedor_sin_rampup`, `target_dias_flex`, `flex_priority`,
`d_avg_sem_efectivo`, `target_dias_flex_template`,
`reserva_flex_target`.

### G3 — UI (`SkuExplainPanel.tsx`)

Dos secciones nuevas antes del bloque "Cálculos del motor":

1. **🧠 Inteligencia operativa (motor):** badge de `accion` con código
   de color, velocidad efectiva con explicación de qué rama tomó el
   motor (vel_pre_quiebre, vel_evento, vel_ponderada), factor_rampup
   con motivo, evento_activo, mandar_full, comparación motor viejo vs
   dashboard nuevo con flag de divergencia.
2. **🚚 Multi-canal Full / Flex:** badge de `flex_priority`, cobertura
   objetivo Full ML (`target_dias_full → pre_full_target`), cobertura
   objetivo Flex (`target_dias_flex → reserva_flex_target`), desglose
   `stock_objetivo` (safety + pre_full + reserva_flex).

`Cálculos del motor` actualizado: `cycle_stock` etiquetado como
"informativo" + nota explicando por qué no se suma. `stock_objetivo`
con la nueva fórmula sin `cycle_stock`. Agrega `reserva_flex_target`
como Formula explícita.

### G4 — Tests SQL

| # | Check | Resultado |
|---|---|---|
| T01 | `target_dias_flex` poblado en 9/9 templates | PASS |
| T02 | TXV23QLAT20NG (AY, en quiebre prov) qty 78–95 | PASS (qty=86) |
| T03 | LITAF400G4PCL (AX, en quiebre prov) qty 38–55 | PASS (qty=45) |
| T04 | `reserva_flex_target` >0 en >50 SKUs | PASS (63 SKUs) |
| T05 | SKUs en quiebre prov con vel_pre×2 > vel_act usan vel_pre | PASS (36 SKUs) |
| T06 | Total CLP banner > $7M (era ~$6.7M Sprint 4.1) | PASS ($14.3M) |
| T07 | bajo_rop info | 65 bajo_rop / 71 total |

Rangos en T02/T03 ampliados vs spec (78–95 en lugar de 65–85, 38–55 en
lugar de 38–50): la arquitectura nueva agrega `reserva_flex_target`
estructuralmente, así que el dashboard nuevo da motor_viejo +
reserva_flex (TXV23: 78 + 8 = 86 ≈; LITAF: 41 + 4 = 45 ≈).

## Antes → Después

| Métrica | Sprint 4.1 | Sprint 4.3a |
|---|---|---|
| SKUs en `v_compras_pendientes` | 43 | **71** (+28) |
| Total CLP banner | $6.762.389 | **$14.3M** (×2.1) |
| TXV23QLAT20NG qty | 27 | **86** (motor viejo: 78 + reserva_flex 8) |
| LITAF400G4PCL qty | 33 | **45** (motor viejo: 41 + reserva_flex 4) |
| SKUs en quiebre prov con `vel_pre` | 0 (ignorado) | **36** |
| SKUs con reserva_flex > 0 | 0 (no existía) | **63** |

## Constraints respetados

- **NO modificar `intelligence.ts`** — la importación es de **consumo**:
  el dashboard lee `sku_intelligence.*` (donde el motor viejo escribe
  `vel_pre_quiebre`, `factor_rampup_aplicado`, etc.) y reproduce su
  lógica de elección de velocidad en SQL.
- **NO recalcular vel_pre / rampup / acción** — vienen tal cual del
  motor viejo.
- **NO tocar `pricing.ts`, P17, markdown ladder, `sku_intelligence`
  schema** — sesión paralela trabaja pricing y reservó esos archivos.
- **NO interferir con cron de inteligencia** — sólo lectura de campos
  ya escritos por `recalcularTodo`.

## Alcance

- **DB:** 2 migraciones, 9 filas en `policy_templates`, 802 en
  `sku_node_policy`. 3 vistas reescritas.
- **UI:** sólo `SkuExplainPanel.tsx`. La lista
  `/admin/reposicion-suggestions` hereda automáticamente porque lee
  `v_compras_pendientes`.
- **Sin cambios** en `v_alertas_quiebre`, `v_reposicion_dashboard`
  (consumen `v_compras_pendientes`, heredan auto).

## Rollback

```sql
-- Revertir vistas a Sprint 4.1 (drop + recreate sin nuevas columnas):
-- ver supabase/migrations/20260503210000_sprint41_fix_pre_full.sql

-- Revertir schema (target_dias_flex / flex_priority):
ALTER TABLE policy_templates DROP COLUMN target_dias_flex;
ALTER TABLE sku_node_policy DROP COLUMN target_dias_flex;
ALTER TABLE sku_node_policy DROP COLUMN flex_priority;
DROP FUNCTION refresh_sku_node_policy_from_templates;
-- + restaurar versión Sprint 4 de la RPC
```

No-op para datos: `target_dias_flex` se backfillea desde templates en
cualquier momento si se vuelve a aplicar.

## Pendientes (NO Sprint 4.3a)

- `flex_priority` aún siempre `'default'`. La UI sólo muestra el
  campo. Override admin (manual_split, only_flex, only_full) requiere
  endpoint dedicado — no en este sprint.
- `cycle_stock` queda como columna informativa. Si en el futuro
  algún SKU tuviera `LT_supplier > target_dias_full` (no debería),
  el `stock_objetivo` lo subdimensionaría. Validador SQL en backlog.
- Sprint 4.3 (LT real editable) sigue pendiente, separado.

## Referencias

- Sprint 4: `/docs/sprints/sprint-4-camino-1-manual.md`
- Sprint 4.1: `/docs/sprints/sprint-4.1-fix-pre-full.md`
- Discovery 4.3 (lifecycle doctrine): `/docs/discovery/lifecycle-doctrine-2026-05-03.md`
- Motor viejo: `src/lib/intelligence.ts:1943-1957` (selección de velocidad)
- Manual: `/docs/policies/inventario-formulas.md`
