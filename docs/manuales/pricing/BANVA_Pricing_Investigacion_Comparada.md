# Gestión de pricing en e-commerce multi-SKU
## Investigación comparada Modelo A (marketplace puro) vs Modelo B (omnicanal), con matriz de transferibilidad a BANVA

---

## 1. Resumen ejecutivo — 10 hallazgos accionables

1. **El repricer es infraestructura, no ventaja.** En Amazon ~33 % de sellers best-seller ya usaban pricing algorítmico en 2015 (Chen, Mislove & Wilson, WWW'16); hoy el benchmark en sellers >US$1M es >50 %. Un catálogo de 425 SKUs sin repricing automático pierde Buy Box sistemáticamente. **Aplica a ambos modelos, pero es crítico en Modelo A.**
2. **El floor del repricer debe ser cuantitativo, no un mark-up.** Los flash crashes documentados (libro de US$23.698.655 en 2011; glitch RepricerExpress UK 2014 con listings a £0,01) comparten la misma raíz: reglas multiplicativas sin floor basado en costo total (COGS + fees + fulfillment + fracción de ads + impuestos).
3. **Existe una regla de dimensionamiento organizacional validada**: ~1 FTE de pricing por cada US$30–200 M de revenue (Simon-Kucher, PPS 2023). Para un seller de ~US$8–10 M anuales como BANVA, **no corresponde aún un Pricing Manager senior (~US$150k), sino un Pricing Analyst (US$15–30 k LATAM nearshore)**.
4. **La concentración real en marketplaces es más extrema que 80/20.** En Amazon, el 5 % de los SKUs capta ~50 % del revenue; la cola larga (>95 % de SKUs) suma ~79 % (ToolsGroup; Brynjolfsson MIT 2003). Esto cambia el enfoque: proteger obsesivamente los top 20–40 SKUs y automatizar el resto con reglas simples.
5. **ACOS del 3,9 % de BANVA es una bandera, no un logro.** Benchmark Amazon "bueno" es 15–30 %. Un ACOS tan bajo con GM 23 % sugiere **sub-inversión publicitaria**: hay headroom de 10–20 puntos de ACOS antes de break-even, probablemente 25–60 % de ventas adicionales sin destruir margen.
6. **A/B testing de precio NO existe nativamente en Amazon ni MercadoLibre** para sellers. Amazon "Manage Your Experiments" excluye explícitamente precio. La alternativa defendible es **pre/post con synthetic control** (CausalImpact / Bayesian structural time series); requiere ≥200 unidades/mes por SKU para detectar lifts de 10 % con potencia 80 %.
7. **La métrica correcta de gobierno no es margen bruto, es Contribution Margin After Ads (CMAA)**. Con GM 23 % y fees ML típicos 13–19 % + Full + ads + devoluciones, es probable que 15–25 % de los 425 SKUs de BANVA estén en CMAA negativo aunque aparezcan en verde en el semáforo de margen bruto.
8. **Pre-pricing en eventos es sancionable en LATAM.** SERNAC Chile documentó en CyberDay 2024 precios inflados en Hiper Líder, Falabella, París y Farmacias Ahumada; Profeco estableció multas de hasta **MX$4,27 M** por publicidad engañosa. Congelar precios T-45 días y documentarlos con screenshots es la defensa estándar.
9. **Velocidad de entrega supera al precio en elasticidad cruzada con conversión en home goods.** Wayfair midió que CastleGate (fast-ship) duplica la conversión vs drop-ship; Anker construyó margen de 52 % no por ser barato sino por calidad percibida. **Invertir más en Full puede rendir más que 5 % de descuento adicional.**
10. **La matriz BANVA (Estrella/Crecimiento/Rentabilidad/Dudoso) es una reinterpretación BCG válida pero incompleta.** Le falta (a) un eje de elasticidad, (b) un tag de ciclo de vida y (c) umbrales cuantitativos explícitos de corte. Enriquecerla con ABC-XYZ por encima genera políticas diferenciadas de safety stock y cadencia de repricing sin romper el vocabulario ejecutivo ya adoptado.

---

## 2. Metodología y fuentes

**Alcance:** revisión de literatura académica indexada (Marketing Science, Journal of Marketing Research, Management Science, AER, JPE, KDD, HBR), documentación oficial de plataformas (Amazon Seller Central, Amazon SP-API, MercadoLibre Developers, Mercado Ads), 10-K/S-1 de empresas públicas (Wayfair, Chewy, Casper, Anker 300866.SZ), reportes de consultoras (McKinsey, Bain, Simon-Kucher, BCG, Deloitte, PPS), herramientas de inteligencia de mercado (Marketplace Pulse, Nubimetrics, Jungle Scout, Pacvue), y cobertura de prensa especializada.

**Criterios de calidad:** se priorizaron fuentes primarias auditadas (10-K, papers peer-reviewed, documentación oficial de plataforma) sobre fuentes secundarias (blogs de vendors SaaS, posts LinkedIn). Cada dato lleva cita. Cuando existían gaps o datos no verificables (ej. ACOS específico por seller MELI, headcount exacto de pricing team en Anker), se admite explícitamente.

**Limitaciones declaradas:**
- Amazon nunca publicó pesos del algoritmo Buy Box; las jerarquías de factores son ingeniería inversa empírica (Chen et al. 2016 como referencia académica).
- No existe un caso público profundo de un top seller MELI LATAM específico con números duros; se entregó un caso compuesto validado con Nubimetrics y MELI Developers.
- Benchmarks de ACOS, TACoS y Buy Box Win Rate provienen frecuentemente de vendors SaaS con sesgo comercial.
- Salarios LATAM para roles de pricing tienen alta dispersión por heterogeneidad de mercado.

---

## 3. Marco conceptual comparativo Modelo A vs Modelo B

| Dimensión estructural | Modelo A — Marketplace puro (>80 % en Amazon/ML/Shopee/eBay) | Modelo B — Retailer omnicanal (marketplace + D2C + físico) |
|---|---|---|
| **Función objetivo de pricing** | Ganar Buy Box / publicación ganadora → volumen | Proteger imagen de precio, margen y coherencia cross-canal |
| **Velocidad de decisión** | Minutos (SP-API permite cambios cada 2 min) | Horas a días (requiere alineación cross-functional) |
| **Dueño típico del pricing** | Founder o Head of E-commerce (≤500 SKUs); Pricing Analyst (500–5K) | CFO / Chief Merchant / VP Pricing con aprobación de Finance |
| **Autonomía del algoritmo** | 70–95 % del catálogo | 30–60 % (MAP, brand, channel coherence limitan) |
| **Margen bruto típico** | 25–45 % antes de ads (después fees marketplace 15–20 %) | 30–60 % (retail general); 60–80 % (DTC premium) |
| **Ad spend como % revenue** | 8–15 % (Amazon); top sellers <10 % | 10–14 % (Wayfair 12,4 % 2024; Casper llegó a 31,5 %) |
| **KPI central** | ACOS / TACoS / Buy Box Win Rate | Blended ROAS cross-channel + MER + CAC/LTV |
| **Atribución** | Last-touch dentro del marketplace (ventana 7–14 días) | Multi-touch + MMM + incrementalidad |
| **Principal tensión política** | Pricing ↔ Ads (cuánto margen ceder por visibilidad) | Pricing ↔ Compras ↔ Tiendas ↔ Marketing (cuatro vías) |
| **Exposición regulatoria** | Amortiguada por el marketplace | Directa (SERNAC, Profeco, CMA) |
| **Data ownership** | Limitada (APIs restringidas, sin email del cliente) | Completa (first-party, CDP, CRM) |
| **A/B test de precio** | No disponible nativamente | Factible vía Shopify apps, geo-split |

**Tesis central**: en Modelo A el repricer es el brazo operativo principal del pricing; en Modelo B el repricer es un subsistema subordinado a una política omnicanal con coherencia de precio como restricción dura. **BANVA hoy opera en Modelo A puro con MercadoLibre Chile**, pero su stack custom (WMS Next.js 14 + Supabase) y matriz Estrella/Crecimiento/Rentabilidad/Dudoso apuntan a una posible evolución híbrida.

---

## 4.1 Algoritmos y reglas de repricing automático

### Estado del arte

El repricing se ha bifurcado en tres capas tecnológicas: **(a) rule-based** ("iguala al más bajo − $0,01"), ejemplificado por Amazon Automate Pricing y RepricerExpress básico; **(b) algorítmico/dinámico** (optimización paramétrica con frecuencias de 2–15 minutos vía SP-API notifications): Repricer.com, Alpha Repricer, xSellco; **(c) ML/AI con teoría de juegos** (Feedvisor, Seller Snap, Aura, Profasee), que modelan la función de reacción del competidor. Trabajos recientes (Calvano et al., *AER* 2020; Assad, Clark, Ershov & Xu, *JPE* 2024; Hansen, Misra & Pai, *Marketing Science* 2021) muestran que **algoritmos Q-learning independientes pueden converger a precios supra-competitivos (colusión tácita) sin comunicación explícita**, lo que matiza el framing de "race-to-the-bottom" — este último describe solo a la capa rule-based mal configurada.

### Benchmarks cuantitativos

| Métrica | Valor | Fuente |
|---|---|---|
| % ventas Amazon que pasan por Buy Box | 75–82 % | Chen, Mislove & Wilson WWW'16; Feedvisor |
| Sellers 3P Amazon con pricing algorítmico (best-sellers) | ~33 % (2015); estimado >50 % hoy | Chen et al. 2016 |
| Frecuencia técnica máxima SP-API | 1 cambio / 2 min | Seller Central Forums |
| Frecuencia típica repricers rule-based | Cada 15 min | Amazon Automate Pricing |
| Sellers Amazon activos con >US$1M ventas anuales | >100.000 (vs 60.000 en 2021) | Marketplace Pulse 2025 |
| Prioridad de costos reportada por sellers | 49 % fees marketplace; 46 % ad spend | Marketplace Pulse Seller Index 2026 |

### Factores Amazon Buy Box vs MercadoLibre "publicación ganadora"

| Factor | Amazon Buy Box | MercadoLibre |
|---|---|---|
| Documentación oficial | No publicada | Publicada en `developers.mercadolibre.com/en_us/catalog-competition` |
| Precio | Variable #1 (random forest Chen et al.) | Factor explícito #1 |
| Fulfillment | FBA/SFP fuertemente favorecidos | Mercado Envíos Full |
| Financiación | No aplica | **Cuotas sin interés**: factor explícito (diferencia LATAM) |
| API para monitorear | `getFeaturedOfferExpectedPrice` | `GET /items/{item_id}/price_to_win?version=v2` con estados `winning / sharing_first / losing / listed` |

### Casos documentados de repricing mal calibrado

- **"The Making of a Fly" (abril 2011)**: dos sellers con reglas multiplicativas encadenadas (profnath 0,9983× bordeebook; bordeebook 1,270589× profnath) escalaron el precio a **US$23.698.655,93** antes de corrección.
- **RepricerExpress UK (diciembre 2014)**: glitch llevó miles de listings a £0,01 durante ~1 hora; Kiddymania reportó pérdidas de ~£20.000.
- **DoJ vs David Topkins (2015)**: primer caso criminal de e-commerce algorítmico bajo Sherman Act §1.
- **Assad, Clark, Ershov & Xu (JPE 2024)**: duopolios de gasolineras alemanas mostraron **+9 % de margen** tras adoptar software algorítmico, sin evidencia de coordinación explícita.
- **MercadoLibre**: no existe documentación pública verificable de un flash crash catastrófico. Se evita fabricar casos.

### Diferencias A vs B

| Dimensión | Modelo A | Modelo B |
|---|---|---|
| Consecuencia de perder Buy Box | Pérdida ~75–82 % de ventas del SKU | D2C y físico amortiguan |
| Conflicto con MAP | Casi nulo | Alto (riesgo de acciones de distribución) |
| Uso de ML/teoría de juegos | Alto ROI demostrable | Justificable solo en SKUs de alto volumen |

### 5 implicaciones accionables

1. **Segmentar en tres cohortes**: tier A (~80 SKUs) repricer algorítmico cada 5–15 min; tier B (~170 SKUs) rule-based horario; tier C (~175 SKUs) revisión manual mensual + floor rígido.
2. **Floor cuantitativo con 5 componentes explícitos**: `floor = COGS + fee_ML + costo_Envíos_Full + fracción_ads_atribuible + IVA_no_recuperable + margen_objetivo_mínimo`; re-calcular trimestralmente cuando ML ajusta tarifas.
3. **Tres reglas anti-race-to-the-bottom**: (a) cooldown si bajó 2× en 24 h sin ganar; (b) ignorar competidores con reputación amarilla/roja o <20 ventas/mes; (c) no competir contigo mismo (excluirte del competitor set vía `seller_id`).
4. **Monitorear `price_to_win` activamente**, no por scraping del frontend. Si el estado es `listed`, no se gana con precio — hay problema estructural (Full, stock, reputación).
5. **Auditar trimestralmente volatilidad propia**: SKUs con >10 cambios/día y win-rate <30 % están "gastando señal". Validar el lift real con A/B matched antes de asumir el "+145 %" publicitado por vendors.

---

## 4.2 Estructura organizacional de pricing

### Estado del arte

La función pricing en e-commerce pasó, en 10 años, de tarea táctica en Excel ejecutada por fundadores a disciplina con equipos dedicados, herramientas algorítmicas y gobernanza formal. La Professional Pricing Society (2023, n=752) reporta equipos de ~**3,58 FTE por US$1 B de revenue** en EE.UU. y ~3,73 FTE por €1 B en Europa. Solo el 33,9 % de empresas usa software específico de pricing; el 30,3 % sigue con Excel. El 26,8 % de pricers reporta a senior management; el 73,2 % a Finance/Marketing/BU/Sales/Product/Ops.

### Estructura por tamaño de catálogo

| Tamaño | Modelo A | Modelo B |
|---|---|---|
| **100–500 SKUs** | Founder + VA/Analyst part-time; repricer SaaS; 0–1 FTE | Founder o E-commerce Manager decide online; Buyer/Category decide físico; 1 FTE mixto |
| **500–5.000 SKUs** | Pricing Analyst dedicado + Head of E-commerce; 1–3 FTEs | Pricing Manager + 1-2 Analysts + Category Managers; 3–6 FTEs |
| **5.000+ SKUs** | Head of Pricing/Revenue Mgmt + equipo 5–15 FTE | Director/VP Pricing + Revenue Mgmt + Data Science + Category; 10–50+ FTEs |

### Perfiles de rol con salarios verificados

| Rol | Salario USA (base + bono) | Salario LATAM in-country (USD/año) | Reporta a |
|---|---|---|---|
| Pricing Analyst | US$90–135 k (mediana PPS US$107 k) | MX ~US$9–21 k; Brasil ~US$16–24 k | Pricing Manager / Finance Dir |
| Pricing Manager | US$111–193 k (mediana US$145 k) | MX US$18–36 k; Brasil US$35–55 k | Head of Pricing / CFO / VP Ecom |
| Revenue Manager | US$107–185 k (mediana US$139 k) | MX ~US$25–45 k | CRO / COO / CFO |
| Category Manager | US$126–222 k (Amazon mediana US$166 k) | MX US$30–60 k; Brasil US$35–70 k | Dir/VP Merchandising |
| Head of E-commerce | US$72–305 k (mediana ~US$107 k) | MX ~US$25–50 k | CEO / COO / CMO |
| Head of Pricing / Director | US$190–271 k+ | MX US$70–120 k; Brasil US$90–160 k | C-suite |

### Cadencias de reuniones (estándar Amazon WBR)

| Cadencia | Qué se revisa | Modelo A | Modelo B |
|---|---|---|---|
| Diaria (15 min) | Buy Box, anomalías, stock, pricing exceptions | Crítica | Selectiva en hero SKUs |
| **WBR semanal** (60–90 min) | Sales, margen, ASP, price realization, competitor moves | Compacta, data-driven | Más larga, politizada |
| MBR mensual | KPIs margen, markdown %, re-tiering | Long-tail focus | Channel conflict, MAP, promo |
| QBR | Strategy review, corridors, algorithm perf | Cambios estructurales | Pricing architecture cross-channel |

### Governance: umbrales típicos

| Decisión | Regla automatizada | Escalación |
|---|---|---|
| Match competitor | Automático si margen ≥ floor y cambio ≤10 % en 24 h | >10 % → Pricing Analyst |
| Descuento algorítmico | Hasta 5–10 % sin aprobación | 10–20 % → Pricing Mgr; **≥25 % → VP/Director** |
| Price floor | **Bloqueado**; excepción requiere Finance + Category | CFO / Head of Pricing |
| Nuevo SKU precio inicial | **100 % manual primeros 30–90 días** | Category Mgr + Pricing Mgr |
| Promo/markdown >20 % | Fuera de scope algorítmico | Promo Review Board |

### Diagramas organizacionales reales

- **Wayfair**: unidad "Pricing, Demand Forecasting, and Profit Management" bajo VP Corey Oberlander, reportando a CTO/COO, no a Finance ni Marketing.
- **Chewy**: sin "Head of Pricing" visible; pricing embebido en ~91 Category Managers.
- **Amazon Retail**: pricing algorítmico centralizado para long tail + Category Managers L5–L6 que manejan hero-SKUs y negocian con vendors.

### Hallazgo crítico de PPS 2023

Cuando se preguntó a pricers qué les genera más insatisfacción: **#1 Corporate politics (52 %); #2 Being understaffed (40,5 %)**. Confirma que pricing es función políticamente tensa. La recomendación de Simon-Kucher: la pregunta correcta no es "a quién reporta" sino "qué tensiones sanas crea con otras funciones".

### 5 implicaciones accionables para founder-led con 425 SKUs

1. **Contratar 1 Pricing Analyst dedicado AHORA** (no Pricing Manager senior). LATAM nearshore US$15–30 k rinde 70–80 % del valor a 15 % del costo de un senior USA.
2. **Playbook de gobernanza de 1 página** con umbrales explícitos: algoritmo puede cambiar ±10 % si CMAA ≥20 %; 10–25 % requiere Analyst; ≥25 % requiere Founder.
3. **Cadencia Amazon-style**: WBR martes 9 am (60 min) + MBR mensual (2 h). Bain documenta lift 10–25 % revenue en 6 meses vs ad-hoc.
4. **Regla explícita Pricing ↔ Ads**: cada SKU tiene un *target blended margin post-ads post-price*. Ambas funciones operan libremente mientras el blended esté en target.
5. **NO contratar Revenue Manager hasta >5.000 SKUs o >US$100 M revenue**. El ROI es bajo fuera de inventario perecedero.

---

## 4.3 Segmentación de SKUs para pricing diferenciado

### Estado del arte

Evolución en cuatro olas: (1) **ABC 1D** (1950s) — 1 eje valor; (2) **BCG 2D** (1970, Henderson) — share × crecimiento, 4 cuadrantes; (3) **GE-McKinsey 9-box** — scores compuestos multicriterio; (4) **multidimensional dinámico** (2000s–2020s): ABC-XYZ (valor × variabilidad), FSN (Fast/Slow/Non-moving), 3D (margen × velocidad × elasticidad), RFM trasladada de clientes a productos, y value-based segmentation (Nagle, Müller & Gruyaert 2023, 7ª ed.) con 6 pasos y *price fences*.

### Comparación de frameworks

| Framework | Ejes | Cuándo usar |
|---|---|---|
| ABC (Pareto) | 1D valor consumo anual | Baseline obligatorio; priorización operativa |
| ABC-XYZ | 2D valor × variabilidad | Retailers >500 SKUs con planificación formal |
| BCG aplicada | 2D share × crecimiento (o margen × crecimiento) | Asignación de budget marketing; visión ejecutiva |
| GE-McKinsey 9-box | 2D multicriterio | ≥3 categorías heterogéneas; review estratégico anual |
| RFM para productos | 3D Recency × Frequency × Monetary | Catálogos grandes; re-engagement SKUs dormantes |
| **3D margen × velocidad × elasticidad** | 3D | **Operadores maduros con repricer y >US$1M GMV** |

### Umbrales cuantitativos documentados

| Segmento | Métrica | Benchmark |
|---|---|---|
| A-items | Top 10–20 % SKUs → 70–80 % revenue | Lokad, NetSuite, Bizowie |
| Star por rotación | Sell-through mensual | ≥80 % excelente; 60–80 % bueno; <40 % alarma |
| Cash cow (margen) | Gross margin | e-commerce sano 40–80 %; premium +20–30 pp vs discount |
| Dog / descontinuar | Aging | >90–180 días sin movimiento = slow; >180–365 = dead stock |
| Estacional — 1ª rebaja | Si STR <30 % a semana 4 | 15–30 % descuento inicial; 40–50 % mid-season; 60–70 % EOS |
| Nuevo skimming | Premium vs mercado | +16 % al launch (Spann, Fischer & Tellis, *Marketing Science* 2015) |
| Nuevo penetration | Descuento vs mercado | −18 % al launch |
| Distribución launches | Patrones observados | Skimming 20 % / Penetration 20 % / Market 60 % |
| Long tail | % SKUs / % revenue | >95 % SKUs = 79 % revenue en gran e-commerce (ToolsGroup) |

### Estrategia por segmento

| Segmento | Estrategia dominante | Trade-off |
|---|---|---|
| Bestsellers / Estrellas | Competitive/dynamic; proteger visibilidad; KVI | Margen vs share (bajar 5 % requiere +20 % volumen) |
| Cash cows | Value-based / margin optimization; subir escalonado +3–5 % | Erosión silenciosa de share si entra competencia |
| Long tail | **Premium pricing** +15–25 % vs commodity | Demanda esporádica → difícil probar óptimo |
| Estacionales | Markdown planificado por triggers WOS/STR | Anticipar = ceder; retrasar = dead stock |
| Loss leaders | KVIs + attach rate histórico >1,3; ventana 48–72 h | Canibalización si el comprador solo toma el loss leader |
| Question marks | A/B con precio paramétrico 30–60 días | Coste de oportunidad de indecisión |
| Dogs | Clearance 60–80 %; bundle con fast movers; delist si STR <20 % en 90 días | Canal se "educa" en esperar rebajas |

### Benchmarks 80/20 reales

En marketplaces la distribución se asemeja a una **power law** más que a 80/20 clásica: **5 % de SKUs genera ~50 % revenue**; cola larga >95 % SKUs = 79 % revenue (ToolsGroup). En Amazon libros (Brynjolfsson MIT 2003), 47,9 % de ventas corresponden a títulos con rank >40.000. En mid-market seller Amazon individual (Flippa), es común que **top 3 SKUs ≈ 70 % revenue y top SKU ≈ 33 %**.

### Matriz BANVA vs frameworks estándar

| BANVA | Equivalente BCG | GE-McKinsey |
|---|---|---|
| **Estrella** | Star | Invest / Grow |
| **Crecimiento** | Question Mark (pero con tracción asumida) | Selective investment |
| **Rentabilidad** | Cash Cow | Harvest / Maintain |
| **Dudoso** | Dog | Divest / Harvest |

**Fortalezas**: nomenclatura en español, más digerible para equipo LATAM; "Crecimiento" elimina ambigüedad de "Question Mark"; "Rentabilidad" orienta a margen (no share). **Debilidades**: sigue siendo 2D; no captura variabilidad (XYZ), elasticidad (3D), ni ciclo de vida; los ejes no están explícitos; no incorpora Buy Box share. **Recomendación**: mantenerla como lenguaje ejecutivo y enriquecer con sub-tags ABC-XYZ + ciclo de vida.

### 5 implicaciones accionables para BANVA

1. **Agregar capa ABC-XYZ sobre BANVA**: composite tag `BANVA-Quadrant / ABC / XYZ` (ej. "Estrella-AX"). Con 425 SKUs es perfectamente manejable.
2. **Umbrales cuantitativos explícitos por cuadrante** (ver propuesta en sección 6).
3. **5 triggers automáticos de reclasificación**: caída Buy Box >20 pp/7 días; aging >120 días; competidor agresivo con -10 % unit economics; crecimiento 3 meses +20 % MoM; margen bruto tras fees <15 % por 2 meses.
4. **Diferenciar strategy por cuadrante × ciclo de vida**: Intro+Crecimiento = penetration −15/−18 %; Maturity+Rentabilidad = testeo subidas +2–5 % cada 6–8 semanas.
5. **Long tail con premium monitoreado** (Israeli & Anderson HBS 2024): para los ~210 C-items, precio +10–20 % vs commodity, monitorizando solo al largest competitor, no hacer price exploration.

---

## 4.4 Integración pricing + publicidad + promociones

### Estado del arte

En la última década, pricing + ads + promos pasó de silos funcionales a **sistema unificado de profit optimization en tiempo real**. Amazon introdujo Sponsored Products (2012); TACoS emerge como métrica unificadora (2018–2020); Retail Media Networks consolidan (2022–24); IA/ML permite modelar elasticidad precio × ad-spend × LTV conjuntamente (2024–26). McKinsey reporta que retailers con dynamic pricing de 5 módulos logran **+2–5 % ventas y +5–10 % margen**. El KPI moderno es **CMAA = Precio − COGS − Fees − Ad Spend atribuible**.

### Fórmulas explícitas

**Break-even ACOS** = (P − COGS − Fees) / P = Margen bruto %

**Target ACOS** = Break-even ACOS − Profit margin deseado

**TACoS** = Ad Spend / Ventas totales (orgánicas + pagadas). TACoS decreciente con ventas crecientes = rank flywheel.

**Max CPC** = AOV × CVR × Target ACOS

Ejemplo: AOV $19, CVR 10 %, Target ACOS 30 % → Max CPC = $0,57.

### Benchmarks TACoS por fase del ciclo de vida

| Fase | TACoS objetivo | ACOS típico |
|---|---|---|
| Lanzamiento (0–3 meses) | 15–25 % | 40–100 % |
| Crecimiento (3–9 meses) | 10–15 % | 25–40 % |
| Madurez (9+ meses) | **5–10 %** | 15–25 % |
| Declive | 10–20 % | 20–30 % |

### Reglas de decisión precio ↔ ads

| Situación | Acción precio | Acción ads |
|---|---|---|
| ACOS real > Break-even y margen < target | **Subir precio +3–5 %** si elasticidad < 1 | Bajar bids 15–20 % |
| ACOS < Target y CVR > categoría | Mantener | **Subir bid +15–25 %** y escalar budget |
| Buy Box perdido | **Bajar precio −2–4 %** hasta recuperar | Pausar ads (gastando sin conversión) |
| Stock >90 días supply | **Bajar −8–15 %** (coupon preferido) | Subir ads 2–3× defensive |
| Stock <28 días | **Subir +5–10 %** (preserva rank) | **Bajar bids −30–50 %** |
| Competidor baja −10 % | NO matchear ciegamente; medir |ε| | Subir bid branded defensivo + bundle |

**Heurística de oro**: nunca subir precio para financiar más ads si la elasticidad cruzada precio-CVR es mayor que la elasticidad precio-tráfico.

### Playbook de eventos (Cyber, Hot Sale, Black Friday, Buen Fin)

| Días | Pricing | Ads | Compliance |
|---|---|---|---|
| **T-90** | Auditar margen; deal-price ≥20 % below lowest 30-day | Histórico CPC/CVR; keyword-seed list | Documentar baseline con screenshots |
| **T-60** | Modelar escenarios deep discount vs coupon + price cut | Pre-warming hero SKUs +10–15 % | **Congelar precios T-45** |
| **T-30** | Deal price definitivo; verificar Max Price | SP prospecting + DSP lookalike | Registro Buen Fin/CyberDay |
| **T-14** | Activar teasers; **no subir precio** | Escalar budget 3–5×; SB video | Cupones pre-aprobados |
| **T-0** | Monitoreo cada 15 min | **33 % del budget reservado 18:00–22:00** | Logs inmutables |
| **T+1 a T+7** | Evitar retornar precio original de golpe (30-day rule) | Retargeting DSP; pausar keywords ineficientes | Responder reclamos <48 h |

### Fechas clave LATAM

- **Hot Sale México** (mayo, AMVO): MX$34.539 M en 2024
- **Hot Sale Argentina** (mayo, CACE): AR$566 MM en 2025
- **CyberDay Chile** (junio, CCS): CL$470 B en 2024
- **Buen Fin México** (noviembre)
- **CyberMonday Chile** (octubre)
- **Black Friday Brasil** (último viernes noviembre)

### Cupones vs descuento directo vs bundles

| Táctica | Impacto Buy Box | Margen | Cuándo usar |
|---|---|---|---|
| **Descuento directo** | **Riesgo 30-day lowest rule** | Lineal | Liquidar stock; carreras short-term |
| **Cupón** | **Neutral — preserva baseline** | Igual al descuento + **fee $0,60/redención Amazon** | Proteger baseline; A/B test previo |
| **Prime Exclusive** | Neutral | Sin fee adicional | Prime Day sin canibalizar no-Prime |
| **Bundle** | ASIN distinto → Buy Box propio | +AOV 15–40 % | Defender price point; inmune a price wars |

Bajar precio permanentemente y luego subirlo es peligroso: **Amazon suprime Buy Box si current price > average 30-day**. Por eso los pros prefieren cupón para "test lower price" antes de comprometer baseline.

### Casos documentados de pre-pricing sancionado

| País | Caso | Sanción |
|---|---|---|
| **México Profeco** | Walmart y Liverpool Buen Fin 2019–21 | Base MX$3,5 M; multas hasta **MX$4,27 M** por publicidad engañosa (2024) |
| **México Profeco** | Buen Fin 2025 | 220 inconformidades, 205 conciliadas, MX$1,33 M devueltos |
| **Chile SERNAC** | CyberDay 2024: Hiper Líder, Falabella, París, Farmacias Ahumada | Precios inflados previo a descuento; investigación formal |
| **Chile SERNAC** | Demandas colectivas Falabella/Paris (pandemia) | Solicitud máx **5.760.900 UTM (~US$401 M)** para Paris |
| **Brasil Procon/CONAR** | "Metade do dobro" Black Friday | Multas variables + suspensión temporal |
| **UK CMA (DMCC Act 2024–25)** | 8 investigaciones abiertas incluyendo Wayfair UK | Fines hasta **10 % turnover global** |

**Defensa estándar**: congelar precios T-45 días antes del evento, documentarlo con screenshots, que el descuento publicitado se calcule sobre ese baseline congelado.

### 5 implicaciones accionables para BANVA (ACOS 3,9 %, GM 23 %)

1. **Redistribución agresiva de budget con gate de margen**. ACOS 3,9 % con GM 23 % sugiere fuerte sub-inversión: headroom probable de 10–20 pp de ACOS antes de break-even. Regla: ningún SKU con GM >35 % debe tener ACOS <15 % salvo commodity.
2. **Pre-playbook T-90 obligatorio** con tiering A/B/C (20 % hero → 70 % budget; 30 % mid → baseline; 50 % long-tail → auto-campaigns). Cupones en lugar de price cuts para hero SKUs.
3. **Migrar a CMAA como KPI maestro** (no ACOS). Alert: SKU con CMAA <8 % durante 60 días entra a revisión de portfolio pruning.
4. **Compliance defensiva LATAM**: congelar precios T-45, registro profeco.gob.mx/CCS Chile, alerta legal ante cambios >5 % en 30 días pre-evento, respuesta a reclamos <48 h.
5. **30–50 bundles** identificados en los 425 SKUs. Cada bundle = ASIN nuevo = Buy Box propio = inmune a price wars del SKU componente. Uplift AOV típico 15–40 %.

---

## 4.5 Métricas y KPIs de desempeño de pricing

### Estado del arte

Tres olas: (1) margen único (pre-2000, **Marn & Rosiello HBR 1992** introduce pocket price waterfall: leakage promedio **16,3 % del list**, total >40 %); (2) price realization + elasticidad (2000–2015, Simon, Nagle codifican "setting vs getting"); (3) stack multidimensional marketplace-native (2015+). Elasticidad mediana en bienes de consumo: **−2,62** (Bijmolt, van Heerde & Pieters, *JMR* 2005, meta-análisis de 367 elasticidades).

### Stack definitivo de KPIs

| KPI | Fórmula | Frecuencia | Benchmark | Modelo |
|---|---|---|---|---|
| Gross Margin % | (Net Rev − COGS) / Net Rev | Daily/Monthly | E-com promedio 41–45 %; textiles hogar 40–55 %; apparel 50–65 %; electrónica 15–30 % | Ambos |
| **Contribution Margin** | GM − ads − fulfillment − comisión − returns | Weekly | Wayfair Q4'25: **15,3 %** | Ambos |
| **Sell-through Rate** | Unidades vendidas / disponibles | Weekly/Monthly | **≥80 % excelente**, 60–80 % saludable | Ambos |
| Price Realization Index | Precio neto / Precio lista | Weekly/Monthly | >90 % strong; <80 % leakage severo; McKinsey promedio industrial 67 % | **Más en B** |
| Price Elasticity ε | (%ΔQ)/(%ΔP); log-log con IV o DoubleML | Quarterly | CPG −1,5 a −3,0; moda −1,0 a −2,0; electrónica −2,0 a −4,0 | Ambos |
| **Buy Box Win Rate** | % tiempo como Featured Offer | Daily | Private label **>95 %**; competido 60–80 %; hipercompetido 30–50 % | **Solo A** |
| Price Competitiveness Index | Precio propio / mediana competidores | Daily | FBA paridad 0,98–1,02; FBM 0,80–0,85 | Ambos |
| AOV | Revenue / Órdenes | Weekly | Chewy FY25 US$591/año por cliente activo; Wayfair Q4'24 US$290 | Ambos |
| Cart Abandonment | 1 − Órdenes/Carts | Daily | **70,19 % promedio global** (Baymard); 48 % por extra costs | Ambos |
| Margin Leakage | Σ waterfall list → pocket | Monthly/Quarterly | McKinsey: off-invoice 16,3 %; total >40 % | Ambos |
| TACoS | Ad Spend total / Revenue total | Weekly | Amazon típico 8–15 %; top sellers <10 % | Principalmente A |

### A/B testing en marketplaces: factibilidad real

**Amazon**: Manage Your Experiments (MYE) permite A/B de título, imágenes, bullets, A+ Content — **NUNCA precio**. Mismo SKU no puede exhibir dos precios simultáneos.

**MercadoLibre**: plataforma corre ABT internamente (Ciruzzi 2020, Amplitude), pero sellers no tienen herramienta nativa de split de precio.

**Shopify/DTC (Modelo B)**: A/B de precio factible vía Pricing.AI, Intelligems, Dexter, o geo-split por ZIP/DMA.

### Alternativas cuasi-experimentales

| Método | Cuándo | Sample mínimo |
|---|---|---|
| Pre/post con control | Cambio en 1 SKU con similares como control | ≥4 semanas pre + 4 post; ≥200 órdenes/periodo |
| Difference-in-differences | Varios SKUs tratados vs no en misma ventana | ≥30 SKUs/grupo; parallel trends |
| **Synthetic control / CausalImpact** | **Un SKU único sin control natural** | **≥12 semanas pre-treatment** |
| Geo-split / GeoLift | Tráfico >10k/semana en regiones | ≥10 DMAs por brazo |
| Double/Debiased ML | Elasticidad con muchos controles | ≥10.000 obs SKU-día |

**Caso Airbnb**: Ye et al. (KDD 2018) validaron sistema de 3 capas con A/B online. **Wayfair**: geo-experiments con 210 DMAs US.

### Benchmarks por vertical

| Vertical | Gross Margin | Sell-through mensual | Return rate | Cart abandonment |
|---|---|---|---|---|
| **Textiles hogar** | **40–55 %** | 60–75 % | 8–15 % | ~70 % |
| Muebles hogar grande | ~30 % (Wayfair 30,2 %) | 40–60 % | 10–20 % | 72–80 % |
| Moda / apparel | 50–65 % | 65–70 % | **25–40 %** | 65–70 % |
| Electrónica | 15–30 % | 50–60 % | 5–12 % | 68–72 % |
| Beauty | 60–80 % | 70–85 % | 3–8 % | 65–70 % |
| Pet supplies (Chewy) | 29,8 % | Autoship 83,3 % | 2–5 % | 60–65 % |
| **Amazon FBA típico** | 25–35 % GM; **15–25 % net margin** | N/A | 5–15 % | N/A |

### Dashboards por cadencia

**Daily (Modelo A)**: Buy Box Win Rate top 20 ASINs; stockout list; competitor price drops; ACOS spikes; Account Health (ODR <1 %, LSR <4 %, VTR ≥95 %).

**Weekly**: GM por categoría WoW; velocity change; competitor price moves; CMAA por SKU post-ads post-fulfillment; sell-through por cohorte.

**Monthly**: P&L completo con waterfall; elasticity refresh; segment mix (Wayfair reporta Active Customers, Repeat %, Contribution Margin); cohort LTV vs CAC.

### Diferencias A vs B

| Dimensión | Modelo A | Modelo B |
|---|---|---|
| Buy Box Win Rate | **KPI central** | No existe |
| Price Realization Index | Poco usado | **KPI central** |
| A/B test nativo | No disponible | Disponible |
| Contribution margin drivers | Ads, comisión, FBA, returns | Shipping, fulfillment, attribution, inventory |

### 5 implicaciones accionables para BANVA

1. **Migrar de Gross Margin a Contribution Margin SKU** como KPI operativo semanal. Con GM 23 %, probablemente 15–25 % de los 425 SKUs están en CMAA negativo.
2. **Segmentación ABC con frecuencias diferenciadas**: top 20–40 SKUs daily; tier 2 (~100) weekly; long-tail (~300) monthly con alerts automáticas.
3. **Programa estructurado pre/post con synthetic control**: 10–15 SKUs/cuatrimestre, ±5–10 % precio en 4 semanas, pre-period ≥8 semanas, usar CausalImpact.
4. **Price Waterfall mensual** para forzar disciplina de discounting. Con ACOS 3,9 % el leak no es ads: probable (a) fees ML mal optimizadas, (b) returns no charged back, (c) cupones auto-applied.
5. **Buy Box Win Rate por tier como KPI de compensación**. Target >95 % SKUs propios/exclusivos, >70 % competidos. Drop de 50→40 % causa −20 % unidades vendidas.

---

## 5. Casos de estudio profundos

### 5.1 Wayfair (Modelo B) — Pricing algorítmico omnicanal a escala

**Perfil**: fundada 2002 como CSN Stores; IPO 2014 a US$2,4 B. Catálogo >30 M SKUs, ~20 k suppliers drop-ship. Revenue 2024 US$11,85 B (-1,3 % YoY, 4º año de declive); 2025 US$12,46 B (+5,1 %, primer crecimiento tras 4 años). 21,4 M customers activos (peak 31,2 M en 2020). Headcount 12.600 post-3 rondas de layoffs (-4.270 empleados 2022–24). GM 30,2 %, Contribution Margin 15,3 % (Q4'25).

**Diagrama organizacional pricing**:
```
CEO Niraj Shah
 └─ CTO Fiona Tan
     └─ Data Science Org (~80 teams, >100 DS a 2021)
         ├─ Pricing, Profitability & Forecasting Algorithms (~20 econ+ML)
         │   Head: Andrea Guglielmo (Associate Director)
         │   Mandate: "pricing algorithms for 10+ million products,
         │             ~$10 B de GMV en 2023"
         │   ├─ Demand Estimation & Price Elasticity
         │   ├─ Competitive Price Index
         │   ├─ Cost / Profitability Forecasting
         │   └─ New Product Success Prediction
 └─ Commercial / Category
     └─ Profit Management & Pricing (business-side, NO algorítmico)
```
**Ratio FTE / SKUs**: 1 : 1,5 M. Es imposible sin automatización; todo SKU vivo está bajo algoritmo.

**Timeline**:
- 2002: fundación CSN Stores
- 2011: rebrand Wayfair + $165 M Series A
- 2013: primer indicio público de pricing algorítmico ("terabytes of data, millions of products")
- 2014: IPO
- 2015: lanza CastleGate (fulfillment propio big-and-bulky); conversión 2× vs drop-ship
- 2016: Niraj fija meta "**unlock 1.000 bps de GM**" (de 24–25 % a 34–35 %)
- 2019: Lin Jia publica explainer sobre price effects / causal inference
- 2020: boom COVID (+55 %, US$14,1 B); 31,2 M active; incidente QAnon (armarios a US$12–14 k con nombres humanos — artefacto de long-tail pricing automatizado sin guardrails de sanity check)
- Oct-2022: migración completa a Google Cloud Platform
- 2022–24: 3 rondas de layoffs (870+1.750+1.650 = 4.270 empleados); pérdida $2,8 B acumulada 2021–2024
- 2025: meta 1.000 bps **alcanzada** (GM 30,2 %)

**Stack tecnológico**: Kafka + Flink para clickstream; Vertex AI Feature Store + BigQuery; modelos propios de fully-loaded COGS, demand forecasting, elasticidad y markup LP solver; Vertex AI Pipelines + Airflow; microservicios GKE; Looker con >500 k tablas; experimentation: Gemini (A/B marketing), Demeter (delayed reward forecasting), WASP (simulador algorítmico), geo-experiments 210 DMAs.

**Decisiones contraintuitivas**:
1. **Sobre-inversión CastleGate 2020–22**: FCF 2022 = −US$1,13 B. Niraj (memo jan-24): *"I think the reality is that we went overboard in hiring during a strong economic period."*
2. **Estrategia deliberada de GM bajo (~30 %) vs Amazon (~45 %)**: el algoritmo busca price-inelasticity por SKU, no maximiza GM global; prioriza conversion (CastleGate discount) para mover a repeat (79 % repeat rate Q4-24). LTM revenue per active customer: $448 (2019) → $553 (2022) → ~$560 (2024), +24 % en 5 años mientras bajaba -32 % el número de clientes.
3. **Incidente QAnon**: armarios automáticamente precios-por-COGS incluyendo shipping de armarios industriales, sin sanity-cap ni lista bloqueada de nombres → backlash reputacional.

**Lecciones transferibles a 425 SKUs**:
- **SÍ transferibles**: fully-loaded COGS por SKU (no wholesale cost); margin profile customizado por cluster; **velocidad de entrega como palanca superior al precio** (CastleGate 2× conversión); guardrails anti-outliers (max 5× mediana categoría); ad payback window explícito por canal.
- **NO transferibles**: 20 ML scientists (ROI negativo), Kafka/Flink real-time (overkill), Vertex AI Feature Store (BigQuery + dbt basta), experimentation platform custom (GrowthBook/Optimizely), pricing totalmente automático (humano en el loop para 425 SKUs).

**Lección macro financiera**: GM 30 % + ad spend 12 % + opex 25 % = loss-making. Para seller LATAM, la estructura sana es **GM ≥35 %, ad spend ≤10 %, opex ≤15 %**.

### 5.2 Casper Sleep (Modelo B) — Caso de fracaso por mal pricing + ads

**Perfil**: fundada abril 2014 (Krim, Parikh, Foss, Chapin, Flateman); IPO feb 2020 @ US$12 (rebajado de US$17–19); privatizada ene 2022 por Durational Capital @ US$6,90/sh, equity value ~US$286 M vs US$1,1 B última ronda privada.

**Diagrama organizacional (reconstruido)**:
```
CEO (Krim 2014→nov-21 → Arel nov-21→)
 ├─ CFO → FP&A → Pricing Analytics (unit economics)
 ├─ Chief Commercial Officer (Emilie Arel, ex Quidsi/Gap/Target)
 │   ├─ VP Retail Partnerships (wholesale, MAP enforcement)
 │   ├─ VP E-commerce (pricing D2C + Amazon)
 │   ├─ VP Retail Stores (72 Sleep Shops)
 │   └─ Merchandising
 ├─ COO / Supply Chain (COGS, GM)
 └─ CMO / Brand (ad budget US$146–157 M/año)
```
**Observación crítica**: Casper **nunca tuvo un Head of Pricing** documentado. Pricing se gestionaba en Commercial + Finance + Marketing en paralelo sin dueño único → desalineamiento entre canales.

**Unit economics 2016–2021**:

| Métrica | 2017 | 2018 | 2019 | 2020 |
|---|---|---|---|---|
| Net revenue (US$ M) | 250,9 | 357,9 | 439,3 | 497 |
| GM % | ~47 | 44,1 | 49,0 | 51,1 |
| S&M % revenue | **43** | **35** | **35** | **31,5** |
| Net loss (US$ M) | (73,4) | (92,1) | (89,6) | (89,6) |
| AOV e-commerce | $583 | $686 | $710 | $710 |
| LTV/CAC | — | — | **1,4×** | — |
| % revenue D2C | ~92 | ~85 | ~78 | **73** |
| Retail partners | 3 | 8 | 18 | 20+ |

**Errores documentados**:
1. **US$422,8 M en marketing en 45 meses = 41 % del revenue acumulado** (benchmark retail 10–12 %; Kohl's 4,9 %, Under Armour 10,5 %). Unit economics brutos: por cada orden de US$750 AOV, ad spend $285, otros S&M $17 → perdía dinero operativo cada venta.
2. **Canibalización de precio Amazon vs D2C**: Wave Queen US$2.595 en casper.com vs US$2.155 en Amazon = **17 % por debajo de MAP D2C**. 27 % del revenue se iba a canal wholesale con ~50 % del margen.
3. **Rechazó oferta Target por US$1 B en 2017**; aceptó US$75 M + distribución. Privatizada 5 años después por **3,5× menos** (US$286 M).

**Contraste Brooklinen**: ~20–30 SKUs core (Classic Core Sheet Set US$99–169 vs Threshold de Target ~US$40 = **4× premium**). Julio 2020: carta firmada por fundadores subiendo 10 % explicando costos. Sigue privada, revenue "well into nine figures" (2023).

**Lecciones transferibles a BANVA**:
1. Un **dueño único de pricing** con accountability end-to-end. Casper demuestra el costo de no tenerlo.
2. **MAP + SKU differentiation por canal** ("name game" de Tempur/Sealy/Serta): desarrollar "canal packs" exclusivos aunque las diferencias sean mínimas (empaque, certificación, garantía).
3. **LTV/CAC > 3×** es la regla D2C sana; <1,5× no sobrevive.
4. **Cap duro en ad spend % revenue ≤15–20 %** en categoría madura.
5. **Assortment focus > breadth**: Brooklinen $100 M+ con 20–30 SKUs core vs Casper 150+ → menos es más.

### 5.3 Anker Innovations (Modelo A) — Marketplace-seller puro escalado con marca

**Perfil**: fundada oct 2011 por Steven Yang (ex-Google) en Shenzhen; IPO ago 2020 en ChiNext (300866.SZ) a RMB 66,32; día 1 +109 %. Revenue 2024 RMB 24,71 B (~US$3,43 B, +41 %). 3.615 empleados (~50 % R&D). En 2016 **~80 % revenue era Amazon**; en 2021 bajó a **54 %**.

**Números duros**:

| Año | Revenue US$ | GM % | % Amazon | # SKUs | # Marcas |
|---|---|---|---|---|---|
| 2017 | ~570 M | **52,0** | ~75–78 | ~1.200–1.500 | 4 |
| 2019 | ~965 M | **50,0** | ~65 | ~1.800–2.000 | 5 |
| 2021 | ~1,89 B | 35,7 | **54** | >2.000 | 5+ |
| 2024 | ~3,43 B | 43,7 | ~40 | >2.000 | 7 |

**Diagrama organizacional**:
```
Steven Yang (CEO, 74,44 % stake)
 ├─ Dongping Zhao (President)
 ├─ Shaun Xiong (SOLIX/Channel)
 └─ 5 BUs → 27 product lines bajo ellas:
     ├─ Charging (Anker)         ├─ Audio (Soundcore)
     ├─ Smart Home (Eufy)        ├─ Proyectores (Nebula)
     └─ Emerging (SOLIX, AnkerMake, eufyMake)
Cada BU: Product Mgmt + R&D + Supply Chain + Category Ops (incluye Pricing + Ads + Listing) + Brand
Transversal: FP&A central, Voice-of-Customer, Global Marketing
```
**Pricing distribuido, no centralizado**: Category Ops dentro de cada product line; layer central de FP&A consolida. VoC team (>300 agentes globales, >10k tickets/día) alimenta pricing y R&D.

**Decisiones contraintuitivas**:
1. **Premium pricing deliberado en commodities** (2014–2018): PowerCore 10.000 se vendía US$25–40 vs genéricos US$10–15. GM 52 % (2017) vs commodity electronics ~30–35 %. Moat de reviews acumulados (PowerCore fue #1 bestseller 90 % del tiempo en 2018–20).
2. **Multi-marca como segmentación de pricing**: 4 price ladders paralelos sin canibalización (Anker mid-premium, Soundcore value-to-mid, Eufy premium, Nebula premium). Dentro de Anker, **arquitectura Series 3/5/7** codifica tier explícitamente para el consumidor.
3. **"Shallow Waters Strategy"**: Yang tolera pérdidas ~RMB 2–3 B/año en nuevas líneas mientras NPM corporativo >5 %. Energy storage perdió ~US$900 M en 3 años antes de ser rentable en 2025.
4. **Compliance temprano**: en 2016 abandonó Power User Program cuando Amazon cambió política sobre incentivized reviews. En 2021 **no fue suspendida en la purga china** (50.000+ sellers incluyendo Aukey, Mpow, VicTsing sí lo fueron).

**Lecciones transferibles a BANVA**:
1. **NO pelear por precio más bajo si hay diferenciación tangible**. Audit: retirar o reprecir el bottom 20–30 % sin justificación documentada de premium.
2. **Good-Better-Best + naming convention** (Series 3/5/7): colapsar 425 SKUs en grid de 3 tiers × 6–10 subcategorías.
3. **Brand-splitting anticipado** antes de llegar a 2.000 SKUs (Anker lo hizo a US$100–150 M con Soundcore).
4. **VoC institucionalizado**: Helium10/SellerApp + GPT para agregar sentiment weekly.
5. **ACOS por tier**, no plano: Series 3 (value) ACOS bajo 5–10 %; Series 7 (premium/new) ACOS alto 30–50 % durante launch.
6. **Diversificar canales ANTES de que toque**: Anker empezó offline (Walmart 2015) cuando era 85 % Amazon.

### 5.4 Top seller MercadoLibre LATAM (Modelo A) — Caso compuesto

**Admisión de gap**: no existe un caso público profundo de un seller argentino/chileno específico con números duros consolidados. Nubimetrics publica solo 6 casos cualitativos; MELI Centro de Vendedores da quotes cortos; los top sellers no hacen disclosure público. Se entrega un **caso compuesto** validado con Nubimetrics, MELI Developers y Real Trends.

**Perfil arquetípico "MercadoLíder Platinum LATAM"**:

| Dimensión | Rango típico |
|---|---|
| Ventas 60 días (Chile) | ≥415 |
| Facturación 60 días Argentina | ≥ARS 1.300.000 |
| Antigüedad mínima | ≥4 meses (3 en MX) |
| Reputación | Zona verde ≥60 días consecutivos |
| Catálogo típico | 200–5.000 SKUs (Tienda Newsan opera >3.000 entre 4 marcas) |
| % Full | 40–80 % del SKU mix |

**Diagrama inferido**:
```
CEO → E-commerce Manager
  ├─ Pricing/Category Analyst (1-2): Nubimetrics + Real Trends + repricer oficial MELI
  ├─ Publicador/Catalog Ops (1-3)
  ├─ Atención/Preguntas 24/7 (2-5): 60 % llegan fuera de horario (Ventiapp 2025)
  ├─ MercadoAds Specialist (1, a veces agencia Platinum)
  └─ Logística/Full Planner
```

**Timeline evolución pricing ops (compuesto)**:
- Fase 1 (año 0–1): intuición, Excel + panel MELI
- Fase 2 (año 1–2): reacción manual semanal
- Fase 3 (año 2–3): Nubimetrics/Real Trends (USD 40–100/mes)
- Fase 4 (año 3–4): activan Ajuste Automático oficial MELI con piso/techo por SKU
- Fase 5 (año 4+): orquestación multi-herramienta (AnyMarket/UpSeller + ERP)

**Stack típico**: ERP (Contabilium/Defontana) + **Nubimetrics** (inteligencia mercado) + **Real Trends** (publicador, preguntas IA) + **Repricer oficial MELI** ("Ajuste Automático", estrategia "Precio para ganar" o "Mejor precio incluye Google") + hub multicanal (AnyMarket/UpSeller) + Mercado Ads.

**Decisiones contraintuitivas documentadas**:
1. **Salir de productos commoditizados aunque vendan** (Neurolab/Nubimetrics): el margen cae más rápido que el volumen.
2. **Activar repricer oficial MELI antes que externos**: uplift reportado **+37 %** condicional a usar SU herramienta; ítems con automatización nativa reciben etiqueta "Recomendado".
3. **NO bajar del precio mínimo aunque pierdas Buy Box**: mejor perder publicación ganadora 3 días que erosionar margen estructural.
4. **Newsan multi-marca en una sola Tienda Oficial**: concentra reputación y Full aggregate, aunque diluye branding.

**Dato técnico crítico**: desde **18 marzo 2026**, MELI bloquea edición de precio vía API para ítems con Automatización activa. Forzará a los sellers a elegir.

**Lecciones transferibles a BANVA**:
1. 425 SKUs está en el punto dulce Platinum; invertir USD 80–100/mes en Nubimetrics.
2. **Full en Chile casi gratis** (tarifas exentas hasta nuevo aviso): maximizar Full en textiles rotación alta.
3. Activar **repricer oficial MELI** antes que externos; estrategia "Precio para ganar en MELI" para textiles hogar.
4. Definir pisos por SKU (no por categoría).
5. Atender gap 24/7 de preguntas (IA de Real Trends o turno extendido).
6. Jaguar Sheet (gratis) para monitoreo Buy Box catálogo por SKU.
7. NO "Acordar con comprador" (penalización severa de ranking).

---

## 6. Matriz de transferibilidad aterrizada a BANVA

**Perfil BANVA (recordatorio)**: fundador Vicente Elias (Master Finanzas UAI); ~345 publicaciones / ~425 SKUs; marcas BANVA Home y American Family (textiles hogar); MercadoLibre Chile; modelo híbrido Full + Flex; facturación ~CLP $60 M netos/mes (~US$65 k/mes, ~US$780 k/año); margen bruto ~23 %; ACOS global 3,9 %; stack Bodega WMS custom (Next.js 14 + Supabase); matriz Estrella/Crecimiento/Rentabilidad/Dudoso; semáforo semanal de SKUs.

### 6.1 Aplica tal cual (copiar la práctica)

| Práctica | Por qué aplica directamente a BANVA | Acción concreta |
|---|---|---|
| **Activar repricer oficial MELI en "Ajuste Automático"** | BANVA ya opera MELI Chile; uplift +37 % es condicional a SU herramienta (MELI oficial 2025) | Este trimestre: activar en los ~85 SKUs del cuadrante Estrella con estrategia "Precio para ganar en MELI"; pisos por SKU ≥ COGS + fees + Full + 8 % margen mínimo |
| **Cadencia Amazon-style WBR semanal (60 min martes)** | Bain documenta lift 10–25 % revenue en 6 meses; BANVA ya tiene semáforo semanal — formalizar con agenda fija | Fundador + futuro Pricing Analyst + Ads owner + Ops: Buy Box top 50 SKUs, competitor gaps, SKUs que movieron >10 %, anomalías ACOS |
| **Floor de repricer con 5 componentes explícitos** | Ningún caso estudiado opera sin floor cuantitativo; BANVA con GM 23 % está demasiado apretado para errores | Fórmula: `floor = COGS + fee_ML_categoría + costo_Full_si_aplica + IVA_no_recuperable + margen_objetivo_8%` hardcoded en el WMS |
| **Congelar precios T-45 días antes de CyberDay Chile y Cyber Monday** | SERNAC documentó casos 2024 (Hiper Líder, Falabella, Paris, Farmacias Ahumada); demandas colectivas hasta 5,76 M UTM | Integrar en WMS lock automático de precio en SKUs marcados como "evento" + screenshots inmutables |
| **Baymard: 48 % de abandonos son por extra costs** | BANVA tiene shipping visible (Flex) y Full; no puede esconderlos | Auditar páginas de producto y transparentar costo final desde el primer paso |
| **Cupones en lugar de price cuts para hero SKUs durante eventos** | Evita 30-day lowest rule y Buy Box suppression post-evento | En próximos CyberDay/CyberMonday/Black Friday: cupón en top 30 SKUs del cuadrante Estrella, NO price cut directo |
| **Monitorear `price_to_win` de MELI Developers en lugar de scraping** | API oficial expone `winning/sharing_first/losing/listed`; scraping es frágil | Integrar endpoint en el Bodega WMS (Supabase cron cada 4 h para tier A; diario tier B) |
| **Respuesta a preguntas MELI <2 h (60 % llegan fuera de horario)** | Requisito implícito para Platinum y Buy Box | IA de Real Trends o turno extendido; es piso, no optativo |

### 6.2 Aplica con adaptación (cómo)

| Práctica estándar | Por qué requiere adaptación | Adaptación específica para BANVA |
|---|---|---|
| **Contratar 1 Pricing Analyst dedicado** | Benchmark Simon-Kucher sugiere 0,5–1 FTE por US$30–200 M. BANVA está en ~US$780 k/año anual; un FTE full-time es caro | **Un part-time nearshore LATAM** (Argentina/Colombia) a US$600–1.200/mes, 20 h/semana, específicamente dedicado a pricing + Nubimetrics. O Vicente absorbe el rol con 20 % de su tiempo hasta superar ~US$1,5 M anual |
| **Matriz BANVA (Estrella/Crecimiento/Rentabilidad/Dudoso)** | Es BCG re-etiquetada; carece de eje de elasticidad, ciclo de vida y umbrales cuantitativos | Enriquecer con sub-tags `BANVA-Quadrant / ABC / XYZ / CicloVida` (ej. "Estrella-AX-Madurez"). Operativo en 425 SKUs. Define umbrales numéricos: Estrella = GM ≥30 %, crec YoY ≥15 %, STR ≥70 %; Dudoso = GM <20 %, crec <−10 %, STR <30 % |
| **Dynamic pricing ML-based (Wayfair)** | 20 ML scientists + Vertex AI es ROI negativo para 425 SKUs | Reglas determinísticas ricas en el WMS Next.js: cada SKU con `(floor, target, ceiling, elasticidad_estimada, acos_target)`. No ML todavía; cuando facture >US$3 M y Nubimetrics + historial de 24 meses lo justifiquen |
| **KPI central = Contribution Margin After Ads (CMAA)** | GM 23 % esconde el verdadero estado; BANVA necesita medición SKU-level post-fees MELI-Full-ads | Construir un `price waterfall` mensual en Supabase: Revenue → fees_ML (13–19 % categoría) → Full_if_applies → ads_atribuibles → returns → CMAA %. Flag SKUs con CMAA <8 % durante 60 días |
| **Governance thresholds Salesforce-style** | BANVA no tiene descuentos por rep (no B2B); adaptar a algoritmo-vs-humano | Playbook de 1 página: algoritmo puede cambiar ±10 % sin aprobación si CMAA ≥12 %; 10–25 % revisa el Pricing Analyst en <4 h; ≥25 % o floor breach requiere Vicente vía Slack `#pricing-exceptions` |
| **A/B testing de precio con synthetic control (CausalImpact)** | Requiere ≥200 unidades/mes por SKU; tier A de BANVA probablemente cumple, tier B no | Solo sobre los ~30 SKUs más vendidos: cambios ±5–10 % en ventanas 4 semanas con pre-period ≥8 semanas, evaluados contra SKUs control de misma subcategoría |
| **Arquitectura Good-Better-Best (Anker Series 3/5/7)** | BANVA tiene 2 marcas (BANVA Home, American Family) — ya es un inicio de segmentación | Colapsar 425 SKUs en grid 3 tiers × subcategorías (sábanas, quilts, almohadas, protectores, toallas). Ej: `Toalla Básica` / `Toalla Premium` / `Toalla Signature` con price ladder deliberado y naming explícito en títulos |
| **Presupuestar SKUs de inversión estratégica con pérdida tolerada** | Anker tolera pérdidas mientras NPM >5 %; BANVA con margen 23 % tiene menos colchón | Cap **máximo 10 % del catálogo (~40 SKUs)** como "investment tier" con ACOS >30 % o pricing agresivo durante 6–12 meses, siempre que el resto del portfolio mantenga CMAA blended ≥10 % |
| **Bundles como Buy Box shield** | Wayfair y Anker usan bundles para escapar competencia comoditizada | Crear 20–30 bundles textil-hogar: set cama king (sábana + funda + protector + almohadas); kit baño (toallas × 3 + piso). Cada bundle = publicación nueva MELI = publicación ganadora propia |
| **Subir precio para capturar headroom de ACOS** | ACOS 3,9 % con GM 23 % sugiere sub-inversión; pero subir precio arriesga Buy Box si hay competencia catalogada | NO subir precio transversalmente. Identificar los ~80 SKUs con elasticidad baja (demanda estable últimos 6 meses sin cambio de precio) y probar +3–5 % solo ahí, con monitoreo diario de `price_to_win`. Inyectar el "ahorro" en ACOS subiendo bids de esos mismos SKUs hasta 15–20 % |

### 6.3 No aplica (por qué)

| Práctica | Por qué NO aplica a BANVA |
|---|---|
| **Head of Pricing senior / equipo dedicado de 5–15 FTE** | Tamaño insuficiente. Umbral razonable: >US$10 M anuales o >2.000 SKUs |
| **Revenue Manager origen airlines/hospitality** | BANVA no tiene inventario perecedero ni capacidad fija. ROI negativo bajo US$100 M |
| **Kafka + Flink + Vertex AI Feature Store** | Overhead injustificable para 425 SKUs; Supabase + cron + dbt cubre el 95 % |
| **Geo-experiments 210 DMAs al estilo Wayfair** | Chile es un solo país chico; no hay granularidad geo suficiente para GeoLift válido |
| **Dedicado Category Manager por subcategoría** (Chewy tiene 91) | Escala insuficiente; un single E-commerce Manager cubre el mapa |
| **DSP Amazon (Demand-Side Platform)** | BANVA no está en Amazon; no aplica. Mercado Ads Display es el equivalente |
| **Reestructuración multi-canal agresiva D2C + físico (Casper)** | BANVA es marketplace-seller profitable; lección es NO replicar la cara cara de Casper (canibalización, destrucción de margen wholesale) hasta validar con claridad LTV/CAC por canal |
| **MAP policy enforcement cross-retailer** | BANVA no tiene ecosistema de retailers; es single-channel MELI. Si más adelante abre Falabella.com o tienda propia, se revisita |
| **Amazon Marketing Cloud (AMC) attribution** | No aplica; BANVA no está en Amazon |
| **A/B native test de precio (Shopify apps Intelligems/Dexter)** | Requiere site propio con tráfico significativo; BANVA opera en MELI que no lo permite |
| **Contratar Pricing Manager senior US$140–190 k** | Costo-beneficio inexistente a escala actual; se aburrirá sin equipo que dirigir |

### 6.4 Roadmap priorizado 12 meses

**Mes 1–2 (quick wins, bajo esfuerzo):**
- Activar repricer oficial MELI en 85 SKUs cuadrante Estrella con piso cuantitativo.
- Formalizar WBR martes 9 am; construir el dashboard en Supabase/Metabase.
- Playbook de governance de 1 página con umbrales explícitos.

**Mes 3–4 (estructural, medio esfuerzo):**
- Contratar Pricing Analyst part-time nearshore US$800/mes.
- Implementar CMAA por SKU en WMS (fórmula waterfall mensual).
- Enriquecer matriz BANVA con sub-tags ABC-XYZ + ciclo de vida.

**Mes 5–7:**
- Contratar Nubimetrics (~US$80/mes) + Real Trends Chile.
- Lanzar 20 bundles de textil hogar en MELI.
- Programa synthetic control A/B en 15 SKUs/trimestre.

**Mes 8–12:**
- Arquitectura Good-Better-Best en todo el catálogo textil hogar.
- Pre-playbook T-90 para CyberDay 2026 y CyberMonday Chile 2026.
- Evaluar apertura de Falabella.com como segundo canal (con diferenciación SKU "name game").
- Revisar KPI ACOS: subir target a 10–15 % blended con validación de lift en ventas totales.

**Gate de revisión fin de año 1**: si facturación mensual pasa CLP $90 M y margen CMAA blended ≥10 %, iniciar evaluación de Pricing Analyst full-time y considerar D2C con Shopify para línea premium.

---

## 7. Anexo de fuentes verificables

### Papers académicos primarios
- Chen, L., Mislove, A., Wilson, C. (2016). *An Empirical Analysis of Algorithmic Pricing on Amazon Marketplace*. WWW'16. https://mislove.org/publications/Amazon-WWW.pdf
- Calvano, E., Calzolari, G., Denicolò, V., Pastorello, S. (2020). *AI, Algorithmic Pricing, and Collusion*. AER 110(10). https://www.aeaweb.org/articles?id=10.1257/aer.20190623
- Assad, Clark, Ershov, Xu (2024). *Algorithmic Pricing and Competition: German Retail Gasoline*. JPE 132(3):723–771.
- Hansen, Misra, Pai (2021). *Algorithmic Collusion: Supra-competitive Prices via Independent Algorithms*. CEPR DP 14372.
- Bijmolt, van Heerde, Pieters (2005). *New empirical generalizations on the determinants of price elasticity*. JMR.
- Spann, Fischer, Tellis (2015). *Skimming or Penetration? Strategic Dynamic Pricing for New Products*. Marketing Science.
- Israeli & Anderson (2024). *Adjusting Prices in the Long-tail*. HBS WP. https://pubwww.hbs.edu/faculty/Pages/item.aspx?num=63163
- Brynjolfsson, Hu, Smith (2003). *The Longer Tail: Amazon's Sales Distribution*. MIT.
- Ye et al. (2018). *Customized Regression Model for Airbnb Dynamic Pricing*. KDD 2018.
- Marn & Rosiello (1992). *Managing Price, Gaining Profit*. HBR.
- Arkhangelsky et al. (2021). *Synthetic Difference-in-Differences*. AER.
- Liu et al. (2021). *Elasticity Based Demand Forecasting and Price Optimization for Online Retail*. arXiv 2106.08274.
- Abramowicz & Stucke (2022). *Dynamic Pricing Algorithms, Consumer Harm, and Regulatory Response*. HBS WP 22-050.

### Documentación oficial de plataformas
- Amazon Automate Pricing: https://sell.amazon.com/tools/automate-pricing
- MercadoLibre Developers — Catalog competition: https://developers.mercadolibre.com.ar/en_us/catalog-competition
- MercadoLibre — Automatizaciones de precios: https://developers.mercadolibre.com.ar/esa/automatizaciones-de-precios
- Mercado Libre — Product Ads Bidding: https://global-selling.mercadolibre.com/learning-center/news/how-the-product-ads-bidding-system-works
- Vendedores MELI Chile — Ajuste Automático: https://vendedores.mercadolibre.cl/nota/vende-mas-con-ajustes-automaticos-de-precio

### Casos de repricing mal calibrado
- Eisen (2011). Amazon's $23,698,655.93 book: https://www.michaeleisen.org/blog/?p=358
- AIAAIC — Amazon penny glitch RepricerExpress Dec 2014: https://www.aiaaic.org/aiaaic-repository/ai-algorithmic-and-automation-incidents/amazon-automated-pricing-glitch
- The Guardian 14-dic-2014: https://www.theguardian.com/money/2014/dec/14/amazon-glitch-prices-penny-repricerexpress

### Consultoras y reportes de industria
- McKinsey — Four ways to achieve pricing excellence in retail marketplaces (2022): https://www.mckinsey.com/capabilities/growth-marketing-and-sales/our-insights/four-ways-to-achieve-pricing-excellence-in-retail-marketplaces
- McKinsey — Dynamic pricing: https://www.mckinsey.com/industries/retail/our-insights/how-retailers-can-drive-profitable-growth-through-dynamic-pricing
- Bain — Dynamic Pricing: https://www.bain.com/how-we-help/retailers-are-you-getting-the-full-value-of-your-dynamic-pricing-strategy/
- Simon-Kucher — Global Pricing Study 2025: https://www.simon-kucher.com/en/insights/global-pricing-study-2025
- Simon-Kucher — Setting up a pricing organization: https://www.simon-kucher.com/en/insights/setting-pricing-organization-do-you-have-effective-pricing-team
- PPS Dec 2023 Survey: https://publications.pricingsociety.com/pps-december-2023-survey-of-todays-pricing-professional/
- Marketplace Pulse Seller Index 2026: https://www.marketplacepulse.com/reports/seller-index
- Modern Retail — Amazon Seller Count (abr 2026): https://www.modernretail.co/operations/marketplace-briefing-amazons-seller-count-falls-as-revenue-concentrates-among-top-sellers/
- Jungle Scout State of the Amazon Seller 2025: https://www.junglescout.com/resources/reports/amazon-seller-report-2025/

### Casos Wayfair
- Wayfair Q4/FY 2024: https://investor.wayfair.com/news/news-details/2025/Wayfair-Announces-Fourth-Quarter-and-Full-Year-2024-Results/default.aspx
- Wayfair Tech Blog — Geo Experiments: https://www.aboutwayfair.com/careers/tech-blog/how-wayfair-uses-geo-experiments-to-measure-incrementality
- Wayfair Tech Blog — Lin Jia Price Effects: https://www.aboutwayfair.com/data-science/2019/09/wayfair-ds-explains-it-all-lin-jia-on-measuring-price-effects/
- Google Cloud — Wayfair Vertex AI: https://cloud.google.com/blog/products/ai-machine-learning/wayfair-accelerating-mlops-to-power-great-experiences-at-scale
- In Practise — Wayfair Pricing Strategy (feb 2022): https://inpractise.com/articles/wayfairs-pricing-strategy-and-mature-gross-margin
- MacroTrends Wayfair: https://www.macrotrends.net/stocks/charts/W/wayfair/revenue

### Casos Casper / Brooklinen
- Casper S-1 (ene 2020): https://www.sec.gov/Archives/edgar/data/1598674/000104746920000166/a2240404zs-1.htm
- Casper 10-K 2019: https://www.sec.gov/Archives/edgar/data/1598674/000104746920001618/a2241047z10-k.htm
- Justine Moore — Four things to learn from Casper's S-1: https://medium.com/@justinemoore_85088/four-things-to-learn-about-d2c-economics-from-caspers-s-1-9e117e446cc1
- GoodBed — MAP Pricing Guide: https://www.goodbed.com/guides/mattress-map-pricing/
- Brooklinen pricing letter jul 2020: https://www.brooklinen.com/blogs/brookliving/brooklinen-update-from-rich-vicki
- eMarketer — D2C home goods: https://www.emarketer.com/content/how-d2c-home-goods-brands-brooklinen-parachute-vie-market-share

### Casos Anker
- Anker prospectus 2020 (resumen EqualOcean): https://equalocean.com/news/2020071714277
- Marketplace Pulse — Anker goes public: https://www.marketplacepulse.com/articles/amazon-native-brand-anker-goes-public
- Marketplace Pulse — Anker 1B sales: https://www.marketplacepulse.com/articles/amazon-native-brand-anker-reaches-1-billion-sales
- HBS Case 625-057 (sept 2024): https://www.hbs.edu/faculty/Pages/item.aspx?num=66383
- Chinesellers (2025) — Shallow Waters Strategy: https://chinesellers.substack.com/p/inside-anker-failures-fixes-and-shallow
- Axios 2022 — Anker billions: https://www.axios.com/2022/08/05/anker-batteries-chargers-smartphones-accessories

### Casos MercadoLibre LATAM
- Nubimetrics Academia: https://academia.nubimetrics.com/algoritmo-mercado-libre ; https://academia.nubimetrics.com/precios-competitivos ; https://academia.nubimetrics.com/mercadolibre-platinum
- Nubimetrics caso Neurolab: https://academia.nubimetrics.com/neurolab-nubimetrics
- Multivende — Ganar Buy Box MELI: https://multivende.com/blog/como-ganar-buy-box-mercado-libre/
- Infobae marzo 2026 — precios dinámicos MELI: https://www.infobae.com/economia/2026/03/10/polemica-entre-usuarios-de-mercado-libre-por-precios-distintos-para-un-mismo-producto-las-explicaciones-de-la-empresa/
- Ex-Ante — MELI Chile inversión US$750 M: https://www.ex-ante.cl/como-es-el-plan-de-mercado-libre-para-fortalecer-su-operacion-en-chile-con-inversion-de-us-750-millones/

### Regulatorio LATAM y UK
- SERNAC — CyberDay 2024 (PDF oficial): https://www.sernac.cl/portal/604/articles-80994_archivo_01.pdf
- BioBioChile — CyberDay 2024 precios inflados: https://www.biobiochile.cl/noticias/economia/actualidad-economica/2024/06/28/reclamos-cyberday-2024-sernac-revela-tiendas-donde-detectaron-precios-inflados-y-publicidad-enganosa.shtml
- Profeco — Buen Fin 2025: https://www.elimparcial.com/dinero/2025/11/18/profeco-resuelve-el-931-de-quejas-y-devuelve-mas-de-13-millones-en-el-buen-fin-2025/
- El Financiero — Profeco multas 2024: https://www.elfinanciero.com.mx/nacional/2023/12/26/cuidadito-con-la-publicidad-enganosa-esto-deberan-pagar-los-infractores-en-2024-segun-profeco/
- Idec Brasil — Metade do dobro: https://idec.org.br/blackfriday
- Sidley — CMA DMCC enforcement nov 2025: https://www.sidley.com/en/insights/newsupdates/2025/11/uk--competition-and-markets-authority-opens-investigations-into-online-pricing-practices

### Libros y frameworks
- Nagle, Müller & Gruyaert (2023). *The Strategy and Tactics of Pricing*, 7th ed. Routledge. https://www.routledge.com/The-Strategy-and-Tactics-of-Pricing/Nagle-Muller-Gruyaert/p/book/9781032016825
- Simon (2015). *Confessions of the Pricing Man*.
- Ariely (2017). *Dollars and Sense*.
- Bryar & Carr (2021). *Working Backwards — Amazon Operating Cadence*: https://workingbackwards.com/concepts/amazon-operating-cadence/

### Benchmarks y datos de industria
- Baymard — Cart abandonment: https://baymard.com/lists/cart-abandonment-rate
- Shopify — Sell-Through Rate: https://www.shopify.com/blog/sell-through-rate
- ATTN Agency — GM benchmarks: https://www.attnagency.com/blog/gross-margin-ecommerce
- Lokad — ABC Analysis: https://www.lokad.com/abc-analysis-inventory-definition/
- ToolsGroup — Long Tail Forecasting: https://www.toolsgroup.com/blog/forecasting-the-long-tail-and-intermittent-demand/
- Pacvue — Q4 2024 Retail Media Benchmark: https://pacvue.com/guides-reports/q4-2024-retail-media-benchmark-report/
- Perpetua — ACoS Guide: https://perpetua.io/blog-amazon-advertising-cost-of-sale-acos/
- Feedvisor — Amazon Buy Box 2026: https://feedvisor.com/university/amazon-buy-box/

---

*Informe producido mediante investigación asistida por múltiples subagentes de research (abril 2026). Todos los datos salariales, benchmarks y números duros deben validarse contra fuentes locales chilenas (p.ej. Michael Page Chile, Korn Ferry LATAM, CCS) antes de usarse como base de ofertas de compensación o proyecciones financieras. Las conclusiones son direccionales: el contexto específico de BANVA puede requerir ajustes que solo una auditoría operativa interna puede identificar.*