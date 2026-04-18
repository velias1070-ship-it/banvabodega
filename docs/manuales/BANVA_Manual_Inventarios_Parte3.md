# Manual de Gestión de Inventarios de Clase Mundial — BANVA SPA
## Entrega 3 de 3: Partes 9–12

> Cierre del manual. Referencias [n] definidas en Entregas 1 y 2 más fuentes adicionales aquí.
>
> **Fuentes adicionales Entrega 3:**
> [54] Goldratt, E. — *The Goal*, 3ª ed., North River Press, 2014.
> [55] Sheffi, Y. — *The Power of Resilience*, MIT Press, 2015.
> [56] Simchi-Levi, D. — *Operations Rules*, MIT Press, 2010.
> [57] Christopher, M. — *Logistics & Supply Chain Management*, 5ª ed., Pearson, 2016.
> [58] Harvard Business Review — "The Bullwhip Effect in Supply Chains" (Lee, Padmanabhan, Whang), *Sloan Management Review*, 1997.
> [59] Fisher & Raman — *The New Science of Retailing*, HBS Press, 2010.
> [60] Forrester, J. — *Industrial Dynamics*, MIT Press, 1961.

---

## PARTE 9 — ERRORES COMUNES Y ANTI-PATRONES

Los 20 errores más caros de la gestión de inventario, con caso real, costo estimado y cómo evitarlos. Cada error está calibrado a la realidad de un e-commerce textil en MELI.

### Error #1 — Tratar todos los SKUs igual

**Síntoma:** misma frecuencia de revisión, mismo método de forecast, mismo service level para los 345 SKUs.

**Caso:** retailer textil chileno (no BANVA) que aplicaba EOQ uniforme; resultado: stockout en sus top 10 SKUs y $80M de exceso en cola larga simultáneamente.

**Costo BANVA estimado:** $10–20M/año en holding + lost sales no segmentado.

**Solución:** matriz ABC-XYZ obligatoria (Parte 2). Política diferenciada por cuadrante.

### Error #2 — Confundir forecast con planning

**Síntoma:** "el forecast dijo 100, compramos 100" sin considerar lead time, safety stock, ni capacidad de bodega.

**Caso:** Forecast es el insumo, planning es la decisión. Hyndman [8] enfatiza que el forecast debe ser **insesgado**, mientras que el planning de inventario **deliberadamente sesga al alza** vía safety stock para alcanzar el service level objetivo.

**Costo:** stockouts crónicos en SKUs A.

**Solución:** separar el rol de forecaster (predice la demanda) del rol de planner (decide cuánto comprar). Aún si es la misma persona, son procesos distintos.

### Error #3 — Ignorar el lead time variability

**Síntoma:** calcular safety stock con $\sqrt{LT} \cdot z \cdot \sigma_D$ ignorando $\sigma_{LT}$.

**Caso:** Si Idetex tiene lead time promedio 35 días con desviación 10 días, ignorar σ_LT puede subestimar el safety stock en 40%.

**Costo:** stockouts inexplicables en SKUs aparentemente bien gestionados.

**Solución:** fórmula completa $SS = z \sqrt{LT \sigma_D^2 + \bar{D}^2 \sigma_{LT}^2}$ (Parte 4.4.1). Medir $\sigma_{LT}$ con OCs históricas.

### Error #4 — Advertising en SKUs sin stock

**Síntoma:** Product Ads activos en publicaciones con stock = 0 o stock proyectado bajo.

**Caso BANVA real:** $350K/mes identificados de ad spend en SKUs sin stock confirmado.

**Costo:** $4–5M/año de presupuesto quemado sin retorno + daño al ranking del SKU + frustración del cliente.

**Solución:** automatización en BANVA Bodega: cuando stock proyectado de un SKU < 10 días, pausar campañas asociadas. Reactivar al reponer.

### Error #5 — Stockout sin replanning

**Síntoma:** un SKU se queda sin stock, vuelve a stock, y el sistema sigue calculando con la velocidad histórica como si nada hubiera pasado.

**Problema:** durante el stockout, el ranking cae. Al volver, la velocidad inicial es menor que la histórica. Si compras al mismo nivel previo, generarás exceso temporal.

**Solución:** período de "ramp-up" post-stockout (4–6 semanas) donde el forecast usa una fracción de la velocidad histórica que crece linealmente.

### Error #6 — Dead stock perpetuo (no descontinuar)

**Síntoma:** SKUs con 0 ventas en 6+ meses siguen en catálogo "por si acaso" o "para no dañar el assortment".

**Caso BANVA:** 91 SKUs con 523 unidades, 173 SKUs zero-velocity con 2.522 unidades.

**Costo:** holding cost ~30% anual sobre el valor inmovilizado + ocupación de espacio en bodega + atención mental dispersa.

**Solución:** **regla de los 90 días**. Si un SKU no vende en 90 días, entra automáticamente a markdown -20%. A los 120 días, -40%. A los 180 días, liquidación o donación. Ningún SKU se queda parado más de 180 días.

### Error #7 — El "bullwhip effect" amplificado

**Síntoma:** una pequeña variación en la demanda final del cliente se amplifica corriente arriba: 10% más venta → 30% más OC al proveedor → 80% más producción del proveedor.

**Origen** [58, 60]: lotes grandes, lead times largos, falta de información compartida, reacciones emocionales a picos.

**Caso:** cuando un SKU explota en CyberDay, el operador entra en pánico y pide 5x lo necesario al proveedor. Cuando llega, la demanda ya volvió a normal y queda exceso.

**Solución:**
1. Reposición frecuente en lotes pequeños (lección Zara)
2. Compartir data con Idetex (lección Walmart)
3. Forecasting riguroso, no reactivo
4. Política escrita: nunca duplicar una OC sin esperar 2 ciclos de venta normalizada

### Error #8 — Confiar en el inventario del sistema sin cycle count

**Síntoma:** "el sistema dice que tengo 50, voy a vender 50". Realidad: hay 35.

**Caso:** sin cycle counting, IRA de bodegas inmaduras es 70–85%. Eso significa que **15–30% de tus decisiones de venta están basadas en data falsa**.

**Costo:** stockouts sorpresa, clientes furiosos, cancelaciones MELI, ranking penalizado.

**Solución:** cycle counting diario (Parte 5.6). Sin IRA > 95%, todos los modelos sofisticados son irrelevantes.

### Error #9 — Lotes mínimos no cuestionados

**Síntoma:** "Idetex me pide MOQ de 200 unidades, así que compro 200". Realidad: a veces solo necesitas 80 y la diferencia se vuelve dead stock.

**Solución:** negociar MOQs explícitamente. La tasa de descuento por volumen rara vez compensa el holding cost de exceso. Calcula el TCO real considerando holding y obsolescencia, no solo el precio unitario.

### Error #10 — Comprar más para "ahorrar en envío"

**Síntoma:** "ya que viene el camión, aprovechemos y pidamos más". Esta lógica es común y desastrosa.

**Análisis numérico:** ahorrar $200K en envío trayendo 100 unidades extra a $10K cada una → $1M de inventario adicional → $300K/año de holding cost. **Pierdes $100K/año por ahorrar $200K una vez.**

**Solución:** EOQ con costo de envío explícito como parte de S. Si el EOQ dice 132 unidades, no compres 200 "porque es lo mismo el envío".

### Error #11 — Forecasting basado solo en historia

**Síntoma:** modelos que solo miran ventas pasadas, ignorando factores conocidos del futuro: planeación de promo, ad spend, cambios de precio, lanzamientos del competidor.

**Solución:** features exógenos en el modelo (precio relativo, ad spend planeado, dummies de eventos). LightGBM o TFT manejan esto naturalmente.

### Error #12 — Promociones sin pre-build de stock

**Síntoma:** anunciar oferta CyberDay sin haber escalado el stock 4–6 semanas antes.

**Caso:** la oferta vende 5x lo normal el primer día, queda en stockout día 2, los 28 días restantes de promo el SKU está sin stock con ranking destruido.

**Solución:** calendario de promos integrado con planning de inventario. Lock de pre-build 6 semanas antes de cada evento (CyberDay mayo y noviembre, Hot Sale, Día de la Madre).

### Error #13 — No medir el costo real de stockout

**Síntoma:** "no se vendió, pero tampoco gastamos en inventario". Falso. Hay margen perdido + ranking dañado + ad spend sin retorno + LTV perdido.

**Solución:** estimar lost sales mensual (Parte 6.3.4) y reportarlo como KPI. Hace visible el costo del under-investment.

### Error #14 — Confundir demand planning con S&OP

**Síntoma:** el demand planner trabaja aislado del comercial, finanzas y operaciones.

**Solución:** reuniones mensuales **S&OP (Sales & Operations Planning)** [14]. Para BANVA: 1 hora al mes con Vicente, Enrique y Joaquín revisando forecast, plan de compras, capacidad de bodega y cash flow proyectado conjuntamente.

### Error #15 — Promociones que destruyen margen sin necesidad

**Síntoma:** descontar SKUs que ya vendían bien "para celebrar el CyberDay". El cliente que iba a comprar a precio completo compra con descuento; el cliente nuevo no compra más.

**Solución:** promocionar selectivamente. KVI a precio competitivo siempre. Long tail sin descuento. Solo descontar SKUs en transición (declive tardío) o para validar nuevos.

### Error #16 — Atribuir ventas al canal equivocado

**Síntoma:** todo se atribuye a Product Ads. Realidad: parte de esas ventas habrían ocurrido orgánicamente.

**Caso BANVA real:** ya identificaste $4M de margen orgánico de "Estrellas". Sin segmentar orgánico vs. ads, sobre-inviertes en publicidad de SKUs que no la necesitan.

**Solución:** medir CVR orgánico vs. ads por SKU. Reducir bid en SKUs donde el orgánico es fuerte.

### Error #17 — Inventario en Full sin disciplina de retiro

**Síntoma:** SKUs C/Z mandados a Full hace 6+ meses, generando storage fees crecientes.

**Solución:** auditoría mensual de Full. Cualquier SKU con < 0,5 unidades/semana de venta en Full debe retirarse. Política escrita.

### Error #18 — No tener un single source of truth

**Síntoma:** stock en Excel, en BANVA Bodega, en MELI seller central, todos diferentes. Cada decisión se basa en una versión distinta de la verdad.

**Solución:** BANVA Bodega es el single source of truth. Cualquier discrepancia se concilia hacia BANVA Bodega. Excel queda prohibido para inventario.

### Error #19 — Confiar en heurísticas humanas para 345 SKUs

**Síntoma:** "yo conozco mis productos, sé cuándo reponer". Realidad: ningún humano puede mantener calibración en 345 SKUs simultáneos.

**Caso:** estudios académicos [25] muestran que la performance del juicio humano se degrada exponencialmente después de ~50 ítems en gestión activa.

**Solución:** automatizar con sistema; reservar el juicio humano para los 20 SKUs más críticos y los casos de excepción.

### Error #20 — No tener contingencia para disrupciones del proveedor

**Síntoma:** un solo proveedor (Idetex) para >80% del catálogo. Si Idetex tiene un problema (huelga, incendio, atraso de importación), BANVA se cae.

**Caso histórico:** Toyota perdió $1.5B en 1997 cuando un incendio en su único proveedor de válvulas P-valve detuvo la producción 5 días [55].

**Solución:** identificar 2–3 proveedores alternativos para los top 30 SKUs. No usarlos rutinariamente, pero mantener relación activa con OCs ocasionales para que el "switch" sea posible si necesitas. Tu relación con tu tío Idetex es una fortaleza pero también una vulnerabilidad — diversifica al menos en SKUs A.

### Síntesis: los 20 errores agrupados

| Categoría | Errores |
|---|---|
| **Segmentación** | #1, #6, #19 |
| **Forecasting** | #2, #11, #12, #14 |
| **Replenishment** | #3, #9, #10, #20 |
| **Operaciones** | #8, #17, #18 |
| **Comercial** | #4, #5, #15, #16 |
| **Estratégicos** | #7, #13 |

**De los 20, los 5 con mayor impacto inmediato para BANVA son:** #4 (ads sin stock), #6 (dead stock perpetuo), #1 (no segmentar), #8 (sin cycle count), #19 (heurísticas humanas en 345 SKUs).

---

## PARTE 10 — ROADMAP DE IMPLEMENTACIÓN 0–24 MESES

Plan por fases para llevar a BANVA desde gestión intuitiva (estado actual) hasta gestión de clase mundial (estado objetivo). Cada fase con objetivos concretos, entregables, métricas de éxito, inversión estimada y riesgos.

### FASE 0 (Mes 0) — Diagnóstico y baseline

**Objetivos:**
- Establecer el punto de partida medible
- Crear consenso sobre el estado actual

**Entregables:**
1. Cálculo de los 25 KPIs de la tabla 6.7 con datos del último mes
2. Matriz ABC-XYZ inicial de los 345 SKUs
3. Cuantificación del dead stock total ($CLP)
4. Cuantificación de lost sales del último mes ($CLP)
5. Cálculo del CCC actual
6. Documento de baseline firmado

**Métricas de éxito:**
- 100% de KPIs medidos (no estimados)
- Equipo (Vicente, Enrique, Joaquín, Raimundo) alineado en los números

**Inversión:** ~40 horas tuyas + 20 horas Raimundo. **$0 en software.**

**Riesgos:** descubrir que la data en BANVA Bodega no es suficientemente limpia. Mitigación: dedicar tiempo a cycle counting acelerado para validar antes de medir.

---

### FASE 1 (Meses 1–3) — Cimientos y "quick wins"

**Objetivos:**
- Frenar la sangre: detener pérdidas evitables inmediatas
- Establecer disciplinas operativas básicas

**Entregables:**
1. **Pausa automática de Product Ads en SKUs con stock proyectado < 10 días.** (Resuelve Error #4. Ahorro estimado: $200K–$400K/mes en ad spend)
2. **Política de markdown automático:** SKU sin venta 90 días → -20%, 120 días → -40%, 180 días → liquidación. Implementar como flujo en BANVA Bodega.
3. **Liquidación inicial de los 91 dead stock SKUs** vía oferta agresiva, bundling o donación. (Libera ~$15–25M de caja una sola vez)
4. **Cycle counting diario implementado** con generación automática de lista (4 SKUs/día). Joaquín entrenado.
5. **Matriz ABC-XYZ activa en BANVA Bodega**, actualizada cada lunes automáticamente.
6. **Política diferenciada por cuadrante** documentada en `.claude/rules/inventory-policy.md`.
7. **Fórmula completa de safety stock** (con $\sigma_D$ y $\sigma_{LT}$) implementada como función SQL.
8. **Reorder Point automático** para los top 30 SKUs A.
9. **Dashboard único en Lightdash o equivalente** con los 25 KPIs.
10. **Reunión semanal de inventario de 30 min** instaurada (Vicente + Enrique + Joaquín). Agenda fija: 12 KPIs semanales.

**Métricas de éxito a fin del mes 3:**
- IRA > 95%
- Dead stock SKUs: de 91 a < 30
- Stock proyectado < 10d en SKUs con ads: 0
- DIO: 81 → 70
- Stockout rate: -30%
- $5–10M de caja liberada

**Inversión:** ~120 h Vicente + 80 h Raimundo + 40 h Enrique + 60 h Joaquín. Software incremental: ~$100/mes (Lightdash hosting).

**Riesgos:**
- Resistencia a los cycle counts diarios. Mitigación: incorporar a bono de Joaquín.
- Liquidación agresiva de dead stock daña percepción de marca. Mitigación: liquidar en Outlet/Marketplace separado o vender a mayorista regional.

---

### FASE 2 (Meses 4–6) — Forecasting y reposición automatizada

**Objetivos:**
- Reemplazar la intuición por modelos en SKUs A y B
- Estandarizar el proceso de compras a Idetex

**Entregables:**
1. **Stack de forecasting Python + Nixtla** desplegado. Holt-Winters multiplicativo para X/Y, TSB para Z. Horizonte 12 semanas, granularidad semanal.
2. **WMAPE medido por cuadrante** en dashboard. Línea base establecida.
3. **Bias y tracking signal por SKU** monitoreados. Alerta automática cuando |TS| > 4.
4. **Calendario de eventos discretos** (CyberDay, Hot Sale, Black Friday, Día de la Madre/Padre, Navidad) integrado al modelo como regresor externo.
5. **Política (s, Q) automatizada** para SKUs A. Generación de OC sugerida lista para 1-click approval.
6. **Política (R, S) semanal** para SKUs B y C.
7. **Medición de OTIF y σ_LT de Idetex** con OCs históricas. Documento compartido con Idetex.
8. **S&OP mensual** de 90 min instaurado (Vicente + Enrique + Joaquín + invitado finanzas si aplica).
9. **Replenishment automatizado a Full** basado en velocidad observada (2x por semana).
10. **Pre-build automático** para CyberDay/Hot Sale (lock 6 semanas antes).

**Métricas de éxito a fin del mes 6:**
- WMAPE SKUs A: < 30%
- Bias: ±5%
- DIO: 70 → 60
- GMROI: $1,4 → $1,8
- Fill rate: 92% → 96%
- Forecast accuracy reportado semanalmente sin excepción

**Inversión:** ~80 h Vicente + 120 h Raimundo (forecasting + integraciones) + 40 h Enrique. Software: $100–200/mes (compute para Nixtla, mantener Lightdash).

**Riesgos:**
- El forecasting estadístico inicialmente tiene WMAPE alto y genera desconfianza. Mitigación: medir FVA contra naive baseline; mostrar que aún imperfecto es mejor que el juicio humano agregado.
- Idetex no acepta compartir OTIF/lead time. Mitigación: medirlo internamente con tus propias OCs.

---

### FASE 3 (Meses 7–12) — Optimización avanzada y MEIO

**Objetivos:**
- Llevar las métricas a nivel "muy bueno" del benchmark
- Implementar prácticas de retailers líderes

**Entregables:**
1. **Migración a LightGBM global model** para forecasting (mlforecast de Nixtla). Features: lags, calendar, precio relativo, ad spend, stock, eventos.
2. **Hierarchical reconciliation** SKU → categoría → total con MinT.
3. **MEIO simple** entre bodega central y Full: safety stock consolidado en central, replenishment 2x/semana basado en venta.
4. **Re-slotting físico** de los top 30 SKUs a golden zone. Migración a batch picking con cluster (carrito 6–10 totes).
5. **Optimización de rutas de pick** TSP (nearest neighbor) en lugar de serpentina.
6. **VMI piloto con Idetex** para los top 10 SKUs (lección Walmart). Idetex mantiene safety stock en su bodega; despacha 1x por semana a demanda.
7. **Policy "test and learn" para SKUs nuevos** (lección Zara/Shein): compra inicial 30–50 unidades, validar 4 semanas, escalar o descontinuar.
8. **Price Automation API de MELI** activada para top 30 SKUs con reglas claras.
9. **Audit mensual de Full** con retiro automático de SKUs C/Z.
10. **Bonos de Vicente/equipo ligados a DIO y GMROI**, no solo a ventas (lección Apple/Tim Cook).

**Métricas de éxito a fin del mes 12:**
- DIO: 60 → 50
- Inventory turnover: 4,5 → 7
- GMROI: $1,8 → $2,5
- Fill rate: 96% → 97%
- IRA: 98%+
- WMAPE A: < 25%
- Dead stock %: < 8%
- CCC: 35 → 25 días
- **Caja liberada acumulada: $40–60M**

**Inversión:** ~100 h Vicente + 150 h Raimundo + 60 h Enrique + 40 h Joaquín. Software: ~$300/mes (mantención stack).

**Riesgos:**
- LightGBM requiere features engineering disciplinado. Mitigación: usar `mlforecast` que automatiza buena parte.
- VMI con Idetex requiere relación contractual. Mitigación: empezar con acuerdo informal sobre 5 SKUs.

---

### FASE 4 (Meses 13–24) — Clase mundial

**Objetivos:**
- Operación que se compara con benchmarks internacionales
- Sistema autosuficiente con intervención humana mínima

**Entregables:**
1. **Evaluación e implementación de DeepAR** (vía AWS Forecast o GluonTS self-hosted) para SKUs A+B con horizonte hasta 60 días.
2. **Forecasts probabilísticos** (no puntuales) usados directamente en cálculo de safety stock. Quantiles p10/p50/p90.
3. **Anticipatory shipping a Full** basado en predicción agregada (versión BANVA del concepto Amazon).
4. **Diversificación de proveedores** para top 30 SKUs: identificar 2–3 alternativos a Idetex con OCs ocasionales que mantengan la relación viva.
5. **Reducción de catálogo** de 345 → 250 SKUs aprox (lección Costco). Eliminar long tail no rentable.
6. **Concentración de poder de compra** en menos SKUs → mejor precio Idetex → mejor margen.
7. **Demand sensing diario** con señales en tiempo real (visitas, agregados al carrito, ad spend) para ajustar campañas y precios intradía.
8. **Treasure hunt textile:** 5–10 SKUs en rotación constante de "edición limitada" (lección Costco).
9. **Bodega 100% trazada por evento**: cada movimiento físico genera un evento timestamp en BANVA Bodega.
10. **Reportería automatizada para Idetex** con velocidad, proyecciones y plan de compras 3 meses adelante (lección Walmart Retail Link).

**Métricas de éxito a fin del mes 24:**
- DIO: 50 → 45
- Inventory turnover: 7 → 8
- GMROI: $2,5 → $3,0
- Fill rate: 97 → 98%
- IRA: 99%
- WMAPE A: < 22%
- Dead stock %: < 6%
- CCC: 25 → 20 días
- Perfect order rate: 92%
- Catálogo: 250 SKUs (de 345)
- **Caja liberada acumulada: $70–100M**
- **Margen %: de 23% a 28%+**

**Inversión:** ~120 h Vicente + 180 h Raimundo + 80 h Enrique. Software: ~$500/mes (incluye AWS Forecast pay-per-use si se adopta).

**Riesgos:**
- Reducción de catálogo enfrenta resistencia interna ("ese SKU lo tenemos por X razón"). Mitigación: política firmada por Vicente, decisión data-driven sin excepciones.
- DeepAR es complejo de operar. Mitigación: si el equipo no lo maneja, mantener LightGBM, que está a ~5% de DeepAR en accuracy y es 10x más simple.

### Resumen del roadmap

| Fase | Meses | DIO target | GMROI target | Caja liberada acumulada | Inversión software incremental |
|---|---|---|---|---|---|
| 0 | 0 | 81 (baseline) | $1,4 | $0 | $0 |
| 1 | 1–3 | 70 | $1,5 | $5–10M | $100/mes |
| 2 | 4–6 | 60 | $1,8 | $15–25M | $200/mes |
| 3 | 7–12 | 50 | $2,5 | $40–60M | $300/mes |
| 4 | 13–24 | 45 | $3,0 | $70–100M | $500/mes |

**ROI total estimado:** ~$80M de mejora estructural en working capital + ~$30M/año de margen recurrente adicional, contra una inversión de software acumulada < $10M en 24 meses (más tiempo del equipo, que es el costo principal).

---

## PARTE 11 — GLOSARIO

**100+ términos técnicos en orden alfabético.**

**ABC analysis** — Clasificación de SKUs por contribución a una métrica (ingresos/margen/unidades). Regla 80/20.

**ACOS (Advertising Cost of Sale)** — Gasto en ads / ventas atribuidas. KPI estándar de retail media.

**Anticipation stock** — Inventario acumulado deliberadamente para un evento futuro conocido.

**Anticipatory shipping** — Práctica de Amazon de pre-posicionar inventario antes de tener pedidos.

**ARIMA** — AutoRegressive Integrated Moving Average. Familia de modelos de forecasting estadístico clásico.

**ASN (Advance Shipment Notice)** — Notificación pre-envío del proveedor con detalle de lo que viene.

**Backorder** — Pedido aceptado pero no servido por falta de stock; se entrega cuando llega.

**Bass diffusion model** — Modelo de adopción para forecast de productos nuevos.

**Batch picking** — Recoger múltiples órdenes simultáneamente en un solo recorrido.

**Bias (forecast)** — Error sistemático del forecast en una dirección.

**Bullwhip effect** — Amplificación de variabilidad en la cadena de suministro aguas arriba.

**Carrying cost** — Costo total de mantener inventario, expresado típicamente como % del valor anual.

**Cash Conversion Cycle (CCC)** — DIO + DSO − DPO. Mide cuántos días financias con tu propia caja.

**Cluster picking** — Variante de batch picking con carro multi-tote.

**COGS (Cost of Goods Sold)** — Costo de los productos vendidos.

**Coefficient of Variation (CV)** — σ/μ. Medida de variabilidad relativa.

**Cold start** — Problema de pronosticar productos sin historia.

**COI (Cube-per-Order Index)** — Métrica de slotting que combina volumen y frecuencia de picks.

**Croston** — Método de forecasting para demanda intermitente.

**Cross-docking** — Recibir mercancía y reembarcarla sin almacenarla.

**CSL (Cycle Service Level)** — Probabilidad de no tener stockout en un ciclo de reposición.

**Cycle counting** — Conteo continuo de subconjuntos del inventario en lugar de uno anual.

**Cycle stock** — Stock que rota normalmente entre reposiciones.

**Days Inventory Outstanding (DIO)** — Días promedio que el inventario permanece antes de venderse.

**Dead stock** — SKUs sin movimiento en >180 días.

**Decoupling stock** — Inventario que independiza dos eslabones de la cadena.

**DeepAR** — Modelo probabilístico de forecasting basado en LSTM, desarrollado por Amazon.

**Demand planning** — Proceso de pronosticar y planificar la demanda en horizontes semana–mes.

**Demand sensing** — Variante de corto plazo (día/intradía) usada para ajustes operativos.

**DIO** — Ver Days Inventory Outstanding.

**dbt (data build tool)** — Capa de transformación SQL versionada, estándar de modern data stack.

**Discrete picking** — Picking de una orden a la vez por picker.

**Dock-to-stock time** — Tiempo desde recepción hasta SKU disponible para venta.

**EDI (Electronic Data Interchange)** — Estándar antiguo de intercambio de docs B2B.

**EOQ (Economic Order Quantity)** — Cantidad óptima de orden que minimiza costo total de inventario.

**EPQ (Economic Production Quantity)** — Variante de EOQ para producción no instantánea.

**ETS** — Error/Trend/Seasonality. Familia de modelos de suavizamiento exponencial.

**FBA (Fulfillment by Amazon)** — Equivalente de Mercado Envíos Full en Amazon.

**FEFO (First Expired, First Out)** — Política de rotación por fecha de expiración.

**FIFO (First In, First Out)** — Política de rotación por orden de recepción.

**Fill rate** — Fracción de la demanda servida directo del stock.

**Forecast accuracy** — Medida de qué tan acertado fue un forecast vs la realidad.

**FSN** — Fast/Slow/Non-moving. Clasificación de SKUs por velocidad.

**FVA (Forecast Value Added)** — Métrica que mide si un paso del proceso de forecasting agrega valor.

**Full (Mercado Envíos Full)** — Servicio de fulfillment de MELI.

**Golden zone** — Zona ergonómica (60–150 cm) donde se ubican los SKUs más pickeados.

**GMROI (Gross Margin Return on Investment)** — Margen bruto / inventario promedio. KPI rey del retail.

**Hedge stock** — Inventario para cubrir riesgo de precio o divisa.

**Hierarchical forecasting** — Forecasting que reconcilia múltiples niveles de agregación.

**HML** — High/Medium/Low cost. Clasificación de SKUs por costo unitario.

**Holding cost** — Costo de mantener inventario.

**Holt** — Método de suavizamiento exponencial doble (nivel + tendencia).

**Holt-Winters** — Suavizamiento triple (nivel + tendencia + estacionalidad).

**Inventory paradox** — Tener mucho y tener poco son ambos caros.

**Inventory turnover** — COGS / inventario promedio. Veces que rota el inventario por año.

**IRA (Inventory Record Accuracy)** — % de ubicaciones donde sistema = físico. Target >99%.

**JIT (Just-in-Time)** — Filosofía de minimizar inventario sincronizando llegada con consumo.

**Kanban** — Sistema visual de pull replenishment originado en Toyota.

**Kiva** — Sistema de robots de Amazon (adquirido 2012, hoy Amazon Robotics).

**KVI (Key Value Item)** — SKUs cuyo precio el cliente conoce y usa para juzgar si la tienda es cara.

**Lead time** — Tiempo entre orden colocada y orden recibida.

**Lead time demand** — Demanda esperada durante el lead time.

**Lean** — Filosofía de minimizar desperdicio, originada en Toyota Production System.

**LightGBM** — Algoritmo de gradient boosting, muy usado para forecasting moderno.

**Lines per hour** — KPI de productividad de picking.

**Lost sales** — Ventas perdidas por falta de stock.

**MAE (Mean Absolute Error)** — Métrica de error de forecast en unidades absolutas.

**MAPE (Mean Absolute Percentage Error)** — Métrica de error porcentual.

**Markdown** — Reducción de precio para liquidar inventario.

**MASE (Mean Absolute Scaled Error)** — Métrica de error normalizada por naive baseline.

**MEIO (Multi-Echelon Inventory Optimization)** — Optimización de inventario en múltiples nodos simultáneamente.

**Min/max** — Política simple: cuando stock baja a min, ordenar hasta max.

**MOQ (Minimum Order Quantity)** — Cantidad mínima por orden exigida por el proveedor.

**MQ-CNN/MQ-RNN** — Multi-Horizon Quantile forecaster de Amazon.

**N-BEATS** — Modelo neuronal de forecasting basado en bloques residuales.

**Naive forecast** — Forecast = última observación. Baseline para evaluar otros métodos.

**Nixtla** — Suite de librerías open-source de forecasting en Python.

**OEE (Overall Equipment Effectiveness)** — KPI de eficiencia, más usado en manufactura.

**OTIF (On-Time In-Full)** — Pedidos entregados a tiempo Y completos.

**Order cycle time** — Tiempo desde orden recibida hasta despacho.

**Pareto principle** — 80/20: el 20% de las causas explica el 80% de los efectos.

**Perfect order rate** — Orden a tiempo + completa + sin daño + correcta. Multiplicativo.

**Pick accuracy** — % de picks correctos.

**Pick face** — Frente de picking, donde el picker accede al SKU.

**Pick path** — Ruta que recorre el picker.

**Pick-to-light** — Sistema con luces que indican qué picker.

**Picks per hour** — KPI de productividad de picking en unidades.

**Postponement** — Estrategia de retrasar la diferenciación final del producto.

**Prophet** — Librería de forecasting de Meta, usa modelo aditivo.

**Pull system** — Reposición disparada por la demanda real (vs push).

**Push system** — Reposición disparada por forecast/plan (vs pull).

**Random stow** — Almacenamiento sin lógica de categoría, asignación a cualquier hueco libre.

**Receiving** — Proceso de recepción de mercancía.

**Reorder point (ROP)** — Nivel de stock que dispara una nueva orden.

**Replenishment** — Proceso de reposición.

**RMSE (Root Mean Squared Error)** — Métrica de error que penaliza más errores grandes.

**RFID** — Identificación por radiofrecuencia. Alternativa a códigos de barra.

**Risk pooling** — Reducción de variabilidad al consolidar demanda.

**S&OP (Sales & Operations Planning)** — Proceso mensual que alinea demanda, oferta y finanzas.

**Safety stock** — Reserva para absorber variabilidad de demanda y/o lead time.

**SARIMA** — ARIMA con componente estacional.

**SCOR model** — Supply Chain Operations Reference. Marco estándar de la ASCM.

**Sell-through rate** — % de unidades vendidas vs unidades disponibles en un período.

**Service level** — Probabilidad de no tener stockout (CSL) o fracción servida (fill rate).

**SES (Simple Exponential Smoothing)** — Suavizamiento exponencial simple.

**Shrinkage** — Pérdidas físicas de inventario por robo, daño, error.

**Single source of truth** — Sistema único que es la verdad oficial.

**SKU (Stock Keeping Unit)** — Unidad mínima de inventario con identificador único.

**Slotting** — Asignación de SKUs a ubicaciones físicas en bodega.

**SOH (Stock on Hand)** — Stock físicamente disponible.

**Stock-to-sales ratio** — Inventario al inicio del mes / ventas del mes.

**Stockout** — Quedarse sin stock disponible.

**Tracking signal** — Bias acumulado / MAD. Detecta forecasts descalibrados.

**TFT (Temporal Fusion Transformer)** — Modelo neuronal SOTA para forecasting con variables exógenas.

**TSB** — Teunter-Syntetos-Babai. Mejora de Croston con corrección de obsolescencia.

**TSP (Travelling Salesman Problem)** — Problema de optimización de rutas, aplicado a picking.

**Turnover** — Ver inventory turnover.

**VED** — Vital/Essential/Desirable. Clasificación por criticidad operacional.

**VMI (Vendor-Managed Inventory)** — El proveedor gestiona el inventario del cliente.

**Voice picking** — Picking guiado por audio.

**Wagner-Whitin** — Algoritmo de lot sizing dinámico.

**Wave picking** — Picking en olas sincronizadas con cut-off de courier.

**WIP (Work-in-Process)** — Inventario en proceso de transformación.

**WMAPE (Weighted MAPE)** — MAPE ponderado por volumen. Métrica estándar retail.

**WMS (Warehouse Management System)** — Software de gestión de bodega.

**XYZ analysis** — Clasificación por variabilidad de demanda (CV).

**Zone picking** — Picking dividido por zonas de bodega.

---

## PARTE 12 — BIBLIOGRAFÍA COMPLETA

Las referencias [1]–[60] usadas a lo largo del manual, con autor, año, link cuando aplica, y una línea de relevancia.

**[1] Silver, E.A., Pyke, D.F. & Thomas, D.J.** (2017). *Inventory and Production Management in Supply Chains*, 4ª ed., CRC Press. — Tratado canónico del inventory control. Indispensable. https://www.routledge.com/9781466558618

**[2] Nahmias, S. & Olsen, T.L.** (2015). *Production and Operations Analysis*, 7ª ed., Waveland Press. — Texto académico estándar de operaciones, claro en fundamentos matemáticos.

**[3] Chopra, S. & Meindl, P.** (2019). *Supply Chain Management: Strategy, Planning and Operation*, 7ª ed., Pearson. — Texto MBA de referencia. Capítulos 11–14 son inventario.

**[4] Axsäter, S.** (2015). *Inventory Control*, 3ª ed., Springer. — Texto avanzado, especialmente fuerte en multi-echelon.

**[5] APICS / ASCM** (2023). *CPIM Body of Knowledge* y *CSCP Learning System*. https://www.ascm.org — Estándar profesional global.

**[6] CSCMP** (2014). *Supply Chain Management Process Standards*. https://cscmp.org — Estándares de procesos del Council of Supply Chain Management Professionals.

**[7] ASCM** (2022). *SCOR Digital Standard v12*. https://scor.ascm.org — Modelo de referencia para procesos de SC.

**[8] Hyndman, R.J. & Athanasopoulos, G.** (2021). *Forecasting: Principles and Practice*, 3ª ed., OTexts. — Manual gratuito y autoritativo de forecasting. https://otexts.com/fpp3/

**[9] Salinas, D., Flunkert, V., Gasthaus, J. & Januschowski, T.** (2020). "DeepAR: Probabilistic forecasting with autoregressive recurrent networks", *International Journal of Forecasting*, 36(3). — Paper fundacional del modelo de Amazon. https://arxiv.org/abs/1704.04110

**[10] Wen, R., Torkkola, K., Narayanaswamy, B. & Madeka, D.** (2017). "A Multi-Horizon Quantile Recurrent Forecaster", NeurIPS Workshop. — MQ-CNN/MQ-RNN de Amazon. https://arxiv.org/abs/1711.11053

**[11] Ferdows, K., Lewis, M.A. & Machuca, J.A.D.** (2004). "Rapid-Fire Fulfillment", *Harvard Business Review*, Nov. — El paper canónico de Zara. https://hbr.org/2004/11/rapid-fire-fulfillment

**[12] Ghemawat, P. & Nueno, J.L.** (2006). "ZARA: Fast Fashion", HBS Case 9-703-497. — Caso HBS detallado.

**[13] Bezos, J.** (1997–2020). *Amazon Shareholder Letters*. https://www.aboutamazon.com/news/company-news/2020-letter-to-shareholders — Filosofía operativa de Amazon directamente del fundador.

**[14] Lapide, L.** (2011). "Sales and Operations Planning", MIT Center for Transportation & Logistics. — Marco S&OP de referencia.

**[15] Gartner** (2023). *Magic Quadrant for Supply Chain Planning Solutions*. https://www.gartner.com — Evaluación anual de vendors de planning.

**[16] McKinsey & Company** (2021). "Succeeding in the AI supply-chain revolution". https://www.mckinsey.com/industries/metals-and-mining/our-insights/succeeding-in-the-ai-supply-chain-revolution

**[17] BCG** (2022). "The Inventory Optimization Imperative". https://www.bcg.com/publications/

**[18] Fisher, M.L.** (1997). "What Is the Right Supply Chain for Your Product?", *HBR*, Mar–Apr. — Clasificación funcional vs innovativa. https://hbr.org/1997/03/what-is-the-right-supply-chain-for-your-product

**[19] Cachon, G. & Terwiesch, C.** (2019). *Matching Supply with Demand*, 4ª ed., McGraw-Hill. — Texto Wharton práctico.

**[20] Wagner, H.M. & Whitin, T.M.** (1958). "Dynamic Version of the Economic Lot Size Model", *Management Science*, 5(1). — Algoritmo clásico de lot sizing dinámico.

**[21] Croston, J.D.** (1972). "Forecasting and stock control for intermittent demands", *Operational Research Quarterly*, 23(3). — Método fundacional para demanda intermitente.

**[22] Syntetos, A.A. & Boylan, J.E.** (2005). "The accuracy of intermittent demand estimates", *International Journal of Forecasting*, 21(2). — Mejora del Croston (TSB).

**[23] Graves, S.C. & Willems, S.P.** (2000). "Optimizing Strategic Safety Stock Placement in Supply Chains", *Manufacturing & Service Operations Management*, 2(1). — Paper fundacional MEIO.

**[24] Snyder, L.V. & Shen, Z-J.M.** (2019). *Fundamentals of Supply Chain Theory*, 2ª ed., Wiley. — Texto académico fuerte en modelos.

**[25] Mentzer, J.T. & Moon, M.A.** (2005). *Sales Forecasting Management*, 2ª ed., Sage. — Estándar académico de demand planning.

**[26] Gilliland, M.** (2010). *The Business Forecasting Deal*, Wiley/SAS. — Origen del concepto FVA.

**[27] MercadoLibre Developers** (2024). *Documentación oficial Mercado Envíos Full y Price Automation*. https://developers.mercadolibre.com.ar — Fuente primaria para integración MELI.

**[28] Amazon Science** (varios). *Publications on forecasting, anticipatory shipping, random stow*. https://www.amazon.science/publications

**[29] Stanford GSB** (2003). *Wal-Mart Stores Inc.*, Case GS-25. — Caso académico clásico de Walmart SC.

**[30] Holt, C.C.** (1957/2004). "Forecasting seasonals and trends by exponentially weighted moving averages", republicado en *International Journal of Forecasting*, 20(1).

**[31] Winters, P.R.** (1960). "Forecasting sales by exponentially weighted moving averages", *Management Science*, 6(3).

**[32] Box, G.E.P., Jenkins, G.M., Reinsel, G.C. & Ljung, G.M.** (2015). *Time Series Analysis: Forecasting and Control*, 5ª ed., Wiley. — Texto fundacional ARIMA.

**[33] Taylor, S.J. & Letham, B.** (2018). "Forecasting at Scale", *The American Statistician*, 72(1). — Paper de Prophet (Meta). https://peerj.com/preprints/3190/

**[34] Oreshkin, B.N., Carpov, D., Chapados, N. & Bengio, Y.** (2020). "N-BEATS: Neural basis expansion analysis for interpretable time series forecasting", ICLR. https://arxiv.org/abs/1905.10437

**[35] Lim, B., Arık, S.Ö., Loeff, N. & Pfister, T.** (2021). "Temporal Fusion Transformers for interpretable multi-horizon time series forecasting", *International Journal of Forecasting*, 37(4). https://arxiv.org/abs/1912.09363

**[36] Frazelle, E.** (2016). *World-Class Warehousing and Material Handling*, 2ª ed., McGraw-Hill. — Manual operativo de bodega.

**[37] Bartholdi, J.J. & Hackman, S.T.** (2019). *Warehouse & Distribution Science*, v0.98, Georgia Tech. — Texto académico open access. https://www.warehouse-science.com/

**[38] Tompkins, J.A. et al.** (2010). *Facilities Planning*, 4ª ed., Wiley. — Diseño de bodegas.

**[39] De Koster, R., Le-Duc, T. & Roodbergen, K.J.** (2007). "Design and control of warehouse order picking: A literature review", *European Journal of Operational Research*, 182(2). — Review autoritativa de picking.

**[40] Petersen, C.G. & Aase, G.** (2004). "A comparison of picking, storage, and routing policies in manual order picking", *International Journal of Production Economics*, 92(1).

**[41] Wulfraat, M.** (2014–2023). *MWPVL International Reports on Amazon FC operations*. https://mwpvl.com/html/amazon_com.html — Análisis detallado de la red Amazon.

**[42] Amazon** (2013). US Patent 8,615,473, "Method and system for anticipatory package shipping".

**[43] Onal, S., Zhang, J. & Das, S.** (2017). "Modeling Random Storage in Amazon Fulfillment Centers", *Production and Operations Management*. — Estudio académico de random stow.

**[44] Fishman, C.** (2006). *The Wal-Mart Effect*, Penguin. — Análisis del impacto Walmart.

**[45] Stanford GSB** (2003). *Wal-Mart Stores Inc.*, Case GS-25. — Ya citado en [29].

**[46] Berman, B.** (2011). "Flatter and faster: Strategies for managing the supply chain at Zara", *Business Horizons*, 54(4).

**[47] Caro, F. & Gallien, J.** (2010). "Inventory management of a fast-fashion retail network", *Operations Research*, 58(2). — Modelo de assortment optimization de Zara.

**[48] McAfee, A.** (2023). "Shein: The Tiktok of E-commerce", MIT Sloan Management Review.

**[49] Lashinsky, A.** (2012). *Inside Apple*, Business Plus. — Tim Cook y su filosofía de inventario.

**[50] Gartner Supply Chain Top 25** (2018–2024). https://www.gartner.com/en/supply-chain/insights/top-25-supply-chains — Ranking anual de SCs líderes.

**[51] Manhattan Associates** (2023). *Active Warehouse Management Documentation*. https://www.manh.com

**[52] Blue Yonder** (2023). *Luminate Platform Whitepapers*. https://blueyonder.com

**[53] MercadoLibre** (2024). *Mercado Envíos Full: Manual del Vendedor*. https://www.mercadolibre.cl/ayuda

**[54] Goldratt, E.** (2014). *The Goal*, 3ª ed., North River Press. — Novela de management que enseña Theory of Constraints. Lectura obligada.

**[55] Sheffi, Y.** (2015). *The Power of Resilience*, MIT Press. — Disrupciones y resiliencia de SC.

**[56] Simchi-Levi, D.** (2010). *Operations Rules*, MIT Press.

**[57] Christopher, M.** (2016). *Logistics & Supply Chain Management*, 5ª ed., Pearson. — Texto europeo estándar.

**[58] Lee, H.L., Padmanabhan, V. & Whang, S.** (1997). "The Bullwhip Effect in Supply Chains", *Sloan Management Review*, 38(3). https://sloanreview.mit.edu/article/the-bullwhip-effect-in-supply-chains/

**[59] Fisher, M. & Raman, A.** (2010). *The New Science of Retailing*, HBS Press. — Aplicación de analytics a retail, especialmente moda.

**[60] Forrester, J.W.** (1961). *Industrial Dynamics*, MIT Press. — Origen intelectual del bullwhip effect.

---

## Cierre del manual

Este documento es un mapa, no el territorio. La diferencia entre BANVA hoy y BANVA clase mundial no la hace leer este manual; la hace **ejecutar consistentemente, semana tras semana, las disciplinas descritas en la Parte 10**. Las empresas que mencionamos (Amazon, Walmart, Zara, Apple) no llegaron a su nivel en 24 meses — Tim Cook tardó 14 años en llevar el DIO de Apple de 30 a 5 días. Pero todas comenzaron donde tú estás hoy: con datos sucios, decisiones intuitivas, y la intuición correcta de que **había que medir, segmentar y optimizar**.

Tres recordatorios finales:

1. **GMROI es la métrica única.** Si tuvieras que mirar un solo número cada semana, mira GMROI. Resume rotación + margen + capital invertido en una sola cifra. Tu meta: $1,4 → $3,0 en 24 meses.

2. **El stockout en MELI es el peor pecado.** Más caro que el dead stock, más caro que el ad spend desperdiciado, porque rompe el ciclo virtuoso de ranking → CTR → CVR → ranking. Un fill rate del 97% en SKUs A no es perfeccionismo, es supervivencia.

3. **El forecasting nunca será perfecto y no necesita serlo.** Necesita ser **consistentemente mejor que la intuición humana** y **insesgado**. WMAPE de 25% en SKUs A es excelente. Lo que mata no es el error promedio sino el sesgo y los outliers no detectados.

Cuando tengas dudas operativas, vuelve a la tabla maestra de KPIs (6.7) y al roadmap (Parte 10). Todo lo demás es contexto.

> **Fin del manual completo. 3 entregas, 12 partes.** Próximos pasos sugeridos: (1) ejecutar la Fase 0 (diagnóstico/baseline) en las próximas 2 semanas, (2) llevar este manual a Notion como página viva con checkboxes por cada entregable de las Fases 1-4, (3) bloquear la reunión semanal de inventario de 30 min en tu calendario empezando el próximo lunes.
