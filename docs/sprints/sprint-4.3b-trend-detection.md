# Sprint 4.3b — Detección de aceleración/desaceleración + promoción temporal

**Owner:** Vicente Elías
**Fecha:** 2026-05-04
**Branch:** `main` (sesión paralela 2)
**Tag:** `[batch:20260504-2]`
**Migración:** `supabase/migrations/20260504130000_sprint43b_trend_detection.sql`
**Tests:** `tests/sprint43b_validation.sql` (6/6 PASS)
**Cron:** `/api/policy/sync-trend-detection` (12:00 UTC daily)

## Decisión del owner (textual)

> "que sea inteligente el sistema y prevenir no comprar productos que sí
> pueden ser buenos. Por ejemplo, que la velocidad aumentó y se empezó a
> vender muy rápido pero son letra C por ejemplo y por eso se compra de
> a poco. Eso está bien pero tener ojo con eso."

El motor viejo reclasifica ABC×XYZ con ventana 90 días. Un SKU que
acelera en la última semana tarda 30+ días en moverse de C a B. Mientras
tanto la política de C lo subdimensiona. Sprint 4.3b detecta el cambio
en 4-7 días y aplica overlay temporal sin tocar la reclasificación
oficial.

## Tendencias y umbrales

Detectadas en `v_trend_detection` comparando 3 ventanas:

- **`uds_28d`** — últimas 4 semanas (días 0-28).
- **`uds_28d_previas`** — 4 semanas previas (días 29-56).
- **`uds_90d`** — baseline 90 días.

Ratios calculados:
- `ratio_recent_vs_previous = vel_28d / vel_28d_previas`
- `ratio_recent_vs_baseline = vel_28d / vel_baseline_90d`

| Tendencia | Regla | Acción |
|---|---|---|
| `acelerando_fuerte` | `ratio_recent_vs_previous ≥ 2.0` AND `uds_28d ≥ 5` | Promover ABC |
| `acelerando` | `ratio ≥ 1.5` AND `ratio_baseline ≥ 1.3` AND `uds_28d ≥ 3` | Promover ABC |
| `desacelerando_fuerte` | `ratio ≤ 0.3` AND `uds_28d_previas ≥ 5` | Sólo flag |
| `desacelerando` | `ratio ≤ 0.5` AND `ratio_baseline ≤ 0.7` AND `uds_28d_previas ≥ 3` | Sólo flag |
| `insuficiente_data` | `uds_90d < 5` | Sólo flag |
| `estable` | default | Sin cambio |

**Por qué dos ratios para `acelerando`**: evita falsos positivos donde 4
semanas previas eran anómalamente bajas (típico cold start o rebote
post-quiebre). El baseline 90d filtra eso.

**Por qué `acelerando_fuerte` no exige confirmación con baseline**: 2×
en 4 semanas es señal demasiado fuerte para esperar más data. Un SKU
recién despegando puede no tener historia 90d.

## Lógica de promoción

Dada `(cell, tendencia)`, función pura `calc_cell_efectiva` retorna
`(cell_efectiva, promocion_activa, motivo)`:

- `acelerando` o `acelerando_fuerte`:
  - `CX/CY/CZ` → `BX/BY/BZ` (mantiene XYZ)
  - `BX/BY/BZ` → `AX/AY/AZ` (mantiene XYZ)
  - `AX/AY/AZ` → sin cambio (ya en top)
- Cualquier otra tendencia → `cell_efectiva = cell` (no degrada).

**Por qué sólo ABC, no XYZ**: el XYZ refleja variabilidad relativa de la
demanda. Una demanda más alta no la vuelve más predecible. Mantener XYZ
preserva el z-value semánticamente correcto. El target_dias_full sí
crece (AZ=14 vs BZ=7) y eso es el efecto operativo deseado.

**Por qué desacelerando NO degrada automáticamente**: ir a `CZ` activa
política `no_reorder`. Si un SKU desacelera por causa temporal
(estacionalidad, quiebre upstream, bug ML), degradarlo automáticamente
puede congelar las compras justo cuando se va a recuperar. Mejor que
humano confirme.

## Aplicación en `v_safety_stock`

```sql
politica_efectiva AS (
  SELECT ...
    COALESCE(snp.cell_efectiva, snp.cell) AS cell_aplicada,
    snp.cell AS cell_original,
    -- Sprint 4.3b: z y target_dias_full vienen de la celda efectiva
    COALESCE(pt_efectiva.z_value, snp.z_value) AS z_value,
    COALESCE(pt_efectiva.target_dias_full, snp.target_dias_full) AS target_dias_full,
    -- target_dias_flex queda como override per-SKU (snp.target_dias_flex)
    snp.target_dias_flex,
    ...
  FROM sku_node_policy snp
  LEFT JOIN policy_templates pt_efectiva
    ON pt_efectiva.cell = COALESCE(snp.cell_efectiva, snp.cell)
)
```

Cuando un SKU `BZ` acelera, su `cell_efectiva = AZ` y `policy_templates`
provee:
- `z_value` de AZ (mismo que BZ en este seed: 1.28).
- `target_dias_full = 14` (vs BZ=7) → `pre_full_target` se duplica.

`target_dias_flex` permanece de `snp` (per-SKU). Razón: sprint 4.3a la
modeló como override por SKU, no derivada de templates.

## Distribución post-deploy (2026-05-04, primer refresh)

`v_trend_detection` (303 SKUs con ventas en 90d):

| Tendencia | SKUs | % |
|---|---|---|
| `estable` | 131 | 43% |
| `insuficiente_data` | 75 | 25% |
| `acelerando_fuerte` | 27 | 9% |
| `desacelerando_fuerte` | 27 | 9% |
| `desacelerando` | 25 | 8% |
| `acelerando` | 18 | 6% |

`sku_node_policy` (802 filas activas: 401 SKUs × 2 nodos):

```
acelerando=36  acelerando_fuerte=54  estable=262
desacelerando=50  desacelerando_fuerte=54
insuficiente_data_matched=150  orphans_no_sales_90d=196
promovidos=50
```

(Cada SKU acelerando tiene 2 filas en `sku_node_policy`: bodega +
full_ml. Por eso los counts son ×2 vs `v_trend_detection`.)

## Top 10 promovidos en `v_compras_pendientes`

| SKU | Nombre | Cell | Tendencia | qty | CLP | ratio |
|---|---|---|---|---|---|---|
| TXSBAF144DL20 | Sabana AFamily 144H Daloa 20P | BZ→AZ | acel_fuerte | 22 | $242k | 7.0× |
| TXV23QLRM25CF | Quilt MF Roma 25P Café | BZ→AZ | acelerando | 18 | $155k | 2.0× |
| TXSB144ISY15P | Sabana Illusions Infantil Starry 15P | BX→AX | acelerando | 12 | $88k | 1.8× |
| JSAFAB420P20W | Jgo Sabanas AF Vias Negro 2.0 W25 | BZ→AZ | acel_fuerte | 7 | $77k | 3.0× |
| TXV25QLBRRS25 | Quilt Breda 25P Rosa | BY→AY | acel_fuerte | 8 | $72k | 2.0× |
| TXV24QLBRMA15 | Quilt Bruselas Marron 15P | BZ→AZ | acel_fuerte | 7 | $49k | 7.0× |
| JSAFAB426P20S | Jgo Sabanas AF Zircon Negro 2.0 S26 | BZ→AZ | acel_fuerte | 4 | $48k | 2.7× |
| TXV23QLAT25BC | Quilt Atenas 25P Blanco | BZ→AZ | acel_fuerte | 2 | $17k | 5.0× |
| TXV23QLRM20CL | Quilt MF Roma 20P Celeste | BY→AY | acel_fuerte | 2 | $15k | 5.0× |
| ALPCMPRHL4060 | Limpiapies Coco 40×60 Hello | BY→AY | acelerando | 4 | $14k | 1.7× |

Patrón claro: BZ→AZ domina — long-tail erráticos despegando que el cron
mensual aún no reclasificó.

## Antes → Después

| Métrica | Sprint 4.3a | Sprint 4.3b |
|---|---|---|
| SKUs en `v_compras_pendientes` | 71 | 68 |
| Total CLP banner | $14,317,315 | $14,370,840 |
| SKUs promovidos en compras | 0 | 10 |
| Acelerando_fuerte detectados | 0 | 54 |
| Acelerando detectados | 0 | 36 |

(El cambio neto en CLP es modesto — la mayoría de SKUs promovidos no
están bajo_rop. La promoción se activará cuando bajen del ROP recalculado
con la nueva celda; entonces sí se sentirá más.)

## Constraints respetados

- **NO modifica `intelligence.ts`** — la detección vive en SQL (vista +
  RPC).
- **NO cambia reclasificación oficial ABC×XYZ** — el cron mensual del
  motor viejo sigue siendo el oráculo. `cell_efectiva` es overlay.
- **NO degrada cuando desacelera** — sólo flag, decisión humana.
- **NO toca pricing.ts, P17, markdown, Op Limpieza** — sesión paralela.
- **NO modifica `policy_templates` seed** — sólo lectura para resolver
  parámetros de la celda promovida.

## Definition of done

- [x] Migration aplicada (idempotente, `[non-reversible:view-rebuild-add-columns-no-data-loss]`)
- [x] `v_trend_detection` devuelve 303 filas
- [x] `sku_node_policy` con 5 columnas nuevas (tendencia, cell_efectiva, etc.)
- [x] Cron diario en `vercel.json` (12:00 UTC)
- [x] RPC ejecutada (datos iniciales: 802 filas afectadas)
- [x] `v_safety_stock` usa `cell_efectiva`
- [x] `v_reposicion_explain` expone tendencia + velocidades por ventana + ratios
- [x] `SkuExplainPanel` muestra sección "📈 Tendencia"
- [x] Tests SQL 6/6 PASS
- [x] Build verde (`tsc --noEmit` sin errores en files Sprint 4.3b)
- [x] Tag `[batch:20260504-2]` en commit

## Pendientes (NO Sprint 4.3b)

- **Endpoint para "rechazar promoción"**: hoy si la promoción está
  errada (ej. pico estacional que no se va a sostener), no hay forma de
  desactivarla — espera al siguiente refresh + cambio de tendencia.
  Roadmap Sprint 4.4+.
- **Sprint 4.3c** — `candidato_descontinuar` (otro flag).
- **Override degrada cuando desacelera prolongado**: revisar tras 30
  días de `desacelerando_fuerte` continuo.

## Rollback

```sql
-- Restaurar v_safety_stock al estado Sprint 4.3a (sin cell_efectiva):
-- ver supabase/migrations/20260504100100_sprint43a_views_with_old_logic.sql

-- Borrar columnas de promoción (datos pierden la trazabilidad):
ALTER TABLE sku_node_policy
  DROP COLUMN tendencia,
  DROP COLUMN cell_efectiva,
  DROP COLUMN promocion_activa,
  DROP COLUMN promocion_motivo,
  DROP COLUMN tendencia_updated_at;

-- Borrar funciones:
DROP FUNCTION refresh_trend_in_sku_node_policy;
DROP FUNCTION calc_cell_efectiva;

-- Borrar vista:
DROP VIEW v_trend_detection;

-- Sacar cron de vercel.json (eliminar entry sync-trend-detection).
```

## Referencias

- Sprint 4.3a: `/docs/sprints/sprint-4.3a-importar-viejo-flex.md`
- Discovery 4.3: `/docs/discovery/lifecycle-doctrine-2026-05-03.md`
- Manual: `/docs/policies/inventario-formulas.md` §"Detección de tendencia"
- `metrics.yaml` — entradas: `vel_recent_sem`, `ratio_recent_vs_previous`,
  `tendencia`, `cell_efectiva`.
