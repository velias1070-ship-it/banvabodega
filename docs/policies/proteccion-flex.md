# Política — Protección Flex (no agotar bodega al mandar a Full)

**Vigencia**: 2026-05-05 → presente
**Sprint origen**: 7 Fase 0
**Vistas afectadas**: `v_compras_pendientes.mandar_full_uds`, `v_in_transit_por_nodo.lane_id='bodega_to_full'`

## Doctrina

`reserva_flex_target = vel_diaria × target_dias_flex` representa el stock mínimo que debe quedar en bodega para que Flex pueda seguir vendiendo durante `target_dias_flex` días sin quebrar.

`mandar_full_uds` **nunca** debe reducir `stock_bodega` por debajo de `reserva_flex_target`. Excepción: lote inicial de SKUs con `is_new_sku=true` puede ignorar la reserva (no hay vel histórica que proteger).

`deficit_full` descuenta `in_transit_picking_full` para evitar double-shipping. Si hay un picking activo que cubre el déficit, `mandar_full_uds = 0` hasta que ML confirme la recepción y la sesión se cierre.

## Decision tree (`v_compras_pendientes.mandar_full_uds`)

```
deficit_full := MAX(0, pre_full_target - stock_full - in_transit_picking_full)
disponible_para_full := MAX(0, stock_bodega - reserva_flex_target)

mandar_full_uds := CASE
  -- 1. Lote inicial nuevos: bodega>0, full=0, sin vel histórica
  WHEN is_new_sku=true AND stock_full=0 AND stock_bodega>0
  THEN LEAST(GREATEST(inner_pack, 2), stock_bodega)

  -- 2. Operativos vel>0: cubrir deficit_full sin agotar Flex
  WHEN vel_actual>0 AND deficit_full>0 AND disponible_para_full>0
  THEN LEAST(CEIL(deficit_full), disponible_para_full)

  -- 3. ELSE: nada para mandar
  ELSE 0
END
```

## Lane bodega_to_full en `v_in_transit_por_nodo`

`v_in_transit_por_nodo` modela 2 lanes:
- `supplier_to_bodega`: OCs proveedor en estado PENDIENTE/EN_TRANSITO/RECIBIDA_PARCIAL.
- `bodega_to_full`: pickings `tipo='envio_full'` con `estado IN ('ABIERTA','EN_PROCESO')` y componentes individuales con `estado='PICKEADO'`.

**Por qué PICKEADO y no PENDIENTE**: cuando un componente queda en `PICKEADO`, el RPC `registrar_movimiento_stock` ya descontó `stock_bodega`. ML aún no lo confirma como recibido en `meli_facility`. Por lo tanto esos uds están físicamente "in transit" entre bodega y Full.

**ETA estimada**: `ps.created_at + 3 días` (típico inbound ML).

## Casos testigo (2026-05-05)

| SKU | stock_bodega | reserva_flex | in_transit_picking_full | deficit_full | disponible | mandar_full_uds | Decisión |
|---|---|---|---|---|---|---|---|
| TXTPBL20200SK | 2 | 15 | 36 | 56 | 0 | **0** | Bodega < flex → no mandar; el picking cubre 36/56, esperar OC |
| JSAFAB438P20W | 3 | 1 | 4 | 9 | 2 | **2** | Manda 2 (picking cubre parte del déficit) |
| JSCNAE188P15W | 6 | 0 | 0 | — | — | **6** | Lote inicial new_sku |

## Anti-patrón pre-Sprint 7

Antes:
- `mandar_full_uds` solo se computaba para `is_new_sku=true` → SKUs operativos quedaban en NULL/0 aunque el motor decía MANDAR_FULL.
- `v_in_transit_por_nodo` filtraba componentes en estado **distinto** de PICKEADO (interpretaba la doctrina al revés). Resultado: 426 uds activamente en tránsito reportadas como 0.
- Doctrina del motor viejo decía "mandar todo lo que tengas en bodega" sin proteger Flex (ej: TXTPBL20200SK con 2 uds bodega sugería mandar 2, dejándola en 0).

## Reglas para agentes

1. Si modificás `mandar_full_uds`, mantené el orden del decision tree (lote inicial > operativo > else).
2. No agregues ramas que ignoren `reserva_flex_target` salvo en `is_new_sku=true`.
3. Si introducís un nuevo lane (`bodega_to_full_x`, `full_to_bodega`, etc.), debe sumar a `in_transit_picking_full` o a un campo nuevo, nunca al `in_transit_oc_bodega` original.
4. Si cambiás el filtro de pickings activos, recordá que `stock_bodega` ya descontó los componentes PICKEADOS — sumar PENDIENTES sería double-counting.
