# supabase/archived/

Diseños que se consideraron, documentaron y se descartaron sin aplicar.
No borrar: sirven como referencia histórica si alguien revisita la decisión.

## Estado actual

Vacío de código. La decisión del Sprint 1 (sales) del 2026-04-15 fue **Opción
C pura** para el rebackfill histórico de `ventas_ml_cache`:

- NO ejecutar replay cronológico de WAC.
- NO crear `ventas_ml_cache_replay_audit`.
- NO crear la función `replay_costos_ventas()`.

Razonamiento (del chat):
- El reporting histórico no maneja decisiones operativas hoy.
- En 60-90 días el histórico "bueno" (post-2026-04-12) se vuelve mayoría sin
  hacer nada.
- Opción A (replay parcial) dejaba 47% como `sin_costo_replay`, equivalente
  práctico al `backfill_estimado` actual.
- Opción D (seed manual de 200+ SKUs) tenía mal ROI para data que será
  irrelevante pronto.
- Opción B (backfill con WAC actual) era matemáticamente peor que dejar el
  estado actual.

## Diseño de referencia (por si el futuro trae arrepentimiento)

Si más adelante alguien decide revertir a un replay, el diseño conversado fue:

1. Tabla `ventas_ml_cache_replay_audit` con columnas:
   `order_id, sku_venta, fecha_venta, costo_producto_old, costo_fuente_old,
   costo_producto_new, costo_fuente_new, diff_clp, diff_pct,
   wac_skus_componentes jsonb, reconstruido_at`.

2. Función plpgsql `replay_costos_ventas()` que:
   - Recorre `movimientos ORDER BY created_at, id` manteniendo
     `Map<sku, (stock_acumulado, wac_corriente)>`.
   - En cada timestamp de venta de `ventas_ml_cache.fecha`, resuelve
     componentes vía `composicion_venta` y calcula `costo_producto`
     reconstruido con IVA ×1,19.
   - Marca filas reconstruibles con `costo_fuente='backfill_replay'` y
     las no reconstruibles con `'sin_costo_replay'`.
   - Escribe solo al audit, nunca a `ventas_ml_cache` directamente.

3. Reportes desde el audit: distribución `diff_pct`, top 20 SKUs con mayor
   delta, cuántas pasan a sin_costo_replay, total CLP que cambia el COGS
   histórico.

4. Aplicar (si el reporte se aprueba): `UPDATE ventas_ml_cache FROM audit`
   en transacción con rollback ready.

## Pre-requisitos técnicos para que tenga sentido revisitar

El replay se descartó principalmente porque la cobertura de costo en entradas
históricas era <60% en febrero 2026 (13.3%) y acumulado 49.3%. Antes de
revivirlo, verificar que la cobertura actual sea >60% consistente por al menos
6 meses, o bien cargar seed manual de costos históricos para los SKUs con
`carga_inicial` sin costo (eran ~204 filas en febrero 2026).
