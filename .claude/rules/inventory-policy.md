# BANVA Bodega — Reglas de inventario y código

Reglas acumuladas del sprint técnico abril 2026. Cada regla viene de un bug real detectado en producción.

Al escribir código nuevo que toque el motor de inteligencia (`src/lib/intelligence.ts`, `src/lib/intelligence-queries.ts`), sync con ML (`src/lib/ml.ts`, `src/app/api/ml/**`), reposición o movimientos de stock, **revisar esta lista antes del commit**.

Referencia cruzada: `docs/banva-bodega-inteligencia.md` §14 ("Patrones a evitar") documenta las primeras versiones de las reglas 1 y 3 con detalle técnico adicional.

## Regla 1 — Nunca valores centinela numéricos

**Patrón prohibido**: usar números "mágicos" (`999`, `-1`, `2071`, `0` como marcador) para representar "no sé", "no aplica" o "no hay dato".

**Patrón correcto**: `NULL` en la DB (columna nullable) + manejo explícito en código y UI (`valor === null ? "—" : valor`).

**Razón**: los centinelas se confunden con valores reales. El código que hace cálculos, comparaciones u ordenamientos no distingue entre "día 999 en quiebre real" y "no hay dato". Sesga decisiones silenciosamente y es muy difícil de detectar — el sistema "funciona" pero con output mentiroso.

**Casos históricos**:
- `dias_en_quiebre = 2071` (PR5 `f11eb07`) — contador incrementaba por recálculo (~80/día), no por día calendario. 5.7 años absurdos propagaron factor de rampup = 0 y recortaron `pedir_proveedor` a 0 aunque había stock del proveedor. Fix: `fecha_entrada_quiebre` como ancla + derivar `floor((hoy - ancla)/día)`.
- `dias_sin_movimiento = 999` (PR6a `533672a`) — fallback cuando `ultimoMovPorSku.get(sku)` era `undefined`. La condición `diasSinMov <= 30` nunca se cumplía → rama `NUEVO` muerta en 533 SKUs → 63 SKUs recién recepcionados atrapados como `DEAD_STOCK`. Fix: `DROP DEFAULT + DROP NOT NULL` en v56 + `null` explícito.
- `cob_full = 999` cuando `vel ≤ 0` — todavía vigente en `intelligence.ts:1010-1019`. Funciona porque la comparación `cob_full < punto_reorden && cob_full < 999` lo excluye explícitamente. Es el único centinela admisible del motor hoy, pero la comparación doble es el parche. Próxima refactorización: pasar a `null` con branch explícito.

**Cómo validar antes del commit**:
- Buscar literales numéricos sospechosos en asignaciones:
  ```
  grep -nE '= 999([^0-9]|$)|= 2071|= -1([^0-9]|$)' src/lib/intelligence*.ts src/lib/ml.ts
  ```
- Cualquier match debe tener un comentario `// Sentinel admisible: …` o refactorizarse a `null`.
- Al leer un campo que podría ser centinela, agregar guard: `if (valor === null) { … } else if (valor > 900) { /* sospechoso */ }`.

## Regla 2 — Sub-bugs detectados durante un PR no son "para después"

**Patrón prohibido**: cuando aparece un bug colateral durante un PR, diferirlo como "lo abrimos como ticket aparte".

**Patrón correcto**: si el fix es **< 1 h de trabajo**, se atiende en el mismo sprint con commit separado dentro del mismo PR (o PR inmediato siguiente, mismo día). Sub-bugs con fix > 1 h se abren como tarea con **deadline explícito para el siguiente sprint**, no backlog abierto.

**Razón**: el contexto del PR es caliente. Dentro de 2 semanas nadie recuerda el matching específico que falla. El sub-bug pospuesto se vuelve "bug misterioso" y cuesta el triple de tiempo recuperar el contexto. En abril 2026 esto se enunció como: *"Sub-bugs detectados durante un PR no son 'para después'."*

**Casos históricos**:
- Matching `razon` vs `motivo` detectado durante investigación de PR6a (el dato no llegaba al pipeline) → fixeado en PR6a-bis (`2c09b8a`), mismo día, no PR separado 3 semanas después. El bug ya estaba silencioso hace meses; detectarlo sin fixearlo hubiese dejado el motor ciego por otro mes.
- Bug `enqueue_all` silencioso encontrado durante el quick win del PR6b-pivot → fixeado inline con test en `4bdfd43` antes de seguir con el scope original del PR.

**Cómo aplicar**:
- Al encontrar un sub-bug, estimá honestamente: ¿se arregla en ≤ 1 h incluyendo test? Si sí, commit separado en el mismo PR.
- Si es mayor, abrir tarea con deadline `próximo sprint` (no "cuando toque") y citar el PR actual como contexto.
- En el mensaje del commit del fix, etiquetar: `(SUB-PR6a/3)` o similar. Así el log muestra la cadena.

## Regla 3 — Nunca tragar errores de API o Supabase

**Patrón prohibido**:
```ts
// ❌ Traga errores silenciosos
void sb.from("tabla").update({ ... });
const { data } = await sb.from("tabla").select("col"); // sin `error`
await fetch(url).catch(() => {});
return data || [];
```

**Patrón correcto**:
```ts
// ✅ Propaga o logea explícito con contexto
const { data, error } = await sb.from("tabla").select("col");
if (error) {
  console.error(`[contexto] query failed: ${error.message}`);
  // propagar, tirar throw, o agregar a errores[] según el caller
}
```

**Razón**: errores silenciosos dejan el sistema en estado inconsistente. Los datos no llegan, las decisiones se toman con `data fantasma` (p.ej. array vacío), nadie se entera hasta que alguien nota el síntoma semanas después. Es el generador #1 de bugs "imposibles" en este sprint.

**Casos históricos**:
- `paginatedSelect` con columna inexistente `razon` (la real era `motivo`) → Supabase devolvía error "column does not exist" → destructuring parcial `const { data } = …` descartaba el error → retornaba `[]` → Map de últimos movimientos vacío → `dias_sin_movimiento = null` en 335 SKUs. **3.271 filas perdidas silenciosamente por semanas**. Fix: PR6a-bis `2c09b8a` seleccionó solo columnas existentes y agregó error log en `paginatedSelect`.
- `void sb.from("ml_items_map").update(...)` en `ml.ts:2292` (PR pre-pivot) — el update de la columna zombi fallaba sin log. Spread semanal de valores stale. Fix: PR6b-pivot-I `db58f8e` cambió a `await + error log + push a errores[]`.

**Cómo validar antes del commit**:
- Grep de patrones prohibidos:
  ```
  grep -nE 'void sb\.|void supabase\.' src/
  grep -nE '\.catch\(\s*\(\s*\)?\s*=>\s*\{?\s*\}?\s*\)' src/
  grep -nE 'const \{ data \} = await sb\.' src/   # potencial swallow
  ```
- Cada match que no descarte el error debe tener comentario justificando (p.ej. `// Fire-and-forget: no crítico, el próximo cron lo resincroniza`).

## Regla 4 — Endpoints con branches condicionales deben ser observables en el response

**Patrón prohibido**: response 200 OK genérico sin indicar qué rama del código se ejecutó.

**Patrón correcto**: si un endpoint tiene `if (param === '1') { … }`, el response debe incluir un campo tipo `enqueue_all_ran: boolean`, `rows_affected: number`, `branch_taken: "wms"|"ml"|"sync"`. El caller (o un tester) debe poder distinguir "no hice nada porque no había trabajo" de "no hice nada porque bug".

**Razón**: un response `{status:"ok", synced:0}` es indistinguible entre "queue estaba vacía, trabajo hecho" y "el branch nunca se ejecutó". Semanas de fallo silencioso con cero señal en monitoring.

**Casos históricos**:
- `POST /api/ml/stock-sync?enqueue_all=1` usaba `new URL(req.url).searchParams` en vez de `req.nextUrl.searchParams`. En Vercel app router el primero no veía el query param → el `if` nunca entraba → response 200 `{message: "queue empty"}` sin ejecutar el enqueue. Bug de semanas invisible hasta el quick win del PR6b-pivot. Fix: `4bdfd43` + exposición de `enqueue_all_ran` y `enqueue_all_inserted` en el response.

**Cómo aplicar**:
- Al escribir un endpoint con branching: lista las ramas en el plan y exponé un campo por rama en el response.
- Test mínimo: con y sin el param, el response debe tener campos distintos.
- Naming: `<action>_ran: boolean` + `<action>_inserted: number` (o `_updated`, `_fetched`).

## Regla 5 — Fuentes duplicadas del mismo dato → fuente única canónica + lecturas derivadas

**Patrón prohibido**: guardar el mismo valor en 2 tablas/columnas diferentes con sync manual entre las dos.

**Patrón correcto**: una sola tabla canónica; toda otra lectura es JOIN o VIEW. Si la duplicación es inevitable (cache, performance), documentar explícitamente cuál es canónica y cuál es derivada, y el derivado tiene un sync automático con invariantes chequeados por test.

**Razón**: el update dual es invariantemente frágil. Un lado se actualiza por una ruta, el otro no. Con el tiempo las fuentes divergen y el código que lee una u otra toma decisiones distintas sobre la misma realidad. Siempre que existan dos lugares homónimos, uno se va a volver zombi.

**Casos históricos**:
- `stock_full_cache` (tabla, canónica) vs `ml_items_map.stock_full_cache` (columna, legado) — PR6b-pivot-I `db58f8e`. El `syncStockFull.stale_cleanup` bajaba la tabla a 0 para SKUs que ML dejaba de reportar, pero NO tocaba la columna → 14 SKUs con valores zombi durante 3-22 días. El motor lee la tabla (correcto) pero `stock-compare phase=wms` leía la columna (mostraba stock fantasma al admin). Fix: `syncStockFull` ahora espejea el cleanup a la columna + `stock-compare` migró a LEFT JOIN contra la tabla + v58 `COMMENT ON COLUMN ... DEPRECADA`.
- Bonus histórico (no fixeado aún): `pedidos_flex` (legacy, un registro por order+sku_venta) vs `ml_shipments` + `ml_shipment_items` (nuevo, shipment-centric). Coexisten por migración incompleta. A consolidar en sprint futuro.

**Cómo aplicar**:
- Cada dato de stock/inventario debe tener **una** tabla canónica declarada en `docs/banva-bodega-inteligencia.md` §11.1.
- Toda lectura desde otro lugar es JOIN o VIEW, no copia.
- Si se necesita cache derivado por performance: crear view materializada + `REFRESH` automático, no columna manualmente sincronizada.

---

## Proceso cuando se detecta un bug nuevo

1. **Identificar la regla violada** (1–5). Si es varias, listalas todas.
2. **Si no pertenece a ninguna**, proponer Regla 6 en el PR que fixea el bug (ver "Proposal" abajo).
3. **Agregar el caso histórico** a la regla correspondiente, con hash del commit del fix.
4. **Commit del fix** primero, **commit de la actualización del archivo** después, para que cada commit tenga una sola responsabilidad.

### Proposal: cómo agregar una regla nueva

- Título que describa el antipatrón, no la solución ("Regla 6 — X no debe Y" en vez de "Regla 6 — usar Z").
- Patrón prohibido + patrón correcto + razón + **al menos 1 caso histórico con hash**. Sin caso histórico: marcar como "Propuesta — sin caso histórico todavía" y esperar confirmación en PR siguiente.
- Comando grep concreto en "Cómo validar". Vaguedades no ayudan en code review.

---

## Historial de bugs del sprint abril 2026

| PR | Hash | Bug | Regla(s) violada(s) |
|---|---|---|---|
| PR5 | `f11eb07` | `dias_en_quiebre = 2071` (contador por recálculo) | Regla 1 |
| PR6a | `533672a` | `dias_sin_movimiento = 999` (centinela apaga rama NUEVO) | Regla 1 |
| PR6a-bis | `2c09b8a` | Select inventaba columna `razon`, `paginatedSelect` tragaba el error → 3.271 filas perdidas | Regla 3 |
| PR6b-pivot (fix enqueue_all) | `4bdfd43` | `?enqueue_all=1` silencioso via `new URL(req.url)` en Vercel | Regla 4 |
| PR6b-pivot-I | `db58f8e` | Columna zombi `ml_items_map.stock_full_cache` + `void` update sin log | Reglas 3 + 5 |

Observación: **5 PRs, 5 antipatrones distintos, todos fixeados en el mismo sprint**. La velocidad con la que aparecieron sugiere que estos patrones estaban latentes en el codebase desde hace tiempo y solo se detectaron al aumentar la observabilidad. Esperar más instancias en áreas no auditadas aún (profitguard, picking, recepciones).
