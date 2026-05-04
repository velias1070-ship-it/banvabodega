# Estados operacionales del SKU — Policy vinculante

> **Status:** Vinculante (versión 2026-05-04 PM, post-revert). Owner: Vicente Elías.
> Si código contradice este doc, corregir código (per `feedback_disonancia_policy_vs_manual`).
> Origen: `docs/discovery/estado-sku-agotar-2026-05-04.md` + `docs/discovery/estados-y-flags-2026-05-04.md`.
> Historial: la versión AM de este doc decía que `agotar` excluía del motor nuevo. Owner aclaró
> después que `agotar` es SOLO toggle de buffer Flex. Revisado el mismo día. Ver
> `docs/sprints/sprint-5.5.2-revert-agotar-filter.md`.

## Resumen

`productos.estado_sku` es un flag **operacional** seteado manualmente desde
`/admin → Inventario`. Define cómo el resto del sistema trata al SKU para
publicación, reposición y pricing. **Cero escritura automática**: solo humanos
vía UI. Toda transición queda en `audit_log.accion='estado_sku_change'`.

## Estados válidos

| Estado | Significado operativo | Default |
|---|---|---|
| `activo` | Operación normal: vende, se reabastece, publica con buffer 2/4 | sí (productos creados desde UI moderna) |
| **`agotar`** | **Vender al máximo sin reserva (buffer Flex = 0). Sigue comprando + sigue en motor.** | — |
| `descontinuado` | Fuera de catálogo — no vende, no se publica, no entra a motor ni pricing | — |
| `dormido` | (Futuro, no implementado) `vel_30d=vel_60d=0 ≥ 60d` con stock | — |
| NULL | Legacy / sin clasificación. Se trata como `activo` | sí (414/509 SKUs hoy) |

## Tabla de comportamiento por componente

| Componente | `activo` / NULL | **`agotar`** | `descontinuado` |
|---|---|---|---|
| `intelligence.ts` (motor viejo) | calcula normal | **calcula normal** | excluido (`intelligence.ts:797`) |
| `sku_intelligence` (cache) | actualizado | **actualizado** | no se actualiza |
| Pricing — `markdown-auto`, `recalcular-floors` | aplica markdown | **aplica markdown** | excluido (`pricing/markdown-auto:220`, `pricing/recalcular-floors:177`) |
| Cron `sync-from-templates` (genera `sku_node_policy`) | incluido | **INCLUIDO** (filtro `WHERE estado_sku IS DISTINCT FROM 'descontinuado'`) | EXCLUIDO |
| Motor nuevo (`v_safety_stock`, `v_compras_pendientes`, `v_reposicion_explain`) | aparece | **aparece** (calcula recompra normal) | NO aparece |
| `/api/ml/stock-sync` buffer Flex | 2 default / 4 shared | **0 (publica todo)** | no publica |
| `/api/ml/activate-with-stock` | buffer 2/4 | **buffer 0** | no activa |
| UI panel inventario | sin badge | badge amber 🏁 AGOTAR | badge rojo ✕ DESCONTINUADO |
| Bulk select panel inventario | seleccionable | excluido del bulk-marcar-agotar | excluido |

**Mental model corto**: `agotar` es **SOLO** el toggle de buffer Flex. Cambia
cómo se publica el stock (sin reserva), pero NO cambia cómo se compra ni
cómo se calcula el motor. Si querés además dejar de comprar, eso lo decide
el motor por velocidad/cobertura/celda — no por este flag.

## Transiciones (manuales)

```
        ┌──────────────────────────────────┐
        │                                  │
        ▼                                  │
       NULL ──────────► activo ◄──────► agotar ──────► descontinuado
                          │                                  ▲
                          └──────────────────────────────────┘
                          (toggle desde UI, no destructivo)
```

- **NULL → activo**: implícito, productos legacy se tratan como activo.
- **activo → agotar**: bulk desde `/admin/inventario` cuando dueño quiere publicar
  TODO el stock sin buffer (típicamente últimas unidades, evento, presión por
  rotar, etc.). NO implica decisión de no-recomprar.
- **activo → descontinuado**: directo cuando se discontinúa sin querer venderlo más.
- **agotar → descontinuado**: cuando el modelo se cierra definitivamente.
- **agotar → activo**: deshacer el toggle de buffer (lo permite la UI).

Toda transición se registra:

```
audit_log {
  accion: "estado_sku_change",
  entidad: "productos",
  entidad_id: <sku>,
  params: { nuevo: "<estado>", previo: "<estado>", source: "admin_inventario_bulk" | "admin_inventario_button" },
  created_at: timestamp
}
```

## Cómo se setea — solo desde UI

Únicos path en código que escriben `productos.estado_sku`:

- `src/app/admin/page.tsx:5961` — bulk update vía botón "Marcar AGOTAR" (`source='admin_inventario_bulk'`).
- `src/app/admin/page.tsx:6399` — toggle individual por SKU (`source='admin_inventario_button'`).

**Cero escritura automática.** Ningún cron, RPC o trigger setea `estado_sku`.

Ningún código fuera de UI debe escribir aquí. Si necesitás cambiar estado masivamente, hacelo desde la UI o emite migration explícita con `[non-reversible:bulk-estado-sku]`.

## Por qué `agotar` no es lo mismo que `descontinuado`

| Pregunta | `agotar` | `descontinuado` |
|---|---|---|
| ¿Sigue vendiendo en ML? | sí, **al máximo** (buffer 0) | no |
| ¿Se calcula `pedir_proveedor`? | **sí (motor viejo + nuevo)** | no en ningún motor |
| ¿Pricing aplica markdown? | sí | no |
| ¿Aparece en `sku_node_policy`? | **sí** | no (cron lo excluye) |
| ¿Aparece en `v_compras_pendientes`? | sí (si supera ROP) | no |
| ¿Se cuentan sus ventas en métricas globales? | sí | sí (histórico) |
| ¿Se considera para reportería? | sí | depende del filtro |
| ¿Es reversible operativamente? | sí (toggle UI) | sí (toggle UI) pero raro |

**Mental model**: `agotar` es el switch de "publicación sin buffer" (buffer Flex=0
en lugar de 2/4). Todo lo demás del sistema sigue tratando al SKU como `activo`.
Si encima querés no recomprar ese SKU, eso es decisión separada — no lo decide
el flag `estado_sku`. (Decisión separada se logra dejando que el motor lo
ponga en celda no_reorder, o marcándolo `descontinuado` cuando ya está cerrado).

## Por qué se revirtió la doctrina del filtro motor (2026-05-04 PM)

La versión AM de este doc decía que `agotar` excluía del motor nuevo via filtro
en `sync-from-templates`. Caso testigo que motivó la revisión:

- **JSAFAB422P20S** (Trópico Rosa). Owner emitió **OC-006 a Idetex el 2026-04-28**
  pidiendo más unidades. **Al día siguiente marcó `agotar`** porque quería publicar
  todo el stock disponible sin buffer Flex. Comportamiento esperado: la OC se
  recibe normal, el stock entra y se publica todo en Flex sin buffer, el motor
  sigue calculando recompra normal. Comportamiento real (versión AM):
  motor nuevo lo invisibilizaba — incoherente con la intención del dueño.

Owner clarificó: "agotar es SOLO toggle de buffer Flex". El sistema tiene
mecanismos separados para "no comprar" (celda CZ + `no_reorder`, o
`descontinuado`); no se mezclan con el flag de buffer.

Ver `docs/sprints/sprint-5.5.2-revert-agotar-filter.md`.

## Distribución actual (snapshot 2026-05-04 PM)

| `estado_sku` | productos | en `sku_node_policy` | actualizados últ 30d |
|---|---:|---:|---:|
| NULL | 414 | sí | 97 |
| `activo` | 73 | sí | 73 |
| **`agotar`** | **22** | **22 (post-revert)** | 19 |
| `descontinuado` | 0 | 0 | 0 |

Post-revert: los 22 `agotar` ahora aparecen en `sku_node_policy` (motor nuevo
los procesa). 27 cambios `estado_sku_change` en audit_log últimos 30d, 100%
manuales (15 bulk + 12 botón individual).

## Casos límite

- **Q: ¿Y si hay una OC abierta cuando marco agotar?**
  R: La OC se ejecuta normalmente (su recepción aumenta stock_bodega). El
  cron de stock-sync publica las uds nuevas en Flex sin buffer. La OC NO se
  cancela y el motor SIGUE pudiendo sugerir nuevas OCs (post-revert 2026-05-04).
  Si querés cortar la OC o dejar de comprar, hacelo manualmente o usá
  `descontinuado`.

- **Q: ¿Si marco agotar el motor sigue diciendo "comprar N uds"?**
  R: Sí. `agotar` no afecta el cálculo de `pedir_proveedor`. Si te sale ruido
  visual, considerá si el SKU debería ser `descontinuado` en su lugar.

- **Q: ¿Pricing baja precio automáticamente al marcar agotar?**
  R: No. Pricing es ortogonal a `estado_sku`. Tenés que setear precio_piso o
  `politica_pricing` por separado si querés markdown agresivo. (Hay 3 SKUs hoy
  con `agotar` + `liquidacion_accion` activa — coexisten sin conflicto).

- **Q: ¿Se ven los SKUs agotar en /admin → Inteligencia?**
  R: Sí en motor viejo y motor nuevo (ambos los procesan). Aparecen en
  `v_compras_pendientes` si superan el ROP — cero diferencia de visibilidad
  respecto a `activo`.

- **Q: ¿Y si el SKU está en quiebre proveedor cuando marco agotar?**
  R: Motor viejo marca `accion='AGOTADO_SIN_PROVEEDOR'` igual que antes. El
  flag `agotar` no influye. Coherente: `agotar` es solo cómo publicás, no si
  hay stock proveedor.

- **Q: ¿Qué pasa con stock_full cuando marco agotar?**
  R: El stock que ya está en Full sigue vendiéndose normal. `mandar_full`
  puede seguir sugiriendo enviar más uds desde bodega.

## Schema y constraint actual

- Tipo: `text` (no enum). **Cualquier string es válido en DB**; la validación es client-side (3 botones en UI).
- CHECK constraint: ninguno.
- Default: `'activo'` (al insert desde admin moderna; legacy productos quedan NULL).
- COMMENT: actualizado 2026-05-04 PM, ver `supabase/migrations/20260504190100_revert_agotar_comment_estado_sku.sql`.

**Hardening pendiente** (no en scope): migrar a ENUM Postgres con valores explícitos `('activo','agotar','descontinuado','dormido')` cuando el ENUM completo se acuerde.

## Ver también

- `docs/discovery/estado-sku-agotar-2026-05-04.md` — discovery original.
- `docs/discovery/estados-y-flags-2026-05-04.md` — discovery exhaustivo de TODOS los flags relacionados.
- `docs/sprints/sprint-5.5.1-alineacion-agotar.md` — sprint AM (revertido el mismo día).
- `docs/sprints/sprint-5.5.2-revert-agotar-filter.md` — revert.
- `audit_log.accion='estado_sku_change'` — historial de transiciones.
- `src/app/admin/page.tsx:5946-5990` — UI bulk + audit log.
- `src/app/api/ml/stock-sync/route.ts:141-177` — buffer 0 para `agotar` (único efecto real).
- `supabase/migrations/20260504190000_revert_agotar_filter_sync_templates.sql` — cron post-revert (filtra solo descontinuado).

## Ejemplos reales (snapshot 2026-05-04 PM, post-revert)

- **JSAFAB422P20S** Trópico Rosa: marcado `agotar` el 2026-04-29 con OC-006 emitida 1 día antes (último lote intencional **no-último**). Owner quiere seguir comprando + vender sin buffer. Post-revert: motor nuevo lo procesa, motor viejo lo procesa, recompra calculada normal. Coherente.
- **TXV23QLRM20OV** Quilt Roma Olivo: toggling activo↔agotar 4 veces el 2026-04-27 12:34 — owner experimentando con UI o probando buffer 0.
- **LITAF400G4PMT** Toallas Family Menta: marcado `agotar` 2026-04-27, ESTRELLA AY motor viejo, accion `AGOTADO_SIN_PROVEEDOR` — el modelo está sin stock en bodega ni proveedor. Post-revert el flag agotar no oculta esto; el motor sigue mostrando la realidad.

---

*Policy formalizada por Claude Opus 4.7 (1M context) el 2026-05-04, revisada el mismo día PM bajo
`feedback_banvabodega_autonomy`. Versión AM (con filtros agotar) revertida.*
