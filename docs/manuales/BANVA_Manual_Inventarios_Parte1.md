# Manual de Gestión de Inventarios de Clase Mundial — BANVA SPA
## Entrega 1 de 3: Partes 1–4

> Manual de referencia para Vicente Elias / BANVA SPA. E-commerce de textiles para el hogar en MercadoLibre Chile, ~345 publicaciones, logística Full+Flex, proveedor primario Idetex (60 días crédito). Aplicación concreta a la realidad operativa de BANVA al cierre de cada parte.
>
> **Marco bibliográfico de referencia** (citado a lo largo del manual con [n]):
> [1] Silver, Pyke & Thomas — *Inventory and Production Management in Supply Chains*, 4ª ed., CRC Press, 2017.
> [2] Nahmias & Olsen — *Production and Operations Analysis*, 7ª ed., Waveland, 2015.
> [3] Chopra & Meindl — *Supply Chain Management: Strategy, Planning and Operation*, 7ª ed., Pearson, 2019.
> [4] Axsäter — *Inventory Control*, 3ª ed., Springer, 2015.
> [5] APICS/ASCM — *CPIM Body of Knowledge* y *CSCP Learning System*, 2023.
> [6] CSCMP — *Supply Chain Management Process Standards*, 2014.
> [7] SCOR Digital Standard — ASCM, v12, 2022.
> [8] Hyndman & Athanasopoulos — *Forecasting: Principles and Practice*, 3ª ed., OTexts, 2021.
> [9] Salinas, Flunkert, Gasthaus & Januschowski — "DeepAR: Probabilistic forecasting with autoregressive recurrent networks", *International Journal of Forecasting*, 2020 (Amazon Science).
> [10] Wen, Torkkola, Narayanaswamy & Madeka — "A Multi-Horizon Quantile Recurrent Forecaster" (MQ-CNN/MQ-RNN), Amazon, NeurIPS 2017.
> [11] Ferdows, Lewis & Machuca — "Rapid-Fire Fulfillment", *Harvard Business Review*, Nov 2004 (caso Zara).
> [12] Ghemawat & Nueno — "ZARA: Fast Fashion", HBS Case 9-703-497, 2006.
> [13] Bezos, J. — *Amazon Shareholder Letters* 1997–2020.
> [14] Lapide, L. — "Sales and Operations Planning", MIT CTL, 2011.
> [15] Gartner — *Magic Quadrant for Supply Chain Planning Solutions*, 2023.
> [16] McKinsey & Company — "Succeeding in the AI supply-chain revolution", 2021.
> [17] BCG — "The Inventory Optimization Imperative", 2022.
> [18] Fisher, M. — "What is the Right Supply Chain for Your Product?", *HBR*, 1997.
> [19] Cachon & Terwiesch — *Matching Supply with Demand*, 4ª ed., McGraw-Hill, 2019.
> [20] Wagner & Whitin — "Dynamic Version of the Economic Lot Size Model", *Management Science*, 1958.
> [21] Croston, J.D. — "Forecasting and stock control for intermittent demands", *Operational Research Quarterly*, 1972.
> [22] Syntetos & Boylan — "The accuracy of intermittent demand estimates", *International Journal of Forecasting*, 2005.
> [23] Graves & Willems — "Optimizing Strategic Safety Stock Placement in Supply Chains", *M&SOM*, 2000.
> [24] Snyder & Shen — *Fundamentals of Supply Chain Theory*, 2ª ed., Wiley, 2019.
> [25] Mentzer & Moon — *Sales Forecasting Management*, 2ª ed., Sage, 2005.
> [26] Gilliland, M. — *The Business Forecasting Deal*, Wiley/SAS, 2010 (FVA).
> [27] MercadoLibre Developers — *Documentación oficial Mercado Envíos Full y Price Automation*, mercadolibre.com.ar/developers, 2024.
> [28] Amazon Science — Publicaciones sobre forecasting, anticipatory shipping (US Patent 8,615,473), random stow.
> [29] Walmart — Retail Link / cross-docking case studies, Stanford GSB case "Wal-Mart Stores Inc.", 2003.
> [30] Holt, C.C. — "Forecasting seasonals and trends by exponentially weighted moving averages", ONR Memo 52, 1957.
> [31] Winters, P.R. — "Forecasting sales by exponentially weighted moving averages", *Management Science*, 1960.
> [32] Box, Jenkins, Reinsel & Ljung — *Time Series Analysis: Forecasting and Control*, 5ª ed., Wiley, 2015.
> [33] Taylor & Letham — "Forecasting at Scale" (Prophet), *The American Statistician*, 2018 (Meta).
> [34] Oreshkin et al. — "N-BEATS: Neural basis expansion analysis for interpretable time series forecasting", ICLR 2020 (Element AI).
> [35] Lim, Arık, Loeff & Pfister — "Temporal Fusion Transformers", *International Journal of Forecasting*, 2021 (Google).

---

## PARTE 1 — FUNDAMENTOS

### 1.1 ¿Qué es inventario y por qué existe?

El inventario es **capital inmovilizado en forma física** que la empresa mantiene como buffer entre dos procesos que no están perfectamente sincronizados. Silver, Pyke y Thomas [1, cap. 1] lo definen formalmente como "stocks of items held to meet future demand", y advierten que su existencia siempre obedece a una **falla de sincronización**: si la demanda llegara exactamente cuando el producto está disponible, en la cantidad exacta y al costo unitario más bajo posible, el inventario sería innecesario. En el mundo real eso nunca ocurre, así que el inventario cumple uno de tres roles de buffer (Hopp & Spearman, *Factory Physics*, citado en [2]):

1. **Buffer de tiempo (lead time buffer):** absorbe el desfase entre el momento en que pides al proveedor y el momento en que el cliente quiere su producto. Si Idetex tarda 30–45 días en entregar un quilt y el cliente de MercadoLibre lo quiere en 24 horas, el inventario es lo que cierra esa brecha.
2. **Buffer de cantidad (variability buffer):** absorbe la incertidumbre en la cantidad demandada o suministrada. Aun si el lead time fuera cero, no sabes con certeza cuántos sets de toallas Cannon vas a vender la próxima semana.
3. **Buffer de capacidad (capacity buffer):** absorbe diferencias entre la tasa de producción/abastecimiento del proveedor y la tasa de consumo. Idetex produce en lotes; tú vendes en goteo continuo.

Chopra & Meindl [3, cap. 12] añaden una cuarta razón estratégica: el inventario puede ser una **decisión deliberada de posicionamiento competitivo**. Amazon mantiene inventario adelantado en sus FCs no porque sea barato, sino porque la promesa "Prime 1-day" exige tener el SKU físicamente cerca del cliente antes de que el cliente lo compre. El inventario es, en este sentido, una **inversión en velocidad de respuesta**.

### 1.2 Tipos de inventario

Siguiendo el marco APICS [5] y Nahmias [2, cap. 4]:

| Tipo | Definición | Ejemplo en BANVA |
|---|---|---|
| **Materias primas** | Insumos sin transformar | No aplica directo: BANVA compra producto terminado |
| **WIP (Work-in-Process)** | Producto en transformación | No aplica (BANVA no fabrica) |
| **Producto terminado** | Listo para venta | Quilts, sábanas, toallas en bodega o Full |
| **MRO** | Mantenimiento, reparación y operaciones | Insumos de bodega: cinta, etiquetas, bolsas, cajas |
| **In-transit / pipeline** | Pagado/comprometido pero aún no recibido | Pedido a Idetex despachado, no recepcionado |
| **Cycle stock** | Stock que rota normalmente entre reposiciones | El "cuerpo" del inventario que vendes mes a mes |
| **Safety stock** | Reserva para absorber variabilidad | Lo que protege contra picos y atrasos de Idetex |
| **Anticipation stock** | Acumulado para evento conocido | Stock acumulado pre-CyberDay |
| **Decoupling stock** | Independiza dos eslabones | Stock entre bodega central y Full |
| **Dead stock** | Sin movimiento por >180 días | Los 91 SKUs con 523 unidades inmovilizadas en BANVA |
| **Hedge stock** | Cobertura contra riesgo de precio/divisa | Compra anticipada de tela importada por alza FX |

> **Clave conceptual:** la mayoría de los dueños de e-commerce miran el inventario como un solo número agregado ("tengo 80 millones en stock"). La gestión de clase mundial **descompone** ese número en sus tipos. Si en BANVA tienes $80M y resulta que $20M son dead stock, $15M son anticipation pre-CyberDay, $25M son cycle stock saludable y $20M son safety stock, la lectura del negocio cambia radicalmente.

### 1.3 Costos de inventario — fórmulas completas

Silver et al. [1, cap. 3] descomponen el costo total anual de inventario en cuatro familias:

#### 1.3.1 Holding cost (costo de mantener)

$$H = i \cdot C$$

donde **C** es el costo unitario del SKU e **i** es la **tasa de holding anual**, expresada como % del valor del inventario. Esa tasa **no es** la tasa de interés bancario; es la suma de:

| Componente | Rango típico retail (% anual) | Cómo calcularlo |
|---|---|---|
| Costo de capital | 8–25% | WACC de la empresa o costo de oportunidad real |
| Almacenamiento físico | 2–5% | Arriendo bodega ÷ valor promedio inventario |
| Obsolescencia | 1–10% | % anual que se castiga por modas/temporadas |
| Mermas y robos (shrinkage) | 0,5–2% | Pérdidas físicas año/valor inventario |
| Seguros | 0,25–1% | Póliza ÷ valor asegurado |
| Impuestos sobre inventario | 0–2% | Patente municipal, otros |
| **Total típico clase retail** | **20–35%** | |

Chopra & Meindl [3, p. 320] reportan que en e-commerce de moda y textiles la tasa **i** suele estar en el rango **25–40%** anual por la alta obsolescencia. **Para BANVA, recomiendo trabajar con i = 30%** como supuesto base hasta tener data interna fina.

> **Ejemplo numérico:** un Quilt Atenas Beige 2P con costo unitario $12.000 CLP, mantenido un año en bodega, te cuesta $12.000 × 0,30 = **$3.600 al año solo por estar parado**. Si lo tienes 6 meses, te cuesta $1.800. Esto es lo que pierdes incluso si lo terminas vendiendo a precio completo.

#### 1.3.2 Ordering cost (costo de ordenar)

$$S = \text{costo fijo por colocar y recibir una orden}$$

Incluye: tiempo de planificación, generación de OC, comunicación con proveedor, recepción, conteo, ingreso al WMS, conciliación de factura. **No incluye** el costo del producto (eso es C). Para BANVA, una OC a Idetex tiene un costo administrativo realista de **$15.000–$40.000 CLP** considerando tiempo de Vicente/Enrique + bodega de Joaquín en recepción.

#### 1.3.3 Stockout cost / shortage cost

El más difícil de medir y el más subestimado [1, cap. 7]. Se compone de:

- **Lost sale margin:** margen unitario × unidades no vendidas
- **Penalización de algoritmo de marketplace:** MercadoLibre reduce posicionamiento de publicaciones que se quedan sin stock [27]. Esta penalización **persiste 2–6 semanas** después de reponer.
- **Customer lifetime value perdido:** el cliente que no encontró tu SKU compra al competidor y puede no volver
- **Costo de las quejas/cancelaciones:** afectan reputación MELI

Una estimación práctica para BANVA: **stockout cost ≈ margen unitario × unidades perdidas × 2** (factor 2 captura el daño de ranking + LTV).

#### 1.3.4 Costo total anual del modelo EOQ

$$TC(Q) = \underbrace{\frac{D}{Q}\cdot S}_{\text{ordenar}} + \underbrace{\frac{Q}{2}\cdot H}_{\text{mantener}} + \underbrace{D\cdot C}_{\text{compras}}$$

donde D = demanda anual, Q = tamaño de orden. Volveremos a esta fórmula en la Parte 4.

### 1.4 El inventory paradox

> "Too much inventory hides problems; too little inventory creates them." — Eli Goldratt, *The Goal*

La paradoja es directa: **tener mucho stock es caro y tener poco stock también es caro, pero por razones distintas**. McKinsey [16] modeló esta curva en U para retailers y encontró que el punto óptimo está donde el costo marginal de aumentar inventario iguala el beneficio marginal de reducir stockouts. La curva es **asimétrica**: el costo de quedarse sin stock crece más rápido que el costo de tener exceso, especialmente en marketplaces donde el ranking penaliza stockouts (caso MELI [27]).

Aplicado a BANVA: tener 2.522 unidades inmovilizadas en 173 SKUs zero-velocity (≈$30M+ a costo) cuesta ~$9M/año en holding. Pero tener 151 SKUs en stockout cuesta margen perdido + ranking destruido + ad spend desperdiciado en publicaciones sin stock — esta segunda pérdida es probablemente **mayor** aunque sea menos visible en el balance.

### 1.5 Inventario y working capital — Cash Conversion Cycle

El **CCC** (Cash Conversion Cycle) es la métrica financiera que conecta inventario con caja [3, cap. 14]:

$$\text{CCC} = \text{DIO} + \text{DSO} - \text{DPO}$$

- **DIO (Days Inventory Outstanding):** días promedio que el inventario permanece antes de venderse = (Inventario promedio / COGS) × 365
- **DSO (Days Sales Outstanding):** días promedio en cobrar a clientes. En MELI, ~14 días (liberación de pago).
- **DPO (Days Payable Outstanding):** días promedio en pagar a proveedores. **BANVA con Idetex: 60 días.**

Tim Cook (Apple) llevó el DIO de Apple de 30+ días en los 90s a **5 días** en 2012, generando una caja operativa que financió toda la expansión de la compañía sin deuda. Cook lo llamó "the inventory is fundamentally evil" — toda unidad parada destruye valor.

> **Ejemplo BANVA:** Si tu COGS anual es ~$540M (estimando 70% de $770M de revenue anual proyectado), y tu inventario promedio es ~$120M, entonces:
> - DIO = (120 / 540) × 365 = **81 días**
> - DSO ≈ 14 (MELI)
> - DPO = 60 (Idetex)
> - **CCC = 81 + 14 − 60 = 35 días**
>
> Esto significa que financias 35 días de operación con tu propio capital. Bajar el DIO de 81 a 50 días libera ~$45M de caja **una sola vez**, sin afectar ventas. Ese es el tamaño real del premio de una buena gestión de inventario.

### 1.6 Cómo aplicar la Parte 1 a BANVA

**Acciones inmediatas (semana 1–2):**

1. **Calcula tu tasa de holding real (i):** suma WACC + arriendo bodega/valor inventario + obsolescencia histórica + seguros. Documenta el número y úsalo en todos los modelos posteriores.
2. **Descompón tu inventario actual en los 10 tipos** (cycle, safety, dead, anticipation, in-transit, etc.) usando los datos que ya tienes en BANVA Bodega. El número agregado oculta el problema.
3. **Calcula el CCC actual** con datos reales de los últimos 12 meses. Este es tu baseline financiero.
4. **Cuantifica el costo de los 91 dead stock SKUs** = 523 unidades × costo unitario promedio × 0,30 anual. Ese número justifica todo el esfuerzo de la Parte 2 (segmentación) y la Parte 9 (errores comunes).

---

## PARTE 2 — CLASIFICACIÓN Y SEGMENTACIÓN DE SKUs

### 2.1 Por qué segmentar (y por qué la mayoría no lo hace)

La regla operativa más importante de la gestión de inventario es: **no todos los SKUs merecen el mismo nivel de atención**. Silver et al. [1, cap. 4] son explícitos: tratar 345 SKUs de la misma forma garantiza que sobreinviertas atención en los irrelevantes y sub-inviertas en los críticos. La segmentación es el mecanismo para **asignar atención de forma inteligente**.

### 2.2 Análisis ABC

Atribuido a Pareto y formalizado por H. Ford Dickie en General Electric (1951), el análisis ABC clasifica los SKUs según su contribución acumulada a una métrica (ingresos, margen, unidades). La regla 80/20 sostiene que ~20% de los SKUs generan ~80% del valor.

| Clase | % SKUs | % Valor | Política típica |
|---|---|---|---|
| **A** | 10–20% | 70–80% | Revisión semanal, forecast riguroso, safety stock alto, quiebre intolerable |
| **B** | 20–30% | 15–20% | Revisión quincenal, forecast estadístico estándar |
| **C** | 50–70% | 5–10% | Revisión mensual, política simple (min/max o (s,Q)), tolerancia a quiebres ocasionales |

**Críticamente, debes hacer el ABC tres veces, no una:**

- **ABC por ingresos:** identifica SKUs que mueven la facturación
- **ABC por margen $:** identifica SKUs que mueven la utilidad (no siempre los mismos)
- **ABC por unidades:** identifica SKUs que consumen capacidad de bodega y picking

Un SKU puede ser **A en margen pero C en unidades** (ej. una almohada de pluma de ganso de alto margen y baja rotación) o **A en unidades pero C en margen** (ej. un cubrecolchón de bajo precio que vende 77/semana). La estrategia operativa para cada uno es completamente distinta.

> **Ejemplo BANVA:** En la matriz Feb 2026 que ya tienes (Estrellas/Volumen/CashCow/Revisar), las **Estrellas** (21 SKUs, $4M margen) son tu A-margen + A-volumen. Las **CashCow** (94 SKUs, $4.1M) son A-margen pero medio-volumen — política: defender precio, no liderar ofertas. **Volumen** (17 SKUs, $3.1M) son A-volumen pero margen menor — política: escala, ads agresivos hasta ACOS/margen permitidos. **Revisar** (110 SKUs, $2.8M) son C — revisión obligada para reclasificar o eliminar.

### 2.3 Análisis XYZ

Mientras ABC mira el valor, XYZ mira la **predictibilidad de la demanda** medida por el coeficiente de variación (CV) [4, cap. 5]:

$$CV = \frac{\sigma_{\text{demanda semanal}}}{\mu_{\text{demanda semanal}}}$$

| Clase | CV | Característica |
|---|---|---|
| **X** | < 0,5 | Demanda estable, fácil de pronosticar |
| **Y** | 0,5–1,0 | Demanda variable con tendencia/estacionalidad identificable |
| **Z** | > 1,0 | Demanda errática/intermitente, casi impronosticable |

### 2.4 Matriz ABC-XYZ — los 9 cuadrantes

Esta es **la herramienta de segmentación más poderosa** de toda la disciplina [1, cap. 4; 24]. Combina valor (ABC) con predictibilidad (XYZ):

| | **X (estable)** | **Y (variable)** | **Z (errático)** |
|---|---|---|---|
| **A** | **AX:** automatizar 100%, safety stock bajo, 99% service level | **AY:** forecast estadístico + ajuste humano, safety stock medio-alto, 98% SL | **AZ:** los más peligrosos. Forecast Croston + safety stock alto, considerar make-to-order o pre-venta |
| **B** | **BX:** automatizar, safety stock bajo, 97% SL | **BY:** automatizar con revisión mensual, 95% SL | **BZ:** revisión mensual, safety stock alto, 92% SL |
| **C** | **CX:** automatizar al máximo, política (s,Q) simple, 95% SL | **CY:** política simple, 90% SL | **CZ:** **candidatos a descontinuar**. Make-to-order o eliminar. 85% SL |

**Política operativa por cuadrante (regla práctica):**

- **AX/AY:** "joyas de la corona". Nunca pueden quebrar. Stock de seguridad calculado riguroso. Reposición con lead time monitoreado.
- **AZ:** alto valor, demanda errática. Aquí es donde más dinero se pierde por mala gestión. Usa Croston o TSB (ver Parte 3) y considera **postponement** (no comprometerte hasta tener pedido firme).
- **CZ:** baja contribución, demanda errática. **Estos son tus candidatos #1 a descontinuar.** En BANVA esto es prácticamente igual al cuadrante "Revisar" (110 SKUs) con CV alto.

> **Aplicación directa BANVA:** los **53 SKUs activos con 0 ventas** del Feb 2026 son CZ por definición (C en valor, Z en variabilidad). Los **174 con CVR<3%** son una mezcla CY/CZ. **Acción:** reclasifica los 345 SKUs en estos 9 cuadrantes y aplica la política por cuadrante. Esto solo, sin tocar nada más, debería liberar 20–30M de caja en 6 meses.

### 2.5 Otras clasificaciones complementarias

**FSN (Fast/Slow/Non-moving):** clasificación por velocidad de salida. APICS [5] recomienda umbrales:
- **Fast:** rotación > 6 veces/año
- **Slow:** 1–6 veces/año
- **Non-moving:** < 1 vez/año (= dead stock candidato)

**VED (Vital/Essential/Desirable):** clasificación por criticidad operacional. Originalmente del sector salud/MRO. Para BANVA es menos relevante salvo para insumos de bodega.

**HML (High/Medium/Low):** clasifica por costo unitario, no por valor total. Útil para definir controles de seguridad física (un SKU H requiere conteo más frecuente porque la merma duele más).

**SDE (Scarce/Difficult/Easy):** clasifica por dificultad de adquisición. Para BANVA: SKUs importados o de proveedores con lead time largo son S; SKUs de Idetex con lead time estable son E.

### 2.6 Ciclo de vida del producto (PLC)

Levitt (HBR, 1965) y formalizado por Kotler. Cada SKU pasa por 4 fases con políticas de inventario distintas:

| Fase | Demanda | Política de inventario |
|---|---|---|
| **Introducción** | Baja, incierta | Lotes pequeños, pre-venta, monitoreo semanal |
| **Crecimiento** | Crece rápido | Sobreabastecer cycle stock, safety stock alto, evitar stockout a toda costa |
| **Madurez** | Estable | Optimizar EOQ, automatizar reposición, exprimir margen |
| **Declive** | Cae | Reducir compras, liquidar, no reabastecer |

> **Aplicación BANVA:** los SKUs de la colección **Idetex Invierno 2026** están en **introducción** — no apliques EOQ todavía, compra lotes pequeños, mide velocidad real 4 semanas antes de escalar. Los **77 dead stock no-Idetex** que ya identificaste están en **declive** — política: liquidar con descuento agresivo y no reordenar.

### 2.7 KVIs (Key Value Items) vs. Long Tail

Los KVI son los SKUs cuyo precio el cliente conoce y usa para juzgar si "esta tienda es cara o barata" [BCG, 17]. En supermercados son la leche, el pan y la coca-cola. En BANVA son probablemente los cubrecolchones impermeables y los sets de toallas Cannon de tamaño estándar — productos que el cliente busca por categoría y compara precios fácilmente.

**Regla:** los KVI **deben** estar siempre en stock y a precio competitivo. La long tail puede estar más cara y con menor disponibilidad. Esta segmentación es ortogonal a ABC-XYZ y debe usarse en conjunto.

### 2.8 Cómo Amazon segmenta sus SKUs

Amazon usa internamente una clasificación de "**movement classes**" (papers de Amazon Science [28]):

- **Hot** (top 5–10% por velocidad): almacenamiento en zonas de fast pick, replenishment diario, forecast con DeepAR a granularidad horaria.
- **Warm:** zonas de pick estándar, replenishment cada 2–3 días.
- **Cold:** zonas de slow pick (alto/bajo, profundo), replenishment semanal.
- **Glacier:** candidatos a remoción de FBA, devolución a vendor o liquidación.

La promoción/degradación entre clases es **automática y semanal**. Esta es la lógica que debes replicar en BANVA Bodega: cada SKU con su clase actualizada cada lunes en base a velocidad de las últimas 4 semanas.

### 2.9 Cómo aplicar la Parte 2 a BANVA

1. **Implementa la matriz ABC-XYZ** sobre los 345 SKUs con datos de los últimos 90 días. Crea un campo `cuadrante_abcxyz` en BANVA Bodega que se actualice automáticamente cada lunes.
2. **Define la política por cuadrante** (service level, frecuencia de revisión, método de forecast). Documenta en `.claude/rules/inventory-policy.md`.
3. **Marca explícitamente los KVIs** (entre 10 y 25 SKUs máximo). Estos nunca pueden estar fuera de stock ni fuera de precio competitivo.
4. **Marca cada SKU con su fase de PLC** y revisa trimestralmente. Los SKUs en "declive" son el origen del dead stock.
5. **Implementa el sistema de "movement classes" tipo Amazon** (Hot/Warm/Cold/Glacier) y usa esta clasificación para slotting físico en bodega (Parte 5).

---

## PARTE 3 — FORECASTING DE DEMANDA

### 3.1 Marco conceptual

Hyndman & Athanasopoulos [8, cap. 1] establecen el principio fundacional: **un forecast no es una predicción puntual, es una distribución de probabilidad**. Quien pronostica "vamos a vender 100 unidades" miente. Lo correcto es: "la mediana de mi forecast es 100, con un intervalo del 80% entre 75 y 130, y un intervalo del 95% entre 60 y 150". Esta distinción es crítica porque el safety stock se calcula sobre la **incertidumbre del forecast**, no sobre el punto medio.

Tres principios derivados:
1. **Forecast siempre tiene error.** El objetivo no es eliminarlo sino medirlo y reducirlo sistemáticamente.
2. **Granularidad importa.** Forecast a nivel SKU-tienda-día es más impreciso (en %) pero más útil que a nivel categoría-mes.
3. **El forecast debe converger con la decisión que va a alimentar.** Si decides reposición semanal, pronostica semanalmente.

### 3.2 Métodos estadísticos clásicos

#### 3.2.1 Media móvil (MA)

$$\hat{F}_{t+1} = \frac{1}{n}\sum_{i=t-n+1}^{t} D_i$$

Útil solo como baseline. Reacciona lento, no captura tendencia ni estacionalidad. Para BANVA: descartado salvo como benchmark.

#### 3.2.2 Suavizamiento exponencial simple (SES)

$$\hat{F}_{t+1} = \alpha D_t + (1-\alpha)\hat{F}_t$$

Asigna más peso a observaciones recientes. **α ∈ [0,1]**: alto = más reactivo, bajo = más estable. Bueno para SKUs sin tendencia ni estacionalidad. Sigue siendo limitado.

#### 3.2.3 Holt (doble suavizamiento) [30]

Captura **nivel + tendencia**:
$$L_t = \alpha D_t + (1-\alpha)(L_{t-1}+T_{t-1})$$
$$T_t = \beta(L_t-L_{t-1}) + (1-\beta)T_{t-1}$$
$$\hat{F}_{t+h} = L_t + h\cdot T_t$$

Útil para SKUs en fase de crecimiento.

#### 3.2.4 Holt-Winters (triple suavizamiento) [31]

Captura **nivel + tendencia + estacionalidad**. Es el método clásico estándar para retail. Existe versión aditiva y multiplicativa. **Para textiles con estacionalidad invierno/verano (quilts, sábanas térmicas), Holt-Winters multiplicativo es el baseline obligatorio.**

#### 3.2.5 ARIMA / SARIMA [32]

Box-Jenkins. Modelo autorregresivo integrado de media móvil. SARIMA añade componente estacional. Más sofisticado pero requiere series largas (2+ años) y supuestos de estacionariedad. Para BANVA con datos de menos de 2 años por SKU, **no es la primera opción**.

#### 3.2.6 Croston [21] y TSB [22] — demanda intermitente

Muchos SKUs de BANVA tienen demanda intermitente: semanas con 0 ventas alternadas con semanas con 2–3 ventas. Aplicar SES a estas series produce forecasts sesgados (sobreestima por la inflación de los ceros). **Croston** descompone la serie en dos:
- Tamaño promedio del pedido cuando hay venta
- Intervalo promedio entre ventas

Y combina ambas. **TSB (Teunter-Syntetos-Babai)** mejora Croston con corrección de obsolescencia.

> **Aplicación BANVA:** todos los SKUs con CV>1 (cuadrantes Z) y demanda intermitente deben pronosticarse con TSB, no con SES o Holt-Winters. Esto cubre probablemente 100–150 SKUs.

### 3.3 Métodos modernos de Machine Learning

#### 3.3.1 Prophet (Meta) [33]

Modelo aditivo: tendencia + estacionalidad anual + estacionalidad semanal + efectos de holidays + ruido. Robusto, fácil de usar, maneja huecos en la serie. Excelente para forecasting agregado. **Limitación:** trata cada SKU como serie independiente; no aprende patrones cruzados.

#### 3.3.2 LightGBM / XGBoost para forecasting

Reformulan el forecast como problema de regresión supervisada. Features: lags, rolling means, día de semana, mes, holidays, precio relativo, stock disponible, ad spend. **Ventaja:** pueden aprender de **todos los SKUs simultáneamente** (modelo global), capturando patrones cruzados (canibalización, halo effects). Es la familia de modelos que ganan la mayoría de competencias M (Makridakis) recientes.

#### 3.3.3 DeepAR (Amazon) [9]

Red neuronal recurrente probabilística. Entrena sobre **miles de series simultáneamente** y produce no un punto sino una distribución. Innovaciones clave del paper:
- Aprende efectos calendario y estacionalidad sin features manuales
- Funciona con SKUs de poca historia (cold-start) por transferencia de patrones de SKUs similares
- Outputs probabilísticos directos para cálculo de safety stock

DeepAR es el motor real detrás del forecasting de Amazon SCM. Disponible open-source en GluonTS y AWS Forecast.

#### 3.3.4 MQ-CNN / MQ-RNN (Amazon) [10]

Multi-Horizon Quantile Forecaster. Pronostica directamente los cuantiles (p10, p50, p90) en múltiples horizontes simultáneamente. Más rápido y preciso que DeepAR para muchos casos retail.

#### 3.3.5 N-BEATS [34] y Temporal Fusion Transformer (TFT) [35]

Estado del arte académico. TFT combina LSTM con mecanismos de atención e incorpora variables estáticas (categoría del SKU), variables conocidas en el futuro (precios planeados, promos) y observadas (ventas pasadas). Requiere infra ML.

#### 3.3.6 ¿Qué debe usar BANVA hoy?

| Volumen y madurez | Recomendación |
|---|---|
| **Hoy (sin equipo ML):** | Holt-Winters para X/Y, TSB para Z. Implementable en Python con `statsmodels` |
| **6 meses:** | LightGBM global model con features de calendario, precio, ads, stock |
| **12 meses:** | DeepAR vía AWS Forecast o GluonTS, o TFT si tienes ingeniero ML |

**Regla de oro:** no saltes etapas. Un Holt-Winters bien hecho con un buen ajuste humano vence a un TFT mal calibrado. Gilliland [26] tiene evidencia abundante.

### 3.4 Métricas de accuracy del forecast

#### 3.4.1 MAPE (Mean Absolute Percentage Error)

$$\text{MAPE} = \frac{1}{n}\sum \left|\frac{D_t - \hat{F}_t}{D_t}\right|$$

Ventaja: interpretable. Desventaja crítica: **explota cuando D_t = 0** (división por cero) y penaliza más los under-forecasts que los over-forecasts. **No usar para SKUs intermitentes.**

#### 3.4.2 WMAPE (Weighted MAPE) — el estándar retail

$$\text{WMAPE} = \frac{\sum |D_t - \hat{F}_t|}{\sum D_t}$$

**Por qué es superior a MAPE:** pondera por volumen. Un SKU de 1000 unidades con error de 100 pesa más que un SKU de 10 unidades con error de 10. Esto refleja correctamente el impacto en el negocio. **WMAPE es el KPI de forecast accuracy que debe usar BANVA.**

Benchmark clase mundial: WMAPE < 20% para SKUs A; < 35% para SKUs B; SKUs C son muy difíciles de pronosticar individualmente y deben evaluarse a nivel categoría.

#### 3.4.3 MAE, RMSE, Bias, MASE

- **MAE (Mean Absolute Error):** misma escala que la unidad. Simple.
- **RMSE:** penaliza más los errores grandes. Útil cuando un error grande es desproporcionadamente costoso.
- **Bias:** $\frac{1}{n}\sum (D_t - \hat{F}_t)$. **El más subestimado.** Si el bias es persistentemente positivo o negativo, el forecast tiene un sesgo sistemático que debe corregirse.
- **MASE (Mean Absolute Scaled Error)** [Hyndman, 8]: normaliza por el error de un naive forecast. MASE < 1 = mejor que naive. **Es la métrica académica preferida** porque es comparable entre series.
- **Tracking signal:** $\frac{\sum (D_t - \hat{F}_t)}{\text{MAD}}$. Si supera ±4, el forecast está descalibrado y debe revisarse.

### 3.5 Hierarchical forecasting

Cuando tienes jerarquías (SKU → categoría → división → total), los forecasts hechos a cada nivel **no suman**. Soluciones [Hyndman, 8 cap. 11]:
- **Bottom-up:** forecast a SKU y agregar. Pierde precisión en agregados.
- **Top-down:** forecast al total y desagregar por proporciones. Pierde precisión en SKU.
- **Middle-out:** forecast en nivel intermedio.
- **MinT (Minimum Trace) reconciliation:** ajusta todos los niveles simultáneamente para que sumen y minimicen error. Estado del arte.

Para BANVA: forecast a SKU semanal, agregar a categoría para validación humana, reconciliar.

### 3.6 Cold start — pronosticar SKUs nuevos

El problema de los productos sin historia. Tres enfoques [3, cap. 7]:
1. **Analog forecasting:** identificar un SKU "gemelo" lanzado antes y copiar su curva.
2. **Bass diffusion model:** modelo de adopción tecnológica adaptable a productos nuevos. Parámetros: coeficiente de innovación (p), de imitación (q), mercado potencial (m).
3. **Cold-start con DL:** DeepAR/TFT generan forecast para SKUs nuevos usando categorías y atributos como features.

**Para BANVA:** cuando lanzas un nuevo color/tamaño de la línea Idetex, identifica el SKU análogo más cercano (mismo material, similar precio) y usa su curva escalada como baseline 60 días.

### 3.7 Estacionalidad, promociones y eventos

Tres efectos calendario críticos para textiles en MELI Chile:

1. **Estacionalidad anual:** quilts y sábanas térmicas explotan abril–julio. Toallas y sábanas frescas explotan octubre–enero. Holt-Winters captura esto si tienes 2+ años.
2. **Estacionalidad de pago:** picos los días 1–5 y 25–30 (post-quincena).
3. **Eventos discretos:** **CyberDay (mayo y noviembre)**, **Black Friday**, **Hot Sale**, **Día de la Madre**, **Navidad**. Estos no son estacionalidad — son **shocks de demanda** que multiplican x3–x10. Deben modelarse como **regresores externos** (dummies + lead/lag).

**Manejo correcto:** crea un dataset maestro `eventos_calendario` con todos los eventos pasados y futuros, y sus dummies. Inclúyelo como features en LightGBM/Prophet.

### 3.8 Demand sensing vs demand planning

**Demand planning:** horizonte semanal/mensual, usado para reposición y compras a Idetex. Frecuencia: actualizar una vez por semana.

**Demand sensing:** horizonte diario/intradiario, usado para asignar stock entre Full y Flex, decidir promociones del día, ajustar bids de ads. Frecuencia: actualizar varias veces al día. Usa señales en tiempo real (ad spend, visitas a la publicación, agregados al carrito).

BANVA debe construir **ambos**, en este orden: primero demand planning (semanal) sólido; demand sensing (diario) viene en una segunda fase.

### 3.9 Forecast Value Added (FVA) [26]

Pregunta clave de Gilliland: **¿el ajuste humano al forecast estadístico realmente lo mejora?** Sorprendentemente, los estudios SAS muestran que en >50% de los casos los ajustes humanos **destruyen valor**. FVA mide:

$$\text{FVA} = \text{WMAPE}_{\text{baseline naive}} - \text{WMAPE}_{\text{nuevo método}}$$

Aplica a cada paso del proceso: naive → estadístico → ML → ajuste humano → ajuste comercial. Si el ajuste comercial empeora el WMAPE, **elimínalo**.

### 3.10 Cómo aplicar la Parte 3 a BANVA

1. **Establece WMAPE como métrica oficial** de forecast accuracy en BANVA Bodega. Calcúlalo semanalmente por SKU, agrupando por cuadrante ABC-XYZ.
2. **Implementa Holt-Winters multiplicativo** para SKUs X/Y con > 6 meses de historia. Implementa **TSB** para SKUs Z. Esto se hace en Python en 2 semanas.
3. **Crea el dataset maestro de eventos** con todos los CyberDays, Hot Sales, Día de la Madre/Padre/Niño, Navidad, Black Friday. Úsalo como regresor externo.
4. **Implementa el cálculo de bias y tracking signal** por SKU. Cualquier SKU con tracking signal > |4| debe revisarse manualmente.
5. **Mide FVA antes de implementar ajustes manuales.** Si tu intuición no agrega valor, no la añadas al sistema.
6. **Roadmap ML:** mes 6, migra a LightGBM global model con features. Mes 12, evalúa AWS Forecast (DeepAR) si justifica el costo.

---

## PARTE 4 — POLÍTICAS DE REPOSICIÓN

### 4.1 EOQ (Wilson, 1934) — el modelo fundacional

El Economic Order Quantity es la respuesta matemática a la pregunta: ¿cuánto debo pedir cada vez? Minimiza la suma del costo de ordenar más el costo de mantener.

#### Derivación

Costo total anual:
$$TC(Q) = \frac{D}{Q}S + \frac{Q}{2}H + DC$$

Derivando respecto a Q e igualando a cero:
$$\frac{dTC}{dQ} = -\frac{DS}{Q^2} + \frac{H}{2} = 0$$

Despejando:
$$\boxed{Q^* = \sqrt{\frac{2DS}{H}}}$$

#### Supuestos críticos (y cuándo se rompen)

1. Demanda constante y conocida → en realidad es estocástica
2. Lead time constante → en realidad varía
3. No hay descuentos por volumen → en realidad sí los hay
4. No hay restricciones de capacidad → en realidad sí
5. Costo de ordenar fijo → en realidad puede variar

A pesar de los supuestos, EOQ es un **buen punto de partida** porque la curva de costo total es **plana cerca del óptimo**: si te equivocas en ±25% en Q, el costo total sube solo ~2% [1, cap. 5]. Por eso EOQ sigue siendo valioso aunque sus supuestos sean falsos.

#### Ejemplo numérico BANVA

SKU: Quilt Atenas Beige 2P
- D = 24 unidades/semana × 52 = **1.248 unidades/año**
- S = $25.000 CLP por OC
- C = $12.000 CLP costo unitario
- i = 30% → H = $3.600/unidad/año

$$Q^* = \sqrt{\frac{2 \cdot 1248 \cdot 25000}{3600}} = \sqrt{17.333} \approx 132 \text{ unidades}$$

**Interpretación:** pedir lotes de ~132 unidades a Idetex. Frecuencia: 1248/132 ≈ 9,5 órdenes/año (cada ~5,5 semanas). El costo total mínimo es $474.000/año en costos de inventario para este SKU.

### 4.2 Extensiones del EOQ

**EOQ con descuentos por cantidad:** si Idetex te ofrece descuento por pedir 200+ unidades, debes evaluar si el ahorro de C compensa el aumento de H. Algoritmo: calcula el TC en cada quiebre de descuento y elige el menor.

**EPQ (Economic Production Quantity):** variante para producción donde el reabastecimiento no es instantáneo. No aplica directo a BANVA salvo que en algún momento maquilen (caso suplementos FNL del histórico).

**Wagner-Whitin [20]:** algoritmo de programación dinámica para demanda variable conocida. Encuentra el lot sizing óptimo cuando la demanda no es constante. Más complejo pero superior cuando hay estacionalidad fuerte. **Aplicable a BANVA para SKUs estacionales (quilts) cuando ya tienes forecast confiable.**

### 4.3 Políticas de control: continua vs periódica

Existen 4 políticas canónicas [1, cap. 7]:

| Política | Cómo funciona | Cuándo usarla |
|---|---|---|
| **(s, Q)** | Cuando inventario ≤ s, pedir Q fijo | SKUs A: monitoreo continuo, lote estable |
| **(s, S)** | Cuando inventario ≤ s, pedir hasta S | SKUs A con demanda variable |
| **(R, S)** | Cada R días, pedir hasta S | SKUs B/C: revisión periódica simple |
| **(R, s, S)** | Cada R días, si inventario ≤ s, pedir hasta S | Híbrido para SKUs B con demanda variable |

**Para BANVA con WMS propio que conoce stock en tiempo real, las políticas continuas (s, Q) y (s, S) son superiores** porque no esperan al ciclo de revisión. La política (R, S) tiene sentido solo para insumos de bodega o SKUs C de muy baja rotación.

### 4.4 Safety stock — fórmulas y métodos

#### 4.4.1 Fórmula básica con demanda y lead time variables

Cuando tanto la demanda como el lead time son aleatorios e independientes:

$$SS = z \cdot \sqrt{LT \cdot \sigma_D^2 + \bar{D}^2 \cdot \sigma_{LT}^2}$$

donde:
- **z** = factor de servicio (de la tabla normal)
- **LT** = lead time promedio
- **σ_D** = desviación estándar de demanda por período
- **D** = demanda promedio por período
- **σ_LT** = desviación estándar del lead time

**Esta es la fórmula que debes implementar en BANVA Bodega.** La mayoría de los e-commerce solo consideran σ_D e ignoran σ_LT, lo que subestima el safety stock cuando el proveedor es errático. Para Idetex (lead time 30–45 días), σ_LT no es despreciable.

#### 4.4.2 Service level: ciclo vs fill rate

Hay dos definiciones distintas de service level [1, cap. 7]:

- **CSL (Cycle Service Level):** probabilidad de no tener stockout en un ciclo de reposición. Si CSL = 95%, en 5% de los ciclos habrá algún quiebre (de cualquier magnitud).
- **Fill Rate (β):** fracción de la demanda que se sirve directo del stock. Si fill rate = 95%, el 5% de las unidades demandadas se pierden.

**Estos NO son iguales.** CSL = 95% puede corresponder a fill rate de 99% si los stockouts son pequeños, o a 90% si son grandes. **Para retail, fill rate es la métrica relevante.** Su cálculo es más complejo (involucra la función de pérdida normal) pero es lo que debe optimizarse.

#### 4.4.3 Tabla de factores z por service level

| Service Level | Z |
|---|---|
| 90% | 1,28 |
| 95% | 1,65 |
| 97% | 1,88 |
| 98% | 2,05 |
| 99% | 2,33 |
| 99,5% | 2,58 |
| 99,9% | 3,09 |

**Crítico:** subir de 95% a 99% **duplica el safety stock** (z pasa de 1,65 a 2,33). Por eso no se busca 99,9% para todos los SKUs — se busca el nivel óptimo por cuadrante ABC-XYZ.

#### 4.4.4 Service level targets recomendados por cuadrante

| Cuadrante | Service Level (Fill Rate) |
|---|---|
| AX | 99% |
| AY | 98% |
| AZ | 95% (alto pero no extremo, porque el costo del SS sería prohibitivo) |
| BX | 97% |
| BY | 95% |
| BZ | 92% |
| CX | 95% |
| CY | 90% |
| CZ | 85% (o descontinuar) |

#### 4.4.5 Reorder Point (ROP)

$$\text{ROP} = \bar{D} \cdot LT + SS$$

**Ejemplo Quilt Atenas Beige 2P:**
- D = 24/semana
- LT promedio Idetex = 5 semanas
- σ_D = 8 (alto, asumimos CV = 0,33)
- σ_LT = 1 semana
- z = 1,88 (97%, asumiendo SKU tipo AY)

$$SS = 1{,}88 \cdot \sqrt{5 \cdot 64 + 576 \cdot 1} = 1{,}88 \cdot \sqrt{896} = 1{,}88 \cdot 29{,}9 \approx 56 \text{ unidades}$$

$$\text{ROP} = 24 \cdot 5 + 56 = 120 + 56 = 176 \text{ unidades}$$

**Interpretación:** cuando el stock disponible (no físico, sino disponible = físico − reservado) cae a 176 unidades, dispara una OC a Idetex por Q = 132. Esto debe estar **automatizado** en BANVA Bodega.

### 4.5 Multi-Echelon Inventory Optimization (MEIO)

MEIO [Graves & Willems, 23] resuelve el problema de **dónde colocar el safety stock cuando tienes varias bodegas**. La intuición clave: no necesitas safety stock en cada bodega; puedes consolidarlo aguas arriba ("decoupling point") para aprovechar el **risk pooling** (la varianza agregada es menor que la suma de varianzas).

Para BANVA con bodega central + Full + Flex:
- **Cycle stock** debe estar en Full para cumplir promesa de tiempo MELI
- **Safety stock** puede estar parcialmente en bodega central, repuesto a Full vía replenishment frecuente
- Esta arquitectura **reduce inventario total ~20–30%** vs. duplicar safety stock en ambos lugares

Amazon hace MEIO a escala continental; tú lo harás entre 2 nodos (central + Full).

### 4.6 Base stock policy

Caso especial de (s, S) donde s = S − 1: cada vez que vendes una unidad, ordenas una. Solo viable cuando ordering cost es muy bajo (ej. dropshipping). **No aplica a BANVA con Idetex** porque cada OC tiene fricción.

### 4.7 Min/max dinámico

Variante moderna donde min y max no son fijos sino que **se recalculan diariamente** en base a forecast actualizado, lead time observado y stock proyectado. Es el estándar de RELEX, ToolsGroup y AWS Supply Chain. **Es lo que debes implementar en BANVA Bodega** una vez que el forecast sea confiable.

### 4.8 Cómo aplicar la Parte 4 a BANVA

1. **Implementa la fórmula completa de safety stock** (con σ_D y σ_LT) en BANVA Bodega como función SQL/Edge Function.
2. **Configura el service level target por cuadrante ABC-XYZ** según la tabla 4.4.4.
3. **Calcula EOQ por SKU A y B** como punto de partida; permite override manual cuando hay restricciones de Idetex (lotes mínimos, MOQ).
4. **Implementa política (s, Q) automatizada para SKUs A** y (R, S) semanal para SKUs C.
5. **Mide σ_LT real de Idetex** con los últimos 12 meses de OC. Probablemente descubrirás que es más alto de lo que asumes, y eso justifica más safety stock del que hoy mantienes en SKUs críticos.
6. **Implementa MEIO simple entre bodega central y Full:** safety stock consolidado en central, replenishment a Full 2x/semana basado en velocidad observada.
7. **Automatiza generación de OC sugerida**: cuando un SKU cruza el ROP, BANVA Bodega genera una OC borrador con Q = EOQ ajustado, lista para que tú o Enrique aprueben en 1 click.

---

> **Fin de la Entrega 1 de 3.** Próxima entrega: Partes 5–8 (Operación de Bodega WMS, Métricas e Indicadores, Cómo lo hacen los gigantes, Tecnología y Stack). Confírmame para continuar.
