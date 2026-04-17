# PR3 (TSB) — Pre-auditoría

Fecha: 2026-04-17. Sin código — diagnóstico sobre el estado actual para decidir scope y timing de PR3.

## 1. Clase Z hoy

| Métrica | Valor |
|---|---:|
| Total SKUs | **533** |
| `xyz='X'` (CV < 0.5, regular) | 22 (4.1 %) |
| `xyz='Y'` (0.5 ≤ CV < 1.0) | 112 (21.0 %) |
| **`xyz='Z'` (CV ≥ 1.0, irregular)** | **399 (74.9 %)** |

Dentro de Z:

| Segmento | SKUs | % de Z |
|---|---:|---:|
| Z con `abc='A'` | 15 | 3.8 % |
| Z con `abc='B'` | 33 | 8.3 % |
| Z con `abc='C'` | 351 | **88.0 %** |
| Z con `vel_ponderada = 0` | 237 | **59.4 %** |
| Z con `vel_ponderada > 0` | **162** | 40.6 % |

**Percentiles de `vel_ponderada` en los 162 Z con vel > 0 (uds/sem):**

| p10 | p25 | p50 | p75 | p90 | avg | max |
|---:|---:|---:|---:|---:|---:|---:|
| 0.07 | 0.19 | **0.60** | 1.16 | 1.73 | 0.89 | 9.56 |

**Lectura:** el universo "vivo" de Z son **162 SKUs** (no 399 — los 237 con vel=0 ya son atrapados por `DEAD_STOCK` / `INACTIVO` y no se benefician de un mejor modelo de forecast). El p50 de 0.60 uds/sem = **~31 uds/año**. Demanda rara + volumen chico.

## 2. Intermitencia real en ventas (últimas 12 semanas)

| Métrica | Valor |
|---|---:|
| SKUs Z con vel>0 evaluados | 162 |
| % semanas con 0 ventas (promedio) | **65.3 %** |
| % semanas con 0 ventas (p50) | 66.7 % |
| Intervalo promedio entre ventas | **3.08 semanas** |
| Muy intermitentes (≥70 % semanas en cero) | 72 (44.4 %) |
| Intermitentes (30–70 % en cero) | 83 (51.2 %) |
| "Regulares" (<30 % en cero) | 7 (4.3 %) |

**Lectura:** 96 % de los Z con vel>0 son genuinamente intermitentes (≥30 % semanas en cero). TSB / Croston / SBA son el modelo correcto para ese 96 %. Los 7 "regulares" probablemente están mal-clasificados como Z (alto CV por escala chica, no por intermitencia); en un PR posterior conviene revisar el umbral CV.

### Top 10 Z con mayor `vel_ponderada` — patrón 12 semanas

| SKU | Cuadrante / ABC | Vel | Serie (sem 1-12) | Diagnóstico |
|---|---|---:|---|---|
| TXSB144ISY10P — Sab Illusions Infantil | ESTRELLA A | 9.56 | `2 6 8 3 3 0 2 9 3 12 20 13` | **MAL-CLASIFICADO Z**: vende casi todas las semanas, con alta varianza (CV>1 por escala) |
| TXV25QLBRBG25 — Quilt Breda 25P Beige | ESTRELLA A | 6.22 | `0 0 0 0 0 0 0 0 6 3 10 6` | **LANZAMIENTO** — arranca sem 9. TSB subestimaría (historia de ceros) |
| TXSC2PVLBEIGE — Set Cortinas Velo | VOLUMEN B | 5.89 | `0 3 5 5 3 3 1 0 4 2 1 10` | Intermitente clásico + pico reciente |
| TEXCCWTILL10P — Cubrecolchón | REVISAR B | 5.39 | `0 0 20 28 79 75 21 28 18 1 0 0` | **PICO Y CAÍDA** — obsolescencia. TSB ideal |
| TXV23QLRM20GR — Quilt Roma Gris | ESTRELLA A | 3.94 | `0 0 1 4 1 0 8 5 0 6 14 7` | Intermitente creciente |
| PRO-LUX-27 — Caja Protector | ESTRELLA A | 3.71 | `0 10 3 8 3 0 1 1 3 21 2 7` | Intermitente con picos |
| TXV25QLBRRS20 — Quilt Breda Rosa | CASHCOW A | 3.65 | `0 0 0 0 0 0 0 0 2 7 3 2` | **LANZAMIENTO** — sem 9+ |
| TXV25QLBRVD20 — Quilt Breda Verde | ESTRELLA A | 2.96 | `0 0 0 0 0 0 0 0 2 6 2 4` | **LANZAMIENTO** — sem 9+ |
| LICALCNDAMF59 — Almohada Cannon | VOLUMEN B | 2.94 | `0 2 0 3 2 2 0 0 2 4 6 3` | Intermitente clásico creciente |
| JSCNAE138P20B — Sábanas CN 200H | REVISAR C | 2.63 | `0 0 0 2 1 1 0 0 0 0 2 3` | Muy intermitente clásico |

**Tres perfiles diferentes conviven dentro de Z con vel alto:**
1. **Mal-clasificados** (1 SKU): venta regular con CV inflado por escala.
2. **Lanzamientos recientes** (3 SKUs, toda la familia Quilt Breda): ceros de historia no son obsolescencia sino "aún no existía".
3. **Intermitentes reales + "pico y caída" obsolescente** (6 SKUs): caso de libro para Croston/SBA/TSB.

**Este mix es el hallazgo más importante de la auditoría.** Un modelo único aplicado a los 162 Z tendrá bolsillos de sesgo. Ver §5.

## 3. Factibilidad shadow mode

| Pregunta | Respuesta |
|---|---|
| ¿Columna `vel_ponderada_tsb` paralela sin tocar `vel_ponderada`? | **Sí.** ALTER TABLE simple, null default. Motor la puebla cuando aplique; lectores actuales la ignoran. |
| ¿Extender Paso 2 (`intelligence.ts:848-960`) sin bloquear? | **Sí.** El paso ya arma `ventasSemana[9]`. TSB necesita ≥12 semanas → ampliar a `[12]`. Cálculo TSB es post-agregado por SKU, aislado. Si falla, fallback a `null` y el motor sigue. |
| Overhead de performance | TSB por SKU: O(n) con ~3 ops exponenciales × 12 semanas ≈ **~0.5-1 ms** JS. 533 SKUs × 1 ms = **+0.5 s** sobre ~9 s actuales (**+5-6 %**). Aceptable. |
| ¿Riesgo de contaminar el motor si TSB se rompe? | Bajo con try/catch por SKU + default null. Patrón ya probado en PR2 (`metricasAccuracy` con falla silenciosa). |

**Conclusión:** shadow mode es barato de agregar. Desbloquea benchmark antes de comprometer cambios de comportamiento.

## 4. Benchmark offline

`forecast_snapshots_semanales` hoy: **13 lunes × 533 SKUs** (12 reconstruidos + 1 real del 2026-04-13), todos con `en_quiebre=NULL`.

| Pregunta | Respuesta |
|---|---|
| ¿TSB retroactivo sobre 12 semanas existentes? | **Sí**. El backfill reconstruyó `vel_ponderada` usando ventas pasadas; se puede reconstruir `vel_ponderada_tsb` con el mismo input (`ventas_ml_cache` desde 2026-01-01). |
| ¿Cuánta historia necesita TSB para converger? | 8–12 observaciones mínimo. Con 16 semanas de ventas disponibles, **cabe razonable** para los lunes >= 2026-03-09 (8+ sem de warmup). Los 4 primeros reconstruidos quedan con `tsb=NULL`. |
| ¿Podemos comparar TSB vs ponderado sobre snapshots? | **Sí** — pero con la misma limitación del PR1: `en_quiebre=NULL` en todas las filas reconstruidas ⇒ la métrica `es_confiable=true` no va a aparecer hasta el 2026-05-18. Sirve para **benchmark informativo** (como la "simulación" del PR1), no para alertas. |

**Plan de benchmark offline viable ya:** para cada lunes entre 2026-03-09 y 2026-04-06, correr TSB usando ventas hasta ese lunes y actuales = semana siguiente. Calcular WMAPE/bias/TS TSB vs WMAPE/bias/TS del ponderado ya reconstruido. Ganar el modelo que mejor puntaje saque en ≥60 % de SKUs Z con vel>0. Con 4 lunes evaluables × 162 SKUs = 648 pares de comparación — muestra razonable.

## 5. Elección de modelo — TSB vs SBA vs Croston

### Test de obsolescencia (ratio `vel_60d / vel_historica_16sem`)

181 SKUs Z con ventas ≥1 en 16 semanas. Ratio hoy:

| Tramo | SKUs | % | Interpretación |
|---|---:|---:|---|
| < 0.5 (decaimiento fuerte) | 37 | 20 % | Obsolescencia real → TSB correcto |
| 0.5 – 0.8 (decaimiento moderado) | 50 – 37 = 13 | 7 % | TSB o SBA indistinto |
| 0.8 – 1.2 (estable) | 35 | 19 % | SBA suficiente |
| > 1.2 (creciente) | **96** | **53 %** | ⚠️ TSB subestima — penaliza ramp-up como obsolescencia |

`ratio_promedio = 1.131` → **el portafolio Z en promedio está creciendo**, no decayendo.

### Veredicto

| Modelo | Pro | Contra en BANVA |
|---|---|---|
| **Croston** (clásico) | Simple, referencia académica | Sesgo +1/(p-1); sobreestima SKUs a pedido raro |
| **SBA** (Syntetos-Boylan) | Corrige el sesgo de Croston | No maneja obsolescencia — pierde precisión en el 20 % fuerte-decaimiento |
| **TSB** (Teunter-Syntetos-Babai) | Maneja obsolescencia | ⚠️ **Penaliza ramp-up**: interpreta ceros iniciales como "producto en decaimiento" aunque sea lanzamiento reciente |

**Recomendación concreta:** **TSB con puerta de seguridad "edad mínima"**, no TSB puro. Reglas:

- Si `dias_desde_primera_venta < 60` (lanzamiento) → **usar ponderado actual**, no TSB. Estos 3+ Quilt Breda caen acá.
- Si ≥60 días y `xyz='Z'` y `vel_ponderada > 0` → **usar TSB**.
- Para Dead stock / SKU=0 → sigue lógica actual (`accion=DEAD_STOCK` / `INACTIVO`).

Alternativa igualmente válida: **correr TSB y SBA en paralelo**, persistir ambos, elegir uno por SKU según `ratio_obsolescencia` calculado en el motor. Más código pero más honesto con el mix detectado.

## 6. Configuración Z actual

### Diferenciación por XYZ en el motor

```bash
grep xyz.*Z src/lib/
```

Resultado: sólo la **clasificación** (intelligence.ts:977-979). **No hay branch condicional por `xyz==='Z'` en ningún paso del motor.** Z hoy recibe el mismo tratamiento que X/Y en:
- Velocidad ponderada (50/30/20 ponderado simple)
- Target de cobertura (por ABC — no XYZ)
- Safety stock (fórmula Z-score estándar con σ_D calculado sobre muestras semanales)

### `intel_config` (singleton `id='main'`, `updated_at = 2026-03-16`)

| Campo | Valor | Diferenciación XYZ |
|---|---:|---|
| `target_dias_a` | 42 | ❌ no |
| `target_dias_b` | 28 | ❌ no |
| `target_dias_c` | 14 | ❌ no |

### Safety stock — distribución en Z

Sobre los 162 Z con vel>0:

| Métrica | Z | X/Y promedio |
|---|---:|---:|
| `safety_stock_completo` p10 | 0.34 | — |
| `safety_stock_completo` p50 | **0.95** | — |
| `safety_stock_completo` p90 | 3.44 | — |
| **avg** | 1.77 | **4.59** |

**Lectura:** el SS promedio de Z es **39 % del de X/Y**, coherente con σ_D menor. Pero el p50 de 0.95 uds es operativamente inútil: cualquier redondeo a `inner_pack ≥ 2` vuelve el SS irrelevante. TSB mejoraría la media (menos sobreestimación) pero el impacto **en unidades físicas** sobre Z será marginal para SS. El gran aporte de TSB en Z es la **clasificación de acciones** (mejor reconocer cuándo parar de pedir), no el tamaño del pedido.

## Recomendación final

**Opción C — TSB en shadow con puerta de ramp-up + benchmark offline en paralelo.**

**Fases concretas:**

**Fase A — Semana 1 (ahora, tras merge PR2)**
- Migración v53: agregar `vel_ponderada_tsb numeric NULL` + `modelo_forecast text NULL` en `sku_intelligence`.
- Implementar helper puro `tsb(ventasSemanales, alpha, beta)` en `src/lib/tsb.ts`. Tests ≥6 casos (intermitente clásico, obsolescencia, lanzamiento, ceros totales, insuficiente historia).
- Extender Paso 2 del motor a 12 semanas. Calcular TSB en shadow cuando `xyz='Z'` AND `vel_ponderada > 0` AND `dias_desde_primera_venta ≥ 60`.
- **No cambiar ninguna decisión.** Persistir el valor, no consumirlo.
- Estimado: 1 día.

**Fase B — Semana 2**
- Script offline `scripts/benchmark-tsb.ts` que recalcula TSB retroactivo para 4 lunes evaluables y compara contra `forecast_snapshots_semanales.vel_ponderada`. Output: tabla de WMAPE/bias/TS por modelo y por SKU.
- Documentar ganadores/perdedores. Decidir si hace falta también correr SBA para comparar.
- Estimado: 1 día.

**Fase C — Post 2026-05-18 (cuando PR2 tenga `es_confiable=true`)**
- Con ≥ 4 semanas reales de snapshots, repetir benchmark con `en_quiebre` legítimo.
- Si TSB gana en ≥ 60 % de los Z evaluables → **activar** TSB como default para Z (cambiar el `vel_ponderada` consumido por el motor cuando `modelo_forecast='tsb'`).
- Agregar al tab 📊 Accuracy un toggle "modelo usado" y columnas TSB.
- Estimado: 1-2 días post-datos.

**Por qué C y no A o B:**

- **A (arrancar PR3 completo ahora):** quemaríamos esfuerzo implementando activación de TSB antes de saber si gana. Riesgo de cambiar la recomendación de reposición de 162 SKUs con datos de benchmark aún no validados.
- **B (esperar junio, todo de una):** desperdicia 4-6 semanas. El código shadow es barato; el benchmark offline nos da señal temprana que **puede invalidar la elección de TSB** (por ejemplo, si en el benchmark SBA empata con TSB, ahorramos la complicación de modelar obsolescencia).
- **C:** baja costo shadow mode ahora + benchmark temprano + decisión informada post-datos reales. Es el patrón que ya validamos con PR1/PR2.

**Riesgo principal a gestionar en C:** que la puerta "60 días desde primera venta" deje afuera los 3 Quilt Breda justamente cuando son los SKUs Z que más vel tienen (3-6 uds/sem). Mientras están dentro de esa ventana, seguirán usando el ponderado actual que los sobreestima — igual que hoy. Impacto neto: **no empeoran**, siguen igual. El beneficio de TSB recae en los 6-9 SKUs intermitentes "viejos" del top 10.

**Estimación total opción C**: 2 días para A+B, + ~1-2 días para activar C cuando haya datos. Ventana natural: arrancar Fase A esta semana, hacer Fase B la próxima, Fase C en la primera semana post-2026-05-18 (semana del 25/05).
