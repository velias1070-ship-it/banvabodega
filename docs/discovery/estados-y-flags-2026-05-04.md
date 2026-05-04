---
title: "Discovery exhaustivo — estados/flags relacionados con 'agotar'"
date: 2026-05-04
owner: Vicente Elías
type: discovery (read-only)
related:
  - docs/policies/estados-sku.md
  - docs/discovery/estado-sku-agotar-2026-05-04.md
  - docs/sprints/sprint-5.5.1-alineacion-agotar.md
---

# Discovery — estados/flags relacionados con 'agotar' (BANVA Bodega)

## TL;DR

**Hay UN solo concepto humano "agotar"** (`productos.estado_sku='agotar'`), pero
hay **6 mecanismos distintos** que efectivamente "bloquean comprar" o "vender al
máximo" en el sistema. La mayoría son computados, NO humanos. La confusión más
común es entre:

1. `estado_sku='agotar'` (humano, 22 SKUs) — vender al máximo, no recomprar.
2. `sku_node_policy.action='no_reorder'` (computado, 438 SKUs) — celda CZ sin demanda.
3. `sku_node_policy.policy_status='blocked_no_cost'` (172 SKUs) — gate por costo faltante.
4. `sku_intelligence.accion ∈ {INACTIVO, DEAD_STOCK, AGOTADO_SIN_PROVEEDOR}` (computado, 145 SKUs).
5. `sku_intelligence.liquidacion_accion ≠ NULL` (computado, 140 SKUs) — afecta PRICING, no compra.
6. **NUEVO 2026-05-04** `sku_intelligence.accion = AGOTAR_NO_RECOMPRA` (override por `estado_sku='agotar'`, sprint 5.5.1).

`agotar` es el único de los 6 que **también** modifica buffer Flex (=0). Los demás
solo bloquean compra y/o ajustan markdown.

---

## 1. Columnas tipo "estado" / "flag" en las 3 tablas

### 1.1 `productos` — flags humanos

| Columna | Tipo | Default | Distribución actual |
|---|---|---|---|
| `estado_sku` | text | `'activo'` | NULL=414, activo=73, agotar=22, descontinuado=0 |
| `es_kvi` | boolean | `false` | false=509 (nadie marcó KVI todavía) |
| `politica_pricing` | text | — | "seguir"=509 (único valor presente) |
| `auto_postular` | boolean | — | false=509 |

**Nota**: `politica_pricing`, `auto_postular`, `es_kvi` son flags humanos teóricos
pero efectivamente sin uso real (todos al default). El único flag humano vivo
es `estado_sku`.

### 1.2 `sku_intelligence` — flags computados (NO humanos)

| Columna | Tipo | Distribución |
|---|---|---|
| `accion` | text | EXCESO=166, INACTIVO=116, OK=65, NUEVO=59, PLANIFICAR=46, AGOTADO_SIN_PROVEEDOR=28, MANDAR_FULL=17, EN_TRANSITO=7, URGENTE=4, DEAD_STOCK=1 |
| `es_catch_up` | boolean | catch_up=0 |
| `es_estacional` | boolean | estacional=3 (humano vía UI) |
| `es_holdout` | boolean | holdout=36 (computado por ABC + tendencia) |
| `es_pico` | boolean | pico=43 (computado) |
| `es_quiebre_proveedor` | boolean | true=504/509 (¡casi todos!) |
| `liquidacion_accion` | text | precio_costo=96, descuento_10=23, liquidar_activa=21, NULL=369 |
| `liquidacion_dias_extra` | integer | computado |
| `liquidacion_descuento_sugerido` | numeric | computado |
| `estacional_motivo`, `estacional_marcado_at`, `estacional_marcado_por`, `estacional_revisar_en` | metadata | sólo poblado para los 3 estacionales humanos |

**Hallazgo clave**: el único flag **humano** en `sku_intelligence` es `es_estacional`
(3 SKUs marcados manualmente vía UI). Todos los demás son computados.

### 1.3 `sku_node_policy` — política por (sku, nodo)

| Columna | Tipo | Distribución |
|---|---|---|
| `action` | enum `policy_action_enum` | no_reorder=438, reorder_normal=232, NULL=172, reorder_periodic=88, reorder_minimo=22, reorder_lt_corto=22 |
| `policy_status` | text | active=802, blocked_no_cost=172 |
| `manual_override` | boolean | true=0 (humano, sin uso real) |
| `promocion_activa` | boolean | true=50 (computado, "acelerando_fuerte"=26 / "acelerando"=24) |
| `promocion_motivo` | text | sólo "Promovido por aceleración (...)" |
| `cell_efectiva` | text | computado |
| `tendencia` | text | computado |

**Nodes**: `bodega_central` y `full_ml` (2 nodos).

**Hallazgo**: `manual_override` existe (toggle humano) pero no hay uno solo activo
en producción → no se usa.

---

## 2. Búsqueda textual de "agotar" en el repo

### 2.1 Código TypeScript (28 matches relevantes)

**`src/app/admin/page.tsx`** (UI bulk + toggle individual + badges):
- `:5930-5934` — filter `filteredNoAgotar`: omite ya-agotar del bulk picker.
- `:5943-5970` — `doBulkAgotar()`: bulk update DB + audit_log + sync inline ML.
- `:6376-6403` — 3 botones individuales `[Activo / Agotar / Descontinuado]`.
- `:6924-6926` — botón bulk "🏁 Marcar N como Agotar".
- `:6953-6963` — checkbox por fila, deshabilitado si ya agotar.
- `:7331, 7345` — copy de ayuda inline.
- `:7903-7913, 7992-7993` — formulario edit producto (mismo set 3 botones) + badge.

**`src/app/api/ml/stock-sync/route.ts:141-191`** — Buffer Flex:
- Línea 175: `const esAgotar = estadoBySkuOrigen[skuOrigen] === "agotar";`
- Línea 176: `const buffer = esAgotar ? 0 : (sharedOrigins.has(skuOrigen) ? 4 : 2);`
- Línea 230: response expone `agotar_bypassed: agotarCount`.

**`src/app/api/ml/activate-with-stock/route.ts:50-62`** — mismo patrón al activar
publicación con stock pre-existente: buffer 0 si agotar.

**`src/lib/intelligence.ts`** (post sprint 5.5.1):
- `:80-93` — Type `AccionIntel` con `AGOTAR_NO_RECOMPRA` y `DESCONTINUADO`.
- `:799` — filtro entrada: excluye `descontinuado` del pipeline entero.
- `:2060-2074` — PASO 10c: override `pedir_proveedor=0` si agotar/descontinuado.

**`src/lib/db.ts:2239`** — comentario: "estado_sku=agotar" trigger sync inline.

### 2.2 SQL / migrations (1 archivo)

- `supabase/migrations/20260504181500_doc_agotar_comment_estado_sku.sql` —
  COMMENT ON COLUMN actualizado 2026-05-04 con doctrina formal.
- `supabase/migrations/20260504100000_sprint43a_target_dias_flex.sql:214` — cron
  `sync-from-templates` filtra `WHERE estado_sku = 'activo' OR estado_sku IS NULL`
  (excluye `agotar` y `descontinuado` del policy refresh).

### 2.3 Docs (5 archivos antes de hoy + 3 nuevos)

- `docs/policies/estados-sku.md` (NUEVO 2026-05-04) — policy vinculante.
- `docs/policies/inventario-formulas.md:160-177` — referencia desde fórmulas.
- `docs/discovery/estado-sku-agotar-2026-05-04.md` (NUEVO) — discovery origen.
- `docs/sprints/sprint-5.5.1-alineacion-agotar.md` (NUEVO) — sprint motor viejo.
- `docs/sprints/sprint-4.3a-importar-viejo-flex.md:50` — mención CZ "Cola muerta — agotar".

### 2.4 Falsos positivos (descartados)

- `MarginSimulatorModal.tsx:228` — "agotar 3 intentos" (ciclo retry, no estado SKU).
- `AdminVentasML.tsx:275` — "paginamos hasta agotar" (loop, no estado SKU).
- `AdminMargenes.tsx:999` — "hasta agotar intentos" (loop).

---

## 3. Otros mecanismos que implican "no recomprar" (sin llamarse 'agotar')

| Mecanismo | Tipo | Cuántos hoy | Quién lo setea | Bloquea compra real? |
|---|---|---|---|---|
| `productos.estado_sku='agotar'` | humano | 22 | UI admin | sí (motor nuevo + viejo) |
| `productos.estado_sku='descontinuado'` | humano | 0 | UI admin | sí (filtro entrada motor viejo + cron policy) |
| `sku_node_policy.action='no_reorder'` | computado | 438 | cron `sync-from-templates` | sí (motor nuevo) |
| `sku_node_policy.policy_status='blocked_no_cost'` | gate | 172 | cron policy templates | sí (no entra a `v_compras_pendientes`) |
| `sku_intelligence.accion='INACTIVO'` | computado | 116 | `intelligence.ts:1490` (vel=0 + stock=0) | sí (motor viejo no calcula `pedir_proveedor`) |
| `sku_intelligence.accion='DEAD_STOCK'` | computado | 1 | `intelligence.ts:1493` (vel=0 + stock>0) | sí (motor viejo) |
| `sku_intelligence.accion='AGOTADO_SIN_PROVEEDOR'` | computado | 28 | `intelligence.ts:1495` | sí (motor viejo no compra si proveedor sin stock) |
| `sku_intelligence.accion='AGOTAR_NO_RECOMPRA'` | override 5.5.1 | 0 todavía → 22 al próximo cron | derivado de `estado_sku='agotar'` | sí (motor viejo, post sprint 5.5.1) |

### Ejemplos por categoría

- **agotar humano**: JSAFAB422P20S Trópico Rosa (marcado 2026-04-29).
- **descontinuado humano**: ninguno hoy (categoría vacía).
- **no_reorder computado**: cualquiera de los 414 NULL con cell=CZ. La doctrina
  de no-reorder viene de la celda ABC-XYZ + tendencia, no de un toggle humano.
- **blocked_no_cost**: los 73 `activo` (todos blocked porque falta `costo_promedio`)
  + 99 NULL en mismo gate. Suspicious: los 73 `activo` son SKUs creados por UI
  moderna pero sin recepción → sin costo aún → motor nuevo no entra.
- **INACTIVO**: 73 `activo` (sin venta) + 43 NULL.
- **AGOTADO_SIN_PROVEEDOR**: 26 NULL + 2 `agotar` (overlap) — motor viejo lo
  detecta cuando `vel_full > 0` pero stock cero en bodega y proveedor.
- **DEAD_STOCK**: 1 NULL — stock vivo pero velocidad nula.

### Lo importante: hay 4 caminos distintos hacia "no comprar"

1. **Decisión humana explícita** (estado_sku=agotar/descontinuado) — voluntad del dueño.
2. **Decisión algorítmica de no-reorder** (action=no_reorder) — celda CZ, sin demanda.
3. **Bloqueo por dato faltante** (policy_status=blocked_no_cost) — gate técnico.
4. **Estado natural de la realidad** (INACTIVO/DEAD_STOCK/AGOTADO_SIN_PROV) —
   computado por velocidad+stock+proveedor.

`agotar` (1) es el único que también afecta el **buffer Flex**.

---

## 4. Otros mecanismos que afectan buffer Flex (publicación a ML)

**Único override por SKU**: `productos.estado_sku='agotar'` → `buffer=0`.

**Default**:
- 2 si `sku_origen` no compartido entre publicaciones ML.
- 4 si `sku_origen` compartido (`sharedOrigins.has(skuOrigen)`).

**No hay**:
- `productos.buffer_override` (no existe).
- Configuración por categoría/proveedor de buffer.
- `sku_node_policy.buffer_ml` (la celda no afecta buffer).
- Override por evento/promo.

`buffer_ml` aparece en `flex-full.ts` como **parámetro de cálculo**, no flag humano.
El valor lo decide `stock-sync` y `activate-with-stock` antes de pasarlo.

**Conclusión**: el buffer Flex tiene **un solo override humano** (`agotar`) y dos
defaults algorítmicos (2/4 según compartido). Sin matriz de buffer por SKU.

---

## 5. UI: opciones que tiene el dueño en /admin/inventario

### 5.1 Toggle individual (panel SKU expandido)

3 botones tipo radio en línea (`page.tsx:6376` y duplicado en `:7903`):

| Botón | Color | Texto confirmación al click |
|---|---|---|
| `✓ Activo` | verde | (no muestra confirmación si ya estaba en otro estado, transición libre) |
| `🏁 Agotar` | amber | "Marcar X como AGOTAR? Se publicara toda unidad en bodega en Flex ignorando el buffer (2/4)." |
| `✕ Descontinuado` | rojo | "Marcar X como DESCONTINUADO? Saldra del motor de inteligencia." |

**DB writes**: 1 row en `productos` (estado_sku) + 1 row en `audit_log`
(`accion='estado_sku_change'`, `params={nuevo, previo, source: 'admin_inventario_button'}`).

### 5.2 Bulk (panel Inventario, modo bulk activo)

Botón único: **"🏁 Marcar N como Agotar"** (`page.tsx:6924`).

Confirmación: "Marcar N SKUs como AGOTAR? Se publicara toda unidad en bodega en
Flex ignorando el buffer (2/4). El sync a ML se dispara automaticamente."

**DB writes**:
- bulk update productos (1 query con `.in("sku", skus)`)
- 1 row audit_log por SKU (`source: 'admin_inventario_bulk'`)
- sync inline a ML para cada SKU (no espera al cron).

### 5.3 NO existen botones para

- "Marcar como descontinuado" en bulk (solo individual).
- "Reactivar" — el toggle Activo lo cubre (libre transición).
- "Marcar estacional" — eso vive en otro flujo (pestaña Inteligencia).
- "Sin buffer" / "Buffer especial" — no hay UI para buffer override.
- "Pausar" / "Liquidar" — no son flags humanos; pricing los decide.
- "es_holdout", "es_pico", "es_kvi", "auto_postular" — sin UI activa.

---

## 6. Cross-tab del catálogo HOY (snapshot 2026-05-04)

### 6.1 Por estado_sku × intelligence.accion + sku_node_policy.action

| estado_sku | productos | AGOTADO_SIN_PROV | EXCESO | INACTIVO | OK | con_liquidacion | snp_no_reorder | snp_action_null (cero policy) | sin_policy |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| NULL | 414 | 26 | 160 | 43 | 59 | 137 | 219 | 13 | 0 |
| activo | 73 | 0 | 0 | 73 | 0 | 0 | 0 | 73 | 0 |
| **agotar** | **22** | **2** | **6** | **0** | **6** | **3** | **0** | **0** | **22** |

### 6.2 Insights críticos del cross-tab

1. **Los 22 `agotar` no tienen fila en `sku_node_policy`** — esto **valida la
   doctrina** (cron `sync-from-templates` los excluye correctamente).
   Motor nuevo los invisibiliza ✓.

2. **Los 73 `activo` están todos en `INACTIVO` y `blocked_no_cost`** — son
   productos creados por UI moderna pero sin costo poblado, sin venta histórica.
   Quedan limbo: `estado_sku='activo'` formal pero motor nuevo no los toca.

3. **3 de 22 `agotar` tienen `liquidacion_accion`** — coexisten ambos conceptos
   sin conflicto:
   - JSCNAE110P20W → agotar + descuento_10
   - 9788490736630 → agotar + liquidar_activa
   - JSECBQ001P25Z → agotar + descuento_10
   
   Esto significa: pricing decide markdown automático, dueño decide "vender al
   máximo sin recomprar". **Ortogonal por diseño**.

4. **2 de 22 `agotar` tienen `accion='AGOTADO_SIN_PROVEEDOR'`** — el motor viejo
   no respetaba `estado_sku=agotar`, así que detectó el síntoma natural
   (sin stock + sin proveedor). Post sprint 5.5.1 esos pasarán a `AGOTAR_NO_RECOMPRA`.

5. **Acciones intel actuales en agotar**: AGOTADO_SIN_PROVEEDOR=2, EN_TRANSITO=2,
   EXCESO=6, MANDAR_FULL=1, OK=6, PLANIFICAR=5. Heterogéneo — refleja realidades
   distintas pero ninguna respeta el flag. Post 5.5.1: todos quedan
   `AGOTAR_NO_RECOMPRA`.

6. **Promociones**: `sku_node_policy.promocion_activa=true` para 50 SKUs
   (acelerando/acelerando_fuerte). Es el opuesto conceptual de agotar — promueven,
   no liquidan. No interfiere con agotar (es por aceleración del cron, no humano).

---

## 7. Conclusión: ¿UN solo concepto "agotar" o múltiples?

### UN concepto humano

**Hay UN solo concepto humano "agotar"** en BANVA: `productos.estado_sku='agotar'`.
Setead manualmente vía 3 caminos (botón individual / bulk / form edit producto),
todo registrado en `audit_log.accion='estado_sku_change'`.

### MÚLTIPLES mecanismos relacionados (distintos pero conviven)

| Concepto | Tipo | Quién decide | Afecta… |
|---|---|---|---|
| `estado_sku='agotar'` | humano | dueño vía UI | compra (motor viejo + nuevo) + buffer Flex |
| `estado_sku='descontinuado'` | humano | dueño vía UI | compra + pricing (skip markdown) + filtro entrada motor viejo |
| `action='no_reorder'` (snp) | computado | cron template | compra (motor nuevo) |
| `policy_status='blocked_no_cost'` | gate | cron policy | compra (motor nuevo) |
| `accion='INACTIVO/DEAD_STOCK/AGOTADO_*'` | computado | `intelligence.ts` | compra (motor viejo) |
| `accion='AGOTAR_NO_RECOMPRA'` | override 5.5.1 | derivado de estado_sku | compra (motor viejo) |
| `liquidacion_accion ≠ NULL` | computado | `intelligence.ts:2139` | **PRICING únicamente** (no afecta compra) |
| `es_estacional=true` | humano | UI Inteligencia (3 SKUs) | velocidad ajustada (no agotar) |
| `es_kvi=true` | humano teórico | UI (no usado) | (futuro: pricing) |
| `manual_override=true` (snp) | humano teórico | UI (no usado, 0 hoy) | bypass cron |

### El problema potencial

La confusión más probable del owner viene de:

1. **`agotar` (humano) vs `no_reorder` (computado)** — ambos producen "no compra"
   en motor nuevo, pero el primero es decisión voluntaria, el segundo es
   algorítmico (celda CZ + cero demanda). Si el owner ve un SKU "no aparece en
   compras", puede ser cualquiera de los dos — y a veces ambos.

2. **`agotar` vs `liquidacion_accion`** — pueden coexistir en el mismo SKU
   (3 casos hoy). Pricing baja precio mientras dueño deja agotar el stock. Es
   coherente: agotar al máximo precio defendible. NO es un bug.

3. **`agotar` vs `AGOTADO_SIN_PROVEEDOR`** — confusos por nombre similar pero
   conceptos distintos:
   - `agotar` = decisión humana ("no recomprar")
   - `AGOTADO_SIN_PROVEEDOR` = realidad detectada ("sin stock en bodega ni proveedor")
   
   Pueden coexistir o estar desalineados. Post sprint 5.5.1, los `agotar`
   sobrescriben `AGOTADO_SIN_PROVEEDOR` con `AGOTAR_NO_RECOMPRA`.

4. **`activo` (estado_sku) que está `INACTIVO` (accion intel)** — los 73 SKUs
   `activo` están todos `INACTIVO`. La palabra suena contradictoria pero refleja
   semánticas distintas: `estado_sku='activo'` = "puede operar"; `accion='INACTIVO'`
   = "computado: no se mueve". Categoría de productos creados por UI nueva sin
   recepción todavía.

### Recomendaciones (no en scope hoy, sólo notas)

- **Renombrar `accion='INACTIVO'`** a `SIN_VENTA` o `DURMIENDO` para reducir
  colisión semántica con `estado_sku='activo'`.
- **Eliminar columnas humanas no usadas**: `politica_pricing` (todos seguir),
  `auto_postular` (todos false), `es_kvi` (todos false), `manual_override`
  (todos false). Antipatrón Regla 5 (fuente fantasma — todos al default).
- **Documentar en UI** la diferencia entre `agotar` (humano) y `no_reorder`
  (algorítmico) para que owner entienda por qué un SKU "no aparece a comprar"
  cuando él NO marcó agotar.
- **NO introducir** un flag adicional `phaseout` o `dormido` hasta que el owner
  pida operativamente diferenciarlos. La doctrina actual con 4 estados
  (activo/agotar/descontinuado/NULL) cubre los casos vivos.

---

*Discovery ejecutado por Claude Opus 4.7 (1M context) el 2026-05-04 bajo
`feedback_banvabodega_autonomy`. Read-only — cero modificaciones a código,
schema o datos.*
