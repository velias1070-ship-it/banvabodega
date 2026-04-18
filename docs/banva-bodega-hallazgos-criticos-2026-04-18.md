# Hallazgos críticos — 2026-04-18

Dos bugs/gaps detectados post-auditoría (`banva-bodega-auditoria-2026-04-18.md`) que pueden desplazar Sprint 6. Sin código tocado — solo queries + lectura de código.

---

## Hallazgo 1 — `dias_sin_movimiento = 999` en **todos** los SKUs

### 1.1 Confirmación

| Métrica | Valor |
|---|---:|
| Total SKUs en `sku_intelligence` | 533 |
| Con `dias_sin_movimiento = 999` | **533 (100 %)** |
| Con `ultimo_movimiento IS NULL` | **533 (100 %)** |
| Con `dias_sin_movimiento ≠ 999` | 0 |
| Con `dias_sin_movimiento > 1 000` | 0 |

**No es un subconjunto afectado — es el campo completamente apagado.**

**Por acción** (para contextualizar): los 999 se reparten uniformemente (INACTIVO 150, EXCESO 131, OK 68, DEAD_STOCK 67, PLANIFICAR 57, AGOTADO_PEDIR 18, MANDAR_FULL 17, URGENTE 13, AGOTADO_SIN_PROVEEDOR 12). Todos los SKUs lo tienen.

### 1.2 Causa — línea exacta

```ts
// src/lib/intelligence.ts:1241-1242
const ultimoMov = ultimoMovPorSku.get(skuOrigen) || null;
const diasSinMov = ultimoMov ? Math.floor((hoyMs - new Date(ultimoMov).getTime()) / 86400000) : 999;
```

`999` es un **valor centinela** cuando `ultimoMov` es null. **Distinto** al bug PR5 (contador por recálculo). Acá el problema es upstream: `ultimoMovPorSku` se construye pero no popula:

```ts
// src/lib/intelligence.ts:744-750
const ultimoMovPorSku = new Map<string, string>();
for (const m of movimientos) {
  const prev = ultimoMovPorSku.get(m.sku);
  if (!prev || m.created_at > prev) {
    ultimoMovPorSku.set(m.sku, m.created_at);
  }
}
```

### 1.3 Verificación en DB — el mapa SÍ tiene datos

| Query | Resultado |
|---|---:|
| `movimientos` totales últimos 60 d | **3 271** (2 007 salidas + 1 264 entradas) |
| SKUs distintos en `movimientos` 60 d | 335 |
| Match exacto `movimientos.sku` ↔ `sku_intelligence.sku_origen` | **335** (case idéntico, ambos UPPER) |
| Fecha más reciente en `movimientos` | 2026-04-18 17:40 |

Entonces **335 de 533 SKUs deberían tener `ultimo_movimiento` poblado**. El motor lo popula en memoria pero el campo llega NULL al upsert. Bug silencioso entre línea 748 (set del map) y línea 1241 (get del map) — posiblemente en la etapa de mapeo final (`rowToUpsert`).

### 1.4 Impacto operativo

| Campo afectado | Impacto |
|---|---|
| Acción **`NUEVO`** — regla `diasSinMov ≤ 30` | **❌ Ningún SKU puede ser `NUEVO`** hoy. 0 / 533 en esa acción. SKUs recién lanzados quedan clasificados como INACTIVO por fallback. |
| Acción `DEAD_STOCK` — regla basada en `vel`, NO en `dias_sin_movimiento` | ✅ No afectada. Los 67 DEAD_STOCK se calculan correctamente por `vel_ponderada=0 && vel_pre=0 && stock>0`. **No hay falsos dead stock por este bug.** |
| Reporting en UI (tab Pendientes, tab SKU Origen) | Muestra "999 días" — informacionalmente inútil |
| Alerta `sin_conteo_30d` | ✅ No afectada (usa `dias_sin_conteo`, columna distinta) |

### 1.5 Severidad

**MEDIA**, no crítica como PR5. El motor no toma decisiones operativas de peso a partir de `dias_sin_movimiento` — la puerta más tangible es la acción `NUEVO`, que hoy queda apagada para todo el catálogo. Nadie pierde plata por esto en el corto plazo.

### 1.6 Fix propuesto (no implementar hoy)

No es fix de centinela — es fix de bug real. Dos hipótesis a chequear en el próximo PR:

1. `rowToUpsert` en `src/app/api/intelligence/recalcular/route.ts` propaga `ultimo_movimiento` correctamente, pero `dias_sin_movimiento` podría no propagarse. Verificar.
2. El motor podría estar leyendo `movimientos` con un filtro que filtra todo. Agregar `console.log(ultimoMovPorSku.size)` al debug.

Además: el centinela `999` conviene reemplazar por `null` (más honesto) — es el mismo patrón que llevamos a cabo con `fecha_entrada_quiebre` en PR5. PR chico.

---

## Hallazgo 2 — `lead_time_real_sigma IS NULL` en los 533 SKUs

### 2.1 Confirmación

| Métrica | Valor |
|---|---:|
| Con `lead_time_real_sigma` poblado | **0 / 533** |
| Con `lead_time_real_dias` poblado | 0 / 533 |
| Suma de `lt_muestras` | 0 |
| `lead_time_fuente = 'oc_real'` | **0 SKUs** |

**Ningún SKU usa σ_LT medido empíricamente.**

### 2.2 Distribución de la fuente de lead time

| `lead_time_fuente` | n | % |
|---|---:|---:|
| `manual_proveedor` | **442** | 82.9 % |
| NULL (SKUs sin proveedor asignado) | 88 | 16.5 % |
| `fallback_default` | 3 | 0.6 % |
| `oc_real` | 0 | 0 % |
| `manual_producto_legacy` | 0 | 0 % |

### 2.3 ¿Por qué σ_LT real es imposible hoy?

Los datos necesarios para calcular σ_LT son `fecha_pedido - fecha_recepcion` a través del tiempo. Estado en DB:

| Fuente | Total | Utilizable para σ_LT | Nota |
|---|---:|---:|---|
| `ordenes_compra` | **4** | **0** | Las 4 son `ANULADA`. |
| `recepciones` | 66 | 0 | **0 con `orden_compra_id`** — la app Etiquetas crea recepciones huérfanas (gap #9 de deuda técnica). |
| `movimientos` tipo `entrada` + `recepcion_id` | 54 | 0 | Tienen recepción pero sin OC → sin fecha_pedido. |

**Conclusión**: σ_LT real requiere proceso operativo de crear OCs con `fecha_emision`, no un fix de código. **Es un gap de gobernanza**, no técnico.

### 2.4 ¿El motor usa entonces sólo el fallback de 5 d?

**No.** El motor usa σ_LT **manual del proveedor** (tabla `proveedores.lead_time_sigma_dias`) en 442 SKUs. Código (`intelligence.ts:1694`):

```ts
return { dias: provData.lead_time_dias, sigma_dias: provData.lead_time_sigma_dias,
         fuente: "manual_proveedor", muestras: provData.lead_time_muestras };
```

`lead_time_real_sigma` sólo se persiste en `sku_intelligence` cuando `fuente === "oc_real"` (línea 1715) — por eso los 442 salen NULL a pesar de que internamente el motor sí usa un σ_LT (el manual) para calcular SS.

### 2.5 Comparación SS_completo vs SS_simple

| Bucket | n | % |
|---|---:|---:|
| **Total evaluados** (`safety_stock_completo NOT NULL`) | **445** | — |
| `SS_completo = SS_simple` | 193 | 43.4 % |
| `SS_completo > SS_simple` (aporta protección) | **252** | **56.6 %** |
| `SS_completo < SS_simple` | 0 | 0 % |
| Delta promedio | +0.13 uds | — |
| Delta máximo | +2.93 uds | — |

**El Método King SÍ está aportando**: en 252 SKUs (57 %) el SS completo es mayor que el simple gracias al término `D̄² × σ_LT²`. El cálculo entra efectivamente en la fórmula. **No es gap falso como temías.**

### 2.6 Severidad

**BAJA–MEDIA**. El Método King opera con σ_LT manual de proveedor — no es óptimo pero es razonable si `proveedores.lead_time_sigma_dias` fue ingresado con criterio. Para afinar se necesitaría:

1. Backfill mínimo de OCs desde datos de recepciones + heurística de fecha de pedido (ej. `fecha_recepcion − lead_time_promedio_manual`) para alimentar `ordenes_compra` con registros proxy. Problema: los datos serán aproximados.
2. Proceso operativo real: hacer que las futuras compras creen OCs con `fecha_emision` registrada, y que `recepciones.orden_compra_id` apunte correctamente. Esto desbloquea σ_LT real en ~3-6 meses.

**Gap de calidad**, no de funcionalidad. El motor no está roto, sólo está trabajando con σ_LT asumido. La corrección depende de proceso, no de código.

### 2.7 Columna que reporté NULL en la auditoría: corrección

El ítem §3.5 de la auditoría (`σ_LT de Idetex medido`) lo marqué ⚠️ Parcial con prioridad A. **Ajuste post-investigación**: sigue siendo ⚠️ Parcial pero con prioridad **M** — el motor funciona razonablemente con el manual. Priorizar antes los gaps donde el motor NO funciona o donde hay $ directo.

---

## Resumen ejecutivo (≤10 líneas)

1. **Bug `999`**: **533/533 SKUs** con `dias_sin_movimiento=999` por fallback centinela en `intelligence.ts:1242`. **335 SKUs tienen movimientos reales en DB** que el motor debería encontrar, pero el upsert llega con NULL. Bug silencioso entre Map populate (línea 748) y row output (línea 1241). **Severidad media** — apaga la acción `NUEVO` (0/533 SKUs) pero **no genera falsos DEAD_STOCK** (se calculan por `vel`, no por `dias_sin_movimiento`).
2. **σ_LT NULL**: **0/533 SKUs** con `lead_time_real_sigma` poblado, **pero** el motor usa σ_LT **manual del proveedor** (442 SKUs, 83 %) — no fallback genérico. **SS_completo aporta protección extra en 252 SKUs (57 %)** vs SS_simple. No es gap falso; es gap de calidad.
3. **Bloqueo σ_LT real**: 4 OCs totales todas ANULADAS + 66 recepciones con 0 `orden_compra_id` → datos para medir σ_LT empírico **no existen**. Requiere proceso operativo, no código.
4. **Impacto financiero acumulado**: los dos hallazgos **no mueven plata directamente hoy**. Distinto a PR5 (que bloqueaba $4.4M en pedidos).
5. **Recomendación Sprint 6**: **mantener el plan original** (pausa ads + markdown + liquidación). Ninguno de estos dos hallazgos desplaza al Sprint 6.
6. **Bug `999`** merece un PR chico (PR5.1 o embebido en PR6) — fix real del upsert + reemplazar centinela por NULL. Estimado: 2 h.
7. **σ_LT empírico** es Sprint 8+ — requiere rediseño del flujo de OCs/recepciones con app Etiquetas, scope >1 sprint.
8. **SKUs recuperables con fix del bug `999`**: estimado ~4-8 SKUs que deberían ser `NUEVO` hoy (lanzamientos recientes < 30d de primer movimiento). No es volumen crítico, pero deja de clasificar mal productos nuevos como INACTIVO.
9. **Ajuste de la auditoría**: §3.5 pasa de prioridad A a M (σ_LT manual sí opera). El resto de la auditoría queda intacto.
10. **Patrón detectado** (misma familia que PR5): centinelas numéricos (`999`, `2071` pre-PR5) que esconden bugs silenciosos. Regla a incorporar en `.claude/rules/inventory-policy.md`: **nunca usar valores centinela numéricos; usar NULL y manejar explícitamente**. Es la segunda vez que mordemos la misma fruta.
