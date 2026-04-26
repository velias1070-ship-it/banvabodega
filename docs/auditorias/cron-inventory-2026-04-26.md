# Inventario de crons BANVA Bodega

**Fecha snapshot**: 2026-04-26
**Origen**: investigación tras detectar patrón "gating zombi" en 3 casos consecutivos (`ml_velocidad_semanal`, `ml_campaigns_mensual`, `ml_snapshot_mensual`)
**Total crons activos**: 34 (22 Vercel + 12 droplet)

Punto de partida para futuras auditorías. **Mantenerlo actualizado** cuando se agregue/saque un cron.

---

## Vercel (22 crons en `vercel.json`)

| # | Path | Schedule | Frecuencia efectiva | Tabla(s) escribe | Tabla(s) lee | Telemetría `ml_sync_health` | Estado |
|---|---|---|---|---|---|---|---|
| 1 | `/api/ml/sync` | `* * * * *` | 1 min (sin gating) | pedidos_flex, ml_shipments, ml_shipment_items, audit_log | ml_items_map, ml_config | ❌ | 🔴 P1.2 telemetría pendiente |
| 2 | `/api/ml/stock-sync` | `* * * * *` | 1 min (sin gating) | stock_sync_queue, ml_items_map, audit_log | stock_sync_queue, ml_items_map, composicion_venta | ❌ | 🔴 P1.1 telemetría pendiente |
| 3 | `/api/profitguard/sync` | `*/5 * * * *` | 5 min | orders_history (vía `/api/orders/import`) | ProfitGuard externo | ❌ | 🔴 P1.4 telemetría pendiente |
| 4 | `/api/agents/cron` | `0 8 * * *` | 1×/día | agent_executions | agent_triggers | ❌ | 🟢 |
| 5 | `/api/ml/metrics-sync` | `0 */4 * * *` | cadencia-driven (post cutover 26-abr) | ml_sync_estado, ml_snapshot_mensual, ml_resumen_mensual | ml_items_map, ML API | ✅ | 🟢 |
| 6 | `/api/ml/ventas-reconcile` | `0 8 * * *` | 1×/día | ventas_ml_cache (estados) | ML API claims/orders | ❌ | 🔴 P1.6 telemetría pendiente |
| 7 | `/api/ml/items-sync` | `*/30 * * * *` | 30 min | ml_items_map | ML API + ml_items_map | ❌ | 🟡 telemetría futura |
| 8 | `/api/ml/attr-watch` | `0 */6 * * *` | 6 h | ml_item_attr_snapshot, ml_item_changes | ml_items_map, ML API | ❌ | 🟢 (informativo, baja criticidad) |
| 9 | `/api/semaforo/refresh` | `0 9 * * 1` | 1×/semana (lunes 9 UTC) | semaforo_estado, semaforo_historico | stock, composicion_venta, productos, ml_snapshot_mensual, orders_history | ❌ | 🟡 leía tabla gateada (cerrado en cutover 26-abr) |
| 10 | `/api/ml/ads-daily-sync` | `0 */6 * * *` | 6 h (post fix #15: cobertura 100% items activos) | ml_ads_daily_cache | ml_items_map, ML API | ✅ | 🟢 |
| 11 | `/api/ml/ads-rebalance` | `30 */6 * * *` | 6 h | ventas_ml_cache.ads_cost_asignado | ml_ads_daily_cache, ventas_ml_cache | ❌ | 🟡 telemetría futura |
| 12 | `/api/ml/margin-cache/refresh` | `*/2 * * * *` (?stale=true&limit=50) | 2 min | ml_margin_cache | ml_items_map, ML API | ❌ | 🟡 telemetría futura |
| 13 | `/api/intelligence/recalcular` | `0 11 * * *` (?full=true&snapshot=true) | 1×/día | sku_intelligence, sku_intelligence_history, stock_snapshots | stock, composicion_venta, productos, ml_items_map, ml_shipments, orders_history | ❌ | 🔴 P1.3 telemetría pendiente |
| 14 | `/api/ml/sync-stock-full` | `*/30 * * * *` | 30 min | stock_full_cache, ml_items_map | ML API fulfillment | ❌ | 🟡 telemetría futura |
| 15 | `/api/ml/ventas-sync` | `0 10 * * *` (?days=7) | 1×/día | ventas_ml_cache | ML API orders, productos, proveedor_catalogo, ml_items_map | ❌ | 🔴 P1.5 telemetría pendiente |
| 16 | `/api/intelligence/actualizar-lead-times` | `0 12 * * 1` | 1×/semana (lunes 12 UTC) | proveedores.lead_time_* | ordenes_compra, recepciones | ❌ | 🟢 (lento, no crítico) |
| 17 | `/api/intelligence/forecast-accuracy` | `30 12 * * 1` | 1×/semana (lunes 12:30 UTC) | forecast_accuracy | sku_intelligence, orders_history, stock_snapshots | ❌ | 🟢 (referencia) |
| 18 | `/api/ml/billing-cfwa-sync` | `0 13 * * *` | 1×/día | ml_billing_cfwa | ML API billing | ❌ | 🟡 verificar lectores (P2) |
| 19 | `/api/ml/activate-warehouse-all` | `15 * * * *` | 1/h | ml_items_map.ultimo_sync, stock_sync_queue | ml_items_map | ❌ | 🟢 |
| 20 | `/api/ml/campaigns-daily-sync` | `0 6 * * *` | 1×/día | ml_campaigns_daily_cache, ml_sync_health | ML API campaigns | ✅ | 🟢 |
| 21 | `/api/ml/sync-health-check` | `0 * * * *` | 1/h | ml_sync_health.is_alerting, notifications_outbox | ml_sync_health | n/a (es el monitor) | 🟢 |
| 22 | `/api/pricing/recalcular-floors` | `30 11 * * *` | 1×/día | auto_postulacion_log | productos, pricing_cuadrante_config | ❌ | ⚪ track pricing — coordinar con otra sesión |

---

## Droplet (12 crons en crontab + 3 one-shots)

Todos con gating horario en script TS por diseño operativo (no es bug).

| # | Comando | Schedule | Gating efectivo (Chile) | Output | Estado |
|---|---|---|---|---|---|
| 1 | `check-margenes.sh` | `*/30 * * * *` | 09:00-18:30 L-S → ~19/día | WA si margen < umbral | 🟢 |
| 2 | `reporte-flex.sh` | `1 * * * *` | 14:00-14:05 → 1/día | WA reporte picking Flex | 🟢 |
| 3 | `milestone-ventas.sh` | `*/15 * * * *` | 09:00-23:00 → ~56/día | WA si $2M/$2.5M/$3M/$3.5M | 🟢 |
| 4 | `cierre-diario.sh` | `1 * * * *` | 00:00-00:05 → 1/día | WA + INSERT cierre_diario | 🟢 |
| 5 | `resumen-margen-fuera-horario.sh` | `59 * * * *` | 08:59-09:04 → 1/día | WA resumen 18:30-09:00 previo | 🟢 |
| 6 | `audit-ml.sh` | `*/30 * * * *` | sin gating → 48/día | WA si SKUs sin mapping | 🟢 |
| 7 | `dormidos-tracker.sh` | `0 * * * *` | 19:00 Chile → 1/día | INSERT tracking_dormidos + WA | 🟢 |
| 8 | `watch-dormidos.sh` | `0 * * * *` | 19:00 Chile + end_date 2026-04-30 → 1/día | WA si SKU dormido >7d | 🟡 vence 30-abr |
| 9 | `flex-orphans.sh` | `0 * * * *` | 09:00 Chile → 1/día | WA si órdenes sin armado | 🟢 |
| 10 | `heartbeat.sh` | `0 * * * *` | domingo 09:00 → 1/semana | Log scripts corrieron recientemente | 🟢 |
| 11 | `viki-watchdog.sh` | `*/5 * * * *` | sin gating → 288/día | DM si Viki cuelga >15min | 🟢 |
| 12 | `notifications-outbox-poll.sh` | `* * * * *` | sin gating → 1440/día | Consume notifications_outbox, entrega WA | 🟢 |

**One-shots agendados**:
- `ads-pipeline-shadow-validation.sh` — 2026-05-05 09:00 Chile (validación Fase 3 PR ads-pipeline)
- `quarantine-velocidad-semanal-check.sh` — 2026-05-09 09:00 Chile (DROP go/no-go)
- `sync-phases-validation.sh` — 2026-04-26 (ya disparado, flag-protected)

---

## Patrón "gating zombi" — estado actual

**Definición**: cron con (1) gating temporal restrictivo, (2) escribiendo a tabla, (3) consumidores que la leen sin staleness check.

| Caso | Estado |
|---|---|
| `ml_velocidad_semanal` | ⚫ Quarantined v79 (2026-04-25), DROP planeado 2026-05-09 |
| `ml_campaigns_mensual` | ⚫ Reemplazado por `ml_campaigns_daily_cache` (Fase 1 PR ads-pipeline) |
| `ml_snapshot_mensual` | ✅ Cutover hoy (commit 2d7273f, `anyPhaseDue()` reemplaza gating día 1-3) |

**Casos pendientes**: 0. Todos los crons con gating temporal restrictivo ya fueron resueltos o no tienen consumidores que lean como fresh.

---

## Patrón "silent failure" — pendiente

13 crons sin telemetría a `ml_sync_health` → si fallan, nadie se entera. Sub-tasks creadas para los 6 críticos:

| Cron | Task | Threshold sugerido |
|---|---|---|
| `/api/ml/stock-sync` | P1.1 (#21) | 30 min |
| `/api/ml/sync` | P1.2 (#22) | 30 min |
| `/api/intelligence/recalcular` | P1.3 (#23) | 48 h |
| `/api/profitguard/sync` | P1.4 (#24) | 1 h |
| `/api/ml/ventas-sync` | P1.5 (#25) | 48 h |
| `/api/ml/ventas-reconcile` | P1.6 (#26) | 48 h |

Patrón a seguir: ver `src/app/api/ml/ads-daily-sync/route.ts` post-commit `fe2d649` (UPDATE ml_sync_health al final del try y en el catch).

---

## Probables huérfanos — pendiente investigar (P2)

| Tabla | Cron escritor | Lectores conocidos |
|---|---|---|
| `ml_item_attr_snapshot` | `/api/ml/attr-watch` | Ninguno encontrado en grep |
| `ml_item_changes` | `/api/ml/attr-watch` | Solo `/api/ml/attr-changes` (endpoint admin, probable bajo uso) |
| `ml_billing_cfwa` | `/api/ml/billing-cfwa-sync` | Ninguno encontrado, **verificar track pricing antes de proponer quarantine** |

---

## Cómo mantener este doc

- **Cada vez que se agregue/elimine un cron** en `vercel.json` o crontab del droplet, actualizar la tabla correspondiente.
- **Cada vez que se agregue telemetría** a un cron, marcar la columna `Telemetría ml_sync_health` como ✅.
- **Cada vez que se descubra un consumidor nuevo** de una tabla "huérfana", actualizar.
- Snapshot completo cada 6 meses o tras un sprint grande.
