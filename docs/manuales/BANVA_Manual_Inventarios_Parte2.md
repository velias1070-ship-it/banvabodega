# Manual de Gestión de Inventarios de Clase Mundial — BANVA SPA
## Entrega 2 de 3: Partes 5–8

> Continuación. Referencias bibliográficas [n] definidas en la Entrega 1.
>
> **Fuentes adicionales usadas en esta entrega:**
> [36] Frazelle, E. — *World-Class Warehousing and Material Handling*, 2ª ed., McGraw-Hill, 2016.
> [37] Bartholdi & Hackman — *Warehouse & Distribution Science*, v0.98, Georgia Tech, 2019 (open access).
> [38] Tompkins et al. — *Facilities Planning*, 4ª ed., Wiley, 2010.
> [39] De Koster, Le-Duc & Roodbergen — "Design and control of warehouse order picking: A literature review", *EJOR*, 2007.
> [40] Petersen & Aase — "A comparison of picking, storage, and routing policies in manual order picking", *IJPE*, 2004.
> [41] Wulfraat, M. — *MWPVL International Reports on Amazon FC operations*, 2014–2023.
> [42] Amazon — US Patent 8,615,473 "Method and system for anticipatory package shipping", 2013.
> [43] Onal, Zhang & Das — "Modeling Random Storage in Amazon Fulfillment Centers", *POMS*, 2017.
> [44] Fishman, C. — *The Wal-Mart Effect*, Penguin, 2006.
> [45] Stanford GSB — "Wal-Mart Stores Inc.", Case GS-25, 2003.
> [46] Berman, B. — "Flatter and faster: Strategies for managing the supply chain at Zara", *Business Horizons*, 2011.
> [47] Caro & Gallien — "Inventory management of a fast-fashion retail network", *Operations Research*, 2010 (caso Zara/Inditex).
> [48] McAfee, A. — "Shein: The Tiktok of E-commerce", MIT Sloan, 2023.
> [49] Lashinsky, A. — *Inside Apple*, Business Plus, 2012 (Tim Cook & inventory).
> [50] Gartner Supply Chain Top 25 — informes anuales 2018–2024.
> [51] Manhattan Associates — *Active Warehouse Management Documentation*, 2023.
> [52] Blue Yonder — *Luminate Platform Whitepapers*, 2023.
> [53] MercadoLibre — *Mercado Envíos Full: Manual del Vendedor* y API docs, 2024.

---

## PARTE 5 — OPERACIÓN DE BODEGA (WMS DE CLASE MUNDIAL)

### 5.1 Procesos core de un WMS

Frazelle [36, cap. 2] descompone la operación de bodega en 7 procesos esenciales que cualquier WMS debe soportar:

| # | Proceso | Definición | KPI principal |
|---|---|---|---|
| 1 | **Receiving** | Recepción física, conteo, inspección de calidad, ingreso al sistema | Dock-to-stock time |
| 2 | **Put-away** | Asignación de ubicación física y traslado | Put-away cycle time |
| 3 | **Storage** | Almacenamiento estructurado | Cubic utilization, IRA |
| 4 | **Picking** | Extracción de unidades para cumplir pedidos | Picks/hour, pick accuracy |
| 5 | **Packing** | Embalaje, etiquetado, validación | Packs/hour |
| 6 | **Shipping** | Despacho a courier o entrega directa | On-time dispatch rate |
| 7 | **Returns** | Procesamiento de devoluciones | Return cycle time, recovery rate |

**Para BANVA con Joaquín como warehouse operator y Vicho como helper, los 7 procesos existen pero la mayoría son manuales/informales.** El objetivo de BANVA Bodega es codificarlos como flujos digitales con trazabilidad por evento.

### 5.2 Receiving: el cuello de botella subestimado

El receiving define la calidad de **todos los datos** posteriores. Si recepcionas mal, todo el inventario está sucio. Frazelle [36] reporta que en bodegas inmaduras 40–60% de las discrepancias de inventario nacen en receiving.

**Buenas prácticas obligatorias:**

1. **Pre-receipt notification (ASN):** el proveedor te envía la lista de qué viene **antes** de que llegue el camión. Idetex debería enviarte esto vía email/Excel; en BANVA Bodega debe poder importarse para pre-cargar la recepción.
2. **Blind count:** quien recibe **no ve** las cantidades del ASN; cuenta a ciegas. Luego el sistema compara y reporta discrepancias. Esto evita el sesgo de "vi 50 en el papel, anoto 50 sin contar".
3. **Inspección por muestreo (AQL):** revisa 10% de unidades por defectos visibles antes de aceptar. Documenta defectos con foto.
4. **Tiempo objetivo dock-to-stock:** clase mundial = **< 4 horas** desde llegada del camión hasta SKU disponible para venta. Bodegas inmaduras = 24–72 horas. **Para BANVA, target inicial razonable: < 24 horas. Target maduro: < 8 horas.**

### 5.3 Slotting: dónde poner cada SKU

**Slotting** es la asignación inteligente de SKUs a ubicaciones físicas. Bartholdi & Hackman [37, cap. 4] muestran que un buen slotting puede reducir el tiempo de picking en **30–50%** sin invertir un peso adicional. Es la palanca de productividad más rentable de toda la operación.

#### 5.3.1 Criterios de slotting

| Criterio | Lógica | Aplicación BANVA |
|---|---|---|
| **Por velocidad (cube-per-order index, COI)** | Fast movers en zona dorada (golden zone) entre cintura y hombro. Slow movers en alto/bajo. | Top 30 SKUs (Estrellas + Volumen) en zona dorada |
| **Por afinidad** | SKUs que se piden juntos cerca | Sets de toallas + cubrecolchones (compras de baño/dormitorio) |
| **Por peso** | Pesados abajo (ergonomía y seguridad) | Quilts King vs. fundas almohada |
| **Por categoría** | Familia agrupada (browsing del picker) | Toallas Cannon todas juntas |
| **Por rotación FIFO/FEFO** | Lo más antiguo más accesible | Crítico para SKUs con cambios de modelo/temporada |

**El método óptimo combina velocidad + afinidad.** Frazelle propone el Cube-per-Order Index (COI):

$$COI_i = \frac{V_i \cdot \text{cubic\_size}_i}{\text{picks}_i}$$

SKUs con bajo COI van más cerca del punto de despacho.

#### 5.3.2 Golden zone

Zona ergonómica entre 60 cm y 150 cm de altura. El picker no se agacha ni se estira. Bartholdi [37] reporta que mover un SKU del piso a la golden zone reduce el tiempo de pick por unidad en **15–30%** y reduce errores ergonómicos.

**Regla práctica BANVA:** los 30 SKUs más vendidos deben estar en golden zone, cerca del área de packing. Los 100 SKUs intermedios en zonas estándar. Los 215 restantes en alto/bajo o reserva.

#### 5.3.3 Re-slotting periódico

El slotting óptimo cambia con la velocidad. Re-slotting clase mundial: **mensual para SKUs A**, trimestral para B, anual para C. BANVA Bodega debe poder generar la **propuesta de re-slotting** cada lunes en base a velocidad de las últimas 4 semanas — sugerir movimientos, no ejecutarlos automáticamente.

### 5.4 Métodos de picking

De Koster et al. [39] clasifican los métodos de picking en una taxonomía estándar:

| Método | Cómo funciona | Cuándo usarlo | Productividad relativa |
|---|---|---|---|
| **Discrete (single order)** | Un picker, una orden a la vez | Operaciones pequeñas, pedidos grandes | 60–100 picks/hr |
| **Batch picking** | Un picker, múltiples órdenes simultáneas | E-commerce con muchos pedidos pequeños | 100–180 picks/hr |
| **Zone picking** | Bodega dividida en zonas; cada picker su zona | Bodegas grandes (500+ m²) | 150–250 picks/hr |
| **Wave picking** | Pickear en olas sincronizadas con courier | Cut-off times estrictos | 120–200 picks/hr |
| **Cluster picking** | Batch + carro multi-tote | E-commerce de alto volumen | 150–220 picks/hr |
| **Pick-to-light** | Luces guían al picker a la ubicación | Alto volumen, baja diversidad | 250–400 picks/hr |
| **Voice picking** | Audífonos guían por voz | Manos libres, ambientes fríos | 200–350 picks/hr |

**Para BANVA con volumen de ~3.000 unidades/mes y 1–2 pickers, el método óptimo es batch picking con cluster (carrito con 6–10 totes).** Discrete es ineficiente; pick-to-light/voice son sobre-inversión hasta superar 10.000 unidades/mes.

### 5.5 Rutas de picking

Cómo recorre el picker la bodega. Petersen & Aase [40] comparan 5 estrategias:

| Estrategia | Descripción | Eficiencia relativa |
|---|---|---|
| **S-shape (traversal)** | Recorre cada pasillo completo en serpentina | Simple, 100% baseline |
| **Return** | Entra y sale del mismo extremo del pasillo | -10% vs S-shape para órdenes pequeñas |
| **Midpoint** | Mitad del pasillo, vuelve | -5% vs S-shape |
| **Largest gap** | Optimiza saltando el mayor hueco entre picks | -20% vs S-shape |
| **Optimal (TSP)** | Resuelve el Travelling Salesman Problem por orden | -30% vs S-shape |

**TSP óptimo es complejo de calcular pero hoy es factible**: BANVA Bodega ya implementa optimización serpentina para Full según el histórico. **Próximo paso:** pasar de serpentina a TSP por orden usando algoritmo de aproximación (nearest neighbor o Christofides). El paper de Bartholdi [37] tiene el código de referencia.

### 5.6 Cycle counting vs. inventario físico anual

El inventario físico anual (cerrar bodega 1–2 días para contar todo) es **un anti-patrón en bodegas modernas** [36, cap. 8]. Razones:
1. Detiene la operación
2. Detecta errores demasiado tarde (acumulados de un año)
3. No identifica causas raíz

**Cycle counting** es el reemplazo: contar **un subconjunto pequeño cada día**, de forma que en el año completo se cuenten todos los SKUs, los más críticos varias veces.

#### 5.6.1 Frecuencia ABC para cycle counting

| Clase | Frecuencia |
|---|---|
| **A** | 1 vez al mes (12x/año) |
| **B** | 1 vez al trimestre (4x/año) |
| **C** | 1 vez al año |

Para BANVA con ~345 SKUs:
- 30 SKUs A × 12 = 360 conteos/año
- 70 SKUs B × 4 = 280 conteos/año
- 245 SKUs C × 1 = 245 conteos/año
- **Total: 885 conteos/año = ~3,4 conteos por día hábil**

3-4 SKUs por día. Joaquín lo hace en 30 minutos antes de abrir picking. **BANVA Bodega debe generar la lista del día automáticamente.**

#### 5.6.2 Métricas del cycle count

- **IRA (Inventory Record Accuracy):** % de ubicaciones donde el conteo físico = sistema, dentro de tolerancia.
- **Tolerancia:** 0% para SKUs A, ±1 unidad para B, ±2 para C (o ±3% del total).
- **Benchmark clase mundial: IRA > 99%.** Bodegas inmaduras: 70–85%.

Cada discrepancia se investiga: ¿error de picking? ¿error de receiving? ¿robo? ¿daño no reportado? La causa raíz alimenta mejoras de proceso.

### 5.7 Cómo Amazon opera sus FCs — random stow / chaotic storage

Amazon [41, 43] revolucionó la gestión de bodegas con el principio contraintuitivo del **random stow** (también llamado chaotic storage):

**Principio:** los productos **no** se almacenan por categoría, sino en **cualquier ubicación libre** (un libro al lado de un cargador al lado de un peluche). El sistema sabe dónde está cada cosa por escaneo de barra al momento de stow.

**Por qué funciona:**
1. **Eliminates congestion:** dos pickers no compiten por el mismo pasillo de "libros"
2. **Maximizes density:** cada hueco se llena sin esperar el SKU "correcto"
3. **Reduces search time:** el sistema dirige al picker exacto, no necesita lógica humana
4. **Diluye picking peaks:** las órdenes de un SKU popular están distribuidas

**Limitación:** requiere **escaneo de barras 100% confiable** y un WMS robusto. Sin eso, pierdes todo. Amazon también usa robots Kiva/Proteus que **traen el estante al picker**, eliminando el caminar.

**¿Aplica a BANVA?** Parcialmente. Random stow puro no es óptimo en bodegas pequeñas (<500 m²) porque el ahorro de congestión es marginal. Pero hay 2 lecciones transferibles:
1. **Múltiples ubicaciones por SKU:** si un quilt popular tiene 100 unidades, divídelas en 2-3 ubicaciones distintas. Reduce congestión de picking.
2. **Ubicaciones flexibles:** no asignes ubicaciones permanentes a SKUs C; libera la ubicación cuando se vacía.

### 5.8 KPIs operativos de bodega — tabla maestra

| KPI | Fórmula | Benchmark clase mundial | Mínimo aceptable |
|---|---|---|---|
| **Lines per hour** | Líneas pickeadas / horas-hombre | > 80 | > 40 |
| **Picks per hour** | Unidades / horas-hombre | > 150 | > 70 |
| **Order cycle time** | Tiempo de pedido → despacho | < 4 hr | < 24 hr |
| **Dock-to-stock time** | Recepción → disponible para venta | < 4 hr | < 24 hr |
| **Inventory record accuracy (IRA)** | Conteos OK / conteos totales | > 99% | > 95% |
| **Pick accuracy** | Picks correctos / picks totales | > 99,9% | > 99% |
| **Perfect order rate** | A tiempo + completo + sin daño + correcto | > 95% | > 85% |
| **Cubic utilization** | Volumen ocupado / volumen útil | 60–75% | > 50% |
| **Damage rate** | Unidades dañadas / unidades manejadas | < 0,1% | < 0,5% |
| **Returns processing time** | Recepción devolución → reingreso a stock | < 24 hr | < 72 hr |

### 5.9 Cómo aplicar la Parte 5 a BANVA

1. **Codifica los 7 procesos core en BANVA Bodega** como flujos digitales con eventos timestamp. Si no está en el sistema, no existe.
2. **Implementa blind count en receiving** — el operador cuenta sin ver ASN; el sistema compara después.
3. **Re-slotting de los 30 SKUs A a golden zone** este mes. Mide tiempo de pick antes/después.
4. **Migra de discrete picking a batch picking con cluster** (carrito de 6–10 totes). Productividad esperada +50–80%.
5. **Implementa cycle counting diario** (~4 SKUs/día) con generación automática de lista. Mide IRA semanalmente. Target: 95% en 3 meses, 99% en 12 meses.
6. **Mide los 10 KPIs de la tabla 5.8** desde semana 1. Sin línea base, no hay mejora.
7. **Implementa optimización TSP de rutas de pick** para Full y Flex. Reducción esperada de 20–30% en tiempo de picking.

---

## PARTE 6 — MÉTRICAS E INDICADORES (NIVEL OBSESIVO)

### 6.1 El principio: lo que no se mide no se gestiona

Peter Drucker. Lapide [14] añade el corolario: **lo que se mide mal, se gestiona peor que no medir**. Esta sección entrega cada KPI con: fórmula, interpretación, benchmark clase mundial, mínimo aceptable, y aplicación a BANVA.

### 6.2 Métricas de rotación y eficiencia de capital

#### 6.2.1 Inventory Turnover (Rotación)

$$\text{Turnover} = \frac{\text{COGS anual}}{\text{Inventario promedio (a costo)}}$$

Mide cuántas veces al año "se da vuelta" el inventario completo.

| Sector | Benchmark clase mundial | Mínimo aceptable |
|---|---|---|
| Grocery (Walmart, Costco) | 12–24x | 8x |
| Fast fashion (Zara) | 12x | 8x |
| Apparel general | 4–6x | 3x |
| **Home textiles e-commerce** | **6–8x** | **4x** |
| Joyería | 1–2x | 0,8x |
| Apple (electrónica) | 60x+ (Tim Cook era) | — |

**Interpretación BANVA:** asumiendo COGS anual ~$540M e inventario promedio ~$120M, turnover = 4,5x. **Estás en el mínimo aceptable.** Target 12 meses: 6x. Target 24 meses: 8x. Cada punto de turnover libera ~$20M de caja.

#### 6.2.2 Days Inventory Outstanding (DIO) / Days of Supply

$$\text{DIO} = \frac{\text{Inventario promedio}}{\text{COGS anual}} \cdot 365 = \frac{365}{\text{Turnover}}$$

Es el inverso del turnover, expresado en días. Más intuitivo para operadores.

| BANVA hoy | Target 12m | Target 24m | Apple Tim Cook |
|---|---|---|---|
| ~81 días | 60 días | 45 días | 5 días |

#### 6.2.3 Sell-through rate

$$\text{Sell-through} = \frac{\text{Unidades vendidas en período}}{\text{Unidades recibidas (o inicial+recibidas)}}$$

Métrica clave en moda. Mide qué % de lo comprado se vendió. Zara apunta a >85% de sell-through a precio completo en cada temporada.

**Para BANVA por colección Idetex:** mide sell-through a 60, 90 y 120 días después de recepción. SKUs con sell-through < 30% a 90 días son candidatos a markdown agresivo.

#### 6.2.4 GMROI (Gross Margin Return on Investment)

$$\text{GMROI} = \frac{\text{Margen bruto anual}}{\text{Inventario promedio (a costo)}}$$

**El KPI más importante de retail.** Une rentabilidad con eficiencia de capital. Responde: ¿cuánto margen bruto genero por cada peso invertido en inventario?

| Benchmark | Valor |
|---|---|
| Best-in-class home retail | > $3,5 por $1 |
| Bueno | $2,5–3,5 |
| Aceptable | $1,5–2,5 |
| Problemático | < $1,5 |

**BANVA:** margen bruto anual ~$170M / inventario promedio ~$120M = **GMROI ~$1,4**. Estás bajo aceptable. **Esto es la prueba numérica de que el problema central de BANVA hoy no es facturación sino eficiencia de capital de inventario.**

#### 6.2.5 Variantes de GMROI

- **GMROII (Investment+Inventory):** incluye también la inversión adicional (espacio, mano de obra)
- **GMROF (Floor):** margen bruto / pies cuadrados de bodega — mide eficiencia de espacio
- **GMROS (Square foot):** sinónimo de GMROF en algunos textos

Para BANVA, **GMROI puro es suficiente** como KPI principal. GMROF es relevante cuando estés evaluando expandir bodega.

#### 6.2.6 Stock-to-sales ratio

$$\text{Stock-to-sales} = \frac{\text{Inventario al inicio del mes}}{\text{Ventas del mes}}$$

Métrica de planning de moda. Si vale 4, tienes 4 meses de inventario. Para BANVA debería estar entre 1,5 y 2,5 según estacionalidad.

### 6.3 Métricas de servicio

#### 6.3.1 Fill rate

Tres niveles:

| Nivel | Fórmula | Cuándo usarlo |
|---|---|---|
| **Unit fill rate** | Unidades servidas / unidades pedidas | Métrica más estricta, granular |
| **Line fill rate** | Líneas servidas completas / líneas pedidas | Para B2B con pedidos multi-línea |
| **Order fill rate** | Órdenes 100% completas / órdenes totales | Más agresiva: una línea faltante = orden incompleta |

**Para BANVA en MELI (B2C, 1 línea típica):** unit fill rate y order fill rate son prácticamente iguales. Target: **> 97%** global.

#### 6.3.2 OTIF (On-Time In-Full)

$$\text{OTIF} = \frac{\text{Pedidos a tiempo Y completos}}{\text{Pedidos totales}}$$

KPI estándar B2B y retail-supplier. Walmart penaliza con multas a proveedores con OTIF < 85%. Para BANVA aplica a la relación con Idetex (¿cumple Idetex sus OTIF?) y a tu propia entrega vía Full/Flex (¿MELI cumple OTIF a tus clientes con tu inventario?).

#### 6.3.3 Perfect Order Rate

$$\text{POR} = \text{OTIF} \times \text{Sin daño} \times \text{Documentación correcta} \times \text{Sin error de pick}$$

Es multiplicativo: 95% × 98% × 99% × 99% = **91%**. Por eso es tan duro. Benchmark clase mundial: **> 95%**.

#### 6.3.4 Stockout rate y lost sales estimation

$$\text{Stockout rate} = \frac{\text{Días-SKU en stockout}}{\text{Días-SKU totales}}$$

Para estimar lost sales:

$$\text{Lost sales (unidades)} \approx \text{Velocidad promedio del SKU} \times \text{Días en stockout}$$

**Aplicación BANVA:** los 151 SKUs hoy en quiebre están perdiendo ~150 × velocidad promedio × días. Si la velocidad promedio es 2 unidades/semana y el quiebre dura 21 días en promedio: **~900 unidades de lost sales potencial al mes**. A margen unitario promedio $5.000 = **$4,5M de margen perdido al mes** solo por stockouts.

### 6.4 Métricas financieras

#### 6.4.1 Cash Conversion Cycle (CCC)

Ya cubierto en Parte 1.5. Para BANVA: **35 días hoy → target 15 días en 18 meses**.

#### 6.4.2 Inventory-to-sales ratio

$$\frac{\text{Inventario al cierre}}{\text{Ventas del mes}}$$

Versión mensual del DIO. Más usado por CFOs. Para textiles e-commerce: <2,0 saludable, >3,0 problemático.

#### 6.4.3 Carrying cost as % of inventory value

Cubierto en 1.3.1. La tasa **i** total. Target BANVA: medirla y mantenerla < 30%.

### 6.5 Métricas de calidad del inventario

#### 6.5.1 Shrinkage rate

$$\text{Shrinkage} = \frac{\text{Inventario contable} - \text{Inventario físico}}{\text{Ventas del período}}$$

Mide pérdidas por robo, daño y error administrativo. Benchmark retail: <1%, mejor en clase <0,5%.

#### 6.5.2 Dead stock ratio

$$\text{Dead stock} \% = \frac{\text{Valor SKUs sin movimiento >180 días}}{\text{Valor inventario total}}$$

| Benchmark | Valor |
|---|---|
| Excelente | < 5% |
| Aceptable | 5–10% |
| Problemático | 10–20% |
| **BANVA estimado actual** | **15–25%** (91 SKUs × valor promedio) |

#### 6.5.3 Backorder rate

$$\frac{\text{Órdenes con backorder}}{\text{Órdenes totales}}$$

En MELI no aplica directamente porque MELI cancela el pedido si no hay stock al momento de venta — no hay backorder, hay lost sale. Pero sí aplica para evaluar cuántas veces tuviste que pausar publicaciones.

### 6.6 Métricas de proveedor

#### 6.6.1 Lead time variability

$$\sigma_{LT} = \text{desv. estándar de los LT observados últimos 12 meses}$$

CV del lead time = σ_LT / LT promedio. **Para Idetex, mide esto con todas las OC del último año.** Si CV > 0,3, tu proveedor es inestable y necesitas más safety stock (Parte 4).

#### 6.6.2 Forecast Accuracy (WMAPE)

Cubierto en Parte 3. **Reportar mensualmente por cuadrante ABC-XYZ.**

### 6.7 Tabla maestra de KPIs — la "single source of truth" de BANVA

| # | KPI | Categoría | Frecuencia | Owner | Benchmark CM | Mínimo OK | BANVA target 12m |
|---|---|---|---|---|---|---|---|
| 1 | Inventory turnover | Capital | Mensual | Vicente | 8x | 4x | 6x |
| 2 | DIO | Capital | Mensual | Vicente | 45 d | 90 d | 60 d |
| 3 | GMROI | Capital | Mensual | Vicente | $3,5 | $1,5 | $2,5 |
| 4 | Sell-through 90d | Capital | Mensual | Enrique | 80% | 50% | 70% |
| 5 | Dead stock % | Capital | Mensual | Vicente | 5% | 15% | 8% |
| 6 | CCC | Capital | Mensual | Vicente | 15 d | 45 d | 25 d |
| 7 | Fill rate | Servicio | Semanal | Joaquín | 98% | 92% | 96% |
| 8 | Stockout rate | Servicio | Semanal | Enrique | 1% | 5% | 2% |
| 9 | Lost sales $ estimado | Servicio | Mensual | Vicente | < $1M | < $5M | < $2M |
| 10 | Perfect order rate | Servicio | Semanal | Joaquín | 95% | 85% | 92% |
| 11 | IRA | Calidad | Semanal | Joaquín | 99% | 95% | 98% |
| 12 | Pick accuracy | Calidad | Semanal | Joaquín | 99,9% | 99% | 99,5% |
| 13 | Damage rate | Calidad | Mensual | Joaquín | 0,1% | 0,5% | 0,3% |
| 14 | Shrinkage rate | Calidad | Trimestral | Vicente | 0,5% | 1,5% | 1% |
| 15 | Dock-to-stock time | Operación | Semanal | Joaquín | 4 hr | 24 hr | 8 hr |
| 16 | Order cycle time | Operación | Semanal | Joaquín | 4 hr | 24 hr | 8 hr |
| 17 | Lines per hour | Operación | Semanal | Joaquín | 80 | 40 | 60 |
| 18 | Idetex OTIF | Proveedor | Mensual | Vicente | 95% | 80% | 90% |
| 19 | Idetex lead time CV | Proveedor | Mensual | Vicente | 0,15 | 0,4 | 0,25 |
| 20 | Forecast WMAPE (A) | Forecast | Mensual | Vicente | 20% | 40% | 25% |
| 21 | Forecast WMAPE (B) | Forecast | Mensual | Vicente | 30% | 50% | 35% |
| 22 | Forecast Bias | Forecast | Mensual | Vicente | ±2% | ±10% | ±5% |
| 23 | Tracking signal | Forecast | Semanal | Vicente | <\|3\| | <\|6\| | <\|4\| |
| 24 | Return rate | Calidad | Mensual | Enrique | 2% | 8% | 4% |
| 25 | Carrying cost % | Capital | Anual | Vicente | 25% | 35% | 28% |

**Esta tabla es el dashboard único de BANVA Bodega.** Cada KPI tiene owner explícito y frecuencia clara. La revisión semanal de Vicente debe abrir esta tabla y nada más.

### 6.8 Cómo aplicar la Parte 6 a BANVA

1. **Implementa los 25 KPIs en BANVA Bodega como dashboard único.** Stop con dashboards múltiples; uno solo, este.
2. **Asigna owner y frecuencia explícita.** Sin owner no se mide.
3. **Establece la línea base de cada KPI con datos del último mes** (no del último año, porque las prácticas están cambiando).
4. **Define los target a 12 meses** (la columna BANVA target). Estos son tus OKRs operativos.
5. **Revisión semanal estructurada de 30 min:** los 12 KPIs semanales con tendencia 4 semanas. Cualquier KPI rojo dispara causa raíz.
6. **Revisión mensual estructurada de 90 min:** los 25 KPIs con tendencia 6 meses. Decisiones estructurales de inventario.

---

## PARTE 7 — CÓMO LO HACEN LOS GIGANTES

### 7.1 Amazon — anticipatory shipping y forecasting con deep learning

#### Modelo operativo

Amazon opera la red de bodegas más sofisticada del planeta: ~175 FCs en EE.UU., 200+ globalmente [41]. Su filosofía operativa se resume en tres principios documentados en shareholder letters de Bezos [13]:

1. **Customer obsession sobre eficiencia local:** prefieren tener stock disponible en el lugar correcto aunque cueste más, que ahorrar y fallar al cliente.
2. **Long-term thinking:** invierten en infraestructura que toma años en pagar (Kiva $775M en 2012, Proteus 2022).
3. **Data-driven everything:** cada decisión operativa tiene un modelo detrás.

#### Tecnología clave

**Random stow / chaotic storage** (cubierto en 5.7). Implementado a escala extrema: un FC típico tiene 1+ millón de SKUs sin organización por categoría.

**Robotics:** Kiva (2012) y Proteus (2022). Los estantes vienen al picker. Productividad: 300–500 picks/hr vs. 100 manual.

**Forecasting con DeepAR y MQ-CNN** [9, 10]. Amazon Forecast (servicio AWS) expone parte de esta tecnología comercialmente. Cobertura: SKU × FC × hora. Horizonte: hasta 60 días con resolución diaria.

**Anticipatory shipping** [42]. Patente 8,615,473: Amazon **despacha inventario hacia regiones antes de tener pedidos**, basándose en predicción agregada. Cuando llega el pedido, el paquete ya está en un hub regional. Reduce tiempo de entrega final en 12–24 horas. Esto no es ciencia ficción: opera en producción desde 2014.

**Multi-Echelon Inventory Optimization (MEIO)** entre FCs nacionales, regionales y locales. Inventario circular se redistribuye automáticamente.

#### Métricas clave

- Days of inventory: 30–45 días (alto vs Apple, bajo vs retail tradicional)
- Fill rate: ~99%
- Forecast accuracy WMAPE: 15–20% a nivel SKU-FC-día (extraordinario para esa granularidad)
- Picks per hour con robots: 300–500

#### Lecciones para BANVA

1. **Forecast probabilístico, no puntual.** Quantiles, no medias.
2. **Inventario adelantado a Full** = versión simple de anticipatory shipping. Si predices que vas a vender 50 unidades de un SKU en MELI la próxima semana, mándalas a Full **antes** del pico.
3. **Múltiples ubicaciones por SKU** (lección de random stow) reduce congestión de picking incluso a escala BANVA.
4. **Trata el forecasting como producto técnico**, no como cálculo. Mide WMAPE semanal por cuadrante. Itera el modelo.

### 7.2 Walmart — Retail Link, cross-docking y VMI

#### Modelo operativo

Walmart construyó su ventaja competitiva sobre tres palancas de supply chain [29, 44, 45]:

1. **Retail Link (1991):** sistema que **comparte datos de venta diarios con todos sus proveedores en tiempo real**. P&G, Coca-Cola, etc. ven cuántas unidades de cada SKU se vendieron en cada tienda ayer. Esto cambió la industria: el proveedor pasó a tener responsabilidad sobre el reabastecimiento.

2. **Vendor-Managed Inventory (VMI):** el proveedor no solo ve la data, **gestiona** el inventario. P&G decide cuándo enviar Tide a cada centro de distribución de Walmart. El riesgo de exceso/quiebre se traslada al proveedor, que lo administra mejor porque es su producto.

3. **Cross-docking:** producto del proveedor llega al CD de Walmart y se transfiere directo al camión de tienda **sin entrar a almacenamiento**. Tiempo en CD: <24 horas. Esto reduce DIO, costos de bodega y daño.

#### Métricas clave

- Inventory turnover: 8–10x (alto para retail físico)
- DIO: 35–45 días
- OTIF requerido a proveedores: >85% (multas por debajo)
- Cross-dock %: 40–60% del flujo total

#### Lecciones para BANVA

1. **Comparte data con Idetex**. Idetex sabe lo que les vendes pero no en tiempo real. Si les envías un dashboard semanal con velocidad y proyección, Idetex puede pre-producir los SKUs que vienen sin esperar tu OC. Lead time efectivo baja.
2. **Negocia VMI para los top 20 SKUs Idetex.** Idetex se compromete a mantener X días de tu safety stock en su bodega, despachando a demanda. Tú solo pagas lo despachado. Es como tener un "Full" de Idetex para ti.
3. **Cross-dock entre bodega y Full:** lo recibido de Idetex que ya está pre-asignado a Full no entra a tu bodega — se etiqueta y reembarca al CD MELI. BANVA Bodega debe soportar este flujo.

### 7.3 Zara / Inditex — fast fashion y rotación extrema

#### Modelo operativo

Zara redefinió la industria del retail con un modelo opuesto al tradicional [11, 12, 46, 47]:

| Dimensión | Industria tradicional | Zara |
|---|---|---|
| Lead time diseño-tienda | 6–12 meses | 2–3 semanas |
| Producción | Lotes grandes en Asia | Lotes pequeños en Europa cercana (Galicia, Portugal, Marruecos, Turquía) |
| Reposición a tienda | 1–2 veces por temporada | 2 veces por semana |
| Markdowns | 30–50% del inventario | 15–20% |
| Sell-through a precio completo | 60–70% | 85%+ |
| Inventory turnover | 4x | 12x+ |

**El secreto no es velocidad por velocidad — es la combinación de:**
1. **Producción cerca del consumidor** (paga 15–20% más por unidad para ahorrar 60% en lead time)
2. **Lotes pequeños inicialmente** ("test and learn"): lanzan pocas unidades, miden venta, reordenan los ganadores
3. **Reposición frecuente:** las tiendas reciben 2 envíos/semana con assortment ajustado por venta real
4. **Diseño centralizado en La Coruña** que reacciona a data de tienda en 48 horas

#### Tecnología

Caro & Gallien [47] documentan el sistema de **assortment optimization** de Zara: un modelo que decide cada lunes qué SKUs y cantidades enviar a cada tienda esa semana, optimizando margen esperado vs. stockout. El modelo aumentó ventas 3–4% sin aumentar inventario.

#### Métricas clave

- Inventory turnover: 12x+
- Lead time promedio: 15 días para colecciones flash
- Sell-through full price: 85%+
- Markdown %: 15–20%

#### Lecciones para BANVA

1. **"Test and learn" en cada nueva colección Idetex:** no compres 100 unidades de cada SKU nuevo. Compra 20–30, mide 4 semanas, reordena los ganadores con confianza, descontinúa los perdedores antes de generar dead stock. **Esta es la lección #1 de Zara para BANVA y resuelve el problema raíz de los 91 dead stock.**
2. **Reposición frecuente Idetex → bodega:** mejor 4 OCs/mes pequeñas que 1 OC/mes grande. Reduce safety stock requerido y libera caja. Negocia con tu tío.
3. **Assortment dinámico en Full:** no envíes a Full lo mismo cada semana. Envía lo que el modelo predice que vas a vender los próximos 14 días, ajustado semanalmente.
4. **Aceptar pagar más por unidad** a cambio de lead time corto a veces es buen negocio. Compara TCO incluyendo dead stock evitado.

### 7.4 MercadoLibre — Mercado Envíos Full y Price Automation

#### Modelo operativo

MercadoLibre opera una red de FCs propios en Brasil, México, Argentina, Chile, Colombia [27, 53]. **Mercado Envíos Full** es el equivalente latinoamericano de FBA: el vendedor envía el inventario al CD de MELI y MELI hace picking, packing y entrega.

**Beneficios documentados de Full vs. Flex/Custom:**
- **Boost en ranking** (publicaciones Full aparecen primero en search)
- **Promesa de entrega más rápida** (24–48 hr en zonas urbanas)
- **Insignia "Full"** que aumenta CTR ~15%
- **Acceso a campañas exclusivas** (CyberDay Full, Hot Sale Full)

**Costo:** comisión de fulfillment + storage fees por unidad/mes. Storage fees aumentan después de 60–90 días (penaliza dead stock en Full).

#### Cómo MELI penaliza stockouts

Esto es crítico y subestimado:

1. **Caída inmediata de posicionamiento** cuando una publicación se queda sin stock. Ranking penalizado.
2. **Pérdida de "Mercado Líder" status** si la tasa de cancelación por stockout sube.
3. **Recuperación lenta:** una vez repuesto el stock, el algoritmo de MELI tarda **2–6 semanas** en recuperar el posicionamiento previo. Durante ese tiempo, tu CTR y CVR caen 30–50%.
4. **Impacto en ad spend:** las campañas Product Ads pagadas durante stockout se ejecutan pero no convierten — quemas presupuesto sin retorno.

**Para BANVA esta penalización es probablemente la fuente #1 de pérdida.** Los $350K/mes de ad spend en SKUs sin stock que ya identificaste son la punta del iceberg.

#### Price Automation

API de MELI [27] que permite definir **reglas dinámicas de precio** basadas en:
- Precio del competidor más barato
- Stock disponible
- Velocidad de venta
- Margen mínimo configurado

Pueden ser reglas defensivas (igualar competidor) u ofensivas (subir precio cuando hay alta demanda).

#### Lecciones para BANVA

1. **Stockout = pecado capital en MELI.** Cualquier inversión en evitar stockouts en SKUs A (más safety stock, lead time corto, proveedor confiable) tiene ROI altísimo.
2. **No advertise sin stock confirmado.** Pausar campañas automáticamente cuando stock proyectado < 10 días.
3. **Storage fees Full penalizan dead stock.** Auditar mensualmente Full y retirar SKUs C/Z.
4. **Implementar Price Automation API** para los top 30 SKUs con reglas claras: defender precio en KVI, exprimir margen en SKUs únicos.

### 7.5 Costco — alta rotación con SKU count bajo

#### Modelo operativo

Costco opera con ~4.000 SKUs vs. 100.000+ de un Walmart típico. Esa restricción **deliberada** es su ventaja:

- **Volúmenes enormes por SKU** → mayor poder de negociación con proveedores
- **Operación simple:** menos SKUs = menos complejidad de bodega, picking, slotting
- **Rotación: 12–14x** (comparable a Zara)
- **DIO: 30 días**
- **GMROI: $5+** (de los más altos del retail)
- **Treasure hunt:** mantienen 25–30% del assortment como rotación constante de "ofertas únicas" para generar visitas

#### Lecciones para BANVA

1. **Menos SKUs es mejor.** BANVA tiene 345 publicaciones; probablemente debería tener 200. Las 145 long tail (cuadrantes CY/CZ) consumen atención sin generar margen.
2. **Concentra el poder de compra:** menos SKUs → más volumen por SKU → mejor precio Idetex → mejor margen.
3. **Treasure hunt textile:** mantén 5–10 SKUs en rotación de "edición limitada" (colores únicos, set especial). Genera urgencia, justifica precio premium.

### 7.6 Shein — ultra-fast fashion y micro-lotes

#### Modelo operativo

Shein [48] llevó el modelo Zara a un extremo:

- **Lead time:** 5–7 días desde diseño hasta producción
- **Tamaño de lote inicial:** **100 unidades por SKU** (vs. 500–1.000 de Zara, 5.000+ de retail tradicional)
- **2.000–10.000 nuevos SKUs por día** lanzados a la web
- **Reorden basado en data:** los SKUs que venden en las primeras 100 unidades se reordenan a lotes grandes en 48 horas
- **Los que no venden se descontinúan** sin generar dead stock significativo
- **Inventory turnover: 35x+** (extremo)

#### Tecnología

Sistema interno (Lurra) que conecta diseño, producción (red de ~3.000 talleres pequeños en Cantón), e-commerce y forecasting en un loop cerrado. Cada SKU es un experimento; el mercado vota; el sistema escala los ganadores.

#### Lecciones para BANVA

1. **"Lote mínimo de prueba" como política:** cualquier SKU nuevo se compra en 30–50 unidades primero. Solo si vende a >X unidades/semana en 4 semanas, se compra cantidad regular.
2. **Velocidad de descontinuación:** SKUs que no validan a 4 semanas se sacan de catálogo y se liquidan. **No esperar 6 meses como hoy.** Esto solo, aplicado disciplinadamente, evita 80% del dead stock futuro.
3. **El loop diseño-data-producción es la ventaja competitiva.** En BANVA: el loop equivalente es Idetex-BANVA Bodega-MELI. Acortar ese loop = más ganancia.

### 7.7 Apple / Tim Cook — la obsesión por DIO bajo

#### Modelo operativo

Cuando Tim Cook llegó a Apple en 1998, Apple tenía DIO de **30+ días** y bodegas llenas. Cook lo describió famosamente: "Inventory is fundamentally evil. You kind of want to manage it like you're in the dairy business: if it gets past its freshness date, you have a problem" [49].

Acciones que tomó:
1. **Cerró 10 de 19 bodegas en su primer año**
2. **Pasó toda la producción a JIT real** con proveedores Asia que producen contra orden
3. **Centralizó forecasting** con un equipo dedicado de 30 personas
4. **Ligó bonos ejecutivos a DIO**, no solo a ventas

Resultados (1998 → 2012):
- DIO: 30 días → **5 días**
- Inventory turnover: 12x → **74x**
- Caja operativa generada por reducción de inventario: **$7B+ (one-time)**
- Posibilitó toda la expansión iOS/iPad sin deuda

#### Lecciones para BANVA

1. **DIO es una métrica ejecutiva, no operativa.** Vicente debe revisar DIO semanal y exigírselo al equipo.
2. **"Inventario es evil" como filosofía.** Cada unidad parada destruye valor. Esto cambia las decisiones diarias.
3. **No vas a llegar a DIO de 5 días** (Apple es un caso extremo y tiene volúmenes que justifican JIT puro). Pero **DIO de 45–60** es totalmente viable para BANVA en 18 meses.
4. **Bonos ligados a DIO**, no solo a ventas. Ya tienes bonos ligados a CVR para Enrique — añade DIO a la fórmula.

### 7.8 Síntesis comparativa

| Empresa | Estrategia central | KPI obsesión | Lección #1 BANVA |
|---|---|---|---|
| Amazon | Inventario adelantado + ML | Fill rate 99% | Forecast probabilístico |
| Walmart | Data sharing + VMI | OTIF proveedor | Compartir data con Idetex |
| Zara | Test and learn + lotes pequeños | Sell-through full price | Comprar nuevos SKUs en 30 unidades |
| MELI | Penaliza stockouts | Stock proyectado | Nunca quebrar SKUs A |
| Costco | Pocos SKUs, alto volumen | GMROI | Reducir long tail |
| Shein | Ultra-velocidad de validación | Velocidad de descontinuación | Matar SKUs en 4 semanas si no validan |
| Apple | DIO bajo extremo | DIO | Bonos ligados a DIO |

---

## PARTE 8 — TECNOLOGÍA Y STACK

### 8.1 ERPs

| ERP | Target | Pros | Contras | ¿BANVA? |
|---|---|---|---|---|
| **SAP S/4HANA** | Enterprise (>$500M) | Estándar mundial, módulos integrados | $$$, complejidad extrema | No |
| **Oracle NetSuite** | Mid-market ($10M–$1B) | Cloud, módulos retail | Caro ($25K+/año) | Tal vez en 3+ años |
| **Microsoft Dynamics 365** | Mid-market | Integración Office | Implementación lenta | No |
| **Odoo** | SMB ($1M–$50M) | Modular, open-source disponible | Implementación requiere expertise | **Sí, candidato** |
| **Defontana / Manager.io / Bsale** | SMB Chile | Adaptado a SII chileno | Limitado en logística | Para contabilidad sí |

**Recomendación BANVA:** mantén la arquitectura actual (Defontana o similar para contabilidad/SII + BANVA Bodega como WMS propio). No migres a un ERP integrado todavía. Cuando crezcas a $3B+ revenue, evalúa Odoo o NetSuite.

### 8.2 WMS

| WMS | Target | Pros | Contras |
|---|---|---|---|
| **Manhattan Active WM** [51] | Enterprise | Líder Gartner MQ, robustez | $$$$ |
| **Blue Yonder Luminate WMS** [52] | Enterprise | IA integrada | $$$$ |
| **Körber K.Motion** | Mid-large | Modular | $$$ |
| **SAP EWM** | Empresas SAP | Integración SAP | Solo SAP |
| **3PL Central / Logiwa** | SMB e-commerce | Cloud, rápido deploy | Funcionalidad limitada |
| **OpenWMS / myWMS** | Open source | Gratis | Requiere desarrollo |
| **BANVA Bodega** | Custom | 100% adaptado, controla data | Mantenimiento propio |

**Recomendación BANVA:** mantén BANVA Bodega como WMS propio. La inversión hecha y la integración con tu operación específica son irreemplazables. Importa **prácticas** de Manhattan/Blue Yonder, no migres.

### 8.3 Planning / Demand Planning Software

| Herramienta | Target | Foco | Costo |
|---|---|---|---|
| **SAP IBP** | Enterprise | Planning integrado | $$$$ |
| **Blue Yonder Luminate Planning** | Enterprise | Demand + supply + S&OP | $$$$ |
| **o9 Solutions** | Enterprise | Knowledge graph + planning | $$$$ |
| **Kinaxis RapidResponse** | Enterprise | Concurrent planning | $$$$ |
| **Anaplan** | Enterprise | Modeling flexible | $$$ |
| **RELEX Solutions** | Mid-large retail | Forecasting + replenishment | $$$ |
| **ToolsGroup SO99+** | Mid-market | Inventory optimization | $$ |
| **Streamline / Slimstock** | SMB-Mid | Forecasting clásico | $ |
| **AWS Forecast (DeepAR)** | Cualquiera con AWS | ML forecasting as-a-service | Pay-per-use |

**Recomendación BANVA fase 1 (0-12m):** Python con `statsforecast`, `mlforecast` y `neuralforecast` (Nixtla, open source). Stack ligero, gratis, integrable a BANVA Bodega.

**Fase 2 (12-24m):** evaluar AWS Forecast para SKUs A+B (DeepAR managed), o quedarse en Nixtla self-hosted si el equipo lo maneja.

### 8.4 Forecasting tools open source — el stack Nixtla

**Nixtla** mantiene 4 librerías Python que cubren todo el espectro:

| Librería | Métodos | Uso BANVA |
|---|---|---|
| **statsforecast** | Holt-Winters, ARIMA, ETS, Croston, TSB, Theta | Baseline obligatorio |
| **mlforecast** | LightGBM, XGBoost con features automáticas | Fase 2 |
| **neuralforecast** | NBEATS, NHITS, TFT, DeepAR | Fase 3 |
| **hierarchicalforecast** | Reconciliación bottom-up/top-down/MinT | Fase 2 |

Estas librerías son **state-of-the-art académico** disponibles gratis. Ganan competencias M periódicamente. **Para BANVA, todo el stack de forecasting puede construirse con Nixtla en Python en 4–6 semanas.**

### 8.5 Integración API con MercadoLibre

**Endpoints críticos para gestión de inventario** [53]:

| Endpoint | Función | Frecuencia recomendada |
|---|---|---|
| `/users/{id}/items/search` | Listado de publicaciones | Diaria |
| `/items/{id}` | Detalle de item (precio, stock, status) | Cada 1 hora para SKUs A |
| `/users/{id}/items/visits` | Visitas por publicación | Diaria |
| `/orders/search` | Órdenes recibidas | Cada 5 min |
| `/items/{id}/full/inventory` | Stock en Full | Cada 30 min |
| `/users/{id}/items_prices` | Price Automation | Cada hora |
| `/advertising/...` | Métricas Product Ads | Diaria |

**Webhooks (notifications):** MELI envía notificaciones push para órdenes nuevas, cambios de stock, etc. **Usar webhooks en lugar de polling cuando sea posible** — más eficiente y en tiempo real.

BANVA Bodega ya tiene la mayor parte de esta infraestructura. La pieza débil suele ser el manejo de rate limits (MELI permite ~1.000 calls/min). Usar caching agresivo y batch endpoints.

### 8.6 Data stack para analytics de inventario

**Stack recomendado para BANVA (alineado con tu infraestructura actual Supabase + Vercel):**

```
[Fuentes]
  ├── BANVA Bodega (Supabase Postgres) ──┐
  ├── MELI API ──────────────────────────┤
  ├── Idetex (Excel/Sheets) ─────────────┤
  ├── ProfitGuard (CSV exports) ─────────┤
  └── Bancos / SII / MP ─────────────────┤
                                          │
[Ingesta]                                  │
  └── Edge Functions Supabase / n8n ─────┘
                                          │
[Storage / Modeling]                       ▼
  └── Postgres + dbt-core ──────────────┐
                                          │
[Analytics]                               │
  ├── Metabase (open source) ────────────┤
  ├── Lightdash (open source) ───────────┤  ← elige uno
  └── Superset (open source) ────────────┘
                                          │
[ML]                                       ▼
  └── Python + Nixtla + Prefect (orquestador)
```

**Por qué dbt:** dbt-core es la capa de transformación SQL versionada en Git. Codifica las definiciones de los KPIs (turnover, GMROI, fill rate) en SQL declarativo, testeable, documentado. **Sin dbt, los KPIs viven en queries dispersos y nadie sabe cuál es la versión correcta.**

**Por qué Metabase/Lightdash:** dashboards self-service con baja curva. Lightdash se conecta directo a dbt y hereda definiciones. Recomendación: **Lightdash** por la integración nativa con dbt.

**Por qué Prefect:** orquesta los jobs de forecasting, KPIs nocturnos, sync con MELI, sin la complejidad de Airflow.

### 8.7 Stack final recomendado para BANVA — versión "12 meses"

| Capa | Herramienta | Costo |
|---|---|---|
| WMS | BANVA Bodega (custom Next.js + Supabase) | Sunk |
| Database | Supabase Postgres | ~$25/mes |
| Transformación | dbt-core | Free |
| BI / Dashboards | Lightdash self-hosted | Free (infra) |
| Forecasting | Python + Nixtla | Free |
| Orquestación | Prefect Cloud free tier | Free |
| AI assist | Claude API (ya usas) | ~$200/mes uso |
| MELI integration | Custom (ya tienes) | Sunk |
| Contabilidad/SII | Defontana o similar | ~$80/mes |
| **Total mensual incremental** | | **~$300/mes** |

**Punto crítico:** clase mundial **no requiere stack caro**. Walmart en 1991 hizo Retail Link con tecnología modesta para la época. La diferencia la hace **disciplina de proceso + datos limpios + decisiones consistentes**, no la marca del software.

### 8.8 Cómo aplicar la Parte 8 a BANVA

1. **Mantén BANVA Bodega como WMS.** No migres.
2. **Implementa dbt sobre Supabase** — primer modelo: `metric_inventory_kpis` que materialice los 25 KPIs de la tabla 6.7 diariamente.
3. **Despliega Lightdash self-hosted** y conéctalo a dbt. Dashboard único de los 25 KPIs.
4. **Adopta Nixtla `statsforecast`** como engine de forecasting fase 1. Implementación 4 semanas.
5. **Migra polling MELI a webhooks** donde sea posible.
6. **Documenta el stack en `.claude/rules/data-stack.md`** para que Raimundo y futuros devs no lo reinventen.
7. **No evalúes ERPs/WMS comerciales hasta superar $3B/año revenue.** Hasta entonces, custom + best-of-breed open source.

---

> **Fin de la Entrega 2 de 3.** Próxima entrega: Partes 9–12 (Errores comunes y anti-patrones, Roadmap de implementación 0–24 meses, Glosario 100+ términos, Bibliografía completa). Confírmame para continuar.
