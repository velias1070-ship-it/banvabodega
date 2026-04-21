# BANVA Bodega — Sprint técnico abril 2026 (CERRADO)

Recap consolidado del sprint que cerró 6 bugs estructurales del motor de inteligencia + sync con ML, y formalizó 6 reglas culturales en `.claude/rules/inventory-policy.md`. Documento escrito al cierre (2026-04-21) para que dentro de 6 meses cualquiera pueda reconstruir el contexto sin recuperar memoria perdida.

---

## 1. Timeline

- **Inicio:** `f11eb07` — 2026-04-18 (fix PR5 `dias_en_quiebre`).
- **Cierre:** `ce5a398` — 2026-04-21 (PR6c autoheal extendido).
- **Duración real:** 4 días calendario. ~3 días efectivos de trabajo (18/19/20/21).

## 2. Los 6 PRs con detalle

| PR | Commit | Fecha | Problema original | Causa raíz encontrada | Fix aplicado | LOC (ins/del) | Tests |
|---|---|---|---|---|---|---|---|
| **PR5** | `f11eb07` | 2026-04-18 | 38 SKUs con `dias_en_quiebre > 1500` (5.7 años absurdos); rama `pedir_proveedor` cortada por factor rampup=0 | `diasEnQuiebre = prev + 1` se incrementaba por recálculo del motor (~80/día), no por día calendario | Ancla `fecha_entrada_quiebre` + derivar `floor((hoy − ancla)/día)`. Migración v55. Regla canónica §14 docs | +499 / −30 | — |
| **PR6a** | `533672a` | 2026-04-18 | 533/533 SKUs con `dias_sin_movimiento=999`; rama `accion=NUEVO` muerta, 63 SKUs falsos `DEAD_STOCK` | Fallback numérico `999` cuando `ultimoMovPorSku.get(sku)=undefined`. La condición `dias<=30` nunca se cumplía | Columna nullable (v56 `DROP DEFAULT + DROP NOT NULL`) + helper puro `esAccionNuevo()` + 9 tests | +306 / −3 | 9 |
| **PR6a-bis** | `2c09b8a` | 2026-04-20 | Post-v56 aplicada, 533 SKUs seguían con `dias_sin_movimiento=NULL` aunque había 3.271 filas en `movimientos` | `queryMovimientos.select("sku,tipo,razon,cantidad,created_at")` pedía columna inexistente `razon` (real: `motivo`). `paginatedSelect` ignoraba el error → array vacío silencioso | Select mínimo `"sku, created_at"` + error log en `paginatedSelect` + 5 tests integración matching normalizado (UPPER+trim) | +159 / −24 | 5 |
| **PR6b original** | — | 2026-04-18/20 | Ads gastando en SKUs sin stock (estimado $175k/mes) | **Diagnóstico empírico mostró que PR6b era placebo**: mecanismo `hold` de ML ya congela spend automático cuando stock=0 | **DESCARTADO**. Pre-auditoría producida (`bd65842`, 189 LOC) sirvió para entender el dominio y guiar PR6b-pivot | — / — | — |
| **PR6b-pivot (A + I)** | `4bdfd43` + `db58f8e` | 2026-04-21 | 23 SKUs BANVA=0 / ML>0 (225 uds fantasma); 14 SKUs con col `stock_full_cache` zombi de hasta 22 días; 96 "oversell" órdenes (en realidad ventas Full invisibles) | 2 bugs encadenados: (a) `?enqueue_all=1` silencioso por `new URL(req.url)` en Vercel; (b) `void sb.from().update()` + stale_cleanup no bajaba col zombi → doble fuente desincronizada | A: `req.nextUrl.searchParams` + response observable + test; I: `syncStockFull` await+log en 3 puntos, stale_cleanup espejea col, `stock-compare wms` migra a LEFT JOIN tabla canónica, script backfill one-time, v58 COMMENT DEPRECADA | +499 / −16 | 6 |
| **PR6c** | `ce5a398` | 2026-04-21 | 26 SKUs activos sin `composicion_venta` trivial; motor veía `stock_full=0` y `vel_ponderada=0` a pesar de 216 ventas/30d registradas | Autoheal inline (paso 5b) solo iteraba sobre `mapped` (items devueltos por ML en esa corrida). SKUs que ML API no lista en fulfillment (paginación, paused) quedaban huérfanos | Paso 5c nuevo (`autohealComposicionExtendido`) escanea TODO `ml_items_map.activo=true` con filtros + upsert idempotente + backfill one-time + 4 tests (incluye regresión explícita) | +402 / −1 | 4 |

## 3. Los 6 antipatrones detectados

### Antipatrón 1 — Centinela numérico incrementable por ejecución

- **PR donde apareció:** PR5 (`f11eb07`).
- **Ejemplo:** `diasEnQuiebre = prevDias + 1` dentro del loop de `recalcularTodo()`.
- **Regla que lo cubre:** **Regla 1** (nunca centinelas numéricos) + derivable de tiempo real, no contador.
- **Cómo validar:** `grep -nE '= prev\w* \+ 1|= prev\w* - 1' src/lib/intelligence*.ts` — todo match debe tener un comentario justificando que el incremento es por evento real (no por ejecución).

### Antipatrón 2 — Centinela numérico como fallback mágico

- **PR donde apareció:** PR6a (`533672a`).
- **Ejemplo:** `diasSinMov = ultimoMov ? ... : 999`.
- **Regla:** **Regla 1**.
- **Cómo validar:** `grep -nE '= 999([^0-9]|$)|= 2071|= -1([^0-9]|$)' src/lib/intelligence*.ts src/lib/ml.ts`.

### Antipatrón 3 — Error swallow por destructuring parcial

- **PR donde apareció:** PR6a-bis (`2c09b8a`).
- **Ejemplo:** `const { data } = await sb.from("tabla").select(...)` — ignora `error`; si columna no existe, devuelve `[]`.
- **Regla:** **Regla 3** (nunca tragar errores de API o Supabase).
- **Cómo validar:** `grep -nE 'const \{ data \} = await sb\.' src/` — cada match debe justificar por qué ignora el error.

### Antipatrón 4 — Branch condicional silencioso (200 OK genérico)

- **PR donde apareció:** PR6b-pivot (`4bdfd43`).
- **Ejemplo:** endpoint con `if (url.searchParams.get("enqueue_all")==="1") {...}` devolviendo siempre `{status:"ok", synced:0}`, indistinguible de "no había trabajo".
- **Regla:** **Regla 4** (endpoints con branches condicionales deben ser observables en el response).
- **Cómo validar:** inspeccionar response JSON: cada branch condicional debe tener un campo `*_ran` o `*_inserted` que lo distinga.

### Antipatrón 5 — Fuentes duplicadas homónimas

- **PR donde apareció:** PR6b-pivot-I (`db58f8e`).
- **Ejemplo:** `stock_full_cache` existe como tabla (canónica) Y como columna en `ml_items_map`. El sync actualiza tabla pero no columna en el path de stale_cleanup → columna se vuelve zombi.
- **Regla:** **Regla 5** (fuente única canónica + lecturas derivadas).
- **Cómo validar:** `grep -rnE 'COLUMN\s+\w+\s+\w+' supabase-v*.sql | grep -i cache` — nombres de columnas que coinciden con tablas existentes son sospechosos.

### Antipatrón 6 — Autoheal que solo cubre la respuesta parcial de API externa

- **PR donde apareció:** PR6c (`ce5a398`).
- **Ejemplo:** autoheal iteraba sobre `mapped` (respuesta de ML en la corrida) en vez de sobre `ml_items_map.activo=true` (fuente canónica local).
- **Regla:** **Regla 6** (autoheal debe escanear la fuente canónica, no la respuesta parcial).
- **Cómo validar:** code review de cualquier función con "autoheal", "backfill", "reconcile" en el nombre. Pregunta guía: *¿la fuente de iteración es la canónica, o una respuesta parcial de un sistema externo?*

## 4. Las 6 reglas formalizadas

Archivo completo: [`.claude/rules/inventory-policy.md`](../.claude/rules/inventory-policy.md).

1. **Regla 1 — Nunca valores centinela numéricos.** Usar `NULL` + manejo explícito.
2. **Regla 2 — Sub-bugs detectados durante un PR no son "para después".** Si el fix es <1h, se atiende en el mismo sprint.
3. **Regla 3 — Nunca tragar errores de API o Supabase.** `try/catch` + `console.error` con contexto.
4. **Regla 4 — Endpoints con branches condicionales deben ser observables en el response.** Campo explícito por rama.
5. **Regla 5 — Fuentes duplicadas del mismo dato → fuente única canónica + lecturas derivadas.** JOIN o VIEW, no copia sincronizada a mano.
6. **Regla 6 — Autoheal debe escanear la fuente canónica, no la respuesta parcial.** Response de API externa = input adicional, no única.

## 5. Plata desbloqueada y visibilidad recuperada

| PR | Impacto |
|---|---|
| **PR5** | ~$3.9M CLP desbloqueados en próxima OC (factor rampup dejó de bloquear pedir_proveedor en 38 SKUs con quiebre histórico; recupera 442 uds de órdenes que el motor bloqueaba) |
| **PR6a + PR6a-bis** | 335 SKUs con movimientos reales recuperados en `dias_sin_movimiento`; 63 SKUs mal clasificados como `DEAD_STOCK` reclasificados (la mayoría a `NUEVO`); rama `accion=NUEVO` que estaba muerta volvió a operar |
| **PR6b-pivot A + I** | 14 SKUs con columna zombi limpiados (~90 uds de stock fantasma que mostraba el admin en `/admin → Stock Compare`). 38 SKUs OOS/no publicados encolados y sincronizados (reducción 23→15 fantasmas BANVA=0/ML>0) |
| **PR6c** | **8 SKUs productivos con 216 ventas/30d invisibles al motor** (biblias + almohadas: LICAAFVIS5746X1 58u, LA-BIB-9 33u, LA-BIB-29 21u, LA-LA-8 20u, TXALMILLVIS46X2 15u, LA-LA-13 13u, BI-BIB-10 10u, RAPAC50X70AFAX4 9u = **179 uds Full visibles de golpe**) + 6 SKUs con Full bajo (4–8 uds) + 12 SKUs paused rescatados al catálogo de composición |

**Resumen total:** 8 SKUs Full gordos reaparecen con vel_ponderada real después del recálculo post-backfill, lo que va a recalcular reposición y márgenes en el próximo ciclo.

## 6. Feature descartado

**PR6b original (pausa automática de Product Ads en SKUs OOS)** — cancelado tras diagnóstico empírico que mostró que ML aplica `status=hold` automáticamente al ad cuando el item está `paused` en marketplace o sin stock publicable. Los 7 SKUs originalmente candidatos ya estaban en `hold` con `gasto_7d=$0`. Ahorro estructural: no construimos código innecesario + pre-auditoría (189 LOC) sirvió para entender el dominio y guiar PR6b-pivot. El caso está documentado en `docs/banva-bodega-pr6b-preauditoria.md`.

## 7. Métricas del sprint

| Métrica | Valor |
|---|---|
| **Commits totales** (sprint scope, `f11eb07^..HEAD`) | 29 |
| **Commits de código** (fix/feat) | 10 |
| **Commits de docs** (pre-auditorías, reportes, reglas) | 14 |
| **Commits de chore/otros** (revert, MCPs, UI menor) | 5 |
| **LOC netos** | +8 002 / −334 = **+7 668** (incluye docs largos; el código neto de los 6 fixes es ~+1 100) |
| **Archivos de test** | 4 → **10** (+6 archivos) |
| **Tests individuales** | ~60 → **107** (+47 tests, todos verdes en CI) |
| **Migraciones Supabase** | v55 (PR5), v56 (PR6a), **v57 saltada** (lugar reservado para ads-pause, descartado), v58 (PR6b-pivot-I `COMMENT ON COLUMN`) |
| **Scripts de backfill** | 3 (`backfill-dias-sin-movimiento`, `backfill-columna-zombi-stock-full`, `backfill-composicion-venta-trivial`) |
| **Horas reales de desarrollo** (estimación) | 18–24h distribuidas en 4 días (~5–6h/día promedio) |

## 8. Lecciones operativas

1. **Pre-auditoría siempre antes de código.** Salvó la dirección del proyecto tres veces:
   - PR6b original → descartado por hallazgo empírico del mecanismo `hold`
   - PR6b-pivot I → pivoteo de "push BANVA→ML" a "stock_full_cache canónica" tras encontrar columna zombi
   - PR6c → pivoteo de "fix al cron sync-stock-full" a "autoheal composicion trivial" tras encontrar el verdadero bottleneck
2. **Validar universos exactos antes de ejecutar scripts masivos.** El universo de PR6c fue `26 filas → 25 SKUs únicos` por dedupe de `9788433031075`; si el script no hubiera sido idempotente con `onConflict`, hubiera fallado con unique violation.
3. **Tests que reproducen el bug original.** El test 4 del PR6c y el test anti-regresión void del PR6b-pivot-I son contratos contra el futuro: documentan exactamente el antipatrón y fallan si reaparece.
4. **Pausar ante ambigüedad.** El caso del `store_id=73722087` — antes de codificar fixes para "stock Flex desconocido", se pausó para investigar: resultó ser el propio warehouse Flex de BANVA registrado en ML, el fix original no era necesario, el real era otro.
5. **El cronograma real del sprint fue guiado por los hallazgos, no por el plan inicial.** El plan de sprint tenía PR5/PR6/PR7 con scopes distintos. El plan final es PR5/PR6a/PR6a-bis/PR6b-pivot A+I/PR6c. El scope cambió porque cada pre-auditoría reveló problemas más profundos.

## 9. Estado operativo post-sprint

Query al cierre (2026-04-21, post-merge, **pre-apply** de backfill PR6c):

| Métrica | Valor |
|---|---:|
| Total SKUs en motor | 533 |
| INACTIVO | 149 (post-apply esperado: ~141, los 8 active invisibles salen del grupo) |
| DEAD_STOCK | **4** (post-PR6a: cayó de 67 a 4 — eran 63 falsos positivos) |
| NUEVO | 63 (rama reactivada, estaba en 0 pre-PR6a) |
| OK | 68 |
| EXCESO | 142 |
| MANDAR_FULL | 8 |
| PLANIFICAR | 62 |
| EN_TRANSITO | 18 |
| AGOTADO_SIN_PROVEEDOR | 12 |
| AGOTADO_PEDIR | 2 |
| URGENTE | 5 |
| **Centinela `dias_sin_movimiento=999`** | **0** ✅ |
| SKUs con movimientos resueltos (335/533 = 63%) | 335 |

Salud del catálogo:

- 445 productos en tabla `productos`
- 414 con `composicion_venta` (93% — post-apply de PR6c esperado: **439**, 99%)
- 620 items activos en `ml_items_map`
- 335 SKUs con movimientos en 60d (los otros 198 INACTIVO o históricos)

## 10. Próximos pasos sugeridos

### Operativos (no-técnicos, prioridad alta esta semana)

- **Lista A — 5 SKUs MANDAR_FULL con plata durmiendo** para Joaquín:
  - TXV23QLAT20AQ (Quilt Atenas 20P Aqua) — 4 uds B-3 — $203k/mes
  - LITAF400G4PMT (Set 4 Toallas AFamily Menta) — 2 uds D-1 — $99k
  - JSAFAB431P20S (Sábanas Oasis Negro 2.0 S26) — 2 uds E1-2 — $71k
  - JSAFAB420P20W (Sábanas Vias Negro 2.0 W25) — 4 uds E1-2 — $60k
  - JSAFAB437P15W (Sábanas Cuadra 1.5 W26) — 5 uds E1-1 — $500
- **Lista B — 10 SKUs AGOTADO_SIN_PROVEEDOR para Idetex** (email formal):
  - Top: TXSB144IDN10P $247k, TXSB144IRK10P $68k, TXV23QLRM30GR $65k, TXSB144ILD15P $65k, TXV23QLAT15NG $60k, TXTPBL105200S $36k, TXV23QLAT15BE $29k, TXV23QLAT20NG $16k, **TEXCCWTILL10P vel_pre_quiebre=26/sem** (el más urgente a futuro), LITAF400G4POV $1k
  - Todos con `stock_idetex=0` en catálogo → solicitud de producción/ETA, no "servíme"
- **Liquidación de ~343 dead stock reales** (~$61M CLP inmovilizados en PLANIFICAR/INACTIVO viejos). Plan de markdown escalado por tramos de cobertura: >180d → 50%, 90–180d → 30%, 60–90d → 15%.

### Técnicos menores detectados, no críticos

- **SKU `9788433031075`** tiene 2 item_id activos en `ml_items_map` (posible duplicado de catálogo ML). Decidir consolidar a 1 o dejar como variante real.
- **193 "ghost SKUs" numéricos** (tipo `33173608`) en `ml_items_map.activo=true` sin producto padre y con `status_ml=paused`. Basura de imports ML viejos. Limpieza opcional: `UPDATE ml_items_map SET activo=false WHERE sku ~ '^[0-9]+$' AND status_ml='paused' AND NOT EXISTS (SELECT 1 FROM productos WHERE sku=ml_items_map.sku)`.
- **Link recepciones ↔ OCs.** Hoy `recepciones` no guarda `orden_compra_id` salvo en app externa factura-etiquetas. Sin ese link no se puede medir `σ_lead_time` real ni cerrar OCs por completo. 6+ semanas estimado, sprint dedicado futuro.
- **σ_LT real vía OCs formales.** Requiere que el proceso de compras cargue OCs con fecha esperada vs fecha real de recepción de forma consistente. Cambio operativo, no solo técnico.
- **Seller_warehouse 73722087** está bien identificado en el código (`getSellerStockType`) pero no hardcodeado como constante. Si en el futuro BANVA abre un segundo warehouse, hay que revisar `updateFlexStock` para soporte multi-store.
- **Test coverage del motor** sigue siendo ~60% de los pasos (los fixes agregaron tests de los 6 bugs específicos, no de las demás ramas). Próximo sprint: tests de integración end-to-end para al menos 3 acciones críticas (`URGENTE`, `MANDAR_FULL`, `DEAD_STOCK`).

---

**Sprint cerrado en git:** desde `f11eb07` (2026-04-18) hasta `ce5a398` (2026-04-21). Estado del árbol post-merge está limpio; tsc verde; 107 tests verdes. El PR6c `--apply` queda pendiente de ejecución manual (Vicente corre post-merge).
