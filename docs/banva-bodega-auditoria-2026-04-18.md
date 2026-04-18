# Auditoría BANVA Bodega vs Manuales — 2026-04-18

> Auditoría forense del estado real de BANVA Bodega contra los requisitos de los manuales de inventario clase mundial.
>
> **Fuentes de requisitos:**
> - `docs/manuales/BANVA_Manual_Inventarios_Parte1.md` (Partes 1–4: Fundamentos, Segmentación, Forecasting, Reposición)
> - `docs/manuales/BANVA_Manual_Inventarios_Parte2.md` (Partes 5–8: WMS, KPIs, Gigantes, Tecnología)
> - `docs/manuales/BANVA_Manual_Inventarios_Parte3.md` (Partes 9–12: Errores, Roadmap, Glosario, Biblio)
> - `docs/manuales/Gestión_de_Inventario_Guía_Completa.docx.md`
> - `docs/manuales/Manual_Experto_Gestión_Inventarios_Textiles.md`
>
> **Realidad evaluada:** código en `src/`, migraciones `supabase-v*.sql`, estado DB (snapshot 2026-04-18), `.claude/rules/*`.
>
> **Estados:** ✅ Cumple / ⚠️ Parcial / ❌ No cumple / 🔮 No aplica todavía. **Prioridad:** A (bloquea/cuesta plata hoy) / M (estructural no urgente) / B (refinamiento).

---

## Área 1 — Segmentación (ABC-XYZ, KVI, PLC)

| # | Requisito del manual | Fuente | Estado BANVA | Evidencia | Gap | Prio |
|---|---|---|---|---|---|---|
| 1.1 | ABC por 3 ejes (ingresos, margen, unidades) actualizado semanalmente | Parte1 §2.2 | ✅ Cumple | `sku_intelligence` columnas `abc_margen`, `abc_ingreso`, `abc_unidades`; migración `supabase-v15-sku-intelligence.sql`; `src/lib/intelligence.ts:1468-1558` (PASO 9) calcula los 3 ejes. DB: 533/533 SKUs con los 3 ejes poblados | Ninguno material | — |
| 1.2 | XYZ por coeficiente de variación (CV) | Parte1 §2.3 | ✅ Cumple | `sku_intelligence.xyz`, `cv`, `desviacion_std`; `src/lib/intelligence.ts:1055-1075` calcula CV sobre 12 semanas; DB: 533/533 SKUs con XYZ | Ventana fija 12 semanas sin auto-tuning | B |
| 1.3 | Recálculo semanal automático | Parte1 §2.8 (Amazon movement classes) | ⚠️ Parcial | `/api/intelligence/recalcular/route.ts` existe. **No hay cron en `vercel.json` que lo invoque**; recálculo es manual desde admin | Cron semanal automático | M |
| 1.4 | KVI identificados explícitamente (10-25 SKUs) | Parte1 §2.7 | ❌ No cumple | Grep exhaustivo `KVI\|key_value` en `src/` → **0 matches**. No hay tabla, columna ni tag `es_kvi` en `productos` o `sku_intelligence` | Implementar flag `es_kvi` + UI para marcarlos | A |
| 1.5 | PLC tagueado por SKU (Introducción/Crecimiento/Madurez/Declive) | Parte1 §2.6 | ❌ No cumple | Grep `plc\|ciclo_vida\|introduccion\|madurez\|declive` → 0 matches. Existe `dias_desde_primera_venta` pero no se traduce a fase PLC | Agregar campo `fase_plc` con lógica automática | M |
| 1.6 | Matriz ABC-XYZ de 9 cuadrantes con política diferenciada | Parte1 §2.4 | ⚠️ Parcial | Existe matriz BANVA propia de 4 cuadrantes (`ESTRELLA/VOLUMEN/CASHCOW/REVISAR`) en `intelligence.ts:1511-1574`. **NO** es la matriz 9 (AX/AY/…/CZ) que exige el manual. Política por cuadrante: `target_dias_full` se asigna por ABC solo, no por cuadrante (ver `intelligence.ts:1559`) | Migrar a matriz 9 oficial + políticas diferenciadas por cuadrante | M |
| 1.7 | Políticas por cuadrante documentadas | Parte1 §2.9 | ❌ No cumple | No existe `.claude/rules/inventory-policy.md`. Políticas viven dispersas en código | Crear doc de política formal | A |
| 1.8 | Marcar SKUs en fase "declive" para liquidación | Parte1 §2.6 | ⚠️ Parcial | Se detectan `dead_stock` (alerta) y `liquidacion_accion` por exceso de DIO, pero no hay tag explícito de fase PLC | Ver 1.5 | M |

---

## Área 2 — Forecasting

| # | Requisito del manual | Fuente | Estado BANVA | Evidencia | Gap | Prio |
|---|---|---|---|---|---|---|
| 2.1 | WMAPE como KPI oficial por cuadrante ABC-XYZ | Parte1 §3.4.2 | ⚠️ Parcial | `src/lib/forecast-accuracy.ts:108` calcula WMAPE; `sku_intelligence.forecast_wmape_8s` existe; tabla `forecast_accuracy` (1599 filas). **DB muestra 0 SKUs con `es_confiable=true` y `semanas_evaluadas=0` para todos** — métrica se persiste pero nunca alcanza la confiabilidad mínima de 4 semanas | Ejecutar backfill y/o cron que escriba semanas_evaluadas reales | A |
| 2.2 | Bias medido mensualmente (target ±5%) | Parte1 §3.4.3 | ⚠️ Parcial | `forecast_accuracy.bias` persistido; fórmula `src/lib/forecast-accuracy.ts:109`. Mismo problema que 2.1: todas las filas con `semanas_evaluadas=0` | Reporte mensual aún no produce número útil | A |
| 2.3 | Tracking Signal semanal (target \<\|4\|) | Parte1 §3.4.3 | ⚠️ Parcial | `forecast_tracking_signal_8s` existe en `sku_intelligence`; fórmula en `forecast-accuracy.ts:111`. Sin alerta automática `\|TS\|>4` fuera de cuadrante ESTRELLA (`intelligence.ts:1542-1545`) | Alerta global para todos los A/B | M |
| 2.4 | FVA (Forecast Value Added) medido | Parte1 §3.9 | ❌ No cumple | Grep `FVA\|forecast_value_added\|naive_baseline` → 0 matches. No hay comparación contra naive | Instrumentar FVA vs naive para validar que el motor mejora el baseline | M |
| 2.5 | Holt-Winters multiplicativo para X/Y | Parte1 §3.2.4 | ❌ No cumple | Grep `holt\|winters` → 0 matches. El motor usa SMA ponderada (vel_7d/30d/60d con pesos) + eventos, no Holt-Winters | Implementar HW vía `statsforecast` de Nixtla | M |
| 2.6 | TSB / Croston para SKUs Z | Parte1 §3.2.6 | ⚠️ Parcial | `src/lib/tsb.ts` implementa TSB completo (grid search α,β, auto-calibración). Persistido: `vel_ponderada_tsb`, `tsb_alpha`, `tsb_beta`, `tsb_modelo_usado`. **Shadow mode:** 104/533 SKUs con TSB calculado, pero `vel_ponderada` consumida en reposición NO usa `vel_ponderada_tsb` | Activar consumo de TSB en SKUs Z (Fase C pendiente) | A |
| 2.7 | Calendario de eventos discretos como regresor | Parte1 §3.7 | ✅ Cumple | Tabla `eventos_demanda` (7 filas) con CyberDay Mayo (×2.5), Día Madre (×1.3), Fiestas Patrias (×1.3), CyberMonday Oct (×2.5), BF (×2.0), Navidad (×2.0), Rebajas Año Nuevo (×1.5). `intelligence.ts:974-982` aplica multiplicador por categoría al `vel_ponderada` | Ninguno material | — |
| 2.8 | Cold start (SKUs \<60 días) | Parte1 §3.6 | ❌ No cumple | `dias_desde_primera_venta` persistido; 82 SKUs con \<60 días y 215 sin primera venta registrada. **No hay lógica de analog matching** — SKU nuevo obtiene vel=0 hasta acumular historia | Implementar analog forecasting por categoría + atributos | M |
| 2.9 | Separación insesgada forecast vs planning sesgado safety stock | Parte3 §9 Error #2 | ✅ Cumple | `vel_ponderada` (forecast) y `pedir_proveedor`/`rop_calculado` (planning) son campos distintos; ajuste safety stock es explícito en `intelligence.ts:1735-1742` | — | — |

---

## Área 3 — Reposición (EOQ, ROP, SS)

| # | Requisito del manual | Fuente | Estado BANVA | Evidencia | Gap | Prio |
|---|---|---|---|---|---|---|
| 3.1 | EOQ calculado por SKU A | Parte1 §4.1 | ❌ No cumple | Grep `EOQ\|wilson\|economic_order` → 0 matches. No hay cálculo `Q* = √(2DS/H)`. `calcularPedirVenta()` usa cobertura objetivo heurística (`target_dias_full` por ABC), no EOQ | Implementar EOQ por SKU A/B | M |
| 3.2 | ROP automático para top 30 A (política s,Q) | Parte1 §4.4.5 | ⚠️ Parcial | `sku_intelligence.rop_calculado` existe; `intelligence.ts:1742` lo calcula como `D×LT + SS_completo`. Flag `necesita_pedir` cuando `stock_total ≤ rop_calculado`. **Problema:** 0 SKUs con `lead_time_real_sigma` poblado → `safety_stock_completo` calculado para 298 SKUs pero con σ_LT=0 (fallback) | Backfill σ_LT desde OCs históricas | A |
| 3.3 | Política (R,S) semanal para B y C | Parte1 §4.3 | ❌ No cumple | No hay rutina de revisión periódica semanal B/C. Política única por ABC se evalúa cada recálculo manual | Definir cadencia (R,S) explícita | B |
| 3.4 | Safety stock con fórmula completa (σ_D y σ_LT) | Parte1 §4.4.1 | ⚠️ Parcial | Fórmula implementada: `safety_stock_completo = Z×√(LT×σ_D² + D̄²×σ_LT²)` en `intelligence.ts`. 298/533 SKUs con SS completo calculado, **pero ninguno con σ_LT real** (DB: `lead_time_real_sigma` IS NULL en todos). Se está usando σ_LT=0 → equivalente a la fórmula simple | Medir σ_LT real y persistirlo | A |
| 3.5 | Lead time variability (σ_LT) medido con OCs históricas | Parte1 §4.4.1 / §6.6.1 | ❌ No cumple | `src/lib/intelligence-queries.ts` tiene función para computar σ_LT desde OCs; campos DB existen. **Estado actual:** solo 4 filas en `ordenes_compra` → muestra insuficiente para σ_LT por proveedor | Registrar más OCs históricamente o importar desde Excel | A |
| 3.6 | MOQ negociado, no ciegamente respetado | Parte3 §9 Error #9 | ⚠️ Parcial | Campo `productos.moq` existe; alerta `pedido_bajo_moq` se emite (`intelligence.ts:1793`). **`calcularPedirVenta()` NO hace round-up automático** — solo alerta | Decidir política explícita: round-up vs alertar | B |
| 3.7 | Ramp-up post-quiebre (4-6 semanas) | Parte3 §9 Error #5 | ✅ Cumple | `src/lib/rampup.ts` matriz 6×2 (días en quiebre × tipo de quiebre); factor ∈ {0, 0.3, 0.5, 0.75, 1.0}; aplicado a `pedir_proveedor_sin_rampup` → `pedir_proveedor`. Migración `supabase-v55-dias-en-quiebre.sql`. DB: 45 SKUs actualmente en quiebre | — | — |
| 3.8 | Generación de OC sugerida lista para 1-click | Parte1 §4.8 | ⚠️ Parcial | `sku_intelligence.pedir_proveedor` y `pedir_proveedor_bultos` se calculan. Tabla `ordenes_compra` solo tiene 4 filas; flujo admin para convertir sugerencia a OC existe pero poco usado | Empujar uso real y cerrar loop medición OTIF | M |
| 3.9 | Service level configurable por cuadrante (AX 99%, CZ 85%…) | Parte1 §4.4.4 | ❌ No cumple | `sku_intelligence.nivel_servicio` existe como columna simple; no hay matriz 9 cuadrantes × z-score | Tabla `service_level_config` por cuadrante | M |

---

## Área 4 — Operaciones de bodega (IRA, cycle count, slotting, picking)

| # | Requisito del manual | Fuente | Estado BANVA | Evidencia | Gap | Prio |
|---|---|---|---|---|---|---|
| 4.1 | IRA >95% medido (target 98%) | Parte2 §5.6.2 / §6.7 KPI #11 | ❌ No cumple | Grep `\bIRA\b\|inventory_record_accuracy` en `src/` → 0 matches. `sku_intelligence.diferencias_conteo` captura delta por conteo, pero no se agrega a un KPI `%IRA` ni se publica en dashboard | Calcular IRA diario, publicar en dashboard | A |
| 4.2 | Cycle counting diario (~4 SKUs/día) | Parte2 §5.6.1 | ❌ No cumple | Tabla `conteos` tiene solo **2 filas**. No hay cron ni lógica que genere lista diaria automática de ~4 SKUs priorizados por ABC. Alerta `sin_conteo_30d` existe en `intelligence.ts:1815` pero no se accióna | Generar lista diaria + medir compliance | A |
| 4.3 | Blind count en recepción | Parte2 §5.2 | ❌ No cumple | Recepciones (`recepciones`, `recepcion_lineas`) muestran ASN previo al conteo — operador VE lo esperado. No hay modo "ciego" | Toggle blind count en UI de recepción | M |
| 4.4 | Golden zone para top 30 SKUs A | Parte2 §5.3.2 | ❌ No cumple | Grep `golden_zone` → 0 matches. `posiciones` no tiene atributo `zona_ergonomica`. Mapa visual existe pero sin lógica de asignación | Marcar posiciones golden + sugerencia semanal | M |
| 4.5 | Re-slotting mensual A, trimestral B, anual C | Parte2 §5.3.3 | ❌ No cumple | No existe reporte de propuesta de re-slotting | Cron que proponga movimientos por ABC × velocidad | M |
| 4.6 | Batch picking con cluster (vs discrete) | Parte2 §5.4 | ❌ No cumple | `picking_sessions` y `picking_bultos` modelan picking pero por orden individual (5 bultos / 6 líneas en DB). No hay agrupación batch multi-orden | Implementar batch con carrito multi-tote | M |
| 4.7 | TSP optimization (vs serpentina) | Parte2 §5.5 | ❌ No cumple | No hay algoritmo de ruta (nearest-neighbor/TSP) en picking | Introducir TSP aproximado al asignar posiciones | B |
| 4.8 | Dock-to-stock \<24h medido | Parte2 §5.8 | ❌ No cumple | `recepciones` tiene `created_at` pero no hay timestamp separado de "disponible para venta"; métrica no se calcula | Agregar timestamps + KPI | B |
| 4.9 | Perfect order rate | Parte2 §5.8 / §6.3.3 | ❌ No cumple | Grep `perfect_order` → 0 matches; no hay composición multiplicativa (a tiempo × completo × sin daño × correcto) | Definir y calcular | B |

---

## Área 5 — KPIs y dashboards

| # | Requisito del manual | Fuente | Estado BANVA | Evidencia | Gap | Prio |
|---|---|---|---|---|---|---|
| 5.1 | Los 25 KPIs de §6.7 implementados | Parte2 §6.7 | ⚠️ Parcial | Cobertura real: `dio`, `gmroi`, `venta_perdida_uds/pesos`, `ingreso_perdido`, `dias_sin_stock_full`, `semanas_con_quiebre` existen en `sku_intelligence`. **Faltan:** turnover, sell_through_90d, dead_stock_%, CCC, fill_rate, stockout_rate, lost_sales_$ agregado, perfect_order, IRA, pick_accuracy, damage_rate, shrinkage, dock_to_stock, order_cycle_time, lines_per_hour, idetex_OTIF, idetex_LT_CV, WMAPE_por_cuadrante, bias, tracking_signal_confiable, return_rate, carrying_cost_%. Aprox **9/25 = 36%** cubiertos | Implementar los 16 KPIs faltantes | A |
| 5.2 | Owner explícito y frecuencia por KPI | Parte2 §6.7 / §6.8 | ❌ No cumple | No existe tabla `kpis` con columnas `owner`, `frecuencia`, `target`. Los KPIs viven implícitos en columnas de `sku_intelligence` | Crear tabla + UI | A |
| 5.3 | Dashboard único (no múltiples) | Parte2 §6.8 | ⚠️ Parcial | `AdminInteligencia.tsx` es el dashboard principal pero `/admin` tiene 13 tabs (Dashboard, Recepciones, Picking, Pedidos ML, Etiquetas, Conteos, Operaciones, Inventario, Movimientos, Productos, Posiciones, Carga Stock, Config). Cada tab es su propia vista | Consolidar vista ejecutiva | B |
| 5.4 | Revisión semanal 30 min (Vicente+Enrique+Joaquín) instaurada | Parte1 §2 / Parte2 §6.8 | ❌ No cumple | No hay tabla `reuniones` ni doc que registre cadencia. Grep `reunion\|meeting\|standup` → 0 matches | Crear log + agenda recurrente | M |
| 5.5 | S&OP mensual 90 min instaurado | Parte3 §9 Error #14 | ❌ No cumple | Grep `sop\|s&op\|sales_operations` → 0 matches | Cadencia mensual documentada | M |
| 5.6 | Ningún KPI sin owner | Parte2 §6.8 | ❌ No cumple | Mismo gap que 5.2 | — | A |
| 5.7 | Bonos ligados a DIO/GMROI (no solo ventas) | Parte2 §7.7 (Apple) / Parte3 §10 Fase 3 | ❌ No cumple | No auditable en código; política HR fuera de WMS. No hay contrato comprometido | Decisión de Vicente (fuera de BANVA Bodega) | M |

---

## Área 6 — Dead stock y liquidación

| # | Requisito del manual | Fuente | Estado BANVA | Evidencia | Gap | Prio |
|---|---|---|---|---|---|---|
| 6.1 | Política markdown automática 90d/120d/180d | Parte1 §2.6 / Parte3 §9 Error #6 / §10 Fase 1 | ⚠️ Parcial | `intelligence.ts:1755-1771` PASO 17 implementa un protocolo diferente: `diasExtra = dio - target_dias_full`; >30d→-10%, >60d→-25%, >90d→-40% ("precio_costo"). **NO es** la regla del manual (que pide días sin venta: 90→-20, 120→-40, 180→liquidar). Además solo aplica a `abc=C` ó `cuadrante=REVISAR` con `vel>0` | Implementar regla del manual literal + descontinuación para vel=0 | A |
| 6.2 | Dead stock ratio medido (target \<8%) | Parte2 §6.5.2 | ❌ No cumple | No existe KPI `dead_stock_%` agregado en dashboard ni en DB. 235 SKUs con `vel_ponderada=0` (44% del catálogo activo de 533) — ratio actual estimado sin medición formal | KPI + alerta cuando ratio >8% | A |
| 6.3 | Regla escrita: no permanencia \>180d sin movimiento | Parte1 §1.2 / Parte3 §9 Error #6 | ❌ No cumple | `sku_intelligence.dias_sin_movimiento = 999` para los 533 SKUs → columna nunca se popula correctamente (sentinel por default). Regla no enforzable | Bug: popular `dias_sin_movimiento` desde tabla `movimientos` | A |
| 6.4 | Liquidación inicial de los 91 (ahora 235 zero-velocity + 127 con acción) dead stock históricos | Parte1 §2.9 / Parte3 §10 Fase 1 | ❌ No cumple | DB: 127 SKUs con `liquidacion_accion` asignada por el motor; ninguna ejecutada visible en ajustes de precio ML | Campaña de liquidación + integración con precios ML | A |

---

## Área 7 — Integración con MELI (ranking + stock + ads)

| # | Requisito del manual | Fuente | Estado BANVA | Evidencia | Gap | Prio |
|---|---|---|---|---|---|---|
| 7.1 | Pausa automática de ads cuando stock proyectado \<10 días | Parte3 §9 Error #4 / §10 Fase 1 | ❌ No cumple | Grep `pausar_ads\|pause.*ad\|ads.*stockout` → matches son menciones en comentarios, no lógica activa. `ml_ads_daily_cache` (30,008 filas) trackea ads pero no hay rutina que pausar cuando `stock_proyectado_dias < 10`. **Costo estimado según manual: $200-400K/mes quemados** | Implementar en `/api/ml/ads-daily-sync` + cron | **A (crítico)** |
| 7.2 | Inventario Full basado en "Stock Depletion Velocity" | Parte2 §7.4 | ⚠️ Parcial | `stock_full_cache` (753 filas) sincroniza stock ML. `vel_full` y `cob_full` existen. `envio_full_pendiente` (5) y `envios_full_historial` (9). **No hay modelo predictivo** tipo "algorithm-based depletion" | Modelo de proyección Full | M |
| 7.3 | Auditoría mensual de Full (retirar SKUs \<0.5 uds/sem) | Parte3 §9 Error #17 / §10 Fase 3 | ❌ No cumple | No hay reporte ni cron que liste SKUs en Full con velocidad baja para retiro | Cron mensual + alerta | M |
| 7.4 | Bundle/listing compliance | Parte2 §7.4 | ⚠️ Parcial | `composicion_venta` (419) mapea `sku_venta → sku_origen` pero no hay validación de "etiquetado correcto Inbound Full" | Revisar flujo inbound Full | B |
| 7.5 | Audit del ranking post-quiebre | Parte3 §9 Error #5 | ❌ No cumple | No hay tracking de posición en búsqueda ML pre/post quiebre | Scraper o API de visibility | B |
| 7.6 | Ads con margen: pausar/ajustar si margen negativo | Parte3 §9 Error #4 | ⚠️ Parcial | `ml_margin_cache` (623) y alertas `margen_negativo_full/flex` existen (`intelligence.ts:1799-1800`). No hay pausa automática | Integrar con Product Ads API | A |

---

## Área 8 — Relación con proveedor (Idetex)

| # | Requisito del manual | Fuente | Estado BANVA | Evidencia | Gap | Prio |
|---|---|---|---|---|---|---|
| 8.1 | OTIF de Idetex medido (target \>90%) | Parte2 §6.6 / §6.7 KPI #18 | ❌ No cumple | Grep `OTIF\|otif` → 0 matches. No hay cálculo `OCs_a_tiempo_y_completas / OCs_totales` | Instrumentar cierre de OCs con delta de fecha/cantidad | A |
| 8.2 | σ_LT de Idetex medido (target CV \<0.25) | Parte2 §6.6.1 / §6.7 KPI #19 | ❌ No cumple | `sku_intelligence.lead_time_real_sigma` existe pero 0/533 poblado. `ordenes_compra` solo 4 filas → muestra insuficiente. Con 398 SKUs Idetex, debería haber historial | Backfill OCs históricas o Excel→DB | A |
| 8.3 | Data sharing con Idetex (tipo Walmart Retail Link) | Parte2 §7.2 | ❌ No cumple | No hay export automático de ventas/forecast hacia Idetex. Grep `idetex` en `src/` → 0 matches activas | Dashboard compartido o email semanal | M |
| 8.4 | VMI piloto para top 20 SKUs | Parte2 §7.2 / Parte3 §10 Fase 3 | ❌ No cumple | Sin código ni tabla VMI | Acuerdo contractual + tabla `vmi_config` | M |
| 8.5 | Diversificación de proveedores para top 30 | Parte3 §9 Error #20 | ❌ No cumple | DB: **398/443 (90%) de SKUs con proveedor = Idetex**. Alternativos (Container, LG, Materos, Otro, Verbo Divino) cubren \<10%. Riesgo Toyota 1997 vigente | Identificar 2-3 alternativos por SKU A | A |
| 8.6 | Reunión trimestral con Idetex | Parte3 §10 Fase 2 | ❌ No cumple | No auditable en código | Cadencia fuera de WMS | B |
| 8.7 | Proveedor catálogo con stock disponible | Parte2 §8 | ✅ Cumple | `proveedor_catalogo` (896 filas) con `stock_disponible`, `inner_pack`, `precio_neto`; lógica de consumo en `intelligence.ts:376`. Migraciones v24/v39/v42 | — | — |

---

## Área 9 — Procesos y gobernanza

| # | Requisito del manual | Fuente | Estado BANVA | Evidencia | Gap | Prio |
|---|---|---|---|---|---|---|
| 9.1 | Reuniones instauradas (semanal + S&OP mensual) | Parte2 §6.8 / Parte3 §10 Fase 1-2 | ❌ No cumple | Sin log ni cadencia documentada | Doc + recordatorios | M |
| 9.2 | Owners explícitos por KPI | Parte2 §6.7 | ❌ No cumple | Ver 5.2 | — | A |
| 9.3 | Políticas escritas en `.claude/rules/inventory-policy.md` | Parte1 §2.9 | ❌ No cumple | `.claude/rules/` contiene `supabase.md`, `ui-ux.md`, `meli-api.md`, `security.md`, `testing.md`. **Ningún archivo `inventory-policy.md`** | Crear el doc | A |
| 9.4 | Documento de baseline firmado (Fase 0) | Parte3 §10 Fase 0 | ❌ No cumple | No existe `baseline-2026.md` ni equivalente | Generar a partir de esta auditoría | A |
| 9.5 | BANVA Bodega como single source of truth | Parte3 §9 Error #18 | ⚠️ Parcial | WMS es SSoT técnico para stock/movimientos. Pero costos, eventos y reglas de liquidación viven parte en Excel/manual. `costos_historial` (10) sugiere Excel para catálogos nuevos | Documentar qué está en WMS vs Excel, migrar Excel residual | M |
| 9.6 | Trazabilidad de decisiones (audit log) | Parte3 §9 Error #18 | ✅ Cumple | `audit_log` (11,825 filas), `admin_actions_log` (39), `sync_log` (260), `ml_webhook_log` (6,853). Migración `supabase-v29-audit-log.sql`. Estructura: acción, entidad, params, resultado, operario, timestamp | Falta consumer/dashboard | B |
| 9.7 | `sku_revision_log` para trazabilidad de decisiones de reposición | — | ⚠️ Parcial | Tabla existe pero 0 filas → infraestructura sin uso | Activar registro al aprobar OCs | B |

---

## Área 10 — Los 20 errores comunes (Parte3 §9)

| # | Error del manual | ¿BANVA lo comete hoy? | Evidencia | Prio |
|---|---|---|---|---|
| 10.1 | #1 Tratar todos los SKUs igual | ⚠️ Parcial | ABC-XYZ existe (533/533) pero políticas de reposición diferencian solo por ABC (`target_dias_full` por A/B/C), no por cuadrante. Cuadrante se calcula pero no se consume en decisión | M |
| 10.2 | #2 Confundir forecast con planning | ✅ No lo comete | Separación clara `vel_ponderada` vs `pedir_proveedor`/`rop_calculado` (`intelligence.ts:1407`, 1742) | — |
| 10.3 | #3 Ignorar lead time variability (σ_LT) | ⚠️ Sí lo comete en la práctica | Fórmula completa implementada, pero 0/533 SKUs con σ_LT real poblado → equivale a usar fórmula simple | A |
| 10.4 | #4 Advertising en SKUs sin stock | ❌ Sí lo comete | Sin pausa automática; 30K filas en `ml_ads_daily_cache` sin cruce contra cobertura proyectada | **A (crítico)** |
| 10.5 | #5 Stockout sin replanning (ramp-up) | ✅ No lo comete | `src/lib/rampup.ts` matriz completa, PRs #261-264 en prod. 45 SKUs activos con `dias_en_quiebre > 0` | — |
| 10.6 | #6 Dead stock perpetuo | ❌ Sí lo comete | 235/533 SKUs con vel=0; `dias_sin_movimiento=999` para todos (bug); regla 180d no enforzable | A |
| 10.7 | #7 Bullwhip effect | ⚠️ Posible | Sin data sharing Idetex (8.3); aunque ramp-up contiene el post-quiebre, sobre-reacción pre-evento no controlada | M |
| 10.8 | #8 Confiar en stock del sistema sin cycle count | ❌ Sí lo comete | 2 conteos totales; no hay rutina diaria; IRA no calculado | A |
| 10.9 | #9 MOQ ciegamente respetado | ⚠️ Parcial | `moq` alertable pero no round-up automático. No hay evidencia de negociación documentada | B |
| 10.10 | #10 Comprar más para ahorrar en envío | ⚠️ Posible | Sin EOQ, decisiones heurísticas dejan espacio a este sesgo | M |
| 10.11 | #11 Forecast solo con historia | ⚠️ Parcial | Eventos como regresor SÍ (§2.7), pero no hay precio relativo, ad_spend, trend externo | M |
| 10.12 | #12 Promociones sin pre-build de stock | ⚠️ Parcial | Calendario existe (7 eventos); multiplicador se aplica al forecast; **no hay lock automático de pre-build 6 semanas antes** | A |
| 10.13 | #13 No medir costo real de stockout | ✅ No lo comete | `venta_perdida_uds/pesos`, `ingreso_perdido`, `oportunidad_perdida_es_estimacion` (`intelligence.ts:1198-1230`) | — |
| 10.14 | #14 Demand planning sin S&OP | ❌ Sí lo comete | Sin ceremonia mensual documentada | M |
| 10.15 | #15 Promos destruyen margen | ❌ Sí lo comete | Sin KVI (§1.4), multiplicador de evento aplica igual a todos | A |
| 10.16 | #16 Atribuir ventas al canal equivocado | ✅ No lo comete | `vel_full`/`vel_flex` separados; `margen_full_30d`/`margen_flex_30d` diferenciados; `canal_mas_rentable` calculado | — |
| 10.17 | #17 Full sin disciplina de retiro | ❌ Sí lo comete | Sin auditoría mensual Full (§7.3) | M |
| 10.18 | #18 No tener single source of truth | ⚠️ Parcial | WMS es SSoT técnico, Excel en reglas y costos legacy (§9.5) | M |
| 10.19 | #19 Heurísticas humanas para 345 SKUs | ✅ No lo comete | Motor `intelligence.ts` ejecuta 19 pasos automáticos; 533 SKUs procesados | — |
| 10.20 | #20 Sin contingencia de proveedor | ❌ Sí lo comete | 90% dependencia Idetex (398/443); sin alternativo automático | A |

**Score errores:** evita 6/20 explícitamente (errores 2, 5, 13, 16, 19, y parcial en otros). Comete o deja abiertos ≥10/20. Los 5 más caros hoy (según manual): #4 ads sin stock, #6 dead stock perpetuo, #8 sin cycle count, #15 promos sin KVI, #20 proveedor único.

---

## Resumen ejecutivo

### Cumplimiento global

Conteo sobre las 10 áreas (63 filas de requisito total):

- ✅ Cumple: **11** (17%)
- ⚠️ Parcial: **20** (32%)
- ❌ No cumple: **32** (51%)

**Cumplimiento ponderado:** ✅=1.0, ⚠️=0.5, ❌=0.0 → (11 + 10) / 63 = **33%**.

### Cumplimiento por área

| Área | ✅ | ⚠️ | ❌ | Score | Estado |
|---|---|---|---|---|---|
| 1. Segmentación | 2 | 3 | 3 | 44% | Buen cimiento, falta KVI/PLC/matriz9 |
| 2. Forecasting | 2 | 4 | 3 | 44% | Métricas persistidas pero no confiables |
| 3. Reposición | 1 | 4 | 4 | 33% | SS sin σ_LT real, EOQ ausente |
| 4. Operaciones | 0 | 0 | 9 | **0%** | **Gap mayor** — sin IRA, cycle count, slotting, batch picking |
| 5. KPIs | 0 | 2 | 5 | 14% | 36% KPIs cubiertos, sin owner |
| 6. Dead stock | 0 | 1 | 3 | 13% | Bug: `dias_sin_movimiento=999` todos |
| 7. MELI | 0 | 3 | 3 | 25% | Ads sin pausa = sangría activa |
| 8. Proveedor | 1 | 0 | 6 | 14% | 90% Idetex, sin OTIF/σ_LT real |
| 9. Gobernanza | 1 | 2 | 4 | 29% | Audit log fuerte, sin reuniones/policy |
| 10. Errores 20 | 6 | 6 | 8 | 45% | Evita los estructurales, no los operativos |

**Áreas más fuertes:** 10 (errores), 1 (segmentación), 2 (forecasting).
**Áreas más débiles:** 4 (ops bodega 0%), 6 (dead stock 13%), 5 (KPIs 14%), 8 (proveedor 14%).

### Top 5 gaps prioridad A (duelen hoy)

1. **Pausar automáticamente Product Ads cuando stock proyectado \<10d** (Área 7.1, Error #4). Ahorro estimado manual: $200-400K/mes.
2. **Corregir bug `dias_sin_movimiento=999`** (Área 6.3) — columna sentinel en todos; dead stock no enforzable.
3. **Backfill σ_LT por proveedor desde OCs históricas** (Área 3.5, 8.2). 0/533 SKUs con σ_LT real; safety stock está subestimado para proveedor errático.
4. **WMAPE/Bias confiables: backfill `semanas_evaluadas`** (Área 2.1, 2.2). Hoy 1599 filas de `forecast_accuracy`, todas con `semanas_evaluadas=0` → métrica no audible.
5. **Cycle counting diario (4 SKUs/día) + cálculo de IRA** (Área 4.1, 4.2, Error #8). Sin esto, todas las decisiones descansan sobre data de calidad desconocida.

### Top 10 gaps prioridad M (roadmap 6 meses)

1. Matriz ABC-XYZ 9 cuadrantes oficial con política diferenciada (1.6, 1.7).
2. KVI flag + lógica de defensa de precio (1.4, Error #15).
3. Holt-Winters multiplicativo para X/Y con Nixtla (2.5).
4. Cold-start analog forecasting para 82 SKUs \<60d (2.8).
5. EOQ clásico para SKUs A/B (3.1).
6. Service level por cuadrante (3.9).
7. Re-slotting mensual A + golden zone (4.4, 4.5).
8. Batch picking con cluster (4.6).
9. Owners/frecuencia por KPI + ceremonia semanal y S&OP (5.2, 5.4, 5.5).
10. Diversificación de proveedores top 30 (8.5, Error #20).

### Errores del Parte 3 que BANVA comete hoy

**Cometidos (❌):** #4, #6, #8, #14, #15, #17, #20 — **7 errores**.
**Parciales (⚠️):** #1, #3, #7, #9, #10, #11, #12, #18 — **8 errores**.
**Evitados (✅):** #2, #5, #13, #16, #19 — **5 errores**.
**Score:** 25% errores evitados limpiamente, 40% parciales, 35% abiertos.

---

## Comparación con el roadmap del manual

### Fase 0 — Diagnóstico y baseline (Mes 0)

| Entregable | Estado | Evidencia |
|---|---|---|
| Cálculo de los 25 KPIs | ⚠️ 36% | 9/25 implementados |
| Matriz ABC-XYZ inicial | ✅ | 533/533 SKUs |
| Dead stock cuantificado $CLP | ❌ | No hay KPI agregado |
| Lost sales último mes $CLP | ⚠️ | Por SKU sí (`ingreso_perdido`); agregado no publicado |
| CCC actual | ❌ | No calculado |
| Doc baseline firmado | ❌ | Esta auditoría puede servir |

**Fase 0: ~40% completada.**

### Fase 1 — Cimientos y quick wins (Meses 1-3)

| Entregable | Estado |
|---|---|
| Pausa automática de ads | ❌ |
| Política markdown 90/120/180 | ⚠️ variante propia, no la del manual |
| Liquidación 91 dead stock | ❌ |
| Cycle counting diario | ❌ |
| Matriz ABC-XYZ activa | ✅ |
| Política por cuadrante documentada | ❌ |
| SS con σ_D y σ_LT | ⚠️ fórmula sí, σ_LT no poblado |
| ROP automático top 30 A | ⚠️ existe pero con SS subestimado |
| Dashboard único | ⚠️ |
| Reunión semanal 30 min | ❌ |

**Fase 1: ~30% completada.**

### Fase 2 — Forecasting automatizado (Meses 4-6)

| Entregable | Estado |
|---|---|
| Stack Nixtla / Holt-Winters / TSB | ⚠️ TSB shadow, HW no |
| WMAPE por cuadrante | ⚠️ persiste pero vacío |
| Bias + tracking signal | ⚠️ persiste pero vacío |
| Calendario eventos discretos | ✅ |
| (s,Q) automatizado A | ⚠️ heurístico, no EOQ |
| (R,S) semanal B/C | ❌ |
| OTIF y σ_LT Idetex | ❌ |
| S&OP mensual | ❌ |
| Replenishment Full 2x/sem | ⚠️ sin scheduler automático |
| Pre-build eventos | ❌ |

**Fase 2: ~15% completada.**

### Fase 3 — Optimización avanzada (Meses 7-12)

| Entregable | Estado |
|---|---|
| LightGBM global forecast | ❌ |
| Hierarchical reconciliation | ❌ |
| MEIO central↔Full | ⚠️ estructura sí, lógica no |
| Re-slotting + batch picking | ❌ |
| TSP ruta pick | ❌ |
| VMI piloto Idetex | ❌ |
| Test-and-learn SKUs nuevos | ❌ |
| Price Automation API | ⚠️ `/api/ml/promotions` existe |
| Audit mensual Full | ❌ |
| Bonos ligados DIO/GMROI | ❌ |

**Fase 3: ~5% completada.**

### Fase 4 — Clase mundial (Meses 13-24)

**Fase 4: 0%** (DeepAR, anticipatory shipping, diversificación, reducción catálogo a 250, treasure hunt, demand sensing diario, reportería Idetex).

### Posicionamiento actual

BANVA está en **transición Fase 1 → Fase 2**. Tiene piezas sueltas de Fase 2 (TSB en shadow, calendario eventos, fórmula SS completa) pero no ha cerrado Fase 1 (ads sin pausa, cycle count inexistente, dead stock perpetuo, dashboard sin owner). **Atrasado ~1 fase respecto al cronograma ideal del manual** si se contara desde fecha de inicio.

---

## Recomendación de próximos 3 sprints

### Sprint 1 (2 semanas) — "Frena la sangría"

**Nombre:** Frena el ad-spend en stockout + desbloquea métricas.

**Scope:**
- Implementar `/api/ml/ads-auto-pause` cron: lee `stock_proyectado` + `vel_ponderada`, si runway \<10d pausa campañas asociadas.
- Fix bug `dias_sin_movimiento=999`: popular desde tabla `movimientos` en PASO X de `intelligence.ts`.
- Backfill `semanas_evaluadas` en `forecast_accuracy` iterando sobre `forecast_snapshots_semanales`.

**Gaps que cierra:** 7.1, 6.3, 2.1, 2.2, Error #4, #6, #11 parcial.

**Dependencias:** motor de inteligencia ya existente; no requiere migraciones nuevas.

---

### Sprint 2 (2 semanas) — "OTIF y safety stock honesto"

**Nombre:** Cierra el loop con proveedor.

**Scope:**
- Backfill `ordenes_compra` históricas desde Excel o emails (meta: \>50 OCs Idetex de últimos 12m).
- Calcular `lead_time_real_sigma` por proveedor y poblar `sku_intelligence.lead_time_real_sigma`.
- Implementar KPI OTIF en `/api/intelligence/kpis-proveedor`.
- Re-correr safety stock completo y actualizar ROP.

**Gaps que cierra:** 3.4, 3.5, 8.1, 8.2, Error #3.

**Dependencias:** `supabase-v27-registrar-movimiento.sql`, `src/lib/intelligence-queries.ts` (ya tiene la función σ_LT).

---

### Sprint 3 (2 semanas) — "Disciplina operativa diaria"

**Nombre:** Cycle count + IRA + policy document.

**Scope:**
- Cron diario que genere lista de 4 SKUs para contar (prioridad: 12/año A, 4/año B, 1/año C).
- Cálculo de IRA semanal + alerta \<95%.
- Crear `.claude/rules/inventory-policy.md` con políticas por cuadrante ABC-XYZ (service level, frecuencia revisión, método forecast).
- Agenda recurrente semanal 30min + template S&OP mensual.

**Gaps que cierra:** 4.1, 4.2, 1.7, 5.4, 5.5, 9.1, 9.3, 9.4, Error #8, #14.

**Dependencias:** tabla `conteos` existente; UI de conteos en `/operador/conteos` ya implementada.

---

## Cierre

15 líneas de resumen:

1. **Cumplimiento global: 33%** (11 ✅ + 20 ⚠️ + 32 ❌ sobre 63 requisitos).
2. **Mejor cubiertas:** Evasión de errores estructurales (45%), Segmentación (44%), Forecasting infraestructura (44%).
3. **Peor cubiertas:** Operaciones bodega (0%), Dead stock (13%), KPIs (14%), Proveedor (14%).
4. **Gaps críticos A:** 5 principales (ads sin pausa, `dias_sin_movimiento` bug, σ_LT vacío, forecast_accuracy vacío, cycle count inexistente). Total A identificados: ~19.
5. **Sprint 1:** Frena sangría de ads + fix bug dead stock + backfill forecast accuracy.
6. **Sprint 2:** Backfill OCs históricas + σ_LT real + OTIF + safety stock honesto.
7. **Sprint 3:** Cycle count diario + IRA + inventory-policy.md + ceremonias semanal/S&OP.
8. **BANVA está en transición Fase 1 → Fase 2.** Fase 0: 40%, Fase 1: 30%, Fase 2: 15%, Fase 3: 5%, Fase 4: 0%.
9. Fortalezas únicas: ramp-up post-quiebre implementado, evasión de error #2 (forecast vs planning), audit log masivo, calendario eventos poblado.
10. Debilidades únicas: 90% concentración Idetex, 235 SKUs con vel=0, cycle count con 2 filas totales, bonos no ligados a DIO.
11. El motor `intelligence.ts` es robusto (19 pasos automáticos, 533 SKUs procesados) pero las **acciones reactivas** (pausar ads, markdown automático, switch proveedor) están ausentes o manuales.
12. TSB está calculado para 104 SKUs pero **no se consume** en decisiones (shadow mode). Activar Fase C del TSB es un win fácil.
13. La matriz BANVA de 4 cuadrantes (Estrella/Volumen/CashCow/Revisar) no es la matriz 9 del manual (AX…CZ) — migración recomendada en 6 meses.
14. No existe `.claude/rules/inventory-policy.md` ni baseline firmado: hay motor sin manifiesto. Priorizar escribirlos.
15. **Honesto:** BANVA está más cerca de la **Fase 1** del manual que de la 2, con varias piezas de Fase 2 en estado "calculado pero no consumido".
