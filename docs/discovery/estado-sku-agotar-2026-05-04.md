# Discovery — `productos.estado_sku = 'agotar'` en BANVA

**Fecha:** 2026-05-04
**Origen:** Discovery anterior detectó 6 SKUs (`no_existe_en_sku_node_policy`) marcados `agotar` con venta activa, OC reciente y motor viejo recomendando comprar. Owner pidió clarificar la doctrina.
**Tipo:** read-only.

---

## TL;DR operativo

`agotar` **no** significa "discontinuar". Significa: **"este SKU se sigue vendiendo, pero no se reabastece y se publica al máximo en Flex (sin buffer 2/4) hasta que el stock baje a cero"**. Es un estado intermedio voluntario manejado por la UI admin para acelerar la salida del inventario.

| Estado | Significado real | Comportamiento sistema |
|---|---|---|
| `activo` (o NULL) | Operación normal | Entra al motor, recibe policy, buffer Flex 2/4 |
| **`agotar`** | **Vender lo que queda al máximo, no recomprar** | NO entra a `sku_node_policy`. Buffer Flex = 0 (publica todo). Pricing normal |
| `descontinuado` | Fuera del catálogo | Pricing y motor lo skipean explícitamente |
| `sin_stock_proveedor` | Mencionado en `intelligence.ts:1331` | Categoría declarativa, no observada hoy en datos |

---

## 1. Definición formal — citas

### Comment de columna (Supabase)

```
Estado operacional del SKU. Valores observados hoy (2026-05-02): "activo" o NULL.
NULL = no clasificado todavía; el sistema infiere actividad desde sku_intelligence
(vel_30d, vel_60d, dias_en_quiebre). Sprint futuro migrará esta columna a un ENUM
con valores explícitos: "activo" (vel > 0), "dormido" (vel_30d=vel_60d=0 ≥ 60 días),
"phaseout" (CZ no_reorder, candidato a borrado), "descontinuado" (snapshot pre-DELETE
para auditoría). Actualmente las decisiones operativas usan sku_intelligence +
policy_templates, no este campo. NO escribir aquí desde código nuevo hasta que el
ENUM exista.
```

**Lectura clave**: el comment **no contempla `agotar`**. La doctrina escrita es `activo / dormido / phaseout / descontinuado`. `agotar` no aparece en la doctrina formal de Supabase.

### Confirmación operativa (UI admin, `src/app/admin/page.tsx:5946`)

Al marcar bulk como `agotar`, el modal de confirmación dice literalmente:

> "Marcar N SKUs como AGOTAR? Se publicara toda unidad en bodega en Flex
> ignorando el buffer (2/4). El sync a ML se dispara automaticamente."

Y la etiqueta del producto cuando está `agotar` (`page.tsx:6427`):

> "🏁 Sin buffer Flex — publicara toda unidad en bodega en ML."

Comparada con `descontinuado` (`page.tsx:6432`):

> "✕ Fuera del motor de inteligencia. No se calcula reposicion ni alertas."

### En docs

- `docs/sprints/sprint-4.3a-importar-viejo-flex.md:50`: usa "agotar" como verbo, no como estado: *"CZ | 0 | 0 | Cola muerta — agotar"* (acción recomendada, no flag).
- `docs/discovery/lifecycle-doctrine-2026-05-03.md:83`: lista los estados que admite el código (`'activo' | 'descontinuado' | 'sin_stock_proveedor' | ...`) — **no menciona `agotar`**.
- `docs/schema-audit-2026-05.md:2227`: documenta la columna con default `'activo'`.

**No hay definición formal en `/docs/policies/` ni `/docs/manuales/`.** `agotar` es una decisión operativa que la UI introdujo; la doctrina escrita aún no lo recogió.

---

## 2. Implementación en código

### 2.1 Escritura — solo desde la UI admin

Único lugar que escribe `'agotar'`:

| Archivo | Línea | Trigger |
|---|---|---|
| `src/app/admin/page.tsx` | 5961 | Bulk update vía botón "Marcar agotar" en panel inventario |
| `src/app/admin/page.tsx` | (otro botón individual) | Switch por SKU en pestaña inventario |

Ambos persisten a `productos.estado_sku = 'agotar'` y a `audit_log` con `accion='estado_sku_change'`, `params.source='admin_inventario_bulk'` o `admin_inventario_button`.

**No hay escritura automática.** Ningún cron/RPC/trigger setea `agotar`. Es 100% decisión humana.

### 2.2 Lecturas (cómo cambia comportamiento)

| Archivo | Línea | Comportamiento al ver `'agotar'` |
|---|---|---|
| `src/app/api/ml/stock-sync/route.ts` | 175-176 | `buffer = 0` (vs 2 default / 4 shared) → publica todo en Flex |
| `src/app/api/ml/activate-with-stock/route.ts` | 53 | Idem: `buffer = 0` al activar Flex con stock disponible |
| `supabase/migrations/.../sprint43a_target_dias_flex.sql:214` | filtro `WHERE estado_sku = 'activo' OR estado_sku IS NULL` | **Excluido** del cron `/api/policy/sync-from-templates` → no entra a `sku_node_policy` |
| `supabase/migrations/.../sprint2_populate_sku_node_policy.sql:255` | mismo filtro | Idem |

**Por contraste**, lecturas que tratan distinto a `descontinuado` pero **no a `agotar`**:

| Archivo | Línea | Comportamiento |
|---|---|---|
| `src/lib/intelligence.ts:797` | `if (p.estado_sku !== "descontinuado") allSkusOrigen.add(...)` | Solo `descontinuado` se excluye del motor; `agotar` SÍ entra |
| `src/app/api/pricing/markdown-auto/route.ts:220` | `if (p.estado_sku === "descontinuado") continue` | Pricing skip solo descontinuado; `agotar` recibe pricing normal |
| `src/app/api/pricing/recalcular-floors/route.ts:177` | idem | idem |

**Lectura clave**: el motor viejo (`intelligence.ts`) **NO filtra por `agotar`** — por eso `sku_intelligence` los sigue calculando con todo (`vel`, `pedir_proveedor`, `mandar_full`, etc.). Lo que filtra `agotar` es el cron que crea `sku_node_policy`. Esa asimetría explica el síntoma observado (motor viejo sugiere comprar, motor nuevo lo invisibiliza).

---

## 3. Schema y constraints

| | Valor |
|---|---|
| `data_type` | `text` (no enum) |
| CHECK constraint que limite valores | **ninguno** |
| COMMENT en columna | sí, ver §1 (no menciona `agotar`) |
| Default | `'activo'` (per `schema-audit-2026-05.md:2227`) |

**Cualquier string es válido en DB.** La validación es solo del lado de la UI (3 botones: activo / agotar / descontinuado).

---

## 4. Distribución actual

| `estado_sku` | productos | creados últ 30d | actualizados últ 30d |
|---|---:|---:|---:|
| **NULL** | 414 | 31 | 97 |
| `activo` | 73 | 73 | 73 |
| **`agotar`** | **22** | 0 | 19 |

Total: 509 productos. Cero `descontinuado` en datos hoy.

**Observación**: 73 `activo` con `creados_30d = 73` y `updated_30d = 73` — todos los `activo` son nuevos. Esto sugiere que el campo solo se setea explícitamente cuando alguien crea un producto vía la UI moderna o cuando se marca `agotar`. Los 414 NULL son los SKUs históricos.

19/22 SKUs `agotar` se actualizaron en los últimos 30 días → flag operativamente vivo.

---

## 5. Historial de los 6 SKUs específicos

| SKU | estado_sku | created | last_update | días desde update |
|---|---|---|---|---:|
| JSAFAB422P20S | `agotar` | 2026-02-26 | 2026-04-29 | 4 |
| BOLMATCUERNEG2 | `agotar` | 2026-02-26 | 2026-04-27 | 6 |
| LITAF400G4PMT | `agotar` | 2026-02-26 | 2026-04-27 | 6 |
| TXV23QLRM20OV | `agotar` | 2026-03-10 | 2026-04-27 | 7 |
| **TX2ALIMFP5070** | **NULL** | 2026-03-11 | 2026-03-11 | 53 |
| JSAFAB429P20S | `agotar` | 2026-02-26 | 2026-02-26 | 67 |

**Hallazgo importante**: TX2ALIMFP5070 NO está marcado `agotar` (su `estado_sku` es NULL). Pero el discovery anterior lo agrupó en "no_existe_en_sku_node_policy". **Eso significa que hay otra razón distinta a `agotar` por la que un SKU puede no entrar a `sku_node_policy`** (probablemente falta de clasificación ABC/XYZ o falta de `costo_promedio` o falta de velocidad). El bucket "no_existe_en_sku_node_policy" en el discovery anterior **no es 100% atribuible a `agotar`** — al menos 1/6 es por otra causa. Vale auditarlo aparte.

### Audit log — todos los cambios estado_sku son manuales

| | n |
|---|---:|
| Total cambios `estado_sku_change` (últimos 30d) | 27 |
| → a `agotar` | 19 |
| → a NULL/activo (deshacer) | 8 |
| `source='admin_inventario_bulk'` (botón bulk) | 15 |
| `source='admin_inventario_button'` (toggle individual) | 12 |
| Primer cambio | 2026-04-25 |
| Último cambio | 2026-04-30 |

**Patrón**: ráfagas de bulk en fechas específicas (2026-04-27, 2026-04-29, 2026-04-30) — Vicente sentándose a clasificar lotes manualmente. Hay toggling rápido en algunos SKUs (`TXV24QLBRBA15`, `TXV23QLRM20OV`, `JSAFAB428P20S` cambian agotar→null→agotar en 5 segundos el 2026-04-27): explorando UI o corrigiendo errores de click.

JSAFAB422P20S específicamente: marcado `agotar` el **2026-04-29 18:30:57** (admin_inventario_bulk). La OC-006 a Idetex con 8 uds del mismo SKU es del **2026-04-28** — fue emitida ANTES del cambio a agotar. Coherente: la OC fue parte del último lote, y al día siguiente Vicente marcó agotar. **No es un error de estado**: es el patrón "compré un último lote, ahora a vaciarlo".

---

## 6. Diferencia con otros estados (lo que efectivamente hace cada uno)

| Estado | Motor viejo lo ve | Cron policy lo ve | Pricing lo ve | Buffer Flex |
|---|---|---|---|---|
| `activo` | sí | sí | sí | 2 (default) o 4 (shared) |
| **`agotar`** | **sí** | **NO** | **sí** | **0 (publica todo)** |
| `descontinuado` | NO | NO | NO | NO se publica |
| NULL | sí | sí (`OR estado_sku IS NULL`) | sí | 2/4 |

`agotar` es la única forma de pedirle al sistema "publicame todo en Flex sin buffer pero sigue calculando precios y métricas". Es un estado pegajoso intermedio.

---

## 7. Comportamiento operativo derivado

| Componente | Comportamiento con `agotar` |
|---|---|
| `intelligence.ts` (motor viejo) | **Sin cambios.** Calcula vel, ABC, XYZ, mandar_full, pedir_proveedor normalmente. Por eso JSAFAB422P20S motor viejo dice "comprar 14" — simplemente ignora el flag |
| `pricing.ts` / `markdown-auto` / `recalcular-floors` | **Sin cambios.** Pricing normal |
| Cron `sync-from-templates` (genera `sku_node_policy`) | **Excluido** del filtro `WHERE estado_sku='activo' OR IS NULL`. No entra al motor nuevo |
| `v_safety_stock`, `v_compras_pendientes`, `v_reposicion_explain` | **Ausentes** porque dependen de `sku_node_policy` |
| `/api/ml/stock-sync` | `buffer=0` → publica `disponible / unidades_pack` completo |
| `/api/ml/activate-with-stock` | Idem: si activás Flex y SKU está agotar, publica todo |
| UI admin (panel inventario) | Muestra badge "🏁 AGOTAR" amber + bulk select excluye los ya agotar |
| Op Limpieza / `pricing-config/skus` | Lectura informativa, sin lógica especial |

---

## 8. Conclusión — qué significa `agotar` operativamente

**Definición efectiva (derivada de la UI + las lecturas en código):**

> Un SKU `agotar` es uno que **se sigue vendiendo activamente** pero el dueño decidió **no reabastecer**. La señal al sistema es: maximizar la salida del stock disponible (publicar todo en Flex sin buffer) sin destruir las métricas (pricing y motor viejo siguen funcionando) hasta que stock = 0. Es una etapa **previa** a `descontinuado`.

**Implicancias para el motor nuevo y Sprint 5.5 v3:**

1. La asimetría observada en JSAFAB422P20S **no es un bug del Sprint 5.5 v3**. Es un comportamiento intencional: motor nuevo (vía `sku_node_policy`) respeta `agotar` y no sugiere reabastecer. Motor viejo (`sku_intelligence`) no filtra por `agotar`, por eso sigue sugiriendo `pedir_proveedor=14`.

2. Los SKUs `agotar` que aparecen en motor viejo con `pedir_proveedor>0` son **falsos positivos del motor viejo**, no falsos negativos del motor nuevo. La UI admin muestra `accion="MANDAR_FULL"` y el cuadrante ESTRELLA porque las velocidades siguen vivas, pero la decisión humana ya fue "no comprar más".

3. La OC-006 emitida el 2026-04-28 (pre-cambio a `agotar`) es legítima: fue el último lote autorizado. Cuando llegue, su recepción aumentará stock_bodega y la lógica `buffer=0` la pondrá toda en Flex.

4. **El motor viejo debería igualar la doctrina** y filtrar `agotar` de su `pedir_proveedor`. Eso eliminaría la divergencia y los SKUs como JSAFAB422P20S desaparecerían del bucket "solo viejo". No es scope Sprint 5.5 v3, pero es un gap real entre motor viejo y la doctrina actual.

5. **El comment de columna debería actualizarse** para incluir `agotar` en la doctrina formal junto a `activo / dormido / phaseout / descontinuado`. Hoy `agotar` está implementado en código pero no documentado en el ENUM aspiracional.

### Inconsistencia secundaria detectada

TX2ALIMFP5070 está como `estado_sku=NULL` pero el discovery anterior lo agrupó en `no_existe_en_sku_node_policy`. Eso significa que hay **otra causa** (probablemente: SKU sin ABC/XYZ asignado, o sin costo, o sin clasificación template) por la que un producto activo no tiene fila en `sku_node_policy`. Auditarlo en discovery aparte si interesa cerrar esa última divergencia entre los 38 "solo viejo".

### Recomendaciones (no acción autónoma)

1. **Dejar Sprint 5.5 v3 como está** — el motor nuevo está correcto al ignorar `agotar`. No es bug.
2. **Cuando alguien tenga tiempo**: agregar filtro `estado_sku NOT IN ('agotar','descontinuado')` en `intelligence.ts` `pedir_proveedor` para alinear el motor viejo a la doctrina y eliminar la divergencia restante.
3. **Actualizar `COMMENT ON COLUMN productos.estado_sku`** para reconocer `agotar` formalmente y documentar su semántica (publicar sin buffer, no entrar a policy, vender hasta cero).
4. **Auditar TX2ALIMFP5070** y los demás "solo viejo" no-`agotar` (~5 SKUs) para entender la causa secundaria.

---

*Discovery generado por Claude Opus 4.7 (1M context) el 2026-05-04 bajo `feedback_banvabodega_autonomy`.*
