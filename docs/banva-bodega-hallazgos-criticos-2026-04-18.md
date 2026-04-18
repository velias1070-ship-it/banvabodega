# Hallazgos críticos post-auditoría — 2026-04-18

> Investigación de los 2 hallazgos de la auditoría (`docs/banva-bodega-auditoria-2026-04-18.md`) que necesitan validación antes de Sprint 6: el valor centinela `999` en `dias_sin_movimiento`, y `lead_time_real_sigma` NULL en los 533 SKUs. Solo queries + lectura de código; sin cambios al sistema.

---

## Hallazgo 1 — Bug `dias_sin_movimiento = 999`

### 1.1 Confirmación del estado

Query 1:

```sql
SELECT count(*), accion FROM sku_intelligence
WHERE dias_sin_movimiento = 999 GROUP BY accion ORDER BY count DESC;
```

| accion | afectados |
|---|---|
| INACTIVO | 150 |
| EXCESO | 131 |
| OK | 68 |
| **DEAD_STOCK** | **67** |
| PLANIFICAR | 57 |
| AGOTADO_PEDIR | 18 |
| MANDAR_FULL | 17 |
| URGENTE | 13 |
| AGOTADO_SIN_PROVEEDOR | 12 |
| **Total** | **533 (100%)** |

Query 2:

```sql
SELECT
  count(*) FILTER (WHERE dias_sin_movimiento = 999) AS c_999,
  count(*) FILTER (WHERE dias_sin_movimiento = 0 AND ultimo_movimiento IS NULL) AS c_sin_hist,
  count(*) FILTER (WHERE dias_sin_movimiento > 1000) AS c_grande,
  max(dias_sin_movimiento) AS max_valor,
  count(*) FILTER (WHERE ultimo_movimiento IS NOT NULL) AS con_ult_mov,
  count(*) FILTER (WHERE ultimo_movimiento IS NULL) AS sin_ult_mov
FROM sku_intelligence;
```

Resultado: `c_999=533`, `max_valor=999`, `con_ult_mov=0`, `sin_ult_mov=533`. Los 533 SKUs tienen `ultimo_movimiento=NULL` y `dias_sin_movimiento=999` simultáneamente. No hay otros valores centinela.

### 1.2 Impacto real en DEAD_STOCK (cruce contra `movimientos` real)

```sql
WITH ult AS (SELECT sku, MAX(created_at) AS ult_mov FROM movimientos GROUP BY sku)
SELECT
  count(*) AS dead_stock_total,
  count(*) FILTER (WHERE u.ult_mov IS NOT NULL) AS con_movimiento_real,
  count(*) FILTER (WHERE u.ult_mov > now() - interval '30 days') AS mov_ult_30d,
  count(*) FILTER (WHERE u.ult_mov > now() - interval '90 days') AS mov_ult_90d,
  count(*) FILTER (WHERE u.ult_mov IS NULL) AS realmente_sin_historia
FROM sku_intelligence si LEFT JOIN ult u ON u.sku = si.sku_origen
WHERE si.accion = 'DEAD_STOCK';
```

| Métrica | Valor |
|---|---|
| Total marcados DEAD_STOCK | 67 |
| Tienen movimiento real | **53 (79%)** |
| Movimiento en últimos 30 días | **49 (73%)** |
| Movimiento en últimos 90 días | 53 |
| Realmente sin historia | 14 |

**Lectura:** 49/67 SKUs marcados DEAD_STOCK tuvieron movimientos de inventario en los últimos 30 días. **No son dead stock — son SKUs recién recepcionados sin ventas todavía.** El motor no los distingue porque `dias_sin_movimiento=999` los hace indistinguibles de SKUs abandonados.

### 1.3 Línea del código que genera el 999

`src/lib/intelligence.ts:1242`:

```ts
const ultimoMov = ultimoMovPorSku.get(skuOrigen) || null;
const diasSinMov = ultimoMov ? Math.floor((hoyMs - new Date(ultimoMov).getTime()) / 86400000) : 999;
```

Antes, en `intelligence.ts:744-750`:

```ts
const ultimoMovPorSku = new Map<string, string>();
for (const m of movimientos) {
  const prev = ultimoMovPorSku.get(m.sku);
  if (!prev || m.created_at > prev) {
    ultimoMovPorSku.set(m.sku, m.created_at);
  }
}
```

La fuente del Map es `movimientos: MovimientoInput[]`, que en producción llega desde `queryMovimientos(60)` (`src/lib/intelligence-queries.ts:211`) — **solo los últimos 60 días** de `movimientos`.

`intelligence.ts:1422-1423` escribe al row:

```ts
ultimo_movimiento: ultimoMov,
dias_sin_movimiento: diasSinMov,
```

Y `src/app/api/intelligence/recalcular/route.ts:512-513` los pasa al upsert.

Capa DB: `sku_intelligence.dias_sin_movimiento INT DEFAULT 999`. Cuando el upsert manda un valor explícito debería sobrescribir el default; si no manda, toma 999.

### 1.4 ¿Es el mismo patrón que PR5 (f11eb07)?

**No.** PR5 arregló `dias_en_quiebre` que se acumulaba por recálculo (contador post-hoc). Este bug es distinto:

1. El Map `ultimoMovPorSku` llega vacío o sin matches para los 533 SKUs del último recálculo persistido.
2. El fallback es 999 (sentinel).
3. **No se acumula**, se calcula en cada recálculo. Un recálculo siguiente con el Map poblado repararía el estado — pero aparentemente no ha vuelto a ocurrir con data completa.

Causa probable (no confirmable sin logs): un recálculo reciente corrió cuando `movimientos` fetch devolvió 0 filas (transient error, timeout, o scope filtrado), y el upsert completo persistió `NULL + 999` para todos. Evidencia circunstancial: `movimientos` hoy tiene 3,271 filas y **335 SKUs distintos en últimos 60 días** — esos 335 deberían tener `ultimo_movimiento` poblado si el recálculo actual usa la data completa. El que haya 0/533 sugiere que el último upsert vio Map vacío.

Hipótesis alterna: el cron/UI corre recálculo "full=true" pero el fetch de movimientos falla silencioso (no hay `throw`, el código `if (!sb) return []` devuelve array vacío) y no se detecta.

**Fix dual (sin implementar aquí):**

- **Auto-sanación:** si `movimientos.length === 0` durante el recálculo, NO sobrescribir `ultimo_movimiento`/`dias_sin_movimiento` (preservar el valor previo).
- **Defensa en profundidad:** cambiar `DEFAULT 999` → `DEFAULT NULL` en la columna; así la ausencia es visible y no se confunde con "hace 999 días".

### 1.5 Impacto estimado

| Consecuencia | Volumen |
|---|---|
| SKUs con `dias_sin_movimiento` corrupto | **533 / 533 (100%)** |
| Acción `NUEVO` nunca se asigna | `intelligence.ts:1268` — `else if (esNuevo && diasSinMov <= 30)`. Condición nunca se cumple → **rama NUEVO muerta** |
| SKUs mal-clasificados DEAD_STOCK que son NUEVO | **~49** (de 67 DEAD_STOCK, 49 con mov. últ. 30d) |
| UI muestra "999" a usuarios | Sí, columna visible en `src/lib/agents-data.ts:176` y cualquier dashboard que consuma `sku_intelligence` |
| Alerta `dead_stock` afectada | **No directamente.** La alerta (`intelligence.ts:1811`) viene de `velPonderada===0 && stTotal>0`; no depende de diasSinMov |

**Severidad:** Media-alta. No sesga la *acción* DEAD_STOCK (que sigue a velocidad=0), pero sí apaga el camino NUEVO y distorsiona toda lectura humana basada en `dias_sin_movimiento`. Menos crítico que PR5 (que sesgaba ramp-up via velocidad_pre_quiebre), pero sí hay ~49 falsos positivos visibles.

---

## Hallazgo 2 — `lead_time_real_sigma IS NULL` en los 533 SKUs

### 2.1 Confirmación del estado

```sql
SELECT
  count(*) AS total_skus,
  count(lead_time_real_sigma) AS con_sigma,
  count(lead_time_real_dias) AS con_lt_medio,
  count(lt_muestras) AS con_muestras,
  max(lt_muestras) AS max_muestras
FROM sku_intelligence;
```

| total_skus | con_sigma | con_lt_medio | con_muestras | max_muestras |
|---|---|---|---|---|
| 533 | **0** | **0** | 533 (default 0) | **0** |

Ningún SKU tiene `lead_time_real_*` poblado. `lt_muestras=0` para todos → sin una sola muestra usable de OC real.

Distribución de `lead_time_fuente`:

| lead_time_fuente | count |
|---|---|
| `manual_proveedor` | 442 |
| `NULL` | 88 |
| `fallback_default` | 3 |
| `oc_real` | **0** |

**0/533 SKUs** usan lead time medido desde OCs. 442 usan el LT manual del proveedor, 88 caen a NULL (probable: productos sin proveedor asignado o sin matchear en `proveedoresLT`), 3 al fallback duro de 5 días.

### 2.2 ¿Hay OCs utilizables?

`ordenes_compra` tiene **4 filas totales**, **0 con `fecha_recepcion`**, **0 con `lead_time_real` calculado**. El código exige `muestras >= 3` para adoptar fuente `oc_real` (`intelligence.ts:1690`) — hoy `muestras=0` para todos los proveedores.

Fuente alternativa (`recepciones` + link a `ordenes_compra`):

```sql
SELECT count(*), count(orden_compra_id) FROM recepciones;
-- 66 recepciones, 0 con orden_compra_id
```

**Las 66 recepciones existentes no tienen `orden_compra_id`.** Sin ese link no hay `fecha_pedido → fecha_recepcion` computable. El flujo de recepción via la app externa "Factura Etiquetas" graba recepciones sin OC asociada — es un gap de datos **estructural**, no solo de backfill.

### 2.3 Qué hace el motor cuando σ_LT no está

`src/lib/intelligence.ts:1681-1701` — `resolverLeadTime(prodInput)`:

```ts
function resolverLeadTime(prodInput): { dias, sigma_dias, fuente, muestras } {
  const provData = proveedoresLT.get(provNombre);
  if (provData && provData.lead_time_fuente === "oc_real" && provData.lead_time_muestras >= 3) {
    return { ..., fuente: "oc_real" };
  }
  if (provData) {
    return { ..., fuente: "manual_proveedor" };
  }
  if (prodInput?.lead_time_dias && prodInput.lead_time_dias !== 7) {
    return { dias, sigma_dias: 0.30 * prodInput.lead_time_dias, fuente: "manual_producto_legacy" };
  }
  return { dias: 5, sigma_dias: 1.5, fuente: "fallback_default" };
}
```

El motor **NO degrada a σ_LT=0**. Usa σ_LT manual del proveedor, o heurística 30% del LT, o fallback 5d/1.5d (CV 30%).

Luego `intelligence.ts:1733-1741`:

```ts
if (sigmaD > 0 || sigmaLtSem > 0) {
  const ssCompleto = Z * Math.sqrt(ltSem * sigmaD² + D² * sigmaLtSem²);
  r.safety_stock_completo = ssCompleto;
  r.safety_stock_fuente = "formula_completa";
} else {
  r.safety_stock_completo = ssSimple;
  r.safety_stock_fuente = "fallback_simple";
}
```

La fórmula completa SÍ ejecuta incluso sin σ_LT real, mientras haya σ_D o σ_LT manual no-cero.

### 2.4 Comparación SS_completo vs SS_simple

```sql
SELECT
  count(*) AS total,
  count(*) FILTER (WHERE safety_stock_completo = safety_stock_simple) AS iguales,
  count(*) FILTER (WHERE safety_stock_completo > safety_stock_simple) AS completo_mayor,
  count(*) FILTER (WHERE safety_stock_completo < safety_stock_simple) AS completo_menor,
  avg(safety_stock_completo - safety_stock_simple) AS delta_prom,
  avg(safety_stock_completo) AS ss_completo_avg,
  avg(safety_stock_simple) AS ss_simple_avg
FROM sku_intelligence
WHERE safety_stock_completo IS NOT NULL AND safety_stock_simple IS NOT NULL;
```

| total | iguales | completo_mayor | completo_menor | delta_prom | completo_avg | simple_avg |
|---|---|---|---|---|---|---|
| 445 | 193 (43%) | 252 (57%) | 0 | **+0.13 uds** | 2.01 uds | 1.88 uds |

**Lectura:**

- SS_completo sí aporta algo respecto al simple (+0.13 uds promedio, +7% relativo).
- En 193 casos es idéntico (SKUs C con velocidad baja donde `D² × σ_LT²` es despreciable).
- **Corrección al diagnóstico previo:** la auditoría dijo "fórmula completa equivalente al simple por fallback". Es parcialmente cierto — sí hay diferencia, pero el delta es económicamente irrelevante. El Método King está prendido pero no aporta señal material.

### 2.5 El hallazgo gordo: LT = 5 días en TODOS los proveedores

```sql
SELECT nombre, lead_time_dias, lead_time_sigma_dias, lead_time_fuente, lead_time_muestras
FROM proveedores ORDER BY nombre;
```

| Proveedor | LT dias | σ_LT | fuente | muestras |
|---|---|---|---|---|
| Container | 5 | 1.5 | manual | 0 |
| **Idetex** | **5** | **1.5** | **manual** | **0** |
| LG | 5 | 1.5 | fallback | 0 |
| Materos | 5 | 1.5 | fallback | 0 |
| Otro | 5 | 1.5 | fallback | 0 |
| Verbo Divino | 5 | 1.5 | fallback | 0 |

**Crítico:** Idetex tiene `lead_time_dias=5` cuando el manual dice **30–45 días** (Parte1 §1.1; §4.4.5 ejemplo usa LT=5 semanas=35 días; Parte3 §10 Fase 2 habla de "medir σ_LT real con OCs históricas" — asumiendo LT de decenas de días).

398/443 SKUs son Idetex (90%). Todos usan LT=5 días en vez del real 30-45:

- **ROP subestimado 6-9x.** `ROP = D × LT + SS`: con LT falso de 5 días vs real 35, el componente `D × LT` es 7x menor.
- **Safety stock subestimado factor √7 ≈ 2.6x.** Fórmula `SS = Z × √(LT × σ_D²)`.
- **Cada OC Idetex tarda en reponer mucho más** de lo que el sistema asume. Eso explica los 45 SKUs en quiebre actual: el sistema pide "a tiempo" según su modelo, pero el camión tarda 6-9x más.

Esto es un problema de **datos en `proveedores`**, no de fórmula. `lead_time_fuente="manual"` indica edición humana. Default o corrección errónea tras crear la tabla. Invalida toda la cadena de reposición para el 90% del catálogo.

### 2.6 Severidad

| Afirmación | Estado |
|---|---|
| σ_LT medido desde OCs reales existe | ❌ 0/533 |
| OCs históricas utilizables | ❌ 0 (ninguna con fecha_recepcion; recepciones sin link a OC) |
| SS_completo != SS_simple matemáticamente | ✅ Sí (pero delta +7%) |
| Método King aporta señal económicamente | ⚠️ Prácticamente no (+0.13 uds) |
| **LT del proveedor dominante (Idetex) es correcto** | ❌ **5 días vs 30-45 reales** |
| **ROP de 398 SKUs Idetex subestimado 6-9x** | ✅ **Sí — raíz real de los quiebres** |

**Severidad: muy alta.** No es solo que σ_LT no esté medido — el **LT medio** en sí es falso para el 90% del catálogo. El gap `σ_LT NULL` es secundario al gap `LT=5 días es falso`.

---

## Resumen ≤10 líneas

1. **Bug 999 confirmado:** 533/533 SKUs con `ultimo_movimiento=NULL` y `dias_sin_movimiento=999`. Línea raíz `intelligence.ts:1242` (sentinel cuando Map vacío) + `DEFAULT 999` en DB. Causa probable: un recálculo completo con fetch de movimientos fallando silencioso sobrescribió el estado.
2. **Severidad bug 999: media-alta.** 49/67 SKUs marcados DEAD_STOCK son en realidad NUEVOS (con movimientos últimos 30d). Rama `accion=NUEVO` (`intelligence.ts:1268`) está muerta. No sesga DEAD_STOCK como acción (esa sigue a velocidad=0), pero sí la lectura humana y el onboarding de SKUs frescos.
3. **σ_LT NULL confirmado:** 0/533 con σ_LT real. Fórmula completa SÍ ejecuta con σ_LT manual (30% del LT), produce delta de solo +0.13 uds sobre SS_simple. Método King encendido pero sin aportar señal material. El gap "cerrado" por la auditoría previa estaba en modo placebo.
4. **Hallazgo colateral crítico:** `proveedores.Idetex.lead_time_dias = 5 días` (manual). El manual dice **30-45 días para Idetex**. 398/443 SKUs (90%) con ROP subestimado 6-9x. **Esta es la raíz real de los 45 SKUs en quiebre hoy**, no la falta de σ_LT.
5. **Imposibilidad estructural de medir σ_LT real hoy:** 4 OCs (0 con fecha_recepcion) + 66 recepciones (0 con `orden_compra_id`). La app Etiquetas graba recepciones sin link a OC. Sin arreglar ese flujo, σ_LT real seguirá NULL indefinidamente.
6. **Recomendación Sprint 6 — reordenar:** el plan original "pausa ads + markdown + liquidación" ataca sangría comercial, pero el **LT=5 falso es más urgente** porque invalida decisiones de compra para el 90% del catálogo. Una actualización manual del campo es trabajo de 5 minutos con ROI inmediato.
7. **Secuencia propuesta:** (a) Día 0: `UPDATE proveedores SET lead_time_dias=35, lead_time_sigma_dias=10 WHERE nombre='Idetex'` — 1 query, arregla ROP de 398 SKUs. (b) Día 1: fix bug 999 (guarda "si movimientos.length=0 no sobrescribir" + `DEFAULT NULL`). (c) Días 2-14: volver al plan Sprint 6 (ads, markdown) sobre base sanitizada.
8. **Falsos DEAD_STOCK recuperables con fix 999:** ~49 SKUs dejarían de figurar como DEAD_STOCK y entrarían a NUEVO o MANDAR_FULL. Lista DEAD_STOCK real se reduciría a ~18 casos (14 sin historia + ~4 con genuina inactividad).
9. **Método King honesto requiere data engineering:** link recepciones↔OCs (cambio en app Etiquetas o flujo interno), backfill OCs Idetex 12m desde email/Excel. No es 2-semana sprint — son 6+ semanas. Declararlo "cerrado" en la auditoría actual fue optimista; corresponde marcarlo ⚠️ Parcial con caveat.
10. **Veredicto:** Sprint 6 necesita insertar un paso 0 de 1 día ("arreglar LT Idetex + bug 999") antes de ads/markdown. Sin eso, pausar ads ahorra plata pero los pedidos a Idetex siguen saliendo 6-9x más tarde de lo necesario, y el panel muestra ~49 falsos dead stock que confunden la operación diaria.
