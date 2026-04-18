

**GESTIÓN DE INVENTARIO**

Guía Completa de Operaciones

*Forecast · ABC · Control de Stock · Compras · Cobertura · Stock de Seguridad*

| *Este documento cubre la teoría y práctica detrás de los pilares fundamentales* *del manejo de inventario en e-commerce y retail moderno.* |
| :---: |

| 01 | FORECAST (Pronóstico de Demanda) Anticipar el futuro para tomar decisiones de stock hoy |
| :---: | :---- |

## **¿Qué es el Forecast?**

El forecast es la estimación cuantificada de la demanda futura de un producto en un período determinado. Es la base sobre la cual se construyen todas las decisiones de inventario: cuánto comprar, cuándo comprar, cuánto stock de seguridad mantener y qué cobertura apuntar.

Sin forecast, las empresas operan en modo reactivo: se quedan sin stock, sobrecompran, o acumulan productos que no rotan. Con un buen forecast, se reduce el capital inmovilizado y se maximiza la disponibilidad.

## **Tipos de Forecast**

### **1\. Promedio Móvil Simple (SMA)**

Promedia los últimos N períodos con igual peso. Simple y fácil de implementar.

| Fórmula: Forecast \= (V₁ \+ V₂ \+ ... \+ Vₙ) / NEjemplo: ventas semanas 1-4 \= \[100, 120, 90, 110\] → Forecast semana 5 \= 105 unidades |
| :---- |

* Ventaja: fácil de calcular y entender

* Desventaja: tarda en reaccionar a cambios de tendencia

### **2\. Promedio Móvil Ponderado (WMA)**

Asigna mayor peso a períodos más recientes, reaccionando más rápido a cambios de demanda.

| Ejemplo con pesos \[0.4, 0.3, 0.2, 0.1\] (más reciente primero):Forecast \= 0.4×110 \+ 0.3×90 \+ 0.2×120 \+ 0.1×100 \= 44+27+24+10 \= 105 unidades |
| :---- |

### **3\. Suavizamiento Exponencial (ETS / Holt-Winters)**

El método más usado en sistemas WMS/ERP modernos. Aplica un factor de suavizamiento α que pondera decrecientemente el pasado.

| Fórmula simple: F(t) \= α × V(t-1) \+ (1-α) × F(t-1)Donde α ∈ (0,1). α alto \= reacciona rápido a cambios. α bajo \= pronóstico más estable.Holt-Winters extiende esto para capturar tendencia \+ estacionalidad. |
| :---- |

### **4\. Forecast por Estacionalidad**

Aplica índices estacionales calculados sobre histórico para ajustar el pronóstico base. Fundamental en e-commerce con eventos como CyberDay, Navidad, Día de la Madre.

| Mes / Evento | Índice Estacional | Ejemplo: base 100 u/sem | Forecast ajustado |
| ----- | ----- | ----- | ----- |
| Semana normal | 1.00 | 100 | 100 |
| Día de la Madre (-1 sem) | 2.30 | 100 | 230 |
| CyberDay | 3.50 | 100 | 350 |
| Navidad | 2.80 | 100 | 280 |
| Enero (post fiestas) | 0.65 | 100 | 65 |

### **5\. Forecast Causal / Regresión**

Modela la demanda en función de variables externas: precio, inversión en ads, temperatura, eventos. Más sofisticado, requiere datos limpios y correlaciones estables.

## **Métricas de Precisión del Forecast**

Medir el error del forecast es tan importante como calcularlo. Las principales métricas son:

| Métrica | Fórmula | Interpretación |
| ----- | ----- | ----- |
| MAE (Error Absoluto Medio) | Σ|Real \- Forecast| / N | Error promedio en unidades. Sin sesgo de signo. |
| MAPE (Error % Medio) | Σ(|Real \- F| / Real) / N × 100 | Error en %. \<10% excelente, \<20% aceptable. |
| RMSE | √(Σ(Real \- F)² / N) | Penaliza errores grandes. Útil para outliers. |
| Sesgo (Bias) | Σ(Forecast \- Real) / N | Positivo \= sobreestimación. Negativo \= subestimación. |
| WAPE | Σ|Real \- F| / ΣReal × 100 | Mejor para SKUs de bajo volumen. |

| Regla práctica BANVA: Para reposición de e-commerce, un MAPE \< 25% por SKU es funcional. Lo crítico es controlar el SESGO — la subestimación sistemática vacía el stock, la sobreestimación inmoviliza capital. |
| :---- |

## **Horizonte de Forecast**

* Corto plazo (1-4 semanas): operativo. Reponer stock, planificar despachos.

* Mediano plazo (1-3 meses): táctico. Órdenes de compra, negociación con proveedores.

* Largo plazo (3-12 meses): estratégico. Presupuesto, capacidad de bodega, lanzamientos.

## **Forecast en E-Commerce: Particularidades**

* Alta variabilidad por eventos de marketing (campañas, descuentos) que distorsionan el histórico

* Long tail de SKUs: muchos productos con pocas ventas → difícil de modelar estadísticamente

* Estacionalidad corta e intensa (2-3 días de CyberDay vs. semanas en retail físico)

* Velocidad cambia con posición en ranking y valoraciones → el forecast debe actualizarse frecuentemente

* Solución práctica: combinar forecast estadístico \+ override manual para eventos \+ alertas de cambio de tendencia

| 02 | CLASIFICACIÓN ABC (y ABC-XYZ) Priorizar donde poner la energía y el capital |
| :---: | :---- |

## **El Principio de Pareto aplicado al Inventario**

La clasificación ABC es la aplicación directa del principio 80/20 de Pareto: el 20% de los SKUs genera el 80% del valor. Clasificar el inventario según su contribución permite tomar decisiones diferenciadas por segmento.

| La trampa más común: tratar todos los SKUs igual. Un SKU A con quiebre de stock puede costar más en ventas perdidas que 50 SKUs C sin stock. La clasificación ABC es la base para asignar prioridad en compras, cobertura objetivo y stock de seguridad. |
| :---- |

## **Clasificación ABC Estándar**

| Clase | % SKUs aprox. | % Ventas/Margen aprox. | Estrategia |
| ----- | ----- | ----- | ----- |
| A ⭐ | 10-20% | 70-80% | Alta cobertura, stock seguridad alto, reposición frecuente, forecast preciso |
| B 🔵 | 20-30% | 15-20% | Cobertura media, stock seguridad moderado, revisión quincenal |
| C 🔶 | 50-70% | 5-10% | Cobertura mínima, stock seguridad bajo, revisión mensual, evaluar discontinuar |

## **Criterios de Clasificación: ¿Por qué clasificar?**

Se puede clasificar por múltiples criterios, y la elección depende del objetivo:

| Criterio | Cuándo usarlo | Ejemplo |
| ----- | ----- | ----- |
| Ventas (unidades) | Planificación logística, picking, espacio bodega | Top SKUs por volumen de pedidos |
| Margen bruto ($) | Priorizar retorno sobre capital invertido | SKUs que más contribuyen al P\&L |
| Ingresos ($) | Gestión de liquidez y facturación | SKUs de mayor valor de venta |
| Frecuencia de rotación | Planificación de reposición | SKUs que más veces se reponen al año |
| Criticidad para el cliente | Satisfacción, reputación | SKUs donde el quiebre deja mala reseña |

## **Clasificación ABC-XYZ: Añadiendo Predictibilidad**

La dimensión XYZ mide la variabilidad de la demanda (qué tan predecible es un SKU), complementando el ABC que mide el valor:

| Clase XYZ | Coeficiente de Variación (CV) | Descripción |
| ----- | ----- | ----- |
| X | CV \< 0.5 | Demanda estable y predecible. Fácil de planificar. |
| Y | 0.5 ≤ CV \< 1.0 | Demanda con cierta variación. Requiere monitoreo. |
| Z | CV ≥ 1.0 | Demanda muy irregular o esporádica. Alta incertidumbre. |

El CV (Coeficiente de Variación) \= Desviación Estándar de ventas / Promedio de ventas del período.

| Combinación | Perfil | Estrategia de inventario |
| ----- | ----- | ----- |
| AX | Alto valor \+ alta predictibilidad | Stock ajustado. Reposición automatizable. Máxima eficiencia. |
| AY | Alto valor \+ variabilidad media | Stock seguridad moderado. Forecast quincenal. |
| AZ | Alto valor \+ impredecible | Stock seguridad alto. Análisis causa de variabilidad. |
| BX | Valor medio \+ predecible | Gestión estándar. Ciclo de revisión fijo. |
| CZ | Bajo valor \+ impredecible | Candidatos a discontinuar o bajo pedido. Mínimo stock. |

## **Clasificación por Cuadrantes (Matriz de Gestión)**

En e-commerce avanzado, se cruza velocidad de ventas con margen para segmentar más estratégicamente:

| Cuadrante | Alta Velocidad | Baja Velocidad |
| ----- | ----- | ----- |
| Alto Margen | ⭐ ESTRELLA: máxima prioridad, nunca sin stock | 💰 CASH COW: proteger margen, controlar stock |
| Bajo Margen | 🚀 VOLUMEN: escalar, optimizar costos logísticos | ❓ REVISAR: discontinuar o mejorar precio/costo |

| Este es exactamente el framework que usa BANVA: Estrellas (21 SKUs, $4M margen), Volumen (17 SKUs, $3.1M), CashCow (94 SKUs, $4.1M) y Revisar (110 SKUs, $2.8M). La diferencia entre un buen operador y uno mediocre es la claridad con que gestiona cada cuadrante de forma diferente. |
| :---- |

| 03 | CONTROL DE STOCK Saber exactamente qué tienes, dónde está y en qué estado |
| :---: | :---- |

## **¿Por qué el Control de Stock es Estratégico?**

El stock es capital inmovilizado. Cada unidad en bodega representa dinero que no está disponible para otras inversiones. El control de stock no es solo 'saber cuánto hay' — es gestionar ese capital con precisión para maximizar su rendimiento.

| Los dos grandes errores: (1) Stockout: quiebre de stock que corta ventas, baja ranking en MercadoLibre y genera mala experiencia. (2) Overstock: exceso de inventario que consume caja, espacio y puede terminar en liquidación con pérdida. |
| :---- |

## **Tipos de Stock**

| Tipo | Descripción | Impacto en gestión |
| ----- | ----- | ----- |
| Stock activo / ciclo | Inventario que se vende y repone regularmente | Base del modelo de reposición |
| Stock de seguridad | Colchón ante variabilidad de demanda y lead time | Protege contra quiebres. Ver sección 5\. |
| Stock en tránsito | Mercadería comprada pero aún no recibida | Debe contarse en disponibilidad proyectada |
| Stock en consignación | Mercadería que pertenece al proveedor hasta venta | No inmoviliza capital propio |
| Stock muerto / inactivo | Sin ventas por tiempo prolongado | Capital perdido. Liquidar o devolver. |
| Stock dañado / cuarentena | Unidades no vendibles sin reparación/descarte | Impacta rentabilidad real del inventario |
| Stock en fulfillment externo | Ej. Full MercadoLibre o 3PL | Menor control, mayor velocidad de entrega |

## **Sistemas de Control: Perpetuo vs. Periódico**

### **Sistema Perpetuo (Continuo)**

Cada movimiento de inventario (venta, recepción, ajuste) actualiza el stock en tiempo real. Ideal para e-commerce y cualquier operación con alto volumen y variedad de SKUs.

* Mayor precisión y visibilidad inmediata

* Permite alertas automáticas de punto de reorden

* Requiere integración entre ventas, bodega y compras

* Ejemplo: BANVA Bodega con WMS sincronizado a MercadoLibre

### **Sistema Periódico**

El stock se cuenta físicamente en intervalos definidos (semanal, mensual). Entre conteos, no hay visibilidad exacta.

* Más simple, requiere menos infraestructura

* Riesgo de quiebres no detectados entre conteos

* Aceptable solo para operaciones pequeñas o SKUs de muy baja rotación

## **Conteo de Inventario: Tipos**

| Método | Descripción | Frecuencia recomendada |
| ----- | ----- | ----- |
| Inventario general | Se cuenta TODO el inventario. Operación se detiene. | Anual (o semestral) |
| Conteo cíclico | Se cuenta un % del inventario rotativamente | Diario/semanal por zonas o categorías |
| Conteo por disparador | Se cuenta cuando hay discrepancia o alerta | On-demand ante anomalías |
| Conteo aleatorio | Muestra aleatoria para detectar desvíos sistémicos | Mensual como auditoría |

| Regla de oro: los SKUs Clase A deben contarse al menos mensualmente. Los SKUs Clase C pueden tolerar conteo trimestral. El conteo cíclico es la práctica estándar en operaciones maduras — nunca para la operación y mantiene alta precisión. |
| :---- |

## **Exactitud de Inventario: IRA y FILL RATE**

| Métrica | Fórmula | Benchmark e-commerce |
| ----- | ----- | ----- |
| IRA (Inventory Record Accuracy) | (SKUs con stock correcto / Total SKUs contados) × 100 | \> 98% operaciones maduras |
| Fill Rate de línea | (Líneas pedido completas / Total líneas pedido) × 100 | \> 95% |
| Fill Rate de unidades | (Unidades enviadas / Unidades pedidas) × 100 | \> 97% |
| Tasa de quiebre (OOS Rate) | (SKUs con stock \= 0 / Total SKUs activos) × 100 | \< 5% SKUs A, \< 15% general |
| Días de inventario (DIO) | (Inventario promedio / COGS diario) | 30-60 días según categoría |

## **Valorización del Inventario**

La forma en que se valorizan los costos del inventario impacta directamente el margen contable y las decisiones de compra:

| Método | Descripción | Impacto |
| ----- | ----- | ----- |
| FIFO (First In, First Out) | Lo primero en entrar es lo primero en salir | Refleja costo actual. Ideal para productos perecibles o con descuento por antigüedad. |
| LIFO (Last In, First Out) | Lo último en entrar es lo primero en salir | No permitido en IFRS/Chile. Solo en GAAP EE.UU. |
| Costo Promedio Ponderado | Precio \= ($ total inventario) / (unidades totales) | Estándar más usado en e-commerce Chile. Simple y estable. |
| Costo Específico | Cada unidad con su costo real de compra | Para artículos de alto valor o únicos (lujo, electrodomésticos). |

| 04 | COBERTURA DE STOCK Cuántos días de ventas puede cubrir el inventario actual |
| :---: | :---- |

## **¿Qué es la Cobertura?**

La cobertura (Days of Cover, DOC) responde a una pregunta simple: con el stock actual y la velocidad de ventas proyectada, ¿cuántos días puedo vender antes de quedarme sin stock?

| Fórmula base:Cobertura (días) \= Stock disponible / Velocidad de ventas diariaEjemplo: 300 unidades en bodega / 15 unidades/día \= 20 días de cobertura |
| :---- |

## **¿Cuánta Cobertura Objetivo Tener?**

La cobertura objetivo depende de tres variables: el lead time del proveedor, el stock de seguridad deseado, y el ciclo de revisión de compras. La fórmula estructural es:

| Cobertura objetivo \= Lead Time \+ Stock Seguridad (en días) \+ Ciclo de RevisiónEjemplo BANVA:- Lead time Idetex: 10 días- Stock seguridad: 7 días (para SKU Clase A con CV alto)- Ciclo revisión: 14 días→ Cobertura objetivo \= 10 \+ 7 \+ 14 \= 31 días |
| :---- |

## **Tabla de Cobertura por Segmento**

| Segmento SKU | Lead Time típico | Cobertura mínima | Cobertura objetivo | Acción si cae bajo mínimo |
| ----- | ----- | ----- | ----- | ----- |
| A \+ Alta velocidad | 7-15 días | 10 días | 30-45 días | Orden urgente inmediata |
| A \+ Estacional | 15-30 días (import.) | 20 días | 60-90 días pre-evento | Anticipar compra 2 meses antes |
| B | 7-15 días | 7 días | 20-30 días | Incluir en próxima orden |
| C | Variable | 5 días | 15-20 días | Evaluar si vale la pena reponer |
| Muerto (0 vel.) | N/A | 0 | 0 — liquidar | Liquidar o devolver proveedor |

## **Cobertura Diferenciada por Canal: Full vs. Flex**

En MercadoLibre Chile, el mismo SKU puede estar en dos canales con costos, velocidades y reglas distintas:

| Variable | Full (Fulfillment ML) | Flex (Bodega Propia) |
| ----- | ----- | ----- |
| Costo de envío | Directo por tarifa ML | 3,320 CLP – bono envío (neto) |
| Velocidad de venta | Mayor (badge FULL boost ranking) | Menor en promedio |
| Control de stock | ML gestiona, riesgo de error | Control total propio |
| Cobertura recomendada | 30 días (tiempo de reposición \+ buffer) | 45 días (mayor flexibilidad) |
| Quiebre de stock | ML pausa publicación automáticamente | Requiere gestión manual o alerta |
| Costo capital inmovilizado | Inventario en centro ML (costo oportunidad) | En bodega propia |

| Estrategia mixta óptima: mantener 20-30 días en Full para velocidad de entrega, y 15-20 días adicionales en Flex como respaldo. Cuando Flex margin \> Full margin, reducir objetivo de Full a 20 días para liberar capital. |
| :---- |

## **Visualizando la Cobertura: El Gráfico de Inventario**

Una herramienta clave para operar con claridad es el gráfico de 'dientes de sierra' (sawtooth chart), que muestra:

* Nivel de stock cayendo con ventas diarias

* Punto de reorden (ROP): nivel al que se dispara la orden de compra

* Lead time: período entre orden y recepción (durante el cual el stock sigue cayendo)

* Stock de seguridad: colchón que protege el quiebre durante el lead time

* Recepción: salto vertical al recibir la orden

| El punto de reorden (ROP) se calcula como:ROP \= (Demanda diaria promedio × Lead Time) \+ Stock de SeguridadEjemplo: 15 u/día × 10 días \+ 50 u \= 200 unidades → Cuando el stock llega a 200, se dispara la orden. |
| :---- |

| 05 | STOCK DE SEGURIDAD El colchón que te protege cuando el mundo no coopera |
| :---: | :---- |

## **¿Por qué existe el Stock de Seguridad?**

En un mundo perfecto, la demanda sería exactamente igual al forecast y los proveedores siempre entregarían exactamente en el plazo acordado. En la realidad, ambas variables tienen incertidumbre. El stock de seguridad (SS) existe para absorber esa incertidumbre sin perder ventas.

| Fuente de incertidumbre | Ejemplo real | Impacto sin SS |
| ----- | ----- | ----- |
| Variabilidad de demanda | Una campaña de ads inesperada triplica ventas en 48hs | Quiebre antes de recibir reposición |
| Variabilidad de lead time | Idetex retrasa entrega 5 días por feriado | Stock a 0 durante el retraso |
| Errores de forecast | Navidad resultó \+40% vs forecast | Ventas perdidas en peak |
| Daños / mermas en tránsito | 10% de la entrega llegó dañada | Stock efectivo menor al esperado |
| Error de conteo en bodega | Discrepancia de 30 unidades en IRA | Quiebre silencioso no detectado |

## **Fórmulas de Stock de Seguridad**

### **Método Simple (por días)**

| SS \= Demanda diaria promedio × Días de cobertura de seguridadEjemplo: 15 u/día × 7 días \= 105 unidades de SS→ Práctico, fácil de gestionar, menos preciso estadísticamente. |
| :---- |

### **Método Estadístico (basado en variabilidad)**

| SS \= Z × √(LT × σ\_d² \+ d² × σ\_LT²)Donde:• Z \= factor de nivel de servicio (ver tabla abajo)• LT \= lead time promedio (días)• σ\_d \= desviación estándar de demanda diaria• d \= demanda diaria promedio• σ\_LT \= desviación estándar del lead timeSi el lead time es constante: SS \= Z × σ\_d × √LT |
| :---- |

| Nivel de Servicio objetivo | Factor Z | Interpretación |
| ----- | ----- | ----- |
| 84% | 1.00 | Acepto quiebre en 1 de cada 6 ciclos de reposición |
| 90% | 1.28 | Quiebre en 1 de cada 10 ciclos |
| 95% | 1.65 | Estándar recomendado para SKUs Clase A |
| 97.5% | 1.96 | Alto servicio para SKUs críticos o alto margen |
| 99% | 2.33 | Muy alto. Solo para SKUs donde el quiebre es catastrófico |
| 99.9% | 3.09 | Casi nunca justificado. Costo de inventario muy alto |

### **Ejemplo Completo**

| SKU: Cubrecolchón Impermeable 2P (SKU A, alta velocidad)• Demanda diaria promedio (d): 11 unidades/día• σ\_d (desviación estándar demanda diaria): 4.5 unidades• Lead time promedio (LT): 10 días (constante desde Idetex)• Nivel de servicio objetivo: 95% → Z \= 1.65SS \= 1.65 × 4.5 × √10 \= 1.65 × 4.5 × 3.16 \= 23.5 ≈ 24 unidadesInterpretación: necesito 24 unidades extra de colchón para tener 95% de probabilidad de no quedar sin stock durante el lead time. |
| :---- |

## **Ajuste de SS por Segmento**

No todos los SKUs merecen el mismo nivel de servicio. Asignarlo por segmento optimiza el capital:

| Segmento | Nivel servicio | Z | Lógica |
| ----- | ----- | ----- | ----- |
| A Estrella / alta rotación | 97-99% | 2.05-2.33 | El costo de quiebre supera el costo de inventario extra |
| A Estacional (pre-evento) | 99% | 2.33 | Imposible reponer durante el evento. Solo hay una oportunidad. |
| B | 90-95% | 1.28-1.65 | Equilibrio entre servicio y capital inmovilizado |
| C alta rotación | 90% | 1.28 | Bajo margen no justifica SS alto |
| C baja rotación | 84% | 1.00 | Evaluar si vale tener SS o trabajar bajo pedido |

| 06 | COMPRA DE STOCK (Gestión de Compras) El arte de comprar bien: qué, cuánto y cuándo |
| :---: | :---- |

## **Los Modelos de Reposición**

Existen dos grandes filosofías para decidir cuándo y cuánto comprar, y en la práctica los operadores las combinan:

### **Modelo de Punto de Reorden (Q, ROP)**

Se fija una cantidad fija de compra (Q) y un nivel de stock disparador (ROP). Cuando el stock cae a ROP, se emite automáticamente una orden de Q unidades.

* Ventaja: simple, automatizable, compras de tamaño óptimo

* Desventaja: si la demanda varía mucho, Q puede quedar desactualizado

| ROP \= d × LT \+ SSQ óptimo (EOQ) \= √(2DS/H)Donde D \= demanda anual, S \= costo de emitir una orden, H \= costo de mantener una unidad por año |
| :---- |

### **Modelo de Revisión Periódica (P, S)**

Se revisa el inventario cada P días y se hace un pedido que lleva el stock hasta el nivel objetivo S (posición máxima).

* Ventaja: simplifica la logística de compras (todos los proveedores en un día fijo)

* Desventaja: requiere más SS porque hay incertidumbre en el período de revisión

| Nivel objetivo S \= d × (P \+ LT) \+ SSCantidad a pedir \= S \- Stock actual \- Pedidos en tránsito |
| :---- |

## **EOQ: La Cantidad Económica de Pedido**

El EOQ (Economic Order Quantity) balancea dos costos opuestos: el costo de ordenar (cae al pedir más veces, pero con pedidos más grandes) y el costo de mantener inventario (sube al tener más stock):

| EOQ \= √(2 × D × S / H)Ejemplo:• D (demanda anual) \= 3,600 unidades/año (300/mes)• S (costo emitir 1 orden) \= 15,000 CLP (tiempo staff \+ admin)• H (costo anual de mantener 1 unidad) \= 2,000 CLP (bodega \+ capital inmovilizado \~20% valor)EOQ \= √(2 × 3600 × 15000 / 2000\) \= √54,000 \= 232 unidades por pedidoFrecuencia: 3,600 / 232 ≈ 15.5 órdenes al año ≈ 1 orden cada 23 días |
| :---- |

| Advertencia práctica: el EOQ asume demanda constante y costos fijos. En e-commerce real, lo más importante es que la cantidad cumpla con:1. Cobertura objetivo alcanzada después de recibir2. Mínimos del proveedor (inner pack, caja completa, pallet)3. Restricción de caja disponible4. Restricción de espacio en bodega |
| :---- |

## **Cálculo de la Orden de Compra**

En la práctica operativa, la cantidad a pedir se calcula así:

| Cantidad a pedir \= (Cobertura objetivo en días × Velocidad diaria) \+ SS \- Stock actual \- En tránsitoEjemplo completo:• Velocidad: 11 u/día• Cobertura objetivo: 45 días• SS: 24 unidades• Stock actual: 85 unidades• En tránsito: 50 unidadesCantidad \= (45 × 11\) \+ 24 \- 85 \- 50 \= 495 \+ 24 \- 85 \- 50 \= 384 unidades→ Redondear al inner pack más cercano del proveedor (ej. múltiplo de 12 → 384 unidades exactas) |
| :---- |

## **Gestión de Proveedores**

| Variable | Descripción | Impacto en compras |
| ----- | ----- | ----- |
| Lead Time | Días desde orden hasta recepción confirmada | Determina cuánto antes hay que pedir |
| Lead Time variability | Desviación estándar del lead time real | Aumenta SS necesario |
| Mínimo de compra (MOQ) | Cantidad mínima por pedido o SKU | Puede obligar a sobre-comprar en SKUs lentos |
| Inner pack / unidad de venta | Multiplo mínimo de compra (ej. caja de 12\) | Redondeo hacia arriba en todos los cálculos |
| Condiciones de pago | Contado, 30/60/90 días | Impacta cash flow. Idetex: 60 días \= ventaja de capital. |
| Descuentos por volumen | Precio baja con mayor cantidad | Trade-off entre ahorro y capital inmovilizado |
| Confiabilidad de entrega | % de órdenes entregadas en fecha acordada | Baja confiabilidad → más SS |
| Política de devolución | ¿Acepta devoluciones o cambios? | Reduce riesgo de overstock |

## **Negociación con Proveedores: Palancas Clave**

1. Volumen comprometido: 'Si garantizo X unidades al año, ¿qué precio y plazo me das?'

2. Exclusividad o primacía: ventaja si eres el mayor comprador de un proveedor

3. Pronto pago: descuento por pagar antes del plazo standard

4. Flexibilidad de entregas: pedir pedidos más frecuentes con menor MOQ

5. Consignación: pagar solo lo vendido — ideal para SKUs nuevos o de alto riesgo

6. Co-inversión en desarrollo de producto: para productos exclusivos (ej. almohadas visco BANVA)

| 07 | MÉTRICAS CLAVE DE INVENTARIO Los números que guían cada decisión |
| :---: | :---- |

## **Dashboard Operativo de Inventario**

| KPI | Fórmula | Frecuencia | Benchmark |
| ----- | ----- | ----- | ----- |
| Rotación de inventario | COGS / Inventario promedio | Mensual | 6-12x/año en textiles hogar |
| Days Inventory Outstanding (DIO) | 365 / Rotación | Mensual | 30-60 días según categoría |
| GMROI | Margen bruto $ / Inventario promedio $ | Mensual | \> 2.0x (cada $ en inv. genera \>$2 margen) |
| Fill Rate | Pedidos completos / Total pedidos × 100 | Semanal | \> 95% |
| OOS Rate (Quiebre) | SKUs en 0 / Total activos × 100 | Diario | \< 5% SKUs A |
| Exceso de stock (DOH \> 90\) | Valor stock con \>90 días cobertura | Mensual | \< 5% del inventario total |
| Dead Stock % | Valor sin venta 90d / Inventario total × 100 | Mensual | \< 2% |
| IRA (Exactitud registro) | SKUs correctos / SKUs contados × 100 | Semanal | \> 98% |
| Capital inmovilizado muerto | Valor stock muerto \+ exceso × costo capital | Mensual | Minimizar; meta \<1% de ventas |

## **GMROI: El Indicador de Rentabilidad del Inventario**

El GMROI (Gross Margin Return On Inventory) es probablemente el indicador más importante para evaluar la salud del inventario en e-commerce. Responde: ¿cuántos pesos de margen bruto genera cada peso invertido en inventario?

| GMROI \= Margen Bruto ($) / Costo promedio del inventario ($)Ejemplo BANVA:• Margen bruto febrero 2026: $14,000,000• Inventario promedio en costo: \~$35,000,000 (estimado)→ GMROI \= 14M / 35M \= 0.4x mensual \= 4.8x anualizadoUn GMROI \> 3.0x anual es sólido en textiles hogar. |
| :---- |

## **Costo Total del Inventario**

Muchos operadores solo ven el costo de compra. El costo real del inventario incluye múltiples componentes:

| Componente | % típico del valor del inventario/año | Comentario |
| ----- | ----- | ----- |
| Costo de capital (oportunidad) | 10-20% | El dinero inmovilizado podría estar en otra inversión |
| Almacenamiento / bodega | 2-5% | Arriendo, servicios, equipos, staff de bodega |
| Manejo y manipulación | 1-3% | Recepción, picking, packing, conteo |
| Merma y obsolescencia | 1-4% | Productos dañados, vencidos, descontinuados |
| Seguro del inventario | 0.5-1% | Cobertura contra robo, siniestro |
| Costo total de inventario | 15-30% del valor | Por eso reducir DIO de 60 a 45 días ahorra real |

| Impacto práctico: si tienes $50M en inventario a costo y el costo de mantenerlo es 20% anual, estás 'pagando' $10M al año por tener ese inventario. Reducir el DIO en 15 días puede liberar \~$8M en caja — dinero que puede usarse para nuevos productos, marketing o simplemente reducir la deuda con el proveedor. |
| :---- |

| 08 | PATOLOGÍAS COMUNES Y SOLUCIONES Los problemas que destruyen rentabilidad y cómo resolverlos |
| :---: | :---- |

## **Las 8 Patologías Más Costosas del Inventario**

| Patología | Síntoma | Causa raíz | Solución |
| ----- | ----- | ----- | ----- |
| Bullwhip Effect | Variaciones de demanda pequeñas generan oscilaciones enormes en órdenes de compra | Cada eslabón de la cadena amplifica la señal de demanda al añadir su propio SS y buffer | Compartir datos de ventas en tiempo real con proveedor. Reducir lotes. Reposición pull. |
| Dead Stock | SKUs con 0 ventas por 90+ días acumulando polvo | Sobre-compra, producto sin demanda, cambio de mercado, quiebre de precio | Política de liquidación a 60-90 días. MOQ menor en nuevos SKUs. Retorno a proveedor si hay acuerdo. |
| Overstock selectivo | Stock alto en SKUs incorrectos, bajo en los correctos | Forecast equivocado, compra emocional, descuento por volumen mal evaluado | Clasificación ABC estricta. Cobertura diferenciada. Revisión mensual de outliers. |
| Quiebre crónico de A's | Los mejores SKUs siempre en 0 | Lead time subestimado, SS insuficiente, falta de alerta temprana | ROP automático. SS estadístico. Alerta a 1.5× ROP para anticipar. |
| Inventario fantasma | Sistema dice hay stock, físico dice 0 | Error en recepción, robo, merma no registrada, error de picking | Conteo cíclico frecuente. Auditorías sorpresa. IRA \> 98% como KPI. |
| Advertising de stock vacío | Gasto publicitario en SKUs sin stock | Falta de integración entre ads y WMS | Pausar campañas automáticamente cuando stock \< SS. API de stock en motor de ads. |
| Sobre-diversificación | Demasiadas variantes (tallas, colores) con stock en todas | Miedo a perder ventas por falta de variante. Presión del proveedor. | Análisis de conversión por variante. Dropship o bajo pedido para variantes C. Longlist vs shortlist. |
| Capital inmovilizado en proveedor erróneo | Stock financiado con proveedor caro cuando hay alternativa | Inercia operativa, relación personal, sin análisis de costo total | Benchmarking semestral de proveedores. Calcular GMROI por proveedor. |

## **Liquidación de Stock: El Protocolo**

El overstock que no se liquida a tiempo se convierte en pérdida total. Un protocolo claro previene la inercia:

7. Identificar: stocks con DIO \> 90 días en SKUs C o D sin forecast de mejora

8. Evaluar recuperabilidad: ¿hay temporada próxima? ¿hay evento que lo reactive?

9. Estrategia por nivel de urgencia:

   * 30-60 DIO extra: descuento progresivo en publicación (5-15%)

   * 60-90 DIO extra: campaña de liquidación activa, bundle con A's

   * \>90 DIO sin movimiento: precio de costo o bajo costo, oferta flash

   * Sin solución: devolver proveedor (si aplica) o destrucción/donación con baja contable

10. Documentar lección: ¿por qué se generó? ¿qué cambia en el proceso de compra?

| 09 | MODELO INTEGRADO DE GESTIÓN Cómo todo se conecta en un sistema operativo |
| :---: | :---- |

## **El Ciclo Virtuoso del Inventario**

Los conceptos anteriores no operan en silos — se alimentan mutuamente en un ciclo continuo:

| Paso | Actividad | Input | Output |
| ----- | ----- | ----- | ----- |
| 1 | Clasificar SKUs (ABC-XYZ) | Historial de ventas, margen, variabilidad | Segmentación priorizada del catálogo |
| 2 | Calcular Forecast | Historial \+ estacionalidad \+ eventos \+ tendencia | Demanda esperada por SKU por período |
| 3 | Calcular SS | Forecast, variabilidad, lead time, nivel servicio | Stock de seguridad por SKU |
| 4 | Definir Cobertura Objetivo | SS, lead time, ciclo revisión, clase ABC | Nivel máximo de stock a mantener |
| 5 | Calcular Punto de Reorden | Demanda diaria, lead time, SS | Trigger de compra automático |
| 6 | Generar Orden de Compra | ROP alcanzado, EOQ, restricciones proveedor | Orden enviada y confirmada |
| 7 | Recepción y Control | Orden vs. recibido, IRA, calidad | Stock actualizado, discrepancias documentadas |
| 8 | Venta y Monitoreo | Ventas reales vs. forecast, OOS, excesos | Feedback para ajustar forecast y SS |
| 9 | Revisión y Ajuste | KPIs: GMROI, Fill Rate, DIO, IRA | Mejoras al modelo → volver al paso 1 |

## **Tecnología: El Stack Mínimo Viable**

| Capacidad | Herramienta mínima | Herramienta avanzada |
| ----- | ----- | ----- |
| Control de stock en tiempo real | Google Sheets con API de ventas | WMS (Warehouse Management System) |
| Forecast automático | Promedio móvil en Excel | Motor de ML con ETS/Prophet |
| Alertas de reposición | Fórmulas condicionales \+ email | Agente IA con push notifications |
| Clasificación ABC | Tabla dinámica mensual | Clasificación dinámica en tiempo real |
| Integración con marketplace | Webhook básico | API bidireccional con sync de stock |
| Análisis de rentabilidad | P\&L manual en spreadsheet | Dashboard con GMROI por SKU en tiempo real |
| Gestión de compras | Email \+ planilla de seguimiento | Módulo de reposición con PO automático |

| El WMS (Warehouse Management System) maduro integra todos estos flujos: recepciones, pickings, ajustes, forecasts, compras y reportería en un solo sistema. BANVA Bodega está construyendo exactamente esta capacidad con Next.js \+ Supabase, incluyendo los 6 agentes especializados de IA. |
| :---- |

## **Resumen Ejecutivo: Los 10 Principios**

11. El forecast es la base de todo. Sin pronóstico, solo hay reacción.

12. No todos los SKUs son iguales. La clasificación ABC diferencia estrategias.

13. El costo real del inventario incluye capital inmovilizado, no solo costo de compra.

14. El stock de seguridad se calibra estadísticamente, no por intuición.

15. La cobertura objetivo se determina por: lead time \+ SS \+ ciclo de revisión.

16. El punto de reorden es la palanca operativa más importante para evitar quiebres.

17. El GMROI mide si el inventario está trabajando para ti o contra ti.

18. El dead stock destruye rentabilidad silenciosamente. Liquidar es siempre mejor que esperar.

19. La integración de datos (ventas → WMS → compras) es el diferenciador operativo.

20. El sistema solo funciona si se mide, se ajusta y se itera continuamente.

*© BANVA SPA — Documento interno de gestión operacional*