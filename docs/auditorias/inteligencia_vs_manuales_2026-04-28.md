# Auditoría Inteligencia vs Manuales — 2026-04-28

**Alcance:** sección "Inteligencia" del repo banvabodega — `src/lib/intelligence.ts`, `src/lib/intelligence-queries.ts`, `src/components/AdminInteligencia.tsx`, `src/app/api/intelligence/**`, `src/lib/rampup.ts`, `src/lib/reposicion.ts` y migraciones SQL relacionadas (v15, v51, v53, v54, v55, v60, v89).

**Fuente de verdad:** `docs/manuales/inventarios/*` (7 archivos) + `docs/manuales/pricing/*` (8 archivos), todos leídos a extensión completa.

**Convenciones:**
- `cita textual` siempre con `archivo:línea` para verificación (`grep -n` reproducible).
- DISO‑NUM = disonancia numérica · DISO‑CON = disonancia conceptual · GAP · HUER = huérfano · DEU = deuda operacional · RIE = riesgo de dato.
- "el código hace X (verificado)" vs "creo que hace X (no verificado)" se distinguen explícitamente.

---

## 1. Resumen ejecutivo

| Categoría | Conteo |
|---|---|
| DISO‑NUM (numérica) | 8 |
| DISO‑CON (conceptual) | 7 |
| GAP (manual prescribe, código no implementa) | 12 |
| HUER (código sin sustento manual) | 5 |
| DEU (operacional) | 6 |
| RIE (riesgo dato) | 5 |
| **Total** | **43** |

**Top 5 críticos** (orden por impacto operativo en decisiones del motor):

| # | Sev | Cat | Título | Ubicación |
|---|---|---|---|---|
| 1 | alta | DISO‑NUM | Pareto ABC 80/95/5 en código vs 70/CV-25-60 prescrito por SPM_Benchmark_Plan + Slimstock | `intelligence.ts:1715-1717` ↔ `BANVA_SPM_Benchmark_Plan.md:237, 271` |
| 2 | alta | DISO‑CON | XYZ con CV crudo y umbrales 0.5/1.0 vs CV deseasonalizado con bandas 25%/60% en textil con peak invernal | `intelligence.ts:1193-1196` ↔ `BANVA_SPM_Benchmark_Plan.md:239, 251, 271` |
| 3 | alta | DEU | XYZ persistido pero "decorativo": no modula service level por celda, todos los SKUs corren con Z idéntico por ABC, ignorando AY/AZ/BZ del manual | `intelligence.ts:1825-1828` ↔ `Manual_Inventarios_Parte1.md:543-553`, `SPM_Benchmark_Plan.md:257-265, 384-394` |
| 4 | alta | DISO‑CON | AZ recibe el mismo Z=1.65 que cualquier B; el manual exige "atacar con LT corto, no buffer alto"; la implementación amplifica buffer en SKUs Z high‑value | `intelligence.ts:1825-1828` ↔ `SPM_Benchmark_Plan.md:5, 259, 267, 586-588` |
| 5 | alta | GAP | Markdown ladder y subtipos REVISAR no viven en `intelligence.ts`: el motor sólo persiste `liquidacion_*` con umbrales 30/60/90d y descuentos 10/25/40, distintos a los 90/120/180 con -20/-40/-60 del pricing engine | `intelligence.ts:2058-2074` ↔ `_inventario_thresholds.md:16-18`, `markdown-auto/route.ts:147-152`, `Investigacion_Comparada:197, 275` |

---

## 2. Mapa de la sección Inteligencia

### 2.1 Archivos principales (qué hace cada uno)

- **`src/lib/intelligence.ts`** (2 296 LOC): motor puro `recalcularTodo()`. Ejecuta 13 pasos por SKU + 6 pasos globales: identidad/costo, demanda física (vel 7/30/60d con exclusión de quiebres ≥3 días), tendencia, eventos, stock agregado (bodega + alternativos + Full + tránsito + envíos Full pendientes), cobertura, margen por canal y ratio Full/Flex, ABC sobre 3 ejes Pareto (margen/ingreso/uds), XYZ por CV, matriz cuadrante (margen×unidades), Safety Stock (King Method), ROP, GMROI, DIO, quiebre prolongado + ancla `fecha_entrada_quiebre`, oportunidad perdida con flag estimación, acción + prioridad (11 valores), liquidación, alertas (~31 tipos). Quiebre Flex en paridad con Full (v60). TSB shadow (no consumido).
- **`src/lib/intelligence-queries.ts`** (840 LOC): accessors server-side a Supabase. Origina los inputs del motor (productos, composicion_venta, ventas_ml_cache filtrado `anulada=false`, stock, stock_full_cache, stock_snapshots, ordenes_compra_lineas, conteos, movimientos filtrados a `motivo IN ('venta_flex','despacho_ml')`, prevIntelligence, proveedor_catalogo, proveedores LT, primera venta, flag estacional, margen/uds 30d). `paginatedSelect` propaga errores (regla 3 inventory-policy) tras bug PR6a-bis.
- **`src/components/AdminInteligencia.tsx`** (3 105 LOC): UI (tab "Intel" del admin). Toggle de 6 vistas (`vistaOrigen`/`vistaEnvio`/`vistaPedido`/`vistaProveedorAgotado`/`vistaAccuracy`/default SKU Venta), banners contextuales, KPIs header, modales Pendientes/Notas, botón "🔁 Recalcular".
- **`src/app/api/intelligence/recalcular/route.ts`** (584 LOC): GET/POST que orquesta cargas + `recalcularTodo()` + upsert a `sku_intelligence` + `sku_intelligence_history` + `stock_snapshots`. Reporta a `ml_sync_health.intelligence_recalcular`.
- **`src/app/api/intelligence/pendientes/route.ts`**: detección de SKUs sin producto WMS, sin costo, sin costo con stock Full.
- **`src/app/api/intelligence/sku-venta`**, **`vista-venta`**, **`forecast-accuracy`**, **`actualizar-lead-times`**, **`envio-full-historial`**, **`envio-full-log`**, **`sku/[sku_origen]`**, **`sku/_bulk`**: lecturas + edición manual + cron de LT real.
- **`src/lib/rampup.ts`** (41 LOC): matriz factor ramp-up post-quiebre (5 buckets propio × 3 buckets proveedor).

### 2.2 Tablas/RPCs Supabase consumidas (lectura)

`productos`, `composicion_venta`, `ventas_ml_cache` (con `anulada=false` y `estado='Pagada'`), `stock`, `stock_full_cache`, `stock_snapshots`, `ordenes_compra_lineas` (+ join `ordenes_compra`), `conteos`, `movimientos` (filtrado a venta real), `picking_sessions` (envio_full ABIERTAS/EN_PROCESO), `sku_intelligence` (prev), `proveedor_catalogo`, `proveedores`, `eventos_demanda`, `intel_config` (singleton), `forecast_snapshots_semanales`, `forecast_accuracy`.

**Escritura:** `sku_intelligence` (upsert), `sku_intelligence_history` (insert), `stock_snapshots` (upsert), `ml_sync_health` (telemetría), `admin_actions_log` (envío Full).

### 2.3 Inputs y outputs del motor

- Inputs: `RecalculoInput` (`intelligence.ts:431-490`).
- Outputs: `SkuIntelRow[]` (~120 columnas, `intelligence.ts:134-311`) + `DebugSkuLog` opcional + persistencia a 3 tablas.

---

## 3. Hallazgos detallados

### H1 — [SEV: alta] [CAT: DISO‑NUM] Pareto ABC 80/95/5 vs 70/CV-25-60 SPM

- **Código:** `intelligence.ts:1715-1717` —
  ```ts
  if (pct <= 80) clase = "A";
  else if (pct <= 95) clase = "B";
  else clase = "C";
  ```
  Cita: `intelligence.ts:1715` `"if (pct <= 80) clase = \"A\";"`.
- **Manual:** `BANVA_SPM_Benchmark_Plan.md:237` — `"Retail/ecommerce / Lokad / Thieuleux / EazyStock / Altcraft 70-75/20/5-10 (margen) <10% / 10-25% / >25% Mensual Tu caso"`. `:271` — `"A=70% margen 90d (≈40-50 SKUs reales), B=20% (≈80-90), C=10% (≈280)"`. `:357` — `"WHEN pct_acum <= 0.70 THEN 'A' WHEN pct_acum <= 0.90 THEN 'B' ELSE 'C'"`.
  El otro manual coexistente sí valida 80/15/5: `Manual_Inventarios_Parte1.md:174-177` (`"A 10–20% 70–80% Revisión semanal..."`) — pero éste fue redactado antes que SPM_Benchmark_Plan y queda subordinado por la nota de éste último: `:236-237` (escuela Industrial vs Retail/ecommerce, "Tu caso").
- **Diferencia:** el código toma el corte clásico industrial (80/95) que el manual SPM corrige explícitamente al 70/90 para textil hogar mensual. Memoria del usuario pide consultar SPM como fuente de verdad reciente.
- **Impacto:** ABC más permisivo → más SKUs etiquetados A → cuadrante ESTRELLA inflado (memoria `project_banva_abc_xyz_state.md` reporta 181 SKUs en REVISAR sanos por la mecánica relativa). Distorsiona service level por ABC, target_dias_full y nivel de cycle counting (`v89-abc-max-y-zombis.sql`).
- **Fix sugerido:** mover los cortes a config (`intel_config.pareto_a_pct`, `pareto_b_pct`) con default 70/90 y permitir override; documentar racional en commit citando SPM_Benchmark_Plan:237.

### H2 — [SEV: alta] [CAT: DISO‑CON] CV crudo vs CV deseasonalizado para textil estacional

- **Código:** `intelligence.ts:1191-1196` —
  ```ts
  const ventasSemanaActivas = ventasSemana.filter((_, i) => !semanasEnQuiebre.has(i));
  const { media: mediaSemanal, std: stdSemanal } = mediaYDesviacion(ventasSemanaActivas);
  const cv = mediaSemanal > 0 ? stdSemanal / mediaSemanal : 999;
  let xyz: ClaseXYZ = "Z";
  if (cv < 0.5) xyz = "X";
  else if (cv < 1.0) xyz = "Y";
  ```
- **Manual:** `BANVA_SPM_Benchmark_Plan.md:239` — `"Para textil con estacionalidad invernal (sábanas/plumones), aplicar la escuela ecommerce con bandas más anchas... lo correcto es deseasonalizar antes de calcular CV (SAP IBP lo hace automáticamente; ejemplo: CV con tendencia = 0.6 → Y; sin tendencia = 0.2 → X)"`. `:251` — `"CV es mal predictor con estacionalidad (consenso Lokad + Kourentzes + Thieuleux). Fix profesional: deseasonalizar (restar índice estacional) y calcular CV del residuo. Fix práctico: usar 12 meses de historia (un ciclo completo) y bandas anchas"`. `:271` — `"CV deseasonalizado con bandas X<25% / Y 25-60% / Z>60%"`. SQL de referencia `:331-339` (residuo sobre MA4).
- **Diferencia:** umbrales 0.5/1.0 (industriales) vs 0.25/0.60 (retail/textil). Y, sobre todo, ningún paso de deseasonalización; el motor calcula CV directo sobre 9 semanas (ventana corta), inflando Z para SKUs estacionales (quilts/sábanas térmicas) que en realidad son Y deseasonalizados.
- **Impacto:** clasifica como Z muchos SKUs estacionales legítimos → forecast (vel_ponderada) los trata como impredecibles → AZ recibe buffer alto (ver H4) → exceso de inventario invernal y ranking destruido por quiebre estival. El flag `es_estacional` (v54) sólo afecta selección de modelo TSB (`intelligence.ts:1216-1220`), **no** la clase XYZ ni los umbrales.
- **Fix sugerido:** (1) bajar umbrales a 0.25/0.60; (2) calcular CV residual sobre rolling‑mean 4 semanas; (3) usar como entrada las últimas 26-52 semanas de `ventas_ml_cache` (no las 9 derivadas de `ordenes`). Pendiente vs usuario: ¿se adopta SPM 70/CV‑25‑60? (ver §4).

### H3 — [SEV: alta] [CAT: DEU] XYZ es decorativo: no modula service level por celda

- **Código:** `intelligence.ts:1825-1828` —
  ```ts
  let ns = 0.95;
  if (r.abc === "A") ns = 0.97;
  else if (r.abc === "C") ns = 0.90;
  ```
  Sólo se usa el eje ABC para el nivel de servicio. La clase `xyz` queda persistida en la fila pero no entra al cálculo de `Z`.
- **Manual:** `Manual_Inventarios_Parte1.md:543-553` — tabla por celda 9 cuadrantes: `"AX 99 | AY 98 | AZ 95 | BX 97 | BY 95 | BZ 92 | CX 95 | CY 90 | CZ 85"`. `BANVA_SPM_Benchmark_Plan.md:257-265, 384-394` — Z por celda y `policy_action` literal.
- **Diferencia:** sólo 3 niveles de servicio (97/95/90) en vez de 9 celdas; AY=AX=0.97, BX=BY=BZ=0.95, CY=CZ=0.90. Confirma memoria `project_banva_abc_xyz_state.md`: "XYZ decorativo".
- **Impacto:** SKUs AX (estables) cargan con el mismo Z=1.88 que AZ (erráticos), inflando SS en AX y subestimando SS en AZ — lo opuesto a lo correcto. AZ además recibe la regla del manual al revés (ver H4).
- **Fix sugerido:** tabla `service_level_por_celda(abc, xyz)` editable + lookup en P12; documentar transición. Esfuerzo bajo.

### H4 — [SEV: alta] [CAT: DISO‑CON] AZ con buffer alto en vez de "atacar LT corto"

- **Código:** `intelligence.ts:1846-1869` (`SS = z * sigmaD * sqrt(ltSem)` y combinada con σ_LT). El motor no tiene rama distinta para AZ; aplica la fórmula uniforme.
- **Manual:** `BANVA_SPM_Benchmark_Plan.md:5` — `"la regla AZ→z=2.33 es errónea; Lokad/Thieuleux convergen en que AZ debe atacarse con lead time corto (Flex/Idetex), no con buffer alto (CSL 90-95%, z=1.28-1.65)"`. `:259, 267, 586-588` — *AZ Service Level 93-95%, z=1.28-1.65 + "comprimir LT" como política*. `Manual_Inventarios_Parte1.md:545` (en cambio) `"AZ 95% (alto pero no extremo, porque el costo del SS sería prohibitivo)"`. Los dos manuales convergen en NO subir z para AZ.
- **Diferencia:** sin discriminación AZ, un SKU A clasificado Z paga z=1.88 (97% SL) sobre σ_D enorme → SS irracional. El manual SPM lo pone como error explícito.
- **Impacto:** capital inmovilizado en AZ; el manual estima `$10M × 25% = $2.5M/año`. Para BANVA con quilts AY-Z mal clasificados (ver H2), el efecto se compone.
- **Fix sugerido:** combinar con H3. Para AZ y BZ usar Z reducido + flag `policy_action='reducir_lt'` que dispare alerta operativa al admin (no ROP elevado).

### H5 — [SEV: alta] [CAT: GAP] Subtipos REVISAR (sano/liquidar/sin_stock/nuevo) no viven en intelligence.ts

- **Código:** `intelligence.ts:2058-2074` (paso 17 — protocolo de liquidación) usa **otra** lógica:
  ```ts
  if (r.abc !== "C" && r.cuadrante !== "REVISAR") continue;
  if (r.vel_ponderada <= 0) continue;
  const diasExtra = Math.max(0, Math.round(r.dio - r.target_dias_full));
  ...
  if (diasExtra > 90) { r.liquidacion_accion = "precio_costo"; r.liquidacion_descuento_sugerido = 40; }
  else if (diasExtra > 60) { r.liquidacion_accion = "liquidar_activa"; r.liquidacion_descuento_sugerido = 25; }
  else if (diasExtra > 30) { r.liquidacion_accion = "descuento_10"; r.liquidacion_descuento_sugerido = 10; }
  ```
- **Manual:** los 4 subtipos REVISAR (sano/liquidar/sin_stock/nuevo) viven en `pricing.ts:418-514` (no en `intelligence.ts`) según `_inventario_thresholds.md:91-110`. Markdown ladder canónico está en `markdown-auto/route.ts:147-152` con 90d→-20%, 120d→-40%, 180d→-60% (`_alineamiento_codigo_vs_manual.md:31-36`).
- **Diferencia:** el motor de Inteligencia decide liquidación por `dio - target_dias_full` en bandas 30/60/90 y descuentos 10/25/40 — no coincide con la cascada de pricing (90/120/180 + -20/-40/-60). Hay dos lógicas paralelas que dirigen al mismo SKU con respuestas distintas. Además, el manual prescribe -8 a -15% en stage 90d (`Investigacion_Comparada:275`), lo que el pricing implementa parcialmente y el motor de intelligence sobreescribe a 10%.
- **Impacto:** el field `liquidacion_descuento_sugerido` que muestra la UI puede contradecir el descuento real que postula el cron de markdown.
- **Fix sugerido:** trasladar la decisión de "es candidato a liquidar" a una propiedad declarativa (`subtipo_revisar`) leída por ambos motores; eliminar P17 o sincronizar literalmente con la cascada de markdown (citar `Investigacion_Comparada:197, 275`).

### H6 — [SEV: alta] [CAT: GAP] Triggers de reclasificación 4 de 5 ausentes en intelligence

- **Código:** `intelligence.ts` no implementa Buy Box drop, competidor agresivo, crecimiento +20% MoM por 3 meses, margen post-fees <15% por 2 meses.
- **Manual:** `Investigacion_Comparada:235` los enumera como triggers obligatorios; `_alineamiento_codigo_vs_manual.md:22` confirma "4 de 5 no implementados".
- **Diferencia:** el único trigger automático efectivo en el motor es `aging` por `dias_sin_movimiento` indirecto (vía P15 + P17). Los triggers MoM/margen viven aparte (`triggers-reclasificacion/route.ts:106, 126-129, 140-142`).
- **Impacto:** la reclasificación operativa depende del cron diario `recalcularTodo` que reordena Pareto, sin política de eventos.
- **Fix sugerido:** ya está documentado en `_alineamiento_codigo_vs_manual.md`. Para Inteligencia: registrar en `sku_intelligence` un campo `motivo_reclasificacion` cuando un trigger externo cambia el cuadrante.

### H7 — [SEV: alta] [CAT: DISO‑NUM] cob_full=999 cuando vel≤0 (centinela admisible reconocido pero presente)

- **Código:** `intelligence.ts:1156-1158, 1446` y `reposicion.ts::calcularCobertura` —
  ```ts
  cob_full = (stock_full / vel_full) * 7    si vel > 0
           = 999                            en otro caso
  ```
  La acción `URGENTE` se gate'a con `cob_full < punto_reorden && cob_full < 999`.
- **Manual / regla:** `inventory-policy.md` Regla 1 (`grep -nE '= 999([^0-9]|$)'`). Es un caso "admisible" autodeclarado: `"Es el único centinela admisible del motor hoy, pero la comparación doble es el parche. Próxima refactorización: pasar a null con branch explícito"`.
- **Diferencia:** la propia regla del repo lo marca como deuda. Propaga "999" en columnas persistidas; cualquier consumidor (UI, semáforo, agentes IA) que ignore el guard se equivoca.
- **Impacto:** reportes `dio` y `cob_*` que no excluyan 999 inflan métricas agregadas.
- **Fix sugerido:** migrar a `numeric NULL` + branches explícitos en P15 y `evaluarAlertas`. Coordinar con UI que usa `999` como "infinito".

### H8 — [SEV: media] [CAT: DISO‑NUM] Pico de demanda 1.5× vs umbrales no encontrados en manual

- **Código:** `intelligence.ts:1112` — `const esPico = vel30d > 0 && vel7d > vel30d * 1.5;`
- **Manual:** ningún manual prescribe el umbral 1.5×. `Investigacion_Comparada:265` habla de demand sensing y picos pero no fija el ratio. **No en manual.**
- **Diferencia:** valor magic-number sin sustento.
- **Impacto:** define alerta `pico_demanda` y, si rebasa, podría escalar pedidos en SKUs A. Hoy el efecto es informativo (la velocidad ajustada usa `multiplicador_evento` separado); el riesgo es bajo.
- **Fix sugerido:** mover a `intel_config.pico_demanda_ratio` (default 1.5) y citar racional en commit.

### H9 — [SEV: media] [CAT: DISO‑NUM] Tendencia ±15% vs nada en manual

- **Código:** `intelligence.ts:529-532` — `if (pct > 15) ... if (pct < -15) ...`.
- **Manual:** ningún manual define la banda ±15%. **No en manual.**
- **Impacto:** alimenta `tendencia_vel`, `caida_demanda` (`> 30%`) y `margen_*_bajando`. Decide alertas operativas.
- **Fix sugerido:** parametrizar; documentar.

### H10 — [SEV: media] [CAT: DISO‑NUM] Margen split 70/30 vs 80/20 sin sustento

- **Código:** `intelligence.ts:1176-1184` —
  ```ts
  if (margenFull30d > 0 && margenFlex30d > 0 && margenFlex30d / margenFull30d > 1.1) {
    pctFull = 0.70; pctFlex = 0.30;
  } else {
    pctFull = 0.80; pctFlex = 0.20;
  }
  ```
- **Manual:** ningún manual fija 80/20 ni 70/30 ni el umbral 1.1. **No en manual.** `_inventario_thresholds.md:32` lo lista como hardcoded.
- **Impacto:** decide cuánto del pedido va a Full vs Flex (nuestra capacidad publicable). Cambiar el umbral cambia el inventario asignado a Full y el costo storage_full.
- **Fix sugerido:** parametrizar (`pct_full_default`, `pct_full_flex_pivot`, `flex_pref_threshold`); documentar.

### H11 — [SEV: alta] [CAT: HUER] Targets ABC 42/28/14 días sin sustento explícito

- **Código:** `intelligence.ts:384-389` —
  ```ts
  cobObjetivo: 40, cobMaxima: 60,
  targetDiasA: 42, targetDiasB: 28, targetDiasC: 14
  ```
  + `intel_config` permite override (intelligence-queries.ts:680).
- **Manual:** `Gestión_de_Inventario_Guía_Completa.docx.md:259-265` da rangos: `A+Alta vel: cobertura mín 10d, objetivo 30-45d`, `A+Estacional 60-90d`, `B 20-30d`, `C 15-20d`. `BANVA_SPM_Benchmark_Plan.md:680-684` también prescribe pre-posicionado Full 30d para A, 14d para B, 0 para CZ. Los valores 42/28/14 caen aproximadamente en el rango A pero no derivan literalmente del manual.
- **Diferencia:** A=42d cae en rango A `30-45d`; B=28d en rango `20-30d`; C=14d en rango `15-20d` (queda **bajo** el mínimo del manual: `5d/15-20d`). Falta justificar porqué C=14d cuando el manual permite hasta 20d para C activos.
- **Impacto:** SKUs C activos quedan permanentemente en URGENTE/AGOTADO; el motor genera ruido en alertas.
- **Fix sugerido:** documentar en `intel_config` el racional + citar Gestión_Completa:259-265. Posible nota: "BANVA usa C=14 porque…".

### H12 — [SEV: alta] [CAT: DEU] Cron de recalcular es diario (1×/día) y nunca incremental

- **Código:** `recalcular/route.ts:51-69` (GET/POST) corre full snapshot vía `vercel.json` `0 11 * * *`. `banva-bodega-inteligencia.md:816-818` (gap #1, gap #2): `"Recalc incremental por evento — el cron siempre corre full=true"`.
- **Manual:** `Manual_Experto_Gestión_Inventarios_Textiles.md:2-9` y `Investigacion_Comparada:101` — `"tier A (~80 SKUs) repricer algorítmico cada 5-15 min; tier B horario; tier C mensual"`. Para inventario, el SPM_Plan + Manual_Parte1 Roadmap Fase 1 prescriben dashboards diarios. Granularidad **mínima** es diaria, óptima es por-evento.
- **Diferencia:** sin tiering por SKU; sin trigger por venta/recepción. Si una orden grande llega 11:01 UTC, el motor la "ve" 24h después.
- **Impacto:** decisiones reactivas (envío Full, pedido proveedor) se basan en datos hasta 24h viejos. Para SKUs A esto es inaceptable según manual.
- **Fix sugerido:** webhook `ml/webhook` debería poner el sku afectado en `intelligence_dirty_queue` + cron rápido cada 5 min `?skus=...`. Extiende patrón existente `recalcular?skus=`.

### H13 — [SEV: alta] [CAT: GAP] Sin alerta `dead_stock_180d` formal ni regla "90 días" automática

- **Código:** `intelligence.ts:2128` — `if (r.vel_ponderada === 0 && r.stock_total > 0) alertas.push("dead_stock");` (umbral implícito = sin venta en ventana 60d que llega al motor).
- **Manual:** `Manual_Inventarios_Parte3.md:69-77` (Error #6) — `"regla de los 90 días. Si un SKU no vende en 90 días, entra automáticamente a markdown -20%. A los 120 días, -40%. A los 180 días, liquidación o donación. Ningún SKU se queda parado más de 180 días"`. `Investigacion_Comparada:197` — `">90-180d sin movimiento = slow; >180-365d = dead stock"`.
- **Diferencia:** el motor no etiqueta SKUs con `dias_sin_movimiento ≥ 180` (categoría dead stock real). El campo `dias_sin_movimiento` existe (PR6a / aging fix `intelligence.ts:857-873`) pero no genera alerta dedicada `dead_stock_180d` ni acciona donación Ley 21.440 (`SPM_Benchmark_Plan.md:476-480, 569-572`).
- **Impacto:** los 91 SKUs muertos del manual viven sin alerta diferenciada — admin debe sortear `alertas[]` para encontrarlos.
- **Fix sugerido:** alertas `slow_movement_90d`, `dead_stock_180d`, `candidato_donacion_365d` con citas SPM + Parte3.

### H14 — [SEV: media] [CAT: DEU] Costo manual nunca actualizado (memoria `feedback_no_inferir_costos`)

- **Código:** `intelligence.ts:921-932` — cascada `costo_promedio > costo > proveedor_catalogo`. Alerta `costo_posiblemente_obsoleto` si `productos.updated_at < hoy-90d` (`intelligence.ts:2087-2092`).
- **Manual:** `Gestión_de_Inventario_Guía_Completa.docx.md:235-238` — método estándar es WAC (costo_promedio). Memoria del usuario `feedback_no_inferir_costos`: nunca rellenar `productos.costo` con promedios de familia. La auditoría previa (`auditoria-inventarios-vs-codigo-2026-04-25.md`) mantiene este punto en deuda.
- **Diferencia:** la cascada del motor cae a `costo_manual` y `proveedor_catalogo` sin fechar; la alerta de stale es el único guard. Sin un cron que recalcule WAC desde recepciones reales (`registrar_movimiento_stock`), `costo_promedio` puede no estar al día.
- **Impacto:** GMROI, margen unitario y oportunidad perdida calculados con costo viejo.
- **Fix sugerido:** ya documentado fuera de Inteligencia. Para el motor: persistir `costo_actualizado_at` y bajar el umbral stale a 60d (en línea con manual: `Manual_Parte1:1.3.1`).

### H15 — [SEV: alta] [CAT: GAP] EOQ ausente — pedir_proveedor 100% cobertura-driven

- **Código:** `intelligence.ts:1933-1939` —
  ```ts
  const demandaCicloUds = velParaPedir * r.target_dias_full / 7;
  const cantidadObjetivo = demandaCicloUds + r.safety_stock_completo;
  r.pedir_proveedor = Math.max(0, Math.ceil(cantidadObjetivo - stockTotalR));
  r.pedir_proveedor_bultos = innerPack > 1 ? Math.ceil(... / innerPack) : ...;
  ```
- **Manual:** `Manual_Inventarios_Parte1.md:445-466` (EOQ Wilson, $Q^* = √(2DS/H)$); `Manual_Experto_Inventarios_Textiles.md:50-58` (políticas (s,Q)/(s,S)/(R,S)). `Gestión_de_Inventario_Guía_Completa.docx.md:386-389` con worked example (D=3600, S=15k, H=2k → EOQ=232).
- **Diferencia:** el motor no minimiza el costo total ordenar+mantener; sólo redondea a `inner_pack`. `moq` se respeta vía alerta `pedido_bajo_moq`, no como variable de decisión. Auditoría previa lo flagea explícito.
- **Impacto:** si `S` (costo orden) varía o el holding cost real cambia, no hay calibración. Manual pricing reconoce que en BANVA esto puede no ser el cuello, pero el manual de inventarios lo pide.
- **Fix sugerido:** EOQ como cálculo paralelo persistido (`eoq_uds`) + alerta `pedido_lejos_eoq` cuando `pedir_proveedor < eoq * 0.5 || > eoq * 2`.

### H16 — [SEV: media] [CAT: GAP] WMAPE/bias/TS no retroalimentan el motor (sólo gatillan alertas)

- **Código:** `intelligence.ts:638-663, 2167-2179` — `evaluarAlertasForecast()` produce 3 alertas (`forecast_descalibrado_critico`, `forecast_descalibrado`, `forecast_sesgo_sostenido`). El forecast (`vel_ponderada`) no se ajusta si bias>0 o TS>4.
- **Manual:** `Manual_Inventarios_Parte1.md:425-428` — `"Si el bias es persistentemente positivo o negativo, el forecast tiene un sesgo sistemático que debe corregirse"`. `Parte1.md:419-428` (FVA — eliminar pasos que no agregan valor). `Parte3.md:781` — `"Lo que mata no es el error promedio sino el sesgo y los outliers no detectados"`.
- **Diferencia:** sólo alerta; no corrige. La memoria `project_banva_abc_xyz_state.md` lo enuncia como gap.
- **Impacto:** sesgo sostenido se acumula sin auto-corrección.
- **Fix sugerido:** factor `bias_correction = 1 - clamp(bias / vel, -0.3, 0.3)` aplicado a `velPonderada` cuando `forecast_es_confiable_8s=true && |TS|>4`.

### H17 — [SEV: media] [CAT: GAP] Sin Holt-Winters (estacionalidad explícita) ni regresores externos

- **Código:** Forecast = SMA ponderado 50/30/20 (`intelligence.ts:1055`). TSB shadow para Z maduros (`intelligence.ts:1216-1238`). Ningún Holt-Winters / Prophet / regresor (precio, ad spend, eventos calendario).
- **Manual:** `Manual_Inventarios_Parte1.md:308-310` — `"Para textiles con estacionalidad invierno/verano (quilts, sábanas térmicas), Holt-Winters multiplicativo es el baseline obligatorio"`. `Parte3.md:35-37, 47-48` — Croston/TSB para intermitente; HW/MQ-CNN para A/Y. `Manual_Experto:46` — MQ-CNN.
- **Diferencia:** el documento `banva-bodega-inteligencia.md:817-822` reconoce: HW pendiente porque historia por SKU < 26 semanas; PR3 Fase B descartó TSB en producción.
- **Impacto:** SKUs estacionales quedan en SMA → over/under provisioning previsible cada cambio de temporada.
- **Fix sugerido:** confirmado pendiente en doc; no introducir mientras historia<26 semanas (Sprint futuro).

### H18 — [SEV: media] [CAT: GAP] Sin VMI / data sharing con Idetex

- **Código:** N/A
- **Manual:** `Manual_Inventarios_Parte2.md:457-461` — VMI para top 20 SKUs. `Parte3.md:347` — VMI piloto Fase 3.
- **Diferencia:** ninguna pieza del motor produce data hacia Idetex (forecast 90 días por SKU, plan de compras).
- **Impacto:** pendiente operativo, no técnico-Inteligencia.
- **Fix sugerido:** export semanal con `vel_ponderada * 4.3 * 13` proyectado por SKU.

### H19 — [SEV: media] [CAT: HUER] División de quiebre prolongado (rama 2 ESTRELLA/CASHCOW: ≥7 días) sin cita exacta del manual

- **Código:** `intelligence.ts:42-44, 70` — Rama 2 dispara protección a los 7 días si `vel_pre > velAct*2` y cuadrante ESTRELLA/CASHCOW. La rama 1 (≥14 d) sí cita Manual Parte 1 §2.4 + Guía Completa.
- **Manual:** `intelligence.ts:25-28` cita `"Manual Parte 1 §2.4; Guía Completa: 'quiebre crónico de A's requiere alerta temprana'"`. Verificación: `Manual_Inventarios_Parte1.md:543` no menciona "7 días"; `Gestión_Completa.docx.md:312` habla de quiebre crónico genérico. **El umbral 7 días es magic number**.
- **Diferencia:** el racional para el 7 vs 14 vs 30 está embebido en código sin cita verificable.
- **Impacto:** medio. Determina cuándo `vel_pre_quiebre` reemplaza a `vel_ponderada` en la fórmula de pedido.
- **Fix sugerido:** documentar racional, parametrizar.

### H20 — [SEV: media] [CAT: HUER] Matriz rampup propio 14/60/120 — no derivada literalmente del manual

- **Código:** `rampup.ts:23-41` — propio 14/60/120 → 1.0/0.5/0.3/0.0; proveedor 30/120 → 1.0/0.75/0.5. El comentario al tope cita `"Manual Inventarios Parte 3 Error #5 (ranking ML degrada), Parte 1 §1.1, Parte 2 §7.4"`.
- **Manual:** `Manual_Inventarios_Parte3.md:62-67` (Error #5) habla de ramp-up "4-6 semanas con velocidad creciente linealmente". Las cifras exactas 1.0/0.5/0.3/0.0 no están en el manual.
- **Diferencia:** el manual prescribe rampa lineal en 4-6 semanas; el código usa escalones discretos. Resultados similares pero no traducción literal.
- **Impacto:** SKUs en quiebre 60-120d reciben 0.30 → pedido recortado dramáticamente. Si el cliente regresa, el SKU vuelve a quebrarse antes de "ramp-up" completo.
- **Fix sugerido:** considerar interpolación lineal según semanas en quiebre (`f(d) = max(0, 1 - d/60)` para propio).

### H21 — [SEV: alta] [CAT: GAP] Imputación 30d × 4.3 sin protección anti-doble‑contado

- **Código:** `intelligence.ts:1668-1700`. Para SKUs con `dias_en_quiebre ≥ 14 && vel_pre_quiebre > 2`, se calcula `imputado = vel_pre_quiebre * margen_unitario_pre_quiebre * 4.3` y se usa `max(real, imputado)` para `margen_neto_30d` y `uds_30d`.
- **Manual:** ningún manual prescribe esta imputación; es decisión local. Justificación interna citada (`Regla 1 inventory-policy`).
- **Diferencia:** el `4.3` (semanas/mes) es razonable, pero usar `max` en `uds_30d` puede sobre-contar al hacer Pareto: un SKU que "va volviendo" tiene `udsReal > 0` y `udsImputado` también — en el límite `max` los suma implícitamente con respecto al ranking del rest del catálogo.
- **Impacto:** abc_unidades puede inflar la clase A para SKUs en recovery, escondiendo SKUs realmente vendiendo (riesgo bajo, pero existe).
- **Fix sugerido:** `udsAttribuido = enRecovery ? Math.max(real, imputado) : real`. Hoy es `enQuiebreImputable` que requiere `dias_en_quiebre ≥ 14`, lo cual está bien; aún así documentar.

### H22 — [SEV: alta] [CAT: GAP] No diferencia "días supply" vs "días sin movimiento" en alerta de aging

- **Código:** `intelligence.ts:2132` — `sin_conteo_30d` cuando `dias_sin_conteo > 30`. La acción `DEAD_STOCK` requiere `vel_ponderada == 0 && stock_total > 0`. No hay alerta basada en `dio` (días supply).
- **Manual:** `Investigacion_Comparada:275, 235` — distingue: `"Stock >90 días supply → Bajar -8 a -15% (coupon preferido)"` (DOC) vs `">90-180d sin movimiento = slow; >180-365d = dead stock"` (DSV). El alineamiento previo de pricing lo nota: `_alineamiento_codigo_vs_manual.md:30`.
- **Diferencia:** un SKU vendiendo 1u/mes con stock para 200 días es "slow por DOC" según manual, pero el motor lo deja en OK/EXCESO sin gatillo.
- **Impacto:** miss en candidatos a markdown DOC-driven.
- **Fix sugerido:** alerta `slow_supply_90d` cuando `dio > 90 && vel_ponderada > 0`; otra `slow_movement_90d` cuando `dias_sin_movimiento > 90`. Mantenerlas ortogonales como manual.

### H23 — [SEV: media] [CAT: HUER] Inferencia de quiebres por gap ≥3 días sin cita

- **Código:** `recalcular/route.ts:381-442` (`inferirQuiebresDeOrdenes`) marca quiebre cuando hay `vel_30d > 1` y 3+ días consecutivos sin venta Full. Combinado con `quiebres explicitos` de `stock_snapshots` en `intelligence.ts:1019-1037` (semana ≥3 días marcados).
- **Manual:** ningún manual prescribe heurística por gap. La aproximación es razonable pero no respaldada.
- **Diferencia:** decisión local sin documentar racional.
- **Impacto:** falsos positivos en SKUs de baja velocidad (vel_30d=1.5) con cualquier fin de semana sin pedidos. La auditoría confirma estado: quiebres inferidos contribuyen a `semanasEnQuiebre` que excluye semanas del cálculo de vel.
- **Fix sugerido:** subir umbral a 5+ días o requerir que la velocidad ANTES y DESPUÉS del gap sea consistente (vel "venía" y "sigue").

### H24 — [SEV: media] [CAT: GAP] Sin métrica `sell-through` ni reporte por colección/temporada

- **Código:** N/A. El motor calcula `gmroi`, `dio`, `cob_*` por SKU pero no `sell_through_60d`, `sell_through_90d`.
- **Manual:** `Manual_Inventarios_Parte2.md:230-237`, `Parte1.md:7.3`. Mide `unidades vendidas / unidades recibidas` en ventana.
- **Diferencia:** no implementado.
- **Impacto:** decisiones de "comprar más" en colecciones nuevas (ej. Idetex Invierno) ciegas a la evidencia temprana de demanda.
- **Fix sugerido:** mediano. Persistir `sell_through_60d_pct` por SKU usando primera_venta + recepciones. Exigir vinculación factura→OC primero.

### H25 — [SEV: alta] [CAT: RIE] queryConteos limita a 100 filas — viola Regla 3 inventory-policy

- **Código:** `intelligence-queries.ts:225` — `.limit(100)` sin paginación.
  ```ts
  const { data } = await sb.from("conteos")
    .select("id, tipo, estado, lineas, created_at")
    .gte("created_at", desde)
    .order("created_at", { ascending: false })
    .limit(100);
  ```
- **Regla repo:** `inventory-policy.md` Regla 3 (errores tragados, fuentes truncadas) y memoria `feedback_silent_failure_antipattern`. Si BANVA pasa de 100 conteos en 90d (3 conteos cíclicos/día → ~270/90d), el motor truncaría silenciosamente.
- **Diferencia:** todos los otros queries usan `paginatedSelect`. Aquí no.
- **Impacto:** `dias_sin_conteo`, `diferencias_conteo`, `ultimo_conteo` pueden estar desactualizados para SKUs con conteos viejos.
- **Fix sugerido:** migrar a `paginatedSelect` (consistente con resto del archivo).

### H26 — [SEV: alta] [CAT: RIE] Telemetría/sentinela: `dias_en_quiebre` con cap 365

- **Código:** `intelligence.ts:598, 621` — `const CAP = 365` y `const dias = Math.min(CAP, Math.max(0, diasCalc));`. El comentario alude a "ningún SKU legítimamente necesita más".
- **Regla:** Regla 1 inventory-policy. El `365` no es centinela puro (no bloquea, sólo capa) pero genera el mismo problema downstream: el rampup factor=0.0 a 121 días (`rampup.ts:39`) ya satura, y nadie distingue 200d real vs 365d cap.
- **Impacto:** acumulación silenciosa más allá del año; pérdida de información para análisis post-mortem.
- **Fix sugerido:** remover el cap (o subir a 1095) y agregar alerta `quiebre_extremadamente_prolongado`.

### H27 — [SEV: alta] [CAT: RIE] queryOrdenes confunde `estado='Pagada'` con NO anulada — el filtro doble es correcto

- **Código:** `intelligence-queries.ts:189-191` — `.eq("estado", "Pagada").eq("anulada", false)`. ✅ Cumple memoria `feedback_ventas_anuladas_filter`.
- **Sin embargo:** `queryUltimaVentaPorSkuOrigen` en `intelligence-queries.ts:312` filtra sólo `.eq("anulada", false)` (sin estado). Esto **es correcto** según la memoria del usuario, pero `queryMargenPorSku:600-602` también filtra sólo `anulada=false` y `costo_fuente!='sin_costo'`. La inconsistencia: `queryOrdenes` (insumo principal de velocidad) requiere ambos; `queryMargenPorSku` (insumo de Pareto margen) sólo uno.
- **Diferencia:** doble criterio en `queryOrdenes` puede esconder ventas en estado distinto a 'Pagada' (ej. 'Pendiente') que sí cuentan vendidas. La memoria dice exactamente lo contrario: "estado=Pagada NO basta". Aquí está el `&&`, lo que **sub‑contaría** cuando una orden está activa pero todavía no se pagó.
- **Impacto:** vel_ponderada subestimada para órdenes muy recientes (no pagadas todavía). Magnitud probable: pequeña (24-48h hasta que MP libera).
- **Fix sugerido:** alinear con `queryMargenPorSku`: filtrar `anulada=false` y dejar fuera el `estado='Pagada'`. Al menos documentar racional explícito en código si la lógica actual es deseada.

### H28 — [SEV: media] [CAT: RIE] queryMovimientos filtra a `motivo IN ('venta_flex','despacho_ml')` — no incluye envío_full

- **Código:** `intelligence-queries.ts:265-270` y comentario `:259-264` documenta exclusión deliberada de `envio_full` (transferencia, no venta). El merge con `ultimaVentaPorSkuOrigen` en `intelligence.ts:857-873` cubre el gap.
- **Diferencia:** correcta intención, pero si el merge falla (silently retornando Map vacío), `dias_sin_movimiento` topea en 60d para SKUs que sólo venden por Full. La memoria `feedback_dual_route_sync` se aplica análogamente: dos rutas (movimientos vs ventas_ml_cache) deben sincronizarse explícitamente.
- **Impacto:** detectado por motor (warn en `intelligence.ts:872`). Riesgo bajo si el log se monitorea.
- **Fix sugerido:** sumar contador de SKUs cuya `ultimaVentaPorSkuOrigen` aporta el dato (no derivable de `movimientos`) y exponerlo en respuesta `recalcular`.

### H29 — [SEV: alta] [CAT: GAP] BANVA SPM pack‑aware: el motor no diferencia explícitamente kits/packs/promos

- **Código:** `intelligence.ts:692-748` — auto-detect alternativas via composicion_venta. No hay tag `is_pack`, `is_promo_bundle` ni `promo_valid_until` (el SPM_Plan los define como columnas).
- **Manual:** `BANVA_SPM_Benchmark_Plan.md:63-75` schema `listing_sku` con `is_pack`, `is_promo_bundle`, `promo_valid_from/until`.
- **Diferencia:** la inteligencia no distingue temporales (3x2 promo) de packs estructurales. Cuando una promo expira, el SKU hereda el track histórico inflado.
- **Impacto:** vel_ponderada distorsionada en SKUs que vienen de promos que expiraron.
- **Fix sugerido:** medio. Persistir `tipo_listing` en `composicion_venta` o nueva tabla; el motor descuenta ventana promo-only cuando calcula vel.

### H30 — [SEV: media] [CAT: GAP] No hay forecast probabilístico (p10/p50/p90)

- **Código:** vel_ponderada es punto fijo. ROP usa Z*sigma (intervalo simétrico).
- **Manual:** `Manual_Inventarios_Parte1.md:276-280` — `"un forecast no es una predicción puntual, es una distribución de probabilidad"`. `Parte3.md:341-346` — DeepAR/MQ-CNN exponen cuantiles. `Manual_Experto:46` — IQF.
- **Diferencia:** Fase futura — manual lo reconoce.
- **Impacto:** decisiones de SS calibradas con asunción normal; casos asimétricos (textil con cola larga) sufren.
- **Fix sugerido:** futuro post-DeepAR.

### H31 — [SEV: media] [CAT: HUER] Lógica `enQuiebreFlexProlongadoProtegido` rama 3 (vel_flex_pre ≥ 1) sin cita

- **Código:** `intelligence.ts:71-72` — `if ((r.abc === "A" || cuad === "ESTRELLA") && r.vel_flex_pre_quiebre >= 1) return true;`
- **Manual:** ningún manual cita "1 u/sem flex". Comentario al tope dice `"Necesario porque el tracking Flex arranca con dias=0"` — racional interno.
- **Diferencia:** parámetro 1 es magic number con racional pero sin sustento manual.
- **Impacto:** medio (afecta cuántos SKUs A/ESTRELLA reciben protección Flex desde día 0).
- **Fix sugerido:** parametrizar; documentar.

### H32 — [SEV: alta] [CAT: GAP] No hay capping del catálogo ni "treasure hunt"

- **Código:** N/A.
- **Manual:** `Manual_Inventarios_Parte2.md:545-560` (Costco), `Parte3.md:344-348` (Reducir catálogo 345→250). Sugiere acción de "amputar" SKUs CY/CZ, mantener 5-10 en rotación premium.
- **Diferencia:** el motor identifica SKUs INACTIVO/DEAD_STOCK pero no los lista como "candidatos a discontinuar" con mecánica de "removerlo del catálogo".
- **Impacto:** acción humana manual. Out-of-scope para Inteligencia stricto sensu pero relevante.
- **Fix sugerido:** alerta `candidato_descontinuar` con criterios `(dead_stock 180d) OR (cuadrante=REVISAR && abc_unidades=C && abc_margen=C)`.

### H33 — [SEV: alta] [CAT: GAP] Sin métrica de `forecast_value_added` (FVA) ni guardrail anti‑override humano

- **Código:** N/A. Existe edición manual (`vel_objetivo`, notas) en `intelligence/sku/[sku_origen]/route.ts` pero sin medir si la intervención mejora el resultado.
- **Manual:** `Manual_Inventarios_Parte1.md:419-428` (Gilliland 2010) — `"FVA = WMAPE_baseline_naive − WMAPE_nuevo_método"`. Si el override comercial empeora WMAPE, eliminarlo.
- **Diferencia:** pendiente.
- **Impacto:** intervenciones humanas no validadas.
- **Fix sugerido:** registrar pre/post WMAPE en `forecast_accuracy` cuando hay override.

### H34 — [SEV: alta] [CAT: GAP] Cycle counting no integrado al motor (no genera lista del día)

- **Código:** v89 actualizó `v_skus_vencidos_conteo` con cadencia 30/90/365. La memoria `project_banva_abc_xyz_state.md` lo confirma. `intelligence.ts` sólo persiste `dias_sin_conteo`.
- **Manual:** `Manual_Inventarios_Parte5.md:128-138` (3-4 SKUs/día calculado para BANVA). `Parte5.md:140` — `"BANVA Bodega debe generar la lista del día automáticamente"`.
- **Diferencia:** la vista existe; falta cron + UI que ofrezca al operador "los SKUs del día".
- **Impacto:** depende de admin recordar abrir la vista.
- **Fix sugerido:** cron lunes 06 UTC genera tarea conteo + push WhatsApp a Joaquín.

### H35 — [SEV: media] [CAT: DEU] `dias_en_quiebre_flex` no participa de la decisión `pedir_proveedor` salvo vía rama 3 v60

- **Código:** `intelligence.ts:1900-1904` el motor sustituye `vel_flex` por `vel_flex_pre_quiebre` cuando `enQP_flex=true`. Pero la rampup matrix de `rampup.ts` sólo recibe `dias_en_quiebre` (Full), no Flex.
- **Manual:** ningún manual prescribe rampup distinto Full vs Flex; el repo lo introduce. Falta de simetría sospechosa.
- **Diferencia:** un SKU en quiebre Flex prolongado pero Full sano no aplica rampup, aunque vendría a ser caso similar.
- **Impacto:** mediano para BANVA (Flex ~20% del volumen).
- **Fix sugerido:** evaluar si rampup debe considerar Flex; documentar racional.

### H36 — [SEV: media] [CAT: DEU] No hay reconciliación de inputs (margen 30d) cuando `costo_fuente='sin_costo'` cambia

- **Código:** `intelligence-queries.ts:600-602` filtra `costo_fuente!='sin_costo'`. Si `productos.costo_promedio` sube de 0 a un valor real (al ingresar costo), la fila histórica de venta no se recalcula para el motor — sólo cuando se vuelva a correr una nueva orden con costo_fuente correcto.
- **Manual:** `Manual_Experto:1.1.1` — `"todo dato sucio invalida el modelo"`.
- **Diferencia:** discrepancia entre `vel_ponderada` (que sí toma todas las órdenes) y `margen_neto_30d` (que descarta órdenes sin costo registrado al momento de la venta).
- **Impacto:** SKUs nuevos cuyo costo se registra después de las primeras ventas tendrán Pareto margen 30d artificialmente bajo.
- **Fix sugerido:** alerta `costo_post_venta` o reconcile (snapshot_costo.ts).

### H37 — [SEV: media] [CAT: HUER] Heurística "queue_empty no recalcula nada" cuando no hay movimientos recientes

- **Código:** `recalcular/route.ts:295-313` — si no full y sin skus dados, recalcula sólo SKUs con movimientos en últimos 7d.
- **Manual:** ningún manual sugiere "dejar SKUs sin recalcular si no movieron". Razonable como optimización pero significa que `dias_sin_conteo`, `dias_en_quiebre`, `forecast_*_8s` quedan stale para SKUs sin movimiento. El cron diario `?full=true` lo cubre, pero el botón manual sin params NO actualiza esos campos.
- **Impacto:** bajo (cron diario lo regulariza). Ojo si admin ejecuta `?full=false` esperando full refresh.
- **Fix sugerido:** documentar comportamiento; renombrar a `?incremental=true` para clarity.

### H38 — [SEV: alta] [CAT: GAP] No hay alerta `lead_time_fallback_default` cuando proveedor sin LT real

- **Código:** `intelligence.ts:1820` cae a `{ dias: 5, sigma_dias: 1.5, fuente: "fallback_default", muestras: 0 }`.
- **Manual:** `Manual_Inventarios_Parte2.md:597-599` — medir σ_LT empírico. Riesgo registrado en `banva-bodega-inteligencia.md` riesgo #6.
- **Diferencia:** no hay alerta cuando el SKU usa fallback con vel>5 (fuerte demanda y LT desconocido).
- **Impacto:** SS subestimado para SKUs sin OC histórica.
- **Fix sugerido:** alerta `lead_time_fallback` cuando `lead_time_fuente='fallback_default' && vel_ponderada > 5`.

### H39 — [SEV: media] [CAT: HUER] `safety_stock_fuente='fallback_simple'` cuando σ_D=0 y σ_LT=0

- **Código:** `intelligence.ts:1857-1861` — `if (sigmaD > 0 || sigmaLtSem > 0) ... else r.safety_stock_completo = ssSimple; r.safety_stock_fuente = "fallback_simple";`. El `ssSimple` también vale 0 si σ_D=0 → `safety_stock_completo = 0`.
- **Manual:** `Manual_Inventarios_Parte4.md:506-516` — la fórmula sólo es válida con σ>0. Caer a 0 puede ser correcto matemáticamente, pero deja al SKU sin protección.
- **Diferencia:** el código no marca este caso.
- **Impacto:** bajo (SKUs con σ=0 son los más estables, casi siempre AX). Aún así, alerta de cordura.
- **Fix sugerido:** alerta `sigma_demanda_cero` cuando `desviacion_std=0 && vel_ponderada > 0`.

### H40 — [SEV: alta] [CAT: GAP] No mide `donación Ley 21.440` ni `recovery rate` esperado de liquidación

- **Código:** N/A.
- **Manual:** `BANVA_SPM_Benchmark_Plan.md:476-484` — recovery 27% via donación Ley 21.440 supera mayorista 10-25%. Tabla de recovery por canal `:469-478`.
- **Diferencia:** la decisión "liquidar vs donar vs mayorista" no se exterioriza en el motor.
- **Impacto:** out-of-scope estricto, pero el motor podría calcular `recovery_estimado_clp` en `liquidacion_*`.
- **Fix sugerido:** futuro.

### H41 — [SEV: alta] [CAT: DEU] AdminInteligencia muestra cuadrante BANVA (4) en vez de matriz ABC-XYZ (9)

- **Código:** `AdminInteligencia.tsx:411-1546` toggle de vistas se basa en cuadrante (ESTRELLA/CASHCOW/VOLUMEN/REVISAR). XYZ existe en columna pero no es un eje de filtro/sort destacado.
- **Manual:** `Manual_Inventarios_Parte1.md:201-218` (matriz 9 cuadrantes). `Parte2.md:17-27`. `SPM:255-265, 384-405`.
- **Diferencia:** UI orienta al usuario al modelo BCG (margen × volumen) no al ABC×XYZ del manual.
- **Impacto:** la matriz canónica no está expuesta operativamente; XYZ queda invisible para el admin.
- **Fix sugerido:** vista adicional "Matriz ABC-XYZ" con los 9 cuadrantes y `policy_action`. El cuadrante BANVA puede coexistir como decisión BCG.

### H42 — [SEV: media] [CAT: RIE] `inferirQuiebresDeOrdenes` mezcla sku_venta y sku_origen

- **Código:** `recalcular/route.ts:431` — `sku_origen: skuVenta` (literal). El comentario advierte `"Se mapea a origen después si es necesario"`. En `intelligence.ts:817-820` se agrupa `quiebresPorSku` por `q.sku_origen` (que en realidad es sku_venta). Posible mismatch silencioso.
- **Diferencia:** pequeño bug latente: si un sku_venta no es sku_origen (caso pack), el quiebre inferido nunca matchea con `quiebresDelSku`. La rama de inferencia se pierde para packs.
- **Impacto:** menor — no rompe motor pero degrada calidad de quiebres inferidos para SKUs con composicion múltiple.
- **Fix sugerido:** mapear sku_venta→sku_origen vía `composicion` antes de push.

### H43 — [SEV: alta] [CAT: GAP] No hay lock de pricing pre-evento (T-45) ni archivo defensivo SERNAC

- **Código:** N/A en Inteligencia.
- **Manual:** `Investigacion_Comparada:286, 323, 616`; `Engines_a_Escala:5, 568`.
- **Diferencia:** el motor podría exponer `evento_inminente=true` y permitir que pricing congele precios. No lo hace.
- **Impacto:** riesgo legal (memoria `feedback_no_sernac_justificacion` excluye SERNAC como driver, pero sí lo cita como referencia legal). Out-of-scope estricto, pero documentar.
- **Fix sugerido:** futuro PR; el motor expone `evento_activo` (P4) y podría levantar `evento_t_minus_X` para integradores.

---

## 4. Mapa de cobertura manual → código

Estado de implementación de cada concepto mayor mencionado por los manuales en `docs/manuales/inventarios/` y `docs/manuales/pricing/`.

Leyenda: ✅ implementado · ⚠️ parcial · ❌ ausente · ➖ no aplica al motor de Inteligencia (otra capa).

| Concepto | Fuente manual | Estado | Hallazgo asociado |
|---|---|---|---|
| ABC sobre 3 ejes (margen/ingreso/uds) | Parte1 §2.2 | ✅ `intelligence.ts:1723-1742` | — |
| Pareto 70/90 (retail/textil) | SPM:237 | ❌ | H1 |
| Pareto 80/95 (industrial) | Parte1:174 | ✅ (pero por defecto) | H1 |
| XYZ por CV crudo | Parte2 §2.3 | ✅ | H2 |
| XYZ por CV deseasonalizado | SPM:251 | ❌ | H2 |
| Service level por celda 9 cuadrantes | Parte1:543-553 | ❌ (sólo 3 niveles ABC) | H3 |
| AZ con LT corto, no buffer | SPM:5, 267 | ❌ | H4 |
| Cuadrante ABC-XYZ visible UI | Parte2 §2.4 | ❌ | H41 |
| Matriz BCG (Estrella/Cashcow/Volumen/Revisar) | Ajuste_Plan:154-157 | ✅ `intelligence.ts:1788-1791` | — |
| Subtipos REVISAR (sano/liquidar/sin_stock/nuevo) | Investig_Comp:197+ | ✅ pero en `pricing.ts`, no Intel | H5 |
| Markdown ladder 90/120/180 → -20/-40/-60 | Investig_Comp:197 | ⚠️ Intel usa 30/60/90 → 10/25/40 | H5 |
| Triggers reclasif: aging | Investig_Comp:235 | ✅ vía `dias_sin_movimiento` | H6 |
| Triggers reclasif: Buy Box drop | Investig_Comp:235 | ❌ | H6 |
| Triggers reclasif: competidor agresivo | Investig_Comp:235 | ❌ | H6 |
| Triggers reclasif: crec MoM 20% × 3m | Investig_Comp:235 | ⚠️ implementado fuera Intel | H6 |
| Triggers reclasif: margen <15% × 2m | Investig_Comp:235 | ⚠️ implementado fuera Intel | H6 |
| Velocidad ponderada 50/30/20 | Gestión_Completa:38 | ✅ `intelligence.ts:1055` | — |
| Holt-Winters / SARIMA | Parte3 §3.2 | ❌ (historia<26 sem) | H17 |
| Croston / TSB | Parte3 §3.2.6 | ⚠️ shadow only | H17 (doc) |
| WMAPE | Parte1:373 | ✅ `forecast_accuracy` | — |
| WMAPE retroalimenta motor | Parte1:425 | ❌ sólo alerta | H16 |
| Bias / Tracking signal | Parte1:382-384 | ✅ alertas | — |
| FVA | Parte1 §3.9 | ❌ | H33 |
| Forecast probabilístico p10/p50/p90 | Parte1:276 | ❌ | H30 |
| Eventos calendario regresor | Parte1:412 | ⚠️ multiplicador | — |
| Pre-build T-45 / T-30 | Investig_Comp:286 | ❌ | H43 |
| EOQ Wilson | Parte1 §4.1 | ❌ | H15 |
| (s,Q) política continua | Parte1 §4.3 | ⚠️ "necesita_pedir" sin lote | H15 |
| MOQ respetado | Parte1 §4.2 | ✅ alerta `pedido_bajo_moq` | — |
| Safety Stock simple Z·σ_D·√LT | Parte4 §4.4.1 | ✅ `safety_stock_simple` | — |
| Safety Stock King con σ_LT | SPM:596 | ✅ `safety_stock_completo` | — |
| Service level Z(0.97/0.95/0.90) por ABC | Parte1:541-553 | ⚠️ sólo 3 niveles | H3 |
| Service level por celda 9 (AY=0.96, AZ=0.93, etc.) | Parte1:543-553 | ❌ | H3 |
| Reorder Point (ROP) | Parte1 §4.4.5 | ✅ `rop_calculado` | — |
| LT real por OCs | Parte1 §4.4 | ⚠️ existe queryLeadTimeReal pero pocas OCs cerradas | H38 (doc) |
| LT fallback default 5d | Reposición | ⚠️ sin alerta | H38 |
| MEIO (multi-echelon) | Parte1 §4.5 | ➖ stand-alone Bodega↔Full | — |
| GMROI | Parte1 §6.2.4 | ✅ `gmroi` | — |
| GMROI potencial (quiebre prolongado) | Adaptación interna | ✅ `gmroi_potencial` | — |
| DIO | Parte1 §6.2.2 | ✅ `dio` | — |
| Sell-through 60/90/120d | Parte2 §6.2.3 | ❌ | H24 |
| Stock-to-sales ratio | Parte2 §6.2.6 | ❌ | — |
| Carrying cost % anual | Parte1 §1.3.1 | ❌ no se modela | — |
| Inventory paradox | Parte1 §1.4 | ➖ conceptual | — |
| Cash Conversion Cycle | Parte1 §1.5 | ❌ | — |
| Lost sales estimation | Parte2 §6.3.4 | ✅ `venta_perdida_*` con flag estimación | — |
| Tipos stock (cycle/safety/dead/anticipation/...) | Parte1 §1.2 | ⚠️ el motor solo distingue bodega/full/transito/dañado | — |
| Stock proyectado | ERP_Patrones | ✅ `stock_proyectado` | — |
| Reservaciones expires_at | ERP_Patrones | ➖ fuera del motor | — |
| Cycle counting cadencia A=30d/B=90d/C=365d | Parte5 §5.6.1 | ✅ `v89` view | — |
| Cycle counting auto-genera lista del día | Parte5:140 | ❌ | H34 |
| Pickear con RPC `registrar_movimiento_stock` | Memoria | ✅ | — |
| Pack-aware sync | SPM:1 | ⚠️ via composicion_venta sin tag pack/promo | H29 |
| Donación Ley 21.440 / recovery rate | SPM:476 | ❌ | H40 |
| Liquidación pipeline 12 semanas | SPM:560 | ❌ | H40 |
| Treasure hunt / cap catálogo | Parte2:545+ | ❌ | H32 |
| VMI con Idetex | Parte2 §7.2 | ❌ | H18 |
| 30-day lowest rule | Investig_Comp:310 | ➖ pricing | — |
| CMAA como KPI maestro | Investig_Comp:329 | ❌ | (alineamiento previo) |
| Floor / piso de precio | Engines_a_Escala:684 | ➖ pricing | — |
| Ceiling absoluto | Engines_a_Escala:556 | ❌ | (alineamiento previo) |
| Cooldown anti race | Engines_a_Escala | ➖ pricing | — |
| ramp-up post-quiebre | Parte3 Error #5 | ✅ matriz `rampup.ts` | H20 |
| `dias_en_quiebre` ancla temporal | Inventory-policy R1 | ✅ PR5 | — |
| Quiebre prolongado protegido | Adaptación interna | ✅ ramas 1+2+3 | H19 |
| Quiebre Flex (paridad) | v60 | ✅ | H35 |
| Anulada=false en lecturas analíticas | Memoria | ✅ ventas; ⚠️ `queryOrdenes` mezcla con estado | H27 |
| Centinela 999 admisible | Inventory-policy R1 | ⚠️ presente | H7 |
| Centinela 365 implícito quiebre | Inventory-policy R1 | ⚠️ presente | H26 |

---

## 5. Pendientes que requieren al usuario (Vicente)

Cada uno requiere zanjar política antes de tocar código:

1. **¿Adoptar 70/90 (SPM) o mantener 80/95 (industrial)?** (H1) — Memoria reciente sugiere SPM.
2. **¿Adoptar bandas XYZ 0.25/0.60 deseasonalizadas (textil hogar)?** (H2) — Posible reclasificación masiva, requiere comunicar al equipo.
3. **¿Implementar tabla service_level_por_celda (9 valores) reemplazando los 3 actuales?** (H3) — Cambia stock seguridad por SKU.
4. **¿Trasladar la decisión de liquidación 100% a `pricing.ts` y eliminar P17 de `intelligence.ts` (o sincronizar literalmente con cascada markdown 90/120/180→-20/-40/-60)?** (H5) — Hoy hay dos lógicas paralelas.
5. **¿Subir `target_dias_c` de 14d a 20d?** (H11) — Manual permite ese rango; reduce alertas URGENTE.
6. **¿Adoptar imputación multiplicativa en `uds_30d` con cap?** (H21).
7. **¿Filtrar `queryOrdenes` por `anulada=false` solamente, o seguir con `estado='Pagada'+anulada=false`?** (H27) — Memoria del usuario apunta al primero.
8. **¿Cron rápido cada 5 min para SKUs A o conservar diario único?** (H12) — Costo Vercel.
9. **¿Persistir flags `is_pack`/`is_promo_bundle` en `composicion_venta` o tabla nueva?** (H29).
10. **¿Implementar regla de los 90 días automáticamente con donación Ley 21.440 como destino?** (H13 + H40).

---

## 6. Anexos: archivos auditados y comandos de verificación

- `src/lib/intelligence.ts` (2 296 líneas, leído completo).
- `src/lib/intelligence-queries.ts` (840 líneas, leído completo).
- `src/lib/rampup.ts` (41 líneas, leído completo).
- `src/components/AdminInteligencia.tsx` (3 105 líneas, leído por grep + lectura focal).
- `src/app/api/intelligence/recalcular/route.ts` (584 líneas, leído completo).
- `src/app/api/intelligence/pendientes/route.ts` (186 líneas, leído completo).
- Migraciones: `v15` (sku_intelligence init), `v51-forecast-accuracy`, `v53-tsb`, `v54-es-estacional`, `v55-dias-en-quiebre`, `v60-quiebre-flex`, `v89-abc-max-y-zombis` (leídas).
- Manuales inventarios: 7 archivos (todos leídos completos).
- Manuales pricing: `_alineamiento_codigo_vs_manual.md` y `_inventario_thresholds.md` leídos completos; el resto ya consolidado en esos dos.

Comandos de verificación reproducibles:
```
grep -nE '= 999([^0-9]|$)|= 2071|= -1([^0-9]|$)' src/lib/intelligence*.ts   # Regla 1
grep -nE 'pct <= 80|pct <= 95' src/lib/intelligence.ts                       # H1
grep -nE 'cv < 0.5|cv < 1.0' src/lib/intelligence.ts                         # H2
grep -nE 'ns = 0\.9|ns = 0\.95|ns = 0\.97' src/lib/intelligence.ts           # H3
grep -nE 'tendencia.*15|pico.*1\.5' src/lib/intelligence.ts                  # H8, H9
grep -nE '0\.70|0\.80|0\.30|0\.20|1\.1' src/lib/intelligence.ts              # H10
grep -nE 'limit\(100\)' src/lib/intelligence-queries.ts                       # H25
grep -nE 'CAP = 365' src/lib/intelligence.ts                                  # H26
grep -nE 'estado.*Pagada' src/lib/intelligence-queries.ts                     # H27
grep -nE "motivo.*venta_flex|motivo.*despacho_ml" src/lib/intelligence-queries.ts # H28
```

---

*Auditoría realizada en read-only; no se editó código fuente, manuales ni migraciones. Generada por Claude Opus 4.7 (1M context) el 2026-04-28.*

---

# Adendum — Consenso ST y modo de lanzamiento Operación Limpieza

**Fecha:** 2026-04-28 (post-auditoría, mismo día)
**Origen:** diálogo de revisión Vicente ↔ agente, validado contra los manuales de la sección 1 de esta auditoría.
**Aplica a:** consumidores futuros del sell-through (módulo Inteligencia, Operación Limpieza, motor de markdown, sesión paralela de pricing — `project_banvabodega_paralelo_pricing`).

## A.1. Construcción correcta de sell-through (consenso)

| Componente | Cómo se hace bien |
|---|---|
| **Numerador ST** | `ventas_ml_cache` con filtro `anulada=false` (estado=Pagada NO basta — feedback_ventas_anuladas_filter); granularidad `sku_origen`. |
| **Denominador interim (B)** | `vendido / (vendido + stock_actual)` mientras `stock_snapshots` acumula histórico. |
| **Denominador definitivo (A)** | `vendido / stock_total_inicial_ventana` cuando `stock_snapshots` cubra 60-90 d (≈ 2026-06-16 a 2026-07-16). **`stock_total`, no `stock_full` ni `stock_bodega`** — Op Limpieza mide capital atrapado, no salud por canal. |
| **Ajuste de exposición** | `dias_disponibles_30d = 30 − dias_quiebre_intra_ventana`, calculado **diario** desde `stock_snapshots.en_quiebre_full=true` con fallback a `sku_intelligence.fecha_entrada_quiebre` para el spell actual. |
| **Edad SKU** | `MIN(fecha_primera_venta_observada, ml_items_map.date_created_ml, recepciones.creado_at)`. **Sin reset por reposición** — el manual asume cohorte continua. |
| **Gate confounders** | Excluir spells con `fecha_entrada_quiebre IS NOT NULL`; gate vía `eventos_demanda` (CyberDay, Día Madre, BlackFriday) curada retrospectivamente; LIGHTNING/DOD activos en ventana via `ml_margin_cache.tiene_promo` snapshot histórico (ver A.4 — `ml_promo_history`). |
| **Salida** | Cuatro campos persistidos en `sku_intelligence` (no runtime): `st_observado_30d` + `st_exposure_adjusted_30d` + `dias_disponibles_30d` + `factor_normalizacion_aplicado`, **más** `st_confidence` ∈ `('high', 'low_confidence', 'excluded')` también persistida. **Nunca un solo número que esconda el sesgo.** **`st_confidence` debe ser columna estable en `sku_intelligence`, no derivada en cada lectura** — si fuera runtime, el operador vería sets distintos día a día sin saber por qué (aplica `feedback_silent_failure_antipattern`). El valor se recalcula solo en el cron de Inteligencia y queda fijo hasta el próximo recálculo, igual que `abc`/`xyz`. |

## A.2. Sutilezas operativas

1. **`stock_total` vs `stock_full` para denominador (A).** Op Limpieza es decisión financiera (capital atrapado), no de canal. Usar `stock_full` mide "STR del canal Full" — útil pero distinto. **`stock_total` es la única lectura correcta para markdown.**

2. **Divergencia silenciosa velocidad ↔ ST.** El motor de velocidad (`intelligence.ts:1018-1049`) excluye semanas con `≥3 días de quiebre`. El ajuste de ST acordado es **diario sin gate de threshold**. Misma cobertura conceptual, granularidad distinta. **NO son derivables uno del otro** — un lector futuro va a calcular `vel_30d × dias_disponibles_30d ≈ ventas_30d` y la cuenta no le va a dar. Documentar en código y commit. Migración a velocidad diaria es scope expansión válido pero no obligatorio para arrancar Op Limpieza.

3. **`eventos_demanda` ya existe** (7 filas; columnas verificadas en schema: `id`, `nombre`, `fecha_inicio`, `fecha_fin`, `fecha_prep_desde`, `multiplicador`, `categorias` (array), `notas`, `activo` (bool), `multiplicador_real`, `evaluado` (bool), `created_at`).

   **Semántica de los flags — verificada contra las 7 filas reales (2026-04-28)**:
   - `activo=true` → evento vigente/aplicable; `false` significa "evento dado de baja, ignorar". Confirmado: las 7 filas tienen `activo=true` y son todas eventos futuros (mayo 2026 → enero 2027).
   - `multiplicador` → lift esperado a priori (planificado). Confirmado: todas pobladas (1.3 a 2.5).
   - `multiplicador_real` → lift observado post-evento. **NULL = evento aún no calibrado**. Confirmado: las 7 en NULL (ninguna ha ocurrido).
   - `evaluado=true` → ciclo de revisión completo (alguien comparó esperado vs real). `false` = pendiente de evaluación humana. Confirmado: las 7 en `false`.
   - `fecha_prep_desde` → **inicio del período de afectación de demanda anticipatoria**. **Convención correcta: T-45 mínimo, no T-14/-21**. Las 7 filas actuales tienen `fecha_prep_desde` a 14-21 d antes de `fecha_inicio` — eso es **insuficiente**: el lift empieza 3-6 semanas antes según `BANVA_Pricing_Investigacion_Comparada.md:286` (tabla T-minus: T-60 modelado, T-45 congelar, T-14 teasers) y `BANVA_Pricing_Engines_a_Escala.md:19` (Amazon usa crossover semanas 7-9/10-12 → gap de 3 semanas porque "el demand de hoy contamina el de mañana vía recomendaciones y queries"). Razón operativa: ML comunica DEALs/CyberDay con anticipación → queries y CTR de SKUs implicados suben antes; el comprador pre-evento retiene compras → distorsiona ventas previas. Si el gate usa T-14, los días T-45 a T-14 entran al ST como demanda orgánica cuando ya están bajo influencia → ST inflado → motor concluye "salud" → no markdownea cuando debería. **Repoblar las 7 filas a `fecha_prep_desde = fecha_inicio - 45d`** es prerequisito antes de arrancar el modo híbrido.
   - `categorias` (array) → SKUs/categorías afectadas. **Convención por verificar**: las 7 filas tienen `categorias=[]` (vacío). Default declarado: **`categorias=[]` significa "aplica a todo el catálogo"** (no "no aplica a nada"). Esta es una decisión que conviene cerrar antes de implementar; si la convención que tenía Vicente en mente era la opuesta, hay que ajustar la lógica del consumidor.

   Un evento se considera **"curado"** para gate automático cuando `activo=true AND multiplicador_real IS NOT NULL AND evaluado=true`. Cualquier otra combinación cae a la cola de revisión.

   **Estado actual del piso** (2026-04-28): **0 eventos curados**. Las 7 filas son todas futuras y ninguna ha sido evaluada — coherente con la convención. Implicación: **0 eventos históricos** poblados. La curaduría retrospectiva del último año (CyberDay Marzo, Día Madre 2025, BlackFriday 2025, Navidad 2025, Año Nuevo 2026) requiere INSERTs nuevos, no UPDATE de filas existentes. Sin esos INSERTs históricos, el gate de overlap para ventanas 30/60/90 d hacia atrás encuentra 0 eventos y deja pasar TODA la demanda histórica como "orgánica". 1-2 h sigue siendo realista pero el trabajo es crear filas, no actualizarlas.

4. **Regla meta — "nunca ajuste invisible".** Toda corrección sobre el observado debe ser auditable en el output. Si normalizamos por `multiplicador_real`, el output muestra **ST_observado + ST_normalizado + factor_aplicado**. Si excluimos días, muestra **dias_excluidos + motivo**. Aplica más allá de promos: cualquier ajuste silencioso muere. Sin esa transparencia, en 6 meses nadie audita y el motor se vuelve cabra.

## A.3. Agujeros estructurales (no se resuelven con código)

- **Stock Full histórico no se backfillea.** `movimientos` registra solo bodega; ML no devuelve serie distribuida por fecha. Hasta que `stock_snapshots` acumule 60-90 d (jul-ago 2026), denominador (A) para SKUs Full (~80% del catálogo) es imposible.
- **Precios diarios no existen antes del 2026-04-25** (tabla `ml_price_history` arrancó esa fecha). Imposible deseasonalizar / estimar elasticidad propia hasta tener 12 meses limpios (≈2027-04-28).
- **Promos externas ML llegan sin loguear** (caso `ALPCMPRSQ6012`: cambio de precio en `/seller-promotions` sin webhook `items`). Webhook como fuente única para reconstruir promo histórica es frágil. Snapshot diff de `ml_margin_cache` es estructuralmente más robusto.

## A.4. Acciones inmediatas (sin código, decisión operativa)

| Prioridad | Acción | Razón |
|---|---|---|
| **P0 urgente** | Arrancar `ml_promo_history` append-only (snapshot diff diario o por evento de `ml_margin_cache.tiene_promo/promo_type/promo_pct`) | Cada día sin captura = 1 día de promo histórica perdida para siempre. Webhook NO es alternativa válida. |
| **P0 urgente** | Alerting si `stock_snapshots` cron falla 1 día (aplica `feedback_silent_failure_antipattern`) | Sin alarma, el cron silencioso deja un agujero descubierto en julio. |
| **P0 prerequisito** | **Repoblar las 7 filas existentes con `fecha_prep_desde = fecha_inicio - 45d`** (hoy están a 14-21 d). Sin este UPDATE, el gate de overlap deja entrar demanda anticipatoria como "orgánica". 7 UPDATEs, ≤ 5 min. | Comparada:286 + Engines:19 — lift empieza 3-6 semanas antes, no 14 d. |
| **P1** | Curar retrospectivamente `eventos_demanda` con calendario último año (INSERTs nuevos — al 2026-04-28 hay 0 eventos históricos cargados; las 7 filas son todas futuras). Aplicar también `fecha_prep_desde = fecha_inicio - 45d` y `fecha_fin + 14d` carryover. Cerrar la convención de `categorias=[]` (default propuesto: "aplica a todo el catálogo"). | Rescata calidad para análisis hacia atrás. Sin curaduría histórica, gate de overlap encuentra 0 eventos y todo el histórico pasa como "orgánico". No bloquea P0 prerequisito. |
| **P1** | Documentar la divergencia velocidad-semanal ↔ ST-diario en `inventory-policy.md` y commit que toque alguna de las dos lógicas | Evita "fix" futuro de un bug que no existe. |

## A.5. Decisión de lanzamiento — modo híbrido (opción 3)

**Decidido por Vicente, 2026-04-28.**

Op Limpieza arranca en **modo semi-auto con cola de revisión humana** (alineado con `BANVA_Pricing_Operacion_Limpieza.md`: *"60-90 días en modo semi-auto antes de transición a auto"*).

**Reglas del modo híbrido:**

- **Automático** (markdown sin intervención): SKUs cuya ventana 30d esté 100% dentro de `stock_snapshots` con cobertura, sin quiebre actual (`fecha_entrada_quiebre IS NULL` o `dias_en_quiebre < 2`), sin overlap con eventos `eventos_demanda` **no curados** dentro de `[fecha_prep_desde, fecha_fin + 14d]` — el `+14d` cubre el carryover post-evento (`Comparada:290` documenta T+1 a T+7 con 30-day rule; `Engines:19` extiende a 3 semanas por contaminación de recomendaciones/queries; 14 d es punto medio defendible). Curado = `activo=true AND multiplicador_real IS NOT NULL AND evaluado=true`; ver A.2.3. ST(B) calculado sobre exposición ajustada completa.
- **Cola de revisión** (`st_confidence='low_confidence'`): SKUs con cualquiera de — ventana se solapa con días pre-`stock_snapshots`, gate de promo no resoluble por falta de `ml_promo_history`, ventana incluye evento calendario **no curado** dentro de `[fecha_prep_desde, fecha_fin + 14d]` (cualquier evento que NO cumpla `activo=true AND multiplicador_real IS NOT NULL AND evaluado=true`), o quiebre intermitente entre 13-30 d atrás. Estos NO se markdownean automáticos.

- **Kill-switch global durante evento activo (NO low_confidence)**: cuando `hoy ∈ [fecha_inicio, fecha_fin]` de cualquier evento `activo=true`, **pausar el motor de markdown ladder de Op Limpieza** (las bajadas defensivas por aging E1-E4) — no SKU por SKU. **Scope explícito**: la pausa aplica SOLO a Op Limpieza. **`auto_postular` (cron `0 10,14,18,22 * * *`) y la postulación a promos tier 5/4 ofrecidas por ML siguen activos**, porque durante el evento ML ofrece DEALs/cupones específicos del evento y `Comparada:618` prescribe explícitamente *"cupón en top 30 SKUs del cuadrante Estrella"* durante CyberDay/CyberMonday/Black Friday. Apagar la postulación contradiría el playbook del manual. Lo que se pausa es la **bajada defensiva por aging**, no la **postulación oportunística a promos del evento**.

  Razón documentada en `Engines:19` y `Engines:584` — Amazon pausaba Project Nessie (su motor de pricing predictivo) durante Prime Day y feriados ("increased media focus and customer traffic") y lo reactivaba después; el manual prescribe replicarlo literal para CyberDay/Black Friday Chile. Razón operativa: durante el evento la señal de ST es ruido por dos efectos simultáneos — tráfico anómalo (5-20× impresiones/clicks) y volatilidad de competidores (race-to-the-bottom amplificado). `low_confidence` con cola humana no escala: durante un CyberDay con 200+ SKUs simultáneos en cola, nadie atiende y el modo híbrido degrada a "feature en pausa" silenciosa. **Pausa de markdown ladder > delegación humana imposible**, pero **postulación oportunística sigue corriendo** porque su lógica es "ML ofrece, decidimos meter o no", no "ST cayó, bajamos defensivamente".
- **Destino UI de la cola**: extender `src/components/AdminMarkdownPilot.tsx` con un badge/filtro `low_confidence_st` y una sub-pestaña "Pendiente revisión". **NO crear vista nueva** — la cola es parte del flujo de markdown existente, no una feature aparte. Un agente futuro que cree `AdminMarkdownReview.tsx` paralelo introduce duplicación zombi (Regla 5 de `inventory-policy.md`).
- **Hard gate** (no entran a ningún escalón ≥E2): `fecha_entrada_quiebre IS NOT NULL AND dias_en_quiebre >= 2`. No se liquida lo que no está expuesto. **El AND con threshold ≥2 días es necesario** para no excluir falsos positivos: un SKU que entró a quiebre hace 30 min por una venta agotadora aparece con `fecha_entrada_quiebre = hoy` aunque la ventana 30d previa fue 100% expuesta. Sin el threshold, ese SKU queda fuera del análisis todo el día por un evento puntual de hace minutos. Con threshold ≥2 días, el gate captura quiebres reales (estructurales) y deja pasar agotamientos transitorios que se reponen rápido.

**Cobertura esperada del modo automático:**

| Fecha | Ventana 30d auditable | Ventana 60d | Ventana 90d |
|---|---|---|---|
| 2026-04-28 (hoy) | ~5-10% catálogo | 0% | 0% |
| 2026-05-28 | ~70% catálogo (presentes en stock_snapshots todo el mes) | low confidence | low confidence |
| 2026-06-28 | ~85% | ~70% | low confidence |
| 2026-07-28 | ~95% | ~85% | ~70% |

La cola de revisión humana absorbe el resto. **La feature NO está en pausa hasta julio** — está en cobertura creciente con backstop manual. El capital atrapado en SKUs ambiguos sigue atrapado solo si nadie atiende la cola.

**Cuello de botella operativo (decisión pendiente de Vicente):** quién atiende la cola, con qué frecuencia, dónde se ve.

- **Sugerencia (no decisión)**: si la cola arranca chica (decenas de SKUs/semana), atenderla como ítem fijo en la WBR semanal de pricing. Si crece a centenas, asignar operador dedicado. Sin operador asignado, modo híbrido degrada a "feature en pausa" — el riesgo es exactamente el que A.5 describe.
- **Métricas mínimas a exponer en `AdminMarkdownPilot`**: tamaño de la cola hoy, edad media del SKU más viejo en la cola, % del catálogo en `low_confidence` (debe bajar mes a mes mientras `stock_snapshots` acumula).

## A.6. Estructura ML/MLC que el motor de markdown debe respetar

Tres consecuencias del marketplace que NO estaban en la conversación inicial pero afectan el diseño del motor antes de implementar. Citas verificadas contra los manuales.

### A.6.1. Cupón vs descuento directo para SKUs hero (`Comparada:306, 618`)

`Comparada:306` (tabla cupones vs descuento directo) y `Comparada:618` (matriz transferibilidad BANVA) prescriben:

> *"Cupones en lugar de price cuts para hero SKUs durante eventos. Evita 30-day lowest rule y Buy Box suppression post-evento. En próximos CyberDay/CyberMonday/Black Friday: cupón en top 30 SKUs del cuadrante Estrella, NO price cut directo."*

**Razón operativa**: el descuento directo marca el baseline a la baja en el rolling 30-day de ML. Cuando subís el precio post-evento, ML suprime el Buy Box porque `current_price > avg_30d`. El cupón es **neutral al baseline** — preserva el precio de lista para el cálculo del 30-day y entrega el descuento solo al comprador en el carrito.

**Implicación para Op Limpieza**: hoy el motor solo postula descuentos directos (`promos_postulables`, `auto_postulacion_log`). Para SKUs del cuadrante Estrella durante eventos, el escalón debería postular **cupón**, no price cut. Esto requiere distinguir en el motor `accion_tipo ∈ ('descuento_directo', 'cupon')` por cuadrante × contexto-evento. Hoy es asunción implícita "siempre descuento directo" — gap a cerrar antes de que el motor toque SKUs Estrella en evento.

### A.6.2. 30-day rolling rule de ML — markdown en ladder NO es reversible (`Comparada:310`)

`Comparada:310` documenta:

> *"Bajar precio permanentemente y luego subirlo es peligroso: Amazon suprime Buy Box si current price > average 30-day."*

ML aplica la misma regla. Implicancia concreta para el ladder de markdown E1 → E2 → E3 → E4 (-10/-25/-40/-60% según el manual de Op Limpieza):

- Una vez que un SKU bajó a E2 (-25%), el promedio 30d arrastra ese precio. Subirlo después gatilla supresión de Buy Box.
- **El markdown del ladder es one-way sin penalty**. Subir el precio post-liquidación requiere o bien aceptar 30 d con Buy Box suprimido, o postular cupón para esconder la subida del baseline, o esperar 30 d con el precio bajo hasta que el rolling se renueve.
- Esta restricción debe estar **escrita en el flujo del motor** y visible en la UI antes de aprobar el escalón. El operador debe ver "este markdown es one-way: no podés volver atrás sin penalty" en la postulación.

**Gap actual**: el motor no contempla esto. La asunción implícita es "puedo subir y bajar libremente" — falsa.

### A.6.3. Cadencia óptima de repricing por categoría (`Engines:42`)

`Engines:42` cita Camilo Martínez (equipo pricing ML):

> *"automated algorithms combine factors such as competitiveness, revenue, and inventory levels. Bestsellers can change up to 15 times a day, but **home and living can just chill at the same price for a good while**."*

**Implicación**: para BANVA (textil hogar) cualquier cambio de precio basado en ventana semanal o sub-semanal es **ruido, no señal**. Refuerza dos cosas del consenso ya cerrado:
- Las ventanas 30/60/90 d del manual de Op Limpieza son las correctas, no acelerarlas.
- Cualquier propuesta futura de "repricer en tiempo real" para textil hogar es scope expansión injustificada por la propia cita de la gente de ML.

## A.7. Kill-switch durante eventos — política formal (resumen)

Consolidando A.5 + A.6 para que sea único punto de referencia.

**Scope del kill-switch**: aplica SOLO al motor de **markdown ladder de Op Limpieza** (bajadas defensivas por aging E1-E4). NO aplica a `auto_postular` (cron `0 10,14,18,22 * * *`) ni a la postulación oportunística a promos ML (LIGHTNING/DOD/cupones del evento). La razón es que durante eventos el manual (`Comparada:618`) prescribe **activar** la postulación a cupones para SKUs Estrella, no apagarla. Lo que se pausa es la lógica defensiva ("ST cayó, bajo precio"), no la oportunística ("ML ofrece DEAL, decido meter o no").

| Estado del calendario | Markdown ladder (Op Limpieza) | `auto_postular` (promos ML) |
|---|---|---|
| `hoy ∈ [fecha_prep_desde, fecha_inicio - 1d]` de evento `activo=true` no curado | Cola de revisión humana (`low_confidence`) | Activo (con criterios normales) |
| `hoy ∈ [fecha_inicio, fecha_fin]` de evento `activo=true` | **Kill-switch — pausa total del motor de aging** | **Activo + priorizar cupones para SKUs Estrella** (`Comparada:618`) |
| `hoy ∈ [fecha_fin + 1d, fecha_fin + 14d]` de evento `activo=true` no curado | Cola de revisión humana (carryover) | Activo (con criterios normales) |
| Sin overlap con eventos | Modo automático elegible (sujeto a otros gates de A.5) | Activo (con criterios normales) |

**Documentación de la pausa**: cada evento de pausa del motor de aging se loguea en `pricing_decision_log` (tabla ya existe, ver listing `mcp__supabase__list_tables`) con `decision_type='kill_switch_event'`, `motor='markdown_ladder'`, `event_name`, `paused_at`, `resumed_at`. Inmutable. Razón: `Engines:584` — *"Pausa pricing engine durante CyberDay, Black Friday, días previos a fechas de alto escrutinio. Documenta la decisión de pausa en `pricing_policy` con `paused_categories` o flag global."* El campo `motor` permite que kill-switches futuros de otros engines se loguen sin colisión.

## A.8. Persistencia y descubrimiento

- Este adendum vive en `docs/auditorias/inteligencia_vs_manuales_2026-04-28.md` (sección "Adendum — Consenso ST...").
- Puntero en `.claude/rules/inventory-policy.md` para que cualquier agente que toque Inteligencia / Op Limpieza lo encuentre por grep antes de cambiar lógica de ST.
- Memoria de proyecto local: `project_op_limpieza_modo_hibrido.md` — solo visible en esta sesión Claude (la sesión paralela de pricing no la ve; por eso el puntero en `inventory-policy.md` es la vía cross-sesión).

*Adendum generado por Claude Opus 4.7 (1M context) el 2026-04-28, post-auditoría, sin tocar código.*
