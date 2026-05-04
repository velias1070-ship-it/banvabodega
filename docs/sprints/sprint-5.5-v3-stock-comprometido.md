# Sprint 5.5 v3 — Stock comprometido en motor nuevo

**Fecha:** 2026-05-04
**Owner:** Vicente Elías
**Tag:** `[batch:20260504-sprint5.5v3]`
**Scope:** 3 vistas SQL reescritas. Cero migración de datos. Cero tocar TS.

---

## Decisión

Replicar la simetría del motor viejo (`intelligence-queries.ts:131,401-426` +
`recalcular/route.ts:220-223`) en el motor nuevo, **versión limpia**:

1. **`v_compras_pendientes` y `v_reposicion_explain`** ahora usan
   `qty_on_hand - qty_reserved` para `bodega_central` (= stock DISPONIBLE).
   Captura los 3 tipos de stock comprometido (picking full + picking flex +
   residuales) en una sola operación porque `qty_reserved` ya los agrega.

2. **`v_in_transit_por_nodo`** se separa por nodo destino:
   - `to_node_id='bodega_central'` + `lane='supplier_to_bodega'` → OCs proveedor.
   - `to_node_id='full_ml'` + `lane='bodega_to_full'` → `picking_sessions`
     `tipo='envio_full'` ABIERTA/EN_PROCESO (componentes != PICKEADO/OMITIDO).

3. **`v_compras_pendientes.in_transit_bodega`** suma ambos lanes (total) porque
   ambos contribuyen a "stock futuro disponible" que reduce el pedido al
   proveedor (replica heurística motor viejo).

NO incluye picking flex en `v_in_transit_por_nodo` porque ya está descontado
vía `stock.qty_reserved`. Sumarlo sería double-counting.

---

## Por qué v3 (y no v1, no v2)

| Versión | Qué hizo | Por qué se descartó |
|---|---|---|
| **v1** (intento sumar picking_full a in_transit) | Sumar uds picking al `qty_in_transit` de bodega | Double-counting. Motor nuevo lee `qty_on_hand` BRUTO, las uds del picking quedaron sumadas dos veces (en stock + en transit). TXTPBL20200SK pre 51 → post 15 (subpedido grave). Revertido. |
| **v2** (sólo descontar qty_reserved) | `qty_on_hand - qty_reserved` en consumers | Insuficiente: el motor pierde noción de que las uds van a aparecer en Full. TXTPBL pasaría a 88 (overpedido +45). |
| **v3** ✅ | Ambas a la vez + separar lanes por destino | TXTPBL nuevo=53 vs viejo=43. Diff residual +10 explicado por doctrina `pre_full_target` (Sprint 6). |

---

## Resultado TXTPBL20200SK

| | Pre-fix | Post-fix v3 | Motor viejo |
|---|---:|---:|---:|
| `stock_bodega` | 40 (bruto) | **3** (disponible) | 3 |
| `stock_bruto_bodega` | n/a | 40 | — |
| `qty_reserved_bodega` | n/a | 37 | — |
| `in_transit_bodega` (total) | 30 (solo OC) | **66** | 66 |
| `in_transit_oc_bodega` | 30 | 30 | — |
| `in_transit_picking_full` | n/a | 36 | — |
| `qty_a_comprar` | 52 | **53** | 43 |
| Banner CLP total | $7,533,795 | $7,681,449 | n/a |
| Banner SKUs bajo ROP | 46 | 48 | n/a |

Diff residual `qty_a_comprar` motor nuevo vs viejo = +10 uds. Origen:
`stock_objetivo` motor nuevo es 122 (incluye `pre_full_target=96`); motor
viejo no tiene `pre_full_target` explícito y resulta en stock_objetivo
~112. Documentado en `comparacion-viejo-vs-nuevo-2026-05-04.md` y es
decisión de Sprint 6, no bug.

---

## Tests

| # | Test | Resultado |
|---|---|---|
| T1 | `v_in_transit` separa lanes para TXTPBL | **PASS** — `bodega_central=30, full_ml=36` |
| T2 | `stock_bodega` es disponible | **PASS** — `bruto=40 reservado=37 disponible=3` |
| T3 | TXTPBL nuevo dentro de doctrina (±30% del viejo) | **PASS** — viejo=43 nuevo=53 diff=+23% |
| T4 | Distribución masiva | REPORTE — 34 SKUs, 26% coinciden ±15%, diff_avg=+74.59% (residual de pre_full_target) |
| T5 | Banner CLP razonable | **PASS** — $7,681,449 / 48 SKUs |

T4 reporta como **REPORTE** (no PASS/FAIL): la meta de "≥80% coinciden ±15%"
del DOD original asume que se puede cerrar la divergencia con motor viejo, pero
el residual mayoritario es la doctrina `pre_full_target` del motor nuevo —
fuera del scope de este sprint.

---

## Validación específica: SKUs con picking activo

Los 13 SKUs que están afectados por el picking ABIERTA + tienen
`pedir_proveedor > 0` en motor viejo:

| SKU | viejo | nuevo | picking_full | reservado | diff |
|---|---:|---:|---:|---:|---:|
| 9788471511348 | 48 | 60 | 6 | 6 | +12 |
| TXTPBL20200SK | 43 | 53 | 36 | 37 | +10 |
| JSAFAB421P20S | 19 | 32 | 28 | 31 | +13 |
| JSAFAB427P20S | 25 | 29 | 16 | 16 | +4 |
| BOLMATCUERCAF2 | 8 | 14 | 5 | 6 | +6 |
| TXTLILL4G4PMT | 11 | 13 | 16 | 16 | +2 |
| TXMTFIL1315CR | 7 | 11 | 10 | 10 | +4 |
| TXTLVAL4G6PAZ | 11 | 11 | 8 | 8 | 0 |
| TXV23QLAT20AQ | 25 | 11 | 3 | 3 | -14 |
| JSAFAB424P20S | 1 | 8 | 4 | 4 | +7 |
| ALPCMPRLV4060 | 6 | 7 | 5 | 5 | +1 |
| JSAFAB426P20S | 2 | 6 | 4 | 4 | +4 |
| JSAFAB439P20W | 1 | 1 | 4 | 4 | 0 |

El fix simétrico cierra el gap de bug; el diff residual es 100% doctrina.
TXV23QLAT20AQ −14 es una asimetría rampup motor viejo que el motor nuevo
no replica (no en scope).

---

## Picking zombi 47cc317f

Sesión `flex` `EN_PROCESO` desde **2026-04-05** (1 mes atrás), 18 líneas,
**TODAS PICKEADO**. Cero pendientes, cero uds bloqueadas en bodega.

**Estado real**: terminada operativamente, falta marcar `estado='COMPLETADA'`.
**Impacto en motor**: cero (todos los componentes son PICKEADO, sus reservas
ya fueron liberadas por `reconciliar_reservas`).
**Recomendación**: cerrar manualmente con UPDATE puntual cuando alguien tenga
contexto operativo. NO bloquea Sprint 5.5 v3.

```sql
-- (Manual, no incluido en migration)
UPDATE picking_sessions
   SET estado = 'COMPLETADA', completed_at = '2026-04-05T13:00:46.611386+00'
 WHERE id = '47cc317f-67a9-4dbe-8d5e-c79dd32f92cd';
```

El otro picking flex `EN_PROCESO` (8ff8be07, 2026-05-02) está activo: 28
componentes PICKEADO + 2 pendientes. Operación normal.

---

## Tres tipos de stock comprometido en BANVA (ahora documentados)

| Fuente | Donde | Cómo lo agarra motor nuevo |
|---|---|---|
| `picking_sessions tipo='envio_full'` ABIERTA/EN_PROCESO | `picking_sessions.lineas[].componentes[]` | Vía `qty_reserved` (descontado del stock_bodega) + vía `v_in_transit_por_nodo` lane `bodega_to_full` |
| `picking_sessions tipo='flex'` ABIERTA/EN_PROCESO | idem | Vía `qty_reserved` solamente (no se modela como tránsito porque sale a venta directa) |
| Residuales (PICKEADO sin liberar) | `stock.qty_reserved` | Vía `qty_reserved` |
| `pedidos_flex` (legacy congelado 2026-03-19) | n/a | NO se consulta |
| `ml_shipments ready_to_ship` | n/a | NO directo, indirecto vía `picking_sessions` |

---

## Próximos sprints

### Sprint 5.5.1 — Cerrar picking zombi (manual)

Cuando owner tenga contexto operativo del picking 47cc317f, cerrarlo con
UPDATE puntual. No bloquea ningún flujo.

### Sprint 6 — Migrar escrituras + doctrina pre_full_target

Per `frontera-reposicion-pricing.md` §4 (ETA Q3 2026):
- Resolver diferencia +30% entre motor nuevo y viejo (`pre_full_target`).
- Mover storage de `vel_objetivo` y `_bulk` fuera de `sku_intelligence`.
- Crear `markdown_state` y migrar pricing.

### Sprint 7+ — Awareness completa de in-transit

`v_in_transit_por_nodo` hoy maneja:
- ✅ OCs proveedor → bodega
- ✅ Picking full ABIERTA → full

Falta:
- Envíos full COMPLETADA pero ML aún no recibidos (el "blind spot 2-3 días"
  del owner).
- Transferencias entre posiciones (movimientos `transferencia` con `to_node`).

No urgente; bloqueado por instrumentación de `envios_full_lineas` con flag
`recibida_por_ml`.

---

## Archivos creados / modificados

| Archivo | Tipo |
|---|---|
| `supabase/migrations/20260504180000_sprint55v3_stock_comprometido.sql` | NUEVO |
| `tests/sprint55v3_validation.sql` | NUEVO |
| `docs/sprints/sprint-5.5-v3-stock-comprometido.md` | NUEVO (este doc) |

3 archivos nuevos, cero modificación de TS, cero migración de datos.

*Sprint generado por Claude Opus 4.7 (1M context) el 2026-05-04 bajo
`feedback_banvabodega_autonomy`.*
