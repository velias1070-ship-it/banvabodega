# Alineamiento código BANVA vs manuales de pricing

**Propósito**: tabla durable que para cada regla relevante de pricing dice (a) qué prescribe el manual con cita exacta, (b) qué hace hoy el código en `banvabodega`, (c) cuál es el gap. Material de trabajo para decidir qué exponer en el panel de configuración y qué reglas todavía faltan implementar.

**Manuales fuente** (todos en `docs/manuales/pricing/`):
- `BANVA_Pricing_Ajuste_Plan.md` (262 líneas) — deck conceptual, matriz BCG con políticas por cuadrante.
- `BANVA_Pricing_Deep_Research.md` (225 líneas) — recomendación operativa en 3 capas.
- `BANVA_Pricing_Engines_a_Escala.md` (804 líneas) — arquitectura técnica, fórmula del piso, guardrails.
- `BANVA_Pricing_Investigacion_Comparada.md` (776 líneas) — investigación comparada, matriz de transferibilidad a BANVA.

**Cómo leerlo**: las citas del manual van con `archivo:línea` para verificación. Los valores del código van con `archivo:línea` también. Todo número que no aparece en manual está marcado **no en manual** explícitamente.

---

## 1. Clasificación de cuadrante (ESTRELLA / VOLUMEN / CASHCOW / REVISAR)

| Aspecto | Manual dice | Código hace | Gap |
|---|---|---|---|
| Definición Estrella | GM ≥30%, crec YoY ≥15%, STR ≥70% (`Investigacion_Comparada:627`); "Alto Volumen, Alto Margen" (`Ajuste_Plan:154`) | Pareto top 80% margen Y Pareto top 80% unidades (`intelligence.ts:1756`) | **Conceptual**: manual usa umbrales absolutos (GM, crec, STR); código usa percentiles relativos. Un SKU puede ser Estrella en código con GM <30% si está en el top de margen del catálogo. |
| Definición Dudoso/Revisar | GM <20%, crec <-10%, STR <30% (`Investigacion_Comparada:627`) | Pareto NO-margen Y Pareto NO-unidades (`intelligence.ts:1759`: cae a REVISAR si no es A en margen ni en unidades) | Mismo gap: relativo vs absoluto. 181 SKUs cayeron en REVISAR aunque están sanos (Task #38). |
| Sub-clasificación de REVISAR | Cola larga sana ≠ dead stock; "long tail con premium monitoreado +10-20% vs commodity, NO hacer price exploration" (`Investigacion_Comparada:210, 237`); "Dog/descontinuar: >90-180d slow; >180-365d dead stock" (`Investigacion_Comparada:197`) | `subtipoRevisar()` distingue 4 subtipos: revisar_sano (default), revisar_liquidar (≥180d sin mov o alerta dead_stock), revisar_sin_stock, revisar_nuevo (<60d primera venta). `revisar_sano` aplica defender 15% margen, descuento máx 20% (`pricing.ts:426-437, 496-500`) | **Alineado** desde la corrección de Task #38. El sano queda con política `defender`, no `liquidar`. |
| Triggers de reclasificación automática | 5 triggers: caída Buy Box >20pp/7d; aging >120d; competidor agresivo con -10% unit economics; crecimiento +20% MoM por 3 meses; margen post-fees <15% por 2 meses (`Investigacion_Comparada:235`) | Reclasificación corre vía `recalcularTodo` (en `intelligence.ts`) que se gatilla por cron, no por triggers de evento. Sólo 1 de los 5 está implementado: aging por días sin venta dentro del flujo markdown (`markdown-auto/route.ts:147`). | **Gap mayor**: 4 de 5 triggers no implementados. Buy Box drop, competidor agresivo, crecimiento MoM y margen post-fees por 2 meses no existen en código. |

---

## 2. Markdown ladder (descuento por aging)

| Aspecto | Manual dice | Código hace | Gap |
|---|---|---|---|
| Trigger de aging | "Stock >90 días supply → Bajar -8 a -15% (coupon preferido)" (`Investigacion_Comparada:275`); ">90-180d sin movimiento = slow; >180-365d = dead stock" (`Investigacion_Comparada:197`); aging >120d como trigger de reclasificación (`Investigacion_Comparada:235`); cargo por stock antiguo >120d (`Engines_a_Escala:666`) | Trigger por **días sin venta** (no días supply): 90/120/180 (`markdown-auto/route.ts:147-152`) | **Conceptual**: manual habla de "stock supply" (días de cobertura) y "días sin movimiento" como dos métricas separadas; código sólo usa días sin venta. Para SKU con stock alto vendiendo lento, ambas convergen, pero un SKU que vendió hace 60d con stock para 200d ya está en zona slow según manual. |
| Profundidad del descuento — primer escalón | "-8 a -15%" stage 90d (`Investigacion_Comparada:275`) | -20% en 90d (`markdown-auto/route.ts:152`) | **Más agresivo que manual**. Código aplica -20%, manual prescribe -8 a -15%. |
| Profundidad del descuento — segundo escalón | No prescrito explícito. Manual menciona "1ª rebaja: 15-30% / mid-season: 40-50% / EOS: 60-70%" para estacionales (`Investigacion_Comparada:198`); "Clearance 60-80%" para Dogs (`Investigacion_Comparada:214`) | -40% en 120d (`markdown-auto/route.ts:151`) | **No en manual** la cifra exacta -40% para 120d. El manual sólo da el rango EOS / Clearance que se aplica al final de la cadena. |
| Profundidad del descuento — clearance | "Clearance 60-80%; bundle con fast movers; delist si STR <20% en 90d" (`Investigacion_Comparada:214`); 60-70% EOS estacional (`Investigacion_Comparada:198`) | -60% en 180d (`markdown-auto/route.ts:150`) | **Alineado** con rango clearance manual (60-80%). |
| Cupón vs price-cut directo | Cupón preferido sobre price-cut: "Cupón … neutral — preserva baseline" vs "Descuento directo … riesgo 30-day lowest rule" (`Investigacion_Comparada:303-310`); "Cupones en lugar de price cuts para hero SKUs" (`Investigacion_Comparada:618`); "stock >90 días supply → Bajar -8 a -15% (**coupon preferido**)" (`Investigacion_Comparada:275`) | Sólo price-cut directo vía `precio_venta` en ML. No hay generación de cupón diferenciado en el código (`markdown-auto/route.ts:166`) | **Gap**: el cupón está prescrito como táctica preferida y no existe en código. Implica build (cupones ML, scoping, métrica). |
| Bloqueo "valle de la muerte" $19.990-$23.000 | Slide 9: "valle de la muerte" envío gratis afecta `Crecimiento`, dictar bajar a $19.800 (`Ajuste_Plan:133, 155`) | `VALLE_MUERTE_MIN=19990`, `VALLE_MUERTE_MAX=23000`, bloquea cualquier markdown que caiga en rango (`pricing.ts:24-25`, `markdown-auto/route.ts:173-175`) | **Alineado**. Constantes coinciden con manual. |
| Delist por STR baja | "Delist si STR <20% en 90 días" (`Investigacion_Comparada:214`) | No implementado | **Gap**: regla no codificada. Subtipo `revisar_liquidar` baja precio pero nunca delistea automáticamente. |

---

## 3. Floor / piso de precio

| Aspecto | Manual dice | Código hace | Gap |
|---|---|---|---|
| Fórmula del piso | `Engines_a_Escala:684`: `floor = (costo + iva + envío) / (1 − comisión − ACOS − margen)` | `pricing.ts:97-120`: `floor = (costoNetoConIva + envioClp) / (1 − comisionFrac − acosFrac − margenMinimoFrac)` | **Idéntico**. La fórmula del código replica el manual literal. |
| Componentes del piso (versión 5-componentes) | `Investigacion_Comparada:102`: `COGS + fee_ML + costo_Envíos_Full + fracción_ads_atribuible + IVA_no_recuperable + margen_objetivo_mínimo` (6 componentes); `Investigacion_Comparada:615`: `COGS + fee_ML_categoría + costo_Full_si_aplica + IVA_no_recuperable + margen_objetivo_8%` | Implementa: COGS (costoNetoConIva), comisión (fees), envío (Full), ACOS (fracción ads), IVA, margen mínimo (`pricing.ts:105-120`) | **Alineado**. Los 5-6 componentes del manual están en la fórmula del código. |
| Componentes adicionales del piso (versión Deep_Research) | `Deep_Research:112`: "costo landed + fee del canal + subsidio logístico esperado + empaque + reserva por devolución/reclamo + reserva de publicidad + margen mínimo de contribución" | No incluye empaque ni reserva por devolución/reclamo explícitos | **Gap menor**: el costo de empaque y la reserva de devolución no se modelan separadamente. Manual `Engines_a_Escala:684` también omite estos, así que está alineado con la fórmula técnica. |
| Floor obligatorio (no nullable) | `Engines_a_Escala:558`: "Amazon implementó forzosamente min/max obligatorio por SKU desde 14-ene-2015 — listings sin floor/ceiling se desactivan automáticamente"; `Engines_a_Escala:591`: "Hard floors/ceilings por SKU (sku_price_bounds NOT NULL)" | `productos.precio_piso` es nullable. El floor se calcula on-the-fly y se persiste en `precio_piso_calculado`, pero el override manual `precio_piso` puede quedar NULL (`pricing.ts:527`) | **Gap parcial**: el motor calcula floor en runtime, pero no fuerza un piso NOT NULL para auto-postular como prescribe manual. La protección existe (no postula bajo floor calculado) pero no hay constraint en DB. |
| Ceiling absoluto | `Engines_a_Escala:556`: "Guardrail faltante: ceiling absoluto, sanity check vs cost basis"; `Engines_a_Escala:318`: `ceiling_multiplier numeric DEFAULT 1.5` en schema propuesto; `Investigacion_Comparada:628`: "cada SKU con (floor, target, ceiling, elasticidad_estimada, acos_target)" | No existe `precio_techo` ni `ceiling_multiplier` en `productos`. Sin guardrail superior. | **Gap**: ceiling absoluto no implementado. Caso "libro $23.698.655" (`Engines_a_Escala:556`) sin protección. |
| Margen objetivo Estrella | `Investigacion_Comparada:613`: "pisos por SKU ≥ COGS + fees + Full + 8% margen mínimo" para Estrella | `v74-pricing-cuadrante-config.sql:32`: `ESTRELLA margen_min_pct = 8` | **Alineado**. |
| Margen mínimo CASHCOW | `Investigacion_Comparada:209`: "Cash cows … subir escalonado +3-5%"; `Ajuste_Plan:168`: marketplaces "retener entre 15% y 25%" | `v74:34`: `CASHCOW margen_min_pct = 20` | **Alineado** con rango 15-25% manual; en el centro del rango. |
| Margen mínimo VOLUMEN (Crecimiento) | `Ajuste_Plan:155`: Crecimiento "match-lowest", margen comprimido para penetración; sin umbral explícito | `v74:33`: `VOLUMEN margen_min_pct = 5` | **No en manual** la cifra exacta 5%. El manual sólo dice que el margen se comprime, no fija piso. 5% es razonable pero requiere validación con Vicente. |
| Margen mínimo REVISAR | `Ajuste_Plan:157`: Interrogante = "perforación de precios controlada (Drop-Pricing) … precio de costo"; sin umbral mínimo explícito | `v74:35`: `REVISAR margen_min_pct = 0` | **Alineado** con prescripción manual (precio de costo = margen 0). |

---

## 4. ACOS objetivo por cuadrante

| Aspecto | Manual dice | Código hace | Gap |
|---|---|---|---|
| ACOS de equilibrio (regla maestra) | `Deep_Research:116`: "el ACOS de equilibrio debe ser inferior al margen de ganancia"; `Engines_a_Escala:649`: "ACOS ≤ Margen_contributivo / Precio" | Restricción implícita: el piso usa `(1 − comision − acos − margen)` como denominador, lo que fuerza acos+margen < (1-comisión). No hay validación explícita ACOS<margen por SKU. | **Alineado conceptualmente** vía la fórmula. Sin alerta si `acos_target > margen_neto`. |
| Benchmark ACOS Hogar / textiles | `Ajuste_Plan:36, 167`: "ACOS Hogar (19-27%)"; `Investigacion_Comparada:30`: bench Amazon "bueno" 15-30% | `_DEFAULT.acos_objetivo_pct = 12` (`v74:36`) | **Más bajo que benchmark**. Manual prescribe 19-27% para Hogar. |
| ACOS Estrella | `Ajuste_Plan:154`: "Aumentar el ACOS agresivamente (del 3.9% hacia el 12-15%)"; `Investigacion_Comparada:674`: "subir target a 10-15% blended"; `Investigacion_Comparada:327`: "ningún SKU GM>35% debe tener ACOS<15%" | `ESTRELLA acos_objetivo_pct = 13` (`v74:32`) | **Alineado** con rango 12-15% manual. |
| ACOS VOLUMEN (Crecimiento) | `Investigacion_Comparada:208`: bestsellers "competitive/dynamic; proteger visibilidad; KVI" — implícito ACOS alto en stage growth; `Investigacion_Comparada:263`: "Crecimiento (3-9 meses) ACOS 25-40%" | `VOLUMEN acos_objetivo_pct = 18` (`v74:33`) | **Más bajo que manual** (manual 25-40% growth, código 18%). Posible decisión BANVA por margen estrecho de la categoría; no documentado en código. |
| ACOS CASHCOW (Rentabilidad) | `Investigacion_Comparada:265`: "Madurez (9+ meses) ACOS 15-25%"; `Investigacion_Comparada:549`: "Series 3 (value) ACOS bajo 5-10%" | `CASHCOW acos_objetivo_pct = 7` (`v74:34`) | **Más bajo que manual** (madurez 15-25%). Alineado con value-tier 5-10% si se interpreta cashcow como value. |
| ACOS REVISAR | `Ajuste_Plan:157`: liquidación; sin guidance ACOS específico | `REVISAR acos_objetivo_pct = 5` (`v74:35`) | **No en manual** explícito. 5% como "ACOS mínimo o pausar" según comentario v74:35. |
| ACOS techo sostenible global | `Engines_a_Escala:654`: "ACOS techo sostenible ≈ 25-30% para preservar 13% neto" | No hay alerta global por SKU sobre acos_real > techo | **Gap**: ningún monitor/alerta cuando ACOS observado supera techo sostenible. |

---

## 5. Política de pricing por cuadrante

| Aspecto | Manual dice | Código hace | Gap |
|---|---|---|---|
| Estrella | `Ajuste_Plan:154`: "Repricing Algorítmico Parametrizado. El sistema debe empujar los precios gradualmente hacia arriba ante quiebres de stock de la competencia"; `Investigacion_Comparada:208`: KVI, proteger visibilidad | `v74:32`: política_default = `exprimir`, "Subir +3-5% si elasticidad <1" | **Alineado** semánticamente. |
| Crecimiento (Volumen) | `Ajuste_Plan:155`: "Repricing Basado en Reglas Competitivas (Match-Lowest). Igualar automáticamente a la competencia para acaparar la visibilidad" | `v74:33`: política_default = `seguir`, "Match-lowest. Respeta valle muerte." | **Alineado**. |
| Rentabilidad (CashCow) | `Ajuste_Plan:156`: "Pricing Estático Defensivo basado en Valor. No entrar en guerras de precios. Margen priorizado sobre volumen"; `Investigacion_Comparada:209`: "subir escalonado +3-5%" | `v74:34`: política_default = `defender`, "Estatico, value-based, +2-5% cada 6-8 sem." | **Alineado**. |
| Interrogante (Revisar) | `Ajuste_Plan:157`: "Reglas de Liquidación Agresiva. Perforación de precios controlada (Drop-Pricing) ignorando la competencia" | `v74:35`: política_default = `liquidar`, "Liquidacion agresiva, sin floor estricto. ACOS minimo o pausar." | **Alineado** para subtipo revisar_liquidar. Subtipo revisar_sano cambia a `defender` (`pricing.ts:498`). |
| Cascada de override SKU > cuadrante > default | `Investigacion_Comparada:147`: governance estándar matriz | `pricing.ts:446-486`: cascada implementada con flag de fuente (`fuente.margen` y `fuente.politica` en {sku, cuadrante, default}) | **Alineado**. Centinela: `politica_pricing='seguir'` y `margen_minimo_pct=15` en SKU se tratan como "no-override" y caen al cuadrante (`pricing.ts:462, 477`). Esto es decisión de implementación, no del manual; documentar en UI. |

---

## 6. Logística por cuadrante (Full / Flex)

| Aspecto | Manual dice | Código hace | Gap |
|---|---|---|---|
| Estrella → Full | `Ajuste_Plan:154`: "Operación exclusiva 100% en Full. La velocidad de entrega defenderá la Buy Box" | `v74:32`: `canal_preferido = 'full'` | **Alineado** como hint, pero sin enforcement. Código no fuerza Full ni penaliza si Estrella sale por Flex. |
| Crecimiento → mixto | `Ajuste_Plan:155`: no especifica canal, sólo el price-floor en valle muerte | `v74:33`: `canal_preferido = 'mixto'` | **Alineado**. |
| Rentabilidad → Flex | `Ajuste_Plan:156`: "Operación exclusiva vía Flex (desde BANVA Bodega). Al tener baja rotación, enviar estos SKUs a Full generaría sobrecostos por bodegaje prolongado"; `Investigacion_Comparada:694`: "Voluminosos / baja rotación: Full anti-económico" | `v74:34`: `canal_preferido = 'flex'` | **Alineado**. |
| Interrogante → Flex | `Ajuste_Plan:157`: implícito al hablar de liberar capacidad bodega | `v74:35`: `canal_preferido = 'flex'` | **Alineado**. |

---

## 7. Cadencia de revisión por familia / tier

| Aspecto | Manual dice | Código hace | Gap |
|---|---|---|---|
| 4 familias económicas (tráfico/margen/estacional/cola larga) | `Deep_Research:60`: "tráfico, margen, estacionales, cola larga"; `Deep_Research:114`: "tráfico = diaria; margen = semanal; estacionales = calendario; cola larga = menor frecuencia" | Cuadrante BANVA (4 categorías) ≠ familias económicas. No hay tag `estacional`. | **Gap conceptual**: BANVA usa cuadrante (margen × volumen relativo). Manual recomienda agregar tag de ciclo de vida + estacional. |
| Tiering por velocidad de revisión | `Investigacion_Comparada:101`: "tier A (~80 SKUs) repricer algorítmico cada 5-15 min; tier B (~170 SKUs) rule-based horario; tier C (~175 SKUs) revisión manual mensual + floor rígido" | Crons únicos: `markdown-auto` diario, `auto-postular` por demanda, `recalcular-floors` cron. Sin tiering por SKU. | **Gap mayor**: todos los SKUs corren a la misma cadencia. No hay clasificación tier A/B/C de velocidad. |

---

## 8. Eventos (CyberDay, Buen Fin, Black Friday)

| Aspecto | Manual dice | Código hace | Gap |
|---|---|---|---|
| Pre-pricing freeze T-45 | `Investigacion_Comparada:286`: "Congelar precios T-45"; `Investigacion_Comparada:616`: "Integrar en WMS lock automático de precio en SKUs marcados como evento + screenshots inmutables"; `Investigacion_Comparada:323`: "Congelar precios T-45 días antes del evento" | No implementado | **Gap mayor**: ningún flag `evento_inminente` ni lock pre-evento. Riesgo legal SERNAC documentado. |
| Cupones para hero SKUs en evento | `Investigacion_Comparada:618`: "cupón en top 30 SKUs del cuadrante Estrella, NO price cut directo" | No hay generación de cupones (sólo postula promos ML estándar) | **Gap**. |
| 30-day lowest rule | `Investigacion_Comparada:310`: "Amazon suprime Buy Box si current price > average 30-day"; ML tiene equivalente UNHEALTHY | El sistema captura `precio_obligado` para tipos UNHEALTHY/SMART/etc. (Task #33), pero no proyecta el efecto de un price-cut en evento sobre baseline 30-day | **Gap parcial**: detecta pero no advierte. |
| Pre-warming de ads T-30 / T-14 | `Investigacion_Comparada:286-289`: T-90 modelado, T-30 SP prospecting, T-14 escalar budget 3-5× | No implementado en código BANVA (puede estar en consola Mercado Ads manual) | **Gap**: no hay playbook codificado. |
| Compliance LATAM (Profeco/SERNAC) | `Investigacion_Comparada:316-323`: SERNAC documentó CyberDay 2024; `Engines_a_Escala:568`: Sernac v. Dell precio publicado obliga; `Engines_a_Escala:5`: "tu kill-switch no es opcional — es defensa legal" | No hay archivado de screenshots / precio histórico para defensa legal | **Gap**: tabla `ml_price_history` existe (cooldown) pero no archivado defensivo screenshot-style. |

---

## 9. Governance y umbrales de aprobación

| Aspecto | Manual dice | Código hace | Gap |
|---|---|---|---|
| Algoritmo cambia ±10% sin aprobación | `Investigacion_Comparada:148`: "Hasta 5-10% sin aprobación"; `Investigacion_Comparada:630`: BANVA-adapted "algoritmo puede cambiar ±10% sin aprobación si CMAA ≥12%" | `auto_postular=true` permite cualquier cambio dentro de floor calculado y descuento_max_pct (`pricing.ts:529`). No hay umbral de "cambio %" como gate. | **Gap conceptual**: el código gobierna por floor/descuento_max, no por delta% vs precio actual. |
| Cambio 10-25% requiere Pricing Analyst | `Investigacion_Comparada:148`: "10-25% → Pricing Mgr"; `Investigacion_Comparada:630`: "10-25% revisa Pricing Analyst en <4h" | No hay flujo de aprobación humana para promos pendientes. Es apply directo o nada. | **Gap mayor**. |
| Cambio ≥25% requiere VP/Director | `Investigacion_Comparada:148`: "≥25% → VP/Director"; `Investigacion_Comparada:630`: "≥25% o floor breach requiere Vicente vía Slack" | Idem. apply directo si auto_postular=true. | **Gap mayor**. |
| Floor breach bloqueado | `Investigacion_Comparada:149`: "Price floor: Bloqueado; excepción requiere Finance + Category" | El gate floor existe: si precio_objetivo < floor, no postula (`pricing.ts:189`) | **Alineado** en bloqueo. Sin "excepción documentada" para autorizar. |
| Cooldown anti race-to-the-bottom | `Investigacion_Comparada:103`: "cooldown si bajó 2× en 24h sin ganar" | Cooldown evaluado en `pricing.ts:537+` (Task #17 completed) | **Alineado**. |
| Ignorar competidores con reputación baja | `Investigacion_Comparada:103`: "ignorar competidores con reputación amarilla/roja o <20 ventas/mes" | No implementado (depende de price_to_win, Task #20 pending) | **Gap**. |

---

## 10. KPI maestro: CMAA (Contribution Margin After Ads)

| Aspecto | Manual dice | Código hace | Gap |
|---|---|---|---|
| Definición CMAA | `Investigacion_Comparada:245`: "CMAA = Precio − COGS − Fees − Ad Spend atribuible"; `Engines_a_Escala:647`: "Margen_post_ads = Margen_contributivo − (ACOS × Precio)" | `ml_margin_cache.margen_pct` calcula margen contributivo (precio − costo − comisión − envío) sin restar ads atribuibles | **Gap**: KPI maestro del manual no se calcula. ACOS por SKU sí se obtiene de `ml_ads_daily_cache`, pero no se compone CMAA en una sola métrica. |
| Migrar de GM a CMAA como KPI operativo | `Investigacion_Comparada:408`: "Migrar de Gross Margin a Contribution Margin SKU como KPI operativo semanal"; `Investigacion_Comparada:329`: "Alert: SKU con CMAA <8% durante 60 días" | UI muestra `margen_pct` (margen sobre precio sin ads). No hay alerta `cmaa_60d < 8%`. | **Gap mayor**: KPI prescrito como maestro no existe en producción. |
| Price waterfall mensual | `Investigacion_Comparada:411, 629`: "construir un price waterfall mensual: Revenue → fees_ML → Full → ads → returns → CMAA %" | No hay endpoint/vista waterfall consolidado | **Gap**. |

---

## 11. Buy Box / publicación ganadora

| Aspecto | Manual dice | Código hace | Gap |
|---|---|---|---|
| Monitor `price_to_win` activo | `Investigacion_Comparada:81`: "GET /items/{item_id}/price_to_win?version=v2 con estados winning/sharing_first/losing/listed"; `Investigacion_Comparada:103`: "Monitorear price_to_win activamente, no por scraping"; `Investigacion_Comparada:619`: "Integrar endpoint en el Bodega WMS (Supabase cron cada 4h para tier A; diario tier B)" | No implementado (Task #20 pending) | **Gap**. |
| Buy Box Win Rate como KPI | `Investigacion_Comparada:412`: "Buy Box Win Rate por tier como KPI de compensación. Target >95% propios/exclusivos, >70% competidos" | No tracked | **Gap**. |
| Reaccionar a pérdida Buy Box | `Investigacion_Comparada:274`: "Buy Box perdido → Bajar precio -2-4% hasta recuperar; pausar ads"; `Investigacion_Comparada:589`: "NO bajar del precio mínimo aunque pierdas Buy Box" | Sin disparador (depende de price_to_win) | **Gap**. |

---

## 12. Repricer oficial MELI (Ajuste Automático)

| Aspecto | Manual dice | Código hace | Gap |
|---|---|---|---|
| Activar Ajuste Automático MELI | `Investigacion_Comparada:613, 656`: "Activar repricer oficial MELI en 85 SKUs cuadrante Estrella con estrategia 'Precio para ganar en MELI'"; uplift +37% reportado en `Investigacion_Comparada:588` | Task #19 pending. No integrado | **Gap mayor**. Manual lo marca como Tier 1 quick-win. |
| Conflicto edición precio API vs Automatización | `Investigacion_Comparada:592`: "desde 18 marzo 2026 MELI bloquea edición de precio vía API para ítems con Automatización activa" | El código pushea precio vía PUT user-products. Si un SKU tiene Automatización ML activa, el push fallará. No hay flag `automatizacion_ml_activa` para skip | **Gap operativo**: si Vicente activa automatización ML en un SKU, el cron BANVA chocará silenciosamente. |

---

## 13. Bundles y SKUs de inversión

| Aspecto | Manual dice | Código hace | Gap |
|---|---|---|---|
| 20-30 bundles textil hogar | `Investigacion_Comparada:331, 634`: "30-50 bundles … cada bundle = ASIN nuevo = Buy Box propio = inmune a price wars" | `composicion_venta` soporta combos (sku_venta ≠ sku_origen). Trivial composition (sku_venta=sku_origen, unidades=N) válida (memoria `feedback_composicion_trivial_no_bug`). | **Alineado** en arquitectura. Cuántos bundles activos hoy: dato de catálogo, no de motor. |
| Cap "investment tier" 10% catálogo | `Investigacion_Comparada:633`: "máximo 10% del catálogo (~40 SKUs) como investment tier con ACOS >30% o pricing agresivo durante 6-12 meses, siempre que el resto mantenga CMAA blended ≥10%" | No hay tag `investment_tier` ni cap | **Gap**. |

---

## 14. Reservas en el piso (devoluciones, empaque)

| Aspecto | Manual dice | Código hace | Gap |
|---|---|---|---|
| Reserva por devolución | `Deep_Research:112`: "reserva por devolución/reclamo"; `Investigacion_Comparada:411`: "returns no charged back" como leak | No modelado en fórmula del piso (`pricing.ts:120`) | **Gap menor**: depende de tasa de devolución por SKU. Textiles hogar 8-15% según `Investigacion_Comparada:381`. Asumido implícito en margen mínimo. |
| Empaque | `Deep_Research:112`: "empaque" como componente | No modelado | **Gap menor**. |
| IVA no recuperable | `Investigacion_Comparada:102`: "IVA_no_recuperable"; `Engines_a_Escala:684`: incluido en `costo + iva` | `costoNetoConIva` incluye IVA (`pricing.ts:136`) | **Alineado**. |

---

## 15. Capa ML / dynamic pricing avanzado

| Aspecto | Manual dice | Código hace | Gap |
|---|---|---|---|
| No usar RL ni Deep Learning a esta escala | `Engines_a_Escala:5`: "no necesitas RL ni deep learning para pricing … rules-first ahora"; `Engines_a_Escala:804`: "RL probablemente nunca a tu escala" | Código es rules-only (políticas determinísticas, cooldown, floor algebraic) | **Alineado** intencionadamente. |
| Bandits Thompson Sampling sólo en KVIs >100 ventas/mes | `Engines_a_Escala:5`: "bandits TS solo sobre KVIs cuando un SKU pase ~100 ventas/mes" | No implementado (correcto para esta etapa) | **Gap futuro**, no ahora. |
| Elasticidad por SKU | `Investigacion_Comparada:628`: "cada SKU con (floor, target, ceiling, elasticidad_estimada, acos_target)" | `productos.precio_piso` y `precio_techo` (sin valor por SKU). Sin `elasticidad_estimada`. | **Gap**: las 4 dimensiones recomendadas no están como columnas SKU-level. Floor sí, ceiling no, elasticidad no, acos_target sólo a nivel cuadrante. |
| Validación pre/post con CausalImpact | `Investigacion_Comparada:631`: "synthetic control sobre los ~30 SKUs más vendidos: cambios ±5-10% en ventanas 4 semanas" | No implementado | **Gap futuro**. |

---

## 16. Resumen de gaps mayores ordenados por impacto

| # | Gap | Manual | Esfuerzo aprox |
|---|---|---|---|
| 1 | **CMAA como KPI maestro** no existe; UI muestra GM (`margen_pct`) | `Investigacion_Comparada:245, 408, 329` | Mediano. Compose ml_margin_cache + ml_ads_daily_cache. |
| 2 | **Triggers de reclasificación** 4 de 5 no implementados (Buy Box drop, competidor agresivo, crec MoM, margen post-fees 2 meses) | `Investigacion_Comparada:235` | Alto. Requiere price_to_win + scraping competidor + serie histórica margen. |
| 3 | **Pre-evento freeze T-45** ausente. Riesgo legal SERNAC documentado | `Investigacion_Comparada:286, 323`; `Engines_a_Escala:568` | Bajo-mediano. Flag `evento_inminente` + lock + screenshot. |
| 4 | **Cupones vs price-cut** sólo se usa price-cut. Manual prescribe cupón preferido | `Investigacion_Comparada:275, 308, 618` | Mediano. Integración API ML coupons. |
| 5 | **Governance thresholds 10-25-25%** ausente. apply directo si auto_postular=true | `Investigacion_Comparada:148, 630` | Bajo. Estado `pendiente_aprobacion` + UI revisión. |
| 6 | **Repricer oficial MELI Ajuste Automático** no integrado. +37% uplift dejado en mesa | `Investigacion_Comparada:613, 656` | Mediano. Task #19 pending. |
| 7 | **Buy Box monitor `price_to_win`** ausente | `Investigacion_Comparada:81, 103, 619` | Mediano. Task #20 pending. |
| 8 | **Cuadrante por Pareto vs umbrales absolutos** del manual (GM/STR/crec) | `Investigacion_Comparada:627`; `intelligence.ts:1756` | Medio. Decisión: mantener Pareto o migrar a thresholds. |
| 9 | **Markdown -20% código vs -8 a -15% manual** stage 90d | `Investigacion_Comparada:275`; `markdown-auto:152` | Bajo. Cambio de constante. |
| 10 | **Ceiling absoluto por SKU** ausente | `Engines_a_Escala:556, 318` | Bajo. Columna `precio_techo` + validación. |
| 11 | **Tiering por cadencia A/B/C** todos los SKUs corren igual frecuencia | `Investigacion_Comparada:101` | Mediano. Marcar tier por SKU + cron diferenciado. |
| 12 | **CASHCOW ACOS 7% vs 15-25% manual** (madurez) | `Investigacion_Comparada:265`; `v74:34` | Bajo. Decisión: revisar valor o documentar racional BANVA. |
| 13 | **VOLUMEN ACOS 18% vs 25-40% manual** (growth) | `Investigacion_Comparada:263`; `v74:33` | Bajo. Idem. |
| 14 | **Delist automático STR<20% en 90d** ausente | `Investigacion_Comparada:214` | Bajo-mediano. |
| 15 | **Conflicto Automatización ML activa** no detectado, push falla silencioso | `Investigacion_Comparada:592` | Bajo. Flag `automatizacion_ml_activa` + skip. |

---

## 17. Reglas alineadas (verificación, sin gap)

Para evitar churn al revisar: estas reglas están **alineadas con manual** y no requieren cambio.

- Fórmula del piso (`pricing.ts:97-120` ↔ `Engines_a_Escala:684`).
- Margen mínimo Estrella 8% (`v74:32` ↔ `Investigacion_Comparada:613`).
- Margen mínimo CASHCOW 20% (`v74:34` ↔ rango 15-25% `Ajuste_Plan:168`).
- Margen mínimo REVISAR 0% (`v74:35` ↔ `Ajuste_Plan:157`).
- ACOS Estrella 13% (`v74:32` ↔ `Ajuste_Plan:154`).
- Política Estrella `exprimir` (`v74:32` ↔ `Ajuste_Plan:154`).
- Política VOLUMEN `seguir` (`v74:33` ↔ `Ajuste_Plan:155`).
- Política CASHCOW `defender` (`v74:34` ↔ `Ajuste_Plan:156`).
- Política REVISAR `liquidar` (`v74:35` ↔ `Ajuste_Plan:157`).
- Canal preferido por cuadrante (`v74:32-35` ↔ `Ajuste_Plan:154-157`).
- Cascada override SKU > cuadrante > default (`pricing.ts:446-486` ↔ `Investigacion_Comparada:147`).
- Sub-clasificación REVISAR sano vs liquidar (`pricing.ts:426-437, 494-514` ↔ `Investigacion_Comparada:197, 210, 237`).
- Valle muerte $19.990-$23.000 (`pricing.ts:24-25` ↔ `Ajuste_Plan:133`).
- Markdown clearance -60% en 180d (`markdown-auto:150` ↔ `Investigacion_Comparada:214`).
- Cooldown anti race-to-the-bottom (`pricing.ts:537+` ↔ `Investigacion_Comparada:103`).
- Bloqueo postular bajo floor (`pricing.ts:189` ↔ `Investigacion_Comparada:149`).
- Rules-first sin RL/DL (`pricing.ts` global ↔ `Engines_a_Escala:5, 804`).

---

*Documento construido leyendo los 4 manuales completos (`Ajuste_Plan` 262 líneas, `Deep_Research` 225 líneas, `Engines_a_Escala` 804 líneas, `Investigacion_Comparada` 776 líneas). Toda cita verificada con grep antes de incluirse. Cuando un valor no aparece en manual está marcado **no en manual** explícitamente.*
