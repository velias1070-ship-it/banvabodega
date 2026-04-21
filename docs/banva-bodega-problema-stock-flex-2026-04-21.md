# Problema: stock fantasma Flex + cadena de decisiones rotas — 2026-04-21

> Diagnóstico detallado descubierto al auditar el SKU `TXV24QLBRBA15`. No es un bug único — es una cadena de 8 problemas que se refuerzan entre sí y distorsionan las decisiones de reposición, envío a Full, y publicación en ML. Este doc es para auditoría profunda: cada problema viene con evidencia DB, líneas de código, impacto cuantificado cuando aplica, y referencia cruzada con los otros.

## Caso testigo

SKU: `TXV24QLBRBA15` — Quilt Bruselas Bars Single (Idetex, ABC=B, XYZ=Y, cuadrante=REVISAR).

Estado 2026-04-21:

| Campo | Valor |
|---|---|
| stock_bodega | 1 |
| stock_full | 19 |
| stock_en_transito | 0 |
| stock_total | 20 |
| vel_ponderada | 5 u/sem |
| vel_full / vel_flex | 5 / 0 |
| pct_full / pct_flex | 0.80 / 0.20 |
| target_dias_full | 28 (ABC=B) |
| safety_stock_simple / completo | 3.68 / 4.08 |
| rop_calculado | 7.65 |
| pedir_proveedor | **0** (debería ser 5) |
| mandar_full | **0** |
| necesita_pedir | **false** |
| accion | PLANIFICAR |
| alertas | `[]` |
| ml_items_map.stock_flex_cache | **0** |
| ml_items_map.ultimo_stock_enviado | 6 (del 14-abr) |

**Lo que debería pasar:** pedir ~5 uds a Idetex + mover 1-3 de Full a bodega para habilitar Flex (requiere bodega ≥ 3 con buffer=2).

**Lo que pasa:** nada. El motor dice PLANIFICAR sin alertas, no pide, no redistribuye, ML publica 0 en Flex hace 7 días.

---

## Problema 1 — Stock fantasma Flex (regla de buffer invisible)

**Síntoma:** 1 uds en bodega que el motor trata como disponible, pero ML Flex publica 0.

**Código que genera el fantasma:**
`src/app/api/ml/stock-sync/route.ts:129,137`

```ts
const buffer = sharedOrigins.has(skuOrigen) ? 4 : 2;
const available = Math.max(0, Math.floor((disponibleOrigen - buffer) / unidadesPack));
```

Regla: `publicar_flex = floor((stock_bodega − buffer) / inner_pack)` con buffer=2 (o 4 si SKU compartido). Para este SKU: `floor((1−2)/1) = −1 → max(0, −1) = 0`.

**Dónde se pierde:** el motor (`intelligence.ts`) lee `stock_bodega=1` directo de `stock` table, sin restar el buffer. Lo incluye en `stock_total=20` que alimenta todas las decisiones (pedir_proveedor, cob_total, dio, mandar_full, necesita_pedir).

**No existe** el concepto `stock_bodega_efectivo = max(0, stock_bodega − buffer_flex)` en el motor.

**Impacto:** cada SKU con `stock_bodega ≤ 2` (no compartido) o `≤ 4` (compartido) tiene stock fantasma. Query para cuantificar:

```sql
SELECT COUNT(*) AS skus_con_fantasma,
       SUM(stock_bodega) AS uds_fantasma
FROM sku_intelligence
WHERE stock_bodega > 0 AND stock_bodega <= 2
  AND vel_ponderada > 0;
```

---

## Problema 2 — vel_flex confunde "sin demanda" con "sin publicación"

**Síntoma:** vel_flex=0 se interpreta como señal comercial ("este SKU no tiene demanda Flex") cuando en realidad es señal técnica ("ML no publicó Flex por el buffer").

**Historia del SKU (`sku_intelligence_history`):**

```
Fecha      vel_full  vel_flex
2026-04-16   5.24      0.37
2026-04-17   2.07      0.14
2026-04-18   3.33      0.00
2026-04-19   3.33      0.00
2026-04-20   4.50      0.00
2026-04-21   5.00      0.00
```

`vel_flex` decae no porque la demanda haya desaparecido — la última venta Flex fue 2026-03-19 y al salir de la ventana 30d el motor "olvida". Durante esos 30+ días el SKU tuvo `stock_bodega=1` permanente → ML Flex mostró 0 → imposible que hubiera ventas Flex.

**Selection bias:** el motor mide el canal que él mismo está bloqueando y usa ese resultado para decidir si seguir permitiéndolo.

**Fórmula afectada:** `vel_flex` se calcula en el loop por SKU sobre ventas de los últimos 30d. No hay ajuste por "días con Flex publicado".

---

## Problema 3 — pct_flex decae sin mecanismo de recuperación

**Síntoma:** `pct_flex` histórico refleja 3 ventas viejas de marzo (cuando había 20-40 uds). Con cada recálculo donde vel_flex=0, el peso baja. Eventualmente → 0%, y el SKU se declara "Full-puro".

**Código (`intelligence.ts` en el loop por SKU):**

```ts
const pctFull = velTotal > 0 ? velFull / velTotal : 1;
const pctFlex = velTotal > 0 ? velFlex / velTotal : 0;
```

No hay memoria de largo plazo ni "modo comercial objetivo". El ratio sigue la señal rota.

**Consecuencia:** `targetFlexUds = vel × pct_flex × target_dias / 7`. Si pct_flex→0, el motor deja de reservar stock para Flex.

---

## Problema 4 — mandar_full refuerza el círculo vicioso

**Síntoma:** cuando llega reposición a bodega, el motor decide cuánto enviar a Full basándose en pct_flex degradado.

**Código (`intelligence.ts:1665-1667`):**

```ts
const targetFlexUds = velParaPedir * r.pct_flex * r.target_dias_full / 7;
const disponibleParaFullR = Math.max(0, r.stock_bodega - Math.ceil(targetFlexUds));
r.mandar_full = Math.max(0, Math.min(Math.ceil(targetFullUds - r.stock_full - r.stock_en_transito), disponibleParaFullR));
```

Con pct_flex bajo → targetFlexUds bajo → disponibleParaFull alto → todo se va a Full → Flex sigue muerto.

**Cadena completa:** ML no publica (P1) → vel_flex=0 (P2) → pct_flex decae (P3) → mandar_full reserva menos para bodega (P4) → futuras recepciones van 100% a Full → Flex queda permanentemente muerto.

---

## Problema 5 — en_quiebre_bodega no detecta el quiebre real

**Síntoma:** `stock_snapshots.en_quiebre_bodega` usa regla que asume "stock_bodega=0 → quiebre". Con stock_bodega=1 y Flex publicado=0, el sistema registra "sin quiebre" todos los días, pero el canal Flex está muerto efectivamente.

**Código (`intelligence.ts:2038-2039` en `generarStockSnapshots`):**

```ts
en_quiebre_full: r.stock_full === 0 && r.vel_full > 0,
en_quiebre_bodega: r.stock_bodega === 0 && r.vel_flex > 0,
```

**Evidencia:** el SKU tiene 6/6 filas de snapshot con `en_quiebre_bodega=false`, pese a que ML Flex lleva 7+ días publicando 0.

**Fix conceptual:** debería ser `stock_bodega <= buffer_flex && vel_flex > 0` o leer `ml_items_map.stock_flex_cache` directo.

Además: la segunda condición (`vel_flex > 0`) también es parte del problema — una vez que vel_flex cae a 0 por los problemas 2 y 3, la condición nunca dispara aunque el stock bajara a 0. Doble negación silenciadora.

---

## Problema 6 — No hay snapshot histórico de stock_flex_publicado

**Síntoma:** Imposible reconstruir retroactivamente "¿cuántos días este SKU tuvo Flex publicado>0?". Sin eso, no se puede hacer análisis honesto del canal.

**Lo que existe:**
- `ml_items_map.stock_flex_cache`: último valor enviado a ML (single row por SKU, se sobrescribe)
- `ml_items_map.ultimo_stock_enviado`: mismo concepto
- `stock_snapshots`: `stock_full`, `stock_bodega`, `stock_total` diario — NO incluye stock publicado
- `sku_intelligence_history`: `vel_full`, `vel_flex`, `stock_full`, `stock_bodega` — NO incluye stock publicado
- `audit_log`: solo acciones individuales (stock_sync entry/result), no se agrega en serie temporal

**Lo que no existe:**
- Columna `stock_flex_publicado` en `stock_snapshots` o `sku_intelligence_history`
- Tabla dedicada `stock_ml_cache_history` con snapshot diario de `ml_items_map.stock_flex_cache`

**Consecuencia:** no puedo responder "¿durante las últimas 4 semanas este SKU cuántos días tuvo Flex muerto?" sin hacerlo a mano.

---

## Problema 7 — Bug orden invertido SS_completo en Recalc pedir_proveedor

**Ya documentado en detalle en respuesta previa.** Resumen:

- `intelligence.ts:1457` inicializa `row.safety_stock_completo = 0`
- `intelligence.ts:1676` (Recalc) lee `r.safety_stock_completo` → vale 0 → fórmula `pedir = ceil(demanda_ciclo + 0 − stock_total)` entrega 0 cuando `stock_total == demanda_ciclo`
- `intelligence.ts:1800` recién asigna `r.safety_stock_completo = 4.08` — pero `pedir_proveedor` ya está en 0

**Impacto DB:** 43 SKUs con pedidos suprimidos, 397 uds no pedidas. 16 ABC=A, 15 ESTRELLA.

Para este SKU puntualmente: pedir_teorico=5, pedir_real=0. Delta=5 uds no pedidas solo por este bug.

---

## Problema 8 — necesita_pedir no refleja la fórmula Fase B

**Síntoma:** `necesita_pedir=false` para un SKU que debería pedir según la fórmula de Fase B. La alerta que debería disparar nunca llega.

**Código (`intelligence.ts:1810-1811`):**

```ts
const stockTotal = r.stock_full + r.stock_bodega + r.stock_en_transito;
r.necesita_pedir = stockTotal <= r.rop_calculado && D > 0;
```

- `rop_calculado = D×LT + SS_completo` = 5×(5/7) + 4.08 = 3.57 + 4.08 = **7.65 uds**
- stockTotal = 20
- 20 ≤ 7.65 → **false**

El ROP clásico (basado solo en LT, no en target_dias_full) protege para el próximo ciclo de compra. La fórmula Fase B (`cantidad_objetivo = demanda_ciclo + SS`) apunta al stock objetivo para el ciclo completo. Son conceptos distintos.

El motor mezcla: calcula pedir con Fase B (`cantidad_objetivo − stock_total`) pero dispara alerta con ROP clásico. Resultado: ningún SKU con cobertura > LT × velocidad dispara alerta, aunque esté por debajo del cantidad_objetivo.

**Consecuencia:** ningún aviso en `alertas[]` para los 43 SKUs del Problema 7. Invisibles para el operador.

---

## Efectos cruzados (cómo se refuerzan)

### Ciclo A: pérdida de Flex

```
stock_bodega ≤ 2 (P1 buffer)
    ↓
ML publica 0 en Flex
    ↓
vel_flex = 0 (P2 selection bias)
    ↓
pct_flex decae (P3 sin memoria)
    ↓
targetFlexUds → 0 (P4 mandar_full)
    ↓
nueva recepción se va 100% a Full
    ↓
stock_bodega vuelve a ≤ 2 o cae a 0
    ↓
(vuelve al inicio, loop cerrado)
```

Este ciclo mata el canal Flex silenciosamente. No hay alerta. `en_quiebre_bodega=false` (P5). Historial no tiene señal (P6).

### Ciclo B: underordering

```
Recalc pedir_proveedor con SS=0 (P7)
    ↓
pedir_proveedor = 0 aunque stock_total < objetivo
    ↓
necesita_pedir usa ROP clásico, no cantidad_objetivo (P8)
    ↓
sin alerta
    ↓
Idetex no entra en lista de OCs
    ↓
stock se sigue consumiendo hasta stockout real
    ↓
SKU entra en accion=AGOTADO_PEDIR o URGENTE
    ↓
ahí recién se nota, ya tarde
```

### Ciclo C: los dos ciclos se alimentan entre sí

Un SKU en Ciclo A (Flex muerto, solo Full rota) cuando agote Full entra en Ciclo B (pedir=0 por bug). Cuando finalmente se note, tendrá bodega=0 y Full=0 simultáneamente, y el ramp-up post-quiebre arrancará recuperación lenta — pero arrancará con pct_flex histórico ya degradado a ~0%, así que recomprará 100% para Full y el canal Flex nunca se reabre. **Daño permanente al SKU.**

---

## Lo que el sistema no registra hoy

Para auditar honestamente los problemas 1-6 necesitarías estos datos que no existen:

| Dato faltante | Propósito | Dónde debería vivir |
|---|---|---|
| `stock_flex_publicado` diario por SKU | Saber cuántos días Flex estuvo vivo | columna nueva en `stock_snapshots` o `sku_intelligence_history` |
| `vel_flex_por_dia_expuesto` | Separar "no hay demanda" de "no hay oferta" | cálculo derivado del dato anterior |
| `dias_flex_muerto_30d` | Señal para alerta operativa | `sku_intelligence` como columna |
| `flex_objetivo` (flag policy) | Decisión explícita del operador si un SKU debe sostener Flex | `productos` o config |
| snapshot `ml_items_map.stock_flex_cache` histórico | Auditoría retrospectiva | tabla `ml_stock_cache_history` |
| `buffer_flex_aplicado` por SKU | Saber cuánto stock se reserva por regla | derivable pero no persistido |
| pedir_proveedor_teorico vs pedir_real | Detectar supresiones por bugs o dedup | columna nueva en `sku_intelligence` |

---

## Evidencia DB consolidada

### Para este SKU

```sql
-- 1. Estado actual motor
SELECT sku_origen, stock_bodega, stock_full, stock_total,
       vel_ponderada, vel_full, vel_flex, pct_full, pct_flex,
       safety_stock_completo, rop_calculado,
       pedir_proveedor, necesita_pedir, accion, alertas
FROM sku_intelligence WHERE sku_origen='TXV24QLBRBA15';

-- 2. Estado actual ML
SELECT sku_venta, stock_flex_cache, stock_full_cache,
       ultimo_stock_enviado, ultimo_sync, available_quantity
FROM ml_items_map WHERE sku_origen='TXV24QLBRBA15';

-- 3. Historial 30d
SELECT fecha, vel_full, vel_flex, stock_full, stock_bodega, accion
FROM sku_intelligence_history
WHERE sku_origen='TXV24QLBRBA15'
ORDER BY fecha DESC LIMIT 30;

-- 4. Movimientos 60d
SELECT created_at::date AS fecha, tipo, motivo, cantidad, qty_after
FROM movimientos
WHERE sku='TXV24QLBRBA15'
ORDER BY created_at DESC;

-- 5. Audit log stock_sync para este SKU
SELECT created_at, accion, params->>'availableQty' AS available, 
       params->>'reason' AS reason
FROM audit_log
WHERE accion LIKE 'stock_sync:%'
  AND params->>'sku' = 'TXV24QLBRBA15'
ORDER BY created_at DESC LIMIT 20;
```

### Queries de impacto agregado

```sql
-- SKUs con stock fantasma (P1)
SELECT COUNT(*) AS con_fantasma, SUM(stock_bodega) AS uds_fantasma
FROM sku_intelligence
WHERE stock_bodega BETWEEN 1 AND 2 AND vel_ponderada > 0;

-- SKUs con pedidos suprimidos por bug SS=0 (P7)
SELECT COUNT(*), SUM(CEIL((vel_ponderada*target_dias_full/7.0) + safety_stock_completo - stock_total)) AS uds_suprimidas,
       SUM(CASE WHEN abc='A' THEN 1 ELSE 0 END) AS abc_A
FROM sku_intelligence
WHERE pedir_proveedor = 0
  AND safety_stock_completo > 0
  AND stock_total < (vel_ponderada*target_dias_full/7.0) + safety_stock_completo
  AND accion NOT IN ('INACTIVO','DEAD_STOCK','EXCESO','NUEVO')
  AND vel_ponderada > 0;

-- SKUs donde Flex "murió" silencioso (vel_flex cayó a 0 con stock_bodega bajo)
SELECT COUNT(*)
FROM sku_intelligence
WHERE vel_flex = 0 AND pct_flex > 0 AND stock_bodega BETWEEN 0 AND 2
  AND vel_ponderada > 0;

-- SKUs con necesita_pedir=false pero que deberían pedir (P8)
SELECT COUNT(*)
FROM sku_intelligence
WHERE necesita_pedir = false
  AND stock_total < (vel_ponderada*target_dias_full/7.0) + safety_stock_completo
  AND vel_ponderada > 0
  AND accion NOT IN ('INACTIVO','DEAD_STOCK','EXCESO');
```

---

## Resumen: 8 problemas encadenados

| # | Problema | Código | Efecto | Severidad |
|---|---|---|---|---|
| 1 | Stock fantasma Flex (buffer=2 no visible en motor) | `stock-sync/route.ts:129,137` vs `intelligence.ts` no lo resta | Motor trata stock no-publicable como disponible | Alta |
| 2 | vel_flex confunde demanda vs oferta | Loop intelligence.ts, fórmula vel_flex | Selection bias, señal rota | Alta |
| 3 | pct_flex decae sin recovery | `intelligence.ts` pct = velFlex/velTotal | Deriva histórica, declara "Full-puro" falsamente | Media |
| 4 | mandar_full refuerza vicioso | `intelligence.ts:1665-1667` | Nueva reposición se va toda a Full | Alta |
| 5 | en_quiebre_bodega mal definido | `intelligence.ts:2038-2039` | No registra quiebre efectivo del canal | Media |
| 6 | Sin snapshot histórico de stock publicado | Data modeling | Imposible auditoría retrospectiva | Alta (bloquea fix) |
| 7 | Bug SS=0 en Recalc pedir_proveedor | `intelligence.ts:1676` vs `1800` orden invertido | 43 SKUs / 397 uds suprimidas | Crítica |
| 8 | necesita_pedir usa ROP viejo, no cantidad_objetivo Fase B | `intelligence.ts:1811` | Alertas no disparan para los 43 del P7 | Alta |

**Severidad combinada:** crítica. El motor toma decisiones sobre un estado distorsionado sistemáticamente. Los SKUs más rentables (ABC=A, ESTRELLAs) son los más afectados por P7+P8. El canal Flex muere silenciosamente en SKUs con rotación mixta por P1-P4.

**Complementa los hallazgos previos:**
- `docs/banva-bodega-auditoria-2026-04-18.md`
- `docs/banva-bodega-hallazgos-criticos-2026-04-18.md` (LT Idetex=5 falso + bug 999)

Estos 8 problemas no estaban enumerados en la auditoría anterior. La auditoría cubrió requisitos de manuales vs código; esto es un análisis de **coherencia interna del motor** que apareció recién al trazar un SKU puntual.

---

## Plan de fix sugerido (sin implementar aún)

**Sprint orden — del más barato/alto ROI al más estructural:**

1. **Fix P7 (1 día):** mover bloque PASO 12 SS+ROP antes del Recalc pedir_proveedor. Agregar tests. Rehabilita 43 SKUs de inmediato.
2. **Fix P8 (misma PR que P7):** cambiar `necesita_pedir` para usar `cantidad_objetivo` en vez de `rop_calculado`. O agregar segunda flag `necesita_pedir_ciclo`. Dispara alertas.
3. **Fix P1+P4 (2-3 días):** agregar `stock_bodega_efectivo = max(0, stock_bodega − buffer_flex)` al motor. Usar el efectivo en `stock_total`, `cob_total`, cálculos de pedir, cálculo de mandar_full. Romper el ciclo vicioso de fantasma.
4. **Fix P5 (1 día):** redefinir `en_quiebre_bodega = (stock_bodega <= buffer_flex) && (vel_flex > 0 OR pct_flex_historico > 5%)`. Detectar quiebre efectivo.
5. **Fix P6 (1 semana):** agregar columna `stock_flex_publicado` a `stock_snapshots` y `sku_intelligence_history`. Poblar desde `ml_items_map.stock_flex_cache` en cada recálculo. Backfill retroactivo solo posible desde hoy hacia adelante.
6. **Fix P2+P3 (después de P6):** con el dato histórico, calcular `vel_flex_ajustada = ventas_flex_30d / dias_flex_publicado_30d`. Usar esa como señal real. Agregar flag `flex_objetivo` en productos para override manual.

Dependencias: P6 bloquea análisis retrospectivo de P2/P3. P1/P4/P5 pueden avanzar en paralelo a P6.

---

## Tests de regresión mínimos al fixear

Ninguno de los 8 está cubierto hoy. Al hacer PRs, agregar en `src/lib/__tests__/intelligence-flex.test.ts`:

1. **SKU con stock_bodega=1, buffer=2:** stock_efectivo debe ser 0, cob_total debe excluirlo, pedir debe considerarlo faltante.
2. **SKU con stock_bodega=3, buffer=2:** stock_efectivo debe ser 1, ML publica 1 en Flex.
3. **SKU con stock_total==demanda_ciclo y SS>0:** pedir debe ser ceil(SS), no 0.
4. **SKU con stock_total < cantidad_objetivo pero > ROP:** necesita_pedir debe ser true (después del fix P8).
5. **SKU con vel_flex=0 por 30 días y stock_bodega=1:** debe entrar en en_quiebre_bodega efectivo.
6. **SKU con vel_flex cayendo:** pct_flex no debe caer abajo de un piso si flex_objetivo=true (post-fix P6).
7. **SKU con ramp-up activo:** pedir_proveedor_sin_rampup debe reflejar el Fase B correcto con SS real.

---

## Qué buscar al auditar

Al revisar otros SKUs o procesos:

1. Cualquier decisión que use `stock_bodega` directo (sin restar buffer) → candidato a Problema 1/4.
2. Cualquier métrica basada en `vel_flex` sin normalizar por exposición → candidato a Problema 2.
3. Cualquier flag tipo `en_quiebre_*` que compare stock con 0 en lugar de con umbral → candidato a Problema 5.
4. Cualquier write de `r.X` que dependa de `r.Y` donde `r.Y` se asigna después en el código → candidato a Problema 7.
5. Cualquier fórmula que mezcle ROP clásico con cantidad_objetivo Fase B → candidato a Problema 8.

Grep útil:

```bash
grep -n "stock_bodega" src/lib/intelligence.ts | grep -v "buffer"
grep -n "vel_flex" src/lib/intelligence.ts | grep -v "expuesto"
grep -n "r\\.safety_stock_completo" src/lib/intelligence.ts  # verificar que todas las lecturas son POSTERIORES a las escrituras
grep -n "r\\.stock_total\\|stockTotal" src/lib/intelligence.ts  # ver dónde se computa y si usa efectivo
```
