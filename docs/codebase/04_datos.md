# Fase 4 — Capa de datos

> Fuente: 107 archivos `supabase*.sql` en la raíz + `grep` sobre `src/` para tablas y RPCs efectivamente usadas. Para detalles de invariantes y reglas: `.claude/rules/supabase.md`.

## 1. Migraciones (orden cronológico aproximado por número)

> Las migraciones se ejecutan **manualmente** en el SQL Editor de Supabase (no hay CLI). Los números colisionan en algunos casos (dos archivos `v15`, dos `v17`, etc.) — es una convención implícita de "subnúmero por feature paralela".

### Setup base (sin versión / v2–v6)
- `supabase-setup.sql` — bootstrap inicial.
- `supabase-v2-setup.sql` — [NEW] `operarios`, `productos`, `posiciones`, `stock`, `recepciones`, `recepcion_lineas`, `movimientos`, `mapa_config`.
- `supabase-v3-setup.sql` — [NEW] `composicion_venta`, `picking_sessions`, `conteos`, `ml_config`, `ml_items_map`, `pedidos_flex`.
- `supabase-v4-flex-stock.sql` — ALTER `ml_items_map` (`user_product_id`, `stock_version`).
- `supabase-v5-locks.sql` — ALTER `recepcion_lineas` (`bloqueado_por`, `bloqueado_hasta`).
- `supabase-v6-atomic-lock.sql` — [RPC] `bloquear_linea`, `desbloquear_linea`.

### Finanzas y conciliación (v7–v10)
- `supabase-v7-conciliacion.sql` — [NEW] `conciliaciones`, `movimientos_banco`, `cuentas_bancarias`.
- `supabase-v7-discrepancias-qty.sql` — [NEW] `discrepancias_qty`.
- `supabase-v8-finanzas.sql` — [NEW] `plan_cuentas`, `reglas_conciliacion`, `pasarelas_pago`.
- `supabase-v8-stock-sku-venta.sql` — ALTER `stock` (sku_venta).
- `supabase-v8b-feedback.sql` — [NEW] tabla feedback (agentes).
- `supabase-v9-banco-sync.sql` — [NEW] `sync_log`, `alertas`.
- `supabase-v9-fix.sql` — fixes correctivos.
- `supabase-v9-inner-pack.sql` — soporte de packs.
- `supabase-v9-simple.sql` — simplificación.
- `supabase-v9b-mp-liquidacion.sql` — liquidaciones MP.
- `supabase-v10-picking-tipo-titulo.sql` — campo de título en picking.
- `supabase-v10-reembolsos.sql` — ALTER `movimientos_banco` (reembolso).

### Agentes IA, OC, costos (v11–v14)
- `supabase-v11-agents.sql` — [NEW] `agent_config`, `agent_rules`, `agent_insights`, `agent_runs`, `agent_conversations`.
- `supabase-v12-orders-history.sql` — [NEW] `orders_history`, `orders_imports`.
- `supabase-v12-profitguard-cache.sql` — [NEW] `profitguard_cache`.
- `supabase-v13-fix-update-stock.sql` — [RPC] `update_stock` mejorado.
- `supabase-v14-agent-triggers.sql` — [NEW] `agent_triggers`.
- `supabase-v14-factura-original.sql` — ALTER `recepciones`.

### Inteligencia, ML maps, Flex (v15–v22)
- `supabase-v15-sku-intelligence.sql` — [NEW] `sku_intelligence` (núcleo del motor: velocidad, reposición, quiebre, ABC, forecast, estacionalidad).
- `supabase-v15-ventas-razon-social.sql` — campo razón social.
- `supabase-v16-stock-full-cache-columns.sql` — ALTER stock_full_cache.
- `supabase-v17-ml-stock-full.sql` — ALTER ml_items_map (`inventory_id`, columnas Full).
- `supabase-v17-quiebre-prolongado.sql` — ALTER `sku_intelligence` (quiebre).
- `supabase-v18-normalize-upper-skus.sql` — normaliza SKUs a mayúsculas.
- `supabase-v19-ml-items-map-sku-origen.sql` — ALTER ml_items_map (sku_origen).
- `supabase-v19-vel-objetivo.sql` — ALTER sku_intelligence + [NEW] `intel_config`.
- `supabase-v20-stock-full-cache-fuente.sql` — ALTER stock_full_cache (fuente).
- `supabase-v20-vel-objetivo-historial.sql` — [NEW] `vel_objetivo_historial`.
- `supabase-v21-envios-full-historial.sql` — [NEW] `envios_full_historial`, `envios_full_lineas`.
- `supabase-v22-composicion-alternativo.sql` — ALTER composicion_venta (alternativos).

### Picking, costos, audit, RPCs (v23–v34)
- `v23-notas-bultos`, `v24-proveedor-catalogo` (NEW `proveedor_catalogo`, `costos_historial`), `v25-stock-ml-cache`, `v26-ml-tables-formal` (NEW `ml_shipments`, `ml_shipment_items` — modelo shipment-centric), `v27-registrar-movimiento` ([RPC] `registrar_movimiento_stock`), `v28-costo-promedio` (ALTER productos), `v28-qty-reserved` (ALTER stock + RPCs `reservar_stock`/`liberar_reserva`), `v29-audit-log` (NEW `audit_log`), `v29-reconciliar-reservas` ([RPC]), `v30-calcular-qty-ubicada` ([RPC]), `v30-computed-reservas` ([RPC] `resolver_sku_fisico`), `v31-fix-reservas-cutoff`, `v31-stock-deducted`, `v32-fixes-operador`, `v32-reservas-include-full`, `v33-desglose-reservas` ([RPC]), `v33-qty-after-timeline`, `v33-shipment-costs-cache`, `v34-envio-full-pendiente` (NEW), `v34-shipment-hidden`, `v34-timeline-reserva-full`.

### Métricas ML, Ads, Margin Cache, Forecast (v35–v52)
- `v35-ml-metrics` — [NEW] `ml_ads_daily_cache`, `ml_campaigns_mensual`, `ml_velocidad_semanal`.
- `v36-auto-fill-costo`, `v36-ml-publicaciones` (ALTER ml_items_map: listing_id, status_ml).
- `v37-ventas-ml-cache` — [NEW] `ventas_ml_cache`.
- `v38-mov-banco-notas`, `v39-conciliacion-parcial`, `v39-proveedor-campos`.
- `v40-campaigns-mensual`, `v40-egreso-metadata`, `v40-item-attr-snapshot` ([NEW] `ml_item_attr_snapshot`).
- `v41-semaforo` — [NEW] `semaforo_config`, `semaforo_semanal`.
- `v42-proveedor-stock-null`, `v43-oportunidad-perdida-estimacion`.
- `v44-rcv-compras-dedup` — [NEW] `rcv_compras` con dedup.
- `v45-rcv-compras-factura-ref`, `v45-ventas-margen` ([NEW] `rcv_ventas`).
- `v46-ads-margen` — ALTER margen ads.
- `v47-ml-shipping-tariffs` — [NEW] `ml_shipping_tariffs`.
- `v48-ml-margin-cache` — [NEW] `ml_margin_cache`.

### Atomicidad picking, agentes IA, forecast (v49–v60)
- `v49-atomic-picking-update` — [RPC] `actualizar_linea_picking`, `agregar_linea_picking`.
- `v50-admin-atomic-picking` — [RPC] `eliminar_linea_picking`, `dividir_envio_full`.
- `v51-forecast-accuracy` — [NEW] `forecast_accuracy`.
- `v51-ml-billing-cfwa` — [NEW] `ml_billing_cfwa`.
- `v52-forecast-alerts` — alertas de forecast.
- `v53-tsb` — [NEW/ALTER] columnas para TSB (modelo de demanda).
- `v54-es-estacional`, `v55-dias-en-quiebre`, `v56-nullable-dias-sin-movimiento` — campos del motor de inteligencia.
- `v57-flex-objetivo`, `v58-deprecar-columna-zombi` — DEPRECA `ml_items_map.stock_full_cache`.
- `v59-drop-flex-objetivo` — [DROP].
- `v60-quiebre-flex` — flag flex en quiebre.

### Admin users, margin cache invalidate, semáforo (v61–v70)
- `v61-admin-users` — [NEW] `admin_users` (sistema de usuarios admin UI-level — ver memoria `project_banva_admin_users`).
- `v62-margin-cache-invalidate` — auto-invalidación de caché.
- `v63-margin-cache-promo-name`, `v64-semaforo-markdown`, `v64-ticket-promedio-rpc` ([RPC] `ticket_promedio_por_sku`).
- `v65-margin-cache-status-ml`, `v65-semaforo-intel-bridge` — bridge semáforo↔inteligencia.
- `v66-promos-postulables` — [NEW] `promos_postulables`.
- `v67-margin-cache-stock`, `v67-semaforo-por-item`, `v68-productos-pricing-policy`, `v68-semaforo-pk-sku-venta`, `v69-semaforo-proveedor`.
- `v70-auto-postulacion-log` — [NEW] `auto_postulacion_log`.

### Proveedor canónico y drops (v71–v74)
- `v71-transferir-stock-hereda-sku-venta` — [RPC] `transferir_stock`.
- `v72-proveedores-canonico` — [NEW] `proveedores` (RUT único parcial) + `proveedor_id` FK nullable en 5 tablas.
- `v73-drop-productos-sku-venta` — [DROP] `productos.sku_venta` (columna 100% vacía).
- `v74-drop-productos-codigo-ml` — [DROP] `productos.codigo_ml` (derivable vía composición + ml_items_map).

> Carpeta `supabase/archived/` y `supabase/pending-mov/` contienen helpers SQL fuera del flujo principal (limpieza de motivos, check de whitelist).

## 2. Tablas detectadas

> Combinación de migraciones + `grep -rohE 'sb\.from\("..."' src/`. Para cada tabla, agrupada por dominio.

### Core WMS
| Tabla | Propósito | Doc |
|---|---|---|
| `operarios` | Usuarios del operador, login con PIN. | supabase.md |
| `productos` | Diccionario maestro de SKUs. | supabase.md |
| `posiciones` | Ubicaciones físicas en bodega. | supabase.md |
| `stock` | Unique `(sku, posicion_id)`. Cantidades + `qty_reserved`. | supabase.md |
| `movimientos` | Log de entradas/salidas/transferencias (con costo). | supabase.md |
| `recepciones` | Cabecera de recepción de mercadería. | supabase.md |
| `recepcion_lineas` | Líneas de recepción con etapas (PENDIENTE/CONTADA/etiquetada/ubicada). | supabase.md |
| `mapa_config` | Config visual del mapa (singleton `id='main'`). | supabase.md |
| `composicion_venta` | Pack/combo: SKU venta → SKUs físicos (sku_origen). | supabase.md |
| `picking_sessions` | Sesiones de picking legacy (jsonb `lineas`). | supabase.md |
| `conteos` | Conteos cíclicos (jsonb `lineas`). | supabase.md |
| `picking_bultos`, `picking_bultos_lineas` | Bultos/bolsas del picking moderno. | TODO confirmar |
| `envios_full_historial`, `envios_full_lineas`, `envio_full_pendiente` | Envíos a Bodega Full. | parcialmente en docs |

### MercadoLibre
| Tabla | Propósito | Doc |
|---|---|---|
| `ml_config` | Singleton `id='main'`. Tokens OAuth + config. | supabase.md |
| `ml_items_map` | Mapping SKU ↔ item ML. Tiene `user_product_id`, `stock_version`, `inventory_id`, `sku_venta`, `sku_origen`, `listing_id`, `status_ml`. **`stock_full_cache` columna deprecada en v58** (regla 5 — ver inventory-policy). | supabase.md |
| `ml_shipments`, `ml_shipment_items` | Modelo shipment-centric (status, substatus, logistic_type, handling_limit). | supabase.md / meli-api.md |
| `pedidos_flex` | Legacy: 1 fila por order+sku_venta. **Convive con shipment-centric** — migración pendiente. | supabase.md |
| `stock_full_cache` | Caché stock Full por SKU (canónico). | supabase.md |
| `stock_sync_queue` | PK `sku`. Cola de SKUs para push a ML. | supabase.md |
| `ml_webhook_log` | Auditoría webhooks ML (dedup + detección desconexión). | TODO confirmar |
| `ml_item_attr_snapshot`, `ml_item_changes` | Detección de cambios atributos. | TODO |
| `ml_ads_daily_cache`, `ml_campaigns_mensual`, `ml_velocidad_semanal` | Métricas ML. | TODO |
| `ml_margin_cache` | Caché margen por ítem (refresh cron). | TODO |
| `ml_shipping_tariffs` | Tarifas envío ML. | TODO |
| `ml_billing_cfwa` | Facturación ML CFWA. | TODO |
| `shipment_costs_cache` | Caché costos de envío. | TODO |
| `ventas_ml_cache` | Caché de ventas para reportes. | TODO |
| `auto_postulacion_log` | Log de auto-postulaciones a promos. | TODO |
| `promos_postulables` | Promos disponibles. | TODO |

### Inteligencia
| Tabla | Propósito | Doc |
|---|---|---|
| `sku_intelligence` | Núcleo motor: velocidad, gap, cobertura, ABC, forecast, estacionalidad, días en quiebre. | docs/banva-bodega-inteligencia.md |
| `sku_intelligence_history` | Historial. | TODO |
| `intel_config` | Configuración del motor. | TODO |
| `vel_objetivo_historial` | Cambios de velocidad objetivo. | TODO |
| `forecast_accuracy`, `forecast_snapshots` | Accuracy del forecast en ventanas. | TODO |
| `eventos_demanda` | Picos/eventos. | TODO confirmar |
| `sku_revision_log` | Log de revisiones por SKU. | TODO |

### Proveedor / compras
| Tabla | Propósito | Doc |
|---|---|---|
| `proveedores` | Canónico (v72). PK `id` uuid, UNIQUE parcial RUT, `nombre_canonico`, `aliases[]`. | supabase.md |
| `proveedor_catalogo` | Lista de precios por proveedor (N:N SKU↔Proveedor con `precio_neto`). | supabase.md |
| `proveedor_cuenta` | Cuentas bancarias del proveedor. | TODO |
| `ordenes_compra`, `ordenes_compra_lineas` | OCs. | TODO |
| `costos_historial` | Historial costos por SKU. | TODO |
| `rcv_compras`, `rcv_ventas` | Registro de Compras / Ventas SII. | parcialmente en docs |

### Finanzas
| Tabla | Propósito | Doc |
|---|---|---|
| `conciliaciones`, `conciliacion_items` | Cabecera y líneas de conciliación. | TODO |
| `movimientos_banco` | Movimientos bancarios. | TODO |
| `cuentas_bancarias` | Cuentas. | TODO |
| `plan_cuentas` | Plan contable. | TODO |
| `reglas_conciliacion` | Reglas automáticas. | TODO |
| `pasarelas_pago` | Pasarelas (MP, transferencia, etc.). | TODO |
| `mp_liquidacion_detalle` | Detalle liquidaciones MP. | TODO |
| `discrepancias_qty`, `discrepancias_costo` | Discrepancias detectadas. | TODO |
| `periodos_conciliacion` | Períodos. | TODO confirmar |
| `empresas` | Empresas vinculadas. | TODO confirmar |

### Auditoría
| Tabla | Propósito | Doc |
|---|---|---|
| `audit_log` | Log atómico (v29). | supabase.md |
| `admin_actions_log` | Acciones admin. | TODO |
| `stock_snapshots` | Snapshots de stock para forecast. | TODO confirmar |

### Agentes IA
| Tabla | Propósito | Doc |
|---|---|---|
| `agent_config`, `agent_rules`, `agent_insights`, `agent_runs`, `agent_conversations`, `agent_triggers` | Sistema multi-agente. | parcialmente en docs |
| `agent_data_snapshots` | Snapshots para feed de agentes. | TODO confirmar |

### Otros
| Tabla | Propósito | Doc |
|---|---|---|
| `admin_users` | Usuarios admin (v61), UI-level only sin RLS. | memoria `project_banva_admin_users` |
| `semaforo_config`, `semaforo_semanal` | Sistema de alertas semáforo. | TODO |
| `wms_state` | Estado global WMS. | TODO confirmar |
| `alertas` | Alertas finanzas. | TODO confirmar |

> **Discrepancias**: el subagente menciona vistas `v_stock_disponible`, `v_stock_proyectado`, `v_timeline_sku`. No verificadas con grep. **TODO**: confirmar con SQL real (queries abajo).

## 3. RPCs Supabase (verificadas con `grep '\.rpc("')`

17 RPCs invocadas desde el código:

| RPC | Migración | Uso inferido |
|---|---|---|
| `actualizar_linea_picking` | v49 | Update atómico de línea de picking. |
| `agregar_linea_picking` | v49 | Agrega línea atómicamente. |
| `bloquear_linea` | v6 | Lock de línea de recepción (TTL 15 min). |
| `calcular_qty_ubicada` | v30 | Total ubicado para una recepción. |
| `desbloquear_linea` | v6 | Libera lock. |
| `desglose_reservas` | v33 | Reservas Flex vs Full. |
| `dividir_envio_full` | v50 | Split de envío Full en dos. |
| `eliminar_linea_picking` | v50 | Delete admin. |
| `exec_sql` | TODO migración | **Ejecuta SQL dinámico**. Usado en `ml/audit-mappings`. **Riesgo de SQL injection si los argumentos no se sanitizan**. |
| `increment_rule_usage` | TODO | Contador de uso de reglas IA. |
| `liberar_reserva` | v28 | Libera reserva si se cancela. |
| `reconciliar_reservas` | v29 | Recalcula reservas vs realidad. |
| `registrar_movimiento_stock` | v27 | **Único punto autorizado de cambio de stock** (memoria `feedback_movimientos_stock`). |
| `reservar_stock` | v28 | Crea reserva. |
| `ticket_promedio_por_sku` | v64 | Ticket promedio histórico. |
| `transferir_stock` | v71 | Transferencia entre `sku_origen` y `sku_venta`. |
| `update_stock` | v13 | RPC legacy de update — preferir `registrar_movimiento_stock`. |

## 4. Storage buckets

Único bucket detectado: **`banva`**

- Path observado: `facturas/{folio}_{ts}.jpg` (subido por App Etiquetas).
- Otros usos (etiquetas PDF, exports) — TODO: confirmar al revisar `src/app/admin/page.tsx`.
- Política: TODO confirmar (no detectado en migrations grep, posiblemente configurado vía Supabase UI).

## 5. RLS policies

Patrón general detectado en migrations: **todas permisivas**.

```sql
ALTER TABLE <tabla> ENABLE ROW LEVEL SECURITY;
CREATE POLICY "<tabla>_all" ON <tabla> FOR ALL USING (true) WITH CHECK (true);
```

Razones documentadas (`.claude/rules/security.md`):
1. No hay Supabase Auth.
2. La app usa anon key directamente.
3. Seguridad delegada a no-exposición pública de la anon key + PIN admin client-side.

> **No se detectaron policies restrictivas** ni con `auth.uid()`. Cualquier usuario con la anon key tiene acceso total de lectura/escritura a TODAS las tablas. Esto es **deuda crítica** documentada en Fase 8.

## 6. Queries SQL recomendadas para auditar el estado real (NO ejecutar)

Para reconciliar el código contra el DB real, correr en Supabase SQL Editor:

```sql
-- Inventario de tablas
SELECT table_name, table_type
FROM information_schema.tables
WHERE table_schema = 'public'
ORDER BY table_name;

-- Columnas
SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
ORDER BY table_name, ordinal_position;

-- Foreign keys
SELECT tc.table_name AS from_table, kcu.column_name AS from_col,
       ccu.table_name AS to_table, ccu.column_name AS to_col, tc.constraint_name
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu USING (constraint_name)
JOIN information_schema.constraint_column_usage ccu USING (constraint_name)
WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public';

-- Indices
SELECT schemaname, tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
ORDER BY tablename, indexname;

-- Vistas
SELECT table_name, view_definition
FROM information_schema.views
WHERE table_schema = 'public';

-- Funciones (RPCs)
SELECT routine_name, routine_type, data_type
FROM information_schema.routines
WHERE specific_schema = 'public'
ORDER BY routine_name;

-- Tamaño de tablas
SELECT relname AS table, pg_size_pretty(pg_total_relation_size(relid)) AS size
FROM pg_catalog.pg_statio_user_tables
ORDER BY pg_total_relation_size(relid) DESC LIMIT 30;

-- RLS status por tabla
SELECT relname AS table, relrowsecurity AS rls_enabled
FROM pg_class
WHERE relkind='r' AND relnamespace = 'public'::regnamespace
ORDER BY relname;

-- Policies activas
SELECT schemaname, tablename, policyname, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname='public'
ORDER BY tablename, policyname;

-- Tabla con más filas (sample)
SELECT relname, n_live_tup
FROM pg_stat_user_tables
WHERE schemaname='public'
ORDER BY n_live_tup DESC LIMIT 30;
```

## 7. Hallazgos

1. **`exec_sql` RPC** existe y se usa desde un endpoint del repo (`ml/audit-mappings`). Ejecuta SQL dinámico — alto riesgo si la entrada no se controla. Ver Fase 8.
2. **Duplicación canónica/zombi**: `stock_full_cache` (tabla) vs `ml_items_map.stock_full_cache` (columna). La columna está deprecada (v58), pero todavía existe físicamente. Regla 5 de `inventory-policy.md`.
3. **Modelo dual de pedidos Flex**: `pedidos_flex` (legacy) y `ml_shipments + ml_shipment_items` (nuevo) coexisten. Migración pendiente.
4. **Centinelas numéricos**: la regla 1 de inventory-policy menciona `cob_full = 999` aún vigente en `intelligence.ts`. Es deuda controlada (con doble comparación), no bug activo.
5. **RLS efectivamente desactivado**: aunque está habilitado, las policies son `USING (true)`. Equivalente a no tener RLS.
6. **Service role key**: usada en `/api/ml/setup-tables` y `scripts/debug-shipping.mjs`. Inconsistente con el resto del código.
