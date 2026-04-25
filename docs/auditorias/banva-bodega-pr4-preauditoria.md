# PR4 — Pre-auditoría: re-clasificación de clase Z

Fecha: 2026-04-18. Sin código. Decidir scope antes de implementar.

Contexto: PR3 Fase B concluyó que TSB no pasa para activar en Z. Diagnóstico real: Z mezcla **intermitencia genuina** con **estacionalidad / ciclos de producto** en la misma clase. Ningún modelo tipo Croston/SBA/TSB es apropiado para el segundo grupo. PR4 debe separar esas poblaciones.

## 1. Cuantificación del problema

### Historia disponible — limitación fundamental

| Fuente | Rows | Rango | Semanas distintas |
|---|---:|---|---:|
| `ventas_ml_cache` | 10 612 | 2026-01-01 → 2026-04-17 | **16** |
| `orders_history` | 9 214 | 2026-01-09 → 2026-04-17 | 15 |
| `ml_velocidad_semanal` | 1 633 | 2026-01-26 → 2026-03-30 | 10 |
| Máximo por SKU (cualquier fuente) | — | — | **14** |

**Ningún SKU tiene ≥ 16 semanas de historia.** Cualquier detección de estacionalidad con autocorrelación lag-12 o tests formales requiere ≥ 2 ciclos (26 semanas trimestral, 104 semanas anual). **Con los datos de hoy no existe manera rigurosa de separar estacionalidad de intermitencia.**

### Clasificación heurística débil sobre los 167 Z con vel > 0

Métricas posibles hoy (15 semanas alineadas lun-dom, 2025-12-29 → 2026-04-06):

- **frecuencia**: semanas con `uds > 0`
- **concentración final**: `% del total en las últimas 4 semanas`
- **concentración inicio**: `% del total en las primeras 4 semanas`

| Cuadrante | n | sin_venta | 1-3 sem | 4-7 sem | 8-12 sem | 13-15 sem | concentra_final ≥60% | concentra_inicio ≥60% |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| ESTRELLA-Z | 15 | 0 | 2 | 5 | 6 | 2 | 6 | 0 |
| CASHCOW-Z | 3 | 0 | 0 | 1 | 2 | 0 | 0 | 0 |
| VOLUMEN-Z | 2 | 0 | 0 | 0 | 2 | 0 | 0 | 0 |
| REVISAR-Z | 147 | 9 | 57 | 61 | 19 | 1 | 48 | 5 |
| **Total** | **167** | 9 | 59 | 67 | 29 | 3 | **54** | 5 |

**Lectura:**
- **67 SKUs con 4-7 semanas de venta** = candidato a intermitencia genuina (grupo principal).
- **54 SKUs con concentración final ≥60%** = cola larga al alza. Puede ser estacional (inicio de temporada), lanzamiento (ramp-up), o tendencia creciente. **No distinguible con 15 semanas.**
- 5 SKUs con concentración al inicio = candidato a "pico y caída" (posible fin-de-ciclo o fin-de-temporada).
- **29 SKUs con 8-12 semanas de venta + sin concentración extrema** = candidato a demanda regular-pero-variable mal-clasificada como Z (problema de escala, no de patrón).

**Honestidad del diagnóstico:** los umbrales 60% y "concentración final/inicio" son proxies. El dato actual no permite decir "X es estacional" con confianza estadística. Sirven para priorizar qué SKUs revisar manualmente.

## 2. Los 3 SKUs bloqueantes del criterio 2 del benchmark TSB

Series 15 semanas (2025-12-29 → 2026-04-06):

| SKU | Nombre | Cuadrante | Total | Serie semanal | Diagnóstico |
|---|---|---|---:|---|---|
| **TXSB144ISY10P** | Sábana Illusions Infantil Starry | ESTRELLA | 92 | `1 5 5 2 6 8 3 3 0 2 9 3 12 20 13` | **Crecimiento sostenido** con varianza alta. Mal-clasificado Z (CV inflado por escala, no intermitencia). Últimas 3 semanas 45 uds (49% del total). Podría ser ramp-up o tendencia. **No estacional detectable.** |
| **TXTPBL105200S** | Topper Illusions 1.5P | CASHCOW | 57 | `2 2 0 1 9 2 4 0 4 10 15 8 0 0 0` | **Pico en medio (sem 10-12 = 33 uds) + caída a cero** últimas 3. Ambiguo: fin de ciclo producto, fin de stock, o estacional de verano. 15 semanas no alcanza. |
| **TXTPBL1520020** | Topper Illusions 2.0P | CASHCOW | 150 | `9 18 25 17 17 31 18 11 2 0 0 1 1 0 0` | **Decaimiento monotónico fuerte**: 135 uds (90%) en primeras 7 semanas, 4 uds (10%) en últimas 8. **Obsolescencia o fin-de-temporada verano**. Sin historia del diciembre anterior no se puede confirmar ciclo. |

**Los 3 SKUs son casos DISTINTOS, no un patrón único "estacional":**
- TXSB144ISY10P → **problema de clasificación XYZ**, no de modelo forecast.
- TXTPBL105200S → ambiguo, necesita más historia o anotación manual.
- TXTPBL1520020 → **decay real** — SBA/TSB podrían funcionar con parámetros distintos, o es obsolescencia terminal (no re-aparecerá).

Con 15 semanas no hay señal de ciclo anual. Lo que parece "estacional" podría ser simplemente "producto de verano vendiendo de enero a marzo". Confirmar requiere ver enero 2027.

**Estado TSB actual de los 3 (post-recálculo):**

| SKU | `primera_venta` | Días | `tsb_modelo_usado` | `vel_ponderada` | `vel_ponderada_tsb` |
|---|---|---:|---|---:|---:|
| TXSB144ISY10P | 2026-01-04 | 104 | tsb | 9.66 | 9.00 |
| TXTPBL105200S | 2026-01-03 | 105 | tsb | 1.09 | 1.39 |
| TXTPBL1520020 | 2026-01-01 | 107 | tsb | 0.44 | 0.51 |

Todos cumplen la puerta de 60 días (primera venta en enero) y corren TSB. El TSB no los "empeora" por mal cálculo — los empeora porque el modelo subyacente no es apropiado para su patrón.

## 3. Opciones de re-clasificación

| Opción | Descripción | Tablas | Motor | Riesgo |
|---|---|---|---|---|
| **A** | XYZ → XYZW: 4ª clase "estacional" | `sku_intelligence.xyz` CHECK ampliado | `intelligence.ts` P10 clasificador nuevo; todos los consumers de `xyz` re-evaluados | Alto — 30+ consumers de XYZ, migración grande |
| **B** | Flag booleano `es_estacional` | `sku_intelligence.es_estacional` (nueva col) | Solo extender `seleccionarModeloZ()` con exclusión | Bajo — no toca XYZ, cambio puntual |
| **C** | 5 clases X/Y/Z/S/M | reemplazar `xyz` por `clase_temporal` | Re-motor clasificador + re-mapeo completo | Muy alto — rompe todo; justificable sólo con ≥52 sem |

### Argumento por opción B con matices

- **Respeta XYZ** como clasificador de varianza (útil para SS cálculo, abc).
- **Separa "qué modelo usar"** de "qué tan variable es" — concepto distinto.
- **Reversible**: si el flag resulta mal asignado, basta UPDATE a false; el motor vuelve al SMA/TSB por defecto.
- **Mínima superficie**: una columna + una condición extra en `seleccionarModeloZ()`.
- **Compatible con TSB shadow existente**: el flag enmascara el TSB para estacionales; el TSB queda calculado para quienes sí pasan.

**Contra opción A (XYZW):** ningún consumer de `xyz` en el motor usa la clase Z para algo específico hoy (confirmado con `grep xyz.*Z`, sólo aparece en la clasificación en sí). Agregar una 4ª clase no aporta semántica — es un flag disfrazado. Además rompe compatibilidad con reportes externos.

**Contra opción C:** con 15 semanas no se puede clasificar en 5 tipos honestamente. Sería pseudo-sofisticación. Cuando haya 52+ semanas, esta opción se vuelve revisitable.

### Recomendación: **opción B** + **detección manual en Fase 1** (sin modelo de HW).

## 4. Viabilidad de Holt-Winters

| Modelo | Historia mínima | SKUs BANVA que califican hoy |
|---|---:|---:|
| Holt-Winters anual (12 meses estacionalidad) | 104 semanas (2 ciclos) | **0** |
| Holt-Winters anual (mínimo aceptable) | 52 semanas | **0** |
| Holt-Winters trimestral (13 semanas estacionalidad) | 52 semanas (2 ciclos) | **0** |
| STL decomposition | ≥ 2 ciclos | **0** |

**Holt-Winters no es viable hoy.** Próximas ventanas:
- Trimestral: ~julio 2026 (cuando haya ≥ 26 semanas, mínimo aceptable con 1 ciclo).
- Anual básico: ~enero 2027.
- Anual robusto: ~abril 2027 (para tener 2 ciclos + buffer).

**Alternativa potencial entre tanto:** ninguna estadística rigurosa. Cualquier "modelo estacional" con 15 semanas será adivinanza dresseada de matemática.

## 5. Alternativa pragmática si HW no es viable

**PR4 Fase 1 — hint manual** (lo único realmente honesto con los datos actuales):

1. Migración v54 agrega dos campos:
   - `sku_intelligence.es_estacional: boolean NULL` (default NULL = sin evaluar)
   - `sku_intelligence.estacionalidad_nota: text NULL` (texto libre: "Abril-Agosto: alta; Sep-Mar: baja")
2. UI nuevo botón en `AdminInteligencia` tab actual → **Modal "Marcar estacional"** con campo nota.
3. Motor: extender `seleccionarModeloZ({primera_venta, xyz, es_estacional}, hoy)`:
   - `es_estacional === true` → `sma_ponderado` (exenta de TSB, no se penaliza con obsolescencia).
   - Resto igual que hoy.
4. Tab Accuracy: agregar columna "Estacional" para filtrar.
5. Alerta nueva `forecast_estacional_sin_eventos`: SKU marcado estacional pero sin entrada en `eventos_demanda` que cubra su temporada (prompt para que admin agregue el evento).

**PR4 Fase 2 — detección automática (post 2026-07 o 2027-04 según horizonte):**

Cuando haya ≥ 26-52 semanas por SKU:
1. Script offline que computa autocorrelación lag-12/lag-52 + test de Dickey-Fuller estacional.
2. Sugiere flipping `es_estacional` en sugerencias (no auto-aplica).
3. Admin revisa y confirma.

**PR4 Fase 3 — Holt-Winters real (post 2027-04):**
1. Módulo `src/lib/holt-winters.ts` puro.
2. Aplica solo a SKUs con `es_estacional=true` y ≥ 52 semanas.
3. Shadow primero, benchmark, activación bajo los mismos 4 criterios del PR3 Fase B adaptados.

## 6. Relación con PR3 Fase A (TSB shadow)

**Estado TSB hoy:** 110 SKUs con `tsb_modelo_usado='tsb'`, 335 con `'sma_ponderado'`, 91 con `vel_ponderada_tsb > 0` (post-recálculo 2026-04-18 00:17 UTC).

**Cambio necesario en `seleccionarModeloZ()` (implementación PR4 Fase 1):**

```ts
export function seleccionarModeloZ(
  sku: { primera_venta: Date | string | null; xyz: string; es_estacional?: boolean | null },
  hoy: Date,
): ModeloForecast {
  if (sku.xyz !== "Z") return "sma_ponderado";
  if (sku.es_estacional === true) return "sma_ponderado";  // ← NUEVA LÍNEA
  if (!sku.primera_venta) return "sma_ponderado";
  const pv = ...
  return diasDesdeInicio >= 60 ? "tsb" : "sma_ponderado";
}
```

Los 3 bloqueantes post-marcado serían excluidos del TSB shadow. Sus columnas `vel_ponderada_tsb` = NULL y `tsb_modelo_usado='sma_ponderado'` en el próximo recálculo.

**Tests adicionales necesarios (mínimo 3):**
- SKU Z maduro + `es_estacional=true` → SMA
- SKU Z maduro + `es_estacional=false` → TSB (default hoy)
- SKU Z maduro + `es_estacional=null` → TSB (null ≠ true)

## Gaps confirmados (no inventar)

- **`patrones_estacionales` no existe** en el schema (verificado).
- **`eventos_demanda` existe** (12 filas, 7 eventos activos: Cyber Day Mayo, Fiestas Patrias, Navidad, Rebajas Año Nuevo, Día Madre, Black Friday, Cyber Monday Octubre). Todos con `categorias=[]` vacío → no se aplica hoy a SKUs particulares.
- `intel_config` no tiene parámetros por XYZ ni por estacionalidad.
- Historia máxima por SKU: 14 semanas. HW y variantes **no viables**.
- **Cualquier afirmación "X es estacional" con 15 semanas es insuficiente estadísticamente.** Las marcas iniciales de PR4 Fase 1 serán hints humanos basados en conocimiento del negocio, no detección automática.

## Recomendación final

**Opción B — flag `es_estacional` booleano**, implementada en 3 fases:

| Fase | Cuándo | Qué hace |
|---|---|---|
| **Fase 1** | PR4 (semana próxima) | Migración v54 + 2 columnas nullable + UI hint manual + extensión `seleccionarModeloZ()` + 3 tests. Sin modelos nuevos. TSB sigue igual salvo exclusión de marcados. |
| **Fase 2** | ~2026-07 | Script offline detecta candidatos con autocorrelación lag-12 + Dickey-Fuller. Genera **sugerencias** al admin (no auto-marca). |
| **Fase 3** | ~2027-04 | Implementar Holt-Winters real para SKUs con `es_estacional=true` + ≥ 52 semanas. Shadow + benchmark + activación. |

**Por qué no Fases agresivas ahora:** no hay datos que justifiquen modelos estacionales formales. Pretender tenerlos sería ingeniería ceremonial — el usuario acierta en marcar TXTPBL1520020 como estacional manualmente mejor que cualquier modelo inferiría con 15 semanas.

**Por qué no descartar Fase 2/3:** la arquitectura del flag lo hace no-lock-in. Cuando lleguen más datos, las fases siguientes son extensiones no-disruptivas.

**Criterios de activación para Fase 3 (adelantado, como hicimos con PR3 Fase B):**
- Mismo formato 4-criterios: WMAPE mediano −15%, cero regresión en ESTRELLA/CASHCOW marcados, bias razonable, sanity low-velocity.
- Mínimo 52 semanas de historia para los SKUs evaluados.
- Cero regresión **específicamente** en SKUs donde TSB hoy no empeora (para no cancelar logros por avanzar con HW).

---

**Generado:** 2026-04-18
**Fuentes:** queries directas a Supabase + inspección de `intelligence.ts:seleccionarModeloZ` + tablas `ventas_ml_cache`, `ml_velocidad_semanal`, `orders_history`, `eventos_demanda`, `sku_intelligence`, `composicion_venta`.
**No se aplicó ninguna migración en esta auditoría.** Solo lectura.
