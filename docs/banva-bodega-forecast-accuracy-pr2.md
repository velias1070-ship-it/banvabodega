# PR2/3 — Alertas + UI de forecast accuracy

Fecha: 2026-04-17. Build sobre PR1 (commit `d39fc37`). Sin TSB, sin recálculo incremental (PR3).

## Qué cambió

### Motor

- `src/lib/intelligence.ts`
  - `AlertaIntel`: eliminado `"cambio_canal_rentable"` (residuo muerto del commit inicial del motor, nunca emitido). Agregados 3 nuevos: `"forecast_descalibrado_critico"`, `"forecast_descalibrado"`, `"forecast_sesgo_sostenido"`. **Conteo: 28 → 31 strings.**
  - `SkuIntelRow`: 6 campos nuevos (`forecast_wmape_8s`, `forecast_bias_8s`, `forecast_tracking_signal_8s`, `forecast_semanas_evaluadas_8s`, `forecast_es_confiable_8s`, `forecast_calculado_at`).
  - `RecalculoInput`: campo opcional `metricasAccuracy?: Map<sku_origen, {wmape, bias, tracking_signal, semanas_evaluadas, es_confiable, calculado_at}>`.
  - Nueva función exportada `evaluarAlertasForecast(row, metrica)` — lógica pura de juicio, testeable sin montar todo el motor.
  - Paso 19 consume `input.metricasAccuracy`, escribe los 6 campos cacheados en la row, y agrega las alertas vía `evaluarAlertasForecast()`.

- `src/lib/forecast-accuracy-queries.ts`
  - Nueva función `ultimasMetricasAccuracy(sb, ventana)` — una query (ORDER BY sku_origen, calculado_at DESC; deduplicación en memoria = DISTINCT ON virtual), **sin N+1**.

- `src/app/api/intelligence/recalcular/route.ts`
  - Carga `metricasAccuracy` con try/catch antes del `recalcularTodo()`. Falla silenciosa: si la tabla no existe (ej. deploy previo a v52), loggea warning y continúa sin las 3 alertas.
  - `rowToUpsert` propaga los 6 campos al upsert a `sku_intelligence`.

### Migración (**no aplicada — aplícala vos post-merge**)

- `supabase-v52-forecast-alerts.sql` agrega las 6 columnas nullable en `sku_intelligence` + índice parcial `idx_sku_intel_forecast_ts` para filtrar descalibrados por TS sin full-scan.

**Comando para aplicar desde Claude Code con MCP:**

```
mcp__supabase__apply_migration name="v52_forecast_alerts" query="$(cat supabase-v52-forecast-alerts.sql)"
```

O en el SQL Editor de Supabase: pegá el contenido del archivo.

### UI

- `src/components/AdminInteligencia.tsx`
  - `IntelRow`: 6 campos nuevos (alineados con migración v52).
  - `vistaAccuracy: boolean` + 2 filtros (`accuracyFiltroEstrella`, `accuracyFiltroBias`).
  - Botón `📊 Accuracy` en el grupo toggle del header, con tooltip explicativo.
  - Vista completa de tabla con banner contextual, pills de filtro, placeholder "2026-05-18", ordenamiento priorizado por cuadrante + `ABS(TS)`. Ver §15.8 del doc de inteligencia.

### Tests

- `src/lib/__tests__/forecast-accuracy.test.ts`: **5 tests nuevos** sobre `evaluarAlertasForecast` (ESTRELLA A-X crítica, A con TS<4 sin alerta, clase Z excluida de descalibrado pero no de sesgo, `es_confiable=false` silencia todo, VOLUMEN A-X dispara advertencia no crítica). **Total: 13 tests, 13 verdes.**

### Docs

- `docs/banva-bodega-inteligencia.md`
  - §5 reescrita: "botones-vista booleanos" (no tabs). Tabla con los 6 botones del header, incluyendo 📊 Accuracy.
  - §6: 31 alertas (antes decía 29 — corrige el miscount que ya veníamos arrastrando). 3 nuevas al final.
  - §12 gap #4: marcado cerrado (PR1 medición + PR2 alertas y UI). Único remanente relacionado: TSB para Z → gap renombrado como PR3.
  - §15: subsecciones nuevas 15.6 (alertas en motor), 15.7 (columnas cacheadas), 15.8 (tab Accuracy).

## Resultado post-merge

**Migración v52 aún no aplicada** → los 6 campos no existen todavía en la DB. El primer recálculo tras aplicar la migración va a popular los campos en `NULL` para todos los SKUs (porque `forecast_accuracy.es_confiable` sigue en `false` — el backfill tenía `en_quiebre=NULL`). Las 3 alertas nuevas **no se van a disparar** hasta la primera medición real con ≥4 lunes reales acumulados.

**Primera alerta real estimada: lunes 2026-05-18** (4 lunes reales: 2026-04-20, 04-27, 05-04, 05-11 con `en_quiebre=boolean`; el cron del 05-18 los evalúa).

Mientras tanto, el tab Accuracy muestra el placeholder explícito, y la simulación informativa del README de PR1 (72 SKUs con `|TS|>4`, 17 ESTRELLAS descalibradas) da la expectativa de magnitud cuando pase a datos reales.

## Convenciones de color en UI

| Estado | Color | Regla |
|---|---|---|
| TS dentro de rango | gris `var(--txt2)` | `ABS(TS) ≤ 2` |
| TS amarillo | ámbar `var(--amber)` | `2 < ABS(TS) ≤ 4` |
| TS rojo | rojo `var(--red)` | `ABS(TS) > 4` (dispara alerta) |
| Bias +N | rojo | `bias > 0` (subestimamos, stockout-prone) |
| Bias -N | ámbar | `bias < 0` (sobrestimamos, exceso-prone) |
| Chip crítica | 🔴 | `forecast_descalibrado_critico` presente |
| Chip advertencia | 🟡 | `forecast_descalibrado` o `forecast_sesgo_sostenido` |

## Queries SQL útiles (post aplicación v52)

### Descalibrados ESTRELLA ordenados por |TS|

```sql
SELECT sku_origen, nombre, cuadrante, abc, xyz,
       forecast_tracking_signal_8s AS ts,
       forecast_bias_8s AS bias,
       forecast_wmape_8s AS wmape,
       forecast_semanas_evaluadas_8s AS n
FROM sku_intelligence
WHERE forecast_es_confiable_8s = true
  AND cuadrante = 'ESTRELLA'
  AND abs(forecast_tracking_signal_8s) > 4
ORDER BY abs(forecast_tracking_signal_8s) DESC;
```

### Sesgo sostenido por proveedor

```sql
SELECT proveedor,
       count(*)                                                      AS skus_con_sesgo,
       avg(forecast_bias_8s)::numeric(10,2)                          AS bias_promedio,
       avg(abs(forecast_bias_8s) / NULLIF(vel_ponderada, 0))::numeric(10,3) AS bias_relativo_promedio
FROM sku_intelligence
WHERE 'forecast_sesgo_sostenido' = ANY (alertas)
GROUP BY proveedor
ORDER BY count(*) DESC;
```

## Próximo PR (PR3/3)

TSB (Teunter-Syntetos-Babai) para demanda intermitente clase Z:

- Nuevo `vel_ponderada_tsb` paralelo (no reemplaza el ponderado 50/30/20 para X/Y).
- Decisión en el motor: si `xyz='Z'` y hay ≥ 12 semanas de ventas, usar TSB; si no, velocidad actual.
- Separar las métricas: `forecast_accuracy` gana columna `modelo` (`"ponderado"` o `"tsb"`).
- Alertas nuevas: `forecast_tsb_desvio` cuando TSB predice pero realidad difiere >30%.
- El tab Accuracy gana filtro "modelo usado" y comparativa TSB vs ponderado.

Estimación: PR3 ~2-3 días, parecido al scope de PR1+PR2. Priorizar después de que PR2 acumule 4-6 semanas de datos reales para poder benchmark.
