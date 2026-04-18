# BANVA Bodega — Módulo Inteligencia (fuente de verdad)

Documento técnico del motor `intelligence.ts` + UI + schema + integraciones al **2026-04-16** (commit `352e7a4`). Reemplaza al viejo `AdminInteligencia.txt`.

## Tabla de contenidos

1. [Arquitectura de 3 capas](#1-arquitectura-de-3-capas)
2. [Motor `recalcularTodo()`](#2-motor-recalculartodo)
3. [Schema `sku_intelligence`](#3-schema-sku_intelligence)
4. [Endpoints `/api/intelligence/*`](#4-endpoints-apiintelligence)
5. [UI `AdminInteligencia.tsx`](#5-ui-admininteligenciatsx)
6. [Tipos de alerta](#6-tipos-de-alerta)
7. [Acciones y prioridades](#7-acciones-y-prioridades)
8. [Fórmulas matemáticas clave](#8-fórmulas-matemáticas-clave)
9. [Flujos de datos críticos](#9-flujos-de-datos-críticos)
10. [Jobs / crons](#10-jobs--crons)
11. [Integraciones externas](#11-integraciones-externas)
12. [Gaps conocidos](#12-gaps-conocidos)
13. [Cambios recientes relevantes](#13-cambios-recientes-relevantes)
14. [Riesgos técnicos identificados](#14-riesgos-técnicos-identificados)
15. [Metadata](#metadata)

---

## 1. Arquitectura de 3 capas

```
┌───────────────────────────────────────────────────────────────────────────┐
│  UI  (client, React 18 + Next 14 App Router)                              │
│                                                                           │
│   src/components/AdminInteligencia.tsx                3 315 LOC           │
│     tabs: origen · envio · pedido · proveedor-agotado · notas · pendientes│
│   src/components/AdminReposicion.tsx                  2 914 LOC           │
│   src/components/AdminComercial.tsx                   2 514 LOC           │
│   src/components/AdminMLSinVincular.tsx                 ~600 LOC          │
│                                                                           │
│   Renderizado desde src/app/admin/page.tsx (tab "Intel")  11 269 LOC      │
│                                                                           │
│                               │ fetch                                     │
│                               ▼                                           │
├───────────────────────────────────────────────────────────────────────────┤
│  API  (server, route handlers /api/intelligence/*)                        │
│                                                                           │
│   recalcular/route.ts                   485 LOC   GET/POST (cron + botón) │
│   sku-venta/route.ts                    419 LOC   GET                     │
│   vista-venta/route.ts                  287 LOC   GET                     │
│   pendientes/route.ts                   192 LOC   GET                     │
│   sku/[sku_origen]/route.ts              79 LOC   PATCH                   │
│   sku/_bulk/route.ts                    111 LOC   POST                    │
│   envio-full-log/route.ts                95 LOC   POST                    │
│   actualizar-lead-times/route.ts         60 LOC   GET (cron lunes)        │
│                                                                           │
│                               │ invoke                                    │
│                               ▼                                           │
├───────────────────────────────────────────────────────────────────────────┤
│  LIB  (pure + Supabase accessors)                                         │
│                                                                           │
│   src/lib/intelligence.ts         1 766 LOC   Motor puro recalcularTodo() │
│   src/lib/intelligence-queries.ts   635 LOC   Queries + helpers read-side │
│   src/lib/reposicion.ts             199 LOC   Reposición + LT resolver   │
│   src/lib/rampup.ts                  41 LOC   Matriz factor ramp-up       │
│   src/lib/store.ts                3 446 LOC   Bridge UI/DB (composiciones)│
│   src/lib/db.ts                   3 082 LOC   CRUD Supabase + RPCs        │
│   src/lib/ml.ts                   2 535 LOC   Integración ML (server only)│
│                                                                           │
│                               │ SQL / RPC                                 │
│                               ▼                                           │
├───────────────────────────────────────────────────────────────────────────┤
│  DB  (Supabase / PostgreSQL — schema public, 87 tablas)                   │
│                                                                           │
│   sku_intelligence         (118 cols · 533 rows · 1.6 MB)                 │
│   sku_intelligence_history ( 33 cols · 375 rows · 400 KB)                 │
│   stock_snapshots          (  9 cols · 375 rows · 280 KB)                 │
│   productos · composicion_venta · stock · movimientos · ordenes_compra*  │
│   ventas_ml_cache · ml_items_map · stock_full_cache · proveedor_catalogo  │
│   eventos_demanda · intel_config · vel_objetivo_historial                 │
└───────────────────────────────────────────────────────────────────────────┘
```

El motor `intelligence.ts` es **función pura**: lee mediante accessors de `db.ts`/`intelligence-queries.ts`, calcula, y devuelve arrays. La **persistencia** (upserts a `sku_intelligence`, `sku_intelligence_history`, `stock_snapshots`) la hace el endpoint `/api/intelligence/recalcular` tras recibir el resultado.

---

## 2. Motor `recalcularTodo()`

Ubicación: `src/lib/intelligence.ts:733-1355` (loop por SKU) + `1365-1766` (pasos globales + snapshots).

El motor tiene **13 pasos por SKU + 6 pasos globales = 19 pasos lógicos**. Confirma el nombre histórico "19 pasos" aunque la arquitectura cambió (pasos ABC/Cuadrante/Alertas se hacen _después_ del loop, no dentro).

### 2.1 Pasos por SKU (loop principal)

| # | Nombre | Qué hace (1 línea) | Inputs clave | Outputs en `sku_intelligence` | Ruta:línea |
|---|---|---|---|---|---|
| 1 | Identidad + costo + proveedor | Resuelve nombre/categoría/proveedor y costo en cascada; inner_pack y stock proveedor | `productos`, `proveedor_catalogo` | `sku_origen, nombre, categoria, proveedor, costo_neto, costo_bruto, costo_fuente, stock_proveedor, tiene_stock_prov, inner_pack` | `intelligence.ts:768-847` |
| 2 | Demanda física (vel 7/30/60d + canal) | Expande órdenes a físico por composición; excluye semanas en quiebre ≥3d; separa Full/Flex | `ventas_ml_cache`, `composicion_venta`, `stock_snapshots` | `vel_7d, vel_30d, vel_60d, vel_ponderada, vel_full, vel_flex, pct_full, pct_flex, margen_full_{7,30,60}d, margen_flex_{7,30,60}d, precio_promedio, ingreso_30d` | `intelligence.ts:848-960` |
| 3 | Tendencia + pico | `es_pico = vel_7d > vel_30d × 1.5`; tendencia con banda ±15% | vel_7d, vel_30d | `tendencia_vel, tendencia_vel_pct, es_pico, pico_magnitud` | `intelligence.ts:961-968` |
| 4 | Eventos de demanda | Multiplica vel si hay evento activo para la categoría | `eventos_demanda` | `multiplicador_evento, evento_activo, vel_ajustada_evento` | `intelligence.ts:969-980` |
| 5 | Stock agregado | Suma bodega principal + alternativos; Full físico; tránsito desde OC + envíos Full | `stock`, `stock_full_cache`, `ordenes_compra_lineas`, `envio_full_pendiente` | `stock_full, stock_bodega, stock_total, stock_en_transito, stock_proyectado, oc_pendientes` | `intelligence.ts:981-1009` |
| 6 | Cobertura | `(stock / velSemanal) × 7`; 999 si vel≤0 | stock, vel | `cob_full, cob_flex, cob_total` | `intelligence.ts:1010-1019` |
| 7 | Margen por canal + split | Decide 70/30 si flex > full × 1.1, si no 80/20 | `financials` | `canal_mas_rentable, pct_full, pct_flex, margen_tendencia_full, margen_tendencia_flex` | `intelligence.ts:1020-1061` |
| 8 | Target cobertura por ABC (placeholder) | Se calcula global; aquí sólo reserva el campo | `intel_config`, `abc` (pre-loop si existía) | `target_dias_full` (provisional) | `intelligence.ts:1062-1068` |
| 10 | XYZ + dedupe alternativas | CV semanal (sin quiebres); si grupo alternativo ya cubierto → no pedir | ventas_semana_activas | `cv, xyz, desviacion_std, pedir_proveedor` (ajustado) | `intelligence.ts:1069-1086` |
| 10c | Ramp-up post-quiebre | Aplica factor multiplicador a `pedir_proveedor` según dias_en_quiebre y quiebre_propio/proveedor | `rampup.ts::calcularFactorRampup` | `factor_rampup_aplicado, rampup_motivo, pedir_proveedor_sin_rampup, pedir_proveedor` (reducido) | `intelligence.ts:1507-1524` (aplicación) · `rampup.ts:1-41` (matriz) |
| 12 | Safety stock + ROP | Fórmula completa con σ_LT; cascada LT: `oc_real(≥3) > manual_proveedor > manual_producto > fallback_5d` | σ_D, LT, σ_LT, Z(servicio) | `safety_stock_simple, safety_stock_completo, safety_stock_fuente, lead_time_usado_dias, lead_time_fuente, lt_muestras, rop_calculado, necesita_pedir, nivel_servicio` | `intelligence.ts:1526-1576` (+ `reposicion.ts` para `resolverLeadTime`) |
| 13 | Indicadores financieros | GMROI anualizado + DIO | margen, vel, costo, stock | `gmroi, dio, costo_inventario_total` | `intelligence.ts:1087-1093` |
| 14 | Quiebre prolongado + oportunidad perdida | Detecta primer snapshot en quiebre; preserva vel_pre y margen_unitario_pre; imputa `venta_perdida_*` + flag de estimación | `stock_snapshots`, prev `sku_intelligence` | `dias_sin_stock_full, semanas_con_quiebre, vel_pre_quiebre, margen_unitario_pre_quiebre, dias_en_quiebre, es_quiebre_proveedor, abc_pre_quiebre, venta_perdida_uds, venta_perdida_pesos, ingreso_perdido, oportunidad_perdida_es_estimacion, gmroi_potencial, es_catch_up` | `intelligence.ts:1094-1310` |
| 15 | Acción + prioridad | Árbol de decisión secuencial; 11 acciones posibles; ajusta prioridad por ABC (−5 si A, +5 si C) | velocidades, stocks, cobertura, quiebres | `accion, prioridad, mandar_full, pedir_proveedor` | `intelligence.ts:1311-1355` |
| 16 | Ajuste de precio | Flag si vel≥5 con margen<0 o vel≥10 con margen<5% precio | vel, margen, precio | `requiere_ajuste_precio` | `intelligence.ts:1356-1359` |
| 18 | Operación (conteos + movimientos) | Último conteo/movimiento y días sin cada uno | `conteos`, `movimientos` | `ultimo_conteo, dias_sin_conteo, diferencias_conteo, ultimo_movimiento, dias_sin_movimiento` | `intelligence.ts:1360-1369` |

### 2.2 Pasos globales (después del loop por SKU)

| # | Nombre | Qué hace | Outputs |
|---|---|---|---|
| 9 | ABC 3 ejes (Pareto) | Orden DESC por métrica; A≤80%, B≤95%, C>95%. Imputa métricas para SKUs en quiebre prolongado usando `vel_pre_quiebre × margen_unitario_pre × 4.3` | `abc_margen, abc_ingreso, abc_unidades, abc` (alias margen), `pct_margen_acumulado, pct_ingreso_acumulado, pct_unidades_acumulado` — `intelligence.ts:1366-1437` |
| 11 | Cuadrante (matriz fija) | `abc_margen × abc_unidades` → ESTRELLA / CASHCOW / VOLUMEN / REVISAR | `cuadrante` — `intelligence.ts:1445-1455` |
| — | **Recalc `mandar_full` + `pedir_proveedor` con targets ABC** | `target_dias_full` por ABC, `demanda_ciclo = vel × target/7`, `pedir = ceil(demanda_ciclo + SS_completo - stock_total)`; redondeo a `inner_pack` → `pedir_proveedor_bultos` | `mandar_full, pedir_proveedor, pedir_proveedor_bultos, cob_full` (recalc) — `intelligence.ts:1439-1476` |
| 17 | Protocolo de liquidación | Si `abc='C'` o `cuadrante='REVISAR'` y `margen>0`: `diasExtra=dio-target`; >90d `precio_costo` (40%); >60d `liquidar_activa` (25%); >30d `dcto_10` (10%) | `liquidacion_accion, liquidacion_dias_extra, liquidacion_descuento_sugerido` — `intelligence.ts:1577-1588` |
| 19 | Alertas (29 tipos) | 29 condiciones evaluadas en serie; push a `alertas[]` | `alertas[], alertas_count` — `intelligence.ts:1589-1652` |
| — | History + stock_snapshots | `generarHistoryRows(rows, hoy)` + `generarStockSnapshots(rows, hoy)` exportados del motor | Filas para `sku_intelligence_history` y `stock_snapshots` — `intelligence.ts:1693-1735` |

🆕 **CAMBIO vs doc anterior:** El orden real es _loop por SKU → ABC/Cuadrante global → re-cálculo de mandar/pedir con targets finales → liquidación → alertas_. El doc anterior presentaba los 19 pasos como secuencia plana; hoy están particionados loop/global.

---

## 3. Schema `sku_intelligence`

Tabla canon del motor. **118 columnas / 533 rows / 1.6 MB**. Abajo: columnas agrupadas, tipo, paso que las escribe, UI que las lee.

> Leyenda escritor (paso): `P#` del §2.  
> Leyenda lector UI: `I`=AdminInteligencia, `C`=AdminComercial, `R`=AdminReposicion, `M`=AdminMargenes, `-`=sin consumo UI directo.

### 3.1 Identidad (5)

| Columna | Tipo | Nullable | Default | Escrito por | Leído por |
|---|---|---|---|---|---|
| `sku_origen` | text (PK) | no | — | P1 | I C R M |
| `nombre` | text | sí | — | P1 | I C R |
| `categoria` | text | sí | — | P1 | I C |
| `proveedor` | text | sí | — | P1 | I R |
| `skus_venta` | text[] | sí | `{}` | P1 (deriva) | I |

### 3.2 Demanda (13)

| Columna | Tipo | Null | Escrito | Leído |
|---|---|---|---|---|
| `vel_7d`, `vel_30d`, `vel_60d` | numeric | no | P2 | I C |
| `vel_ponderada` | numeric | no | P2 | I C R |
| `vel_full`, `vel_flex`, `vel_total` | numeric | no | P2/P7 | I |
| `pct_full`, `pct_flex` | numeric | no | P2/P7 | I |
| `tendencia_vel` | text (`subiendo/bajando/estable`) | no | P3 | I |
| `tendencia_vel_pct` | numeric | no | P3 | I |
| `es_pico` | bool | no | P3 | I |
| `pico_magnitud` | numeric | no | P3 | I |

### 3.3 Eventos (3)

| Columna | Tipo | Null | Escrito | Leído |
|---|---|---|---|---|
| `multiplicador_evento` | numeric | no | P4 | I C |
| `evento_activo` | text | sí | P4 | I |
| `vel_ajustada_evento` | numeric | no | P4 | I |

### 3.4 Stock (10)

| Columna | Tipo | Null | Escrito | Leído |
|---|---|---|---|---|
| `stock_full` | int | no | P5 | I R |
| `stock_bodega` | int | no | P5 | I R |
| `stock_total` | int | no | P5 | I R |
| `stock_sin_etiquetar` | int | no | P5 (siempre 0) | — |
| `stock_proveedor` | int | sí | P1 | I R |
| `tiene_stock_prov` | bool | no | P1 | I R |
| `inner_pack` | int | no | P1 | I R |
| `stock_en_transito` | int | no | P5 | I R |
| `stock_proyectado` | int | no | P5 | I |
| `oc_pendientes` | int | no | P5 | I |

### 3.5 Cobertura (4)

| Columna | Tipo | Null | Escrito | Leído |
|---|---|---|---|---|
| `cob_full`, `cob_flex`, `cob_total` | numeric | no | P6 + recalc global | I R |
| `target_dias_full` | int | no | P8 + recalc global | I R |

### 3.6 Margen por canal (8)

| Columna | Tipo | Null | Escrito | Leído |
|---|---|---|---|---|
| `margen_full_{7,30,60}d` | numeric | no | P2/P7 | I C M |
| `margen_flex_{7,30,60}d` | numeric | no | P2/P7 | I C M |
| `margen_tendencia_full`, `margen_tendencia_flex` | text | no | P7 | I M |
| `canal_mas_rentable` | text | no | P7 | I |
| `precio_promedio` | numeric | no | P2 | I |

### 3.7 ABC + cuadrante (11)

| Columna | Tipo | Null | Escrito | Leído |
|---|---|---|---|---|
| `abc` (alias margen) | text (A/B/C) | no | P9 | I C R |
| `abc_margen`, `abc_ingreso`, `abc_unidades` | text | no | P9 | I |
| `ingreso_30d`, `margen_neto_30d`, `uds_30d` | numeric | no | P2/P9 | I C |
| `pct_margen_acumulado`, `pct_ingreso_acumulado`, `pct_unidades_acumulado` | numeric | no | P9 | I |
| `cv` | numeric | no | P10 | I |
| `xyz` | text (X/Y/Z) | no | P10 | I |
| `desviacion_std` | numeric | no | P10 | R |
| `cuadrante` | text | no | P11 | I C |

### 3.8 Safety stock + ROP (13)

| Columna | Tipo | Null | Escrito | Leído |
|---|---|---|---|---|
| `stock_seguridad` (legacy alias) | numeric | no | P12 | R |
| `punto_reorden` (legacy) | numeric | no | P12 | R |
| `nivel_servicio` | numeric | no | P12 | R |
| `lead_time_real_dias`, `lead_time_real_sigma` | numeric | sí | P12 (oc_real) | R |
| `lead_time_usado_dias` | numeric | no | P12 | R |
| `lead_time_fuente` | text | no | P12 | R |
| `lt_muestras` | int | no | P12 | R |
| `safety_stock_simple` | numeric | no | P12 | R |
| `safety_stock_completo` | numeric | no | P12 | I R |
| `safety_stock_fuente` | text | no | P12 | R |
| `rop_calculado` | numeric | no | P12 | I R |
| `necesita_pedir` | bool | no | P12 | I |

### 3.9 Financieros (6)

| Columna | Tipo | Null | Escrito | Leído |
|---|---|---|---|---|
| `gmroi` | numeric | no | P13 | I C |
| `gmroi_potencial` | numeric | no | P14 | I |
| `dio` | numeric | no | P13 | I |
| `costo_inventario_total` | numeric | no | P13 | I |
| `costo_neto`, `costo_bruto`, `costo_fuente` | numeric / numeric / text | no | P1 | I M |

### 3.10 Quiebre prolongado (13)

| Columna | Tipo | Null | Escrito | Leído |
|---|---|---|---|---|
| `dias_sin_stock_full` | int | no | P14 | I |
| `semanas_con_quiebre` | int | no | P14 | I |
| `venta_perdida_uds`, `venta_perdida_pesos`, `ingreso_perdido` | numeric | no | P14 | I |
| `oportunidad_perdida_es_estimacion` | bool | no | P14 | I (tooltip) |
| `vel_pre_quiebre` | numeric | no | P14 | I |
| `margen_unitario_pre_quiebre` | numeric | no | P14 | I |
| `dias_en_quiebre` | int | sí | P14 | I R |
| `es_quiebre_proveedor` | bool | no | P14 | I R |
| `abc_pre_quiebre` | text | sí | P14 | I |
| `es_catch_up` | bool | no | P14 | I |

### 3.11 Acción + reposición (9)

| Columna | Tipo | Null | Escrito | Leído |
|---|---|---|---|---|
| `accion` | text (11 valores) | no | P15 | I (todas las vistas) |
| `prioridad` | int | no | P15 | I (sort) |
| `mandar_full` | int | no | P15 + recalc global | I |
| `pedir_proveedor` | int | no | P15 + recalc global | I |
| `pedir_proveedor_bultos` | int | no | recalc global | I |
| `pedir_proveedor_sin_rampup` | int | no | P10c | I (tooltip) |
| `factor_rampup_aplicado` | numeric | no | P10c | I (columna "Ramp-up") |
| `rampup_motivo` | text | no | P10c | I (tooltip) |
| `requiere_ajuste_precio` | bool | no | P16 | I M |

### 3.12 Alertas (2)

| Columna | Tipo | Null | Escrito | Leído |
|---|---|---|---|---|
| `alertas` | text[] | no | P19 | I (chips) |
| `alertas_count` | int | no | P19 | I (badge) |

### 3.13 Liquidación (3)

| Columna | Tipo | Null | Escrito | Leído |
|---|---|---|---|---|
| `liquidacion_accion` | text | sí | P17 | C |
| `liquidacion_dias_extra` | int | no | P17 | C |
| `liquidacion_descuento_sugerido` | numeric | no | P17 | C |

### 3.14 Operación (5)

| Columna | Tipo | Null | Escrito | Leído |
|---|---|---|---|---|
| `ultimo_conteo` | timestamptz | sí | P18 | I |
| `dias_sin_conteo` | int | no | P18 | I |
| `diferencias_conteo` | int | no | P18 | I |
| `ultimo_movimiento` | timestamptz | sí | P18 | I |
| `dias_sin_movimiento` | int | no | P18 | I |

### 3.15 Objetivos (2) + Metadata (3)

| Columna | Tipo | Null | Escrito | Leído |
|---|---|---|---|---|
| `vel_objetivo` | numeric | no | Manual (PATCH) | I |
| `gap_vel_pct` | numeric | sí | P2 (derivado) | I |
| `updated_at` | timestamptz | no | al upsert | I |
| `datos_desde`, `datos_hasta` | date | sí | P2 | — |

### 3.16 Flag estacional + metadata (PR4 Fase 1, migración v54)

| Columna | Tipo | Null | Escrito | Leído |
|---|---|---|---|---|
| `es_estacional` | boolean | no (default `false`) | Manual (SQL Editor o script inicial) | I (banner Accuracy), motor P2 (vía `seleccionarModeloZ`) |
| `estacional_motivo` | text | sí | Manual | Query admin |
| `estacional_marcado_por` | text | sí | Manual | Query admin |
| `estacional_marcado_at` | timestamptz | sí | Manual (`now()`) | Query admin |
| `estacional_revisar_en` | date | sí | Manual (`marcado_at + 6 meses`) | I (count para banner vencidos) |

Índice parcial `idx_sku_intel_estacional_revisar` sobre `estacional_revisar_en` WHERE `es_estacional=true` acelera la query del banner.

Sin UI de edición — marcado y desmarcado se hacen vía Supabase SQL Editor. Script inicial: `scripts/marcar-estacionales-iniciales.sql`.

---

## 4. Endpoints `/api/intelligence/*`

| Método | Path | Body (POST/PATCH) | Función | Consumer UI |
|---|---|---|---|---|
| GET · POST | `/api/intelligence/recalcular` | query `?full=true&snapshot=true` | Invoca `recalcularTodo()`, upsert `sku_intelligence`, inserta `sku_intelligence_history` y `stock_snapshots`. Devuelve `{ ok, n_skus, t_ms, errores }` | Botón "🔁 Recalcular" en `AdminInteligencia.tsx` + cron diario 11 UTC |
| GET | `/api/intelligence/sku-venta` | — | Devuelve lista SKU venta con composición + stock + velocidad Full/Flex/ponderada + margen | Tab **envio** (selección de SKU venta → Full) |
| GET | `/api/intelligence/vista-venta` | — | Vista comercial por SKU venta: ABC, cuadrante, accion, alertas | `AdminComercial` tab "Vista comercial" |
| GET | `/api/intelligence/pendientes` | — | SKUs con problemas: sin producto WMS, sin costo, sin mapeo ML, sin composición | Banner "Pendientes atención" en `AdminInteligencia` |
| POST | `/api/intelligence/envio-full-log` | `{ sku_venta, unidades_motor, unidades_final, razon_edit }` | Registra edición manual de cantidad en un envío a Full | Flujo **crear picking Full** |
| PATCH | `/api/intelligence/sku/[sku_origen]` | `{ vel_objetivo?, nota?, evento_activo? }` | Update manual de campos editables | Inline edit en tabla `origen` |
| POST | `/api/intelligence/sku/_bulk` | `{ updates: [...] }` | Update masivo (varios SKUs a la vez) | Modal "Editar masivo" |
| GET | `/api/intelligence/actualizar-lead-times` | — | Refresca `lead_time_real_dias/_sigma` por proveedor y por producto desde histórico de OCs + `proveedor_catalogo` | Cron lunes 12 UTC + botón en `AdminReposicion` |

Todos los endpoints usan `anon key`; no hay auth propia. El cron se valida con `Authorization: Bearer ${CRON_SECRET}`.

---

## 5. UI `AdminInteligencia.tsx`

- **LOC total**: 3 315 (`src/components/AdminInteligencia.tsx`).
- Renderizado desde `src/app/admin/page.tsx` (tab "Intel" del sidebar).

### 5.1 Vistas (botones-vista booleanos, no tabs)

🆕 **CORRECCIÓN vs doc anterior:** el componente NO usa un `mode` enum tipo `"origen"|"envio"|...`; usa **booleans independientes** por vista (`vistaOrigen`, `vistaEnvio`, `vistaPedido`, `vistaProveedorAgotado`, `vistaAccuracy`). Al hacer click en un botón del header se pone ése en `true` y los otros en `false`. "Pendientes" y "Notas" son **modales**, no vistas.

Botones actuales en el header (toggle group):

| Botón | State boolean | Propósito | Fuente de datos |
|---|---|---|---|
| `SKU Venta` (default) | `!vistaOrigen && !vistaEnvio && !vistaPedido && !vistaProveedorAgotado && !vistaAccuracy` | Vista principal por SKU venta | `sku_intelligence` + composición |
| `SKU Origen` | `vistaOrigen` | Tabla de SKU físicos con acción, stock, cobertura, margen, alertas | cache `sku_intelligence` |
| `Envio a Full` | `vistaEnvio` | Selección SKU venta → uds a mandar → crear picking `envio_full` | `GET /api/intelligence/sku-venta` |
| `Pedido a Proveedor` | `vistaPedido` | Selección SKU origen → cálculo bultos → exporta Excel | `sku_intelligence` + `proveedor_catalogo` |
| `Ventana Proveedor` | `vistaProveedorAgotado` | SKUs donde `es_quiebre_proveedor=true` o `stock_proveedor=0`, agrupados | derivado de `sku_intelligence` |
| `📊 Accuracy` 🆕 (PR2/3) | `vistaAccuracy` | Forecast accuracy: SKUs A/B con WMAPE/bias/TS descalibrados; placeholder hasta el 2026-05-18 | `forecast_*_8s` cacheado en `sku_intelligence` |

### 5.2 KPIs del header

Caja con métricas agregadas del portafolio:

- **Total origen** (SKUs físicos)  
- **Total venta** (SKUs venta tras composición)  
- **Stock bodega** · **Stock Full** · **Stock en tránsito**  
- **Urgentes** (`accion IN (URGENTE, AGOTADO_PEDIR, AGOTADO_SIN_PROVEEDOR)`)  
- **ABC A** (cantidad)  
- **Cobertura promedio**

### 5.3 Banners contextuales

- ⚠️ **Stock Full desactualizado** si `max(stock_full_cache.updated_at) < now() - 2h`.
- ⚠️ **Pendientes atención** (modal con `/api/intelligence/pendientes`).
- ⚠️ **ML sin vincular** (cantidad de items + unidades totales sin mapeo).
- 🟢 **Ramp-up activo en N SKUs** (cuando hay `factor_rampup_aplicado ≠ 1.0`).
- 🟡 **Excluidos del envío a Full** (listado desde commit `9c64010`).

### 5.4 Flujo del botón "🔁 Recalcular"

1. Click → deshabilita botón + muestra spinner.
2. `POST /api/intelligence/recalcular?full=true&snapshot=true` (header: `x-trigger: manual`).
3. Backend:
   - `cargarInputs()` lee productos, composicion_venta, ventas_ml_cache, stock, stock_full_cache, ordenes_compra, ordenes_compra_lineas, envio_full_pendiente, picking_sessions abiertas, conteos, movimientos, stock_snapshots previos, eventos_demanda, proveedor_catalogo, sku_intelligence previa.
   - `recalcularTodo(inputs)` → `{ rows, debug }`.
   - `generarHistoryRows(rows, hoy)` y `generarStockSnapshots(rows, hoy)`.
   - Upsert de cada set a Supabase (chunks de 500).
4. Response `{ ok: true, n_skus: 533, t_ms: ~9 000, errores: [] }`.
5. UI re-fetch de `sku_intelligence` + muestra toast `"✓ Recalculado: 533 SKUs en 9.2s"`.
6. Refresh de tabla + KPIs.

🆕 **CAMBIO vs doc anterior:** el recálculo siempre corre en modo _full_ (no hay incremental aún). El commit `8a65ef7` agregó columna **"Motor"** al lado de "Mandar" para mostrar el valor crudo antes del redondeo a `inner_pack`.

---

## 6. Tipos de alerta

**31 strings posibles** en `alertas[]` (28 previos + 3 nuevas de PR2/3; `cambio_canal_rentable` fue eliminado como residuo muerto en PR2). Orden y condición según `intelligence.ts:1589-1680`.

| # | `alertas[]` | Condición (código) | Urgencia |
|---|---|---|---|
| 1 | `sin_costo` | `vel_ponderada > 0 && !costo_bruto` | 🔴 Crítica |
| 2 | `costo_posiblemente_obsoleto` | Fuente manual/catalogo y `productos.updated_at` < hoy−90d y vel>0 | 🟡 Advertencia |
| 3 | `necesita_pedir` | `stock_total ≤ rop_calculado` | 🟠 Urgente |
| 4 | `pedido_bajo_moq` | `pedir_proveedor > 0 && moq > 1 && pedir_proveedor < moq` | 🟢 Info |
| 5 | `agotado_full` | `stock_full == 0 && vel_full > 0` | 🔴 Urgente |
| 6 | `urgente` | `cob_full < punto_reorden && cob_full < 999` | 🔴 Urgente |
| 7 | `margen_negativo_full` | `margen_full_30d < 0 && vel_full > 0` | 🔴 Crítica |
| 8 | `margen_negativo_flex` | `margen_flex_30d < 0 && vel_flex > 0` | 🔴 Crítica |
| 9 | `pico_demanda` | `es_pico === true` | 🟢 Info |
| 10 | `caida_demanda` | `tendencia_vel == 'bajando' && abs(tendencia_vel_pct) > 30` | 🟡 Advertencia |
| 11 | `sin_stock_proveedor` | `!tiene_stock_prov` | 🔴 Crítica |
| 12 | `proveedor_agotado_con_cola_full` | `stock_proveedor == 0 && stock_full > 0 && vel > 0` | 🟠 Urgente |
| 13 | `exceso` | `cob_total > 60` | 🟡 Info |
| 14 | `dead_stock` | `vel_ponderada == 0 && stock_total > 0` | 🟡 Info |
| 15 | `margen_full_bajando` | `margen_tendencia_full == 'bajando'` | 🟡 Advertencia |
| 16 | `margen_flex_bajando` | `margen_tendencia_flex == 'bajando'` | 🟡 Advertencia |
| 17 | `requiere_ajuste_precio` | `requiere_ajuste_precio === true` | 🟡 Info |
| 18 | `sin_conteo_30d` | `dias_sin_conteo > 30` | 🟡 Info |
| 19 | `liquidar` | `liquidacion_accion !== null` | 🟠 Advertencia |
| 20 | `evento_activo` | `evento_activo !== null` | 🟢 Info |
| 21 | `en_transito` | `stock_en_transito > 0` | 🟢 Info |
| 22 | `stock_danado_full` | Detalle `stock_full_cache` trae `danado>0` o `perdido>0` | 🟠 Advertencia |
| 23 | `estrella_quiebre_prolongado` | `(dias_en_quiebre ≥ 14 && vel_pre > 2) && (abc=='A' || abc_pre_quiebre=='A')` | 🔴 Crítica |
| 24 | `catch_up_post_quiebre` | `es_catch_up === true` | 🟢 Info |
| 25 | `bajo_meta` | `vel_objetivo > 0 && vel_ponderada < vel_objetivo × 0.8` | 🟡 Advertencia |
| 26 | `sobre_meta` | `vel_objetivo > 0 && vel_ponderada > vel_objetivo × 1.3` | 🟢 Info |
| 27 | `proveedor_volvio_stock` | `prev.es_quiebre_proveedor && !es_quiebre_proveedor && vel_pre > 2` | 🟢 Info |
| 28 | `pedido_bajo_moq` | `pedir_proveedor > 0 && moq > 1 && pedir_proveedor < moq` | 🟢 Info |
| 29 🆕 PR2 | `forecast_descalibrado_critico` | `es_confiable && abc ∈ {A,B} && xyz ∈ {X,Y} && abs(TS)>4 && cuadrante='ESTRELLA'` | 🔴 Crítica |
| 30 🆕 PR2 | `forecast_descalibrado` | igual que anterior pero `cuadrante≠'ESTRELLA'` | 🟡 Advertencia |
| 31 🆕 PR2 | `forecast_sesgo_sostenido` | `es_confiable && abc ∈ {A,B} && semanas_evaluadas ≥ 8 && abs(bias) > vel_ponderada × 0.3` | 🟡 Advertencia |

Lista canon en `intelligence.ts:1589-1680`. La lógica de las 3 nuevas está extraída a `evaluarAlertasForecast()` (exportada, testeable sin montar todo el motor).

---

## 7. Acciones y prioridades

Enum `AccionIntel` (11 valores). Asignado por P15. Prioridad numérica determina orden de la tabla (menor = más arriba). El motor ajusta prioridad por ABC: `prioridad -=5` si `abc=A`, `+=5` si `abc=C`.

| # | Acción | Regla de activación | Prioridad base | Racional |
|---|---|---|---|---|
| 1 | `AGOTADO_SIN_PROVEEDOR` | `stock_full==0 && (vel_full>0 ∨ quiebre prolongado) && stock_bodega==0 && (es_quiebre_proveedor ∨ !tiene_stock_prov)` | **3** | Bloqueado en toda la cadena |
| 2 | `AGOTADO_PEDIR` | `stock_full==0 && (vel_full>0 ∨ quiebre prolongado) && stock_bodega==0` (proveedor tiene) | 5 | Urgente — pedir ya |
| 3 | `MANDAR_FULL` | `(vel==0 && vel_pre==0 && stock_full==0 && stock_bodega>0)` ∨ nuevo con stock bodega | 10 | Lote inicial Full |
| 4 | `URGENTE` | `cob_full < punto_reorden && cob_full < 999` | 15 | Cobertura por debajo de ROP |
| 5 | `EN_TRANSITO` | (URGENTE ∨ AGOTADO_PEDIR) **y** `stock_en_transito>0` **y** cobertura de tránsito ≥ 7d | 25 | Reposición ya viene |
| 6 | `PLANIFICAR` | `cob_full < 30` | 40 | Cobertura baja no-crítica |
| 7 | `NUEVO` | `vel==0 && vel_pre==0 && dias_sin_movimiento ≤ 30` | 50 | Recién ingresado |
| 8 | `OK` | `cob_full ≤ cobMaxima` | 60 | Normal |
| 9 | `EXCESO` | `cob_full > cobMaxima` (default 60d) | 70 | Stock de más |
| 10 | `DEAD_STOCK` | `vel==0 && vel_pre==0 && stock_total>0` | 80 | Sin venta + stock |
| 11 | `INACTIVO` | `vel==0 && vel_pre==0 && stock_total==0` | 99 | Candidato a discontinuar |

El árbol decide con precedencia top-down, así que un SKU con `stock_full=0 + vel_full>0 + stock_bodega=0 + sin proveedor` cae en `AGOTADO_SIN_PROVEEDOR` (prio 3) aunque también cumpla `URGENTE`.

---

## 8. Fórmulas matemáticas clave

### 8.1 Velocidad ponderada (`intelligence.ts:913`)

```
vel_ponderada = 0.5 · vel_7d + 0.3 · vel_30d + 0.2 · vel_60d
```

Las velocidades diarias excluyen semanas marcadas "en quiebre" (≥3 días sin stock explícito en `stock_snapshots`).

### 8.2 Tendencia (`intelligence.ts:886-889`)

```
pct = (vel_7d − vel_30d) / vel_30d · 100
dir = subiendo  si pct >  15
      bajando   si pct < −15
      estable   si |pct| ≤ 15
```

### 8.3 Pico de demanda (`intelligence.ts:961-962`)

```
es_pico        = vel_30d > 0 ∧ vel_7d > 1.5 · vel_30d
pico_magnitud  = vel_7d / vel_30d   (0 si vel_30d=0)
```

### 8.4 CV + XYZ (`intelligence.ts:868-879`, `1069-1076`)

```
μ  = media(ventas_semanales sin semanas en quiebre)
σ  = √( Σ(vᵢ − μ)² / n )
CV = σ / μ     (∞ si μ=0)

X si CV < 0.5   (regular)
Y si CV < 1.0   (moderada)
Z si CV ≥ 1.0   (irregular)
```

### 8.5 ABC Pareto (`intelligence.ts:1385-1406`)

```
items_pos = items ordenados DESC por métrica > 0
total     = Σ métrica
acum      = 0
para cada item:
  acum += métrica
  pct_acum = acum / total · 100
  clase = A si pct_acum ≤ 80
          B si pct_acum ≤ 95
          C en otro caso
```

Se aplica tres veces independientemente sobre `margen_neto_30d`, `ingreso_30d`, `uds_30d`.

### 8.6 Safety Stock (`intelligence.ts:1542, 1547`)

Simple (legacy, sin σ_LT):

```
SS_simple = Z · σ_D · √LT
```

Completo (Fase B, canon actual):

```
SS_completo = Z · √( LT · σ_D²  +  D̄² · σ_LT² )
```

donde `Z` depende del nivel de servicio por ABC (A=0.97→Z≈1.88, B=0.95→Z≈1.65, C=0.90→Z≈1.28). `LT` y `σ_LT` en **semanas**.

### 8.7 Punto de reorden (`intelligence.ts:1550`)

```
ROP = D̄ · LT + SS_completo
necesita_pedir = stock_total ≤ ROP
```

### 8.8 GMROI (`intelligence.ts:1087-1089`)

```
margen_bruto_anual = margen_promedio · vel_ponderada · 52
GMROI              = margen_bruto_anual / (costo_bruto · stock_total)
```

Versión "potencial" (para SKUs en quiebre):

```
GMROI_pot = (margen_prom_pot · vel_pre · 52) / (costo_bruto · vel_pre · target_dias_full/7)
```

### 8.9 DIO (`intelligence.ts:1090`)

```
DIO = (stock_total / vel_ponderada) · 7    (en días)
      999 si vel_ponderada ≤ 0
```

### 8.10 Oportunidad perdida (`intelligence.ts:1242-1267`)

```
dias_efectivos     = max(diasQuiebre, dias_en_quiebre)
vel_para_perdida   = vel_pre_quiebre · pct_full   (si quiebre prolongado)
                   = vel_full                     (en otro caso)

venta_perdida_uds    = dias_efectivos · vel_para_perdida / 7

margen_para_perdida  = margen_full_30d          si > 0
                     = margen_full_60d          si > 0
                     = precio_promedio · 0.25   (fallback ⇒ flag estimacion)
venta_perdida_pesos  = venta_perdida_uds · margen_para_perdida
oportunidad_perdida_es_estimacion = true  si se usó fallback
```

### 8.11 Cobertura proyectada (`intelligence.ts:1010-1019`)

```
cobertura(stock, velSemanal) = (stock / velSemanal) · 7     si velSemanal > 0
                             = 999                          en otro caso
```

Aplicado a `(stock_full, vel_full)`, `(stock_bodega, vel_flex)`, `(stock_total, vel_ponderada)`.

### 8.12 Redondeo a `inner_pack` (`intelligence.ts:1476-1477`)

```
pedir_bultos = ceil(pedir_proveedor / inner_pack)     si inner_pack > 1
             = pedir_proveedor                         en otro caso
```

### 8.14 Selección de modelo para Z (`tsb.ts:seleccionarModeloZ`) — PR3 Fase A + PR4 Fase 1

```
si xyz !== 'Z'                       → sma_ponderado
si es_estacional === true            → sma_ponderado   (PR4 Fase 1)
si primera_venta es null             → sma_ponderado   (fallback seguro)
si fecha inválida                    → sma_ponderado
si (hoy − primera_venta) < 60 días   → sma_ponderado   (puerta anti-ramp-up)
resto                                → tsb
```

Intencionalmente 2 regímenes (no 3). El flag `es_estacional` gana sobre la puerta de edad — un SKU marcado estacional queda en SMA aunque sea maduro. 18 tests cubren todas las ramas (`src/lib/__tests__/tsb.test.ts`).

### 8.13 Factor ramp-up post-quiebre (`rampup.ts:1-41` · aplicación `intelligence.ts:1507-1524`)

```
si dias_en_quiebre es null o 0:
    factor = 1.0   (no_aplica)

si quiebre_propio:
    dias ∈ [1,14]    → 1.00
    dias ∈ [15,60]   → 0.50
    dias ∈ [61,120]  → 0.30
    dias > 120       → 0.00    (candidato a discontinuar)

si quiebre_proveedor:
    dias ∈ [1,30]    → 1.00
    dias ∈ [31,120]  → 0.75
    dias > 120       → 0.50

pedir_proveedor_final = round(pedir_sin_rampup · factor)
```

### 8.14 velPre_quiebre (`intelligence.ts:1190-1230`)

```
vel_historica = max(vel_60d, vel_ponderada)          (vel_60d limpia, PR #263)

si enQuiebreAhora:
    si prev.dias_en_quiebre > 0:     # sigue en quiebre
        vel_pre_quiebre = max(vel_historica, prev.vel_pre_quiebre)
    si prev.dias_en_quiebre == 0:    # acaba de entrar
        vel_pre_quiebre = vel_historica

si se repuso (stock>0 ahora, prev.dias > 0):
    es_catch_up = (vel_7d > vel_pre · 1.5) ∧ (vel_pre > 2)
    si vel_30d > 0 ∧ NOT catch_up:
        vel_pre_quiebre = 0          # reset
    si no:
        vel_pre_quiebre = preservado
```

### 8.16 `dias_sin_movimiento` y acción `NUEVO` (PR6a)

Antes de PR6a: `dias_sin_movimiento` caía a un centinela `999` cuando `ultimoMovPorSku.get(sku)` era `undefined` (ya fuera porque el SKU no tenía movimientos o porque el Map venía vacío por un fetch silencioso). La condición `diasSinMov <= 30` en el paso 15 nunca se cumplía → **rama `NUEVO` muerta** → SKUs recién recepcionados quedaban atrapados como `DEAD_STOCK` / `INACTIVO`.

Fix PR6a:
- Columna nullable (`v56`): `DROP DEFAULT; DROP NOT NULL`.
- `intelligence.ts:1241-1244`: `diasSinMov: number | null = ultimoMov ? … : null` — sin centinela.
- Helper puro `esAccionNuevo({...})` expuesto y testeable (9 tests en `intelligence-nuevo.test.ts`).
- El paso 15 usa `movimientoReciente = dias === null || dias <= 30`. Null (sin data) se trata como "no hay evidencia de que sea viejo" → eligible para `NUEVO`.
- Log explícito si `movimientos.length === 0` en un recálculo — detecta fetch silencioso.

Backfill `scripts/backfill-dias-sin-movimiento.ts`: lee `movimientos` sin filtro de ventana, recalcula `dias_sin_movimiento` y `ultimo_movimiento`, y deja `NULL` en SKUs sin historia. Dry-run/apply.

### 8.15 `dias_en_quiebre` y `fecha_entrada_quiebre` (PR5)

Derivación **idempotente** vía `resolverDiasEnQuiebre()` en `intelligence.ts`:

```
si !enQuiebreAhora:
  dias_en_quiebre = 0
  fecha_entrada_quiebre = NULL       ← limpia fósiles

si enQuiebreAhora:
  ancla = prev.fecha_entrada_quiebre   si existe y >= 2025-01-01
        | primerQuiebre (stock_snapshots)  si existe y >= 2025-01-01
        | hoy                              en cualquier otro caso
  dias_en_quiebre = min(365, floor((hoy − ancla) / 1 día UTC))
  fecha_entrada_quiebre = ancla        (se congela hasta que salga del quiebre)
```

Antes de PR5 el motor hacía `diasEnQuiebre = prev + 1` en cada corrida — contador por recálculo, no por día. Con ~80 runs/día llegaba a 2 000+ días en 25 días reales. 49 SKUs quedaban con factor_rampup=0.0/0.5 y `pedir_proveedor` recortado sin razón. Tests en `src/lib/__tests__/intelligence-quiebre.test.ts` (8 casos).

**Reset correcto (PR5)**: la rama `!enQuiebreAhora` limpia SIEMPRE, sin condicionar a `stFull>0`. Eso arregla los SKUs `EXCESO` / `MANDAR_FULL` con valores fósiles heredados que antes nunca se limpiaban.

---

## 9. Flujos de datos críticos

### 9.1 Recalcular manual (botón UI)

```
User              UI                       API                                     DB
 │ click "🔁"      │                         │                                       │
 │────────────────▶│ spinner ON              │                                       │
 │                 │ POST /api/intelligence/recalcular?full=true&snapshot=true       │
 │                 │────────────────────────▶│                                       │
 │                 │                         │ cargarInputs()                        │
 │                 │                         │──────────────────────────────────────▶│
 │                 │                         │◀────────── productos, ventas, stock,  │
 │                 │                         │            composicion, snapshots,    │
 │                 │                         │            catalogo, prev intel, etc. │
 │                 │                         │                                       │
 │                 │                         │ rows, debug = recalcularTodo(inputs)  │
 │                 │                         │ (pure, in-memory ~1-3 s)              │
 │                 │                         │                                       │
 │                 │                         │ upsert sku_intelligence (chunks 500)  │
 │                 │                         │──────────────────────────────────────▶│
 │                 │                         │ insert sku_intelligence_history       │
 │                 │                         │──────────────────────────────────────▶│
 │                 │                         │ upsert stock_snapshots                │
 │                 │                         │──────────────────────────────────────▶│
 │                 │◀──── { ok, n_skus, t_ms, errores }                              │
 │                 │ toast + refetch tabla   │                                       │
 │◀── re-render ───│                         │                                       │
```

### 9.2 Creación de picking "Envío a Full"

```
User (admin)   AdminInteligencia (tab envio)     API                                   DB
 │ selecciona SKU venta + edita qty            │                                        │
 │─────────────▶│ valida stock bodega, redondea│                                        │
 │              │ a inner_pack                 │                                        │
 │              │ POST /api/intelligence/envio-full-log { sku_venta, motor, final, razon}│
 │              │─────────────────────────────▶│ insert admin_actions_log              │
 │              │                              │──────────────────────────────────────▶ │
 │              │ crea session (tipo=envio_full, estado=ABIERTA)                        │
 │              │ upsert picking_sessions                                               │
 │              │──────────────────────────────────────────────────────────────────────▶│
 │              │ upsert envio_full_pendiente (suma qty reservada)                      │
 │              │──────────────────────────────────────────────────────────────────────▶│
 │              │ redirect a tab Picking                                                │
 │◀─────────────│                                                                       │
```

### 9.3 Pickear una línea → descuento stock + sync ML

```
Operario         Operador UI                     db.ts RPC                 stock / movimientos / ML
 │ scan SKU       │                              │                          │
 │───────────────▶│ fetch linea pendiente        │                          │
 │                │ RPC actualizar_linea_picking │                          │
 │                │─────────────────────────────▶│ update jsonb + estado    │
 │                │                              │ estado = PICKEADA        │
 │                │                              │                          │
 │                │ RPC registrar_movimiento_stock(sku, posicion, -qty, 'envio_full', idemp_key)
 │                │─────────────────────────────────────────────────────────▶│
 │                │                              │                          │ UPDATE stock SET cantidad = cantidad - qty
 │                │                              │                          │ INSERT movimientos (tipo, qty_after, ...)
 │                │                              │                          │
 │                │ cuando todas las líneas cierran:                        │
 │                │ estado session = CERRADA                                 │
 │                │─────────────────────────────────────────────────────────▶│
 │                │ enqueue /api/ml/stock-sync   │                          │
 │                │ (stock_sync_queue insert)    │                          │
 │                │                              │                          │
 │                │                              │                          │── cron cada minuto ──▶ PUT /user-products/*/stock/type/selling_address
```

### 9.4 Snapshot diario (cron 11 UTC)

```
Vercel cron                API                                          DB
 │ 11:00 UTC                │                                            │
 │────── GET /api/intelligence/recalcular?full=true&snapshot=true ──────▶│
 │                          │ (flujo idéntico a §9.1)                    │
 │                          │                                            │
 │                          │ además: insert sku_intelligence_history    │
 │                          │──────────────────────────────────────────▶│ (fila por SKU por día)
 │                          │ upsert stock_snapshots                     │
 │                          │──────────────────────────────────────────▶│
```

---

## 10. Jobs / crons

### 10.1 Crons directos al motor

| Path | Schedule UTC | Frecuencia | Impacto |
|---|---|---|---|
| `/api/intelligence/recalcular?full=true&snapshot=true` | `0 11 * * *` | diario 11:00 | Recálculo completo + inserta history + stock_snapshots |
| `/api/intelligence/actualizar-lead-times` | `0 12 * * 1` | lunes 12:00 | Refresca `lead_time_real_dias/_sigma` por proveedor y producto (OCs + catálogo) |

### 10.2 Crons que alimentan al motor (indirectos)

| Path | Schedule | Dato que produce | Uso en motor |
|---|---|---|---|
| `/api/ml/ventas-sync?days=7` | diario 10:00 | filas en `ventas_ml_cache` | P2 (demanda), P7 (margen) |
| `/api/ml/ventas-reconcile` | diario 08:00 | corrige divergencias ML↔cache | P2 |
| `/api/ml/sync-stock-full` | cada 30 min | `stock_full_cache` | P5 (stock Full) |
| `/api/ml/stock-sync` | cada minuto | `stock_sync_queue` + PUT ML | (no afecta motor; es output) |
| `/api/ml/margin-cache/refresh` | cada 5 min | `ml_margin_cache` (costo+comisión+envío) | P2/P7 (margen real) |
| `/api/profitguard/sync` | cada 5 min | enriquece margen por orden en `ventas_ml_cache` | P2/P7 |

### 10.3 Cron downstream

| Path | Schedule | Consumidor del motor |
|---|---|---|
| `/api/semaforo/refresh` | lunes 09:00 | Usa `sku_intelligence` + `semaforo_semanal` |
| `/api/agents/cron` | diario 08:00 | Agentes IA leen `sku_intelligence` + `sku_intelligence_history` |

---

## 11. Integraciones externas

### 11.1 MercadoLibre (input principal)

- **Órdenes → `ventas_ml_cache`** vía `/api/ml/ventas-sync` (cada 24h, últimos 7 días) + `/api/ml/sync` (polling cada minuto). Estos datos son el insumo principal de P2/P7.
- **Stock Full → `stock_full_cache`** vía `/api/ml/sync-stock-full` cada 30 min + webhooks `stock-locations` en vivo (commits 2026-04-16: modelo dual con drift-check).
- **Márgenes → `ml_margin_cache`** calculados en `/api/ml/margin-cache/refresh` combinando costo + comisión ML + costo de envío real del shipment.

### 11.2 ProfitGuard

- `/api/profitguard/sync` enriquece órdenes con ingresos netos, comisiones y costos logísticos reales. 🆕 El motor **ya no hace override** de `vel_ponderada` con datos PG (commit `816ef5e`): PG alimenta los márgenes en `ventas_ml_cache`, pero la velocidad se calcula exclusivamente desde órdenes reales.

### 11.3 Idetex / `proveedor_catalogo`

- Fuente de verdad de **precios y stock de proveedor**.
- Se actualiza vía upload manual de Excel (`/api/proveedor-catalogo/import-template`) o bulk PATCH (`/api/proveedor-catalogo/bulk-update`).
- El motor lo consume en P1 (cascada de costo: `costo_promedio > costo_manual > proveedor_catalogo`) y para `stock_proveedor`/`tiene_stock_prov`.
- Hay una regla específica: **Verbo Divino** incluye todos los SKUs (no filtra por ABC), porque son pocos (`src/app/api/proveedor-catalogo/faltantes/route.ts:69`).

---

## 12. Gaps conocidos

Explícito — estos no existen en el código hoy:

| # | Gap | Nota |
|---|---|---|
| 1 | **Recalc incremental por evento** | El cron siempre corre `full=true`. No hay enqueue tipo `intelligence_dirty_queue` cuando cambia stock/venta/costo. |
| 2 | **Tests del motor** | Cero coverage en `intelligence.ts`. Único test del repo: `src/lib/__tests__/reposicion.test.ts`. |
| 3 | **Versionado de configuración** | `intel_config` no guarda snapshot por corrida. `config_historial` existe pero no se usa desde el motor. |
| 4 | **Forecast accuracy** (WMAPE / bias / tracking signal) | **Cerrado en PR1 (medición) + PR2 (alertas + UI).** PR1 agregó tablas + módulo puro + cron. PR2 enganchó 3 alertas al motor (`forecast_descalibrado_critico`, `forecast_descalibrado`, `forecast_sesgo_sostenido`), 6 columnas `forecast_*_8s` en `sku_intelligence`, tab `📊 Accuracy` con filtros, banner y tabla priorizada por cuadrante. PR3 (pendiente): TSB para clase Z. |
| 5 | **TSB para demanda intermitente** | Clase Z usa mismo SS que X/Y. No hay Teunter-Syntetos-Babai. |
| 6 | **Modelos de forecast por clase XYZ** | Estado real por clase: ✅ **SMA ponderado 50/30/20** funcionando para X/Y y por default para Z (`vel_ponderada`). ✅ **TSB shadow** calculado para Z maduros (≥60 días desde primera venta) en PR3 Fase A — persistido en `vel_ponderada_tsb`, **no consumido** por el motor. Benchmark PR3 Fase B (2026-04-18) concluyó NO PASA los 4 criterios de activación → TSB queda shadow permanente. ❌ **Holt-Winters / estacionales**: no implementado; pre-auditoría PR4 (`docs/banva-bodega-pr4-preauditoria.md`) confirma que HW **no es viable con los datos actuales** (historia máxima por SKU = 14 semanas; HW trimestral requiere ≥26, anual ≥52). ❌ **Re-clasificación Z con detección de estacionalidad**: pendiente PR4 Fase 1 (flag manual `es_estacional`), Fase 2 (~julio 2026: detección automática), Fase 3 (~abril 2027: HW real). |
| 7 | **EOQ / costo de orden** | `moq` se respeta vía alerta pero no se optimiza tamaño de lote. |
| 8 | **Transacción atómica en `/recalcular`** | Los 3 upserts (intel, history, snapshots) son independientes; inconsistencias posibles ante fallo parcial. |
| 9 | **Auto-match factura → OC** | 66/66 recepciones están huérfanas; no hay vinculación automática. |
| 10 | **Factura separada como doc contable** | `recepciones` mezcla "llegó a bodega" con "documento SII". |
| 11 | **Cron automático de recálculo incremental** | Sólo diario 11 UTC (full). No hay "cada hora modo rápido". |
| 12 | **Rate limiting API** | Nada detecta abuso. Regla `.claude/rules/security.md` lo confirma. |
| 13 | **Webhook ML — verificación de secret** | Campo en tabla, no se valida. |
| 14 | **`stock_sync_queue` — purga automática** | Acumula (54 rows hoy); no hay job de limpieza. |
| 15 | **Retención de `audit_log` / `agent_runs` / `ml_ads_daily_cache`** | Crecen indefinidamente. |
| 16 | **Migraciones versionadas** | Se ejecutan manualmente en SQL Editor; el historial `supabase-v*.sql` no se valida contra estado real. |
| 17 | **PIN admin hardcoded (`1234`) + PINs operario en texto plano** | Sin hash. |
| 18 | **Modelo shipment-centric final** | `pedidos_flex` legacy sigue vivo junto a `ml_shipments`. |
| 19 | **σ_LT empírico de Idetex (y otros proveedores)** | El motor usa `proveedores.lead_time_sigma_dias` manual en 442/533 SKUs (82 %). SS_completo aporta protección vs simple en 252 SKUs (57 %). Para medir σ_LT real se necesita: (a) crear OCs formales con `fecha_emision` al momento de pedir, (b) conectar `recepciones.orden_compra_id` → `ordenes_compra.id` para cruzar fecha_emision/fecha_recepcion. Hoy hay 4 OCs totales todas ANULADAS + 66 recepciones huérfanas. Requiere cambio operativo en flujo de compras, no fix de código. Estimación: Sprint 8+ si se atacan PR6/PR7 antes. |

---

## 13. Cambios recientes relevantes

Últimos commits que tocaron `src/lib/intelligence.ts` o `src/app/api/intelligence/**`:

| Hash | Fecha | Mensaje | Impacto |
|---|---|---|---|
| `8a65ef7` | 2026-04-16 | feat(inteligencia): columna "Motor" junto a "Mandar" para ver el valor crudo | UI: expone valor antes de redondeo a `inner_pack` |
| `9c64010` | 2026-04-16 | feat(inteligencia): mostrar SKUs excluidos del envío a Full con razón | UI: nuevo banner |
| `3f7ba08` | 2026-04-xx | docs: lógica rampup post-quiebre + velPre histórica + protección cuadrante (#264) | Doc complementaria `docs/banva-bodega-logica-rampup.md` |
| `da7ad22` | 2026-04-xx | feat(inventario): `velPre_quiebre` usa `vel60d` histórica limpia (#263) | P14: evita contaminar vel_pre con ventas recientes post-reposición |
| `bb1b92a` | 2026-04-xx | feat(inventario): protección ESTRELLA/CASHCOW en `enQuiebreProlongado` (#262) | Previene que un A caiga a REVISAR por quiebre |
| `a2e736b` | 2026-04-xx | feat(inventario): ramp-up post-quiebre + fix `dias_en_quiebre` corrupto (#261) | Introduce matriz ramp-up + fix de contador |
| `4896f6d` | 2026-xx | feat(intelligence): Fase B reposición — SS completo + ROP + LT por proveedor | Canon actual del P12 |
| `5089908` | 2026-xx | feat(intelligence): Paso 5 — ABC sobre 3 ejes + margen real + cuadrante estable | ABC ahora es trivariado |
| `816ef5e` | 2026-xx | refactor(intelligence): eliminar override de ProfitGuard en `vel_ponderada` | Velocidad = órdenes reales solamente |
| `79a82e0` | 2026-xx | fix: count envio_full pickings as stock en tránsito | P5 ahora considera pickings abiertos |
| `4f7ef14` | 2026-xx | fix(inteligencia): re-evaluar `es_quiebre_proveedor` + ventana proveedor agotado + flag `estimacion` | P14: introduce `oportunidad_perdida_es_estimacion` |

---

## 14. Riesgos técnicos identificados

⚠️ **Patrón a evitar — contadores derivados de recálculos** (aprendizaje del bug PR5 en `dias_en_quiebre`): cualquier campo que se incremente `+1` en cada corrida del motor se infla 2–3 órdenes de magnitud dado el volumen actual de recálculos (~80/día). Regla: **persistir ancla temporal** (`fecha_*`) y **derivar el contador** como `floor((hoy − ancla)/día)`. Es idempotente y no requiere conocer el histórico de ejecuciones. Ver `resolverDiasEnQuiebre()` como ejemplo canónico (§8.15).

⚠️ **Patrón a evitar — centinelas numéricos esconden bugs** (2ª lección, PR6a). Los campos calculados que caen a un número "imposible" (ej. `999`, `2071`) cuando no hay data fuente, **sesgan silenciosamente** las decisiones del motor. Casos detectados:
- `dias_en_quiebre = 2071` (PR5, f11eb07) → incrementaba por recálculo, falsificaba el factor de ramp-up.
- `dias_sin_movimiento = 999` (PR6a) → centinela cuando el Map `ultimoMovPorSku` venía vacío, **apagaba la rama `NUEVO`** del motor y mal-clasificaba 63 SKUs como `DEAD_STOCK`.

**Regla canónica**: nunca un valor centinela numérico en campos calculados. Usar `NULL` en DB con `DROP DEFAULT + DROP NOT NULL`; manejar explícitamente en código (`dias === null ? ... : ...`). Esto fue lo que hizo PR5 con `fecha_entrada_quiebre` y PR6a con `dias_sin_movimiento`.

| # | Riesgo | Dónde | Probabilidad | Mitigación actual | Pendiente |
|---|---|---|---|---|---|
| 1 | **Upsert no transaccional en `/recalcular`** — si falla entre intel y history, DB queda inconsistente (motor actualizado sin snapshot) | `recalcular/route.ts` | Baja pero posible en timeouts | Ninguna | Envolver los 3 upserts en una RPC `SECURITY DEFINER` o en transacción Supabase |
| 2 | **Race en `mandar_full`** — 2 recálculos simultáneos (cron + botón manual) leen mismo `stock_bodega` | `intelligence.ts:1317-1318` | Media (cron 11 UTC ≠ horarios de oficina) | Motor es read-only; persistencia no bloquea | Lock a nivel ruta (`pg_advisory_lock`) |
| 3 | **`prev.dias_en_quiebre` stale** — dos recálculos seguidos muy rápido pueden no incrementar el contador | `intelligence.ts:1215` | Baja (cron diario) | Ninguna | Idem (#2) |
| 4 | **Duplicados en `composicion_venta`** — si hay dos filas con `(sku_venta, sku_origen)` y `unidades` distintas, P1 usa la primera silenciosamente | `intelligence.ts:539-545` | Baja (unique constraint) | Dedupe lógica en motor | Confirmar unique constraint real en DB |
| 5 | **`stock_full_cache` desincronizado** — si sync ML falla, el motor ve stock falso | `intelligence.ts:981-1009` | Media (reciente commit `03e6a45` mitiga) | Webhook en vivo + health endpoint | Alerta operativa si drift > 10 uds |
| 6 | **Lead time fallback** — si proveedor no tiene LT real ni manual, cae a 5d; ROP puede quedar subestimado para proveedores lentos | `reposicion.ts:resolverLeadTime` | Media | Cascada `oc_real > manual_proveedor > manual_producto > 5d` | Alerta si `lead_time_fuente == 'fallback_default'` + vel>5 |
| 7 | **`vel_pre_quiebre` vieja** — SKU 180+ días en quiebre usa velocidad histórica que puede estar desactualizada | `intelligence.ts:1190-1230` | Baja | Flag `es_catch_up` + reset al reponer | Tiempo máx de preservación configurable |
| 8 | **`stock_proveedor = null`** — se interpreta "optimista" (tiene); si catálogo nunca actualizó, puede inducir pedidos inexistentes | `intelligence.ts:798-799` | Media | Flag `tiene_stock_prov` explícito | Forzar valor no-null al importar catálogo |
| 9 | **Inner_pack editado sin transacción** — cambiar `productos.inner_pack` a mitad de un recálculo lleva a redondeos incoherentes | UI edit | Baja | — | Lock durante recálculo |
| 10 | **`envio_full_pendiente` sin liberación** — session abandonada (ABIERTA >24h) bloquea uds en tránsito | `envio_full_pendiente` | Media (35 sesiones en DB) | Ninguna | Cron de limpieza de sesiones viejas |
| 11 | **`update_stock` RPC legacy** — todavía se llama desde código viejo; no registra movimiento | `db.ts`, `reconciliar_reservas` | Media | — | Migrar a `registrar_movimiento_stock` y eliminar RPC (ver memoria `project_movimiento_stock_migration`) |
| 12 | **Alertas no contextualizan estado** — `alertas[]` es string array; no hay sticky-note ni histórico por alerta (no se sabe cuándo se disparó) | `intelligence.ts:1589-1652` | Baja | — | Tabla `alertas_history` |
| 13 | **Webhook ML no verifica secret** | `api/ml/webhook/route.ts` | Baja (URL oscura) | — | Verificar header `x-signature` con secret de `ml_config` |
| 14 | **`ml_items_map` y `composicion_venta` inconsistentes** | `store.ts` | Media | Diferentes endpoints de reparación | Job de reconciliación + tests |

---

## 15. Forecast accuracy (PR1+PR2 de 3)

Medición de error de `vel_ponderada` sobre ventanas móviles. PR1 (este) implementa la medición sin alertas ni UI; PR2 engancha alertas al motor; PR3 agrega TSB para clase Z.

### 15.1 Tablas

| Tabla | Propósito |
|---|---|
| `forecast_snapshots_semanales` | Una fila por `(sku_origen, semana_inicio)`. Guarda el forecast que estaba vigente ese lunes. `origen='real'` vs `'reconstruido'`. `en_quiebre` es **NULLABLE**: `NULL` en filas reconstruidas o cuando `stock_snapshots` no cubre los 7 días previos. |
| `forecast_accuracy` | Métricas por `(sku_origen, ventana_semanas, calculado_at)`. Ventanas fijas 4/8/12. FK a `sku_intelligence(sku_origen)` ON DELETE CASCADE. |

### 15.2 Fórmulas (`src/lib/forecast-accuracy.ts`)

```
error_i = actual_i − forecast_i             # positivo = subestimamos
WMAPE   = Σ|error_i| / Σ actual_i           # NULL si Σactual=0
BIAS    = Σ error_i / n                     # promedio con signo
MAD     = Σ|error_i| / n
TS      = Σ error_i / MAD                   # NULL si MAD=0
```

Reglas:
- Tomar últimas N semanas cerradas (`ventanaSemanas` = 4|8|12).
- Excluir semanas con `en_quiebre=true` **o** `en_quiebre=null`.
- `semanas_evaluadas < 4` ⇒ todas las métricas NULL y `es_confiable=false`.

Benchmark del manual (Parte 2 §6.6.2): WMAPE < 20 % para A, < 35 % para B, `|TS| < 4` target.

### 15.3 Endpoints

| Método | Path | Función |
|---|---|---|
| POST | `/api/intelligence/forecast-accuracy` | Valida `Authorization: Bearer ${CRON_SECRET}` (o `x-cron-secret`). Corre `snapshotSemanalActual()` + `calcularYGuardarAccuracy()`. |
| GET | `/api/intelligence/forecast-accuracy?sku_origen=X` | Últimas 3 corridas × 3 ventanas del SKU. Lectura pública. |

### 15.4 Cron

```
0 11 * * *   /api/intelligence/recalcular           (ya existía)
0 12 * * 1   /api/intelligence/actualizar-lead-times (ya existía)
30 12 * * 1  /api/intelligence/forecast-accuracy    ← NUEVO
```

### 15.5 Backfill

Script `scripts/backfill-forecast-snapshots.ts` (o via SQL directo; éste se usó en producción). Reconstruye los últimos 12 lunes cerrados usando `ventas_ml_cache` + `composicion_venta` con las mismas fórmulas que el motor P2. Todas las filas reconstruidas llevan `origen='reconstruido'` y `en_quiebre=NULL`. El primer snapshot con `origen='real'` lo graba el cron cada lunes.

### 15.6 Alertas en el motor (PR2)

El paso 19 del motor lee `forecast_accuracy` al arranque de `recalcularTodo()` (función `ultimasMetricasAccuracy(sb, 8)`; una sola query, sin N+1) y pasa un `Map<sku_origen, MetricaActual>` al loop por SKU. La lógica de juicio está en `evaluarAlertasForecast(row, metrica)` (puro, exportado desde `intelligence.ts`, testeado en `forecast-accuracy.test.ts`).

Reglas:
- Sólo `es_confiable=true` → nunca alertar sobre métricas reconstruidas/no-confiables.
- Clase Z excluida de `forecast_descalibrado_*` (es ruido de intermitencia; PR3 lo trata con TSB).
- A/B solamente en las 3 alertas.
- Falla silenciosa: si `forecast_accuracy` no existe o la query se cae, el motor continúa sin las alertas.

### 15.7 Columnas cacheadas en `sku_intelligence` (PR2, migración v52)

```sql
ALTER TABLE sku_intelligence
  ADD COLUMN forecast_wmape_8s             numeric NULL,
  ADD COLUMN forecast_bias_8s              numeric NULL,
  ADD COLUMN forecast_tracking_signal_8s   numeric NULL,
  ADD COLUMN forecast_semanas_evaluadas_8s int NULL,
  ADD COLUMN forecast_es_confiable_8s      boolean NULL,
  ADD COLUMN forecast_calculado_at         timestamptz NULL;
```

Redundantes con `forecast_accuracy`, cacheadas por el motor en el upsert final para que la UI filtre/ordene sin joins. Índice parcial `idx_sku_intel_forecast_ts` acelera el tab Accuracy.

### 15.8 Tab `📊 Accuracy` (PR2)

Botón nuevo en el header de `AdminInteligencia` (patrón `vistaAccuracy` boolean). Contenido:

- **Banner contextual**: `📊 Forecast accuracy — X ESTRELLAS descalibradas · Y SKUs A/B con sesgo sostenido · Última medición: …`
- **Pills de filtro**: "Solo ESTRELLA", "Subestimamos demanda" (`bias>0`), "Sobrestimamos demanda" (`bias<0`).
- **Tabla**: SKU + Nombre, Cuadrante, ABC-XYZ, Vel ponderada, WMAPE (%), Bias con signo, TS con color (rojo ABS>4, ámbar >2), chip de alerta (🔴/🟡), semanas confiables.
- **Orden default**: ESTRELLA crítica → CASHCOW/VOLUMEN → REVISAR; secundario `ABS(TS)` DESC.
- **Placeholder** si no hay `es_confiable=true` aún: "Aún no hay métricas confiables — primera medición real **2026-05-18**".
- 🆕 **Banner ⏰ estacionales vencidos** (PR4 Fase 1): si hay SKUs con `es_estacional=true AND estacional_revisar_en < hoy`, se muestra contador + query SQL para listar detalles. Se oculta cuando el contador es 0.

## Metadata

- **Fecha de generación:** 2026-04-16 (actualizado 2026-04-17 con PR1 forecast accuracy)
- **Último commit revisado:** `352e7a4` (`fix(ml/webhook): parsear formato real de stock-locations`)
- **Snapshot del motor al momento de redactar:** último `recalcularTodo()` corrido el **2026-04-17 01:52 UTC** — 533 SKUs.
- **Archivos fuente principales:** `src/lib/intelligence.ts` (1 766 LOC), `src/lib/intelligence-queries.ts` (635 LOC), `src/lib/reposicion.ts` (199 LOC), `src/lib/rampup.ts` (41 LOC), `src/components/AdminInteligencia.tsx` (3 315 LOC), `src/app/api/intelligence/**` (8 rutas), `vercel.json` (16 crons).
- **Complemento obligatorio:** `docs/banva-bodega-estado-actual.md` (estado general del sistema, data viva, deuda técnica cross-módulo).
- **Próxima regeneración recomendada:** cuando cambie `src/lib/intelligence.ts` o el schema `sku_intelligence` (cualquiera de los dos invalida el mapa de pasos y el catálogo de columnas). Como rutina: al inicio de cada sprint que toque el motor.
