# PR1/3 — Medición de forecast accuracy

Fecha: 2026-04-17. Schema `public`. Sin UI ni alertas (vienen en PR2).

## Qué cambió

- `supabase-v51-forecast-accuracy.sql` → 2 tablas: `forecast_snapshots_semanales` (PK `sku_origen+semana_inicio`) y `forecast_accuracy` (PK `sku_origen+ventana_semanas+calculado_at`, FK a `sku_intelligence`).
- `src/lib/dates.ts` — helpers `lunesIso`, `restarSemanas`, `ultimosNLunesCerrados`.
- `src/lib/forecast-accuracy.ts` — módulo puro `calcularMetricas(forecasts, actuales, ventana)`.
- `src/lib/forecast-accuracy-queries.ts` — `snapshotSemanalActual` + `calcularYGuardarAccuracy`.
- `src/app/api/intelligence/forecast-accuracy/route.ts` — POST (cron) + GET (debug por SKU).
- `src/lib/__tests__/forecast-accuracy.test.ts` — 8 casos (serie perfecta, sesgo±, quiebre=true, quiebre=NULL, <4 semanas, intermitente con ceros, ventana 12 recortando outliers viejos).
- `scripts/backfill-forecast-snapshots.ts` — reconstrucción standalone via tsx.
- `vercel.json` — nuevo cron `30 12 * * 1`.
- `docs/banva-bodega-inteligencia.md` §15 — nueva sección; gap #4 marcado "parcial".

## Resultado del primer run

### Backfill

| origen | filas | SKUs | semanas | rango |
|---|---:|---:|---:|---|
| `reconstruido` | 6 396 | 533 | 12 | 2026-01-19 → 2026-04-06 |
| `real` | 533 | 533 | 1 | 2026-04-13 (snapshot del forecast vigente HOY) |

### Métricas persistidas (honesto)

Las 12 semanas reconstruidas tienen `en_quiebre=NULL` ⇒ todas excluidas ⇒ `semanas_evaluadas=0` para todas las ventanas ⇒ **0 SKUs confiables en la primera corrida**. Esto es lo esperado con opción C estricta.

| Ventana | Filas | `es_confiable=true` | Σ excluidas promedio |
|---:|---:|---:|---:|
| 4 | 533 | 0 | 4.0 |
| 8 | 533 | 0 | 8.0 |
| 12 | 533 | 0 | 12.0 |

La primera métrica real llegará el lunes **2026-05-18** (4 lunes con `origen='real'` acumulados a partir del cron del 2026-04-20).

### Proyección simulada (tratando `NULL` como `false`, sólo para diagnosticar sesgo histórico — NO persistida)

Este cálculo aproxima qué veremos dentro de 4-5 semanas si el sesgo del predictor se mantiene igual.

| Métrica (ventana 8s simulada) | Valor |
|---|---:|
| SKUs con WMAPE calculable | **292 / 533** (55 %) |
| WMAPE promedio | **1.068** (≈ 107 %) |
| SKUs con \|TS\| > 4 | **72** |
| \|TS\| promedio | **2.79** |

Interpretación: el motor está subestimando o sobrestimando severamente en una parte del catálogo. WMAPE alto no es sorpresa para un catálogo 71 % clase C con demanda intermitente, pero **72 SKUs con \|TS\| > 4 son señal de sesgo estructural** que PR2 debe alertar.

### Top 10 \|TS\| ventana 8 (simulado)

| SKU | ABC | Cuadrante | TS | Actual total (uds) |
|---|---|---|---:|---:|
| TX2ALIMFP5070 | B | REVISAR | +8.0 | 18 |
| JSAFAB441P20W | C | REVISAR | +8.0 | 2 |
| JSAFAB442P20W | C | REVISAR | +8.0 | 2 |
| JSAFAB436P20W | C | REVISAR | +8.0 | 3 |
| JSAFAB440P20W | C | REVISAR | +8.0 | 3 |
| JSAFAB439P20W | C | REVISAR | +8.0 | 1 |
| TXSBAF144LK2P | C | REVISAR | −8.0 | 0 |
| MAN-FRA-ROS-00022 | C | REVISAR | −8.0 | 0 |
| 9788481693294 | C | REVISAR | −8.0 | 0 |
| TEXPRWTILL10P | C | REVISAR | −8.0 | 0 |

Nota: los de TS=−8 son SKUs que el motor predice venta pero no vendieron nada en el periodo. Candidatos a reclasificar a `INACTIVO`/`DEAD_STOCK`.

### Top 10 WMAPE > 50 % ventana 12 (simulado)

| SKU | ABC | Cuadrante | WMAPE | Actual total |
|---|---|---|---:|---:|
| JSCNAE180P20S | C | REVISAR | 3.849 | 1 |
| JSAFAB408P20Z | C | REVISAR | 3.442 | 1 |
| TEXPRWTILL10P | C | REVISAR | 2.654 | 13 |
| TXSBAF144VT20 | C | REVISAR | 2.593 | 2 |
| TXTPBL9020010 | C | REVISAR | 2.366 | 4 |
| JSAFAB381P20X | C | REVISAR | 2.209 | 1 |
| TXV24QLBRMA25 | C | REVISAR | 2.012 | 1 |
| TXSBAF144Q20P | C | REVISAR | 1.988 | 1 |
| ALPCMPRSQ6012 | C | REVISAR | 1.988 | 1 |
| AFINF100133SP | C | REVISAR | 1.980 | 4 |

### Distribución de descalibrados ventana 8 (simulado)

**Por clase ABC:**

| ABC | SKUs total | \|TS\| > 4 | % | WMAPE > 50 % | % |
|---|---:|---:|---:|---:|---:|
| A | 87 | 19 | 21.8 % | 54 | 62.1 % |
| B | 71 | 6 | 8.5 % | 64 | 90.1 % |
| C | 375 | 47 | 12.5 % | 132 | 35.2 % |

**Por cuadrante:**

| Cuadrante | SKUs total | \|TS\| > 4 | WMAPE > 50 % |
|---|---:|---:|---:|
| ESTRELLA | 82 | 17 (20.7 %) | 49 (59.8 %) |
| CASHCOW | 5 | 2 | 5 |
| VOLUMEN | 11 | 2 | 10 |
| REVISAR | 435 | 51 | 186 |

🚨 **17 ESTRELLAs con \|TS\| > 4** — clase A de alto margen con forecast sesgado más de 4 MAD. Objetivo principal para el dashboard de PR2.

## Queries SQL listas para copiar

### Cambio estructural (SKUs cuyo forecast cambió abruptamente entre ventana 4 y ventana 12)

```sql
WITH last_run AS (
  SELECT max(calculado_at) AS t FROM forecast_accuracy
)
SELECT
  f4.sku_origen,
  si.abc, si.cuadrante,
  f4.wmape AS wmape_4s,
  f12.wmape AS wmape_12s,
  (f4.wmape - f12.wmape) AS delta_wmape,
  f4.tracking_signal AS ts_4s,
  f12.tracking_signal AS ts_12s
FROM forecast_accuracy f4
JOIN forecast_accuracy f12
  ON f12.sku_origen = f4.sku_origen AND f12.ventana_semanas = 12
JOIN sku_intelligence si ON si.sku_origen = f4.sku_origen
JOIN last_run r ON f4.calculado_at = r.t AND f12.calculado_at = r.t
WHERE f4.ventana_semanas = 4
  AND f4.es_confiable AND f12.es_confiable
  AND ABS(f4.wmape - f12.wmape) > 0.25
ORDER BY ABS(f4.wmape - f12.wmape) DESC
LIMIT 20;
```

### Sesgo sostenido (tracking signal fuera de ±4 sobre ventana 8)

```sql
WITH last_run AS (SELECT max(calculado_at) AS t FROM forecast_accuracy)
SELECT
  f.sku_origen,
  si.abc, si.cuadrante, si.accion,
  f.tracking_signal,
  f.wmape,
  f.bias,
  f.forecast_total,
  f.actual_total,
  CASE
    WHEN f.tracking_signal > 4  THEN 'subestimando (riesgo stockout)'
    WHEN f.tracking_signal < -4 THEN 'sobrestimando (riesgo exceso)'
  END AS diagnostico
FROM forecast_accuracy f
JOIN sku_intelligence si ON si.sku_origen = f.sku_origen
JOIN last_run r ON f.calculado_at = r.t
WHERE f.ventana_semanas = 8
  AND f.es_confiable
  AND ABS(f.tracking_signal) > 4
ORDER BY f.tracking_signal DESC;
```

## Convención de signo (crítico para PR2)

```
error = actual − forecast
bias > 0  → subestimamos demanda (propenso a stockout)
bias < 0  → sobrestimamos demanda (propenso a exceso)
```

## Notas de seguridad

- RLS permisivo en ambas tablas (convención del proyecto). FK a `sku_intelligence(sku_origen)` con `ON DELETE CASCADE` — si un SKU se borra, su historia de accuracy también.
- El endpoint POST valida `Authorization: Bearer ${CRON_SECRET}` **o** `x-cron-secret: <secret>`. Si `CRON_SECRET` no está configurado, rechaza todo por defecto.
- El endpoint GET es lectura pública (alineado con otros endpoints de `/api/intelligence/*`).
