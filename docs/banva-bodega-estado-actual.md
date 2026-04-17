# BANVA Bodega — Estado actual del sistema

Documento fuente de verdad del WMS al **2026-04-16**. Reemplaza al viejo `AdminInteligencia.txt` y complementa a `banva-bodega-inteligencia.md` (dive profundo al motor).

## Tabla de contenidos

1. [Schema DB (Supabase actual)](#1-schema-db-supabase-actual)
2. [Motor Inteligencia (estado real)](#2-motor-inteligencia-estado-real)
3. [Endpoints API activos](#3-endpoints-api-activos)
4. [UI y rutas](#4-ui-y-rutas)
5. [Integraciones externas](#5-integraciones-externas)
6. [Estado del negocio (data actual)](#6-estado-del-negocio-data-actual)
7. [Deuda técnica conocida](#7-deuda-técnica-conocida)
8. [Historial reciente de cambios](#8-historial-reciente-de-cambios)

---

## 1. Schema DB (Supabase actual)

Proyecto Supabase: `qaircihuiafgnnrwcjls`. Schema `public`. **87 tablas**, **8 vistas**, **22 funciones RPC**. Todas las tablas con RLS habilitado y política permisiva `USING(true)` — la seguridad depende de que la `anon key` no se exponga fuera de la app.

### 1.1 Tablas por dominio

Row count estimado desde `pg_class.reltuples` (valor `-1` = postgres aún no hizo ANALYZE; se reporta `n/d`).

#### Dominio INVENTARIO

| Tabla | Cols | Tamaño | Est. rows | Columnas clave | Notas |
|---|---|---|---|---|---|
| `stock` | 8 | 208 KB | 290 | `sku, posicion_id, cantidad, qty_reserved` | Stock físico por SKU+posición. Trigger `auto_adjust_reserved` ajusta reservas |
| `movimientos` | 13 | 1.1 MB | 3.143 | `sku, posicion_id, tipo, cantidad, qty_after, recepcion_id, costo_unitario, idempotency_key` | Ledger inmutable. Todo cambio pasa por `registrar_movimiento_stock()` |
| `conteos` | 11 | 184 KB | 1 | `lineas (jsonb), estado, operario, fecha` | Conteos cíclicos; líneas embebidas |
| `posiciones` | 9 | 64 KB | 27 | `id, nombre, tipo, bloque, orden` | Grid físico de bodega |
| `stock_full_cache` | 10 | 304 KB | 753 | `sku, qty, fuente (cache/webhook/api_distribuida/resta_pendientes)` | Stock en meli_facility (Full) |
| `stock_snapshots` | 9 | 280 KB | 375 | `sku_origen, fecha, stock_*, en_quiebre` | Snapshot diario (vía motor) |
| `stock_sync_queue` | 2 | 112 KB | 54 | `sku` | Cola de push a selling_address |
| `envio_full_pendiente` | 7 | 48 KB | n/d | `sku, qty, picking_session_id, estado` | Reservas para envíos a Full |
| `envios_full_historial` | 10 | 48 KB | n/d | `sku, qty, fecha_envio, session_id` | Log histórico de envíos |
| `envios_full_lineas` | 20 | 224 KB | 389 | `session_id, componentes (jsonb), estado` | Líneas de picking para Full |

#### Dominio VENTAS

| Tabla | Cols | Tamaño | Est. rows | Columnas clave | Notas |
|---|---|---|---|---|---|
| `orders_history` | 20 | 5.6 MB | 8.332 | `order_id, sku_venta, canal (full/flex), fecha, status` | Canon de órdenes históricas |
| `orders_imports` | 9 | 72 KB | 245 | `archivo, tipo, fecha_import` | Log de imports CSV |
| `ventas_ml_cache` | 38 | 10 MB | 10.512 | `order_id, item_id, variation_id, sku_venta, costo, comision, envio, margen_*` | Cache enriquecido; fuente del motor |
| `pedidos_flex` | 15 | 1.3 MB | 332 | `order_id, sku_venta, fecha_armado, estado` | **Legacy** (pre shipment-centric) |
| `ml_shipments` | 19 | 440 KB | 963 | `shipment_id, order_ids[], status, substatus, logistic_type, handling_limit` | Modelo nuevo shipment-centric |
| `ml_shipment_items` | 9 | 536 KB | 990 | `shipment_id, seller_sku, quantity, stock_deducted` | Items por shipment |
| `ml_items_map` | 27 | 904 KB | 659 | `sku (origen), item_id, variation_id, sku_venta, user_product_id, stock_version, status` | Mapeo WMS ↔ ML (singleton lógico por `(item_id,variation_id)`) |
| `ml_webhook_log` | 12 | 136 KB | 58 | `topic, resource, status, payload, error` | Log de webhooks recibidos |
| `ml_sync_estado` | 10 | 64 KB | 1 | `last_order_fetch, last_shipment_fetch, last_full_sync` | Singleton `id='main'` |
| `ml_velocidad_semanal` | 7 | 600 KB | 1.633 | `sku_venta, semana, uds` | Histórico de velocidad |
| `ml_margin_cache` | 24 | 696 KB | 623 | `item_id, margen_neto, comision, costo_envio, fecha_calculo` | Cache márgenes por item |
| `ml_ads_daily_cache` | 14 | 7.9 MB | 29.602 | `item_id, fecha, inversion, ingresos, acos, roas` | Analytics de ads |
| `ml_snapshot_mensual` | 67 | 1.7 MB | 1.880 | `item_id, periodo, visitas, cvr, ingreso_*, quality_score` | Snapshot mensual (source de views) |
| `ml_resumen_mensual` | 34 | 48 KB | n/d | `periodo, items_activos, visitas_total, …` | Agregado por periodo |
| `ml_campaigns_mensual` | 33 | 48 KB | n/d | `campaign_id, periodo, inversion, conversiones` | Campañas ads |
| `ml_benchmarks` | 12 | 48 KB | 5 | `categoria, metric, valor` | Benchmarks competencia |
| `ml_item_attr_snapshot` | 5 | 632 KB | 2.405 | `item_id, fecha, atributos (jsonb)` | Historial atributos |
| `ml_item_changes` | 7 | 64 KB | n/d | `item_id, campo, antes, despues, detectado_at` | Delta de atributos |
| `ml_shipping_tariffs` | 7 | 32 KB | n/d | `peso_gr_max, precio, tarifa` | Matriz envío Full |
| `ml_acciones` | 12 | 32 KB | n/d | `item_id, tipo_accion, valor_antes, valor_despues, fecha` | Tracking de cambios admin |
| `ml_config` | 15 | 64 KB | 1 | `client_id, client_secret, access_token, refresh_token, expires_at` | Singleton `id='main'` |
| `pasarelas_pago` | 14 | 2 MB | 3.579 | `medio_pago, monto, comision, fecha` | MP + tarjetas + transferencias |

#### Dominio COMPRAS

| Tabla | Cols | Tamaño | Est. rows | Columnas clave | Notas |
|---|---|---|---|---|---|
| `ordenes_compra` | 15 | 80 KB | n/d (4 total) | `numero, proveedor, estado, total_neto, fecha` | **Uso marginal**: sólo 4 OCs en producción, todas `ANULADA` |
| `ordenes_compra_lineas` | 22 | 192 KB | 247 | `orden_id, sku_origen, cantidad_pedida, cantidad_recibida, precio_neto` | Líneas abiertas de OC |
| `recepciones` | 14 | 208 KB | 66 | `folio_sii, proveedor, total, orden_compra_id` | **66 recepciones, 100% sin `orden_compra_id`** → vía app factura-etiquetas |
| `recepcion_lineas` | 25 | 336 KB | 735 | `sku, cantidad_esperada, cantidad_recibida, qty_ubicada, bloqueado_por, bloqueado_hasta` | Cotejo de factura → stock |
| `recepcion_ajustes` | 11 | 48 KB | n/d | `recepcion_id, tipo_ajuste, qty, motivo` | Ajustes manuales |
| `proveedores` | 12 | 48 KB | n/d | `rut, nombre, lead_time_dias, sigma_dias, moq` | Catálogo maestro |
| `proveedor_catalogo` | 8 | 536 KB | 875 | `sku_origen, precio_neto, precio_bruto, stock_disponible, actualizado_at` | Precios y stock por proveedor |
| `proveedor_cuenta` | 10 | 48 KB | n/d | `proveedor, saldo, ultimo_pago, vence` | Cuenta corriente |
| `proveedor_imports` | 8 | 32 KB | n/d | `archivo, fecha_import, lineas_ok, lineas_error` | Log import catálogo |
| `discrepancias_costo` | 14 | 88 KB | 159 | `recepcion_id, sku, costo_factura, wac, delta_pct` | Diff factura vs WAC |
| `discrepancias_qty` | 13 | 96 KB | 16 | `recepcion_id, sku, qty_esperada, qty_recibida` | Diff qty |
| `rcv_compras` | 23 | 384 KB | 483 | `folio, rut_proveedor, neto, iva, fecha, periodo` | Registro SII de compras |
| `rcv_ventas` | 22 | 248 KB | 136 | `folio, rut_cliente, neto, iva` | Registro SII de ventas |
| `costos_historial` | 7 | 64 KB | n/d | `sku, costo_anterior, costo_nuevo, fuente, fecha` | Trail de cambios de costo |

#### Dominio INTELIGENCIA

| Tabla | Cols | Tamaño | Est. rows | Columnas clave | Notas |
|---|---|---|---|---|---|
| `sku_intelligence` | **118** | 1.6 MB | 533 | `sku_origen, vel_*, stock_*, abc, cuadrante, accion, alertas[], safety_stock_*, rop_calculado, factor_rampup_aplicado, oportunidad_perdida_es_estimacion, es_quiebre_proveedor` | Output canon del motor. 118 columnas |
| `sku_intelligence_history` | 33 | 400 KB | 375 | `sku_origen, fecha, vel_*, stock_*, accion, gmroi, dio` | Snapshot diario histórico |
| `sku_revision_log` | 17 | 32 KB | n/d | `sku, campo, antes, despues, quien, fecha` | Audit de ediciones manuales |
| `intel_config` | 5 | 32 KB | n/d | `id='main', nivel_servicio_*, target_dias_*` | Config global del motor |
| `config_historial` | 5 | 24 KB | n/d | `config_key, valor, quien, fecha` | Audit config |
| `eventos_demanda` | 12 | 32 KB | n/d | `nombre, fecha_inicio, fecha_fin, multiplicador, categorias[]` | Eventos de demanda (BF, CM, etc.) |
| `vel_objetivo_historial` | 6 | 24 KB | n/d | `sku_origen, vel_objetivo, quien, fecha` | Trail vel_objetivo manual |

#### Dominio PRODUCTO

| Tabla | Cols | Tamaño | Est. rows | Columnas clave | Notas |
|---|---|---|---|---|---|
| `productos` | 23 | 416 KB | 431 | `sku (unique), nombre, categoria, proveedor, costo_neto, costo_manual, costo_promedio (WAC), inner_pack, moq, lead_time_dias, sigma_dias, activo` | Maestro. FK: `stock.sku → productos.sku` |
| `composicion_venta` | 9 | 808 KB | 419 | `sku_venta, sku_origen, unidades, codigo_ml` (UNIQUE `(sku_venta, sku_origen)`) | Packs/combos. Soporta multi-origen |

#### Dominio OPERACIÓN

| Tabla | Cols | Tamaño | Est. rows | Columnas clave | Notas |
|---|---|---|---|---|---|
| `admin_actions_log` | 6 | 96 KB | n/d | `accion, entidad, params (jsonb), quien, created_at` | Audit admin genérico |
| `audit_log` | 9 | 4.8 MB | 10.214 | `accion, entidad_id, params, resultado, quien, created_at` | Audit granular (stock_sync, ML PUT) |
| `sync_log` | 6 | 104 KB | 187 | `kind, ok, detail, at` | Log de corridas de sync |
| `picking_sessions` | 8 | 360 KB | 35 | `id, titulo, tipo (flex/envio_full), estado (ABIERTA/EN_PROCESO/CERRADA), lineas (jsonb)` | Sesiones de armado |
| `picking_bultos` | 4 | 40 KB | n/d | `session_id, bulto_numero` | Bultos creados al cerrar |
| `picking_bultos_lineas` | 6 | 48 KB | n/d | `bulto_id, sku, cantidad` | Detalle por bulto |
| `operarios` | 6 | 32 KB | n/d | `id, nombre, pin, activo, rol (operario/admin)` | Login operador (PIN en texto plano) |
| `agent_config` | 14 | 64 KB | n/d | `nombre, modelo, prompt_base, activo` | Config agentes IA |
| `agent_rules` | 11 | 48 KB | n/d | `nombre, trigger, condicion, accion, activo` | Reglas que disparan agentes |
| `agent_triggers` | 8 | 80 KB | 16 | `agent_id, rule_id, proximo_disparo` | Triggers agendados |
| `agent_runs` | 13 | 6.4 MB | 15.367 | `agent_id, input, output, tokens_in, tokens_out, coste, exito, duracion_ms` | Log de ejecuciones |
| `agent_insights` | 15 | 144 KB | 29 | `agent_id, texto, tipo, visto, feedback` | Insights producidos |
| `agent_conversations` | 7 | 48 KB | n/d | `usuario, mensajes (jsonb), created_at` | Chat con agentes |
| `agent_data_snapshots` | 5 | 152 KB | n/d | `agent_id, fecha, data (jsonb)` | Snapshot input a agentes |
| `feedback_agentes` | 7 | 96 KB | n/d | `run_id, rating, comentario, fecha` | Rating de respuestas |

#### Dominio CONCILIACIÓN (bancaria / SII)

| Tabla | Cols | Tamaño | Est. rows | Notas |
|---|---|---|---|---|
| `movimientos_banco` | 21 | 5.3 MB | 6.007 | Extracto banco + cuenta + conciliación |
| `conciliaciones` | 16 | 136 KB | 215 | Header: periodo + estado |
| `conciliacion_items` | 6 | 96 KB | 51 | Matches manuales RCV ↔ banco |
| `reglas_conciliacion` | 10 | 48 KB | n/d | Reglas automáticas de matching |
| `periodos_conciliacion` | 12 | 32 KB | n/d | Cierres mensuales |
| `cuentas_bancarias` | 10 | 48 KB | n/d | Cuentas configuradas |
| `plan_cuentas` | 9 | 80 KB | 24 | Plan contable |
| `presupuesto` | 7 | 24 KB | n/d | Budget por categoría |
| `cobranza_acciones` | 9 | 24 KB | n/d | Acciones de cobranza B2B |
| `mp_liquidacion_detalle` | 19 | 56 KB | n/d | Detalle liquidaciones MP |
| `empresas` | 4 | 48 KB | n/d | Razones sociales (BANVA + ALBA) |

#### Dominio SEMÁFORO / ALERTAS

| Tabla | Cols | Tamaño | Notas |
|---|---|---|---|
| `semaforo_semanal` | 26 | 440 KB / 704 rows | Snapshot semanal: color + razón |
| `semaforo_snapshot_semanal` | 21 | 48 KB | Snapshot anterior para comparación |
| `semaforo_config` | 4 | 32 KB | Umbrales por tipo |
| `alertas` | 9 | 24 KB | Genéricas (poco usadas) |

#### Otros

| Tabla | Notas |
|---|---|
| `mapa_config` (singleton `id='main'`, 104 KB) | Config visual de `/admin/mapa` |
| `profitguard_cache` (928 KB) | Cache agregado de rentabilidad por orden |
| `_backup_sku_intelligence_dias_quiebre_20260416` | Backup puntual del fix ramp-up |
| `_backup_test_vinculacion_20260416` | Backup ML vinculación |

### 1.2 Triggers activos

| Trigger | Tabla | Función | Propósito |
|---|---|---|---|
| `auto_adjust_reserved` (AFTER INSERT/UPDATE) | `stock` | `auto_adjust_reserved()` | Reajusta `qty_reserved` cuando cambia `cantidad` |
| `rcv_compras_normalizar_periodo` (BEFORE INSERT/UPDATE) | `rcv_compras` | idem | Derivar `periodo` (YYYY-MM) desde `fecha` |
| `resolver_factura_ref` | `movimientos_banco` | idem | Resolve ref a `rcv_compras` por folio |

### 1.3 Vistas (`v_*` + `vista_venta`)

| Vista | Propósito / retorno |
|---|---|
| `v_stock_disponible` | Agrega por `sku`: `on_hand, reserved, disponible`. Base para UI stock |
| `v_stock_proyectado` | `v_stock_disponible` + `en_camino` de OCs confirmadas/parciales/en_transito |
| `v_evolucion_sku` | Serie temporal mensual por `sku_venta` (de `ml_snapshot_mensual`) |
| `v_impacto_acciones` | Join `ml_acciones` vs snapshot antes/después del cambio |
| `v_skus_mejoraron` | Top SKUs con mejora MoM en uds/CVR/ingreso |
| `v_tendencia_mensual` | Agregado mensual de todo el portafolio ML |
| `v_timeline_sku` | UNION ALL por SKU: movimientos, PUT a ML, reservas (Flex), reservas (Full). Ordenado DESC |
| `vista_venta` | Flatten `composicion_venta` + `productos` para UI |

### 1.4 Funciones RPC / stored procedures (22)

| Función | Firma | Uso |
|---|---|---|
| `registrar_movimiento_stock` | `(p_sku, p_posicion, p_delta, p_tipo, p_sku_venta?, p_motivo?, p_operario?, p_nota?, p_recepcion_id?, p_costo_unitario?, p_idempotency_key?) → uuid` | **Canónico**. Todo cambio de stock pasa por aquí |
| `update_stock` | `(p_sku, p_posicion, p_delta, p_sku_venta?) → void` | **LEGACY — evitar**. No registra movimiento. Pendiente migrar y eliminar |
| `reservar_stock` | `(p_sku, p_cantidad) → boolean` | Reserva para picking Flex |
| `liberar_reserva` (x2 sobrecargas) | `(p_sku, p_cantidad, p_descontar?, p_motivo?, p_operario?, p_idempotency_key_prefix?) → boolean` | Libera reserva; con `p_descontar=true` confirma |
| `transferir_stock` | `(p_sku, p_pos_origen, p_pos_destino, p_cantidad, p_operario?) → boolean` | Traspaso interno |
| `stock_total` | `(p_sku) → integer` | Helper SUM por SKU |
| `bloquear_linea` | `(p_linea_id uuid, p_operario, p_minutos=15) → boolean` | Lock optimista 15 min en `recepcion_lineas` |
| `desbloquear_linea` | `(p_linea_id) → void` | Libera lock manual |
| `calcular_qty_ubicada` | `(p_recepcion_id, p_sku) → integer` | Suma qty ya ubicada en bodega |
| `agregar_linea_picking` | `(p_session_id, p_linea jsonb) → void` | Mutación atómica sobre `picking_sessions.lineas` |
| `actualizar_linea_picking` | `(p_session_id, p_linea_id, p_patch jsonb) → jsonb` | Parche atómico |
| `eliminar_linea_picking` | `(p_session_id, p_linea_id) → boolean` | Borra línea |
| `dividir_envio_full` | `(p_session_id, p_linea_ids[], p_nuevo_titulo, p_fecha) → uuid` | Fork de sesión envío Full |
| `reconciliar_reservas` | `() → TABLE(sku, reserva_anterior, reserva_nueva)` | Recompone `qty_reserved` desde shipments + pickings |
| `calcular_reservas_correctas` | `() → TABLE(sku_fisico, qty_deberia_reservar)` | Cálculo read-only (preview de reconciliar) |
| `desglose_reservas` | `() → TABLE(fuente, total_reservado)` | Desglose por origen (ML Flex / Picking Full / Manual) |
| `calcular_costo_envio_ml` | `(p_peso_gr, p_precio) → integer` | Lookup tarifa Full según peso/precio |
| `resolver_sku_fisico` | `(p_seller_sku) → text` | Convierte `sku_venta` a `sku_origen` vía composición |

### 1.5 Migraciones

Versionadas como `supabase-v{N}-*.sql` en la raíz. Última familia aplicada: `v50-admin-atomic-picking.sql`. Se ejecutan **manualmente** en Supabase SQL Editor (no hay herramienta automatizada de migraciones). La tabla `supabase_migrations.schema_migrations` registra cada `apply_migration()` hecho vía MCP, pero el grueso histórico se hizo sin registrar.

### 1.6 Extensiones Postgres habilitadas

Habituales: `pgcrypto`, `uuid-ossp`, `pg_graphql`, `pg_stat_statements`, `supabase_vault`, `pgsodium`. (No dependencias exóticas del dominio.)

### 1.7 Storage Buckets

- `banva` — único bucket activo. Se usa como almacenamiento genérico para etiquetas PDF, QRs y eventuales adjuntos de recepción. Uso real bajo; gran parte del flujo documental pasa por **app Etiquetas** (ver §5.1).

---

## 2. Motor Inteligencia (estado real)

### 2.1 Pasos del motor `recalcularTodo()` — `src/lib/intelligence.ts` (1.766 LOC)

El motor ya no son "19 pasos planos": hay **pasos por SKU dentro del loop principal** y **pasos globales después del loop**. Listado actualizado al commit `352e7a4` (2026-04-16).

**Pasos por SKU (loop principal, líneas 733–1355):**

| # | Paso | Inputs | Outputs (`sku_intelligence`) | Cambio reciente |
|---|---|---|---|---|
| 1 | **Identidad + catálogo proveedor** | `productos`, `proveedor_catalogo` | `sku_origen, nombre, categoria, proveedor, costo_neto, costo_bruto, costo_fuente, stock_proveedor, tiene_stock_prov, inner_pack` | Cascada costo promedio→manual→catálogo; inner_pack desde productos |
| 2 | **Demanda (velocidades físicas)** | `ventas_ml_cache`, `composicion_venta`, `stock_snapshots` | `vel_7d, vel_30d, vel_60d, vel_ponderada, vel_full, vel_flex, pct_full, pct_flex, margen_*_7/30/60d, precio_promedio, ingreso_30d` | #261 excluye semanas en quiebre (≥3d) |
| 3 | **Tendencia y picos** | vel_7d, vel_30d | `tendencia_vel, tendencia_vel_pct, es_pico, pico_magnitud` | |
| 4 | **Eventos de demanda** | `eventos_demanda` | `multiplicador_evento, evento_activo, vel_ajustada_evento` | |
| 5 | **Stock (físico + Full + tránsito)** | `stock`, `stock_full_cache`, `ordenes_compra_lineas`, `envio_full_pendiente` | `stock_bodega, stock_full, stock_total, stock_en_transito, stock_proyectado, oc_pendientes` | PR #250 suma envíos pendientes a tránsito |
| 6 | **Cobertura** | stock, velocidades | `cob_full, cob_flex, cob_total` | |
| 7 | **Margen por canal + split Full/Flex** | financials de `ventas_ml_cache` | `canal_mas_rentable, pct_full, pct_flex, margen_tendencia_*` | 80/20 default; 70/30 si flex más rentable en >10% |
| 8 | **Target cobertura ABC** (placeholder, se calcula global paso 11) | ABC | `target_dias_full` | A=42, B=28, C=14d (configurable `intel_config`) |
| 10 | **Clasificación XYZ + dedupe alternativas** | σ, media semanal | `cv, xyz, desviacion_std, pedir_proveedor` ajustado | Dedupe: si grupo alternativo ya cubierto, no pedir |
| 10c | **Ramp-up post-quiebre** | `rampup.ts` (dias_en_quiebre, es_quiebre_proveedor) | `factor_rampup_aplicado, rampup_motivo, pedir_proveedor` (reducido) | **#261–#264** |
| 12 | **Safety stock + ROP** | σ_D, LT, σ_LT, Z | `safety_stock_simple, safety_stock_completo, safety_stock_fuente, lead_time_usado_dias, lead_time_fuente, rop_calculado, necesita_pedir` | Fase B: cascada LT `oc_real(≥3muestras) > manual_proveedor > manual_producto_legacy > fallback_5d` |
| 13 | **Indicadores financieros** | stock, velocidad, margen | `gmroi, dio, costo_inventario_total` | |
| 14 | **Quiebre prolongado + oportunidad perdida** | `stock_snapshots`, prev `sku_intelligence`, ramp-up | `vel_pre_quiebre, margen_unitario_pre_quiebre, dias_en_quiebre, es_quiebre_proveedor, venta_perdida_uds, venta_perdida_pesos, oportunidad_perdida_es_estimacion, gmroi_potencial, es_catch_up` | #263 usa `vel_60d` limpia; #262 protección ESTRELLA/CASHCOW |
| 15 | **Acción y prioridad** | todo lo anterior | `accion, prioridad, mandar_full, pedir_proveedor` | |
| 16 | **Ajuste de precio** | margen vs precio, velocidad | `requiere_ajuste_precio` | |
| 18 | **Operación (conteos/movimientos)** | `conteos`, `movimientos` | `ultimo_conteo, dias_sin_conteo, diferencias_conteo, ultimo_movimiento, dias_sin_movimiento` | |

**Pasos globales (después del loop, líneas 1365–1766):**

| # | Paso | Outputs |
|---|---|---|
| 9 | **ABC 3 ejes (Pareto)** | `abc_margen, abc_ingreso, abc_unidades, abc, pct_*_acumulado` (imputa vel_pre × margen para quiebres) |
| 11 | **Cuadrante (matriz fija)** | `cuadrante` (ESTRELLA / CASHCOW / VOLUMEN / REVISAR) |
| — | **Recalc `mandar_full` / `pedir_proveedor` con targets ABC** | + redondeo a `inner_pack` → `pedir_proveedor_bultos` |
| 17 | **Protocolo liquidación** | `liquidacion_accion, liquidacion_dias_extra, liquidacion_descuento_sugerido` |
| 19 | **Alertas (29 tipos)** | `alertas[], alertas_count` |
| — | **Generar history + stock_snapshots** | filas para `sku_intelligence_history` + `stock_snapshots` |

**Conteo real:** 13 pasos por SKU + 6 pasos globales = **19 pasos lógicos** (coincide con el nombre histórico, pero con responsabilidades redistribuidas).

### 2.2 Campos de `sku_intelligence` por grupo

Total de columnas: **118**. Resumen por grupo (detalle completo en `banva-bodega-inteligencia.md` §3):

- **Identidad (5)**: `sku_origen, nombre, categoria, proveedor, skus_venta[]`
- **Demanda (12)**: `vel_7d, vel_30d, vel_60d, vel_ponderada, vel_full, vel_flex, vel_total, pct_full, pct_flex, tendencia_vel, tendencia_vel_pct, es_pico, pico_magnitud`
- **Eventos (3)**: `multiplicador_evento, evento_activo, vel_ajustada_evento`
- **Stock (10)**: `stock_full, stock_bodega, stock_total, stock_sin_etiquetar, stock_proveedor, tiene_stock_prov, inner_pack, stock_en_transito, stock_proyectado, oc_pendientes`
- **Cobertura (4)**: `cob_full, cob_flex, cob_total, target_dias_full`
- **Quiebres (12)**: `dias_sin_stock_full, semanas_con_quiebre, dias_en_quiebre, es_quiebre_proveedor, vel_pre_quiebre, margen_unitario_pre_quiebre, abc_pre_quiebre, venta_perdida_uds, venta_perdida_pesos, ingreso_perdido, oportunidad_perdida_es_estimacion, es_catch_up`
- **ABC/Cuadrante (10)**: `abc, abc_margen, abc_ingreso, abc_unidades, ingreso_30d, margen_neto_30d, uds_30d, pct_*_acumulado (x3), cv, xyz, desviacion_std, cuadrante`
- **Safety stock (10)**: `stock_seguridad, punto_reorden, nivel_servicio, lead_time_real_dias, lead_time_real_sigma, lead_time_usado_dias, lead_time_fuente, lt_muestras, safety_stock_simple, safety_stock_completo, safety_stock_fuente, rop_calculado, necesita_pedir`
- **Financieros (5)**: `gmroi, gmroi_potencial, dio, costo_inventario_total, costo_neto, costo_bruto, costo_fuente`
- **Acción + reposición (9)**: `accion, prioridad, mandar_full, pedir_proveedor, pedir_proveedor_bultos, pedir_proveedor_sin_rampup, factor_rampup_aplicado, rampup_motivo, requiere_ajuste_precio`
- **Alertas (2)**: `alertas[], alertas_count` — 29 strings posibles
- **Liquidación (3)**: `liquidacion_accion, liquidacion_dias_extra, liquidacion_descuento_sugerido`
- **Operación (5)**: `ultimo_conteo, dias_sin_conteo, diferencias_conteo, ultimo_movimiento, dias_sin_movimiento`
- **Objetivos (2)**: `vel_objetivo, gap_vel_pct`
- **Metadata (3)**: `updated_at, datos_desde, datos_hasta`

**Valores posibles de `accion`** (11):
`INACTIVO, NUEVO, MANDAR_FULL, DEAD_STOCK, AGOTADO_SIN_PROVEEDOR, AGOTADO_PEDIR, URGENTE, EN_TRANSITO, PLANIFICAR, OK, EXCESO`

### 2.3 Crons activos en `vercel.json`

16 crons configurados:

| Path | Schedule (UTC) | Frecuencia | Función |
|---|---|---|---|
| `/api/ml/sync` | `* * * * *` | cada minuto | Polling órdenes Flex recientes |
| `/api/ml/stock-sync` | `* * * * *` | cada minuto | Push stock Flex → ML (`selling_address`) |
| `/api/profitguard/sync` | `*/5 * * * *` | cada 5 min | Enriquecer márgenes por orden |
| `/api/ml/margin-cache/refresh?stale=true&limit=25` | `*/5 * * * *` | cada 5 min | Refrescar margen cache (stale, 25 items) |
| `/api/ml/items-sync` | `*/30 * * * *` | cada 30 min | Sync catálogo items ML |
| `/api/ml/sync-stock-full` | `*/30 * * * *` | cada 30 min | Sync stock Full desde `meli_facility` |
| `/api/ml/attr-watch` | `0 */6 * * *` | cada 6 h | Detectar cambios de atributos ML |
| `/api/ml/ads-daily-sync` | `0 */6 * * *` | cada 6 h | Sync ads daily |
| `/api/ml/ads-rebalance` | `30 */6 * * *` | cada 6 h (min 30) | Rebalancear budget ads |
| `/api/ml/metrics-sync` | `*/10 13-23 1-5 * *` | cada 10 min, L-V 13-23h UTC | Billing + métricas ML |
| `/api/agents/cron` | `0 8 * * *` | diario 08:00 UTC | Triggers de agentes |
| `/api/ml/ventas-reconcile` | `0 8 * * *` | diario 08:00 UTC | Reconciliar ventas ML |
| `/api/ml/ventas-sync?days=7` | `0 10 * * *` | diario 10:00 UTC | Bulk fetch últimas 7d |
| `/api/intelligence/recalcular?full=true&snapshot=true` | `0 11 * * *` | **diario 11:00 UTC** | **Recálculo motor + snapshot** |
| `/api/intelligence/actualizar-lead-times` | `0 12 * * 1` | lunes 12:00 UTC | Actualizar LT por proveedor |
| `/api/semaforo/refresh` | `0 9 * * 1` | lunes 09:00 UTC | Refrescar semáforo semanal |

No hay crons **deshabilitados** (el archivo no contiene entradas comentadas).

---

## 3. Endpoints API activos

**~96 endpoints** en `src/app/api/**/route.ts`. Tabla por dominio. Auth: `[DB]`=anon key + RLS permisivo (sin protección), `[CRON]`=Bearer `CRON_SECRET`.

### 3.1 Intelligence (8)

| Path | Métodos | Función | Consumer |
|---|---|---|---|
| `/api/intelligence/recalcular` | GET, POST | Corre `recalcularTodo()` + upsert + history + snapshot | Botón "Recalcular" + cron 11 UTC |
| `/api/intelligence/sku-venta` | GET | Vista SKU venta (composición, stock, velocidad, márgenes) | `AdminInteligencia` tab "envio" |
| `/api/intelligence/vista-venta` | GET | Vista comercial SKU venta (ABC, cuadrante, acción) | `AdminComercial` |
| `/api/intelligence/pendientes` | GET | SKUs pendientes (sin producto, sin costo, sin mapeo ML) | Banner + modal UI |
| `/api/intelligence/envio-full-log` | POST | Log de envíos a Full (redondeos, edits manuales) | Flujo crear picking Full |
| `/api/intelligence/sku/[sku_origen]` | PATCH | Update campos manuales (vel_objetivo, notas) | Inline edit UI |
| `/api/intelligence/sku/_bulk` | POST | Bulk update (velocidades, eventos, atributos) | Modal masivo UI |
| `/api/intelligence/actualizar-lead-times` | GET | Refresh LT/σ desde `proveedor_catalogo` + OCs | Cron lunes + botón |

### 3.2 ML / MercadoLibre (41)

Subagrupación:

- **OAuth + health**: `ml/auth`, `ml/verify`, `ml/debug`, `ml/diagnostico`, `ml/diagnostico/stock`, `ml/setup-tables`
- **Webhook + notifications**: `ml/webhook` (topics `orders_v2, shipments, claims, stock-locations, fbm_stock_operations, items`), `ml/subscribe-topic`
- **Órdenes + ventas**: `ml/sync`, `ml/ventas-sync`, `ml/ventas-reconcile`, `ml/ventas-cache`, `ml/ventas-stats`, `ml/orders-history`, `ml/refresh-shipments`, `ml/investigate`, `ml/setup-ventas-cache`
- **Stock**: `ml/stock-sync` (PUSH Flex), `ml/sync-stock-full` (PULL Full), `ml/stock-full`, `ml/stock-compare`, `ml/stock-health`, `ml/activate-with-stock`
- **Items + atributos**: `ml/items-sync`, `ml/item-update`, `ml/attr-watch`, `ml/attr-changes`, `ml/bulk-attr-sync`, `ml/link-missing`, `ml/publish`, `ml/variations`, `ml/categories`, `ml/category-attributes`
- **Promos**: `ml/promotions`, `ml/item-promotions`, `ml/scan-promos`
- **Ads**: `ml/ads-daily-sync`, `ml/ads-rebalance`, `ml/metrics-sync`, `ml/billing-probe`
- **Márgenes + cache**: `ml/margin-cache`, `ml/margin-cache/refresh`
- **Logística**: `ml/labels`, `ml/flex`

### 3.3 Otros dominios

| Dominio | Endpoints | Función |
|---|---|---|
| **MercadoPago** | `mp/sync`, `mp/sync-live`, `mp/request-report`, `mp/check-report`, `mp/cleanup-live` | Sync pagos/liquidaciones |
| **ProfitGuard** | `profitguard/sync` (cron 5min), `profitguard/orders` | Rentabilidad por orden |
| **Semáforo** | `semaforo/refresh` (cron lunes), `semaforo/current`, `semaforo/revisar`, `semaforo/cubeta/[nombre]`, `semaforo/historial/[sku]` | Alertas semanales |
| **Agents** | `agents/chat`, `agents/run`, `agents/cron` (diario 8), `agents/feedback`, `agents/rules`, `agents/status` | Sistema multi-agente (Anthropic) |
| **Admin** | `admin/costo-batch`, `admin/dedup-rcv-compras` | Utilidades admin masivas |
| **Orders** | `orders/query`, `orders/import`, `orders/backfill-from-ml`, `orders/stats`, `orders/sku-velocity` | Consultas/imports órdenes |
| **Recepciones** | `recepciones/recalcular-discrepancias` | Recalcular discrepancias costo/qty |
| **Picking** | `picking/scan-errors` | Reporte de errores de escaneo |
| **SII** | `sii/rcv`, `sii/sync`, `sii/sync-anual`, `sii/bhe`, `sii/bhe-rec`, `sii/export` | Integración SII Chile |
| **Proveedor catálogo** | `proveedor-catalogo/faltantes`, `.../bulk-update`, `.../import-template` | Gestión precios proveedor |
| **Costos** | `costos/traza` | Trazabilidad de costo por SKU |
| **Reclasificar stock** | `reclasificar-stock` | Cambio de SKU origen |
| **Diagnóstico** | `diagnostico-recepcion` | Deep-dive recepción por folio |
| **Sheet** | `sheet/update-cost` | Sync costos Google Sheet |
| **Debug (dev)** | `debug/composicion`, `debug-fix`, `debug-query` | Herramientas manuales |

---

## 4. UI y rutas

### 4.1 Páginas activas

| Ruta | LOC | Componente | Qué permite |
|---|---|---|---|
| `/` | 24 | `Home` | Selector Operador/Administrador |
| `/operador` | 971 | `OperadorPage` | PWA móvil (max-width 480px): Picking, Recepciones, Conteos, Facturas |
| `/admin` | **11.269** | `AdminPage` | Panel monolítico, 13 tabs: Dashboard, Recepciones, Picking, Pedidos ML, Etiquetas, Conteos, Operaciones, Inventario, Movimientos, Productos, Posiciones, Carga Stock, Config |
| `/admin/mapa` | 114 | `MapaOperador` | Editor visual del mapa de bodega |
| `/admin/qr-codes` | — | tab | Generador/impresión QR de posiciones |
| `/conciliacion` | 2.743 | `DashboardConciliacion` (dynamic import) | Conciliación bancaria: RCV ↔ movimientos banco |
| `/mapa` | — | alias público | Acceso directo al mapa |

Auth: `/admin` usa PIN `1234` hardcodeado + `sessionStorage.banva_admin_auth`. `/operador` es acceso libre (identifica por nombre de operario).

### 4.2 Componentes destacados (`src/components/*.tsx`)

| Componente | LOC | Rol |
|---|---|---|
| `AdminInteligencia.tsx` | **3.315** | Motor UI: tabs `origen / envio / pedido / proveedor-agotado / notas / pendientes` |
| `AdminReposicion.tsx` | 2.914 | Lead times, safety stock, ramp-up; interfaz proveedores |
| `AdminComercial.tsx` | 2.514 | Márgenes, promociones, eventos de liquidación |
| `AdminCompras.tsx` | 1.255 | OCs, proveedores, carga de catálogo |
| `AdminMargenes.tsx` | 1.154 | Simulador precios ↔ márgenes |
| `AdminAgentes.tsx` | 1.136 | Config agentes IA |
| `ConciliacionSplitView.tsx` | 1.134 | Split view conciliación |
| `ConciliacionTabla.tsx` | 1.127 | Tabla reconciliación |
| `AdminVentasML.tsx` | 959 | ML Directo (búsqueda, envíos, logística) |
| `AdminMLSinVincular.tsx` | — | Matching items ML ↔ SKU WMS |

Patrón general: `"use client"` por defecto, inline styles masivos, sin component library, sin tests. Refresh con `setTick` y polling cada 10s.

---

## 5. Integraciones externas

### 5.1 App Etiquetas (factura → recepción)

App web externa (fuera de este repo) que:
1. Usuario sube foto/PDF de factura al móvil.
2. Gemini Vision parsea folio, proveedor, líneas.
3. **Escribe directo a Supabase** tablas `recepciones` + `recepcion_lineas` + `rcv_compras` (usa misma anon key).
4. Operador en `/operador/recepciones` encuentra la recepción lista para cotejar y ubicar en bodega.

**Estado:** es la **única fuente de recepciones en producción**. De 66 recepciones totales, **100% tienen `orden_compra_id = NULL`** (entran huérfanas). El módulo de OCs formal prácticamente no se usa (sólo 4 OCs en DB, todas `ANULADA`).

**Gap conocido:** sin auto-match factura → OC (se trata aparte en §7).

### 5.2 MercadoLibre

- **OAuth**: `ml_config` (singleton). Auto-refresh en `getValidToken()`.
- **Webhooks recibidos** (POST `/api/ml/webhook`): `orders_v2`, `shipments`, `claims`, `stock-locations`, `fbm_stock_operations`, `items`, `marketplace_fbm_stock`.
- **Endpoints consumidos**: `/orders/{id}`, `/shipments/{id}[/items]`, `/packs/{id}`, `/user-products/{id}/stock[/type/{T}]` (PUT con `x-version` optimistic locking), `/users/{seller_id}/items/search`, `/seller-promotions/items/{id}`, `/items/{id}`, `/categories/{id}/attributes`, `/marketplace/billing/*`.
- **Stock distribuido**:
  - `selling_address` (Flex) → push cada 1 min desde WMS.
  - `meli_facility` (Full) → lectura cada 30 min a `stock_full_cache` + webhook `stock-locations` en vivo + health endpoint (drift cache vs live).
- **Rate limits actuales**: billing-probe respeta 5 req/min (últimas correcciones en commits `a29440d`, `b924389`). Stock sync usa retry on 409 una vez.

### 5.3 Supabase

- Proyecto: **qaircihuiafgnnrwcjls** (región us-east-1).
- Buckets: `banva` (único activo).
- RLS: **habilitado en todas las tablas** con políticas permisivas (`USING(true)/WITH CHECK(true)`). La anon key es la superficie de ataque real.
- Sin Supabase Auth; cliente WMS + app Etiquetas usan la misma anon key.

### 5.4 Vercel

- Proyecto único con deploys desde `main`.
- Crons: ver §2.3 (16 crons activos).
- **Variables de entorno críticas**: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`, `ML_SYNC_SECRET`, `ANTHROPIC_API_KEY`, `MP_ACCESS_TOKEN`, `PROFITGUARD_API_KEY`, `SII_SERVER_URL`, `SII_API_KEY`, `GOOGLE_SHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `AGENTS_CRON_SECRET`, `NEXT_PUBLIC_TEST_MODE`.
- `vercel.json` declara `maxDuration` explícito en rutas pesadas (`admin/costo-batch`: 120s, `profitguard/orders`: 300s).

### 5.5 Otras

- **MercadoPago**: `MP_ACCESS_TOKEN` env; endpoints `/v1/transactions`, `/v1/reports`.
- **SII Chile**: servidor railway.app externo (`SII_SERVER_URL` + `SII_API_KEY`) que hace el scraping y responde JSON.
- **Google Sheets**: service account lee "Diccionario" (`GOOGLE_SHEET_ID`), col `GOOGLE_COST_COLUMN` (default N).
- **Anthropic (Claude API)**: `ANTHROPIC_API_KEY`; endpoints `agents/chat`, `agents/run`, `agents/cron`.

---

## 6. Estado del negocio (data actual)

Snapshot al **2026-04-16** (último recálculo del motor: **2026-04-17 01:52 UTC**, cron diario 11 UTC).

### 6.1 Catálogo

| Métrica | Valor |
|---|---|
| Total SKUs en `sku_intelligence` | **533** |
| SKUs en `productos` (maestro) | 431 |
| Composiciones venta | 419 |
| **Cuadrantes** | |
| — ESTRELLA | 74 (13.9%) |
| — CASHCOW | 11 (2.1%) |
| — VOLUMEN | 11 (2.1%) |
| — REVISAR | 437 (82.0%) |
| **Clase ABC (margen)** | |
| — A | 85 (16.0%) |
| — B | 69 (13.0%) |
| — C | 379 (71.1%) |

### 6.2 Salud de stock

| Métrica | Valor |
|---|---|
| SKUs OOS (`stock_total=0`) | **190** (35.6%) |
| SKUs dead stock (>180d sin movimiento + stock>0) | 343 (64.4%) |
| SKUs zero-velocity (`vel_ponderada=0` + `stock>0`) | 78 |
| Unidades inmovilizadas (∑ stock_total) | **6.235** |
| Valor caja inmovilizada (∑ `costo_inventario_total`) | **$61.011.260 CLP** |

### 6.3 Órdenes de compra

| Estado | Cantidad |
|---|---|
| BORRADOR | 0 |
| PENDIENTE | 0 |
| EN_TRANSITO | 0 |
| RECIBIDA_PARCIAL | 0 |
| RECIBIDA | 0 |
| CERRADA | 0 |
| ANULADA | **4** |
| **Total OCs** | **4** |

**Conclusión:** el módulo de OCs formal está **inactivo** en producción. La compra y recepción operan vía app Etiquetas sin vincularse a una OC (ver §5.1). Monto en tránsito formal = **$0**.

### 6.4 Recepciones

| Métrica | Valor |
|---|---|
| Total recepciones | 66 |
| Recepciones últimos 30 días | **35** |
| Recepciones sin `orden_compra_id` | **66 (100%)** |
| Líneas de recepción | 735 |

### 6.5 Motor

| Métrica | Valor |
|---|---|
| Último recálculo (`max updated_at`) | 2026-04-17 01:52 UTC |
| SKUs con `factor_rampup_aplicado ≠ 1.0` | **49** |
| Snapshots diarios en `sku_intelligence_history` | 375 |
| Stock snapshots | 375 |

**Distribución de `accion`** (533 SKUs):

| Acción | N | % |
|---|---:|---:|
| INACTIVO | 149 | 28.0% |
| EXCESO | 121 | 22.7% |
| DEAD_STOCK | 71 | 13.3% |
| PLANIFICAR | 69 | 12.9% |
| OK | 65 | 12.2% |
| AGOTADO_PEDIR | 13 | 2.4% |
| EN_TRANSITO | 13 | 2.4% |
| MANDAR_FULL | 13 | 2.4% |
| AGOTADO_SIN_PROVEEDOR | 12 | 2.3% |
| URGENTE | 7 | 1.3% |
| NUEVO | 0 | — |

Urgentes reales (URGENTE + AGOTADO_*): **32 SKUs (6.0%)**.

---

## 7. Deuda técnica conocida

### 7.1 TODOs / FIXMEs detectados (grep en `src/`)

| Archivo:línea | Texto |
|---|---|
| `src/lib/intelligence.ts:1156` | `stock_sin_etiquetar: 0, // TODO: cuando se implemente etiquetado` |
| `src/app/api/semaforo/refresh/route.ts:125` | `// TODO: send Telegram alert` |

El grep adicional por `TODO|FIXME|XXX|HACK` devuelve mayormente comentarios `TODOS` (masivo, en castellano — "afecta a TODOS los SKUs"), no deuda real.

### 7.2 Sprints pendientes identificados

| Sprint | Descripción | Estado | Señal |
|---|---|---|---|
| **Forecast básico** (Holt-Winters / Croston) | Predicción de demanda más allá de promedio móvil | No existe | Motor usa SMA ponderado 50/30/20; no hay `forecast.ts` |
| **TSB para demanda intermitente** | Teunter-Syntetos-Babai para SKUs clase Z | No existe | No hay tratamiento diferencial para Z (sólo cv>1) |
| **Slow Moving automático** (Regla 90d) | Trigger auto-liquidación tras 90d sin venta | Parcial | Existe `liquidacion_accion` pero disparo es por `dio > target + 30/60/90d`, no por inactividad temporal |
| **EOQ / MOQ integrados** | Pedido óptimo considerando costo orden + holding | No existe | `moq` y `inner_pack` se respetan, pero no hay optimización EOQ |
| **Auto-match factura → OC** | Vincular recepciones huérfanas con OCs pendientes | **Bloqueante** | 66/66 recepciones sin `orden_compra_id`; OC prácticamente muerta |
| **Factura separada como 3° documento** | Separar "Nota recepción" (llegó) de "Factura SII" (doc contable) | No existe | Hoy se mezclan — una recepción es ambas cosas |
| **Tests del motor** | Suite de tests para `intelligence.ts` | **Cero** | Sólo 1 test en `src/lib/__tests__/reposicion.test.ts` |
| **Versionado de configuración** | Snapshot de `intel_config` por corrida | Parcial | `config_historial` existe pero no se usa desde el motor |
| **Medición forecast accuracy** (WMAPE / bias / tracking signal) | Comparar previsto vs realizado | No existe | No hay tabla de comparación ni backtest |
| **Cron automático incremental** | Re-calcular solo SKUs cambiados (no full) | No existe | Cron siempre corre `full=true&snapshot=true` |
| **Eliminar `pedidos_flex` legacy** | Migrar 100% a `ml_shipments` | Parcial | Ambos modelos coexisten |
| **Eliminar `update_stock` RPC legacy** | Forzar que todo pase por `registrar_movimiento_stock` | Pendiente | RPC aún existe y se llama desde reconciliación/transferencias |
| **Transacción en `/api/intelligence/recalcular`** | Los 3 upserts (intelligence, history, snapshots) no son atómicos | Pendiente | Si falla entre 1 y 2 → DB inconsistente |
| **Rate limiting en API routes** | Nada detecta abuso | Pendiente | Rule `security.md` lo marca explícitamente |
| **PIN admin hardcodeado** | `1234` en `src/app/admin/page.tsx` | Pendiente | Rule `security.md` lo marca |
| **PINs operarios en texto plano** | Sin hash en `operarios.pin` | Pendiente | Idem |
| **Webhook ML sin verificación de secret** | Campo existe pero no se valida | Pendiente | Idem |
| **Transición final webhooks Full** | Webhook `stock-locations` está en vivo pero en modo observación | En curso | Commits recientes (2026-04-16) |

### 7.3 Riesgos técnicos latentes

- **Sin transacciones** en upserts combinados → ver `banva-bodega-inteligencia.md` §14.
- **Race conditions suaves** entre `syncStockToML` (cada minuto) y flujos de picking/reserva.
- **`stock_sync_queue`** acumula pero no se purga automáticamente (54 rows acumuladas).
- **`ventas_ml_cache`** = 10 MB / 10.512 rows: no hay compactación ni particionamiento.
- **`audit_log`** = 10.214 rows; no hay retención configurada (crecerá indefinidamente).
- **`agent_runs`** = 15.367 rows / 6.4 MB; idem.
- **`ml_ads_daily_cache`** = 29.602 rows / 7.9 MB; idem.

---

## 8. Historial reciente de cambios

### 8.1 Últimos 10 PRs mergeados a `main`

Todos los merges del log están en **2026-03-19** (batch de trabajo). Después de eso, **commits directos a main** (regla del proyecto: "siempre trabajar en main").

| PR | Fecha merge | Rama origen | Qué cambió |
|---|---|---|---|
| #252 | 2026-03-19 | `claude/wms-intelligence-section-3DkRB` | Iteración final inteligencia |
| #251 | 2026-03-19 | idem | Iteración |
| #250 | 2026-03-19 | idem | Iteración |
| #249 | 2026-03-19 | idem | Iteración |
| #248 | 2026-03-19 | `claude/audit-mercadolibre-integration-Vvioa` | Audit integración ML |
| #247 | 2026-03-19 | `claude/wms-intelligence-section-3DkRB` | Iteración |
| #246 | 2026-03-19 | `claude/fix-wms-operator-bugs-lOLyR` | Fix bugs operador |
| #245 | 2026-03-19 | `claude/ml-stock-sync-eSnpf` | Stock sync ML |
| #244 | 2026-03-19 | idem | idem |
| #243 | 2026-03-19 | idem | idem |

Resto de historial reciente (commits directos, post merge window):

### 8.2 Últimos 10 commits directos a `main`

| Hash | Fecha | Mensaje | Archivos clave |
|---|---|---|---|
| `352e7a4` | 2026-04-16 | fix(ml/webhook): parsear formato real de stock-locations | `src/lib/ml.ts`, `src/app/api/ml/webhook/route.ts` |
| `99cff98` | 2026-04-16 | fix(ml/syncStockFull): no borrar stock cuando API distribuida falla | `src/lib/ml.ts` |
| `d2a04d6` | 2026-04-16 | feat(ml): billing-probe expone rows crudas cuando hay day filter | `src/app/api/ml/billing-probe/route.ts` |
| `9dc4006` | 2026-04-16 | feat(ml/stock-health): check de drift cache vs ML en vivo (opt-in) | `src/app/api/ml/stock-health/route.ts` |
| `9b6afff` | 2026-04-16 | fix(ml/webhook): nombres de topic reales | webhook route |
| `03e6a45` | 2026-04-16 | feat(ml): stock Full en vivo via webhooks + log + health endpoint | ml lib + webhook + health |
| `2b7c2f2` | 2026-04-16 | fix(ml): auto-crear productos y composicion_venta faltantes al sync ML | `src/lib/ml.ts` |
| `8a65ef7` | 2026-04-16 | feat(inteligencia): columna "Motor" junto a "Mandar" para ver el valor crudo | `AdminInteligencia.tsx` |
| `9c64010` | 2026-04-16 | feat(inteligencia): mostrar SKUs excluidos del envío a Full con razón | `AdminInteligencia.tsx` |
| `b924389` | 2026-04-16 | fix(ml): billing-probe retry con backoff en 429 | billing-probe |

**Tema dominante de las últimas 2 semanas:** telemetría y robustez de sync de stock Full (webhooks en vivo + health check de drift + retries en billing). En `inteligencia`, 2 mejoras de UX (columnas "Motor" y "excluidos del envío a Full").

**Serie previa (2026-04-xx) — PRs #261 a #264 relevantes para motor:**

- `#261` — Ramp-up post-quiebre + fix `dias_en_quiebre` corrupto (`src/lib/intelligence.ts`, `src/lib/rampup.ts`)
- `#262` — Protección ESTRELLA/CASHCOW en `enQuiebreProlongado`
- `#263` — `velPre_quiebre` usa `vel60d` histórica limpia
- `#264` — Docs lógica ramp-up + velPre histórica + protección cuadrante (`docs/banva-bodega-logica-rampup.md`)

---

**Generado:** 2026-04-16  
**Último commit revisado:** `352e7a4`  
**Complemento obligatorio:** `docs/banva-bodega-inteligencia.md` (dive profundo al motor).  
**Próxima regeneración:** cuando cambie el schema de `sku_intelligence`, se agreguen/retiren crons, o cambie `intelligence.ts`. Meta: trimestral o por inicio de sprint grande.
