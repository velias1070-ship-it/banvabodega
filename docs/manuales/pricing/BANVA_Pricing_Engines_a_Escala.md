# Pricing engines a escala: qué hacen los grandes y qué de eso replicas en BANVA

## Resumen ejecutivo

**Tesis principal:** a tu escala (425 SKUs, ~$60M CLP/mes, 13% margen neto, marketplace puro) **no necesitas RL ni deep learning para pricing**. La evidencia empírica es contundente: incluso Walmart, Alibaba y Airbnb operan capas rule-based bajo sus modelos ML, y los papers que comparan rules vs bandits vs RL muestran que **bandits Thompson Sampling capturan ~95% del óptimo en 1.000 observaciones** (Misra et al. 2019, *Marketing Science*) mientras que RL solo se valida en producción a escalas de miles de transacciones por SKU. La arquitectura correcta para BANVA es: **rules engine custom en TypeScript + Postgres con JSONB validado por `pg_jsonschema`, elasticidad jerárquica Bayesiana solo sobre el top 10–15% de KVIs, content-addressable rule sets para versioning, y append-only decision log estilo Modern Treasury**. La parte más valiosa para ti no es "el algoritmo" — es **el sistema de guardrails (floors, ceilings, kill-switches, anomaly detection) que previno que terminaras como el libro de $23.698.655 de Amazon** (Eisen 2011) o como los sellers de RepricerExpress que perdieron £100k en una hora (Fortune 2014). Más importante aún: en Chile, bajo Ley 19.496 art. 12 y la jurisprudencia *Sernac v. Dell* (2009), **el precio publicado obliga**, y la FNE acaba de cerrar (marzo 2026) un estudio de mercado de e-commerce que explícitamente identifica riesgos de "colusión algorítmica". Tu kill-switch no es opcional — es defensa legal. Este documento traza la evolución concreta: **rules-first ahora → elasticidad jerárquica cuando tengas 6 meses de historia limpia → bandits TS solo sobre KVIs cuando un SKU pase ~100 ventas/mes → RL probablemente nunca a tu escala**.

---

## 1. Cómo lo hacen los grandes (Bloque A)

### 1.1 Amazon Retail (1P): tres algoritmos en capas, no uno

Lo más detallado públicamente sobre la arquitectura de pricing de Amazon Retail **viene de la demanda FTC v. Amazon** (Caso 2:23-cv-01495-JHC, complaint redacted nov 2023). La FTC describe tres capas algorítmicas distintas:

1. **Anti-discounting / matching algorithm**: monitorea precios de sellers terceros fuera de Amazon y los penaliza en el Buy Box si bajan precio en otra parte. La FTC lo describe como *"a 'game theory approach,' never making the first move and instead disciplining rivals by rapidly copying others' moves to the penny, both up and down"*.
2. **Featured Merchant Algorithm (Buy Box)**: **~98% de las compras pasan por el Buy Box**, según la propia FTC.
3. **Project Nessie**: algoritmo predictivo que identificaba productos donde Amazon estimaba que la competencia *seguiría* un alza de precio. *"In April 2018 alone, Nessie was used to raise the prices of more than eight million items that collectively cost nearly $194 million"* — generó **US$1.4B en utilidad incremental 2016–2018**. Detalle clave para ti: Amazon **pausaba Nessie durante Prime Day y feriados** ("increased media focus and customer traffic") y lo reactivaba después. Eso es un **kill-switch operacional documentado** que tu sistema debe replicar para CyberDay y Black Friday Chile.

Por el lado de demanda y elasticidad, Amazon Science publicó la evolución de su forecasting: empezaron con módulos especializados (uno para elasticidad, uno para errores, "Distribution Engine") y migraron a un **MQ-RNN/CNN unificado, multi-horizonte, sobre Apache Spark, que escala a millones de SKUs** (Amazon Science, "The history of Amazon's forecasting algorithm"). El paper público más útil arquitectónicamente es **Cooprider & Nassiri, "Science of price experimentation at Amazon"** (assets.amazon.science): documenta que Amazon usa **Poisson cross-price elasticity models** sobre ~1 año de historia y experimentos **crossover** (semanas 7–9 / 10–12) para lidiar con efectos de carryover en demanda — porque el demand de hoy contamina el de mañana vía recomendaciones y queries.

**Caveat crítico:** las descripciones de Nessie son alegaciones FTC, disputadas por Amazon. El portavoz Tim Doyle declaró: *"Nessie was used to try to stop our price matching from resulting in unusual outcomes where prices became so low that they were unsustainable… didn't work as intended, so we scrapped it"*. Pero la **descripción mecánica** del algoritmo es la única documentación pública detallada que existe sobre pricing de un hyperscaler.

### 1.2 Walmart: markdown clearance + plataforma Element, NO el RL paper que circula

**Hallazgo importante de mitos**: el paper "Dynamic Pricing on E-commerce with Deep RL" que se cita frecuentemente como "el paper de Walmart" es en realidad **de Alibaba/Tmall** (Liu et al. 2019, arXiv:1912.02572). No existe paper peer-reviewed de Walmart sobre RL en pricing.

Lo que Walmart sí publicó (Tier 1):
- **Chen, Mehrotra et al. (2021), "A Multiobjective Optimization for Clearance in Walmart Brick-and-Mortar Stores", *INFORMS Interfaces* 51(1):76–89**. Política de markdown personalizada *por tienda* (no chain-wide). Resultado: **+21% sell-through, −7% costos**.
- **Ganti, Sustik, Tran, Seaman (Walmart Labs, 2018), "Thompson Sampling for Dynamic Pricing", arXiv:1802.03050**. Despliegue real: TS con elasticidad constante por SKU (un parámetro), test de 5 semanas, supera estadísticamente al baseline pasivo "estimar y optimizar".
- **Sarpal et al. (Walmart Labs), KDD 2019, "Anomaly Detection for an E-commerce Pricing System"** y arXiv:2310.04367 (2023). **Esto es lo más importante para BANVA**: usan ensemble de **LOF + Isolation Forest + XGBoost + Random Forest** sobre los *outputs* del pricing engine antes de publicar; ofertas que exceden un "anchor price" (típicamente el listing 1P) se **auto-despublican** hasta revisión humana.

Escala operacional declarada en el blog Walmart Global Tech ("Cost orchestration at Walmart"): **40 millones de updates de costo/día, 80 millones de items repreciados/día, 300 millones de attribute updates/día**. Plataforma ML interna: **Element** (Kubernetes-based, multi-cloud).

**Posicionamiento legal de Walmart (2026)**: tras dos patentes USPTO sobre pricing, declararon explícitamente *"We don't participate in surge pricing"* y rebrandearon su práctica como **"algorithmic merchandising"** (PYMNTS, 2026). Lección de governance: *cómo nombras tu sistema importa* en evidencia regulatoria.

### 1.3 MercadoLibre: 28M cambios de precio/día y bandera explícita de no-A/B testing

La fuente más valiosa es **Camilo Ernesto Martínez (equipo de pricing ML), "E-Commerce Pricing Anecdotes"** (medium.com/mercadolibre-tech, dic 2023). Datos directos:

- **28 millones de cambios de precio diarios** en todo el marketplace.
- *"automated algorithms combine factors such as competitiveness, revenue, and inventory levels"* — **ensemble de factores, no ML puro**.
- **Cadencia por categoría**: bestsellers cambian hasta **15 veces/día**, pero **"home and living can just chill at the same price for a good while"** — señal directa para BANVA: tu categoría es de baja frecuencia óptima de repricing.
- **Estacionalidad**: enero suele estar **−7% a −16%** vs diciembre.
- **Cadencia humana**: sellers exitosos repriciando **~3 veces/mes/SKU** (≈36/año).
- **Política explícita anti-A/B en precios**: *"these strategies have not been implemented, as the price is the same regardless of who is observing"*. Esto es un **precedente de governance LATAM** que debes adoptar literalmente — no hagas A/B testing de precios al mismo SKU para distintos compradores.

Adicionalmente, ML expone un repricer nativo vía API (`POST /marketplace/items/{ITEM_ID}/prices/automate`) con `rule_id ∈ {INT, INT_EXT}` y `min_price`/`max_price` obligatorios, y se desactiva automáticamente si el seller cambia precio manualmente. Esto te indica el patrón mental de ML: **rule-based con guardrails humanos como default**.

No existe blog post de mercadolibre.tech detallando infraestructura de pricing (DBs, latencias, Kafka). El blog cubre el *qué*, no el *cómo*.

### 1.4 Alibaba/Tmall: el único RL en producción públicamente validado

**Liu et al. (2019), "Dynamic Pricing on E-commerce Platform with Deep Reinforcement Learning: A Field Experiment", arXiv:1912.02572**. Es el paper más citado en RL para pricing retail. Arquitectura:

- MDP con cuatro grupos de features de estado: **price, sales, customer traffic, competitiveness**.
- Action space discreto (DQN, K=100 puntos de precio) y continuo (DDPG).
- Innovación clave: **DRCR (Difference of Revenue Conversion Rates) como reward**, no revenue directo. Razón: en FMCG la correlación precio↔conversion-rate es +0.15 (ruido). Reward de revenue puro **no converge**. DRCR sí.
- Cold-start: **pre-training sobre decisiones de pricing humanas históricas** (estilo DQfD).
- **Sin A/B testing por razón legal**: *"it is impossible to do online A/B testing, because it is illegal to set different price for the same product to different customers"* — usan **Difference-in-Differences** con SKUs control matched.
- Resultado: DDPG ~6× y DQN ~5× sobre baseline manual (en métrica DRCR, no revenue).

**Alerta de aplicabilidad para ti**: los autores explícitamente advierten que *"low-sales-volume products may not have sufficient training data"* — **tu long tail no califica para RL**. El experimento corrió sobre miles de SKUs con tráfico Tmall (varios órdenes de magnitud sobre $60M CLP/mes).

Sobre **JD.com y Shopee**: hay papers académicos terceros usando datos JD vía API, pero **no hay engineering blog post propio de JD ni Shopee sobre arquitectura de pricing**. La frase "Asian retailer with elasticity over 10TB transactions" que circula en decks SaaS es **mitología no verificable** — probablemente referencia distorsionada al paper Alibaba.

### 1.5 Airbnb, Uber, DoorDash: los patrones más transferibles a retail

**Airbnb (Ye et al., KDD 2018, "Customized Regression Model for Airbnb Dynamic Pricing")**. Arquitectura de tres etapas:
1. Modelo de **booking probability** (clasificación binaria, GBM por mercado).
2. Regresión de precio óptimo con **loss asimétrica custom** que penaliza simultáneamente "predije muy bajo y se reservó" (dejaste plata) y "predije muy alto y no se reservó" (perdiste venta).
3. Capa de personalización.

Es el patrón correcto para catálogos con **alta heterogeneidad de SKU** (cada listing es único — análogo a tus textiles donde cada SKU tiene tela, tamaño, color distintos). Decompone P(venta) × precio en lugar de asumir curva de demanda agregada.

**DoorDash ("Building a better Pricing Framework", careersatdoordash.com)** — la arquitectura más directamente portable a tu stack:

- Stack: Kotlin + gRPC + Redis + Cassandra. **Para BANVA: TypeScript/Next.js + Postgres + cache (Vercel KV o Upstash Redis)**.
- **Pipeline con context y registry pattern**: cada request lleva metadata (user/store/cart); componentes de precio (line items) se evalúan en orden de dependencia. **Más de 10 line items componen el precio final**.
- **Price lock en Redis**: garantiza consistencia entre precio mostrado y cobrado.
- **Auditoría por diseño**: *"the pricing service stores immediate price quote results in the database for monitoring, auditing, and debugging. We also persist all the metadata in the context so that we can rerun a specific request with the same metadata"* — esta es la práctica que adoptas.
- Migraron a CockroachDB (Postgres-compatible) para feature store con **−75% costo**.

**Uber ("Disaster recovery for multi-region Kafka")**: Kafka regional → Flink jobs computan pricing → service active/active → DB active/active para lookup. Sharding geográfico vía **H3 hexagonal cells** (open source). Para BANVA esto es overkill, pero el patrón **streaming features → pricing engine → cached output** es replicable como `materialized view` Postgres + cache.

### 1.6 Open source: hallazgo honesto

**No existe pricing engine open-source con +1k stars que combine rules + elasticidad para retail**. Las búsquedas en GitHub (`topic:pricing-engine`, `topic:dynamic-pricing`) están dominadas por (a) pricing de derivativos quant (Monte Carlo, Heston), (b) billing engines SaaS, (c) proyectos académicos <100 stars. El más cercano (PricePulse) es un portfolio project. **Tendrás que construir.**

---

## 2. Algoritmos y modelos: qué se justifica a tu escala (Bloque B)

### 2.1 Estado del arte 2024–2026 — los papers que importan

| Paper | Venue | Relevancia para BANVA |
|---|---|---|
| Russo & Van Roy (2018), "A Tutorial on Thompson Sampling", arXiv:1707.02038 | Foundations & Trends ML | **Referencia canónica**. El patrón Beta-Bernoulli TS con aproximación Laplace es lo más simple que puedes desplegar por SKU sobre una grilla de 5 precios. |
| Ganti et al. (Walmart, 2018), "Thompson Sampling for Dynamic Pricing", arXiv:1802.03050 | Walmart Labs | Producción real con elasticidad constante por SKU. Patrón directamente replicable. |
| Misra, Schwartz, Abernethy (2019), "Dynamic Online Pricing with Incomplete Information", *Marketing Science* 38(2) | T1 | **El número que justifica bandits**: tras 1.000 observaciones de precio, bandit captura **~95% del óptimo** vs **66% de un experimento balanceado**. |
| Ferreira, Simchi-Levi, Wang (2018), "Online Network Revenue Management Using Thompson Sampling", *Operations Research* 66(6) | T1 | TS + LP para handle restricciones de inventario multi-SKU. |
| Liu et al. (Alibaba, 2019), arXiv:1912.02572 | T1 producción | Único RL field-validated; útil para la *idea* del DRCR reward. |
| Uma Maheswari et al. (CODS-COMAD 2024), "Contextual Bandits for Online Markdown Pricing" | T1 producción (kids' apparel, 800 stores) | **Bandits contextuales superan a RL** en escenarios sparse + non-stationary. Evidencia directa contra adoptar RL prematuro. |
| Apte et al. (2024), "Dynamic Retail Pricing via Q-Learning", arXiv:2411.18261 | T1 (simulator-only) | **Caveat**: solo simulator, no field-validated. |
| arXiv:2604.14059 (2026), "Comparative Study of DP and RL in Finite-Horizon Dynamic Pricing" | T1 | **Con 40–400 episodes de training, Fitted DP supera consistentemente a DQN/A2C/PPO**. RL solo iguala con cientos a miles de episodes. |

### 2.2 Estimación de elasticidad con datos sparse — qué funciona en long tail

A 425 SKUs con $60M CLP/mes, la mediana de tus SKUs probablemente vende **<20 unidades/mes**. Métodos:

- **OLS log-log naive**: produce muchísimas elasticidades positivas o cero a nivel SKU — **inutilizable**. Confirmado por Orduz, "Hierarchical Pricing Elasticity Models" (juanitorduz.github.io/elasticities).
- **Bayes jerárquico (partial pooling)**: tres niveles **Global → Categoría (toallas/sábanas/cobertores/decoración) → SKU**. Bhuwalka et al. (MIT, *J. Industrial Ecology* 2022) reportan **reducción 1.6–2.3× de error estándar con solo 15 obs/grupo**. **Esta es tu ruta default**.
- **DML (Double/Debiased ML)** — Chernozhukov et al. (2018) *Econometrics Journal* 21. DoorDash lo aplicó en su blog "Smarter Promotions with Causal Machine Learning" (2025). Frisch-Waugh residualization con cross-fitting + ML para nuisance functions, OLS final para el coeficiente de elasticidad. **Apropiado cuando tienes confounders ricos (calendario, promos competidores, tráfico ML)**.
- **BLP (Berry-Levinsohn-Pakes 1995)**: foundational pero **overkill para 425 SKUs sin instrumentos de costo válidos**.
- **Embeddings de producto + k-NN para compartir información**: Zhao et al. (Alibaba, "Learning and Transferring IDs Representation in E-commerce", arXiv:1712.08289) — entrenas embeddings (texto + imagen + co-purchase) y para SKU nuevo tomas elasticidad media de los k vecinos.

### 2.3 Trade-offs empíricos rules vs ML vs RL por volumen

Síntesis de la evidencia citada:

| Aproach | Cuándo se justifica | Evidencia |
|---|---|---|
| **Rules-based puro** | <50–100 transacciones/SKU/mes; long tail | Pryse Eng heuristic: "200 tx/mes sobre 3.000 SKUs = AI no aprende". Implícito en Walmart y Airbnb (rules debajo de ML). |
| **Bayes jerárquico de elasticidad** | A partir de ~15 obs/grupo | Bhuwalka 2022; Bhaduri 2017. **Tu default para los ~85% SKU long-tail**. |
| **TS bandit por SKU sobre grilla 5 precios** | SKUs con ≥100 ventas/mes (KVIs) | Misra 2019: 95% óptimo en 1.000 obs. Ganti 2018: producción Walmart. |
| **Bandits contextuales (LinUCB / LinTS)** | Cuando tienes contexto rico (estación, stock, competidor) | CODS-COMAD 2024: superan RL. |
| **Deep RL (DQN/DDPG/PPO)** | Solo escala Tmall+ | Liu 2019 explícitamente flag long-tail no aprende. arXiv:2604.14059: con <400 episodes, DP supera RL. **No justificado para BANVA**. |

### 2.4 Cold start: cómo arrancar SKUs nuevos

- **Embedding-based prior**: para SKU nuevo, k-NN sobre embedding de atributos (categoría, fibra, tamaño, color, supplier, image embed) → toma elasticidad mediana de vecinos como prior informado. Validado en eBay (Brovman et al., arXiv:2102.06156): >50% de items son únicos single-quantity y los embeddings content-only logran +6% surface rate A/B.
- **Dynamic Prior TS** (Zhao et al., arXiv:2602.00943): reemplaza el Beta(1,1) ingenuo por prior cuadrático que apunta a probabilidad ε de superar al incumbente. **Drop-in para lanzamientos**.
- **Pre-train sobre decisiones humanas**: lo que Liu/Alibaba usan — bootstrap el modelo desde lo que ya hicieron pricing managers.
- **Transfer learning estilo Airbnb**: GBM entrenado por mercado/categoría usa solo features del listing (no historia) → un SKU nuevo con foto, fibra, dimensiones predice booking-prob desde el día 1.

### 2.5 KVIs (Key Value Items): qué SKUs son los que el cliente "recuerda"

Metodología defendible (síntesis McKinsey "Pricing in Retail" + ClearDemand + Anderson & Simester sobre signpost pricing):

Score compuesto por SKU:
1. Velocidad de venta (unidades/mes, normalizada por categoría).
2. Frecuencia de búsqueda / page-views.
3. Centralidad en co-purchase (basket attachment).
4. |Elasticidad estimada| (del modelo Bayes jerárquico).
5. **Transparencia competitiva**: ¿existe el mismo SKU en competidores ML, fácil de comparar?

Top 5–15% por score → KVIs (precio match competidor, bandit ajustado, margen bajo, son tus driver de tráfico). El resto **subes o mantienes margen** porque la elasticidad es baja y la comparación es costosa para el comprador.

**Caveat**: el "5–15% es KVI" es folklore consultor (McKinsey/Bain). **No hay paper peer-reviewed que justifique un % específico**. Calíbralo midiendo qué porcentaje de tus búsquedas/visitas ML concentra el top-quintil de SKUs.

---

## 3. Esquema de DB y evaluación de reglas (Bloque C)

### 3.1 Patrón híbrido: columnas tipadas + JSONB validado

Martin Fowler ("Rules Engine", "Production Rule System", "Refactoring to an Adaptive Model") establece el patrón canónico: **rule = {condition, action}**, con almacenamiento desacoplado del código imperativo. Para Postgres/Supabase la regla del pulgar viene del Heap Engineering blog ("When To Avoid JSONB"): *"PostgreSQL has no way of knowing that record→>'value_2' = 0 will be true 50% of the time, so it relies on a hardcoded estimate of 0.1%"*. Conclusión: **columnas tipadas para lo que filtras (priority, validez temporal, status, scope) + JSONB para el AST de predicados variables**, con `pg_jsonschema` en Supabase para CHECK constraint.

### 3.2 Resolución de conflictos: DMN-style, no salience Drools

Drools (RH 7.9 docs) usa **salience** (entero, default 0; mayor dispara primero) con tie-break por orden en source file. Phreak indexa por sequence number. **No lo recomiendo para ti**: Fowler advierte *"the interaction of rules can often be quite complex… nobody can understand this implicit program flow"*.

**Adopta hit policies DMN** (Camunda 8 spec):
- **Unique** (default): exactamente una regla puede matchear; violación = error.
- **First**: primera fila que matchea gana (orden importa).
- **Priority**: output seleccionado por lista de prioridad de output values.
- **Collect+aggregation** (`C+`, `C<`, `C>`, `C#`): para descuentos que stackean.

Para pricing, el camino correcto es **First-match con priority entero como tiebreaker**, más un `mode` por rule-group (`first | best | collect`) cuando haya descuentos compuestos.

### 3.3 Engine genérico vs custom: para ti es custom TS

| Engine | Cuándo elegirlo |
|---|---|
| **Drools** | ≥10k reglas con chaining, equipo Java, escala enterprise. **Overkill brutal para BANVA**. |
| **Camunda DMN** | Si analistas de negocio van a editar reglas y ya corres Camunda. |
| **GoRules Zen-Engine** | Embeddable Rust con bindings Node, JDM JSON checkable en Git, push S3 → Agent atomic reload. **Buena opción si quieres autoría no-dev de reglas.** |
| **Custom TS evaluator + JSON predicate AST** | **Tu caso**: <1000 reglas, equipo pequeño, máximo control. |
| **PL/pgSQL functions** | Cuando la regla *es* un query (rule = row, evaluador = SQL function). |

ThoughtWorks Tech Radar: *"We've seen too many people tying themselves to a hard-to-test black-box rules engine for spurious reasons, when custom code would have been a better solution"*. **Empieza custom TS.**

### 3.4 Versioning, rollback, A/B sin downtime: content-addressable rule sets

Patrón derivado de Marfeel (content-addressable como Git) y GoRules architecture (publish → S3 → Agent polls etag → atomic reload):

```sql
CREATE TABLE pricing_rule_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_hash text UNIQUE NOT NULL,    -- sha256 del JSON canónico
  rules jsonb NOT NULL,
  parent_id uuid REFERENCES pricing_rule_sets(id),
  created_at timestamptz DEFAULT now(),
  created_by uuid,
  notes text
);

CREATE TABLE pricing_rule_set_pointers (
  channel text PRIMARY KEY,             -- 'production' | 'canary' | 'shadow'
  rule_set_id uuid REFERENCES pricing_rule_sets(id),
  rollout_pct numeric DEFAULT 100 CHECK (rollout_pct BETWEEN 0 AND 100),
  updated_at timestamptz DEFAULT now()
);
```

Promote = update 1 row. Rollback = update otra vez al hash anterior. Bucketing canary: `hash(customer_id || rule_set_id) % 100 < rollout_pct`. Patrón shadow-mode (Flagsmith): computas precio candidato pero no lo aplicas, logueas (current, candidate, delta) — comparas distribuciones offline antes de promover.

**Importante para Chile**: A/B testing con precios diferentes a clientes distintos para el mismo SKU **es legalmente expuesto** bajo Ley 19.496 y la política explícita de ML (*"the price is the same regardless of who is observing"*). Tu A/B es entre **versiones del rule set en periodos disjuntos**, no entre compradores simultáneos.

### 3.5 Auditoría: append-only ledger

Patrón Modern Treasury / Square Books / Stripe Ledger: *"All changes are preserved, and any previous state can be reconstructed [from] the immutable, append-only log"*. Aplicado a pricing decisions:

```sql
CREATE TABLE pricing_decision_log (
  id              bigserial PRIMARY KEY,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  request_id      uuid NOT NULL,
  sku             text NOT NULL,
  input_snapshot  jsonb NOT NULL,                -- TODO lo que vio el evaluador
  rule_set_hash   text NOT NULL REFERENCES pricing_rule_sets(content_hash),
  channel         text NOT NULL,
  base_price_cents     bigint NOT NULL,
  final_price_cents    bigint NOT NULL,
  fired_rule_ids       uuid[] NOT NULL,
  decision_explanation jsonb NOT NULL
) PARTITION BY RANGE (occurred_at);

REVOKE UPDATE, DELETE ON pricing_decision_log FROM PUBLIC;
CREATE INDEX ON pricing_decision_log (sku, occurred_at DESC);
CREATE INDEX ON pricing_decision_log USING gin (input_snapshot jsonb_path_ops);
```

Beneficios documentados (Architecture Weekly sobre Stripe Ledger): *"5 billion events/day… No discrepancy is ever fixed by modifying an existing ledger entry. Every correction is a new entry that references the original"*. Para tu volumen (<1GB/mes), partición mensual + retención 18 meses caliente, archivar más viejo a Supabase Storage en Parquet.

---

## 4. Tabla comparativa de aproximaciones algorítmicas

| Aproximación | Complejidad implementación | Datos requeridos | Lift esperado | Cuándo aplica BANVA |
|---|---|---|---|---|
| Rules-based puro (cost-plus + competitor delta) | Baja | Costos + scrape competidor | Baseline | **Hoy, sobre 100% del catálogo** |
| Bayes jerárquico elasticidad (3 niveles) | Media (PyMC/NumPyro) | 6+ meses historia ventas con variación de precio | +3–8% margen documentado en industria | **Mes 6, sobre 100% catálogo** |
| Thompson Sampling Beta/Logístico por SKU | Media | ≥100 ventas/SKU/mes | Misra: 95% óptimo en 1k obs | **Solo top 10–15% KVIs**, mes 9+ |
| LinUCB / contextual TS | Media-alta | Features contextuales (estación, stock, competidor) | CODS-COMAD: supera RL en sparse | Si tu KVI set crece a 200+ SKUs |
| DML para elasticidad causal | Alta | Confounders ricos (promos, calendario, tráfico) | DoorDash: substancial en promos | Cuando empieces campañas Mercado Ads serias |
| Deep RL (DQN/DDPG) | Muy alta | Miles tx/SKU/mes | Liu: 5–6× DRCR (no revenue) | **No aplica a BANVA en 3+ años** |

---

## 5. Patrones arquitectónicos — diagrama referencial

Stack recomendado para BANVA (Next.js + Supabase + Vercel + n8n):

```
                        ┌──────────────────────────────┐
                        │  n8n / cron job (diario)     │
                        │  - scrape competidores ML    │
                        │  - actualizar costos         │
                        │  - recompute elasticities    │
                        └──────────────┬───────────────┘
                                       │
                                       ▼
┌─────────────┐   webhook       ┌──────────────────────────────────┐
│ ML API      │ item_competition │  Pricing Engine (Vercel route)   │
│ items_prices│ ───────────────▶ │  - load rule_set (pointer)       │
└─────────────┘                  │  - evaluate JSONB AST in TS      │
                                 │  - first-match + priority        │
                                 │  - apply hard guardrails         │
                                 └──────────────┬───────────────────┘
                                                │
                       ┌────────────────────────┼─────────────────────┐
                       ▼                        ▼                     ▼
              ┌─────────────────┐    ┌────────────────────┐  ┌───────────────────┐
              │ price BEFORE    │    │ pricing_decision   │  │ price_review_queue│
              │ INSERT TRIGGER  │    │ _log (append-only) │  │ (anomalies)       │
              │ validate_price  │    │ partitioned monthly│  │ → Slack alert     │
              └─────────────────┘    └────────────────────┘  └───────────────────┘
                       │
                       ▼
              ┌──────────────────────┐
              │ prices (current)     │
              │ + price_history      │
              └──────────┬───────────┘
                         │ outbox / Realtime CDC
                         ▼
              ┌──────────────────────┐
              │ ML publisher worker  │
              │ POST /items/{id}     │
              └──────────────────────┘
```

Componentes derivados de DoorDash (registry + orchestrator + price lock + audit), Walmart (anomaly detection ensemble), Airbnb (decoupled booking-prob × price), MercadoLibre (min/max obligatorio).

---

## 6. Schema SQL DDL referencial (para Postgres/Supabase)

```sql
-- =============================================================
-- 1. Catálogo y costos (input)
-- =============================================================
CREATE TABLE sku_economics (
  sku_id              text PRIMARY KEY,
  cogs_cents          bigint NOT NULL,
  category            text NOT NULL,
  ml_commission_pct   numeric(5,4) NOT NULL,
  msrp_cents          bigint,
  weight_g            int,
  volume_cm3          int,
  fulfillment_default text CHECK (fulfillment_default IN ('full','flex','custom')),
  updated_at          timestamptz DEFAULT now()
);

CREATE TABLE sku_price_bounds (
  sku_id        text PRIMARY KEY REFERENCES sku_economics(sku_id),
  min_price_cents bigint NOT NULL,
  max_price_cents bigint NOT NULL,
  ceiling_multiplier numeric DEFAULT 1.5,
  max_daily_changes  int DEFAULT 4,
  max_daily_pct_move numeric DEFAULT 0.20,
  CHECK (min_price_cents < max_price_cents)
);

-- =============================================================
-- 2. Rules engine
-- =============================================================
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE pricing_rule_sets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_hash  text UNIQUE NOT NULL,
  rules         jsonb NOT NULL,
  parent_id     uuid REFERENCES pricing_rule_sets(id),
  created_at    timestamptz DEFAULT now(),
  created_by    uuid,
  notes         text,
  CHECK (jsonb_matches_schema(
    '{"type":"object","required":["rules"],
      "properties":{"rules":{"type":"array","items":{
        "type":"object",
        "required":["id","priority","scope","conditions","action"],
        "properties":{
          "id":{"type":"string"},
          "priority":{"type":"integer"},
          "scope":{"type":"object"},
          "conditions":{"type":"object"},
          "action":{"type":"object"},
          "valid_from":{"type":"string","format":"date-time"},
          "valid_to":{"type":"string","format":"date-time"}
        }}}}}'::json,
    rules))
);

CREATE TABLE pricing_rule_set_pointers (
  channel       text PRIMARY KEY CHECK (channel IN ('production','canary','shadow')),
  rule_set_id   uuid NOT NULL REFERENCES pricing_rule_sets(id),
  rollout_pct   numeric DEFAULT 100 CHECK (rollout_pct BETWEEN 0 AND 100),
  updated_at    timestamptz DEFAULT now(),
  updated_by    uuid
);

-- =============================================================
-- 3. Política / kill-switches
-- =============================================================
CREATE TABLE pricing_policy (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz DEFAULT now(),
  updated_by  uuid
);
-- seed:
-- INSERT VALUES ('global_kill_switch', '{"enabled": false}');
-- INSERT VALUES ('z_threshold', '{"value": 3.0}');
-- INSERT VALUES ('paused_categories', '{"list": []}');

-- =============================================================
-- 4. Elasticidad y modelo
-- =============================================================
CREATE TABLE sku_elasticity (
  sku_id          text REFERENCES sku_economics(sku_id),
  model_version   text NOT NULL,
  elasticity_mean numeric NOT NULL,
  elasticity_sd   numeric NOT NULL,
  pooling_level   text NOT NULL,         -- 'sku' | 'category' | 'global'
  fitted_at       timestamptz DEFAULT now(),
  PRIMARY KEY (sku_id, model_version)
);

CREATE TABLE sku_kvi_score (
  sku_id            text PRIMARY KEY REFERENCES sku_economics(sku_id),
  velocity_z        numeric,
  search_freq_z     numeric,
  basket_attach_z   numeric,
  abs_elasticity_z  numeric,
  competitive_visibility_z numeric,
  composite_score   numeric,
  is_kvi            boolean GENERATED ALWAYS AS (composite_score > 1.0) STORED,
  updated_at        timestamptz DEFAULT now()
);

-- =============================================================
-- 5. Decision log (append-only, particionado)
-- =============================================================
CREATE TABLE pricing_decision_log (
  id                   bigserial,
  occurred_at          timestamptz NOT NULL DEFAULT now(),
  request_id           uuid NOT NULL,
  sku_id               text NOT NULL,
  channel              text NOT NULL,
  rule_set_hash        text NOT NULL,
  input_snapshot       jsonb NOT NULL,
  base_price_cents     bigint NOT NULL,
  final_price_cents    bigint NOT NULL,
  fired_rule_ids       text[] NOT NULL,
  decision_explanation jsonb NOT NULL,
  guardrail_blocked    boolean DEFAULT false,
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

REVOKE UPDATE, DELETE ON pricing_decision_log FROM PUBLIC;
CREATE INDEX ON pricing_decision_log (sku_id, occurred_at DESC);
CREATE INDEX ON pricing_decision_log USING gin (input_snapshot jsonb_path_ops);

-- =============================================================
-- 6. Cola de revisión humana
-- =============================================================
CREATE TABLE price_review_queue (
  id                bigserial PRIMARY KEY,
  sku_id            text NOT NULL,
  proposed_price_cents bigint NOT NULL,
  current_price_cents  bigint NOT NULL,
  reason            text NOT NULL,           -- 'z_score' | 'rate_limit' | 'bound_violation'
  context           jsonb NOT NULL,
  created_at        timestamptz DEFAULT now(),
  resolved_at       timestamptz,
  resolved_by       uuid,
  resolution        text                     -- 'approved' | 'rejected' | 'corrected'
);

-- =============================================================
-- 7. Stats rollover (materialized view, refresh cada 5 min)
-- =============================================================
CREATE MATERIALIZED VIEW sku_rolling_stats AS
SELECT
  sku_id,
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY final_price_cents) AS median_7d,
  STDDEV(final_price_cents)::numeric AS sd_7d,
  PERCENTILE_CONT(0.05) WITHIN GROUP (ORDER BY final_price_cents) AS p5_7d,
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY final_price_cents) AS p95_7d
FROM pricing_decision_log
WHERE occurred_at > now() - interval '7 days'
  AND guardrail_blocked = false
GROUP BY sku_id;

CREATE UNIQUE INDEX ON sku_rolling_stats (sku_id);

-- =============================================================
-- 8. Trigger validate_price (kill-switch, bounds, z-score, rate-limit)
-- =============================================================
CREATE OR REPLACE FUNCTION validate_price() RETURNS trigger AS $$
DECLARE
  v_kill_switch boolean;
  v_paused_cats jsonb;
  v_z_threshold numeric;
  v_bounds RECORD;
  v_stats RECORD;
  v_z numeric;
  v_changes_today int;
BEGIN
  -- kill-switch global
  SELECT (value->>'enabled')::boolean INTO v_kill_switch
    FROM pricing_policy WHERE key='global_kill_switch';
  IF v_kill_switch THEN
    INSERT INTO price_review_queue(sku_id, proposed_price_cents, current_price_cents, reason, context)
      VALUES (NEW.sku_id, NEW.final_price_cents, OLD.final_price_cents, 'global_kill_switch', to_jsonb(NEW));
    RETURN NULL;
  END IF;

  -- bounds duros (Lección Eisen 2011, RepricerExpress 2014)
  SELECT * INTO v_bounds FROM sku_price_bounds WHERE sku_id=NEW.sku_id;
  IF NEW.final_price_cents < v_bounds.min_price_cents OR
     NEW.final_price_cents > v_bounds.max_price_cents THEN
    INSERT INTO price_review_queue VALUES (DEFAULT, NEW.sku_id, NEW.final_price_cents,
      OLD.final_price_cents, 'bound_violation', to_jsonb(NEW), now(), NULL, NULL, NULL);
    RETURN NULL;
  END IF;

  -- z-score vs 7d median (estilo Walmart KDD 2019)
  SELECT (value->>'value')::numeric INTO v_z_threshold FROM pricing_policy WHERE key='z_threshold';
  SELECT * INTO v_stats FROM sku_rolling_stats WHERE sku_id=NEW.sku_id;
  IF v_stats.sd_7d > 0 THEN
    v_z := abs(NEW.final_price_cents - v_stats.median_7d) / v_stats.sd_7d;
    IF v_z > v_z_threshold THEN
      INSERT INTO price_review_queue VALUES (DEFAULT, NEW.sku_id, NEW.final_price_cents,
        OLD.final_price_cents, 'z_score', jsonb_build_object('z',v_z,'stats',row_to_json(v_stats)),
        now(), NULL, NULL, NULL);
      RETURN NULL;
    END IF;
  END IF;

  -- rate limit: max N cambios/día/SKU
  SELECT count(*) INTO v_changes_today FROM pricing_decision_log
    WHERE sku_id=NEW.sku_id AND occurred_at > now() - interval '24 hours' AND guardrail_blocked=false;
  IF v_changes_today >= v_bounds.max_daily_changes THEN
    INSERT INTO price_review_queue VALUES (DEFAULT, NEW.sku_id, NEW.final_price_cents,
      OLD.final_price_cents, 'rate_limit', jsonb_build_object('changes_today',v_changes_today),
      now(), NULL, NULL, NULL);
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_validate_price
  BEFORE INSERT OR UPDATE ON prices
  FOR EACH ROW EXECUTE FUNCTION validate_price();
```

---

## 7. Roadmap evolutivo: rules → elasticidad → bandits

Disparadores concretos para pasar de etapa:

**Fase 0 (mes 0–3) — Rules-first foundation:**
- Implementa schema completo con guardrails (`sku_price_bounds`, trigger, decision log).
- Reglas iniciales: cost-plus floor, MAP/MSRP ceiling, competitor delta cap, stock-aged markdown ladder.
- Decision log activo desde día 1.
- Webhook `item_competition` y `items_prices` enchufado a Vercel route, response <500ms (requisito ML).
- KPI gate para fase 1: **6 meses de decision log con ≥20% de SKUs con variación de precio ≥10%** (necesitas esa varianza para estimar elasticidad).

**Fase 1 (mes 6–9) — Elasticidad jerárquica Bayes:**
- NumPyro/PyMC corriendo en n8n cron diario, three-level (Global → Categoría → SKU).
- Fitted elasticity entra como input *aditivo* a las reglas (no las reemplaza). Regla nueva: "si elasticidad >−0.5 y stock >60d, sube precio 3%".
- DML para promos / Mercado Ads cuando lances campañas serias (reduce sesgo por confounders calendario).
- KPI gate para fase 2: **identificación robusta de KVIs** (top 10–15% por composite score, validado contra search frequency en GA o ML analytics) y **≥100 ventas/mes en al menos 30 SKUs**.

**Fase 2 (mes 9–18) — Thompson Sampling sobre KVIs:**
- Bandit Beta-Bernoulli o gaussiano sobre grilla de 5 precios por KVI.
- **Solo KVIs**, no long tail. Long tail sigue rules + elasticidad.
- Cold-start nuevos KVIs con prior cuadrático (Zhao 2026) o k-NN embedding.
- Shadow mode 4 semanas antes de canary, canary 5%→25%→100% con stable hashing.
- KPI gate para fase 3: **lift ≥3% sostenido en margen sobre el set KVI con p<0.05** y >200 SKUs en bandit.

**Fase 3 (improbable a tu escala) — Bandits contextuales / RL:**
- Solo si BANVA crece a $300M+ CLP/mes, >2000 SKUs activos y >100 tx/SKU/mes en al menos 200 SKUs.
- Aún así, evidencia (CODS-COMAD 2024, arXiv:2604.14059) sugiere que **bandits contextuales superan a RL** en estos contextos. **RL probablemente nunca se justifica para BANVA**.

---

## 8. Riesgos y guardrails con casos reales

### 8.1 El catálogo de fracasos que tu sistema debe prevenir

**El libro de la mosca, Amazon abril 2011** (Eisen, michaeleisen.org/blog/?p=358). Dos sellers con repricers: profnath setea `precio = bordeebook × 0.9983`, bordeebook setea `precio = profnath × 1.270589`. Factor combinado: **1.2684 por ciclo → crecimiento geométrico unbounded**. El libro *Making of a Fly* llegó a **US$23.698.655,93**. **Guardrail faltante**: ceiling absoluto, sanity check vs cost basis, rate limit. Tu trigger `validate_price` ya lo cubre.

**RepricerExpress, Amazon UK, 12-dic-2014** (Fortune, EcommerceBytes). Loop autoreforzado bajó precios a **£0.01** durante 1 hora en plena Navidad. Un seller perdió £100k en 2 horas. Resultado: Amazon implementó forzosamente **min/max obligatorio por SKU desde 14-ene-2015** — listings sin floor/ceiling se desactivan automáticamente al detectar pricing error. **Guardrail**: `sku_price_bounds` no es opcional, es un campo NOT NULL.

**Walmart $8.85, nov 2013** (ABC, CNBC). Pantallas Viewsonic ($579) y proyectores ($600) listados a $8.85 por horas. Walmart canceló órdenes citando ToS pero el daño reputacional fue grande. Postmortem: **publicaron paper KDD 2019** (Sarpal et al.) sobre anomaly detection ensemble (LOF + Isolation Forest + XGBoost). Tu z-score check es la versión simplificada del mismo patrón.

**Wayfair $10k cabinets, julio 2020**. Verdict: **mayormente teoría conspirativa QAnon** (Snopes desmintió). **Lección lateral**: SKU names autogenerados (Yaritza, Alyvia, Anabel) + precios industriales reales = catástrofe reputacional aun cuando técnicamente no había bug. Plausibility checks no son solo numéricos; las naming conventions también importan.

### 8.2 Riesgo legal Chile

**Ley 19.496 art. 12**: *"Todo proveedor de bienes o servicios estará obligado a respetar los términos, condiciones y modalidades conforme a las cuales se hubiere ofrecido o convenido"* — **el precio publicado obliga al vendedor**.

**Sernac v. Dell (2009)**, Corte de Apelaciones de Santiago: Dell publicó computadores a ~$1.000 CLP por error de sitio web; tribunal **forzó a Dell a respetar el precio publicado**. **Sernac v. Weber Stephen (dic 2019)**: parrillas con descuentos >90% por error; procedimiento voluntario colectivo bajo arts. 12, 28(d), 50.

**FNE estudio de mercado e-commerce (nov 2024 → preliminar dic 2025 → final marzo 2026)**: identifica explícitamente *"colusión algorítmica y discriminaciones arbitrarias basadas en algoritmos"* como riesgos en marketplaces. Es probable que en 2026–2027 haya enforcement nuevo.

**Implicancia operativa**: tu kill-switch no es feature opcional, es **defensa legal**. Un bug que publique $100 cuando debió ser $50.000 puede ser obligación contractual de cumplir bajo Ley 19.496.

### 8.3 Riesgo de colusión algorítmica

**U.S. v. Topkins (DOJ, 2015)**: poster art en Amazon Marketplace; primer caso criminal por price-fixing algorítmico bajo Sherman Act §1. La ilegalidad estuvo en el **acuerdo humano de usar algoritmos complementarios**, no en el algoritmo per se. Plea: $20k multa + cooperación. Su co-conspirador Aston (Trod Ltd.) recibió 6 meses de cárcel.

**U.S. v. RealPage (2024–2025)**: software YieldStar agregaba data **non-public** de competidores landlords y devolvía precios sugeridos. DOJ alegó **hub-and-spoke conspiracy**. Settlement nov 2025: prohibición de usar non-public competitor data + monitor 3 años. **Lección directa**: scrapear precios públicos de competidores en ML está bien; **alimentar tu pricer con data interna que terceros te pasen NO**.

**Calvano, Calzolari, Denicolò, Pastorello (AER 2020), arXiv:1804.06410**: dos Q-learners en Bertrand repetido **convergen a precios supra-competitivos vía trigger strategies sin comunicarse**. Empíricamente confirmado por Assad, Clark, Ershov, Xu (CESifo 2020) en gasolina alemana: estaciones con repricer algorítmico subieron márgenes ~28% en duopolios. **Lección**: **NO uses RL con horizonte largo entrenado contra competidores que también usan RL**. Mantente myopic, anclado en cost+target-margin, no en perfil-maximization de largo plazo que aprenda reacciones.

### 8.4 FTC v. Amazon: lecciones de governance

La demanda FTC alega que Amazon **pausaba Project Nessie durante Prime Day y feriados** ("increased media focus and customer traffic") y lo reactivaba después. Adóptalo como práctica formal:
- Pausa pricing engine durante CyberDay, Black Friday, días previos a fechas de alto escrutinio mediático.
- Documenta la decisión de pausa en `pricing_policy` con `paused_categories` o flag global.
- Evita lenguaje game-theoretic en código y commits ("punish competitor", "discipline rivals" — el FTC usó internal language como evidencia contra Amazon).

### 8.5 Stack mínimo de safety (resumen)

1. **Hard floors/ceilings por SKU** (`sku_price_bounds` NOT NULL).
2. **Anomaly detection en outputs** (z-score vs rolling 7d median, ensemble si crece).
3. **Rate limits** (max 4 cambios/día/SKU, max ±20% movimiento acumulado).
4. **Kill-switches multinivel** (global, categoría, SKU manual_override).
5. **Approval queue para anómalos** (no fail-open, fail-to-review).
6. **Two-person rule** para cambios al rule set en producción (PR + approver en GitHub).
7. **Staged rollouts** (shadow → canary 5% → 25% → 100%).
8. **Decision log inmutable** con `REVOKE UPDATE,DELETE`.
9. **Pausa pre-anunciada** durante eventos de alto escrutinio.
10. **Solo public competitor data**; nunca pools privados de terceros.

---

## 9. Específicos marketplace (Bloque E, BANVA-direct)

### 9.1 Catálogo ML — variables conocidas del ranking

Vía `GET /items/{ITEM_ID}/price_to_win?version=v2` (developers.mercadolibre.cl/competencia-en-catalogo, **Tier 1 oficial**):

| Boost | Estado | Acción operativa |
|---|---|---|
| `fulfillment` | Full activo | mantener stock Full en SKUs KVI |
| `free_shipping` | envío gratis sobre umbral | precio ≥ $19.990 CLP para que el subsidio aplique |
| `same_day_shipping` | Flex zona metropolitana | activar Flex en RM |
| `free_installments` | cuotas sin interés (Premium) | usar Premium en KVIs |
| `shipping_collect` | colecta ML | configurar colecta |

Estados: `winning | competing | sharing_first_place | listed`. Webhook tópico `item_competition` te notifica cambios. Reputación verde oscuro = subsidio máximo (~50% envío gratis), Mercado Líder = mayor exposición en búsquedas (vendedores.mercadolibre.cl/nota/que-necesitas-para-ser-mercadolider).

**Importante**: el ganador NO es global — es por ubicación del comprador. Si tienes Full en CD Santiago pero el comprador está en Concepción, otro seller con Flex local puede ganarte. Tu engine debe contemplar **multiple winning configurations por SKU**.

### 9.2 Repricer — patrón webhook-driven

**Rate limits documentados:**
- ML: 1.500 req/min/seller (response 429 si excedes).
- Webhook ML: response HTTP 200 en <500ms o ML desactiva el tópico.
- Amazon SP-API `getFeaturedOfferExpectedPriceBatch`: hasta 40 SKUs/request.

**Arquitectura recomendada para BANVA**: webhook-driven, **NO polling**. Suscríbete a `item_competition` + `items_prices`. Cuando llega webhook, encolas en queue (Vercel Queue, Upstash, o PostgreSQL `LISTEN/NOTIFY`), pricing engine consume async, recomputa, escribe a `prices` (trigger valida), publisher worker hace POST de vuelta a ML.

Con 425 SKUs y rate limit 1500/min tienes capacidad sobrada — incluso refrescando todo el catálogo cada 30s estarías a 14 req/s.

**Open source**: no hay repricer ML maduro open-source. Hay SDKs (mercadolibre/flamepool — pool workers con rate-limiting) que sirven como base. Construye in-house.

**Vendors comparables**: Feedvisor (su CTO Yagil Engel publicó el paper técnico más serio: dos etapas — modelo de profit curve + modelo de market response), Aura (Hyperdrive ~10s latencia), Seller Snap (game-theory engine, 2–15min). Para ti probablemente no hace falta SaaS — el sweet spot es construir el rule engine + elasticidad y conectar Feedvisor/similar solo si más adelante creces a multi-marketplace.

### 9.3 Pricing × Mercado Ads — fórmula operativa

Mercado Ads Product Ads (developers.mercadolibre.cl/product-ads, **Tier 1**) usa **ACOS Objetivo** como puja. Estrategias: `VISIBILITY`, `PROFITABILITY`, automático. Métricas devueltas: `acos`, `roas`, `cpc`, `cvr`, `top_impression_share`, `lost_impression_share_by_budget`, `lost_impression_share_by_ad_rank`. Brand Ads ocupa "posición 0" sobre Product Ads.

**Coupling pricing × ads (fórmula derivada):**

```
Margen_contributivo_unitario = Precio − COGS − comisión_ML × Precio
                                − envío_efectivo − costo_logístico − IVA_neto

Margen_post_ads = Margen_contributivo − (ACOS × Precio)

Restricción: ACOS ≤ Margen_contributivo / Precio
Equivalente: CPA_máx = Margen_contributivo_unitario
```

Para BANVA con margen bruto ~30% (después de comisión 13–17% en textiles):
- ACOS techo sostenible ≈ 25–30% para preservar 13% neto.
- Si bajas precio para ganar Buy Box, **simultáneamente** baja tu ACOS techo. El coupling es real, no teórico.

**Literatura relevante:**
- **Zhao & Berman (2025), arXiv:2508.08325**: Multi-Agent RL precio×bid sobre dataset Amazon. Hallazgo contraintuitivo: con alto search cost, los algoritmos **bajan** precios coordinadamente (reducen bids → costo adquisición baja → permiten precios menores). Implicancia: si Mercado Ads tiene mucho competidor agresivo, tu mejor estrategia puede ser **bajar simultáneamente precio y bid**.
- **Agrawal et al. (2023), arXiv:2304.14385**: dynamic pricing Bayesiano + advertising como signaling.
- **Zhao et al. (KDD 2020), doi:10.1145/3394486.3403384**: RL para optimización conjunta orgánico + paid en feed.

### 9.4 Pricing × Logística — Full vs Flex en CL

**Full** (vendedores.mercadolibre.cl/nota/cuales-son-los-costos-por-almacenar-stock-en-full):
- Costo almacenamiento diario por unidad (función de tamaño).
- Cargo por stock antiguo (>120 días).
- Servicio de colecta ($/m³, descuento por volumen).
- Cargo fijo bajo umbral: productos <$19.990 CLP tienen **~$600 CLP/unidad** (referenciado por Wivo Analytics 2025) — puede consumir todo el margen.
- Subsidio envío gratis: hasta 50% según reputación.

**Flex** (envios.mercadolibre.cl/mercado-envios-flex):
- Bonus envío en MercadoPago 2 días post-entrega, varía con distancia.
- Productos <$19.990: ML cobra $2.940–$4.000 al comprador (según sector).
- ≥$19.990: ML bonifica hasta 15% de la tarifa (subsidio menor que Full).
- Requisito ≥97% envíos correctos/semana o pierdes "Llega hoy".
- Boost SEO `same_day_shipping` directo en `price_to_win`.

**Comisión ML Chile**: 8–21% según categoría/tipo publicación. Hogar/textiles típicamente 13–17%.

**Fórmula price floor para BANVA:**

```
P_min = (COGS + costo_logístico_total + costo_almacenamiento_esperado
         + costo_retornos_esperado + margen_objetivo)
       / (1 − comisión_ML − ACOS_objetivo − envío_pct)

donde:
  costo_almacenamiento_esperado = tarifa_diaria × días_promedio_inventario
  costo_stock_antiguo_esperado = P(días > 120) × tarifa_stock_antiguo
  costo_retornos_esperado = ratio_retornos × (COGS + costo_logística_inversa)
```

**Implicancias tácticas**:
1. **Voluminosos / baja rotación**: Full anti-económico (almacenamiento × volumen × días domina). Flex preferible si zona metropolitana.
2. **<$19.990 CLP en Full**: cargo fijo $600 puede ser deficitario. Forzar precio ≥$19.990 o agrupar en kit.
3. **Híbrido Full + Flex**: ganas Buy Box en zonas distintas (Full en Santiago, Flex en regiones con CD).
4. **Reputación verde oscuro = subsidio envío 50%**: defenderla operativamente afloja tu floor en ~envío × 0.5.
5. **MercadoLibre Tech blog "Marketplace Forecasting"** (Coba Puerto): LSTM Global Time Series para forecast 12-week por ítem distinguiendo demanda potencial vs ventas (cap por stock). Te sirve para alimentar `P(días > 120)` con precisión.

---

## 10. Bibliografía con tier y URLs

**Tier 1 (papers peer-reviewed, court docs, official engineering blogs):**

1. FTC v. Amazon, Complaint redacted (Nov 2023). https://www.ftc.gov/system/files/ftc_gov/pdf/1910134amazonecommercecomplaintrevisedredactions.pdf
2. FTC v. Amazon, Second Amended Complaint (Oct 2024). https://www.ftc.gov/system/files/ftc_gov/pdf/0327-20231031-REDACTEDSecondAmendedComplaint.pdf
3. U.S. v. Topkins, Information (April 2015). https://www.justice.gov/atr/case-document/file/513586/download
4. U.S. v. RealPage, Complaint (Aug 2024). Wilson Sonsini analysis: https://www.wsgr.com/en/insights/doj-settles-its-algorithmic-price-fixing-case-against-realpage.html
5. Liu et al. (Alibaba, 2019), "Dynamic Pricing on E-commerce Platform with Deep Reinforcement Learning: A Field Experiment". arXiv:1912.02572. https://arxiv.org/abs/1912.02572
6. Ye et al. (Airbnb, KDD 2018), "Customized Regression Model for Airbnb Dynamic Pricing". https://www.kdd.org/kdd2018/accepted-papers/view/customized-regression-model-for-airbnb-dynamic-pricing
7. Ganti et al. (Walmart, 2018), "Thompson Sampling for Dynamic Pricing". arXiv:1802.03050. https://arxiv.org/abs/1802.03050
8. Chen, Mehrotra et al. (Walmart, 2021), "A Multiobjective Optimization for Clearance in Walmart Brick-and-Mortar Stores", *INFORMS Interfaces* 51(1):76–89.
9. Sarpal et al. (Walmart, KDD 2019), "Anomaly Detection for an E-commerce Pricing System". https://dl.acm.org/doi/10.1145/3292500.3330748 + arXiv:2310.04367.
10. Russo & Van Roy (2018), "A Tutorial on Thompson Sampling". arXiv:1707.02038.
11. Ferreira, Simchi-Levi, Wang (2018), "Online Network Revenue Management Using Thompson Sampling", *Operations Research* 66(6):1586–1602.
12. Misra, Schwartz, Abernethy (2019), "Dynamic Online Pricing with Incomplete Information Using Multi-Armed Bandit Experiments", *Marketing Science* 38(2):226–252.
13. Calvano, Calzolari, Denicolò, Pastorello (2020), "Artificial Intelligence, Algorithmic Pricing, and Collusion", *AER* 110(10):3267–3297.
14. Chernozhukov et al. (2018), "Double/Debiased Machine Learning", *Econometrics Journal* 21(1):C1–C68.
15. Bhuwalka et al. (MIT, 2022), "A Hierarchical Bayesian Regression Model that Reduces Uncertainty in Material Demand Predictions", *J. Industrial Ecology*.
16. Berry, Levinsohn, Pakes (1995), "Automobile Prices in Market Equilibrium", *Econometrica* 63(4):841–890.
17. Cooprider & Nassiri (Amazon Science), "Science of price experimentation at Amazon". https://assets.amazon.science/ba/f5/f761c2a04652a798704b5208cc60/science-of-price-experimentation-at-amazon.pdf
18. Amazon Science, "The history of Amazon's forecasting algorithm". https://www.amazon.science/latest-news/the-history-of-amazons-forecasting-algorithm
19. DoorDash Engineering, "Building a better Pricing Framework". https://careersatdoordash.com/blog/rebuilding-our-pricing-framework/
20. Uber Engineering, "Disaster recovery for multi-region Kafka at Uber". https://www.uber.com/blog/kafka/
21. Walmart Global Tech, "Cost orchestration at Walmart". https://medium.com/walmartglobaltech/cost-orchestration-at-walmart-f34918af67c4
22. MercadoLibre Tech, Camilo E. Martínez, "E-Commerce Pricing Anecdotes". https://medium.com/mercadolibre-tech/e-commerce-pricing-anecdotes-e603907d307d
23. MercadoLibre Tech, Coba Puerto, "Global Time Series Forecasting Models for Item-Level Demand and Sales Forecasts". https://medium.com/mercadolibre-tech/global-time-series-forecasting-models-for-item-level-demand-and-sales-forecasts-in-our-marketplace-aee2956957ae
24. MercadoLibre Developers, Catálogo y price_to_win. https://developers.mercadolibre.cl/es_ar/competencia-en-catalogo
25. MercadoLibre Global Selling, Pricing Reference / Pricing Management Tool. https://global-selling.mercadolibre.com/devsite/pricing-reference
26. Mercado Ads docs. https://developers.mercadolibre.cl/product-ads/
27. Vendedores ML Chile, Mercado Líder. https://vendedores.mercadolibre.cl/nota/que-necesitas-para-ser-mercadolider
28. Vendedores ML Chile, costos Full. https://vendedores.mercadolibre.cl/nota/cuales-son-los-costos-por-almacenar-stock-en-full
29. Mercado Envíos Flex. https://envios.mercadolibre.cl/mercado-envios-flex
30. Amazon SP-API getFeaturedOfferExpectedPriceBatch. https://developer-docs.amazon.com/sp-api/reference/getfeaturedofferexpectedpricebatch
31. Eisen, M. (2011), "Amazon's $23,698,655.93 book about flies". https://www.michaeleisen.org/blog/?p=358
32. Uma Maheswari et al. (CODS-COMAD 2024), "Contextual Bandits for Online Markdown Pricing". https://dl.acm.org/doi/10.1145/3632410.3632448
33. Schultz et al. (Zalando, 2023), "Causal Forecasting for Pricing". arXiv:2312.15282.
34. Zhao & Berman (2025), "Algorithmic Collusion of Pricing and Advertising on E-commerce Platforms". arXiv:2508.08325.
35. Assad, Clark, Ershov, Xu (2020), "Algorithmic Pricing and Competition: Empirical Evidence from the German Retail Gasoline Market", CESifo WP 8521.
36. Martin Fowler, "Rules Engine". https://martinfowler.com/bliki/RulesEngine.html
37. Martin Fowler, "Refactoring to an Adaptive Model". https://martinfowler.com/articles/refactoring-adaptive-model.html
38. Camunda DMN hit policies. https://docs.camunda.io/docs/components/best-practices/modeling/choosing-the-dmn-hit-policy/
39. Drools 8 docs, agenda y salience. https://docs.drools.org/8.38.0.Final/drools-docs/docs-website/drools/rule-engine/index.html
40. Modern Treasury, "How to Scale a Ledger, Part V: Immutability". https://www.moderntreasury.com/journal/how-to-scale-a-ledger-part-v
41. Square Engineering, "Books, an immutable double-entry accounting database". https://developer.squareup.com/blog/books-an-immutable-double-entry-accounting-database-service/
42. PostgreSQL Wiki, "SQL2011 Temporal". https://wiki.postgresql.org/wiki/SQL2011Temporal
43. Supabase pg_jsonschema. https://supabase.com/docs/guides/database/extensions/pg_jsonschema
44. Heap Engineering, "When to Avoid JSONB". https://www.heap.io/blog/when-to-avoid-jsonb-in-a-postgresql-schema
45. Ley 19.496 Chile (BCN). https://www.bcn.cl/leychile/navegar?idNorma=61438
46. FNE estudio mercado e-commerce (nov 2024). https://www.fne.gob.cl/en/fne-inicia-estudio-de-mercado-sobre-comercio-electronico/
47. Sernac, Procedimiento Voluntario Colectivo Weber Stephen (2020). https://www.sernac.cl/portal/604/w3-propertyvalue-20982.html
48. P2B Regulation (EU) 2019/1150. https://eur-lex.europa.eu/eli/reg/2019/1150/oj/eng
49. NYSE Market-Wide Circuit Breakers FAQ. https://www.nyse.com/publicdocs/nyse/NYSE_MWCB_FAQ.pdf
50. arXiv:2604.14059 (2026), "Comparative Study of DP and RL in Finite-Horizon Dynamic Pricing".
51. Apte et al. (2024), "Dynamic Retail Pricing via Q-Learning". arXiv:2411.18261.
52. Zhao et al. (2026), "Dynamic Prior Thompson Sampling". arXiv:2602.00943.
53. Brovman et al. (eBay), "Personalized Embedding-based e-Commerce Recommendations". arXiv:2102.06156.
54. Zhao et al. (Alibaba), "Learning and Transferring IDs Representation in E-commerce". arXiv:1712.08289.

**Tier 2 (practitioners identificables, vendor docs con detalle técnico):**

55. Yagil Engel (Feedvisor CTO), "Rule-Based vs. Algorithmic Repricer". https://feedvisor.com/resources/e-commerce-strategies/feedvisors-algorithmic-repricing-difference/
56. DoorDash Eng, "Smarter Promotions with Causal Machine Learning" (2025).
57. DoorDash Eng, "CockroachDB feature store" (2023).
58. Juan Camilo Orduz, "Hierarchical Pricing Elasticity Models". https://juanitorduz.github.io/elasticities/
59. Bemi blog, "It's Time to Rethink Event Sourcing". https://blog.bemi.io/rethinking-event-sourcing/
60. Architecture Weekly (Oskar Dudycz), "Building your own Ledger Database".
61. Marfeel, content-addressable deploys. https://www.marfeel.com/docs/touch/continuous-deployment/sdk-reference/content-addressable-system.html
62. LaunchDarkly, Guide to Dark Launching. https://launchdarkly.com/blog/guide-to-dark-launching/
63. ThoughtWorks Tech Radar, Clara rules entry.
64. McKinsey, "Pricing in Retail: Setting Strategy".
65. ClearDemand, "KVI Analysis". https://cleardemand.com/kvi-analysis-how-a-few-skus-can-transform-your-price-image/
66. Wivo Analytics, costo de venta ML LATAM (2025).
67. BCLP, análisis FTC v. Amazon (Oct 2024). https://www.bclplaw.com/en-US/events-insights-news/the-ftc-and-state-case-against-amazon-highlights-risks-and-impacts-from-using-pricing-algorithms.html
68. CeCo (Centro Competencia UAI), análisis FNE estudio e-commerce. https://centrocompetencia.com/nuevo-estudio-mercado-fne-e-commerce-primeras-impresiones/

**Tier 3 (informativo, sesgo comercial reconocido):**

69. Pryse Engineering, "AI Pricing for B2B".
70. Multivende, Nubimetrics, Jaguar Sheet — blogs ML LATAM.
71. Pacvue / Skai / Perpetua docs públicos.
72. Mirakl marketplace anomaly detection blog.

**Gaps explícitos (no encontré evidencia tier 1 para):**
- Pesos numéricos del algoritmo de catálogo ML (no publicados).
- Tarifas Full Chile en CLP/m³ formato tabla (solo visibles dentro del panel autenticado).
- Paper sobre "Asian retailer 10TB transactions" — probablemente referencia distorsionada al paper Alibaba Liu 2019.
- Walmart paper RL en pricing — **no existe**, es confusión con Alibaba.
- Engineering blog post de Shopee, JD.com, MercadoLibre o Stripe sobre arquitectura específica de rules engine para pricing.
- Repricer open source maduro para ML o Amazon (no existe).
- Paper KDD/SIGIR sobre integración de logística marketplace fulfillment como variable en price floor — **gap de literatura abierta**.

---

## Conclusión

La pregunta original era "cómo lo hacen los grandes y qué de eso es replicable a tu escala". La respuesta no es un algoritmo — es una **arquitectura de tres capas**:

1. **Reglas con guardrails duros** (lo que faltó en el libro de la mosca, RepricerExpress, Walmart 2013).
2. **Modelos de demanda/elasticidad bajo las reglas, no sobre ellas** (el patrón Walmart, Airbnb, MercadoLibre — el 100% de los grandes mantienen reglas humanas como el outer loop).
3. **Audit log inmutable + kill-switches multinivel** (lo que la FTC documenta de Project Nessie, lo que Walmart publicó en KDD 2019, lo que la jurisprudencia chilena exige implícitamente).

**La evolución correcta para BANVA es lenta, no rápida**: rules-first + guardrails ahora, elasticidad jerárquica Bayesiana en mes 6, bandits TS solo sobre KVIs en mes 9–12, RL probablemente nunca. Cada salto debe estar gateado por evidencia empírica (varianza de precios suficiente, ≥100 ventas/mes en SKUs target, lift sostenido con p<0.05), no por hype. La prioridad arquitectónica número uno **no es "el algoritmo"** — es el `validate_price` trigger con bounds, z-score y rate-limit que prevenga el accidente catastrófico que termine en titular Sernac. Construye eso primero. Lo demás es optimización marginal.