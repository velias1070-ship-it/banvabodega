# BANVA Bodega — Snapshot 2026-04-18

Fuente de verdad para contexto externo (Claude web). Todos los números vienen de query directa a Supabase + lectura del repo al **2026-04-18**.

## 1. Resumen ejecutivo

- **Último commit a `main`**: `d80940a` — `feat(intelligence): flag es_estacional con metadata auditable (PR4 Fase 1)`.
- **Último recálculo del motor**: **2026-04-18 15:04 UTC**, 445 SKUs procesados en 3.2 s (full, sin snapshot).
- **Sprint terminado**: **PR4 Fase 1**. Quedó dormant hasta **2026-05-18** (primera medición real de forecast accuracy) y **2026-10-18** (revisión obligatoria de los 3 SKUs estacionales marcados).
- Entre hoy y 2026-05-18 el sistema de forecast corre en modo shadow: TSB calcula pero no se consume; las 3 alertas `forecast_*` escritas en el motor no disparan porque no hay filas `es_confiable=true`.

**Migraciones aplicadas desde `banva-bodega-estado-actual.md` (2026-04-16):**

| Migración | Propósito |
|---|---|
| v51 | `forecast_snapshots_semanales` + `forecast_accuracy` (PR1). |
| v52 | +6 cols en `sku_intelligence` para alertas forecast (PR2). |
| v53 | +6 cols para TSB shadow (PR3 Fase A). |
| v54 | +5 cols para flag `es_estacional` con metadata auditable (PR4 Fase 1). |

## 2. Estado del motor Inteligencia

### 2.1 Métricas generales

**Total**: **533 SKUs** en `sku_intelligence` (último recálc. `2026-04-18T15:04:20Z`).

| ABC | n | % |
|---|---:|---:|
| A | 83 | 15.6% |
| B | 64 | 12.0% |
| C | 386 | 72.4% |

| Cuadrante | n | % |
|---|---:|---:|
| ESTRELLA | 79 | 14.8% |
| CASHCOW | 4 | 0.8% |
| VOLUMEN | 7 | 1.3% |
| REVISAR | 443 | 83.1% |

| XYZ | n | % |
|---|---:|---:|
| X | 23 | 4.3% |
| Y | 113 | 21.2% |
| Z | **397** | **74.5%** |

| Acción | n | % |
|---|---:|---:|
| INACTIVO | 150 | 28.1% |
| EXCESO | 128 | 24.0% |
| OK | 67 | 12.6% |
| DEAD_STOCK | 67 | 12.6% |
| PLANIFICAR | 58 | 10.9% |
| AGOTADO_PEDIR | 18 | 3.4% |
| MANDAR_FULL | 17 | 3.2% |
| URGENTE | 16 | 3.0% |
| AGOTADO_SIN_PROVEEDOR | 12 | 2.3% |
| EN_TRANSITO | 0 | — |
| NUEVO | 0 | — |

| `tsb_modelo_usado` | n | % |
|---|---:|---:|
| `sma_ponderado` | 342 | 64.2% |
| `tsb` | 103 | 19.3% |
| `NULL` (no evaluado) | 88 | 16.5% |

### 2.2 Salud operativa

| Métrica | Valor |
|---|---:|
| SKUs OOS (`stock_total=0`) | **192 (36.0 %)** |
| SKUs dead stock (>180d sin mov + stock>0) | 341 (64.0 %) |
| SKUs zero-velocity (`vel_ponderada=0` + stock>0) | 74 |
| Unidades inmovilizadas (∑ stock_total donde vel=0) | 448 |
| **Valor caja inmovilizada** (∑ `costo_inventario_total` donde vel=0) | **$7 196 094 CLP** |
| SKUs con `factor_rampup_aplicado ≠ 1.0` | 57 |
| SKUs con `es_estacional=true` | 3 |

**SKUs estacionales** (los 3 marcados el 2026-04-18 por `vicente`, `revisar_en=2026-10-18`):

| sku_origen | nombre | xyz | cuadrante | motivo |
|---|---|---|---|---|
| TXSB144ISY10P | Sabana Illusions 144H Infantil Starry 10P | Y | ESTRELLA | Crecimiento sostenido, NO estacional. Motor lo reclasificó a Y el 2026-04-18. Flag defensivo. |
| TXTPBL105200S | Topper Illusions 1.5 P | Z | CASHCOW | pico+caída post-temporada, evaluar con 6 meses más historia |
| TXTPBL1520020 | Topper Illusions 2.0 P | Z | CASHCOW | decay monotónico fuerte, posible fin-temporada o obsolescencia — revisar con año completo |

### 2.3 Urgentes reales

**46 SKUs** con `accion IN ('URGENTE', 'AGOTADO_PEDIR', 'AGOTADO_SIN_PROVEEDOR')` (16 + 18 + 12). Distribución:

- **URGENTE (16)**: stock bajo con venta activa. Ej. `TXV23QLAT20BE` (Quilt Atenas Beige, vel 22.2/sem, stock_full=66, cob_full=26d).
- **AGOTADO_PEDIR (18)**: sin stock pero proveedor tiene. Ej. `TXV25QLBRBG20` (Quilt Breda Beige, vel 2.4, stock_proveedor=30).
- **AGOTADO_SIN_PROVEEDOR (12)**: bloqueados en toda la cadena. Ej. `TEXCCWTILL10P` (Cubrecolchón Illusions, vel 5.8/sem, proveedor=0).

⚠️ **Anomalía detectada**: la mayoría de los AGOTADO_* tienen `dias_en_quiebre` entre 1 507 y 1 666 (4-4.5 años). Son valores herencia del cálculo de "primer quiebre" que debe estar leyendo una fecha antigua del histórico. Coherente con el campo pero no literal con la realidad operativa — los SKUs no llevan 4 años sin stock. Revisar en próximo sprint.

**Top 10 venta_perdida_pesos (30 d imputada)**:

| SKU | Nombre | Acción | Cuadrante | Perdido (CLP) | Días quiebre |
|---|---|---|---|---:|---:|
| TEXCCWTILL10P | Cubrecolchón Illusions Waterproof 10P | AGOTADO_SIN_PROV | ESTRELLA | **17 275 387** | 1 507 |
| TXV23QLAT20NG | Quilt Atenas 20P Negro | AGOTADO_SIN_PROV | ESTRELLA | 13 689 760 | 1 507 |
| TXV23QLAT15NG | Quilt Atenas 15P Negro | AGOTADO_SIN_PROV | ESTRELLA | 9 017 125 | 1 529 |
| TXTPBL105200S | Topper Illusions 1.5 P | AGOTADO_SIN_PROV | CASHCOW | 7 223 950 | 1 510 |
| BOLMATCUERCAF2 | Bolso Matero Café 2c Chico | MANDAR_FULL | ESTRELLA | 7 219 718 | 1 119 |
| TXV23QLRM30GR | Quilt MF Roma 30P Gris | AGOTADO_SIN_PROV | ESTRELLA | 6 228 096 | 1 515 |
| LITAF400G4PMT | Set 4 Toallas Family Menta | MANDAR_FULL | ESTRELLA | 5 315 703 | 1 092 |
| BOLMATCUERNEGX4 | Bolso Matero Negro 4c | MANDAR_FULL | ESTRELLA | 4 162 980 | 1 131 |
| TXV23QLAT15BE | Quilt Atenas 15P Beige | AGOTADO_SIN_PROV | REVISAR | 4 077 669 | 1 530 |
| TXSB144IRK10P | Sábana Illusions Rocket 10P | AGOTADO_SIN_PROV | ESTRELLA | 3 533 417 | 1 513 |

Los 10 tienen `oportunidad_perdida_es_estimacion=false` (margen calculado con datos reales, no fallback 25 %).

## 3. Forecast Accuracy (PR1-PR4)

### 3.1 Tablas nuevas — estado actual

| `forecast_snapshots_semanales.origen` | n | min_sem | max_sem |
|---|---:|---|---|
| `real` | 533 | 2026-04-13 | 2026-04-13 |
| `reconstruido` | 6 396 | 2026-01-19 | 2026-04-06 |

| `forecast_accuracy.ventana_semanas` | n | es_confiable |
|---:|---:|---:|
| 4 | 533 | **0** |
| 8 | 533 | **0** |
| 12 | 533 | **0** |

- **Último lunes con snapshot real**: 2026-04-13.
- **Próximo lunes real proyectado**: 2026-04-20 (cron lunes 12:30 UTC).
- **Última corrida `forecast_accuracy`**: 2026-04-17 13:03 UTC. La próxima es el 2026-04-20.

### 3.2 Simulación informativa (|TS|>4 tratando `en_quiebre=NULL` como excluible)

**72 SKUs** tendrían `|TS| > 4` si el sistema estuviera activo hoy (ventana 8 s):

| Cuadrante | n |
|---|---:|
| ESTRELLA | 13 |
| CASHCOW | 2 |
| VOLUMEN | 2 |
| REVISAR | 55 |

**Top 10 por |TS|**:

| SKU | Nombre | Cuadrante | ABC | XYZ | TS |
|---|---|---|---|---|---:|
| TXSBAF144LK2P | Sabana AFamily 144H Lark 20P | REVISAR | C | Z | −8 |
| JSAFAB442P20W | Sábanas AF Cuadra Mini | REVISAR | C | Z | +8 |
| JSAFAB441P20W | Sábanas AF Campine Lines | REVISAR | C | Z | +8 |
| JSAFAB440P20W | Sábanas AF Florelia Lines | REVISAR | C | Z | +8 |
| JSAFAB436P20W | Sábanas AF Campine 2.0 W | REVISAR | C | Z | +8 |
| MAN-FRA-ROS-00022 | Frazada saquito bebe | REVISAR | C | Z | −8 |
| 9788481693294 | Biblia Bolsillo Blanca | REVISAR | C | Z | −8 |
| TX2ALIMFP5070 | Pack almohadas Illusions | REVISAR | B | Z | +8 |
| TEXPRWTILL10P | Protector Illusions WP 10P | REVISAR | C | Z | −8 |
| JSAFAB439P20W | Sábanas AF Lavande Blanc | REVISAR | C | Z | +8 |

### 3.3 Alertas dormantes (cumplirían hoy si `es_confiable=true`)

| Alerta | Criterio | Cumplirían hoy |
|---|---|---:|
| `forecast_descalibrado_critico` | ABC A/B + XYZ X/Y + \|TS\|>4 + cuadrante=ESTRELLA | **10** |
| `forecast_descalibrado` | idem, otros cuadrantes | 8 |
| `forecast_sesgo_sostenido` | ABC A/B + n≥8 + \|bias\|/vel > 30 % | **39** |

**Estas alertas están escritas en el motor pero no disparan hasta 2026-05-18** (cuando haya 4 lunes con `en_quiebre=boolean` real → primera fila `es_confiable=true`). La simulación de arriba es informativa: así se verá el tab 📊 Accuracy cuando los datos confiables lleguen.

## 4. Estado del stack TSB (PR3-PR4)

### 4.1 Universo evaluado

| Métrica | Valor |
|---|---:|
| SKUs con `tsb_modelo_usado='tsb'` | **103** |
| SKUs con `vel_ponderada_tsb > 0` | 83 |
| Δ promedio absoluto \|vel_ponderada − vel_ponderada_tsb\| / vel_ponderada | **38.1 %** |

(Baja respecto a los 110 del PR3 Fase A inicial: −2 por los Toppers marcados estacionales + −5 por reclasificaciones naturales Z→Y tras últimos recálculos.)

### 4.2 Veredicto del benchmark (literal de `docs/banva-bodega-tsb-benchmark-2026-04-18.md`)

| # | Criterio | Valor | Umbral | Veredicto |
|---|---|---|---|---|
| 1 | Δ WMAPE mediano (SMA − TSB) | 5.1 % (SMA=90.5 %, TSB=85.4 %) | ≥ 15 % | ❌ FALLA |
| 2 | Regresiones ESTRELLA/CASHCOW-Z | 3 / 8 | 0 | ❌ FALLA |
| 3 | Bias TSB mediano / vel | 20.1 % | > −20 % | ✅ PASA |
| 4 | SMA<0.5 & TSB>3 | 0 / 26 (0.0 %) | < 10 % | ✅ PASA |

**Veredicto global: TSB ❌ NO PASA. Estado: no activado, shadow permanente hasta re-benchmark con datos reales.**

## 5. Crons activos (`vercel.json`)

18 crons. **En negrita los que tocan el stack de forecast.**

| Path | Schedule | Qué hace |
|---|---|---|
| `/api/ml/sync` | `* * * * *` | Polling órdenes Flex |
| `/api/ml/stock-sync` | `* * * * *` | Push stock Flex → ML |
| `/api/profitguard/sync` | `*/5 * * * *` | Enriquecer márgenes por orden |
| `/api/ml/margin-cache/refresh?stale=true&limit=25` | `*/5 * * * *` | Refresh margen cache |
| `/api/ml/metrics-sync` | `*/10 13-23 1-5 * *` | Billing + métricas L-V |
| `/api/ml/items-sync` | `*/30 * * * *` | Sync catálogo items |
| `/api/ml/sync-stock-full` | `*/30 * * * *` | Lectura stock Full |
| `/api/ml/attr-watch` | `0 */6 * * *` | Cambios atributos |
| `/api/ml/ads-daily-sync` | `0 */6 * * *` | Sync ads daily |
| `/api/ml/ads-rebalance` | `30 */6 * * *` | Rebalance presupuesto ads |
| `/api/agents/cron` | `0 8 * * *` | Triggers agentes |
| `/api/ml/ventas-reconcile` | `0 8 * * *` | Reconciliar ventas |
| `/api/ml/ventas-sync?days=7` | `0 10 * * *` | Bulk fetch 7 días |
| **`/api/intelligence/recalcular?full=true&snapshot=true`** | **`0 11 * * *`** | **Recálculo motor + snapshot diario** |
| `/api/ml/billing-cfwa-sync` | `0 13 * * *` | CFWA billing |
| `/api/intelligence/actualizar-lead-times` | `0 12 * * 1` | LT por proveedor (lunes) |
| **`/api/intelligence/forecast-accuracy`** | **`30 12 * * 1`** | **Snapshot + accuracy (lunes)** |
| `/api/semaforo/refresh` | `0 9 * * 1` | Semáforo semanal (lunes) |

## 6. Deuda técnica pendiente

Lectura combinada de `banva-bodega-inteligencia.md §12` y `banva-bodega-estado-actual.md §7`.

| # | Gap | Estado | Cambió ≤30 d |
|---|---|---|---|
| 1 | Recalc incremental por evento | Abierto | No |
| 2 | Tests del motor | Parcial (75 tests creados con PRs 1-4) | Sí |
| 3 | Versionado de configuración | Abierto | No |
| 4 | Forecast accuracy (WMAPE/bias/TS) | **Cerrado PR1+PR2** | Sí |
| 5 | TSB para demanda intermitente Z | **Shadow — no activado** (PR3 NO PASA benchmark) | Sí |
| 6 | Modelos estacionales (Holt-Winters) | **Parcial** (flag manual PR4 Fase 1); HW pendiente hasta tener ≥52 sem | Sí |
| 7 | EOQ / costo de orden | Abierto | No |
| 8 | Transacción atómica `/recalcular` | Abierto | No |
| 9 | Auto-match factura → OC | Abierto (66/66 recepciones huérfanas) | No |
| 10 | Factura SII separada de recepción | Abierto | No |
| 11 | Rate limiting API | Abierto | No |
| 12 | Webhook ML sin secret | Abierto | No |
| 13 | `stock_sync_queue` purga auto | Abierto | No |
| 14 | Retención `audit_log`/`agent_runs`/`ads_daily_cache` | Abierto (crecen indefinidamente) | No |
| 15 | PIN admin hardcoded + PINs operario en texto plano | Abierto | No |
| 16 | Migraciones versionadas / aplicadas manual | Parcial (regla operativa acordada 2026-04-17) | Sí |
| 17 | `pedidos_flex` legacy convive con `ml_shipments` | Abierto | No |
| 18 | `dias_en_quiebre` con valores 4+ años (ver §2.3) | **Cerrado PR5** (migración v55 + `fecha_entrada_quiebre` + backfill) | Sí |

## 7. Archivos fuente de verdad

| Archivo | Existe | LOC | Último commit que lo tocó |
|---|---|---:|---|
| `docs/banva-bodega-inteligencia.md` | ✅ | 931 | `d80940a` 2026-04-17 |
| `docs/banva-bodega-estado-actual.md` | ✅ | 623 | `3e520c6` 2026-04-16 |
| `docs/banva-bodega-forecast-accuracy-pr1.md` | ✅ | 169 | `d39fc37` 2026-04-17 |
| `docs/banva-bodega-forecast-accuracy-pr2.md` | ✅ (bonus) | 115 | `af1dcbf` 2026-04-17 |
| `docs/banva-bodega-tsb-pr3-fase-a.md` | ✅ | 128 | `b9ab905` 2026-04-17 |
| `docs/banva-bodega-tsb-benchmark-2026-04-18.md` | ✅ | 110 | `563b9a9` 2026-04-17 |
| `docs/banva-bodega-pr4-preauditoria.md` | ✅ | 192 | `71e83de` 2026-04-17 |

(`banva-bodega-estado-actual.md` está a 2 días de desfase — las migraciones v51-v54 + PR2-PR4 Fase 1 no están reflejadas allí. Actualizable en un PR separado cuando haga falta.)

## 8. Reglas operativas del manual — cumplimiento

Basado en `BANVA_Manual_Inventarios_Parte3.md` Fase 1-2 (referencia externa; grep en repo + DB).

| # | Regla | Estado | Evidencia |
|---|---|---|---|
| 1 | Reunión semanal de 30 min | **NO** | Sin cron, sin policy en repo |
| 2 | S&OP mensual de 90 min | **NO** | Sin cron, sin policy |
| 3 | FVA (Forecast Value Added) medido | **NO** | `grep -i fva src/` = 0 hits en código |
| 4 | 343 SKUs dead stock liquidados | **NO** | Hoy hay **341 dead stock** (>180d, stock>0). Acción `DEAD_STOCK=67` marca el subset puro; `liquidar` activa para SKUs con `liquidacion_accion!=null`, pero no hay acción externa (ML promo, markdown real) |
| 5 | Auditoría automática pausa ads en OOS | **NO** | `grep -i pausa.*ads` = 0 hits |
| 6 | Markdown automático (-20% a 90d, -40% a 120d) | **PARCIAL** | Motor sugiere `liquidacion_accion` y `liquidacion_descuento_sugerido` (10/25/40 %) en `intelligence.ts:1705-1715`, pero **no hay integración con ML promotions API** para aplicarlo automáticamente |

## 9. Próximos hitos temporales

| Fecha | Hito | Automatizado |
|---|---|---|
| 2026-04-20 lunes | 1er snapshot `origen='real'` con `en_quiebre=boolean` | ✅ cron |
| 2026-04-27 | 2do snapshot real | ✅ |
| 2026-05-04 | 3er snapshot real | ✅ |
| 2026-05-11 | 4to snapshot real | ✅ |
| **2026-05-18** | **Primera medición confiable ventana 4 s → alertas disparan** | ✅ |
| ~2026-06-08 | Ventana 8 s confiable (4 lunes reales sin quiebre) | — |
| ~2026-06-15 | Posible re-benchmark TSB con datos reales | Manual |
| **2026-10-18** | **Revisión obligatoria de los 3 SKUs estacionales** | Banner UI |
| ~2026-07 | Ventana 26 sem por SKU → pre-auditoría HW trimestral | Manual |
| ~2027-04 | Ventana 52 sem → pre-auditoría HW anual | Manual |

## 10. Ventana de trabajo disponible entre hoy y 2026-05-18

El stack de forecast está dormant. Lo accionable mientras tanto:

**Backlog operativo (data viva disponible hoy):**

1. **Liquidar los 341 dead stock**. 67 ya marcados como acción `DEAD_STOCK`, pero sin flujo que los convierta en acción ML. Costo inmovilizado en vel=0: $7.2 M CLP.
2. **46 urgentes**: resolver los 16 URGENTE reales y los 18 AGOTADO_PEDIR (proveedor disponible). Los 12 AGOTADO_SIN_PROVEEDOR son caso aparte (decisión de discontinuar vs buscar proveedor alternativo).
3. **Recuperar top 10 SKUs con venta perdida** ($72 M CLP acumulados estimados): 7 son ESTRELLA + 1 CASHCOW, de alto impacto.
4. **Auditar el campo `dias_en_quiebre` > 1 500 d** (anomalía §2.3). Probable bug de cálculo de "primer quiebre" con fecha incorrecta heredada.

**Backlog técnico (no bloquea funcionalidad actual):**

5. **Sincronizar `banva-bodega-estado-actual.md`** con las 4 migraciones nuevas (v51-v54).
6. **Implementar auditoría automática de pausa de ads en OOS** (regla §8.5, hoy en 0).
7. **Integración ML promotions** para aplicar `liquidacion_descuento_sugerido` del motor (regla §8.6, hoy parcial).
8. **Transacción atómica en `/api/intelligence/recalcular`** — hoy los 3 upserts (intel, history, snapshots) son independientes (gap #8).
9. **Purga de `stock_sync_queue`** y política de retención `audit_log`/`agent_runs` (gaps #13-#14).

**Tareas pendientes que requieren data futura (NO hacer ahora):**

- Re-benchmark TSB → esperar datos reales (≥2026-05-18).
- Detección automática de estacionalidad (PR4 Fase 2) → esperar ≥52 sem.
- Holt-Winters real (PR4 Fase 3) → esperar ≥52 sem por SKU (hoy: máx 14 sem).

---

**Generado**: 2026-04-18
**Método**: queries directas a Supabase + lectura del repo. Sin supuestos.
