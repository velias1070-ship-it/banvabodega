# Auditoría: WMS BANVA vs. Manuales de Gestión de Inventarios

**Fecha:** 2026-04-25
**Alcance:** mapeo del código actual contra las recomendaciones de los 6 manuales en `docs/manuales/inventarios/`
**Cruce con:** `auditorias/banva-bodega-auditoria-2026-04-18.md` (auditoría forense previa, 33% cumplimiento sobre 63 requisitos amplios)

---

## Resumen ejecutivo

El WMS implementa la mayoría de las prácticas modernas de gestión de inventarios para e-commerce textil multicanal: ledger append-only de movimientos, segmentación ABC-XYZ por 3 ejes, reposición con safety stock dinámico, TSB para demanda intermitente, y reconciliación de stock ML cada hora. Cumplimiento estimado **~67%** contra los 6 manuales.

**5 gaps con mayor impacto operativo**:

1. Reservaciones explícitas con `expires_at` (race condition latente entre webhooks ML)
2. Lotes/series y trazabilidad por batch (no se puede aislar defectuosos por lote)
3. Holt-Winters para SKUs estacionales (quilts/sábanas térmicas con pico invernal 4×)
4. Política automática de cycle counting ABC-driven
5. EOQ como complemento al cálculo cobertura-driven

**Decisiones deliberadas justificadas** (no son gaps reales): sin ubicaciones virtuales supplier/customer (escala 1-2 bodegas), WAC en vez de FIFO (Idetex como proveedor único), sin soft-reservations (B2C puro).

---

## Tabla de prácticas

| # | Práctica | Manual fuente | Estado | Evidencia / Gap |
|---|----------|---------------|--------|-----------------|
| 1 | Ledger append-only de movimientos | ERP Patrones | ✓ CUMPLE | Tabla `movimientos` + RPC `registrar_movimiento_stock` (v27) |
| 2 | Partida doble origen/destino | ERP Patrones | ⚠ PARCIAL | `movimientos.razon` registra tipo de operación, sin árbol de ubicaciones virtuales (supplier/customer/inventory) |
| 3 | Tabla de saldos cacheada | ERP Patrones | ✓ CUMPLE | `stock(sku, posicion_id)` actualizado vía RPC atómica |
| 4 | Reservaciones soft con expiración | ERP Patrones | ✗ GAP | No hay tabla `reservations`. `composicion_venta` es catálogo estático, no reserva por orden |
| 5 | Reservaciones hard | ERP Patrones | ⚠ PARCIAL | `bloquear_linea` con SELECT FOR UPDATE existe para picking de recepciones, NO para órdenes ML |
| 6 | Stock proyectado (`on_hand + en_tránsito − reservado`) | ERP Patrones | ✓ CUMPLE | `intelligence.ts` calcula `stockProy` |
| 7 | Stock en tránsito desde OCs | Manual Experto | ✓ CUMPLE | `stock_en_transito` desde OCs en estados `confirmada/enviada/en_transito` |
| 8 | Reorder point con LT y safety stock | BANVA Parte 4 | ✓ CUMPLE | Doble cálculo: legacy + nuevo con `√(LT·σ_D² + D̄²·σ_LT²)` |
| 9 | Safety stock con σ_LT real | BANVA Parte 4 | ⚠ PARCIAL | Fórmula implementada, pero σ_LT no poblado en producción (gap heredado de auditoría 18-abr) |
| 10 | EOQ (lote económico) | BANVA Parte 4 | ✗ GAP | `pedir_proveedor` 100% cobertura-driven, no minimiza costo total ordenar+mantener |
| 11 | ABC por margen / ingreso / unidades | BANVA Parte 2 | ✓ CUMPLE | 3 ejes Pareto 80/20 en `intelligence.ts` |
| 12 | XYZ por coeficiente de variación | BANVA Parte 2 | ✓ CUMPLE | CV = σ/μ con umbrales 0.5/1.0 |
| 13 | Matriz ABC-XYZ multi-cuadrante | BANVA Parte 2 | ⚠ PARCIAL | 4 cuadrantes BANVA (ESTRELLA/CASHCOW/VOLUMEN/REVISAR) en vez de 9 estándar — naming custom, lógica equivalente |
| 14 | Política diferenciada por cuadrante | BANVA Parte 2 | ⚠ PARCIAL | `target_dias_full` por clase ABC; falta `nivel_servicio` formal por cuadrante |
| 15 | TSB / Croston para demanda intermitente | BANVA Parte 3 | ✓ CUMPLE | RPC `calcular_tsb` + `inteligencia_base_tsb` (v53), 104 SKUs en shadow mode |
| 16 | Holt-Winters para SKUs estacionales | BANVA Parte 3 | ✗ GAP | Solo SMA ponderada. Aceptado en PR4 hasta tener ≥52 semanas de histórico (estimado enero 2027) |
| 17 | WMAPE como métrica oficial | BANVA Parte 3 | ⚠ PARCIAL | `forecast_accuracy` calculado (v51), pero el motor no ajusta `pedir_proveedor` por sesgo |
| 18 | Eventos calendario (CyberDay, Hot Sale) | BANVA Parte 3 | ⚠ PARCIAL | Multiplicador aplicado a `vel_ponderada`, sin lead/lag formal post-evento |
| 19 | Cycle counting ABC-driven | BANVA Parte 5 | ⚠ PARCIAL | Tabla `conteos` y UI operador existen; sin scheduler automático A=7d / B=30d / C=90d |
| 20 | Lotes / series / trazabilidad batch | ERP Patrones | ✗ GAP | Sin `lot_number` en `stock` ni `movimientos`. No se puede trazar defectuosos por lote |
| 21 | Valuación FIFO | Manual Experto | ⚠ PARCIAL | Usa WAC (`costo_promedio`); FIFO requiere lotes (gap #20) |
| 22 | Gestión formal de devoluciones | Manual Experto | ⚠ PARCIAL | Campo `cantidad_devuelta` en `pedidos_flex` legacy. Sin modelo de causa de devolución ni movimiento de reverso |
| 23 | Concurrencia multi-transacción | ERP Patrones | ⚠ PARCIAL | SELECT FOR UPDATE solo en RPC de bloqueo de líneas. Updates a `stock_full_cache` confían en transacción DB sin lock explícito |
| 24 | KPIs (DIO / GMROI / WMAPE / ACOS) | BANVA Parte 1 | ⚠ PARCIAL | Calculados, pero DIO usa estimados (no COGS real) y WMAPE no retroalimenta el motor |
| 25 | Sync ML con reconciliador periódico | ERP Patrones | ✓ CUMPLE | Cron `/api/ml/stock-reconcile` cada hora (PR6b-pivot, abr-2026) |

---

## Top 5 gaps con plan de implementación

### Gap 1 — Reservaciones explícitas (CRÍTICO)

**Problema**: cuando una orden ML llega, el código deduce stock inmediatamente sin tabla formal de reservas. Dos webhooks simultáneos pueden ambos ver el mismo stock disponible y reservar de más.

**Lo que dicen los manuales**: tabla separada con `(order_id, sku, qty, type IN ('soft','hard'), expires_at)`, RPC atómica con SELECT FOR UPDATE, cron de expiración cada 5 min.

**Plan**:
1. Migración `v73`: tabla `reservations` con `expires_at`, status, tipo
2. RPC `reservar_stock_linea(order_id, sku, qty, tipo)` atómica
3. Cron `limpiar_reservaciones_expiradas` cada 5 min
4. Webhook ML: `webhook → reserve_stock_linea(hard) → fulfillment → release on shipment`
5. Update `intelligence.ts` para restar `qty_reserved_hard` de disponible

**Esfuerzo**: 12-15 horas. **Archivos**: nueva migración SQL + `ml.ts` (webhook) + `intelligence.ts` (cálculo disponible).

---

### Gap 2 — Lotes/series y trazabilidad batch (CRÍTICO)

**Problema**: si una recepción de Idetex con 500 quilts tiene 50 defectuosos, no hay forma de aislar los 50 — todo el SKU queda sospechoso. No se puede hacer FIFO real ni reclamar al proveedor por lote.

**Lo que dicen los manuales**: cada movimiento debe llevar `lot_number`. Tabla `lotes` con fecha recepción, proveedor, cantidad recibida vs defectuosa.

**Plan**:
1. Migración `v76`: agregar `lot_number` a `stock`, `movimientos`, `recepcion_lineas`. Crear tabla `lotes`.
2. App Etiquetas (`~/banva1/`): agregar campo "número de lote" al flujo de recepción (afecta cross-repo)
3. Recálculo de COGS: ordenar por `lot_number` ASC para FIFO
4. Dashboard de defectividad por lote en admin

**Esfuerzo**: 18-22 horas. **Archivos**: migración SQL + `banva1/index.html` + nueva ruta admin de lotes.

---

### Gap 3 — Holt-Winters para SKUs estacionales (MEDIO)

**Problema**: SMA ponderada aplasta el pico estacional. Quilt invierno = 450 uds en abril vs 280 uds promedio anual. SMA dice 280 → stock insuficiente abril, exceso mayo.

**Lo que dicen los manuales**: Holt-Winters multiplicativo es baseline para retail con estacionalidad. WMAPE < 20% es clase mundial.

**Estado**: PR4 lo dejó deferred hasta tener ≥52 semanas de histórico (enero 2027). Hoy hay marca manual `es_estacional` en 67/533 SKUs.

**Plan parcial accionable hoy**:
1. Aprovechar el marcado manual `es_estacional` para aplicar multiplicador estacional aprendido año-anterior cuando exista
2. Usar `factor_mes` por categoría (quilts/sábanas térmicas/cubrecamas) como fallback hasta tener 24+ meses por SKU

**Esfuerzo**: 8-10 horas para fallback por categoría; 20-25 horas para HW completo cuando haya datos.

---

### Gap 4 — Política automática de cycle counting (MEDIO)

**Problema**: la auditoría forense de 18-abril documenta solo **2 conteos en toda la historia** de la base de datos. Sin conteos cíclicos no se detecta shrinkage temprano.

**Lo que dicen los manuales**: ABC-driven — A cada 7 días, B cada 30, C cada 90.

**Plan**:
1. Migración `v75`: tabla `conteo_schedule(sku, clase_abc, dias_intervalo, proximo_conteo)`
2. Cron diario que genera tareas pendientes para `proximo_conteo <= hoy`
3. UI en `/operador/conteos` con filtro "Programados hoy" priorizando A
4. Al cerrar conteo: `UPDATE proximo_conteo = today + intervalo`

**Esfuerzo**: 8-10 horas. **Archivos**: migración + cron route + UI operador.

---

### Gap 5 — EOQ como complemento (BAJO-MEDIO)

**Problema**: `pedir_proveedor` se calcula 100% cobertura-driven. Para SKUs A con costo de OC alto (~$25k), pedir lotes pequeños frecuentes genera overhead innecesario.

**Lo que dicen los manuales**: EOQ = √(2DS/H) minimiza costo total. Para textiles retail, 2-3 órdenes/mes por SKU A es típico.

**Plan**:
1. Función pura `calcularEOQ(D_anual, S, H)` en `reposicion.ts`
2. Para SKUs A con datos suficientes: `pedir = max(EOQ, ROP_clásico)`
3. Campo `pedir_metodo IN ('cob_driven', 'eoq', 'fallback')` para observabilidad

**Esfuerzo**: 6-8 horas. Riesgo bajo (es función pura, fácil de testear).

---

## Decisiones deliberadas justificadas

### Sin ubicaciones virtuales supplier/customer/inventory
**Manuales recomiendan**: árbol completo Odoo-style con location_id en cada movimiento.
**BANVA hace**: `movimientos.razon` con tipo de operación, sin ubicaciones virtuales.
**Justificación**: 1-2 bodegas, 1 canal principal (ML). La virtualización agrega 15-20h de implementación sin valor operativo a esta escala. Re-evaluar si BANVA escala a 3+ centros de distribución.

### WAC en vez de FIFO
**Manuales recomiendan**: FIFO para textiles con riesgo de obsolescencia.
**BANVA hace**: `costo_promedio` ponderado.
**Justificación**: Idetex es proveedor único (~90% volumen), costos estables, sin arbitraje. FIFO requiere lotes (Gap 2) y agrega ~20h sin mejora material en margen reportado.

### Sin soft-reservations (carrito abandonado)
**Manuales recomiendan**: soft-reservation para wishlist + hard al confirmar pago.
**BANVA hace**: solo deduce stock al confirmar orden.
**Justificación**: Flex es pago inmediato, no hay ventana intermedia. Carrito web abandonado representa <5% de eventos y no requiere infra dedicada.

### Forecast accuracy no retroalimenta el motor
**Manuales recomiendan**: si WMAPE > umbral, aumentar safety stock dinámicamente.
**BANVA hace**: calcula WMAPE, alerta `forecast_descalibrado`, pero el motor sigue usando `vel_ponderada` sin ajuste.
**Justificación parcial**: SMA 4 sem ya es reactivo; loop de feedback agrega complejidad. Revisar si las alertas no se atienden manualmente con frecuencia.

---

## Cruce con la auditoría forense del 18-abril

3 de los 5 gaps de este reporte ya estaban documentados en abril:
- **Lotes/series** — citado como pendiente de "trazabilidad batch" en sección de Operaciones de Bodega
- **EOQ** — citado en sección de Reposición
- **Holt-Winters** — explícitamente diferido a enero 2027 en PR4

Los **2 gaps nuevos** que aporta este reporte son:
- Reservaciones explícitas (no estaba en la auditoría forense)
- Cycle counting automático (estaba citado pero sin plan de implementación concreto)

**Items de la auditoría forense que siguen abiertos y no están en este reporte** (ver `banva-bodega-auditoria-2026-04-18.md` para detalle):
- Pausa automática Product Ads OOS — infra existe (PR6b), confirmar que el cron diario está actuando en producción
- σ_LT real desde OCs cerradas (0/533 SKUs poblados)
- KVI / PLC / matriz 9 cuadrantes oficial

---

## Conclusión

El WMS está sólido en lo crítico. Los 5 gaps identificados son acotados, accionables, y suman ~50-65 horas de implementación si se ejecutan los cinco. Priorización recomendada por impacto operativo:

1. Reservaciones explícitas (race condition real, no hipotético)
2. Lotes/series (habilita FIFO + reclamos a proveedor)
3. Cycle counting automático (esfuerzo bajo, alto valor)
4. Holt-Winters por categoría (paliativo hasta 2027)
5. EOQ (cierre fino, no bloquea)
