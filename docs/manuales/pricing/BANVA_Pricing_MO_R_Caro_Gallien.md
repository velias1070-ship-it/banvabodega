# MO+R para BANVA: del paper de Caro-Gallien al `sku_daily_snapshot` ejecutable

**Bottom line up front.** El estado del arte en Markdown Optimization + Replenishment (MO+R) es maduro y replicable: la literatura desde Smith-Achabal (1998) hasta Caro-Gallien (2012) y la línea Cohen-Perakis (2017-2021) entrega fórmulas cerradas y MILP que en producción rinden **5-10% de uplift en revenue de liquidación** y **2-8% en margen sobre SKUs vivos**. Los vendors enterprise (Oracle, Blue Yonder, Revionics, 7Learnings) cobran USD 60K-2M/año y están descalificados a tu escala — su "AI" es ~500 líneas de Python con `lightgbm` + `econml` + `cvxpy` + `MABWiser`. Para BANVA, el camino correcto es construir in-house en 6-8 semanas un stack que cubra (a) Operación Limpieza con Caro-Gallien adaptado y (b) joint pricing-inventory para SKUs vivos vía Federgruen-Heching BSLP. El cuello de botella real no es el modelo: es la falta de Layer 2 (snapshots de inventario diarios) sin el cual ninguna estimación de elasticidad es defendible. Empezar mañana con el `sku_daily_snapshot` table y un script de scraping de top-50 competidores compra el dato que en 90 días habilita todo lo demás.

---

# DIMENSIÓN 1 — SURVEY TÉCNICO/ACADÉMICO

## 1.1 Los seis papers fundacionales (con ecuaciones operativas)

### Smith & Achabal (1998) — el origen del MDO

**Cita.** Smith, S.A. & Achabal, D.D. (1998). "Clearance Pricing and Inventory Policies for Retail Chains." *Management Science* 44(3): 285-300. DOI: 10.1287/mnsc.44.3.285.

**Idea central.** Modelan demanda de clearance como producto de tres efectos multiplicativos: precio, tiempo y broken-assortment (la demanda cae cuando faltan tallas/colores).

$$d(p, t, I) = k(p) \cdot \gamma(t) \cdot y(I)$$

con $k(p) = \alpha e^{-\gamma p}$ (precio), $\gamma(t) = e^{-\lambda t}$ (decaimiento de temporada), y $y(I) = \min\{1, I/I^*\}$ (efecto surtido roto). El óptimo de Pontryagin entrega un sendero **monotónicamente decreciente y aproximadamente exponencial** de precios:

$$p^*(t) = \frac{1}{\gamma} + \mu(t)$$

donde $\mu(t)$ es el costate del inventario (precio sombra). **Para BANVA**: el efecto $y(I)$ explica por qué los 101 muertos no se mueven aunque bajes precio — cuando quedan 2-3 unidades de un cubrecolchón en una sola talla, la demanda colapsa estructuralmente, no por elasticidad. Implicación: liquidar agresivamente o **castear/agrupar en bundles** los SKUs con $I < I^*$.

### Caro & Gallien (2012) — el playbook de Zara, el más relevante para ti

**Cita.** Caro, F. & Gallien, J. (2012). "Clearance Pricing Optimization for a Fast-Fashion Retailer." *Operations Research* 60(6): 1404-1422. DOI: 10.1287/opre.1120.1102. PDF abierto: http://personal.anderson.ucla.edu/felipe.caro/papers/pdf_FC15.pdf

**Modelo de demanda (Eq. 1 del paper, log-log con elasticidad constante — NO es MNL como creías):**

$$\rho^w_r = \exp\{\beta_0 + \beta_1 \ln(C_r) + \beta_2 A^w_r + \beta_3 \ln(\rho^{w-1}_r) + \beta_4 \ln(\min\{1, I^w_r/f\}) + \beta_5 \ln(p^w_r/p^T_r)\}$$

donde $\rho^w_r$ = tasa de venta semana $w$, $C_r$ = cantidad inicial de compra (proxy de "fashionness"), $A^w_r$ = edad en días, $\rho^{w-1}_r$ = lag (AR(1)), $f$ = umbral de assortment, $\beta_5$ = **elasticidad-precio constante** (típicamente entre -2.5 y -1.0), $\beta_4$ = elasticidad de assortment.

**Optimización (MILP, Eqs. 9-24).** Variables binarias $x^w_{nk}$ = 1 si cluster $n$ se vende a precio ≤ $p_k$ en semana $w$. Objetivo:

$$\max \sum_{w,n,k} p_k \cdot \mu^w_{nk} + \sum_n p_0 \cdot I^W_n$$

Restricciones críticas: orden de clusters preservado, **clusters pueden mergear pero no separarse**, **markdowns únicamente** (no se sube precio), máximo $N^w$ precios distintos por semana (restricción de display), inventario mínimo por categoría.

**Resultado de campo.** Experimento controlado 2008 fall-winter Bélgica vs Irlanda: **+5.8% revenue clearance** (estadísticamente significativo). Forecast MAD 8-14%. Brecha CE vs DP completo <0.5% promedio. Adoptado mundialmente por Zara en 2009.

**Para BANVA.** Este es el paper-cookbook. Mapeo directo: clusters = SKUs con mismo precio regular; "categorías" = puntos de precio mostrados en vitrina; restricción de display irrelevante (ML no la impone). Tu escala (425 SKUs) es trivial vs los miles que resolvieron. La actualización en dos etapas con exponential smoothing $\hat{\beta}^w = \theta_1 \hat{\beta}^{w-1} + \theta_2 \tilde{\beta}^{C,w-1} + \theta_3 \tilde{\beta}^{P,w}$ es exactamente lo que necesitas para SKUs con poca data: pides prestada elasticidad de SKUs similares y la actualizas semanalmente.

### Gallego & van Ryzin (1994) — el baseline analítico

**Cita.** *Management Science* 40(8): 999-1020. DOI: 10.1287/mnsc.40.8.999.

**HJB:** $\partial J^*/\partial t (n,t) = \max_\lambda \{r(\lambda) - \lambda \cdot [J^*(n,t) - J^*(n-1,t)]\}$.

Con demanda exponencial $\lambda(p) = \alpha e^{-p}$, **fórmula cerrada**:

$$J^*(n,t) = \ln\left(\sum_{i=0}^n \frac{(\alpha t/e)^i}{i!}\right), \quad p^*(n,t) = J^*(n,t) - J^*(n-1,t) + 1$$

**Heurística determinista (la regla de oro práctica)**: cobra precio fijo $p_D$ tal que $\lambda(p_D) = \min\{\lambda^*, n/T\}$ donde $\lambda^* = \arg\max r(\lambda)$. Asintóticamente óptima con error $O(1/\sqrt{n})$. **Numéricamente la brecha es <2% con $n \geq 30$**. Para BANVA: para cualquier SKU calculas la run-out rate $n/T$, comparas con $\lambda^*$ y obtienes precio óptimo en una línea de Python. Es tu warm-start universal.

### Federgruen & Heching (1999) — joint pricing-inventory, política BSLP

**Cita.** *Operations Research* 47(3): 454-475.

**Resultado estructural.** Existen $(y^*_t, p^*_t)$ tales que la política óptima es **base-stock list-price (BSLP)**:
- Si $x \leq y^*_t$: pide hasta $y^*_t$ y cobra precio lista $p^*_t$.
- Si $x > y^*_t$: no pidas y cobra $\tilde{p}_t(x) \leq p^*_t$, **decreciente en x** (más stock → mayor descuento).

**Para BANVA — usa esto para SKUs vivos, no para muertos.** Implementa como tabla `pricing_rules` (ver Dimensión 3.D): para cada SKU vivo defines $y^*$ (target stock Full+Flex) y $p^*$ (precio lista); cuando excedes target, descuento automático. Numéricamente Federgruen-Heching reportan +2-8% profit vs static pricing con apparel.

### Bitran & Mondschein (1997) — markdown periódico, validado en Falabella Chile

**Cita.** *Management Science* 43(1): 64-79. DOI: 10.1287/mnsc.43.1.64.

**DP periódico** con arrivals Poisson y precios de reserva i.i.d. con distribución $F$:

$$V_k(n) = \max_{p \in \mathcal{P}} \sum_{m=0}^n \Pr(S_k = m | p) \cdot [m \cdot p + V_{k+1}(n-m)]$$

**Hallazgos clave:** (a) $p^*_k(n)$ decreciente en $n$, decreciente en tiempo restante. (b) **4-7 cambios de precio por temporada capturan >95% del óptimo continuo**. (c) Validado empíricamente con datos de Falabella Chile (calibración Weibull) — único estudio publicado con datos chilenos directamente análogos. **Implicación operativa**: **revisión semanal de precios es óptima**, no necesitas más frecuencia.

### Cohen-Perakis (2017, 2021) — promotion optimization multi-item

**Citas.** Cohen, Leung, Panchamgam, Perakis & Smith (2017) *Operations Research* 65(2): 446-468. Cohen, Kalas, Perakis (2021) *Management Science* 67(4): 2340-2364. PDF: https://maxccohen.github.io/Promotion-Optimization-for-Multiple-Items-in-Supermarkets.pdf

Demanda multiplicativa con efectos cross-item aditivos:

$$d^i_t = a^i_t + \sum_{m=0}^{M_i} \alpha^i_m p^i_{t-m} + \sum_{j \neq i} \beta^{ij} p^j_t$$

**Aproximación App(2)** (efectos hasta pares): demuestra que con cross-effects aditivos, App(2) es **exacta** y resoluble como LP por unimodularidad total. Lifts reportados: 3-9% profit vs baseline. **Para BANVA — relevancia parcial**: tus 425 SKUs tienen sustitución cross-item dentro de familias (cubrecolchón king vs queen, mismo material). Aplicable a partir de Fase 3, no antes.

## 1.2 Estado del arte 2020-2026

### Causal ML para elasticidad

**Chernozhukov et al. (2018) — Double/Debiased ML.** *Econometrics Journal* 21(1): C1-C68. DOI: 10.1111/ectj.12097. Para un PLR $Y = \theta D + g(X) + U$, $D = m(X) + V$, score Neyman-ortogonal:

$$\hat{\theta} = \frac{\sum (D_i - \hat{m}(X_i))(Y_i - \hat{g}(X_i))}{\sum (D_i - \hat{m}(X_i))^2}$$

con cross-fitting K-fold. Con $D = \log p$, $Y = \log q$, $X$ = controles, recuperas elasticidad $\sqrt{n}$-consistente aun cuando los nuisances convergen sólo a $n^{-1/4}$. **Para BANVA: este es tu camino correcto desde Fase 2.** Implementación: `econml.dml.LinearDML` o `DoubleML` package (Python).

**Wager & Athey (2018) — Causal Forests.** *JASA* 113(523): 1228-1242. Estima elasticidad heterogénea $\beta(x)$ por SKU/cluster con CIs. Implementación: `econml.dml.CausalForestDML`. Para detectar que cubrecolchones impermeables tienen elasticidad distinta a sábanas algodón.

**Tang, Qi, Fang, Shi (2025) — Offline Feature-Based Pricing Under Censored Demand.** *M&SOM* 27(2): 535-553. DOI: 10.1287/msom.2024.1061. **El paper más relevante para tu situación**: aborda exactamente el problema de demanda censurada por stockouts (que tendrás en cualquier SKU pegado a Full vacío). Combina survival analysis con DR estimator. Bound de regret en muestra finita.

**Hua, Yan, Xu, Yang (KDD 2021) — "Markdowns in E-Commerce Fresh Retail"** (Alibaba/Freshippo, arXiv:2105.08313). Modelo semi-paramétrico $\log Q = \alpha(x) + \beta(x) \log P + \varepsilon$ con DNN para $\alpha,\beta$ pero bloque log-linear para garantizar interpretabilidad económica. **Blueprint deployado en producción** que puedes copiar.

### Contextual bandits para pricing

**Misra, Schwartz, Abernethy (2019).** *Marketing Science* 38(2): 226-252. DOI: 10.1287/mksc.2018.1129. **Bandit con monotonicidad de demanda** — la innovación clave: comparte info entre arms vía la restricción $\Pr(\text{compra}|p_1) \geq \Pr(\text{compra}|p_2)$ para $p_1 < p_2$. En simulación: 95% del óptimo en 1,000 períodos vs 66% del A/B balanceado. **Lift +4% anualizado**. Tu plantilla para Fase 4.

**LinUCB / Thompson Sampling.** Li-Chu-Langford-Schapire (2010), Agrawal-Goyal (2013). Regret $\tilde{O}(d\sqrt{T})$. Implementación: `MABWiser` (Fidelity, gratis) o Vowpal Wabbit.

**Badanidiyuru, Kleinberg, Slivkins (2018) — Bandits with Knapsacks.** *J. ACM* 65(3). Marco directo para tu problema: arm = precio, recurso = inventario. Regret $\tilde{O}(\sqrt{KT})$.

**Mussi, Nuara, Trovò, Gatti, Restelli (AAAI 2023, arXiv:2211.09612) — PVD-B.** Caso de uso casi idéntico al tuyo: e-commerce italiano, 1,200 productos, 4 meses A/B contra pricing humano. **+55% turnover (~€300K)**. Algoritmo adoptado permanentemente. Es el precedente más cercano publicado a tu escala.

### RL para joint pricing-inventory

**Gijsbrechts, Boute, Van Mieghem, Zhang (2022).** *M&SOM* 24(3): 1349-1368. DOI: 10.1287/msom.2021.1064. Estudio riguroso A3C en lost-sales/dual-sourcing/multi-echelon. **Hallazgo crítico para ti**: DRL es competitivo con heurísticas tailored pero **tuning-intensivo**. A tu escala, las heurísticas Caro-Gallien/Federgruen-Heching dominan DRL en costo-beneficio.

**Liu et al. (Alibaba, arXiv:1912.02572).** DDPG/D4PG en Tmall, miles de SKUs, lift demostrado en producción. No replicable a tu escala sin equipo de research.

**Madeka et al. (Amazon, arXiv:2210.03137) y Maggiar-Eisenach et al. (2025, arXiv:2507.22040).** Structure-Informed Deep RL para inventory management. Embebe propiedades estructurales (monotonicidad, concavidad) vía DirectBackprop. Frontera 2025-2026.

### Forecasting de demanda con efectos de precio

**Salinas et al. (2020) — DeepAR.** *Int. J. Forecasting* 36(3): 1181-1191. LSTM probabilístico, ~15% mejora sobre ARIMA/ETS en retail.

**Lim et al. (2021) — Temporal Fusion Transformer.** *Int. J. Forecasting* 37(4): 1748-1764. Soporta nativamente known-future inputs (calendario de markdowns, eventos Cyber). SOTA en M5/electricity.

**Lección del M5 (Walmart).** Makridakis et al. (2022): los 5 ganadores usaron **LightGBM con features de precio** (lag, momentum, %discount). Pure DL quedó atrás. **A 425 SKUs, LightGBM domina; usa TFT/DeepAR sólo para incertidumbre probabilística de horizonte largo (planificación de Full).**

### Gap de literatura LATAM/MercadoLibre

**No existe paper revisado por pares en M&SOM/OR/Mgmt Science específico sobre MercadoLibre o pricing dinámico chileno hasta abril 2026.** Lo más cercano: Hervas-Drane & Shelegia (2024, *Mgmt Science*, SSRN 4135714) sobre marketplaces 3P; Hanspach-Sapi-Wieting (SSRN 3945137) sobre algorithmic pricing en Bol.com (metodología transposable). Consecuencia: tu sistema construido será competitivo con cualquier deployment publicado en LATAM.

## 1.3 Marco matemático consolidado

### Especificaciones de demanda — cuándo usar cuál

| Forma | Ecuación | Cuándo | Pitfall |
|---|---|---|---|
| Log-log | $\log d = \alpha + \beta \log p + \gamma' x$ | Default; $\beta$ = elasticidad constante | Falla con ceros (usa Poisson log-link) |
| Exponencial | $d = a e^{-bp}$ | DP cerrado Gallego-van Ryzin | Elasticidad $-bp$ crece linealmente, implausible |
| Poisson log-link | $d \sim \text{Poisson}(\lambda),\ \log\lambda = \alpha + \beta \log p$ | **SKUs de baja venta (tu caso, 0-20 u/día)** | Sobredispersión — usa NB2 |
| MNL | $P_i = e^{\alpha_i - \beta p_i}/(1+\sum e^{\alpha_j - \beta p_j})$ | Sustitución cross-SKU dentro de familia | IIA viola comparación dispar |
| Jerárquico Bayesiano | $\beta_i \sim N(\mu_\beta, \sigma_\beta^2)$ con priors por cluster | **Mandatorio cuando hay <30 obs/SKU — tu caso** | Compute (NUTS) |

### Tu fórmula maestra de markdown (adaptada Caro-Gallien)

Para Operación Limpieza, el problema es:

$$\max_{\{p_t^i\}} \sum_{t=1}^T \sum_{i=1}^N p_t^i \cdot \mathbb{E}[\min(d_t^i(p_t^i), I_t^i)] + s^i \cdot I_{T+1}^i - h \cdot I_t^i$$

sujeto a:
- Inventario: $I_{t+1}^i = (I_t^i - d_t^i)^+$
- Markdown only: $p_{t+1}^i \leq p_t^i$
- Precio mínimo: $p_t^i \geq c_i \cdot (1 + m_{\min})$ (margen mínimo aceptable, posiblemente negativo para muertos)
- Ladder discreto: $p_t^i \in \mathcal{P} = \{0\%, -10\%, -20\%, -30\%, -40\%, -50\%, -60\%\}$
- Holding cost: $h$ = costo de oportunidad warehouse + Full storage CLP/u/día

con demanda

$$d_t^i = \exp\{\alpha_i + \beta_g \log(p_t^i / p_0^i) + \beta_4 \log(\min\{1, I_t^i/f\}) + \delta_t\}$$

donde $\beta_g$ es elasticidad pooled del cluster $g$ del SKU $i$, y $\delta_t$ son dummies de eventos (CyberDay, fin de semana).

### Sample complexity: por qué necesitas pooling

Para detectar 5% lift de revenue por SKU con 80% power: $n \approx 16\sigma^2/\Delta^2 \approx 313{,}000$ impresiones por arm. A 500 imp/SKU/día = >2 años. **Conclusión**: Tests SKU-level imposibles; pooling cluster-level (10-30 SKUs) baja a ~25 días. Bandits Misra-Schwartz-Abernethy convergen 5-10× más rápido que A/B balanceado.

---

# DIMENSIÓN 2 — BENCHMARK COMERCIAL

## 2.1 Vendors enterprise: lo que hacen y cuánto cobran

| Vendor | Metodología | Uplift declarado | Precio anual | Fit BANVA |
|---|---|---|---|---|
| **Oracle Retail LPO** (heredero ProfitLogic) | Econométrica + OR | "Hasta 15%" margen | USD 500K-2M+ | **No** |
| **Blue Yonder** (ex-JDA, Panasonic) | ML con 200+ factores | +5% profit, -80% OOS | USD 300K-1.5M | **No** |
| **Revionics (Aptos)** | ML elasticity + cross-effects | 5-9% profit, 8-10x ROI | USD 200K-1M | **No** |
| **DemandTec (Acoustic)** | Econométrica + ML | 1-12% revenue, 5-20% margen | USD 250K-1M | **No** |
| **dunnhumby** | Customer-centric (loyalty) | +1-2% (honesto) | USD 300K-2M | **No** (no tienes loyalty) |
| **Pricefx** | Plataforma cloud + AI agents | "Hasta 70x ROI" | USD 100K-3.5M | **No** (su propia admisión) |
| **Competera** | ML + competitor graph | +7% profit (NOVUS) | USD 60K-300K | Borderline |
| **Intelligence Node** | Matching + reglas | Sin %s específicos | USD 15K-150K | Posible bajo, bajo valor |
| **Wiser Solutions** | Repricer rule-based | N/A | USD 8K-50K (Pro tier) | Add-on opcional |
| **Eversight (Instacart)** | A/B + bandits | +20-50% vs traditional | USD 200K-1M+ | **No** (pero replica método) |
| **7Learnings** | GBM pricing fashion/ecom | +10% profit promedio | EUR 30K-150K | **El más cercano** |
| **Engage3** | Price Image Mgmt | +6% market share | USD 50K-500K | **No** |

**Realidad económica para BANVA.** A USD 1M revenue (~CLP 900M anuales), 1% mejora margen ≈ USD 10K. Máximo gasto racional en pricing tools: **USD 5-15K/año** *si* materializas 5% lift. **Todos los enterprise vendors fallan este test por 10-100×.**

## 2.2 Lo replicable in-house en <500 líneas Python

| "AI" del vendor | Implementación open-source equivalente |
|---|---|
| "AI-driven elasticity" | `lightgbm` regression `units ~ price + competitor_price + DoW + days_listed + stock + promo` |
| "Causal price impact" | `econml.dml.LinearDML` o `DoubleML` package — **literalmente el mismo método** |
| "AI markdown timing" | `inventory / forecast(price)` + `cvxpy` optimización 200 líneas |
| "Predictive offer engine" | `MABWiser` Thompson sampling, 50 líneas |
| "Competitive monitoring" | ML API `price_to_win` + `httpx` scraper top-50 |
| "Cross-elasticity matrix" | Sólo importa con >5K SKUs — **skip** |

## 2.3 Stack mínimo viable open-source

| Capa | Tool | Costo |
|---|---|---|
| Data ingest | ML API + Python `requests` + Postgres (Supabase) | $0 |
| Forecasting corto | LightGBM (M5-style features) | $0 |
| Forecasting largo + uncertainty | `nixtla/neuralforecast` (TFT, N-HiTS) | $0 |
| Causal elasticity | `econml` (DML/CausalForest) | $0 |
| Bandits | `MABWiser` (Fidelity) | $0 |
| Optimización | `cvxpy` o Google OR-Tools | $0 |
| Inventory (newsvendor, EOQ, ROP) | `stockpyl` (MIT, Larry Snyder, Lehigh) | $0 |
| Orchestration | n8n (ya tienes) o GitHub Actions cron | $0 |
| Dashboard | Streamlit o Metabase | $0 |
| Compute | VPS Hetzner CX22 o Vercel Edge | USD 8-30/mes |
| Proxies (scraping competidores) | IPRoyal residential | USD 18-25/mes |
| Real Trends (alertas competidores) | Subscripción Chile | USD 80-150/mes |

**Total: USD 110-200/mes (~CLP 100-180K)** — vs USD 60K+/año de Competera, el competidor más barato.

## 2.4 Recomendación buy/build/skip para BANVA

**BUILD** (clear ROI, ~6-8 semanas tu engineer Raimundo):
1. `sku_daily_snapshot` + ingestión (semana 1)
2. Demand model LightGBM con features de precio (semana 2-3)
3. DML elasticity refit semanal (semana 4)
4. Markdown optimizer `cvxpy` (semana 5)
5. Repricing bandit `MABWiser` (semana 6)
6. ROP recalculation joint con pricing (semana 7)
7. Streamlit "approve recommendations" UI (semana 8)

**BUY** (mínimo necesario):
- **Real Trends** (~USD 100/mes): alertas competidores, mass publisher. Operacionalmente útil aun si construyes tu propio modelo.
- **Wiser Pro** (~USD 700/mes): **SKIP por ahora** — sólo si encuentras gap real después de 6 meses.

**SKIP completamente:**
- Cualquier demo de Oracle/Blue Yonder/Revionics/Pricefx (perderás 3-5 horas y no te venderán)
- Cross-elasticity halo modeling (irrelevante a 425 SKUs)
- RL/Q-learning end-to-end (data-hungry, sim-to-real frágil a tu escala)
- Repricer real-time sub-horario (ML "Price-to-win" ya corre platform-level)

**Re-evaluar a USD 5M revenue.** Ahí 7Learnings (mejor fit metodológico, ~4-8 semanas implementación) o Competera (entry mid-market) se vuelven defendibles.

---

# DIMENSIÓN 3 — ROADMAP APLICADO PARA BANVA

## 3.A Schema `sku_daily_snapshot` (Postgres / Supabase)

```sql
-- Particionado mensual por snapshot_date — eficiente para 425 SKUs × 730 días
CREATE TABLE sku_daily_snapshot (
    snapshot_date         DATE NOT NULL,
    sku_id                TEXT NOT NULL,           -- tu SKU interno BANVA
    ml_item_id            TEXT NOT NULL,           -- MLC1234... ID en MercadoLibre
    family                TEXT NOT NULL,           -- cubrecolchon_imp, sabana_algodon, etc.
    category_ml           TEXT,                    -- categoría ML (MLC1574 etc.)
    
    -- LIFECYCLE (gap crítico que mencionaste)
    lifecycle_stage       TEXT NOT NULL CHECK (lifecycle_stage IN
        ('new','growing','mature','declining','stagnant','dead','liquidating')),
    days_since_listed     INT NOT NULL,
    days_since_last_sale  INT,
    
    -- INVENTARIO (Layer 2 — el crítico que te falta)
    stock_full            INT NOT NULL DEFAULT 0,  -- en bodega ML Full
    stock_flex            INT NOT NULL DEFAULT 0,  -- en tu bodega
    stock_in_transit      INT NOT NULL DEFAULT 0,  -- camino a Full
    stock_total           INT GENERATED ALWAYS AS (stock_full + stock_flex + stock_in_transit) STORED,
    is_stockout_full      BOOLEAN GENERATED ALWAYS AS (stock_full = 0) STORED,
    is_stockout_total     BOOLEAN GENERATED ALWAYS AS (stock_full + stock_flex = 0) STORED,
    days_of_supply        NUMERIC,                 -- stock_total / forecast_daily_demand
    
    -- PRECIO Y COSTO (cost-at-time-of-sale — tu otro gap)
    price_listed          INT NOT NULL,            -- precio actual CLP
    price_regular         INT NOT NULL,            -- precio "lista" pre-markdown
    discount_pct          NUMERIC GENERATED ALWAYS AS 
        ((price_regular - price_listed)::NUMERIC / NULLIF(price_regular,0)) STORED,
    cost_landed_clp       INT NOT NULL,            -- costo logístico-aterrizado (CLP/u) AL MOMENTO
    fx_clp_usd            NUMERIC,                 -- tipo de cambio del día (auditoría)
    
    -- VENTAS Y EXPOSICIÓN
    units_sold            INT NOT NULL DEFAULT 0,
    revenue_clp           INT NOT NULL DEFAULT 0,
    visits                INT NOT NULL DEFAULT 0,  -- de items_visits API
    questions             INT NOT NULL DEFAULT 0,
    conversion_rate       NUMERIC GENERATED ALWAYS AS 
        (units_sold::NUMERIC / NULLIF(visits,0)) STORED,
    
    -- CANAL / FULFILLMENT
    pct_via_full          NUMERIC,
    pct_via_flex          NUMERIC,
    
    -- COMPETENCIA (de scraper o Real Trends)
    competitor_price_min  INT,
    competitor_price_avg  INT,
    competitor_count      INT,
    has_buy_box           BOOLEAN,                 -- si SKU es catalog
    price_to_win          INT,                     -- de /price_to_win API si aplica
    
    -- EVENTOS (Layer 5 parcial)
    is_cyber_event        BOOLEAN DEFAULT FALSE,
    is_holiday            BOOLEAN DEFAULT FALSE,
    promo_flag            TEXT,                    -- 'oferta_dia','flash','none'
    
    -- METADATA
    semaforo_bucket       TEXT,                    -- tu Semáforo Semanal
    
    PRIMARY KEY (snapshot_date, sku_id)
) PARTITION BY RANGE (snapshot_date);

-- Particiones mensuales (script para 24 meses adelante)
CREATE TABLE sku_daily_snapshot_2026_05 PARTITION OF sku_daily_snapshot
    FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
-- ... (genera vía función)

-- Índices críticos
CREATE INDEX idx_sds_sku_date ON sku_daily_snapshot (sku_id, snapshot_date DESC);
CREATE INDEX idx_sds_family_date ON sku_daily_snapshot (family, snapshot_date DESC);
CREATE INDEX idx_sds_lifecycle ON sku_daily_snapshot (lifecycle_stage, snapshot_date DESC) 
    WHERE lifecycle_stage IN ('dead','stagnant','liquidating');
CREATE INDEX idx_sds_stockout ON sku_daily_snapshot (snapshot_date) 
    WHERE is_stockout_total = TRUE;
```

**Tamaño estimado.** 425 SKUs × 730 días × ~250 bytes/row ≈ 78 MB raw. Con índices ~120 MB. Trivial para Supabase. **Particionado mensual** acelera queries por rango de fechas y permite drop trivial de particiones >2 años.

**Ingesta diaria** (cron 23:00 CLT vía n8n):
1. Pull `/users/{id}/items_visits` con `date_from = today, date_to = today`
2. Pull `/items?ids=...` en batches de 20 para `available_quantity`, `price`, `sold_quantity`
3. Pull `/orders/search?seller={id}&date_created.from=today` para `units_sold` y `revenue`
4. Pull `/items/{id}/price_to_win` para SKUs catalog-eligible
5. Run scraper top-50 para `competitor_price_*`
6. Compute lifecycle_stage via reglas Semáforo
7. Compute cost_landed_clp consultando `lots` table (ver 3.D para handling de cost-at-time-of-sale)

## 3.B Roadmap por fases

### Fase 0: Foundation (semanas 1-4)

**Pre-requisitos:** acceso ML API, Supabase project ID `qaircihuiafgnnrwcjls`, n8n corriendo.

**Deliverables:**
- `sku_daily_snapshot` table desplegada y backfill de 90 días (vía API histórica donde sea posible)
- Tabla `lots` con FIFO de costos por embarque (necesaria para `cost_landed_clp` correcto)
- Pipeline n8n diario funcional con alertas Slack si falla
- Dashboard Streamlit/Metabase con vista por SKU: stock, precio, ventas 7/30 días, días-en-quiebre, costo
- Scraper top-50 competidores en Railway/Hetzner con Playwright + IPRoyal proxies
- Documento de Política de Recolección de Datos (1 página, tu defensa legal)

**Métrica de éxito:** 30 días consecutivos de snapshots sin gaps; <5% SKUs con `cost_landed_clp` NULL.

**Costo:** ~80 horas Raimundo + USD 30/mes infra. **Tiempo: 4 semanas estrictas.**

**ROI directo: cero.** Pero sin Fase 0, todas las demás son fantasía.

### Fase 1: Operación Limpieza (semanas 5-12)

**Pre-requisito:** Fase 0 completa + 30 días de snapshots.

**Deliverables:**
- Algoritmo Caro-Gallien adaptado (ver 3.C abajo) corriendo semanalmente
- Recomendaciones de markdown para los 101 muertos + 28 estancados
- A/B test con grupo control de 30 SKUs (matched-pair por familia/precio/edad)
- Dashboard de tracking semanal: $ liquidado, % stock liberado, margen residual

**Métrica de éxito:**
- Liquidar **80% del valor de inventario muerto en 12 semanas** (CLP 5.6M de los 7M)
- Margen residual no peor que -15% sobre costo promedio (i.e., recuperas ≥85% del costo)
- 95% del stock estancado movido a "vivo" o "muerto" (no más limbo)

**Costo:** ~100 horas Raimundo + ~CLP 200-400K en Mercado Ads para acelerar exposición de SKUs liquidando.

**ROI esperado:** Liberar CLP 5.6M de capital muerto + ahorrar Full storage (estimado CLP 30-60K/mes) + abrir SKU slots para reposiciones rotativas. **NPV ~CLP 6-7M considerando costo de oportunidad del capital al 12% anual.**

### Fase 2: Pricing rule-based para SKUs vivos con replenishment (meses 4-6)

**Pre-requisito:** Fase 1 generó 8+ semanas de variación de precio para alimentar elasticidad cruda.

**Deliverables:**
- `pricing_rules` table (esquema en 3.D)
- Implementación de Federgruen-Heching BSLP simplificada por familia
- Elasticidad cruda (OLS pooled cluster-level) para 8-12 familias principales
- Reglas de Full-vs-Flex split automatizadas
- Re-orden automático con ROP que considera precio actual

**Métrica de éxito:**
- 80% de decisiones de precio para SKUs vivos generadas por sistema (founder aprueba, no decide ad-hoc)
- Stockouts en Full reducidos 50% vs baseline
- Margen bruto promedio +1-3% sobre baseline pre-sistema

**Costo:** ~120 horas Raimundo. **Tiempo: 8-12 semanas.**

**ROI:** A 1.5% margin lift sobre revenue mensual de CLP 100M = CLP 1.5M/mes ≈ CLP 18M/año.

### Fase 3: Causal ML para elasticidad (meses 7-12)

**Pre-requisito:** ≥6 meses de snapshots con variación deliberada de precio (Fase 1+2 generan esto naturalmente). Idealmente 12 meses.

**Deliverables:**
- DML pipeline en `econml` corriendo mensualmente
- Elasticidades por SKU-cluster con CIs
- Causal Forest detectando heterogeneidad (SKU/season/inventory_level)
- IV setup con FX CLP/USD como instrumento (importas de China — instrument fuerte)
- Validación contra Fase 2: ¿elasticidades crudas vs DML coinciden?

**Métrica de éxito:**
- Elasticidades estimadas con CIs cuyo ancho ≤ 0.5 (i.e., $\beta = -1.5 \pm 0.25$)
- F-stat de primer-stage del IV >10 (Stock-Yogo)
- Validación out-of-sample: predicción de demanda en hold-out con MAPE <25%

**Costo:** ~80 horas Raimundo o un consultor data-science 40 horas (~CLP 1.5M).

**ROI:** Refinamiento sobre Fase 2 — quizás +1-2% margen adicional. Más importante: **defensividad** del modelo (sabes por qué los precios se mueven).

### Fase 4: Contextual bandits (meses 12-18)

**Pre-requisito:** Fase 3 con elasticidades validadas; equipo cómodo con experimentación.

**Deliverables:**
- Bandit Misra-Schwartz-Abernethy en `MABWiser` corriendo en SKUs nuevos / inciertos
- Bandits with Knapsacks (Ferreira-Simchi-Levi-Wang 2018) para SKUs con stock limitado
- Cluster-level pooling para superar la sample-complexity barrier
- Guardrails: precio nunca <costo+5%, nunca >2× competitor median

**Métrica de éxito:** Tiempo de descubrimiento de precio óptimo en SKUs nuevos: <30 días vs ~90 días con prueba humana.

**Costo:** ~100 horas + monitoreo continuo.

**ROI:** Marginal sobre Fase 3, pero crítico para el ritmo de introducción de nuevos SKUs (especialmente colecciones estacionales).

## 3.C Algoritmo específico para Operación Limpieza

**Setup.** 101 SKUs muertos (CLP 7M valor inventario al costo) + 28 estancados (CLP 3M). Ventana objetivo: **12 semanas**. Holding cost estimado:
- Full storage para texils medium-large: ~CLP 15-30/u/día = CLP 450-900/u/mes
- Costo oportunidad capital: 12% anual = 1%/mes
- Recargo stock-antiguo Full >120 días: escalonante, asume CLP 50-100/u/día adicional

**Para un cubrecolchón impermeable king (tu top seller saludable como benchmark):** costo ~CLP 7,200; precio regular ~CLP 26,990. Si está muerto con stock 5 unidades en Full, holding = ~5 × CLP 60/u/día × 84 días = CLP 25,200; hold cost ya equivale a 70% del costo unitario en 12 semanas. **El holding cost domina la decisión.**

### Algoritmo (pseudo-código Python, adaptado Caro-Gallien):

```python
import cvxpy as cp
import numpy as np

# Para cada cluster g (familia con elasticidad pooled):
# Variables de decisión: discount_step[s][t][i] binario
#   = 1 si SKU i en escalón de descuento s en semana t
# Escalones: [0%, 10%, 20%, 30%, 40%, 50%, 60%, 70%]

DISCOUNTS = np.array([0, 0.10, 0.20, 0.30, 0.40, 0.50, 0.60, 0.70])
T = 12  # semanas
N = len(skus_in_cluster)
S = len(DISCOUNTS)

# Demanda esperada (de Fase 0 forecast + elasticidad pooled del cluster)
# d[i,s] = demanda semanal esperada SKU i bajo descuento s
# Calibración: d[i,s] = d_base[i] * (1 - DISCOUNTS[s])^beta_g
#   donde beta_g es elasticidad-precio cluster (típicamente -1.5 a -2.5)
#   y d_base[i] es demanda al precio regular (de tus datos pre-muerte si existen,
#   sino prior del cluster)

x = cp.Variable((N, T, S), boolean=True)

# Sales esperadas por SKU/semana
sales = sum(x[:,:,s] * d[:,s,np.newaxis] for s in range(S))

# Revenue esperada
revenue = sum(x[i,t,s] * d[i,s] * p_regular[i] * (1 - DISCOUNTS[s])
              for i in range(N) for t in range(T) for s in range(S))

# Costo de holding
holding = sum((I_initial[i] - sales[i,:t].sum()) * h_per_unit_week
              for i in range(N) for t in range(T))

# Salvage (al final del horizonte): liquidación a precio piso o write-off
salvage_units = I_initial - sales.sum(axis=1)
salvage = salvage_units @ p_salvage  # CLP/u en outlet de último recurso (o 0)

objective = cp.Maximize(revenue - holding + salvage)

constraints = [
    # Un solo escalón por SKU/semana
    cp.sum(x[i,t,:]) == 1 for i in range(N) for t in range(T),
    # No subir precio (markdown only)
    sum(x[i,t,s]*s for s in range(S)) <= sum(x[i,t+1,s]*s for s in range(S))
        for i in range(N) for t in range(T-1),
    # No vender más que stock
    sum(sales[i,:]) <= I_initial[i] for i in range(N),
    # Margen mínimo aceptable (puede ser negativo para muertos)
    # Ej: descuento máximo 60% -> precio = 40% × p_regular ≥ 0.7 × c (acepta -30% margen)
]

problem = cp.Problem(objective, constraints)
problem.solve(solver=cp.CBC)  # o GLPK_MI, gratis
```

### Reglas de complemento (no en el LP):

**1. Cuándo matar (write-off) en lugar de liquidar.** Si:
- $I < I^*$ (umbral broken-assortment, típicamente 3-5 unidades para textiles), Y
- $d_{\max}(p_{\min}) < 1$ unidad/semana (incluso al 70% off no se mueve)
- Holding cost 12 semanas > costo unitario × 0.5

**Decisión:** descarta vía MELI Full "descarte" (~CLP 200/u, más barato que retiro) o dona. Castigar contablemente y cerrar SKU. **Estimado**: ~20-30 de los 101 muertos caen aquí.

**2. Cuándo bundle.** Cuando dos SKUs muertos son complementos naturales (cubrecolchón king + protector almohada king) y ambos tienen $I > 0$:
- Crea listing "kit" con precio combinado a ~25-35% descuento sobre suma individual
- Cierra los listings individuales para forzar tráfico al kit
- Bundle absorbe stock proporcional sin necesidad de descuento agresivo en cada uno

**3. Mercado Ads vs price cuts.** Para SKUs estancados (no muertos): si CTR<1% y conversión<0.5%, el problema es exposición no precio. Asignar **CLP 50-150K/semana en Mercado Ads Product Ads** antes de bajar precio puede ser más eficiente. **Decisión rule**: si discount necesario para mover stock excede 25%, comparar con costo de campaña Ads que genere mismas impresiones.

**4. Trigger de aceleración.** Si cumplida la semana 6 has movido <40% del stock objetivo, aplicar override: salta dos escalones de descuento simultáneamente y agrega Mercado Ads boost.

## 3.D Joint pricing-inventory para SKUs vivos

### Schema `pricing_rules`

```sql
CREATE TABLE pricing_rules (
    rule_id              SERIAL PRIMARY KEY,
    scope_type           TEXT NOT NULL CHECK (scope_type IN ('sku','family','category','global')),
    scope_id             TEXT NOT NULL,           -- sku_id, family_name, etc.
    
    -- BSLP parameters (Federgruen-Heching)
    target_stock_full    INT,                     -- y* para Full
    target_stock_total   INT,                     -- y* total Full+Flex
    list_price           INT,                     -- p* a stock ≤ y*
    
    -- Markdown trigger function (precio decreciente en stock excedente)
    markdown_curve       JSONB,                   -- [{stock_excess_pct: 20, discount_pct: 5},
                                                  --  {stock_excess_pct: 50, discount_pct: 15}, ...]
    
    -- Reorder point (joint con pricing — usa demanda esperada al list_price)
    reorder_point        INT,                     -- ROP Full
    eoq                  INT,                     -- cantidad de orden a Full
    lead_time_days       INT,                     -- L_F
    safety_stock_z       NUMERIC DEFAULT 1.645,   -- z para 95% service level
    
    -- Channel split rules
    full_share_target    NUMERIC,                 -- φ ∈ [0,1], fracción a Full
    full_min_velocity    NUMERIC,                 -- u/día mínima para justificar Full
    
    -- Guardrails
    price_min            INT,                     -- nunca debajo (cost × 1.05 default)
    price_max            INT,                     -- nunca arriba (competitor_min × 1.15)
    discount_max_pct     NUMERIC DEFAULT 30,      -- markdown máximo en SKUs vivos
    
    -- Elasticity context
    elasticity_estimate  NUMERIC,                 -- β del cluster (Fase 2/3)
    elasticity_ci_low    NUMERIC,
    elasticity_ci_high   NUMERIC,
    elasticity_source    TEXT,                    -- 'pooled_ols','dml','prior'
    
    -- Audit
    created_at           TIMESTAMPTZ DEFAULT NOW(),
    updated_at           TIMESTAMPTZ DEFAULT NOW(),
    active               BOOLEAN DEFAULT TRUE,
    
    UNIQUE (scope_type, scope_id, active) DEFERRABLE
);

-- Función para resolver precio dado stock actual (BSLP discrete)
CREATE OR REPLACE FUNCTION compute_dynamic_price(p_sku TEXT)
RETURNS INT AS $$
DECLARE
    v_rule pricing_rules%ROWTYPE;
    v_stock INT;
    v_excess_pct NUMERIC;
    v_discount NUMERIC;
BEGIN
    -- Resolver regla por jerarquía: SKU -> family -> category -> global
    SELECT * INTO v_rule FROM pricing_rules
    WHERE active AND (
        (scope_type='sku' AND scope_id=p_sku) OR
        (scope_type='family' AND scope_id=(SELECT family FROM skus WHERE sku_id=p_sku))
        -- ... etc
    ) ORDER BY CASE scope_type 
        WHEN 'sku' THEN 1 WHEN 'family' THEN 2 WHEN 'category' THEN 3 ELSE 4 END
    LIMIT 1;

    SELECT stock_total INTO v_stock FROM sku_daily_snapshot
    WHERE sku_id=p_sku AND snapshot_date=CURRENT_DATE;

    IF v_stock <= v_rule.target_stock_total THEN
        RETURN v_rule.list_price;
    ELSE
        v_excess_pct := (v_stock - v_rule.target_stock_total)::NUMERIC / v_rule.target_stock_total * 100;
        -- Lookup discount en markdown_curve JSONB
        SELECT (curve->>'discount_pct')::NUMERIC INTO v_discount
        FROM jsonb_array_elements(v_rule.markdown_curve) curve
        WHERE (curve->>'stock_excess_pct')::NUMERIC <= v_excess_pct
        ORDER BY (curve->>'stock_excess_pct')::NUMERIC DESC LIMIT 1;
        RETURN GREATEST(v_rule.price_min, 
                        ROUND(v_rule.list_price * (1 - COALESCE(v_discount,0)/100)));
    END IF;
END;
$$ LANGUAGE plpgsql;
```

### Cómo elasticidad alimenta replenishment

ROP estándar:
$$r = \mu_L \cdot L + z \cdot \sigma_L \cdot \sqrt{L}$$

donde $\mu_L = \bar{d}(p) \cdot L$ — **pero $\bar{d}$ depende del precio decidido**. Joint:

1. Computa precio óptimo $p^*$ para target_stock $y^*$ (BSLP)
2. Estima demanda esperada $\bar{d} = a \cdot (p^*)^\beta$ con $\beta$ de `elasticity_estimate`
3. ROP = $\bar{d} \cdot L + z \sigma \sqrt{L}$
4. Si en período actual el precio está descontado por exceso de stock, $\bar{d}$ es mayor → ROP debería ser mayor → pero estás liquidando, **no quieres reordenar**. Lógica: **si stock_actual > target_stock × 1.5, suspende reorder** (señal de que sobre-pediste o demanda cayó).

### Full vs Flex split joint

Heurística operativa para BANVA:

```
SI velocidad_30d ≥ 1.5 u/día Y categoría_size ≤ medium Y precio ≥ $19,990:
    full_share = 80%, flex_share = 20%
SI velocidad ∈ [0.5, 1.5] Y temporada_alta (mar-ago para cubrecolchones):
    full_share = 60%
SI velocidad < 0.5 u/día O categoría_size = XL:
    full_share = 0%, todo Flex
SI estacional fuera-de-temporada (cubrecolchón en dic-feb):
    desocupa Full (retiro), mover a Flex hasta abril
```

Justificación: storage Full 30 días para medium textile ≈ CLP 450-900/u; un cubrecolchón a 0.3 u/día rota cada 30 días, paga ≥ CLP 450/u, contra margen de quizás CLP 5,000 — devora 9% del margen. Flex sin storage es Pareto-superior para slow movers.

## 3.E Workaround de Competitive Intelligence

**Stack recomendado** (validado por análisis de docs ML + ToS + práctica industria):

1. **Capa API (free, legal, real-time):** ML API en tu cuenta para `items_visits`, `items`, `orders`, `price_to_win` (catalog-eligible SKUs), webhooks. Configura `items_prices`, `best_price_eligible`, `price_to_win` webhooks → n8n → Supabase.

2. **Capa Real Trends (USD ~100/mes, legal vía partnership):** alertas competidores, mass publisher, métricas de categoría. Reemplaza 80% del scraping.

3. **Capa scraping ligero (USD ~25/mes, legalmente defendible):** Top 50 SKUs competidores diariamente.

### Spec de scraper

**Stack técnico:**
- Python `httpx` async + `selectolax` para search results pages (HTML estático, parseable directo)
- Playwright + `playwright-stealth` para VIP pages (JS-rendered en algunas categorías)
- Proxy: IPRoyal residential pay-as-you-go (USD 1.75/GB)
- Compute: Hetzner CX22 (USD 8/mes) o piggyback en tu Vercel/Railway existente
- Scheduling: cron 06:00 CLT diario, ~500 fetches totales (50 SKUs × 10 competitor listings + paginación)

**Campos a capturar:**
```python
{
    'ml_item_id': str,           # MLC...
    'title': str,
    'price': int,                # CLP
    'original_price': int,        # si está descontado
    'discount_pct': float,
    'shipping_free': bool,
    'shipping_full': bool,        # tiene Full
    'is_mercadolider': bool,
    'mercadolider_level': str,    # silver/gold/platinum
    'rating': float,
    'reviews_count': int,
    'sold_quantity_bucket': str,  # '+50','+100','+500'
    'is_buy_box_winner': bool,
    'seller_id_hash': str,        # hash, NO el real, por privacidad
    'captured_at': datetime,
}
```

**Frecuencia.** Una vez al día (06:00 CLT) es suficiente y respeta rate limits cómodamente. Si necesitas más frecuencia para SKUs hot durante CyberDay, sube a 4/día sólo esos días.

### Postura legal (resumen ejecutivo)

- ML ToS prohíbe scraping pero la prohibición es contractual no estatutaria
- Datos de listings (precio, título) son **comerciales no-personales**, no protegidos por Ley 19.628 ni Ley 21.719
- Precedente US (hiQ v LinkedIn, Meta v Bright Data) establece que scraping público no autenticado no viola CFAA — no vinculante en Chile pero indicativo
- Riesgo real para BANVA: cierre de cuenta seller si ML detecta. **Mitigación**: scraping desde IP separada (no la cuenta seller), no sesión autenticada, no captura de datos personales (nombres, emails)
- Documenta política interna: `docs/data_collection_policy.md` (1 página)
- **Veredicto**: **bajo riesgo, alta utilidad** — recomendado.

### Alternativa premium

Si la postura legal te incomoda, sustituye scraping por **Nubimetrics 3-module bundle** (~USD 250-350/mes). Cubre 95% de la inteligencia con cero riesgo legal. A tu escala actual, **Real Trends + scraping propio = mejor costo-beneficio**; a USD 5M+ revenue, **Nubimetrics enterprise** se justifica.

## 3.F Plan de inferencia causal para elasticidad

### Cuándo tendrás suficiente data

Pre-condiciones para DML defendible (Chernozhukov 2018 + reglas de oro Caro-Gallien):
- ≥6 meses de snapshots con ≥3-4 puntos de precio distintos por cluster
- ≥30-50 (precio, semana) observaciones por cluster
- Variación de precio ≥15-20% del precio regular en cada cluster

**Tu calendario (asumiendo Fase 0 inicia mayo 2026):**
- Mayo 2026 - Octubre 2026: acumulación natural (Fase 0+1) genera variación porque Operación Limpieza fuerza markdowns a 60% off en muertos y modesta variación en estancados
- **Noviembre 2026 - Enero 2027:** primera ventana viable para DML pooled cluster-level
- Octubre 2027 (18 meses): DML por SKU para top 50 SKUs vivos con suficiente volumen

### Técnicas recomendadas en orden de progresión

**Fase 2 (rápido, sucio, suficiente):**
- Pooled OLS log-log con efectos fijos two-way: `linearmodels.PanelOLS(entity_effects=True, time_effects=True)` agrupando por cluster
- Stockout-censoring correction: dropear SKU-días con `is_stockout_total = TRUE`
- Resultado: $\hat{\beta}$ por cluster, biased pero útil como prior

**Fase 3 (defendible):**
- **Double ML (`econml.dml.LinearDML` o `DoubleML` package)** con cross-fitting K=5
  - Y = log(units_sold), D = log(price_listed)
  - X = log(price_competitor_avg), days_since_listed, log(visits), DoW dummies, holiday flags, season, log(stock_total), interactions
  - Nuisance learners: `LassoCV` y `RandomForestRegressor` (default robusto)
- **Causal Forest (`econml.dml.CausalForestDML`)** para heterogeneidad
  - Output: $\beta(x)$ por SKU según features
  - Validación con honest sampling
- **IV con FX shock** (eres importador, instrumento limpio):
  - Z = log(CLP/USD lagged 1 month)
  - First-stage: log(price) = π₀ + π₁ Z + controls; F-stat >10 (Stock-Yogo)
  - 2SLS via `linearmodels.IV2SLS` o `econml.iv.dml.OrthoIV`

**Validación pre-deployment:**
1. **Sign check**: $\hat{\beta} < 0$ con CI no cruzando cero (rechazo de inelasticidad infinita)
2. **Magnitud plausible**: $\hat{\beta} \in [-3.0, -0.5]$ (literatura textiles/apparel: típicamente -1.0 a -2.5)
3. **Out-of-sample backtest**: dejar último 20% de datos fuera, predecir demanda a precios observados, MAPE <30%
4. **Comparación con prior literatura**: Caro-Gallien Zara apparel $\beta \in [-2.5, -1.0]$; Bitran-Mondschein Falabella ~$-1.7$
5. **A/B confirmatorio en 1 cluster** antes de roll-out global: testear precio recomendado vs precio status-quo en 3 SKUs del cluster por 30 días

### Code skeleton

```python
from econml.dml import LinearDML, CausalForestDML
from sklearn.ensemble import RandomForestRegressor, GradientBoostingRegressor
import pandas as pd

df = pd.read_sql("""
    SELECT s.*, c.competitor_price_avg
    FROM sku_daily_snapshot s LEFT JOIN ...
    WHERE NOT is_stockout_total
      AND units_sold > 0
      AND snapshot_date >= '2026-08-01'
""", conn)

# Filtrar a 1 cluster (familia)
df_cluster = df[df['family'] == 'cubrecolchon_impermeable']

Y = np.log(df_cluster['units_sold'])
T = np.log(df_cluster['price_listed'])
X = df_cluster[['log_competitor_price', 'days_since_listed', 'log_visits',
                'is_weekend', 'is_holiday', 'log_stock_total']].fillna(0)
W = X.copy()  # mismos controles

est = LinearDML(
    model_y=GradientBoostingRegressor(n_estimators=100),
    model_t=GradientBoostingRegressor(n_estimators=100),
    discrete_treatment=False,
    cv=5,
    random_state=42
)
est.fit(Y, T, X=X, W=W)
print(f"Elasticidad: {est.coef_[0]:.3f} ± {est.coef__interval()[0][0]:.3f}")
# Esperar algo como: Elasticidad: -1.823 ± 0.214
```

---

# Pitfalls y modos de falla

**1. Cost-at-time-of-sale incorrecto.** Si calculas margen con `cost_landed_clp` actual sobre venta de hace 6 meses, el FX podría haberse movido 15% — margen real ≠ margen reportado. **Solución**: tabla `lots` con FIFO, `cost_landed_clp` en snapshot toma el costo del lote vigente esa fecha.

**2. Stockout-confounded elasticity.** Estimas $\hat{\beta} = 0.2$ (positivo) porque los días de mucho stock coinciden con días que ya bajaste precio porque no se vendió. **Solución**: dropear SKU-days con stockout o usar Tobit; usar IV con FX.

**3. Promotion confounding.** Markdown coincide con CyberDay → atribuyes a precio el lift de tráfico. **Solución**: dummies explícitos `is_cyber_event`; sólo periodos "limpios" para fit.

**4. Sample size delusion.** Crees que tienes data suficiente porque tienes 425 SKUs × 730 días = 310K rows. Real: 425 SKUs × ~5 puntos de precio distintos × 1 año = ~2K cells útiles. **Solución**: pooling jerárquico, no SKU-level.

**5. BSLP en lost-sales sin verificar Pang/Kocabıyıkoğlu condition.** Federgruen-Heching probaron BSLP para backorder; en lost-sales requiere LSR-elasticity > 0.5 (Kocabıyıkoğlu-Popescu 2011). **Solución**: simulación Monte Carlo antes de creerlo.

**6. Recomendaciones que no se ejecutan.** El #1 modo de falla en pricing implementations (consenso enterprise vendors): el modelo recomienda, nadie cambia el precio en ML, el algoritmo aprende del status-quo. **Solución**: integración directa con `PUT /items/{id}` con human-in-the-loop UI (founder aprueba batch diario en <5 min).

**7. Algorithmic collusion risk.** Deng-Schiffer-Bichler (arXiv:2406.02437, 2024) muestran que Q-learning genera patrones colusorios; PPO menos. En Chile, FNE puede investigar paralelismo de precios. **Mitigación**: usa bandits/PPO (no Q-learning), audita patrones cada 3 meses.

**8. Selección de elasticidad antes de tener IV defendible.** Si tu $\hat{\beta}$ está sesgado hacia cero (típico endogeneity), subestimas el lift de markdown y bajas precio menos de lo óptimo. **Solución**: empieza con prior de literatura ($\beta = -1.5$ para textiles); reemplaza con DML sólo cuando F-stat IV >10.

**9. Confiar en `price_to_win` como verdad.** Es sugerencia algorítmica de ML basada en el catálogo; ignora tu posición de stock, costos, capacidad. **Solución**: úsalo como anchor pero no como decisión final.

**10. Ignorar broken-assortment ($I < I^*$).** Smith-Achabal: cuando stock cae bajo umbral, demanda colapsa estructuralmente. Bajar precio de un SKU con 2 unidades en stock no funciona. **Solución**: regla `lifecycle_stage = 'dead'` cuando stock < 5 Y velocidad < 0.2/sem; matar o bundle, no liquidar individualmente.

---

# Síntesis ejecutiva: top 10 acciones en orden de prioridad

1. **Esta semana — desplegar `sku_daily_snapshot`.** El gap Layer 2 es el cuello de botella de todo. Sin esto, ninguna fase posterior es defendible. ~15 horas Raimundo.

2. **Semanas 1-2 — backfill 90 días + tabla `lots` con FIFO.** Recupera lo que ML API permite + reconstruye costos históricos. Crítico para márgenes correctos.

3. **Semanas 1-4 — scraper top-50 + Real Trends activo.** USD 100/mes total. Sin competitive layer no calibras `price_max` ni detectas que estás 30% sobre/bajo el mercado.

4. **Semanas 5-8 — Operación Limpieza con Caro-Gallien adaptado.** Implementa el `cvxpy` LP del 3.C. Target: liquidar CLP 5.6M en 12 semanas, recuperar ≥85% del costo. Mata 20-30 SKUs sin esperanza vía descarte Full.

5. **Semanas 9-12 — A/B controlled de Operación Limpieza.** 30 SKUs control matched-pair vs 71-99 tratamiento. Es tu primer test causal real y tu defense de los resultados.

6. **Mes 4-6 — `pricing_rules` + BSLP simplificado por familia.** Federgruen-Heching aplicado pragmáticamente. Target: 80% decisiones de precio automatizadas, stockouts Full -50%.

7. **Mes 4-6 — Reglas Full-vs-Flex automatizadas.** Limpia el costo invisible de tener slow-movers en Full. Estimo ahorro CLP 100-300K/mes en storage.

8. **Mes 7-12 — DML elasticity (`econml`) pooled por familia.** Validar con IV de FX (eres importador). Reemplaza Reglas crudas Fase 2.

9. **Mes 12-18 — Bandits Misra-Schwartz-Abernethy en SKUs nuevos.** Acelera price discovery 3× vs prueba humana.

10. **Continuo — auditoría trimestral.** (a) ¿elasticidades siguen estables? (b) ¿bandits no derivan a colusión? (c) ¿márgenes reales = márgenes reportados? (d) ¿stockouts y over-stocks balanceados?

**Inversión total ~12 meses:** ~600 horas Raimundo + USD 1,500-2,500 infra/data + ~CLP 1.5M Mercado Ads para Operación Limpieza = **~CLP 12-15M de costo total**.

**Retorno esperado año 1 conservador:** CLP 6-7M de Operación Limpieza + 1.5% margen sobre CLP 1,200M revenue anual = CLP 18M = **CLP 24-25M total = ROI ~70-100%**, payback ~7-10 meses.

**Retorno año 2 (estado estable Fase 3-4):** 3-4% margen sobre revenue creciente ≈ CLP 60-80M anuales, mientras los costos de mantenimiento caen a ~150 horas/año + USD 3K infra.

El moat real no es ningún algoritmo individual — es tener **Layer 2 sólido** + **disciplina de actualizar precios semanalmente con un modelo, no con intuición**. Los enterprise vendors cobran USD 500K para vender exactamente esa disciplina envuelta en branding. Construirla en 6-8 semanas es factible para tu stack y tu equipo.

---

## URLs y DOIs de referencia (extracto crítico)

- Smith-Achabal 1998: https://doi.org/10.1287/mnsc.44.3.285
- Caro-Gallien 2012 PDF: http://personal.anderson.ucla.edu/felipe.caro/papers/pdf_FC15.pdf
- Federgruen-Heching 1999 PDF: https://business.columbia.edu/sites/default/files-efs/pubfiles/4090/federgruen_pricing.pdf
- Gallego-van Ryzin 1994 PDF: https://business.columbia.edu/sites/default/files-efs/pubfiles/3943/vanryzin_optimal_dynamic_pricing.pdf
- Bitran-Mondschein 1997: https://doi.org/10.1287/mnsc.43.1.64
- Cohen-Kalas-Perakis 2021 PDF: https://maxccohen.github.io/Promotion-Optimization-for-Multiple-Items-in-Supermarkets.pdf
- Chernozhukov et al. 2018 (DML): https://doi.org/10.1111/ectj.12097 — arXiv:1608.00060
- Wager-Athey 2018 (Causal Forests): arXiv:1510.04342
- Misra-Schwartz-Abernethy 2019: https://doi.org/10.1287/mksc.2018.1129
- Tang-Qi-Fang-Shi 2025 (M&SOM, censored demand): https://doi.org/10.1287/msom.2024.1061
- Hua et al. 2021 (Alibaba Freshippo): arXiv:2105.08313
- Mussi et al. 2023 (PVD-B AAAI): arXiv:2211.09612
- Gijsbrechts et al. 2022 (M&SOM RL): https://doi.org/10.1287/msom.2021.1064
- Badanidiyuru-Kleinberg-Slivkins 2018 (BwK): arXiv:1305.2545
- ML Developers Chile: https://developers.mercadolibre.cl/
- ML Trends API: https://developers.mercadolibre.cl/es_ar/tendencias
- ML Price-to-win/Benchmarks: https://global-selling.mercadolibre.com/devsite/pricing-reference
- Costos Full Chile: https://www.mercadolibre.cl/ayuda/costos-operar-full_20522
- `econml`: https://econml.azurewebsites.net/
- `DoubleML`: https://docs.doubleml.org/
- `MABWiser`: https://github.com/fidelity/mabwiser
- `stockpyl`: https://github.com/LarrySnyder/stockpyl
- `nixtla/neuralforecast` (TFT, N-HiTS): https://nixtlaverse.nixtla.io/

Ese es el mapa completo. La acción que mueve la aguja desde mañana es desplegar el `sku_daily_snapshot`. Todo lo demás se construye encima.