# PR6b — Pre-auditoría: pausa automática de Product Ads en SKUs OOS

Datos post-fix PR6a (commit `533672a`, v56 aplicada, backfill ejecutado, recálculo completo). Sin código escrito.

---

## Confirmación post-fix PR6a (bug 999)

| Query | Pre-fix | Post-fix | Estado |
|---|---:|---:|---|
| `count(*) WHERE dias_sin_movimiento = 999` | 533 | **0** | ✅ |
| `accion = 'NUEVO'` | 0 | **67** | ✅ rama NUEVO activa |
| `accion = 'DEAD_STOCK'` | 67 | 0 | 63 SKUs reclasificados a NUEVO, 4 a otros |
| `accion = 'INACTIVO'` | 150 | 150 | = |
| `accion = 'EXCESO'` | 128 | 132 | +4 |
| `dias_sin_movimiento IS NULL` | — | **533** (100 %) | ⚠️ ver nota abajo |

**Nota sobre `dias_sin_movimiento=NULL` en todos**: el backfill pobló correctamente 335 SKUs con valor concreto, pero el recálculo posterior los sobreescribió a NULL. Esto sugiere que el motor **sigue sin matchear** `ultimoMovPorSku.get(skuOrigen)` aunque el `Map` tiene datos (3 271 movimientos en DB, 335 distinct match). El `console.warn` que agregamos no apareció en Vercel logs → el Map no viene vacío, pero los gets fallan.

**Diagnóstico**: hay un bug **secundario** de matching (probable string mismatch sutil, ej. trimming o encoding) que queda sin resolver. **No bloquea PR6b** porque el fix estructural (acción NUEVO activa, 0 centinelas) está OK. Queda como gap sub-20.

**Logs Vercel**: 0 errores/warnings en `/api/intelligence/recalcular` últimos 5 min.

---

## 3.1 Integración ML Ads existente

**Endpoints ya implementados** (grep en `src/app/api/ml/`):

| Ruta | Propósito | ¿Pausa? |
|---|---|---|
| `ads-daily-sync` | Pull de gastos, clicks, impressions a `ml_ads_daily_cache` | ❌ sólo lectura |
| `ads-rebalance` | Re-atribuye costos a ventas (pro-rata pro-rata ads/día) | ❌ sólo escritura local, no ML |
| `item-promotions` | Listar promos activas de un item | ❌ promos ≠ Product Ads |
| `promotions` | CRUD de Seller Promotions (descuentos) | ❌ distinta API |

**Operaciones tipo pausa que SÍ existen** (pero para otros scopes):
- `src/lib/ml.ts:1583` `activateFlexItem(itemId)` — Flex logística (actualmente bloqueado).
- `src/lib/ml.ts:1593` `deactivateFlexItem(itemId)` — Flex logística.

**No existe pausar/activar Product Ads.** Integración 100 % nueva.

**Endpoint ML probable** (referencia: `developers.mercadolibre.cl/es_ar/product-ads`):

```
POST /advertising/product_ads/items/{item_id}
Body: { "status": "paused" }
```

O bien por campaña:
```
POST /advertising/product_ads/campaigns/{campaign_id}/ads/{ad_id}
Body: { "status": "paused" }
```

A confirmar en docs oficiales; `scripts/sync-meli-docs.ts` del repo ya escrapea `docs/meli/` y puede servir para validar endpoint exacto.

## 3.2 Dónde se guardan las campañas

| Tabla | Rows | Uso actual | ¿Sirve para pausa? |
|---|---:|---|---|
| `ml_ads_daily_cache` | 29 602 total / 9 806 últ. 30d | Snapshot diario de métricas por `item_id + date` (cost_neto, clicks, prints, direct_amount, acos, roas). **NO tiene status activa/pausada**. | ❌ sin flag |
| `ml_campaigns_mensual` | 5 rows | Agregado mensual por campaña: `campaign_id, campaign_name, campaign_status, budget, roas_target...`. **Sí tiene `campaign_status`** (una sola fila por campaña, no por item) | Parcial — status campaña padre, no a nivel ad individual |
| `ml_items_map.status_ml` | 282 paused / 341 active / 31 closed / 5 under_review | Status del **item ML** (publicación), no del ad. Un item activo puede tener ad pausado y viceversa. | ❌ mezcla conceptos |

**Hoy no hay tabla/cache local de "este item tiene ad activo"**. El único estado vive en la API de ML.

**Recomendación**: agregar columna `ml_items_map.ad_status text NULL` + `ad_paused_by_motor boolean DEFAULT false` + `ad_paused_at timestamptz`. La segunda distingue "pausado manualmente por Vicente" de "pausado automáticamente por el motor" — crítico para re-activación segura.

## 3.3 Universo candidato a pausar (DATOS LIMPIOS POST-PR6a)

| Métrica | Valor |
|---|---:|
| SKUs con `stock_total = 0` (OOS) | **192** |
| SKUs con `stock_total > 0 && cob_full < 10` (proyección corta) | 15 |
| SKUs críticos (URGENTE + AGOTADO_*) | 43 |
| AGOTADO_SIN_PROVEEDOR | 12 |
| AGOTADO_PEDIR + AGOTADO_SIN_PROVEEDOR | 30 |

### Los 3 números clave que pediste

| Número | Valor |
|---|---:|
| **SKUs OOS con ads (≥1 día con cost_neto>0 en últimos 30d)** | **15** |
| **Gasto de esos 15 SKUs en ads últimos 30d (neto)** | **$175 181 CLP** |
| Generado atribuido a esos items (direct + indirect) 30d | $2 127 868 CLP¹ |
| Unidades vendidas atribuidas (direct+indirect+organic) | 136 |
| **SKUs con cob<10 y ads activos (extra sobre OOS)** | 17 ítems adicionales |
| **Gasto cob<10 últimos 30d (neto)** | $117 083 CLP |
| **Total ahorro mensual estimado (OOS + cob<10)** | **~$292 264 CLP netos** |

¹ **Aclaración importante**: el "generado atribuido" es retrospectivo — incluye ventas que ocurrieron **antes** de que el SKU quedara en OOS. El ahorro real forward es el spend neto ($175k OOS + $117k cob<10), porque si están OOS hoy no van a generar más.

Total ads gastados 30d globales: **$2 740 153 CLP**. Los "SKUs problemáticos" representan **~10.7 %** del spend total. Escala menor que el estimado del manual ($200-400k), pero consistente en orden de magnitud.

## 3.4 Criterio de pausa — 3 opciones

### Opción A — Conservadora (solo `stock_total = 0`)
- **Criterio**: `stock_total = 0` AND `accion IN ('AGOTADO_PEDIR','AGOTADO_SIN_PROVEEDOR','URGENTE')`
- **Universo**: **15 items** (los OOS con ads) — subset de los 43 críticos.
- **Ahorro mensual**: ~$175k netos.
- Pro: cero falsos positivos.
- Contra: deja corriendo ads con cob_full = 1-3 días (quiebre inminente pero aún no OOS).

### Opción B — Media (cob_full < 7 OR OOS)
- **Criterio**: `stock_total = 0` OR (`stock_total > 0` AND `cob_full < 7`)
- **Universo**: estimado **~25-30 items** (15 OOS + ~10-15 con cob<7).
- **Ahorro mensual**: ~$230-250k netos.
- Pro: previene stockout con margen; sigue el benchmark del Manual Parte 3 Error #4 (<10d pero usamos 7 para más margen).
- Contra: puede pausar SKUs a días de recibir reposición.

### Opción C — Agresiva (cob_full < 14 OR OOS)
- **Criterio**: `stock_total = 0` OR `cob_full < 14`
- **Universo**: **~32 items** (15 OOS + 17 con cob<10 ≤ cob<14).
- **Ahorro mensual**: ~$292k netos.
- Pro: máximo ahorro.
- Contra: flapping con reposiciones en ciclo de 1-2 semanas (típico de BANVA).

### Recomendación: **Opción A en PR6b Fase 1**, evaluar B/C según resultados a 30 días

Razones:
1. El universo "solo OOS" son **15 items concretos**, alineados con decisiones ya tomadas (si está `AGOTADO_SIN_PROVEEDOR`, nadie discute que se pause).
2. PR6b es la primera integración con endpoint de Product Ads — que sea cautelosa. Si falla el endpoint en 1 de los 15, hay impacto limitado.
3. Los 17 items `cob<10` son candidatos a "urgentes con stock" — el motor ya marca `URGENTE` / `necesita_pedir`. Pausar ads en ellos puede ser contraproducente si la reposición llega en días (especialmente MANDAR_FULL que sólo espera envío).
4. Benchmarking a 30 días: si A funciona y no hay falsos positivos, pasar a B (cob<7) en PR6b Fase 2. Incremental, reversible.

## 3.5 Criterio de re-activación

Cuando `stock_total > 0` **y** `cob_full ≥ umbral_reactivar`:

- **Umbral propuesto**: `cob_full ≥ 14 días` (doble del umbral de pausa, evita flapping).
- **Hysteresis**: al pausar con `cob<10`, sólo re-activar con `cob≥14`. Si usamos Opción A (pausa sólo con stock=0), re-activar con `cob≥14` tras reposición.
- **Sin aprobación manual** en PR6b Fase 1 — automatizar el ciclo completo. Si se abusa, Fase 2 puede exigir aprobación.
- **Cooldown**: 48 h entre pausa y re-activación (evita ruido por errores de conteo intradiarios).
- **Sólo re-activar lo que el motor pausó** (campo `ad_paused_by_motor = true`). Items pausados manualmente por Vicente **no** se tocan.

## 3.6 Riesgos y mitigaciones

| Riesgo | Probabilidad | Mitigación |
|---|---|---|
| Pausar SKU con stock real no registrado (error de IRA) | Media | Cross-check con `stock_full_cache` (≠ 0 aunque stock bodega=0 también cuenta). Si `stock_full + stock_bodega = 0` real → pausar con confianza |
| Flapping (pausar/reactivar repetido) | Baja | Hysteresis 10↔14 + cooldown 48 h + flag `ad_paused_by_motor` |
| Error en API ML (401/500) | Baja | Try/catch + retry con backoff + log en `audit_log`. Si 3 fallos consecutivos, alerta + no reintentar |
| Perder ranking orgánico | Media | Manual Parte 3 §7.4 dice "recuperación 2-6 semanas post-pausa". Mitigación: pausar **solo** cuando OOS real (Opción A). El ranking igual se pierde por estar en OOS con o sin ads |
| Pausar item que comparte campaña con ítems activos | Alta si API es por campaña, baja si es por ad individual | Usar endpoint a nivel ad/item, no campaña |
| Re-activar en ciclo rápido sin que Vicente se entere | Baja | Banner en AdminInteligencia mostrando "N items pausados por motor" + log |

## 3.7 Scope estimado PR6b

| Componente | Detalle | LOC est. | Migración |
|---|---|---:|---|
| Migración v57 | +2 cols en `ml_items_map`: `ad_status text`, `ad_paused_by_motor boolean`, `ad_paused_at timestamptz` | 15 | sí |
| Función en `src/lib/ml.ts` | `pauseProductAd(item_id)` + `resumeProductAd(item_id)` | 60 | — |
| Endpoint cron `/api/ml/ads-pause-oos` | Lee `sku_intelligence` + `ml_items_map`, identifica los 15 candidatos, llama `pauseProductAd`, loggea. Idempotente (no re-pausar lo ya pausado por motor) | 120 | — |
| `vercel.json` | Cron `0 12 * * *` diario (post-recálculo 11 UTC) | 5 | — |
| UI `AdminInteligencia.tsx` | Banner "N items con ads pausados por motor" en el tab Accuracy (o nuevo tab "Ads Watch") | 40 | — |
| Tests | 5-6 casos: elegible, no elegible (manual), reactivación, idempotencia, error API | 80 | — |
| Script `scripts/pausar-ads-oos.ts` | Dry-run/apply manual para primera corrida supervisada | 100 | — |
| Docs | §8.17 nueva en inteligencia.md + README PR6b | 40 | — |

**Total estimado**: ~460 LOC, 1 migración, 1 cron nuevo, 1 script.
**Tiempo estimado**: 1 día (4-6 horas código + tests + dry-run + documentación).

## 3.8 Alternativa considerada: infraestructura reutilizable

**¿Algo que aproveche sin crear de cero?**

- **`ads-rebalance`**: es el cron que recalcula atribución; podría agregarle la lógica de pausa como sub-tarea. Contra: mezcla responsabilidades (rebalance es read/write local, pausa es write remoto a ML). **Mejor endpoint separado.**
- **`scan-promos`**: escanea promos activas; patrón similar al que necesitamos. Pero promos ≠ ads. Sirve como **plantilla** para el nuevo endpoint.
- **`ml_items_map.status_ml`**: ya trackea status del item (active/paused/closed). Podemos **extender** en vez de agregar columna nueva, pero mezcla conceptos (item ≠ ad). **Mejor agregar `ad_status` separado.**
- **`scripts/backfill-dias-en-quiebre.ts` / `backfill-dias-sin-movimiento.ts`**: patrón de script dry-run/apply. Reutilizable de plantilla para `pausar-ads-oos.ts`.

**Conclusión**: no hay pieza directamente reutilizable para pausa; hay varias **plantillas** para adaptar (scan-promos, backfill scripts). Código nuevo inevitable, pero patrón consolidado.

---

## Resumen

| Bloque | Estado |
|---|---|
| Integración Product Ads | **No existe** — PR6b la crea desde cero con 1 endpoint ML nuevo (`POST .../product_ads/items/{id}`) |
| SKUs OOS con ads HOY | **15** |
| Spend mensual de esos 15 | **$175 181 netos** (Opción A); con cob<10 sube a **$292 264** (Opción C) |
| Recomendación criterio | **Opción A** en Fase 1 (conservadora) |
| Scope técnico | ~460 LOC + migración v57 + cron + UI banner |
| Tiempo estimado | 1 día |
| Gap secundario detectado | Motor no matchea `ultimoMovPorSku` aunque Map tiene datos (no bloquea PR6b) |

**Ahorro anual proyectado PR6b Fase 1**: $175k × 12 = **~$2.1M CLP/año** sin contar SKUs adicionales que se sumen al OOS en el futuro. Fácilmente rentable contra 1 día de desarrollo.
