# Discovery — Doctrina BANVA sobre lifecycle de SKUs y reposición

**Fecha:** 2026-05-03
**Alcance:** lectura de manuales, policies, auditorías y código relevante para preparar Sprint 4.3a (importar lógica del motor viejo al dashboard nuevo) y Sprint 4.3b (lifecycle: lanzamiento / dormido / phaseout / discontinuación).
**Modo:** read-only. No se modificó código, schema ni manuales.
**Convenciones:** `archivo:línea` para toda cita verbatim; bloque `> ...` cuando la frase es del manual.

---

## 1. Inventario de fuentes leídas

### 1.1 Manuales de inventarios (`docs/manuales/inventarios/`)

| Archivo | LOC | Cobertura para lifecycle |
|---|---:|---|
| `BANVA_Manual_Inventarios_Parte1.md` | 603 | Cold start §3.6, EOQ §4.1, ABC §2.2, eventos calendario §3.7 |
| `BANVA_Manual_Inventarios_Parte2.md` | 763 | Zara test-and-learn §7.3, ML Full §7.4, Costco §7.5, Shein §7.6, Apple §7.7 |
| `BANVA_Manual_Inventarios_Parte3.md` | 785 | 20 errores §9 (Errores #5 ramp-up, #6 dead stock 90 días, #12 pre-build, #17 Full discipline) |
| `BANVA_SPM_Benchmark_Plan.md` | 905 | Liquidación 12 semanas, Ley 21.440, recovery rates, calendario CyberDay/Hot Sale |
| `BANVA_ERP_Patrones_Inventario.md` | 710 | Tipos de stock (cycle/safety/dead/anticipation), reservaciones |
| `Gestión_de_Inventario_Guía_Completa.docx.md` | 557 | Cobertura por segmento (§Cobertura), Full vs Flex 30/45 d |
| `Manual_Experto_Gestión_Inventarios_Textiles.md` | 503 | Costco §8.3 amputar SKUs C, Apple §8.4 inventario perecedero, Shein §8.5 C2M |

### 1.2 Policies vinculantes (`docs/policies/`)

- `inventario.md` — política inventario.
- `inventario-formulas.md` (1369 LOC) — cascada de fórmulas, paso 20 RAMPUP POST-QUIEBRE, paso 21 FLEX/FULL CANON.
- `markdown.md` — reglas vinculantes de markdown / liquidación / aging.
- `pricing.md`, `frontera-reposicion-pricing.md` — frontera reposición vs pricing (Adendum A — Op Limpieza híbrida 2026-04-28).
- `_changelog.md`:8 — *"P-INV-1..4 promovidas desde manual (Parte1 §577-578). Inversión de prioridad Full > Flex en `flex-full.ts` v7."*

### 1.3 Auditorías (`docs/auditorias/`)

- **`inteligencia_vs_manuales_2026-04-28.md`** (742 LOC, 43 hallazgos H1-H43 + Adendum A.1-A.6 modo híbrido). **Fuente principal.**
- `auditoria-inventarios-vs-codigo-2026-04-25.md` (189 LOC).
- `banva-bodega-auditoria-2026-04-18.md` — área 1 lifecycle (1.5, 1.8), área 6 dead stock (6.4), área 9 SSoT (9.5).
- `cron-inventory-2026-04-26.md` — 34 crons activos, incluye `dormidos-tracker.sh` (#7) y `watch-dormidos.sh` (#8 vence 2026-04-30).
- `lead_time_inteligencia_2026-04-28.md` — interacción LT × rampup.
- `quiebres-full-9skus-2026-05-01.md` — caso TXTPBL20200SK que motivó P-INV.

### 1.4 Documentación de código

- `docs/banva-bodega-inteligencia.md` (976 LOC) — riesgos, gaps motor.
- `docs/banva-bodega-logica-rampup.md` (183 LOC) — pipeline post-quiebre, matriz rampup.
- `.claude/rules/inventory-policy.md` — 6 reglas con casos históricos (centinelas, errores silenciosos, autoheal, fuentes duplicadas).

### 1.5 Código consultado

- `src/lib/intelligence.ts` (~2 300 LOC) — `recalcularTodo`, `resolverDiasEnQuiebre`, `esQuiebreProlongadoProtegido`.
- `src/lib/intelligence-queries.ts` — `queryProductos` lee `estado_sku`.
- `src/lib/rampup.ts` (41 LOC) — matriz post-quiebre.
- `src/lib/flex-full.ts` — `target_dias_full` por ABC (sólo existe Full, no Flex).
- `supabase/migrations/20260503240000_sprint421_quiebre_por_nodo.sql` — `v_reposicion_explain` con quiebre por nodo (Sprint 4.2.1, recién mergeado).

---

## 2. Cold start — lanzamiento de SKUs nuevos

### 2.1 Doctrina prescrita por los manuales

**Tres enfoques académicos** (`BANVA_Manual_Inventarios_Parte1.md:395-402`):

> ### 3.6 Cold start — pronosticar SKUs nuevos
> El problema de los productos sin historia. Tres enfoques [3, cap. 7]:
> 1. **Analog forecasting:** identificar un SKU "gemelo" lanzado antes y copiar su curva.
> 2. **Bass diffusion model:** modelo de adopción tecnológica adaptable a productos nuevos. Parámetros: coeficiente de innovación (p), de imitación (q), mercado potencial (m).
> 3. **Cold-start con DL:** DeepAR/TFT generan forecast para SKUs nuevos usando categorías y atributos como features.
>
> **Para BANVA:** cuando lanzas un nuevo color/tamaño de la línea Idetex, identifica el SKU análogo más cercano (mismo material, similar precio) y usa su curva escalada como baseline 60 días.

**Test-and-learn (Zara)** — `BANVA_Manual_Inventarios_Parte2.md:496`:

> 1. **"Test and learn" en cada nueva colección Idetex:** no compres 100 unidades de cada SKU nuevo. Compra 20–30, mide 4 semanas, reordena los ganadores con confianza, descontinúa los perdedores antes de generar dead stock. **Esta es la lección #1 de Zara para BANVA y resuelve el problema raíz de los 91 dead stock.**

**Lote mínimo de prueba (Shein)** — `BANVA_Manual_Inventarios_Parte2.md:581-583`:

> 1. **"Lote mínimo de prueba" como política:** cualquier SKU nuevo se compra en 30–50 unidades primero. Solo si vende a >X unidades/semana en 4 semanas, se compra cantidad regular.
> 2. **Velocidad de descontinuación:** SKUs que no validan a 4 semanas se sacan de catálogo y se liquidan. **No esperar 6 meses como hoy.** Esto solo, aplicado disciplinadamente, evita 80% del dead stock futuro.

### 2.2 Estado en código

- `sku_intelligence` persiste `primera_venta` y `dias_desde_primera_venta` (`intelligence.ts:306-307, 1688-1689`). **Existen pero no entran a ningún cálculo** — son metadata visual.
- `productos.estado_sku` admite `'activo' | 'descontinuado' | 'sin_stock_proveedor' | ...` (`intelligence-queries.ts:154-167`). Filtro vigente: `if (p.estado_sku !== "descontinuado") allSkusOrigen.add(p.sku.toUpperCase())` (`intelligence.ts:797`). **No hay estado `'lanzamiento'` ni `'piloto'`.**
- **Ningún cap automático de 30-50 unidades** en lote de prueba. `pedir_proveedor` se calcula contra `target_dias_full` ABC (42/28/14) sin atenuar para SKUs nuevos.
- **Sin analog forecasting:** la auditoría 2026-04-18 lo nota explícito (`auditorias/banva-bodega-auditoria-2026-04-18.md:44`):

  > 82 SKUs <60 días sin lógica analog matching.

- **Sin Bass / DeepAR** (H30 del Adendum: `"No hay forecast probabilístico (p10/p50/p90)"`).

### 2.3 Gap de doctrina vs código

| Prescripción manual | ¿En código? | Cita |
|---|---|---|
| Analog forecasting SKU "gemelo" | ❌ | Parte1:395-402, auditoría 2026-04-18:44 |
| Lote prueba 20-50 uds en SKU nuevo | ❌ | Parte2:496, Parte2:581 |
| 4 semanas de validación → reordenar ganadores / discontinuar perdedores | ❌ | Parte2:582 |
| Bass diffusion / DeepAR cold-start | ❌ futuro | Parte1:399-400 |
| Estado lifecycle `'piloto'`/`'validando'` distinto a `'activo'` | ❌ | `intelligence-queries.ts:21` (sólo activo/descontinuado/sin_stock_proveedor) |
| Persistir `primera_venta` y edad SKU | ✅ sólo metadata | `intelligence.ts:306-307` |

---

## 3. End-of-life — phaseout, discontinuación, dead stock

### 3.1 Regla de los 90 días (regla central del manual)

**`BANVA_Manual_Inventarios_Parte3.md:69-77`** (Error #6 — Dead stock perpetuo):

> **Síntoma:** SKUs con 0 ventas en 6+ meses siguen en catálogo "por si acaso" o "para no dañar el assortment".
>
> **Caso BANVA:** 91 SKUs con 523 unidades, 173 SKUs zero-velocity con 2.522 unidades.
>
> **Costo:** holding cost ~30% anual sobre el valor inmovilizado + ocupación de espacio en bodega + atención mental dispersa.
>
> **Solución:** **regla de los 90 días**. Si un SKU no vende en 90 días, entra automáticamente a markdown -20%. A los 120 días, -40%. A los 180 días, liquidación o donación. Ningún SKU se queda parado más de 180 días.

**Refuerzo en plan táctico** (`BANVA_Manual_Inventarios_Parte3.md:236-237`):

> 2. **Política de markdown automático:** SKU sin venta 90 días → -20%, 120 días → -40%, 180 días → liquidación. Implementar como flujo en BANVA Bodega.
> 3. **Liquidación inicial de los 91 dead stock SKUs** vía oferta agresiva, bundling o donación. (Libera ~$15–25M de caja una sola vez)

### 3.2 Reducción de catálogo (Costco / Manual Experto)

**`Manual_Experto_Gestión_Inventarios_Textiles.md:140`**:

> **Lección Transferible:** Menos es abrumadoramente más. Si dentro de los 345 SKUs del comercio textil se logra identificar una fracción del cuadrante C improductivo, se debe amputar inmediatamente, copiando la eficiencia densa de Costco.

**`BANVA_Manual_Inventarios_Parte2.md:558`**:

> 1. **Menos SKUs es mejor.** BANVA tiene 345 publicaciones; probablemente debería tener 200. Las 145 long tail (cuadrantes CY/CZ) consumen atención sin generar margen.

### 3.3 Recovery rates y donación Ley 21.440

**`BANVA_SPM_Benchmark_Plan.md:469-484`**:

| Canal | Recovery % cost basis |
|---|---|
| MeLi Relámpago 25-35% off | 65-75% |
| MeLi DOD 50% off | ~50% |
| MeLi 70-80% closeout | 20-30% |
| Bulk Yapo / mayorista CL | 10-25% |
| **Donación Ley 21.440 (escudo fiscal)** | **~27%** (corp tax) |

> **Dato fiscal Chile crítico**: **Ley 21.440** (Rentas Municipales, Abr 2022) + SII Resolución Ex. 77/2022 + Circular 49/2022. Donación de bienes corporales (textiles incluidos) a entidades registradas como Donatarias = **deducción 100% como gasto, sin IVA, sin sujeción al límite global del 5% Ley 19.885**. Con tasa Pyme 25% → recuperas $250K por cada $1M donado vs $100K por venderlo a mayorista al 10%. Para textiles apuntar a Hogar de Cristo, Fundación Las Rosas, Techo Chile, Caritas, América Solidaria (verificar inscripción Donataria activa).

**Pipeline 12 semanas** (`BANVA_SPM_Benchmark_Plan.md:484`):

> De los 101 muertos ($7M) + 28 estancados ($3M), la mecánica óptima es **secuencia 12 semanas pegada al CyberDay 1-3 Jun + Hot Sale jul** + cierre con donación Ley 21.440 para residuo. Recovery realista 50-70% del book value ($5-7M de los $10M).

### 3.4 Estado en código

**Markdown ladder canónico vs implementado** (Adendum H5 — `inteligencia_vs_manuales_2026-04-28.md:118-133`):

> Markdown ladder canónico está en `markdown-auto/route.ts:147-152` con 90d→-20%, 120d→-40%, 180d→-60%. (...) el motor de Inteligencia decide liquidación por `dio - target_dias_full` en bandas 30/60/90 y descuentos 10/25/40 — **no coincide** con la cascada de pricing (90/120/180 + -20/-40/-60). Hay dos lógicas paralelas que dirigen al mismo SKU con respuestas distintas.

Código actual en `intelligence.ts` paso 17:

```ts
if (diasExtra > 90) { r.liquidacion_accion = "precio_costo"; r.liquidacion_descuento_sugerido = 40; }
else if (diasExtra > 60) { r.liquidacion_accion = "liquidar_activa"; r.liquidacion_descuento_sugerido = 25; }
else if (diasExtra > 30) { r.liquidacion_accion = "descuento_10"; r.liquidacion_descuento_sugerido = 10; }
```

**Tracking de dormidos vive fuera del motor**, en el droplet (`docs/auditorias/cron-inventory-2026-04-26.md:52-53`):

| # | Cron | Schedule | Acción | Estado |
|---|---|---|---|---|
| 7 | `dormidos-tracker.sh` | `0 * * * *` (1×/día efectivo) | INSERT `tracking_dormidos` + WhatsApp | 🟢 |
| 8 | `watch-dormidos.sh` | `0 * * * *` end_date 2026-04-30 | WhatsApp si SKU dormido >7 d | 🟡 **vencido al 2026-05-03** |

**Sin alerta `dead_stock_180d` formal ni regla 90 días automatizada** (Adendum H13).

**Sin métrica de recovery / Ley 21.440** (Adendum H40):

> No hay alerta `candidato_descontinuar` con criterios `(dead_stock 180d) OR (cuadrante=REVISAR && abc_unidades=C && abc_margen=C)`. (H32)
> El motor podría calcular `recovery_estimado_clp` en `liquidacion_*`. (H40)

**Auditoría 2026-04-18 confirma estado** (`docs/auditorias/banva-bodega-auditoria-2026-04-18.md:38, 102`):

| Ítem | Estado |
|---|---|
| Marcar SKUs en fase "declive" para liquidación (Parte1 §2.6) | ⚠️ Parcial — no hay tag explícito de fase PLC |
| Liquidación inicial de los 91 dead stock históricos | ❌ No cumple — 127 SKUs con `liquidacion_accion`, ninguna ejecutada en ML |

### 3.5 Disonancia velocidad-semanal vs ST-diario (Op Limpieza)

**`docs/policies/frontera-reposicion-pricing.md:92`**:

> **2026-04-28 (Adendum A — Op Limpieza híbrida)**: precedente de coexistencia velocidad-semanal vs ST-diario sin colapsar uno en el otro. Misma lógica acá: dos motores conviven sin escribir el mismo cache.

**Adendum A.2** (clave para Sprint 4.3): el motor de velocidad excluye semanas con ≥3 días de quiebre; el ajuste de ST acordado es **diario sin gate de threshold**. **NO son derivables uno del otro.**

---

## 4. Multi-canal Full vs Flex en lifecycle

### 4.1 Cobertura diferenciada (manual)

**`Gestión_de_Inventario_Guía_Completa.docx.md:267-280`** (tabla canon Full vs Flex):

| Variable | Full (Fulfillment ML) | Flex (Bodega Propia) |
|---|---|---|
| Velocidad de venta | Mayor (badge FULL boost ranking) | Menor en promedio |
| Cobertura recomendada | **30 días** | **45 días** |
| Quiebre de stock | ML pausa publicación automáticamente | Requiere gestión manual o alerta |

> Estrategia mixta óptima: mantener 20-30 días en Full para velocidad de entrega, y 15-20 días adicionales en Flex como respaldo. Cuando Flex margin > Full margin, reducir objetivo de Full a 20 días para liberar capital.

**`Gestión_de_Inventario_Guía_Completa.docx.md:259-265`** (cobertura por segmento):

| Segmento SKU | Lead Time típico | Cobertura mínima | Cobertura objetivo |
|---|---|---|---|
| A + Alta velocidad | 7-15 d | 10 d | 30-45 d |
| A + Estacional | 15-30 d (import.) | 20 d | 60-90 d pre-evento |
| B | 7-15 d | 7 d | 20-30 d |
| C | Variable | 5 d | 15-20 d |
| Muerto (0 vel.) | N/A | 0 | 0 — liquidar |

### 4.2 Estado en código

- `flex-full.ts:56` — sólo existe `target_dias_full: number; // por ABC: A=42, B=28, C=14`. **No existe `target_dias_flex`** pese a que el manual prescribe Full=30, Flex=45.
- `inventario-formulas.md:9` — *"v3 (2026-04-16, 4896f6d): unifica reserva Flex con target_dias_full"* — la reserva Flex se calcula contra `target_dias_full`, no un objetivo separado.
- Targets ABC del motor `42/28/14` son **agnósticos al canal** y caen ~en el rango A pero **C=14 d queda bajo el mínimo del manual** (15-20 d) — auditoría H11.
- **Penalización ranking ML post-quiebre** está en doctrina (`Parte2 §7.4`, `Parte3 Error #5`) y se traduce en `rampup.ts` con factores 0.30 a 0.75 según buckets — **única implementación de "lifecycle de canal"** (recovery post-quiebre).

### 4.3 Quiebre por nodo (recién implementado, Sprint 4.2.1)

`supabase/migrations/20260503240000_sprint421_quiebre_por_nodo.sql` separa `quiebre_bodega_estado` y `quiebre_full_estado` en `v_reposicion_explain`. Es **la primera vez** que el panel de reposición distingue el estado por canal. Sprint 4.3 hereda esa estructura.

### 4.4 Gap

- **Sin `target_dias_flex` separado** ni política de cobertura Full=30 / Flex=45 (Gestión_Completa:276 vs `flex-full.ts:56`).
- **Sin auditoría mensual de Full** para retirar SKUs con <0.5 u/sem (Parte3 Error #17).
- **Sin pausa automática de campañas ads cuando OOS Full** — la doctrina lo identifica como pérdida #1:

  > Para BANVA esta penalización es probablemente la fuente #1 de pérdida. Los $350K/mes de ad spend en SKUs sin stock que ya identificaste son la punta del iceberg. (Parte2:524)

---

## 5. Decisiones cerradas por owner

### 5.1 Adendum 2026-04-28 — modo híbrido Op Limpieza (autoritario)

**Origen:** `docs/auditorias/inteligencia_vs_manuales_2026-04-28.md` §A.5 (Adendum). **Decidido por Vicente, 2026-04-28.**

> Op Limpieza arranca en **modo semi-auto con cola de revisión humana** (alineado con `BANVA_Pricing_Operacion_Limpieza.md`: *"60-90 días en modo semi-auto antes de transición a auto"*).

**Reglas firmadas:**

- **Automático** si: ventana 30 d 100% dentro de `stock_snapshots`, sin quiebre actual (`fecha_entrada_quiebre IS NULL` OR `dias_en_quiebre < 2`), sin overlap con eventos no curados dentro de `[fecha_prep_desde, fecha_fin + 14d]`.
- **Cola de revisión humana** (`st_confidence='low_confidence'`) si: ventana solapa pre-`stock_snapshots`, gate promo no resoluble por falta de `ml_promo_history`, evento calendario no curado en ventana, o quiebre intermitente 13-30 d atrás.
- **Curado** = `activo=true AND multiplicador_real IS NOT NULL AND evaluado=true` (al 2026-04-28: **0 eventos curados**).

**Numerador / Denominador ST acordado** (Adendum A.1):

| Componente | Decisión |
|---|---|
| Numerador | `ventas_ml_cache` con `anulada=false` (estado=Pagada NO basta), granularidad `sku_origen` |
| Denominador interim (B) | `vendido / (vendido + stock_actual)` mientras `stock_snapshots` acumula |
| Denominador definitivo (A) | `vendido / stock_total_inicial_ventana` cuando snapshots ≥ 60-90 d (≈ 2026-06-16 a 2026-07-16). **`stock_total`, no Full ni Bodega** — es decisión financiera de capital atrapado, no de canal |
| Edad SKU | `MIN(fecha_primera_venta_observada, ml_items_map.date_created_ml, recepciones.creado_at)`, **sin reset por reposición** |

**Salida estable** (Adendum A.1):

> Cuatro campos persistidos en `sku_intelligence` (no runtime): `st_observado_30d` + `st_exposure_adjusted_30d` + `dias_disponibles_30d` + `factor_normalizacion_aplicado`, **más** `st_confidence` ∈ `('high', 'low_confidence', 'excluded')` también persistida. **Nunca un solo número que esconda el sesgo.**

### 5.2 Prerequisitos P0 firmados (Adendum A.4)

| Prioridad | Acción |
|---|---|
| P0 urgente | Arrancar `ml_promo_history` append-only (snapshot diff diario de `ml_margin_cache.tiene_promo/promo_type/promo_pct`) — webhook NO es alternativa válida |
| P0 urgente | Alerting si `stock_snapshots` cron falla 1 día (`feedback_silent_failure_antipattern`) |
| P0 prerequisito | **Repoblar las 7 filas de `eventos_demanda` con `fecha_prep_desde = fecha_inicio - 45d`** (hoy 14-21 d) — `Comparada:286` + `Engines:19`: lift empieza 3-6 semanas antes |
| P1 | Curar retrospectivamente `eventos_demanda` con calendario último año (al 2026-04-28: 0 históricos cargados) + carryover `fecha_fin + 14d` + cerrar convención `categorias=[]` (default propuesto: "aplica a todo el catálogo") |
| P1 | Documentar la divergencia velocidad-semanal ↔ ST-diario en `inventory-policy.md` |

### 5.3 Memorias autoritarias del owner (relevantes para lifecycle)

- `feedback_no_inferir_costos` → **nunca rellenar `productos.costo` con promedios de familia.** Solo recepción/OC/catálogo. Implicación lifecycle: SKU nuevo sin costo no se "rescata" estimando — bloquea su entrada al ranking de margen y a `liquidacion_*` hasta que llegue costo real.
- `feedback_no_sernac_justificacion` → no usar SERNAC/compliance como driver de pricing. Solo argumentar por beneficio operativo.
- `feedback_no_opinar_timing` → "Vicente decide timing; yo describo trabajo y ejecuto." Aplicación directa al Sprint 4.3: **describir gap, no recomendar fecha**.
- `feedback_ventas_anuladas_filter` → toda lectura analítica de `ventas_ml_cache` filtra `anulada=false`. `estado='Pagada'` NO basta.
- `feedback_silent_failure_antipattern` → centinelas numéricos + `.select()` sin error catch = bugs invisibles. Aplica a cualquier autoheal de lifecycle (ej. detección "SKU dormido despertó").
- `project_banva_stock_snapshots_seed` → **`stock_snapshots` arrancó 2026-04-16.** Cualquier campo histórico con fecha < esa es inverificable (fósil). Sprint 4.2.1 ya parchó `resolverDiasEnQuiebre`; mismo patrón aplica a `dias_sin_movimiento`, `dias_sin_conteo`, `vel_60d`.
- `feedback_policies_vs_manuales` → reglas vinculantes en `/docs/policies/`; manuales son biblioteca de referencia, NO autoritativos por defecto. **Cualquier acción de lifecycle que cite manual sin policy → preguntar al owner antes de actuar** (`feedback_disonancia_policy_vs_manual`).

### 5.4 Decisiones P-INV (changelog policies, 2026-05-01)

`docs/policies/_changelog.md:8`:

> 2026-05-01 — inventario — P-INV-1..4 promovidas desde manual (Parte1 §577-578). **Inversión de prioridad Full > Flex** en `flex-full.ts` v7. Caso testigo TXTPBL20200SK: stock_full=1, bodega=41, reservaFlex=42 → mandar_full=0 con motor v6 a pesar de Full quebrado. Manual prescribe cycle stock en Full.

Implicación: la policy actual prioriza **completar Full antes que reservar Flex**. Cualquier feature de lifecycle que toque distribución entre nodos hereda esa prioridad.

---

## 6. Gaps documentados — qué falta para cerrar lifecycle

### 6.1 Gaps de cold start (lanzamiento)

| ID | Gap | Cita |
|---|---|---|
| L1 | Sin `estado_sku='lanzamiento'` ni `'piloto'` | `intelligence-queries.ts:21` (sólo activo/descontinuado/sin_stock_proveedor) |
| L2 | Sin analog forecasting para SKUs <60 d | Parte1:395-402; auditoría 2026-04-18:44 (82 SKUs sin matching) |
| L3 | Sin cap "lote prueba 30-50 uds" en `pedir_proveedor` para SKUs nuevos | Parte2:496, Parte2:581 |
| L4 | Sin gate "validar a 4 semanas → reordenar / discontinuar" | Parte2:582 |
| L5 | `primera_venta` y `dias_desde_primera_venta` persistidos pero no consumidos | `intelligence.ts:306-307, 1688-1689` |
| L6 | Sin Bass diffusion / DeepAR / TFT cold-start | Parte1:399-400, Adendum H30 |

### 6.2 Gaps de phaseout / discontinuación

| ID | Gap | Cita |
|---|---|---|
| D1 | Regla 90/120/180 → -20/-40/-60 NO está en `intelligence.ts`; coexiste con `pricing.ts`/`markdown-auto` y se contradicen | Adendum H5 (`inteligencia_vs_manuales:118-133`) |
| D2 | Sin alerta `dead_stock_180d` formal ni `candidato_descontinuar` con criterio `(dead_stock 180d) OR (REVISAR ∧ C×C)` | Adendum H13, H32 |
| D3 | No hay `target_dias_flex` separado (Full=30 / Flex=45 del manual) | `flex-full.ts:56` vs Gestión_Completa:276 |
| D4 | Diferencia "días supply" vs "días sin movimiento" no separada en alertas | Adendum H22 |
| D5 | Sin `recovery_estimado_clp` por canal ni evaluación Ley 21.440 | Adendum H40, SPM:476-484 |
| D6 | Pipeline 12 semanas SPM (CyberDay/Hot Sale + donación) sin ejecutar; 127 SKUs con `liquidacion_accion` y 0 ejecutadas en ML | Audit 2026-04-18:38, SPM:560 |
| D7 | `watch-dormidos.sh` cron Viki vence 2026-04-30 (yellow flag al 2026-05-03) | cron-inventory-2026-04-26:53 |

### 6.3 Gaps de transición / ramp-up post-quiebre (relativamente cerrados)

`docs/banva-bodega-logica-rampup.md` documenta pipeline post-quiebre (3 ramas `esQuiebreProlongadoProtegido` + matriz factor 0.0-1.0 propio×proveedor). Validación 2026-04-16: `0 SKUs con dias_en_quiebre > 365`, `39 SKUs con factor_rampup_aplicado != 1.0`, ahorro 15.3% (189 uds sobre 1233).

| Gap residual | Cita |
|---|---|
| Matriz rampup discreta (14/60/120) vs prescripción manual de rampa lineal 4-6 semanas | Adendum H20 |
| Rampup sólo recibe `dias_en_quiebre` Full, no Flex | Adendum H35 |
| Umbral 7 d para rama 2 ESTRELLA/CASHCOW sin cita literal del manual | Adendum H19 |

### 6.4 Gaps transversales que afectan toda decisión lifecycle

| ID | Gap | Cita |
|---|---|---|
| T1 | XYZ es decorativo: no modula service level por celda (9 valores) — todos los SKUs corren Z idéntico por ABC | Adendum H3 + memoria `project_banva_abc_xyz_state` |
| T2 | AZ recibe buffer alto en vez de "atacar LT corto" | Adendum H4 |
| T3 | 4 de 5 triggers de reclasificación ausentes (Buy Box drop, competidor agresivo, MoM 20%×3m, margen <15%×2m) | Adendum H6 |
| T4 | `eventos_demanda`: 0 históricos curados al 2026-04-28; 7 futuros con `fecha_prep_desde` mal calibrada (14-21 d en vez de 45 d) | Adendum A.2.3 |
| T5 | Cron de `recalcularTodo` es 1×/día y nunca incremental | Adendum H12 |
| T6 | Centinela `dias_en_quiebre` cap 365 + `cob_full=999` cuando vel≤0 (Regla 1 inventory-policy aún presente) | Adendum H7, H26 |
| T7 | Sin métrica `sell-through 60/90/120d` por colección | Adendum H24 |
| T8 | UI muestra cuadrante BANVA (4) en vez de matriz ABC-XYZ (9) | Adendum H41 |

### 6.5 Pendientes que requieren al owner antes de tocar código (Adendum §5)

Vicente debe zanjar política antes de Sprint 4.3:

1. ¿Adoptar 70/90 (SPM) o mantener 80/95 industrial? (H1)
2. ¿Adoptar bandas XYZ 0.25/0.60 deseasonalizadas? (H2)
3. ¿Implementar `service_level_por_celda` (9 valores)? (H3)
4. ¿Mover liquidación 100% a `pricing.ts` y eliminar P17 de `intelligence.ts` o sincronizar literalmente con cascada 90/120/180→-20/-40/-60? (H5)
5. ¿Subir `target_dias_c` de 14 d a 20 d? (H11)
6. ¿Filtrar `queryOrdenes` por `anulada=false` solamente? (H27, alineado con memoria)
7. ¿Cron rápido cada 5 min para SKUs A o conservar diario único? (H12)
8. ¿Persistir `is_pack`/`is_promo_bundle` en `composicion_venta` o tabla nueva? (H29)
9. ¿Implementar regla 90 días automática con donación Ley 21.440 como destino? (H13 + H40)

---

## 7. Síntesis para Sprint 4.3

### 7.1 Lo que ya existe y se puede reutilizar

- **Quiebre por nodo** en `v_reposicion_explain` (Sprint 4.2.1, recién mergeado) → primera capa de "estado por canal" lista para extender.
- **`stock_snapshots`** acumulando desde 2026-04-16 — al 2026-07-16 cubrirá 90 d necesarios para denominador ST(A) definitivo.
- **`primera_venta` + `dias_desde_primera_venta`** ya persistidos en `sku_intelligence`: el campo está, falta el consumo.
- **`productos.estado_sku`** existe como flag manual; espacio para extenderlo a estados lifecycle (`piloto`, `validando`, `dormido`, `phaseout`).
- **Pipeline rampup** (`rampup.ts`) probado en prod con 39 SKUs ajustados → patrón replicable para "rampup post-lanzamiento" (lote prueba → reordenar).
- **Cron `dormidos-tracker.sh`** en Viki ya genera tabla `tracking_dormidos` con WhatsApp → señal externa que el motor podría leer en vez de duplicar lógica.
- **Adendum 2026-04-28 modo híbrido** firmado: cualquier acción Sprint 4.3 que toque markdown / discontinuación debe entrar a la cola humana cuando `st_confidence ≠ 'high'`.

### 7.2 Lo que el manual prescribe pero el código no implementa (priorizado por menor distancia)

| Distancia | Gap | Esfuerzo estimado |
|---|---|---|
| Baja | Estado `lanzamiento` en `productos.estado_sku` + consumo en motor | bajo (enum extension) |
| Baja | `target_dias_flex` separado (45 d) vs `target_dias_full` (30 d) | bajo (config + lectura en `flex-full.ts`) |
| Baja | Alerta `dead_stock_180d` automatizada con flag `candidato_descontinuar` | bajo (regla declarativa) |
| Media | Sincronizar markdown ladder de `intelligence.ts` con el de `pricing.ts` (90/120/180 → -20/-40/-60) o eliminar P17 | medio (decisión owner H5) |
| Media | Lote prueba 30-50 uds: cap automático en `pedir_proveedor` para `dias_desde_primera_venta < 28 d` | medio |
| Media | Analog forecasting básico: matching por `categoria + proveedor + rango_precio` para SKUs <60 d | medio-alto |
| Alta | Bass diffusion / DeepAR cold-start | futuro (post-DeepAR) |
| Alta | `service_level_por_celda` 9 valores (resuelve T1, T2 y AZ→LT corto) | alto (cambio amplio en SS/ROP) |

### 7.3 Riesgos a comunicar antes de implementar

- **Cualquier campo histórico que dependa de `stock_snapshots`** está acotado a ~17 d al 2026-05-03 (memoria `project_banva_stock_snapshots_seed`). Sprint 4.3 que use ST(A) o "días Full disponibles" debe convivir con detección de fósil hasta julio.
- **`eventos_demanda` aún no calibrado** (0 históricos curados, 7 futuros con `fecha_prep_desde` mal). Cualquier gate de evento que entre a Sprint 4.3 levanta `low_confidence` para casi todo.
- **`watch-dormidos.sh` venció 2026-04-30**: si Sprint 4.3 hereda detección de dormidos, decidir si renovar el cron del droplet o mover la lógica al motor.
- **Memoria `feedback_no_opinar_timing`** activa: Sprint 4.3 describe trabajo, no prescribe cuándo.

---

## 8. Anexos

### 8.1 Comandos de verificación reproducibles

```bash
# Estado lifecycle en código
grep -n 'estado_sku' src/lib/intelligence-queries.ts src/lib/intelligence.ts
grep -n 'primera_venta\|dias_desde_primera_venta' src/lib/intelligence.ts
grep -n 'target_dias_flex\|target_dias_full' src/lib/flex-full.ts

# Markdown ladder en motor
grep -nE 'liquidacion_accion|liquidacion_descuento_sugerido' src/lib/intelligence.ts

# Crons Viki
ssh vicente@146.190.55.201 "crontab -l | grep -E 'dormidos|liquidacion'"
```

### 8.2 Archivos clave para cualquier PR de Sprint 4.3

- `src/lib/intelligence.ts` — `recalcularTodo`, `resolverDiasEnQuiebre`, paso 17 liquidación.
- `src/lib/flex-full.ts` — `target_dias_full` (sólo Full hoy).
- `src/lib/rampup.ts` — matriz post-quiebre (referencia para rampup post-lanzamiento).
- `supabase/migrations/20260503240000_sprint421_quiebre_por_nodo.sql` — vista `v_reposicion_explain` con quiebre por nodo (Sprint 4.2.1).
- `docs/auditorias/inteligencia_vs_manuales_2026-04-28.md` §3-5 + Adendum A.1-A.5 — fuente única de gaps documentados.
- `docs/policies/markdown.md`, `docs/policies/inventario.md`, `docs/policies/inventario-formulas.md` — reglas vinculantes.
- `docs/banva-bodega-logica-rampup.md` — patrón de "lifecycle de canal" ya probado.

### 8.3 Notas sobre la lectura

- Todas las citas verbatim verificables con `grep -n` o `sed -n 'N,Mp'` sobre los archivos referenciados.
- La auditoría 2026-04-28 (43 hallazgos H1-H43) es la única fuente que cruza manuales con código línea-por-línea — preferida sobre cualquier otra para resolver disonancias.
- Discrepancias entre policies (`docs/policies/`) y manuales (`docs/manuales/`) se resuelven a favor de policies (memoria `feedback_policies_vs_manuales`). Si el código contradice una policy → corregir código. Si contradice un manual sin policy → preguntar al owner antes de actuar (`feedback_disonancia_policy_vs_manual`).

---

*Discovery realizada en read-only el 2026-05-03 por Claude Opus 4.7 (1M context). No se modificó código, schema ni manuales.*
