# Estados operacionales del SKU — Policy vinculante

> **Status:** Vinculante (formalizada 2026-05-04). Owner: Vicente Elías.
> Si código contradice este doc, corregir código (per `feedback_disonancia_policy_vs_manual`).
> Origen: `docs/discovery/estado-sku-agotar-2026-05-04.md`.

## Resumen

`productos.estado_sku` es un flag **operacional** seteado manualmente desde
`/admin → Inventario`. Define cómo el resto del sistema trata al SKU para
publicación, reposición y pricing. **Cero escritura automática**: solo humanos
vía UI. Toda transición queda en `audit_log.accion='estado_sku_change'`.

## Estados válidos

| Estado | Significado operativo | Default |
|---|---|---|
| `activo` | Operación normal: vende, se reabastece, publica con buffer | sí (productos creados desde UI moderna) |
| **`agotar`** | **Vender lo que queda al máximo, no recomprar** | — |
| `descontinuado` | Fuera de catálogo — no vende, no se publica | — |
| `dormido` | (Futuro, no implementado) `vel_30d=vel_60d=0 ≥ 60d` con stock | — |
| NULL | Legacy / sin clasificación. Se trata como `activo` | sí (414/509 SKUs hoy) |

## Tabla de comportamiento por componente

| Componente | `activo` / NULL | **`agotar`** | `descontinuado` |
|---|---|---|---|
| `intelligence.ts` (motor viejo) | calcula normal | **calcula normal** (gap conocido — no respeta el flag) | excluido (`intelligence.ts:797`) |
| `sku_intelligence` (cache) | actualizado | **actualizado** | no se actualiza |
| Pricing — `markdown-auto`, `recalcular-floors` | aplica markdown | **aplica markdown** | excluido (`pricing/markdown-auto:220`, `pricing/recalcular-floors:177`) |
| Cron `sync-from-templates` (genera `sku_node_policy`) | incluido | **EXCLUIDO** (filtro `WHERE estado_sku='activo' OR IS NULL`) | EXCLUIDO |
| Motor nuevo (`v_safety_stock`, `v_compras_pendientes`, `v_reposicion_explain`) | aparece | **NO aparece** (depende de `sku_node_policy`) | NO aparece |
| `/api/ml/stock-sync` buffer Flex | 2 default / 4 shared | **0 (publica todo)** | no publica |
| `/api/ml/activate-with-stock` | buffer 2/4 | **buffer 0** | no activa |
| UI panel inventario | sin badge | badge amber 🏁 AGOTAR | badge rojo ✕ DESCONTINUADO |
| Bulk select panel inventario | seleccionable | excluido del bulk-marcar-agotar | excluido |

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
- **activo → agotar**: bulk desde `/admin/inventario` cuando dueño decide cerrar línea.
- **activo → descontinuado**: directo cuando se discontinúa sin querer venderlo más.
- **agotar → descontinuado**: cuando stock_total llega a 0 y ya no se quiere vender.
- **agotar → activo**: deshacer (lo permite la UI; observado en audit_log).

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
- `src/app/admin/page.tsx` — toggle individual por SKU (`source='admin_inventario_button'`).

**Cero escritura automática.** Ningún cron, RPC o trigger setea `estado_sku`.

Ningún código fuera de UI debe escribir aquí. Si necesitás cambiar estado masivamente, hacelo desde la UI o emite migration explícita con `[non-reversible:bulk-estado-sku]`.

## Por qué `agotar` no es lo mismo que `descontinuado`

| Pregunta | `agotar` | `descontinuado` |
|---|---|---|
| ¿Sigue vendiendo en ML? | sí, **al máximo** (buffer 0) | no |
| ¿Se calcula `pedir_proveedor` real? | motor viejo: sí (gap); motor nuevo: no | no en ningún motor |
| ¿Pricing aplica markdown? | sí | no |
| ¿Se cuentan sus ventas en métricas globales? | sí | sí (histórico) |
| ¿Se considera para reportería? | sí | depende del filtro |
| ¿Es reversible operativamente? | sí (toggle UI) | sí (toggle UI) pero raro |

**Mental model**: `agotar` es el período transitorio entre "este modelo lo vamos a discontinuar" y "está sin stock, sacarlo del catálogo". Mientras hay stock, agotás vendiendo al máximo.

## Comportamiento esperado del motor nuevo vs viejo

**Motor nuevo (vigente desde Sprint 5)**: respeta `agotar` correctamente — el cron `sync-from-templates` filtra `WHERE estado_sku='activo' OR IS NULL` antes de generar fila en `sku_node_policy`. Sin policy, el SKU no aparece en `v_compras_pendientes` ni `v_reposicion_explain`. **Doctrina alineada**.

**Motor viejo (`intelligence.ts` — todavía vivo)**: NO filtra por `agotar`, solo por `descontinuado` (`intelligence.ts:797`). Por lo tanto `sku_intelligence.pedir_proveedor` sigue calculándose para SKUs `agotar`, generando falsa señal de "comprar N uds" en pantallas que leen el cache viejo. Caso testigo: JSAFAB422P20S marcado agotar 2026-04-29, motor viejo sigue diciendo `pedir_proveedor=14`.

**Decisión pendiente** (no en scope hoy): alinear motor viejo agregando `&& p.estado_sku !== "agotar"` en el filtro de `pedir_proveedor`. Esto eliminaría el ruido visual de los 19 SKUs `agotar` que aparecen como "necesita pedir" en motor viejo.

## Distribución actual (snapshot 2026-05-04)

| `estado_sku` | productos | actualizados últ 30d |
|---|---:|---:|
| NULL | 414 | 97 |
| `activo` | 73 | 73 |
| **`agotar`** | **22** | 19 |
| `descontinuado` | 0 | 0 |

19/22 SKUs `agotar` se actualizaron en los últimos 30 días → flag operativamente vivo.

27 cambios `estado_sku_change` en audit_log últimos 30d, 100% manuales (15 bulk + 12 botón individual).

## Casos límite

- **Q: ¿Y si hay una OC abierta cuando marco agotar?**
  R: La OC se ejecuta normalmente (su recepción aumenta stock_bodega), y al estar `agotar`, el cron de stock-sync publica esas uds nuevas en Flex sin buffer. La OC no se cancela automáticamente. Si querés cortar la OC, hacelo manualmente.

- **Q: ¿Pricing baja precio automáticamente al marcar agotar?**
  R: No. Pricing es ortogonal a `estado_sku`. Tenés que setear precio_piso o `politica_pricing` por separado si querés markdown agresivo.

- **Q: ¿Se ven los SKUs agotar en /admin → Inteligencia?**
  R: Sí (motor viejo los muestra). Si el flag `INTEL_USE_NEW_ENGINE` está ON, **no aparecen** porque motor nuevo los excluye. Esa diferencia es esperada.

- **Q: ¿Y si el SKU está en quiebre proveedor cuando marco agotar?**
  R: motor viejo sigue marcando `es_quiebre_proveedor=true` y `accion='AGOTADO_SIN_PROVEEDOR'`. La señal "agotar" precede a la doctrina del quiebre — vos decidiste no recomprar antes que el sistema te diga "quiebre". Coherente.

- **Q: ¿Qué pasa con stock_full cuando marco agotar?**
  R: El stock que ya está en Full sigue vendiéndose normal. `mandar_full` puede seguir sugiriendo enviar más uds desde bodega (si hay holgura), porque la doctrina dice "vender al máximo, en cualquier canal". Eso es coherente con `buffer=0` en stock-sync.

## Schema y constraint actual

- Tipo: `text` (no enum). **Cualquier string es válido en DB**; la validación es client-side (3 botones en UI).
- CHECK constraint: ninguno.
- Default: `'activo'` (al insert desde admin moderna; legacy productos quedan NULL).
- COMMENT: actualizado 2026-05-04, ver `supabase/migrations/20260504181500_doc_agotar_comment_estado_sku.sql`.

**Hardening pendiente** (no en scope): migrar a ENUM Postgres con valores explícitos `('activo','agotar','descontinuado','dormido')` cuando el ENUM completo se acuerde.

## Ver también

- `docs/discovery/estado-sku-agotar-2026-05-04.md` — discovery que originó esta policy.
- `docs/discovery/lifecycle-doctrine-2026-05-03.md` — propuesta original de estados lifecycle (`piloto / validando / dormido / phaseout`) — aspiracional, no implementado todavía.
- `docs/policies/inventario-formulas.md` §1.5 — referencia desde el doc de fórmulas.
- `audit_log.accion='estado_sku_change'` — historial de transiciones.
- `src/app/admin/page.tsx:5946-5990` — UI bulk + audit log.
- `src/app/api/ml/stock-sync/route.ts:141-177` — buffer 0 para `agotar`.
- `supabase/migrations/20260504100000_sprint43a_target_dias_flex.sql:214` — filtro cron policy.

## Ejemplos reales (snapshot 2026-05-04)

- **JSAFAB422P20S** Trópico Rosa: marcado `agotar` el 2026-04-29 con OC-006 emitida 1 día antes (último lote). Vendió 9 uds en 30d, motor viejo dice "pedir 14" (falso positivo a corregir), motor nuevo lo invisibiliza correctamente.
- **TXV23QLRM20OV** Quilt Roma Olivo: toggling activo↔agotar 4 veces el 2026-04-27 12:34 — owner experimentando con UI o corrigiendo click.
- **LITAF400G4PMT** Toallas Family Menta: marcado `agotar` 2026-04-27, ESTRELLA AY motor viejo, accion `AGOTADO_SIN_PROVEEDOR` — caso típico de "el modelo se acabó, no hay reposición de fábrica, vendemos lo que queda".

---

*Policy formalizada por Claude Opus 4.7 (1M context) el 2026-05-04 bajo
`feedback_banvabodega_autonomy`, con base en discovery y comportamiento real
en código. Cero cambios de comportamiento — solo formalización.*
