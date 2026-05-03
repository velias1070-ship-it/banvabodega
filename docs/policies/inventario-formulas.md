# Inventario — Fórmulas, Fuentes y Trazabilidad

> **Documento maestro**: para cada métrica que calcula `intelligence.ts` se
> declara fórmula, inputs (con fuente), código y ejemplo numérico. Si una
> fórmula cambia en el código, este documento se actualiza en el mismo PR.
>
> **Caso testigo**: usamos `TXTPBL20200SK` (Topper Illusions Super King,
> Idetex, ABC=A, ESTRELLA) para los ejemplos numéricos. Snapshot tomado el
> **2026-05-01 19:45 UTC**.

## Convención crítica de unidades

**Todas las velocidades (`vel_*`) están en uds/SEMANA, no uds/día.**

Esto se ve en `intelligence.ts:1040-1055`:
- `vel_7d = sumar(ordenes_7d)` — uds en 7 días = uds/semana
- `vel_30d = sumar(ordenes_30d) / semanasActivas30d` — uds dividido por semanas
- `vel_60d` idem
- `vel_ponderada = 0.5×vel_7d + 0.3×vel_30d + 0.2×vel_60d` — uds/semana

**Para convertir a uds/día**: dividir por 7. Pero el motor opera todo en
uds/semana hasta el final.

`σ_D` (`desviacion_std`) también está en uds/semana (es la stddev de las
ventas semanales agrupadas en `agruparPorSemana`).

`LT` (lead time) viene en días pero se convierte a semanas (`/7`) antes de
usarse en SS y ROP.

**Ejemplo TXTPBL20200SK:** vel_ponderada=17.9 uds/semana ≈ 2.56 uds/día.

## Cómo leer esta doc

Cada métrica viene en este formato:

```
### nombre_columna

Definición humana.

Fórmula:
  resultado = función(input₁, input₂, ...)

Inputs:
- input₁ — qué es, fuente (tabla.columna o métrica derivada).
- input₂ — ...

Código: src/lib/<archivo>.ts:<línea>

Ejemplo TXTPBL20200SK: input₁=X · input₂=Y → resultado=Z
```

Si un input es a su vez una métrica calculada, está hyperlinkeada al lugar
donde se documenta su fórmula.

---

# Parte 1 — Fuentes de datos

El motor recompone una imagen completa del inventario a partir de **9 tablas
canónicas** (más 5 tablas auxiliares). El orden de "qué dato vive dónde":

## Tablas canónicas (la verdad)

| Tabla | Contiene | Quién la escribe | Dónde se usa en el motor |
|---|---|---|---|
| `productos` | Catálogo maestro: nombre, categoría, proveedor canonico, costo_promedio (WAC) | App Etiquetas (auto-create) + admin manual | Identidad, costo unitario, inner_pack |
| `composicion_venta` | Mapeo `sku_venta → sku_origen + unidades` (combos, packs, alternativas) | Admin manual + autoheal | Vincular ventas ML al SKU origen |
| `ventas_ml_cache` | Histórico de órdenes ML (anuladas marcadas `anulada=true`) | Cron `/api/ml/sync` | Cálculo de velocidades, márgenes, eventos |
| `stock` | Stock por (sku, posicion_id) en bodega BANVA | RPC `registrar_movimiento_stock` | `stock_bodega` (suma por SKU) |
| `stock_full_cache` | Stock disponible en CD MELI (Colina) | Cron `/api/ml/sync-stock-full` | `stock_full` |
| `ordenes_compra` + `ordenes_compra_lineas` | OCs a proveedores con snapshot de decisión al pedir | Admin → Inteligencia → "Generar OC" | `stock_en_transito`, `oc_pendientes` |
| `recepciones` + `recepcion_lineas` | Mercadería recibida del proveedor | App Etiquetas (`banva1`) | Cantidad recibida → trigger v93 actualiza OC |
| `movimientos` | Log de cambios de stock | RPC `registrar_movimiento_stock` | Detección de ventas físicas, último movimiento |
| `stock_snapshots` | Snapshot diario de stock por SKU | Motor (cron 11:00 UTC) | Detección de quiebres, días sin stock |

## Tablas auxiliares

| Tabla | Contiene | Para qué |
|---|---|---|
| `proveedores` | Lead time + σ_LT por proveedor | Safety stock, lead_time_usado |
| `proveedor_catalogo` | Precios pactados + inner_pack por (proveedor, sku) | Costo OC, redondeo a bultos |
| `eventos_demanda` | Eventos con multiplicador (Día Madre 1.3x, etc.) | `vel_ajustada_evento` |
| `intel_config` | Config singleton: targetDiasA/B/C, cobMaxima, costos | Parámetros del motor |
| `sku_intelligence` | **Output** del motor (snapshot actual) | Lo que ves en UI |
| `sku_intelligence_history` | Snapshot diario histórico (subset de columnas) | Comparativa día a día |

## Cron de actualización

| Cron | Cuándo | Qué hace |
|---|---|---|
| `/api/ml/sync` | Cada 5 min | Sincroniza órdenes ML nuevas → `ventas_ml_cache` |
| `/api/ml/sync-stock-full` | Cada hora | Lee stock Full desde MELI → `stock_full_cache` |
| `/api/ml/stock-sync` | Continuo (queue) | Push stock bodega → publicación Flex en MELI |
| `/api/intelligence/recalcular` | **11:00 UTC diario** | Recalcula TODO `sku_intelligence` |

**Para el motor**: la fuente de verdad de stock al momento del cálculo es:
`stock_full_cache` (Full) + `stock` (bodega) + tránsito derivado de
`ordenes_compra_lineas`. La cadencia diaria significa que **decisiones del
motor pueden estar hasta 24h desactualizadas** (gap conocido, ver
`docs/auditorias/inteligencia_vs_manuales_2026-04-28.md` H17).

---

# Parte 2 — Pipeline de cálculo (orden cronológico)

`recalcularTodo()` en `src/lib/intelligence.ts:669` ejecuta para cada SKU
estos pasos en orden. Las métricas se calculan acumulativamente: cada paso
puede usar los outputs de los anteriores.

```
1.  IDENTIDAD              → sku_origen, nombre, proveedor, categoría, costo
2.  ÓRDENES Y SEMANAS      → agrupar ventas por semana, detectar quiebres
3.  VELOCIDADES            → vel_7d, vel_30d, vel_60d, vel_ponderada
4.  CANAL FULL/FLEX        → vel_full, vel_flex, pct_full, pct_flex
5.  EVENTOS                → multiplicador_evento, vel_ajustada_evento
6.  TENDENCIA & PICO       → tendencia_vel, es_pico
7.  STOCK AGREGADO         → stock_full, stock_bodega, stock_en_transito
8.  COBERTURA              → cob_full, cob_flex, cob_total
9.  MARGEN POR CANAL       → margen_full_*, margen_flex_*, canal_mas_rentable
10. PARETO ABC (3 ejes)    → abc_margen, abc_ingreso, abc_unidades, abc
11. XYZ                    → cv, desviacion_std, xyz
12. CUADRANTE              → cuadrante (matriz margen × unidades)
13. SAFETY STOCK + ROP     → safety_stock_completo, rop_calculado, necesita_pedir
14. GMROI + DIO            → gmroi, dio, costo_inventario_total
15. QUIEBRE PROLONGADO     → fecha_entrada_quiebre, dias_en_quiebre
16. OPORTUNIDAD PERDIDA    → venta_perdida_uds, ingreso_perdido
17. ACCIÓN + PRIORIDAD     → accion, prioridad
18. LIQUIDACIÓN            → liquidacion_accion, descuento_sugerido
19. ALERTAS                → alertas[], alertas_count
20. RAMPUP POST-QUIEBRE    → factor_rampup_aplicado
21. FLEX/FULL CANON        → mandar_full, publicar_flex
22. PEDIR PROVEEDOR        → pedir_proveedor, pedir_proveedor_bultos
```

---

# Parte 3 — Métricas

## §1 Identidad y costo

### sku_origen

SKU canónico del producto físico. UPPERCASE. Es la PK del motor.

**Fuente:** `productos.sku` (tabla maestra). También viene como `sku_origen`
de `composicion_venta`.

**Código:** `src/lib/intelligence.ts:686`

### nombre, categoria, proveedor

Metadata del producto.

**Fuente:** `productos.nombre`, `productos.categoria`, `productos.proveedor`
(text legible). El FK `proveedor_id` es el canónico (ver `policies/supabase`).

### costo_neto, costo_bruto, costo_fuente

Costo unitario del SKU. `costo_bruto = costo_neto × 1.19` (IVA 19%).

**Fórmula resolución de `costo_neto`** (cascada de fallbacks):

```
1. productos.costo_promedio (WAC desde recepciones)        → costo_fuente="costo_promedio"
2. productos.costo_manual (override admin)                  → "costo_manual"
3. proveedor_catalogo.precio_neto (precio pactado actual)   → "proveedor_catalogo"
4. null si nada matchea                                     → costo_fuente=null
```

**Código:** `src/lib/intelligence.ts:918-940`

**Política:** memoria `feedback_no_inferir_costos` — **prohibido** rellenar
costo con promedios de familia. Solo recepción/OC/catálogo.

**Ejemplo TXTPBL20200SK:** costo_neto=$24.000 · costo_bruto=$28.560 ·
costo_fuente="costo_promedio" → WAC calculado desde recepciones históricas.

### inner_pack

Unidades por bulto del proveedor (para redondeo de OC). **Distinto** de
`unidades_pack_venta` (uds por pack publicado en MELI).

**Fuente:** `proveedor_catalogo.inner_pack` o fallback a `productos.inner_pack`.

**Código:** `src/lib/intelligence.ts:1886`

**Ejemplo TXTPBL20200SK:** inner_pack = 2 → si pedir_proveedor=84,
pedir_proveedor_bultos = 84/2 = 42.

---

## §2 Velocidad de ventas

### vel_7d, vel_30d, vel_60d

Unidades vendidas por **semana** en las últimas 7/30/60 días.

**Fórmula** (`intelligence.ts:1040-1049`):
```
vel_7d  = sum(unidades en últimos 7 días)        # 7d = 1 semana, no se divide
vel_30d = sum(unidades en últimos 30d) / semanasActivas30d
vel_60d = sum(unidades en últimos 60d) / semanasActivas60d
```

donde `semanasActivasXd = max(1, X/7 − semanas en quiebre)`.

**Exclusión de quiebres**: para `vel_30d` y `vel_60d` se excluyen las
semanas donde el SKU estaba quebrado (Full=0 ≥3 días en la semana). Esto
evita subestimar la velocidad real por el sesgo "no vendió porque no
había stock". Para `vel_7d` no se excluye.

**Inputs:**
- Ventas por día — `ventas_ml_cache` (filtrado `anulada=false AND estado='Pagada'`)
- Composición — `composicion_venta` (mapea `sku_venta → sku_origen × unidades`)
- Quiebres — `stock_snapshots` o inferidos por `inferirQuiebresDeOrdenes`

**Código:** `src/lib/intelligence.ts:1040-1049`

**Ejemplo TXTPBL20200SK:** vel_7d=21 · vel_30d=16 · vel_60d=13 **uds/semana**
(equivalen a 3.0 / 2.3 / 1.9 uds/día respectivamente).

### vel_ponderada

Promedio móvil ponderado entre las tres ventanas. Da más peso a lo reciente.

**Fórmula** (`Parte1.md` no la fija explícito, código define los pesos):
```
vel_ponderada = 0.5 × vel_7d + 0.3 × vel_30d + 0.2 × vel_60d
```

**Inputs:** vel_7d, vel_30d, vel_60d.

**Código:** `src/lib/intelligence.ts:1051-1056`

**Ejemplo TXTPBL20200SK:** 0.5×21 + 0.3×16 + 0.2×13 = 10.5+4.8+2.6 = **17.9 uds/semana** (≈ 2.56 uds/día).

### vel_full, vel_flex, vel_total

Descomposición de la velocidad por canal de venta. **uds/semana.**

**Fórmula:**
```
vel_full = sum(uds Full últimos 30d) / semanasActivas30d
vel_flex = sum(uds Flex últimos 30d) / semanasActivas30d
vel_total = vel_full + vel_flex
```

**Input:** `ventas_ml_cache.canal` (valores: "Full" / "Flex").

**Ejemplo TXTPBL20200SK:** vel_full=11.75 · vel_flex=6.15 · vel_total=17.9
(uds/semana ≈ 1.68 / 0.88 / 2.56 uds/día).

### pct_full, pct_flex

Fracción de ventas que pasa por cada canal. Define cuánto del cycle stock
debe vivir en Full vs bodega.

**Fórmula** (`intelligence.ts:1170-1186`):

```
si margen_flex_30d > 0 AND margen_full_30d > 0 AND margen_flex/margen_full > 1.1:
    pct_full = 0.7, pct_flex = 0.3      # más Flex porque es más rentable
sino:
    pct_full = 0.8, pct_flex = 0.2      # default Full prioritario
```

**Inputs:** `margen_full_30d`, `margen_flex_30d` (calculados en §6).

**Código:** `src/lib/intelligence.ts:1170-1186`

**Pendiente policy:** los umbrales 0.8/0.2, 0.7/0.3 y el ratio 1.1 son
hardcoded. Ver `/docs/policies/inventario.md` "Pendiente — promover".

**Ejemplo TXTPBL20200SK:** margen_flex_30d=$17.723, margen_full_30d=$10.868
→ ratio 1.63 > 1.1 → **pct_full=0.7, pct_flex=0.3**.

### evento_activo, multiplicador_evento, vel_ajustada_evento

Si hay un evento de demanda activo (Día Madre, CyberDay, etc.), aplicar
multiplicador a la velocidad para anticipar pico.

**Fórmula:**
```
si existe evento activo (categoría matchea, fecha hoy entre fecha_inicio y _fin):
    multiplicador_evento = max(multiplicadores aplicables)
    evento_activo = nombre del evento dominante
sino:
    multiplicador_evento = 1.0
    evento_activo = null

vel_ajustada_evento = vel_ponderada × multiplicador_evento
```

**Inputs:** `eventos_demanda` (admin-poblada), `productos.categoria`.

**Código:** `src/lib/intelligence.ts` función inline en pipeline §5.

**Ejemplo TXTPBL20200SK:** Día de la Madre activo (multiplicador 1.3) →
vel_ajustada_evento = 17.9 × 1.3 = **23.27 uds/semana**. Se usa en lugar de
`vel_ponderada` cuando se calcula targets de cobertura y reposición.

### vel_pre_quiebre, vel_flex_pre_quiebre

Velocidad capturada **antes** de entrar en quiebre. Sirve para no
subestimar la demanda futura cuando un SKU lleva tiempo sin stock.

**Fórmula:**
```
Cuando un SKU pasa de "tiene stock" a "Full=0":
    snapshot vel_ponderada actual → vel_pre_quiebre
    snapshot vel_flex actual      → vel_flex_pre_quiebre
Cuando vuelve a tener stock:
    se preserva el último valor capturado
    se usa en safety_stock y pedir_proveedor mientras dura el rampup
```

**Inputs:** snapshot histórico de `vel_ponderada` y `vel_flex` justo antes
de transición a quiebre.

**Código:** `src/lib/intelligence.ts:1008-1037` (detección quiebre).

**Política:** memoria `project_banva_rampup_pendiente` — implementado en
PRs #261-264.

**Ejemplo TXTPBL20200SK:** vel_pre_quiebre=0 (nunca quebrado) ·
vel_flex_pre_quiebre=6.68.

### tendencia_vel, tendencia_vel_pct

Compara vel_7d vs vel_30d para detectar si está acelerando o desacelerando.

**Fórmula** (`intelligence.ts:527`):
```
pct = (vel_corto − vel_largo) / vel_largo × 100
direccion =
    "subiendo"     si pct > 10%
    "bajando"      si pct < -10%
    "estable"      si |pct| ≤ 10%
```

**Inputs:** vel_7d (corto), vel_30d (largo).

**Código:** función `calcTendencia` en `src/lib/intelligence.ts:527-536`.

**Ejemplo TXTPBL20200SK:** vel_7d=21, vel_30d=16 → pct = (21-16)/16 × 100 =
**+31.25% → "subiendo"**.

### es_pico, pico_magnitud

Detección de picos atípicos de demanda.

**Fórmula:**
```
pico_magnitud = vel_7d / vel_30d
es_pico = pico_magnitud > 1.5      # umbral del motor
```

**Ejemplo TXTPBL20200SK:** 21/16 = 1.31 → **es_pico=false** (no llega a 1.5).

---

## §3 Stock

### stock_full

Unidades disponibles en CD MELI (Colina).

**Fuente:** `stock_full_cache.qty_disponible` poblado por
`/api/ml/sync-stock-full` (cron horario lee `meli_facility` vía API
fulfillment de MELI).

**Importante:** ML lo gestiona internamente. Nosotros nunca escribimos en
`meli_facility`, solo leemos.

**Ejemplo TXTPBL20200SK:** 1 ud.

### stock_bodega

Unidades en nuestra bodega física.

**Fórmula:** suma agregada `stock` filtrada por `sku`, normalizada UPPERCASE.

```
stock_bodega = SUM(stock.cantidad) WHERE UPPER(stock.sku) = UPPER(sku_origen)
```

**Fuente:** tabla `stock` (canon). Único actualizador: RPC
`registrar_movimiento_stock` (memoria `feedback_movimientos_stock`).

**Ejemplo TXTPBL20200SK:** 41 uds.

### stock_total

`stock_full + stock_bodega + stock_alternativos`. NO incluye en_tránsito.

**Para deduplicar entre alternativas:** si dos SKUs origen son
intercambiables (mismo `sku_venta`, distinto packaging), el motor suma sus
stocks bajo el principal en `intelligence.ts:1946-1985`.

**Ejemplo TXTPBL20200SK:** 1 + 41 + 0 = 42 uds.

### stock_en_transito

Unidades pedidas al proveedor pero aún no recibidas.

**Fórmula:**
```
stock_en_transito = SUM(cantidad_pedida − cantidad_recibida)
                    FROM ordenes_compra_lineas
                    JOIN ordenes_compra
                    WHERE estado IN ('EMITIDA','RECIBIDA_PARCIAL')
                      AND UPPER(sku_origen) = UPPER(sku)
```

**Fuente:** `ordenes_compra_lineas` con `cantidad_recibida` mantenido por
trigger v93 desde `recepcion_lineas`.

**Importante:** stock_en_transito **NO** entra en `deficit_full` (regla v6
de `flex-full.ts`) — solo en `pedir_proveedor`.

**Ejemplo TXTPBL20200SK:** 30 uds (OC vigente).

### oc_pendientes

Cantidad de OCs distintas con líneas vivas para este SKU.

**Fuente:** count distinct `ordenes_compra.id` con líneas matcheando.

**Ejemplo TXTPBL20200SK:** 1.

### stock_proyectado

Stock total proyectado considerando órdenes en camino.

**Fórmula:** `stock_total + stock_en_transito` (alias práctico).

**Ejemplo TXTPBL20200SK:** 42 + 30 = 72.

### stock_proveedor, tiene_stock_prov

Cuánto stock dice el proveedor que tiene disponible (input manual desde
catálogo o capturado por admin).

**Fuente:** `proveedor_catalogo.stock_proveedor` o input manual.

**`tiene_stock_prov`** = boolean, `stock_proveedor > 0`.

**Ejemplo TXTPBL20200SK:** stock_proveedor=40, tiene_stock_prov=true.

### stock_sin_etiquetar

Subset de bodega que llegó del proveedor pero aún no tiene etiqueta MELI.
No se puede vender hasta etiquetarse.

**Fuente:** `recepcion_lineas` con `etiqueta_impresa=false`.

---

## §4 Cobertura

### cob_full, cob_flex, cob_total

Días que dura el stock al ritmo de venta actual.

**Fórmulas** (función `calcularCobertura` en `src/lib/reposicion.ts:107`):
```
cob_full  = stock_full / velFullCalc × 7      (días)
cob_flex  = stock_bodega / velFlexCalc × 7
cob_total = stock_total / velCalculo × 7

donde:
  velCalculo  = vel_ajustada_evento si evento, sino vel_ponderada (uds/semana)
  velFullCalc = velCalculo × pct_full
  velFlexCalc = velCalculo × pct_flex
```

Casos borde:
- Si `vel ≤ 0` → cob = `999` (centinela admisible, ver `inventory-policy` §1).
- Si `stock = 0` → cob = `0`.

**Código:** `src/lib/intelligence.ts:1151-1158`, `reposicion.ts:107-110`.

**Ejemplo TXTPBL20200SK** (verificado contra motor):
```
velCalculo  = vel_ajustada_evento = 23.27 uds/sem (Día Madre activo)
velFullCalc = 23.27 × 0.7 = 16.29 uds/sem
velFlexCalc = 23.27 × 0.3 = 6.98 uds/sem

cob_full  = 1 / 16.29 × 7 = 0.43 días   ✓ motor=0.43
cob_flex  = 41 / 6.98 × 7 = 41.12 días  (motor=35.88, diferencia probable
            por usar vel_flex original 6.15 en lugar de velFlexCalc 6.98)
cob_total = 42 / 23.27 × 7 = 12.63 días ✓ motor=12.63
```

⚠️ Cobertura Full crítica (0.43 días) es la señal que dispara
acción `URGENTE` cuando `cob_full < punto_reorden`.

### target_dias_full

Días objetivo de cobertura en Full por SKU. Hardcoded por ABC en
`intel_config`.

```
ABC=A → 42 días
ABC=B → 28 días
ABC=C → 14 días
```

**Fuente:** `intel_config.targetDiasA/B/C`. Hardcoded en
`intelligence.ts:387-389`.

**Pendiente policy:** valores derivan aproximadamente del manual
(`Parte1.md:545` "A 30-45d") pero no se citan literalmente.

**Ejemplo TXTPBL20200SK:** ABC=A → **target_dias_full=42**.

**Sprint 4.3a:** además del valor hardcoded en `intel_config`, el
template `policy_templates(cell)` lo expone por celda ABC×XYZ
(AX=42, AY=21, AZ=14, BX=28, BY=14, BZ=7, CX=14, CY=7, CZ=0). El
dashboard de reposición (`v_compras_pendientes`) usa el valor del
template, no el de `intel_config`. Cuando ambos divergen, gana el
template (más fino que el viejo split por sólo ABC).

### target_dias_flex

**Sprint 4.3a (2026-05-04).** Días objetivo de cobertura en bodega
para venta Flex multi-canal. Independiente de `target_dias_full`.

| Cell | target_dias_flex | Cell | target_dias_flex | Cell | target_dias_flex |
|---|---|---|---|---|---|
| AX | 7 | BX | 5 | CX | 3 |
| AY | 5 | BY | 3 | CY | 2 |
| AZ | 3 | BZ | 2 | CZ | 0 |

Fórmula derivada:
```
reserva_flex_target = round(d_avg_dia × target_dias_flex)
```

donde `d_avg_dia = d_avg_sem_efectivo / 7` (la velocidad efectiva
post-elección de motor: vel_pre_quiebre, vel_evento o vel_ponderada,
× factor_rampup).

**Fuente:** `policy_templates.target_dias_flex` (override por SKU vía
`sku_node_policy.target_dias_flex` — backfill auto desde template).

**Rationale:** Sprint 4.3a separa la cobertura Full (target_dias_full)
de la reserva en bodega para Flex. Antes el dashboard suponía que la
bodega cubría sólo cycle_stock (LT_supplier días). Ahora reserva
explícitamente días adicionales para no quedar sin stock Flex cuando
Full está pre-posicionado pero los pedidos Flex llegan al mismo
tiempo.

**Ejemplo TXV23QLAT20NG (AY, 1.51 uds/día):**
`reserva_flex_target = round(1.51 × 5) = 8 uds`.

### flex_priority

**Sprint 4.3a (2026-05-04).** Política de prioridad de canal por SKU.

| Valor | Significado |
|---|---|
| `default` | Multi-canal balanceado (Full + reserva Flex). Default. |
| `only_flex` | SKU sólo se vende Flex (no se manda a Full). |
| `only_full` | SKU sólo se vende Full (no reserva Flex). |
| `manual_split` | Admin define el split manualmente. |

Hoy todas las filas son `default` — la política está expuesta en la
UI (`SkuExplainPanel`) pero no hay endpoint de override aún. Roadmap
Sprint 4.4+.

**Fuente:** `sku_node_policy.flex_priority`.

### Detección de tendencia (Sprint 4.3b)

**Problema:** la reclasificación oficial ABC×XYZ del motor viejo usa
ventana 90 días. Un SKU C que acelera en la última semana tarda 30+
días en moverse a B. Mientras tanto la política de C lo subdimensiona.

**Solución:** overlay temporal en SQL que detecta cambios en 4-7 días
sin modificar el motor viejo.

#### Velocidades por ventana

```
vel_recent_sem    = round(uds_28d / 4, 2)         -- últimas 4 semanas
vel_previous_sem  = round(uds_28d_previas / 4, 2) -- 4 semanas previas (días 29-56)
vel_baseline_sem  = round(uds_90d / (90/7), 2)    -- baseline 90 días
```

donde `uds_X = SUM(ventas_ml_cache.cantidad × composicion_venta.unidades)`
filtrando `anulada = false` y la ventana correspondiente.

**Fuente:** `v_trend_detection`.

#### Ratios

```
ratio_recent_vs_previous = vel_recent_sem / NULLIF(vel_previous_sem, 0)
ratio_recent_vs_baseline = vel_recent_sem / NULLIF(vel_baseline_sem, 0)
```

#### Clasificación de tendencia

| Tendencia | Regla | Acción de policy |
|---|---|---|
| `acelerando_fuerte` | `ratio_prev ≥ 2.0` AND `uds_28d ≥ 5` | Promueve celda ABC |
| `acelerando` | `ratio_prev ≥ 1.5` AND `ratio_baseline ≥ 1.3` AND `uds_28d ≥ 3` | Promueve celda ABC |
| `desacelerando` | `ratio_prev ≤ 0.5` AND `ratio_baseline ≤ 0.7` AND `uds_28d_previas ≥ 3` | Sólo flag |
| `desacelerando_fuerte` | `ratio_prev ≤ 0.3` AND `uds_28d_previas ≥ 5` | Sólo flag |
| `insuficiente_data` | `uds_90d < 5` | Sólo flag |
| `estable` | default | Sin cambio |

**Por qué dos ratios para `acelerando`:** evita falsos positivos donde
las 4 semanas previas eran anómalamente bajas (cold start o rebote
post-quiebre). El baseline 90d filtra eso.

**Por qué desacelerando NO degrada automáticamente:** ir a `CZ` activa
política `no_reorder`. Una desaceleración temporal (estacionalidad,
quiebre upstream) podría congelar compras justo cuando se va a recuperar.
Decisión humana.

**Fuente:** `v_trend_detection.tendencia`.

### cell_efectiva (overlay de promoción)

**Sprint 4.3b.** Cuando un SKU acelera, su celda efectiva se promueve
una letra ABC arriba; XYZ se preserva (la variabilidad relativa no
cambia con el volumen).

```
calc_cell_efectiva(cell, tendencia):
  IF tendencia IN ('acelerando', 'acelerando_fuerte') THEN
    CX | CY | CZ → BX | BY | BZ
    BX | BY | BZ → AX | AY | AZ
    AX | AY | AZ → sin cambio
  ELSE cell
```

`v_safety_stock` usa `cell_efectiva` para resolver `z` y
`target_dias_full` desde `policy_templates`:
- BZ→AZ: `target_dias_full` 7 → 14 (pre_full_target se duplica).
- BY→AY: `target_dias_full` 14 → 21.
- BX→AX: `target_dias_full` 28 → 42.

`target_dias_flex` queda como override per-SKU (no se promueve), porque
la cobertura Flex es decisión operativa, no derivada de la celda.

**Fuente:** `sku_node_policy.cell_efectiva` (refrescada por cron diario
`/api/policy/sync-trend-detection` 12:00 UTC).

**Trazabilidad:** `cell_original` (siempre = `cell` del motor viejo) +
`cell_efectiva` + `promocion_activa` + `promocion_motivo`.

### dias_sin_stock_full

Días corridos contando desde que `stock_full = 0` por última vez.

**Fórmula:**
```
si stock_full > 0:
    dias_sin_stock_full = 0
    fecha_entrada_quiebre = null
sino:
    si fecha_entrada_quiebre is null:
        fecha_entrada_quiebre = hoy
    dias_sin_stock_full = (hoy − fecha_entrada_quiebre)
```

**Importante:** se usa **fecha ancla** (`fecha_entrada_quiebre`), no
contador incrementado por recálculo. Esto fue un bug histórico (PR5
`f11eb07`, "centinela 2071") documentado en `inventory-policy` §1.

**Código:** `src/lib/intelligence.ts:590-636` (`resolverDiasEnQuiebre`).

**Ejemplo TXTPBL20200SK:** stock_full=1>0 → dias_sin_stock_full = 34 (capturado
de un quiebre anterior, ya saliendo).

### fecha_entrada_quiebre, fecha_entrada_quiebre_flex

Fecha en que el SKU entró al estado quebrado (Full=0 o Flex=0).

**Fuente:** snapshot anterior de `sku_intelligence`. Se preserva entre
recálculos; solo se resetea cuando el stock vuelve.

### dias_en_quiebre, dias_en_quiebre_flex

Igual a `dias_sin_stock_full` pero distinguiendo canal Full vs Flex.

### es_quiebre_proveedor

Boolean: ¿el quiebre es porque el proveedor no tiene stock?

**Fuente:** flag derivado de `tiene_stock_prov=false` cuando hay
`AGOTADO_PEDIR`.

---

## §5 Margen

### margen_full_7d, margen_full_30d, margen_full_60d

Margen $ generado por canal Full en cada ventana.

**Fórmula:**
```
margen_full_Xd = sum(margen_neto) FROM ventas_ml_cache
                 WHERE canal='Full' AND ventana=Xd AND anulada=false
```

**Fuente:** `ventas_ml_cache.margen_neto` (calculado por ProfitGuard al
sincronizar).

**Ejemplo TXTPBL20200SK:** margen_full_7d=$11.329 · _30d=$10.868 · _60d=$10.864.

### margen_flex_7d/30d/60d

Idem para canal Flex.

**Ejemplo TXTPBL20200SK:** margen_flex_7d=$18.809 · _30d=$17.723 · _60d=$17.631.

### margen_tendencia_full, margen_tendencia_flex

`calcTendencia(margen_X_7d, margen_X_30d)` — misma función que vel.

**Ejemplo TXTPBL20200SK:** ambos "estable" (variación < 10%).

### canal_mas_rentable

`"flex" | "full"` según cuál tiene mejor margen por unidad.

**Fórmula:**
```
margen_unitario_flex = margen_flex_30d / uds_flex_30d
margen_unitario_full = margen_full_30d / uds_full_30d
canal_mas_rentable = el canal con mayor margen unitario
```

**Ejemplo TXTPBL20200SK:** **canal_mas_rentable="flex"** (margen flex/u >
full/u).

### precio_promedio

Precio promedio ponderado por unidades vendidas en últimos 30 días.

**Fórmula:**
```
precio_promedio = sum(total_neto) / sum(unidades)
```

**Ejemplo TXTPBL20200SK:** $58.748.

### ingreso_30d, margen_neto_30d, uds_30d

Ingreso ($), margen neto ($), unidades vendidas en últimos 30d (filtrado
`anulada=false`).

**Ejemplo TXTPBL20200SK:** ingreso=$4.521.834 · margen_neto=$873.158 · uds=67.

---

## §6 Pareto ABC

El motor calcula 3 ABCs independientes (margen, ingreso, unidades) y
combina.

### abc_margen, abc_ingreso, abc_unidades

**Fórmula** (función `paretoABC` en `intelligence.ts:1703-1722`):

```
1. ordenar todos los SKUs por la métrica (descendente)
2. acumular el porcentaje sobre el total
3. clasificar:
   - SKUs hasta 80% acumulado → "A"
   - SKUs hasta 95% acumulado → "B"
   - resto → "C"
```

**Inputs:** `margen_neto_30d`, `ingreso_30d`, `uds_30d` de cada SKU.

**Ejemplo TXTPBL20200SK:** abc_margen="A" · abc_ingreso="A" · abc_unidades="A".

### pct_ingreso_acumulado, pct_margen_acumulado, pct_unidades_acumulado

Porcentaje del total acumulado hasta este SKU en cada eje. Sirve para
visualizar el corte ABC.

**Ejemplo TXTPBL20200SK:** pct_ingreso=6.24% · pct_margen=4.37% · pct_unidades=14.23%.

### abc

ABC consolidado: el **máximo** entre los 3 ejes (peor caso = más exigente).

**Fórmula:**
```
abc = max(abc_margen, abc_ingreso, abc_unidades)   # A > B > C
```

**Razón:** si un SKU es A en cualquier eje, el motor lo trata como A.

**Pendiente:** memoria `project_banva_abc_xyz_state` — 181 SKUs en
"REVISAR" sanos por la mecánica relativa. ABC oscila día a día (visto en
auditoría 2026-05-01).

**Ejemplo TXTPBL20200SK:** **abc=A**.

### abc_pre_quiebre

ABC capturado antes de entrar en quiebre. Sirve para no degradar la
clasificación durante el quiebre cuando las ventas caen.

---

## §7 XYZ

### desviacion_std (σ_D)

Desviación estándar de la demanda semanal en últimos 60 días.

**Fórmula** (función `mediaYDesviacion` en `intelligence.ts:519`):
```
1. agrupar ventas por semana (8-9 semanas)
2. media = sum(uds_semanales) / n_semanas
3. desviacion_std = sqrt(sum((x-media)²) / n)
```

**Unidad:** uds/semana.

**Inputs:** ventas semanales filtradas por `anulada=false`.

**Código:** `src/lib/intelligence.ts:519-525`, `1188-1197`.

**Ejemplo TXTPBL20200SK:** σ_D = 6.83 uds/semana.

### cv (coefficient of variation)

```
cv = desviacion_std / media_semanal
```

Sirve de input al XYZ.

**Ejemplo TXTPBL20200SK:** cv=0.53.

### xyz

Clasificación de **predictibilidad**.

**Fórmula:**
```
si cv < 0.5  → xyz = "X"   (estable, predecible)
si cv < 1.0  → xyz = "Y"   (moderado)
sino         → xyz = "Z"   (errático)
```

**Código:** `src/lib/intelligence.ts:1193-1197`.

**Ejemplo TXTPBL20200SK:** cv=0.53 → **xyz="Y"**.

---

## §8 Cuadrante

Matriz 2×2 sobre **margen** × **unidades** (excluye eje ingreso).

### cuadrante

**Fórmula** (cuadrante derivado de la posición ABC en margen y unidades):

```
            uds A         uds B/C
margen A    ESTRELLA     CASHCOW
margen B/C  REVISAR      PERRO
```

| Cuadrante | Significado | Política |
|---|---|---|
| **ESTRELLA** | Alto margen + alto volumen | Proteger stock, target_dias_full alto |
| **CASHCOW** | Alto margen + bajo volumen | Mantener, no priorizar OC |
| **REVISAR** | Bajo margen + alto volumen | Subir precio o liquidar |
| **PERRO** | Bajo margen + bajo volumen | Liquidar, no reordenar |

**Código:** `src/lib/intelligence.ts` (lógica del cuadrante post-Pareto).

**Ejemplo TXTPBL20200SK:** abc_margen=A + abc_unidades=A → **cuadrante=ESTRELLA**.

---

## §9 Safety stock y ROP

### nivel_servicio (CSL)

Probabilidad objetivo de NO quebrar durante un ciclo de reposición.

**Hoy** (`intelligence.ts:1825-1828`): por ABC, no plano:
```
ABC=A → 0.97
ABC=B → 0.95 (default)
ABC=C → 0.90
```

**Lo que prescribe el manual** (sin implementar): matriz por ABC×XYZ
diferenciada (9 valores):
- AX 99% / AY 98% / AZ 93-95% (no subir z, comprimir LT)
- BX 97% / BY 95% / BZ 92%
- CX-CZ "automático/no reordenar"

**Ejemplo TXTPBL20200SK:** ABC=A → **nivel_servicio=0.97**.

### zScore(nivel_servicio)

Conversión de % servicio a factor z (de la tabla normal).

**Tabla** (`intelligence.ts:536-555`):
```
0.99 → z=2.33
0.97 → z=1.88
0.95 → z=1.65
0.93 → z=1.48
0.90 → z=1.28
```

**Ejemplo TXTPBL20200SK:** nivel_servicio=0.97 → **z=1.88**.

### lead_time_usado_dias, lead_time_fuente

Lead time del proveedor que usa el motor para SS y ROP.

**Cascada:**
```
1. lead_time_real_dias (medido por motor desde OCs reales)  → "real"
2. proveedores.lead_time_dias (manual o fallback)            → "manual_proveedor" / "fallback"
3. default 7d                                                 → "default"
```

**Estado actual:** 0/86 proveedores tienen `lt_muestras > 0`. Idetex tiene
lead_time_dias=5 manual. Resto fallback=7.

**Ejemplo TXTPBL20200SK:** lead_time_usado=5 días · fuente="manual_proveedor".

### safety_stock_simple

Fórmula clásica que solo considera σ_D (varianza demanda).

**Fórmula:**
```
SS_simple = z × σ_D × √(LT_semanas)
```

**Código:** `src/lib/intelligence.ts:1843-1848`.

**Ejemplo TXTPBL20200SK:** 1.88 × 6.83 × √(5/7) = 1.88 × 6.83 × 0.845 =
**~10.85 uds** (coincide con el dato real).

### safety_stock_completo

Fórmula completa que incluye **σ_LT** (varianza lead time).

**Fórmula** (la que prescribe `Parte1.md:507`):
```
SS_completo = Z × √(LT_sem × σ_D² + D² × σ_LT_sem²)
```

donde **todo está en unidades semanales**:
- Z = factor de servicio (de la tabla normal)
- LT_sem = lead_time / 7 (días → semanas)
- σ_D = desviación estándar demanda semanal (`r.desviacion_std`)
- D = demanda semanal (`r.vel_ponderada`)
- σ_LT_sem = sigma_lt / 7

**Código:** `src/lib/intelligence.ts:1853-1862`.

**Política:** usa la completa si σ_D > 0 OR σ_LT_sem > 0; sino fallback a simple.

**Limitación actual:** σ_LT = 1.5 plano para todos los proveedores
(fallback). NO está medido por OC real. La componente de varianza LT del
SS está calibrada con un default arbitrario.

**Ejemplo TXTPBL20200SK** (verificado 2026-05-01 contra motor):
```
Z = 1.88 (ABC=A → CSL=0.97)
LT_sem = 5/7 = 0.714
σ_D = 6.83 uds/semana
D = vel_ponderada = 17.9 uds/semana
σ_LT_sem = 1.5/7 = 0.214

SS = 1.88 × √(0.714 × 6.83² + 17.9² × 0.214²)
   = 1.88 × √(0.714 × 46.65 + 320.41 × 0.0458)
   = 1.88 × √(33.31 + 14.67)
   = 1.88 × √47.98
   = 1.88 × 6.93
   = 13.02
```

✅ Motor reporta **13.03** — coincide.

### safety_stock_fuente

`"formula_completa" | "fallback_simple"` según cuál se aplicó.

**Ejemplo TXTPBL20200SK:** "formula_completa".

### punto_reorden, rop_calculado

ROP (reorder point): nivel de stock que dispara una nueva OC.

**Fórmulas:**
```
punto_reorden = D × LT_sem + safety_stock_simple    # legacy, sin σ_LT
rop_calculado = D × LT_sem + safety_stock_completo  # nuevo, con σ_LT
```

donde D y LT están en uds/semana y semanas respectivamente.

**Código:** `src/lib/intelligence.ts:1862` (rop_calculado),
`intelligence.ts:1849` (punto_reorden).

**Ejemplo TXTPBL20200SK** (verificado contra motor):
```
ROP = D × LT_sem + SS_completo
    = 17.9 × 0.714 + 13.02
    = 12.78 + 13.02
    = 25.80
```

✅ Motor reporta **25.82** — coincide.

**Interpretación:** cuando `stock_total ≤ ROP` el motor marca
`necesita_pedir=true`. Para TXTPBL20200SK hoy: stock_total=72 (1+41+30) >
25.82 → no necesita pedir nuevo (ya hay OC en tránsito).

### necesita_pedir

Boolean gate.

**Fórmula:**
```
necesita_pedir = (stock_total ≤ rop_calculado) AND (vel_ponderada > 0)
```

**Ejemplo TXTPBL20200SK:** stock_total=42 vs rop=25.82 → 42>25.82 →
**necesita_pedir=false**.

---

## §10 GMROI y DIO

### gmroi (Gross Margin Return on Inventory Investment)

Margen anual generado por cada $1 invertido en inventario.

**Fórmula:**
```
margen_bruto_anual = margen_neto_30d × 12
gmroi = margen_bruto_anual / costo_inventario_total
```

**Interpretación:** GMROI=10 significa que cada $1 invertido en stock genera
$10 de margen anual. Saludable > 3.

**Código:** `src/lib/intelligence.ts:1252`.

**Ejemplo TXTPBL20200SK:** margen anual = $873.158 × 12 = $10.477.896.
costo_inventario_total = $24.000 × 42 = $1.008.000 (stock_total × costo).
gmroi = 10.39 ≈ **10.03** (reportado).

### dio (Days Inventory Outstanding)

Cuántos días tarda en venderse el stock actual.

**Fórmula:**
```
dio = stock_total / vel_ponderada × 7
```

(idéntica a `cob_total`).

**Ejemplo TXTPBL20200SK:** dio = **16.42 días**.

### costo_inventario_total

```
costo_inventario_total = stock_total × costo_neto
```

**Ejemplo TXTPBL20200SK:** 42 × $24.000 = **$1.008.000** (reportado:
$1.199.520 — diferencia probablemente por usar costo_bruto $28.560 ×
42 = $1.199.520 ✓).

---

## §11 Acción y prioridad

### accion

Etiqueta de qué hay que hacer con el SKU. Lookup-table 11 valores.

**Fórmula** (decision tree, `intelligence.ts:1439-1456`):

```
si vel=0 AND vel_pre=0 AND stock_total=0:
    accion="INACTIVO" prioridad=99
sino si esNuevo AND mov reciente AND Full=0 AND bodega>0:
    accion="MANDAR_FULL" prioridad=10
sino si esNuevo AND mov reciente:
    accion="NUEVO" prioridad=50
sino si vel=0 AND vel_pre=0 AND stock_total>0:
    accion="DEAD_STOCK" prioridad=80
sino si Full=0 AND (velFull>0 OR enQuiebreProlongado) AND bodega>0:
    accion="MANDAR_FULL" prioridad=10
sino si Full=0 AND (velFull>0 OR enQuiebre) AND bodega=0 AND (proveedor sin stock):
    accion="AGOTADO_SIN_PROVEEDOR" prioridad=3
sino si Full=0 AND (velFull>0 OR enQuiebre) AND bodega=0:
    accion="AGOTADO_PEDIR" prioridad=5
sino si cob_full < punto_reorden AND cob_full < 999:
    accion="URGENTE" prioridad=15
sino si cob_full < 30:
    accion="PLANIFICAR" prioridad=40
sino si cob_full <= cobMaxima (config):
    accion="OK" prioridad=60
sino:
    accion="EXCESO" prioridad=70

# Override final: si URGENTE o AGOTADO_PEDIR pero hay tránsito
si (accion in [URGENTE, AGOTADO_PEDIR]) AND stock_en_transito > 0:
    accion="EN_TRANSITO" prioridad=25
```

**Inputs:** todas las métricas anteriores.

**Código:** `src/lib/intelligence.ts:1439-1462`.

**Ejemplo TXTPBL20200SK:** Full=1 (no es 0), cob_full=0.43 < punto_reorden
(25.82) → URGENTE. Pero stock_en_transito=30 > 0 → override **accion=EN_TRANSITO
prioridad=25**. (El sistema reporta accion=EN_TRANSITO.)

### prioridad

Número entre 3 y 99. **Menor = más urgente.**

Tabla:
| Prioridad | Significado |
|---|---|
| 3 | Crítico (sin proveedor) |
| 5 | Pedir ya |
| 10 | Mandar Full |
| 15 | Urgente cobertura |
| 25 | En tránsito (esperar) |
| 40 | Planificar próxima OC |
| 50 | Nuevo (observar) |
| 60 | OK |
| 70 | Exceso (revisar) |
| 80 | Dead stock |
| 99 | Inactivo |

---

## §12 Mandar al Full (split bodega/Full)

### mandar_full

Cuántas unidades de bodega trasladar al CD MELI ahora.

**Fórmula** (función canónica `calcularEstadoFlexFull` en `flex-full.ts`,
v7 desde 2026-05-01):

```
targetFullUds       = vel × pct_full × target_dias_full / 7
deficit_full        = max(0, ceil(targetFullUds − stock_full))
disponibleParaFull  = max(0, stock_bodega − buffer_ml)
mandar_full         = min(deficit_full, disponibleParaFull)
```

donde:
- `vel` = `vel_ajustada_evento` si hay evento, sino `vel_ponderada`
- `buffer_ml` = 2 si SKU no compartido, 4 si aparece en >1 publicación ML

**Código:** `src/lib/flex-full.ts:71-93`, llamado desde
`intelligence.ts:1913-1925`.

**Policy:** `/docs/policies/inventario.md` P-INV-1 (cycle stock va a Full
primero, manual `Parte1.md:577-578`).

**Ejemplo TXTPBL20200SK:**
```
vel = 23.27 (con evento Día Madre)
pct_full = 0.7, target = 42 días
targetFull = 23.27 × 0.7 × 42/7 = 97.73
deficit_full = ceil(97.73 - 1) = 97
disponibleParaFull = max(0, 41 - 2) = 39
mandar_full = min(97, 39) = 39
```

### publicar_flex

Cuántas unidades publicar en MELI como Flex (descuenta buffer y respeta
pack de venta).

**Fórmula:**
```
para_flex = stock_bodega − mandar_full
publicable_fisico = max(0, para_flex − buffer_ml)
publicar_flex = floor(publicable_fisico / unidades_pack_venta)
```

**Ejemplo TXTPBL20200SK:** para_flex = 41-39 = 2, publicable = 0,
publicar_flex = 0.

---

## §13 Pedir al proveedor

### pedir_proveedor_sin_rampup

Cuánto pedir al proveedor antes de aplicar el rampup post-quiebre.

**Fórmula:**
```
demanda_ciclo     = vel_para_pedir × target_dias_full / 7
cantidad_objetivo = demanda_ciclo + safety_stock_completo
stock_total_pedido= stock_full + stock_bodega + stock_en_transito
pedir_sin_rampup  = max(0, ceil(cantidad_objetivo − stock_total_pedido))
```

**`vel_para_pedir`** (cascada por estado quiebre):
- Si quiebre prolongado AND protegido → `vel_pre_quiebre`
- Si quiebre flex prolongado → `max(vel, vel - vel_flex + vel_flex_pre_quiebre)`
- Default → `vel_ajustada_evento` (si evento) o `vel_ponderada`

**Código:** `src/lib/intelligence.ts:1882-1939`.

**Ejemplo TXTPBL20200SK:**
```
vel_para_pedir = 23.27 (evento)
demanda_ciclo = 23.27 × 42/7 = 139.6
objetivo = 139.6 + 13.03 = 152.6
stock_total_pedido = 1 + 41 + 30 = 72
pedir_sin_rampup = max(0, ceil(152.6 - 72)) = 81
```

(Sistema reporta 84 — discrepancia probablemente por `vel_para_pedir`
exacto del cron vs reproducción manual.)

### factor_rampup_aplicado, rampup_motivo

Multiplicador post-quiebre para acelerar recuperación.

**Fórmula** (`src/lib/rampup.ts`):
```
si SKU saliendo de quiebre prolongado (vel_pre_quiebre > vel actual):
    factor = 1.5 a 2.0 según severidad
sino:
    factor = 1.0
    motivo = "no_aplica"
```

**Ejemplo TXTPBL20200SK:** factor=1.00, motivo="no_aplica" (nunca
quebrado).

### pedir_proveedor

```
pedir_proveedor = pedir_proveedor_sin_rampup × factor_rampup_aplicado
```

**Ejemplo TXTPBL20200SK:** 84 × 1.0 = **84 uds**.

### pedir_proveedor_bultos

```
pedir_proveedor_bultos = ceil(pedir_proveedor / inner_pack)
```

**Ejemplo TXTPBL20200SK:** 84 / 2 = **42 bultos**.

---

## §14 Liquidación

### liquidacion_accion, liquidacion_dias_extra, liquidacion_descuento_sugerido

Acción de liquidación basada en cuántos días lleva el stock sin moverse vs target.

**Fórmula** (lógica `intelligence.ts`, bandas DIO):
```
dias_extra = max(0, dio − target_dias_full)
si dias_extra >= 90:
    accion="LIQUIDAR_AGRESIVO" descuento=40%
sino si dias_extra >= 60:
    accion="LIQUIDAR" descuento=25%
sino si dias_extra >= 30:
    accion="MARKDOWN" descuento=10%
sino:
    accion=null descuento=0
```

**Conflicto documentado:** la cascada de pricing usa otras bandas
(90/120/180 con -20/-40/-60) — auditoría
`inteligencia_vs_manuales_2026-04-28.md` H4. Pendiente policy unificada.

**Ejemplo TXTPBL20200SK:** dio=16.42 < target=42 → dias_extra=0 →
**liquidacion_accion=null**.

---

## §15 Oportunidad perdida

### venta_perdida_uds

Unidades que se hubieran vendido si no hubiera quiebre.

**Fórmula:**
```
venta_perdida_uds = vel_ponderada × dias_sin_stock_full
```

**Ejemplo TXTPBL20200SK:** 17.9 × ~3.2 (días reales) = ~57 uds (reportado).

### venta_perdida_pesos

```
si margen_full_30d > 0:
    margen_unitario = margen_full_30d / uds_full_30d
sino si margen_full_60d > 0:
    margen_unitario = margen_full_60d / uds_full_60d
sino si precio_promedio > 0:
    margen_unitario = precio_promedio × 0.25      # fallback estimación
sino:
    margen_unitario = 0

venta_perdida_pesos = venta_perdida_uds × margen_unitario
```

**`oportunidad_perdida_es_estimacion`** = true si se usó el fallback
`precio × 0.25`.

**Código:** `src/lib/intelligence.ts:1367-1385`.

**Ejemplo TXTPBL20200SK:** venta_perdida_pesos = $620.087.

### ingreso_perdido

```
ingreso_perdido = venta_perdida_uds × precio_promedio
```

(Es ingreso bruto, no margen).

**Ejemplo TXTPBL20200SK:** 57 × $58.748 = **$3.349.636** (reportado: $3.351.940).

### gmroi_potencial

GMROI proyectado si se restablece el stock al pre-quiebre.

**Fórmula:**
```
margen_anual_pot = vel_pre_quiebre × 365 × margen_unitario_pre_quiebre
costo_inv_pot    = costo_bruto × vel_pre_quiebre × (target_dias_full / 7)
gmroi_potencial  = margen_anual_pot / costo_inv_pot
```

---

## §16 Alertas

### alertas (array), alertas_count

31 tipos posibles, lista en `intelligence.ts:81-130`. Algunas:

| Alerta | Trigger |
|---|---|
| `urgente` | cob_full < punto_reorden |
| `agotado_full` | stock_full = 0 |
| `flex_no_publicado` | publicar_flex = 0 con stock_bodega > 0 |
| `caida_demanda` | tendencia_vel = "bajando" |
| `pico_demanda` | es_pico = true |
| `evento_activo` | multiplicador_evento > 1 |
| `en_transito` | stock_en_transito > 0 |
| `reponer_proactivo` | accion = MANDAR_FULL anticipativo |
| `sin_stock_proveedor` | tiene_stock_prov = false |
| `estrella_quiebre_prolongado` | cuadrante=ESTRELLA AND dias_en_quiebre > umbral |
| `liquidar` | liquidacion_accion ≠ null |
| `forecast_descalibrado` | wmape_8s > umbral |
| `forecast_sesgo_sostenido` | tracking_signal_8s fuera de banda |

**Código:** `src/lib/intelligence.ts:2080-2115` (push de alertas).

**Ejemplo TXTPBL20200SK:** alertas = ["reponer_proactivo", "urgente",
"evento_activo", "en_transito"], alertas_count=4.

---

## §17 Métricas de tracking de calidad del forecast

### forecast_wmape_8s, forecast_bias_8s, forecast_tracking_signal_8s

Calidad del forecast en últimas 8 semanas.

**Fuente:** `src/lib/forecast-accuracy.ts`. Calcula cada cron y guarda en
`forecast_accuracy` y duplica en `sku_intelligence`.

**Estado:** TSB shadow no se consume todavía. Estos campos están null hasta
que TSB esté en producción.

### tsb_alpha, tsb_beta, vel_ponderada_tsb, tsb_modelo_usado

Parámetros del modelo TSB (Teunter-Syntetos-Babai) si está activo.

**Estado:** `tsb_modelo_usado` = "sma_ponderado" para todos los SKUs (TSB
no consumido). Ver `src/lib/tsb.ts`.

---

## §18 Conteo y movimientos

### ultimo_conteo, dias_sin_conteo, diferencias_conteo

Última vez que el SKU fue contado físicamente y cuántas discrepancias
acumuló.

**Fuente:** tabla `conteos` (con `lineas` jsonb).

### ultimo_movimiento, dias_sin_movimiento

Última vez que hubo cambio de stock (entrada, salida, transferencia).

**Fuente:** tabla `movimientos` MERGED con `ventas_ml_cache` (último canal
ventas Full, ya que los envíos Full no generan movimiento). Memoria
`feedback_dual_route_sync` documenta este merge crítico.

**Código:** `src/lib/intelligence.ts:844-873`.

---

## §19 Estacionalidad

### es_estacional, estacional_motivo, estacional_marcado_por, estacional_marcado_at

Flag manual de SKU estacional. Si true, el motor usa lógica diferente para
no liquidar fuera de temporada.

**Fuente:** captura manual desde admin (no auto-detectado).

### primera_venta, dias_desde_primera_venta

Trazabilidad de antigüedad del SKU.

**Fuente:** MIN(`ventas_ml_cache.fecha_date`) por sku_origen.

---

## §20 Holdout

### es_holdout, holdout_asignado_at

SKUs en grupo de control para experimentos (ej. testear nueva política sin
exponer todos los SKUs).

**Fuente:** flag manual. No usado activamente en producción hoy.

---

# Parte 4 — Cómo investigar un SKU paso a paso

Cuando un SKU sorprende ("¿por qué dice X?"), el procedimiento canónico:

1. **Buscar el SKU en la tabla `sku_intelligence`** y leer todas sus columnas.
2. **Identificar la métrica problemática** (ej. `mandar_full = 0`).
3. **Subir por la cadena de inputs** usando este documento:
   - `mandar_full` ← `deficit_full` ← `targetFullUds` ← `vel_ajustada_evento` ← `vel_ponderada` ← `vel_7d/30d/60d` ← ventas raw
4. **Verificar fuentes**: si los inputs se ven raros, ir a la tabla canónica
   (ej. consultar `ventas_ml_cache` para chequear si las ventas se contaron
   bien).
5. **Reproducir la fórmula** con los valores que ves para confirmar que el
   resultado coincide. Si no coincide → bug del motor o documentación
   desactualizada (abrir PR).

**Ejemplo realizado:** auditoría
`docs/auditorias/quiebres-full-9skus-2026-05-01.md` reconstruyó por qué 9
SKUs llegaron a Full=0, exactamente con este método.

---

# Parte 5 — Gaps conocidos del modelo (datos faltantes)

Para entender el contexto de las fórmulas, leer también:

- `/docs/auditorias/inteligencia_vs_manuales_2026-04-28.md` — auditoría
  completa motor vs manuales (31 hallazgos H1-H31).
- `/docs/auditorias/quiebres-full-9skus-2026-05-01.md` — caso testigo de
  quiebres reales y causas raíz.

Datos que el motor **no tiene hoy** y debería tener para aplicar
plenamente las fórmulas del manual:

| Dato | Para qué fórmula | Estado |
|---|---|---|
| `lead_time_real_dias` (medido por OC) | SS completo, ROP | 0/509 SKUs poblado |
| `lead_time_real_sigma` (σ_LT real) | SS completo | 0/509 |
| Costo fijo de hacer una OC (S) | EOQ | No existe columna |
| Costo de mantener inventario (H, %) | EOQ, decisión liquidar | No existe |
| Service level por ABC×XYZ | SS diferenciado | Plano 0.97 |
| MOQ real por proveedor | Restricción OC | Plano = 1 |
| Tabla descuentos por volumen | EOQ con descuentos | No existe |
| Forecast probabilístico p10/p50/p90 | SS sobre incertidumbre | TSB shadow no consumido |
