# Guía operativa — Motor nuevo de inteligencia

> Cómo leer y operar el motor nuevo desde la UI (`/admin` tab Inteligencia).
> Este documento está pensado para uso diario del owner. Para la doctrina
> vinculante ver `/docs/policies/motor-canonico.md`.

## Estado actual

Motor nuevo es **default operativo** desde 2026-05-05 (Sprint 8 Fase 1).
- UI canónica: `/admin` → tab **Inteligencia**.
- UI legacy de debug: `/admin/reposicion-suggestions` (banner amarillo,
  sigue viva como referencia post-mortem).
- Endpoint nuevo: `/api/intelligence/sku-venta-v2`.
- Endpoint viejo: `/api/intelligence/sku-venta` (lectura del motor viejo,
  mantenido para `reposicion-suggestions` y comparación).

---

## Diccionario de columnas

Lo que vas a ver en `/admin` tab Inteligencia, en orden de uso operativo:

| Columna | De dónde sale | Qué significa |
|---|---|---|
| `sku_origen` | `productos.sku` | SKU físico canónico. |
| `accion` | `v_reposicion_explain.accion` | Decisión operativa (ver tabla siguiente). |
| `cell` | `v_safety_stock.cell_efectiva` | Cuadrante ABC×XYZ con override aplicado. |
| `stock_total` | `stock_full + stock_bodega + stock_en_transito_oc` | Inventario total declarado. |
| `stock_total_efectivo` | `stock_total + in_transit_picking_full` | Inventario que el motor "ve" para decisiones. |
| `cob_full` | `v_reposicion_explain.cob_full` | Días de cobertura del Full. NULL si vel=0. |
| `dio` | `v_reposicion_explain.dio` | Days Inventory Outstanding (cuántos días tarda en venderse el inventario actual). |
| `qty_a_comprar` | `v_compras_pendientes.qty_a_comprar` | Cantidad a comprar al proveedor (>0 implica `accion=PEDIR_PROVEEDOR` o similar). |
| `pre_full_target` | `v_compras_pendientes.pre_full_target` | Stock objetivo en Full (cycle + safety). |
| `mandar_full_uds` | `v_compras_pendientes.mandar_full_uds` | Cuánto despachar bodega→Full hoy (>0 implica `accion=MANDAR_FULL`). |
| `reserva_flex_target` | `v_compras_pendientes.reserva_flex_target` | Cuánto bodega debe retener para Flex. `ROUND(d_avg_sem/7 × target_dias_flex)`. |
| `liquidacion_accion` | `v_reposicion_explain.liquidacion_accion` | Acción de markdown (`monitorear`, `descontar_15`, `descontar_30`, `liquidar`). |
| `liquidacion_descuento` | `v_reposicion_explain.liquidacion_descuento` | Descuento sugerido (% sobre lista). |
| `is_new_sku` | `v_reposicion_explain.is_new_sku` | true si el SKU está en lote inicial (sin historia de ventas suficiente). |
| `alertas` | `v_reposicion_explain.alertas` | Array de alertas autónomas activas (ver doctrina). |
| `alertas_count` | `v_reposicion_explain.alertas_count` | Cuántas alertas tiene el SKU (orden de prioridad UI). |

### Diferencia clave: `stock_total` vs `stock_total_efectivo`

El motor viejo solo vio `stock_total`. El motor nuevo descuenta el
**picking activo bodega→Full** (`in_transit_picking_full`, Sprint 7
Fase 0.A). Así, si hay 16 uds en camino al Full vía picking, el motor
nuevo no propone mandar más al Full ni pedir agresivo al proveedor.
Esa es la causa principal de divergencia entre motor viejo
("URGENTE") y motor nuevo ("PLANIFICAR/OK").

---

## Acciones — qué hacer cuando ves cada una

| `accion` | Qué hacer | Quién | Plazo |
|---|---|---|---|
| `URGENTE` | Sale flete urgente o se mueve picking interno hoy. Validar primero `cob_full` y si hay picking en curso (la columna `in_transit_picking_full` ya descuenta, pero conviene re-mirar). | Owner / operación | mismo día |
| `MANDAR_FULL` | Generar picking bodega→Full por `mandar_full_uds`. NO crear picking adicional si ya hay uno activo cubriendo el déficit. | Operario picking | 24-48 h |
| `PEDIR_PROVEEDOR` | Generar OC al proveedor por `qty_a_comprar`. Verificar precio en `proveedor_catalogo` y stock del proveedor (alerta `sin_stock_proveedor`). | Owner / compras | según lead time |
| `PLANIFICAR` | No hacer nada *hoy*. Mirar la cobertura proyectada y el `dio`. Vuelve a aparecer cuando el inventario baje. | Owner | cuando el motor lo cambie |
| `LIQUIDACION` | Aplicar `liquidacion_descuento` desde el módulo de pricing/markdown. Confirmar que `liquidacion_override` no esté seteado por error. | Owner / pricing | según banda |
| `OK` | Nada. SKU sano. | — | — |

**Regla operativa**: si la `accion` te parece equivocada en un caso
puntual, **no hardcodear** la corrección. Usar override por
`sku_node_policy` (ver siguiente sección) y dejar que el motor
recalcule.

---

## Cómo abrir la narrativa ⓘ (sistema de explicación)

Cada fila tiene un botón `ⓘ` (info). Al apretarlo, se abre un modal con
la narrativa **canónica** del SKU, leída desde `v_sku_explanation`.

7 secciones:

1. **velocidad** — `vel_decl_sem`, `vel_pre_quiebre`, qué velocidad usa hoy y por qué.
2. **celda** — Cuadrante ABC×XYZ con override aplicado (si lo hay).
3. **quiebre** — `dias_en_quiebre`, `factor_rampup_aplicado`, fecha de entrada al quiebre.
4. **compromisos** — Stock comprometido a pedidos Flex + picking activo bodega→Full + OCs abiertas con ETA.
5. **decision** — Por qué el motor decidió esta `accion` (ramas evaluadas: cob_full vs ROP, cobertura cruda <7d, lote inicial, etc.).
6. **liquidacion** — Banda DIO y descuento sugerido si aplica.
7. **alertas** — Lista de alertas autónomas con motivo.

**Cuándo usarla**: siempre que un SKU te sorprenda. Si la `accion` no
matchea tu intuición, la narrativa te explica qué entrada del motor te
está sorprendiendo (vel, cobertura, OC, picking).

---

## Override manual — cuando el motor está "desafinado"

El motor canónico **no se modifica desde código** para casos puntuales.
Toda corrección por SKU pasa por `sku_node_policy.{*_override}`.

| Override | Efecto | UI |
|---|---|---|
| `target_dias_full_override` | Cambia el horizonte de cobertura Full (default: A=42, B=28, C=14). | `/admin` → Inteligencia → fila → editar. |
| `target_dias_flex_override` | Cambia el horizonte de reserva Flex (default por ABC). | mismo lugar |
| `liquidacion_override` | Forza una `liquidacion_accion` específica (`monitorear`, `liquidar`, etc.). Sirve para SKU que el motor quiere liquidar pero hay decisión humana de aguantar. | mismo lugar |
| `cell_override` | Forza el cuadrante ABC×XYZ. Útil cuando el clasificador automático tiene poco histórico. | mismo lugar |

**Regla**: si más del 5% del universo activo tiene un override del mismo
tipo, el umbral default está mal calibrado. Replantear en sprint, no
seguir overrideando.

---

## FAQ operativo

**¿Cómo apago el motor nuevo si veo algo raro?**
- Tu navegador solamente: devtools → console:
  `localStorage.setItem("banva_ff_INTEL_USE_NEW_ENGINE", "false"); location.reload()`
- Toda la org: setear `NEXT_PUBLIC_INTEL_USE_NEW_ENGINE=false` en Vercel
  + redeploy (~2 min).
- Total (rollback código): `git revert` del commit Sprint 8 Fase 1.

**¿Por qué el motor nuevo dice `PLANIFICAR` y el viejo decía `URGENTE`?**
- Probablemente hay picking activo bodega→Full que el motor viejo no ve.
  Mirá la narrativa ⓘ sección "compromisos". Si confirmás picking en
  curso, el motor nuevo tiene razón.

**¿El motor viejo sigue corriendo?**
- Sí, el cron `/api/intelligence/recalcular` sigue ejecutándose 1 vez al
  día (11:00 UTC). Alimenta columnas legacy (`forecast_accuracy`,
  `margen_*`, `vel_objetivo`, `dias_sin_conteo`, `stock_danado_full`,
  `gmroi`) y escribe `factor_rampup_aplicado` que el motor nuevo
  consume. NO se le agrega lógica nueva. Borrar tras Sprint 9+.

**¿Dónde se calcula `reserva_flex_target`?**
- `v_compras_pendientes.reserva_flex_target =
   ROUND(d_avg_sem/7 × target_dias_flex)`. El motor viejo no la
  calculaba — usaba `flex-full.ts` con lógica heurística.

**¿`d_avg_sem` es lo mismo que `vel_ponderada` viejo?**
- Casi. `d_avg_sem` aplica `factor_rampup_aplicado` (post-quiebre) y
  reemplaza por `vel_pre_quiebre` cuando `dias_en_quiebre >= 14d` y la
  velocidad pre-quiebre es mayor. Es la velocidad que **el motor cree
  que va a sostenerse a futuro**, no la observada cruda.

**¿Por qué a veces `accion=URGENTE` con `cob_full > reorder_point`?**
- Sprint 7 Fase 1.1 agregó override por **cobertura cruda <7d**: si
  `stock_total < d_avg_sem × 1` (1 semana de cobertura cruda), se marca
  URGENTE aunque `cob_full` (que mira solo Full) esté arriba del ROP.
  Esto cubre el caso "tengo Full en orden pero bodega vacía y la
  próxima OC tarda 30d".

**¿Qué hace el banner amarillo en `/admin/reposicion-suggestions`?**
- Es `DebugBanner`. Avisa que esa vista es legacy del motor viejo y la
  canónica es `/admin` tab Inteligencia. Dismissable por sesión.

**¿Cómo agrego una alerta autónoma nueva?**
- Modificar `v_sku_alertas` con migración Atlas. Documentar la alerta
  en la doctrina (`/docs/policies/motor-canonico.md` P-MOT-2). NO
  agregar lógica de alerta en TypeScript.

**¿Qué pasa si edito directamente `sku_intelligence`?**
- El motor nuevo NO lee de `sku_intelligence` para decidir `accion`.
  Lee de las vistas. La excepción es `factor_rampup_aplicado` (escrita
  por motor viejo, consumida por `v_safety_stock`). Editar
  `sku_intelligence` directamente para otra cosa es bypass del motor y
  se va a sobrescribir en el próximo recálculo.
