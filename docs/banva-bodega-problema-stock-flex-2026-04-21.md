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

## Problema 3 — pct_flex hardcoded en 0.20 o 0.30, insensible a selection bias

**Síntoma:** `pct_flex` no decae — está pegado en 0.20 por default hardcoded. Solo sube a 0.30 cuando `margen_full_30d > 0 AND margen_flex_30d > 0 AND margen_flex/margen_full > 1.1`. Si `margen_flex=0` (típico cuando Flex está muerto por buffer), cae al else → 0.20 fijo.

**Código (`intelligence.ts:1085-1093`):**

```ts
if (margen_full_30d > 0 && margen_flex_30d > 0 &&
    margen_flex_30d / margen_full_30d > 1.1) {
  pctFull = 0.70; pctFlex = 0.30;
} else {
  pctFull = 0.80; pctFlex = 0.20;
}
```

**Evidencia DB 2026-04-21 (Q5):** 245 SKUs con `pct_flex=0.20`, 52 con `pct_flex=0.30`. **Solo 2 valores distintos en los 297 SKUs con velocidad > 0.** Ninguna distribución continua → confirma que el histórico de línea 1014 (`pctFlex = 1 - pctFull`) queda sepultado por paso 7b.

**Selection bias compuesto:** para saltar a 0.30, el motor necesita `margen_flex > 0`. Pero `margen_flex = 0` justamente porque ML Flex publicó 0 por buffer (P1). La señal que elegiría "Flex rentable" está suprimida por el mismo ciclo vicioso que P2.

**Consecuencia:** `targetFlexUds = vel × 0.20 × target_dias_full / 7`. Para SKUs pequeños (vel bajo, target bajo), esto genera reservas teóricas de 1-4 uds que en la práctica son stock zombi (ver P9).

**No es un fix de "agregar memoria de largo plazo".** Es una decisión de política: o se sube el default, o se introduce flag `flex_objetivo` por SKU y se mantiene el default como fallback para los que no tienen política explícita.

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

## Problema 9 — Stock zombi por reserva teórica Flex

**Síntoma:** stock en bodega queda sin canalizarse — no va a Full (el motor lo cree "reservado para Flex") y no vende Flex (buffer ML lo suprime). Stock paria invisible para el operador.

**Cómo se genera:**

Regla 2 (mandar_full, `intelligence.ts:1661-1667`):

```ts
const targetFlexUds = velParaPedir * r.pct_flex * r.target_dias_full / 7;
const disponibleParaFullR = Math.max(0, r.stock_bodega - Math.ceil(targetFlexUds));
r.mandar_full = Math.max(0, Math.min(
  Math.ceil(targetFullUds - r.stock_full - r.stock_en_transito),
  disponibleParaFullR
));
```

Regla 3 (publicación ML, `stock-sync/route.ts:129,137`):

```ts
const buffer = sharedOrigins.has(skuOrigen) ? 4 : 2;
const available = Math.max(0, Math.floor((disponibleOrigen - buffer) / unidadesPack));
```

**Ejemplo TXV24QLBRBA15 (stock_bodega=1, stock_full=19, vel=5, pct_flex=0.20, target=28):**
- Regla 2: `targetFlexUds = 5 × 0.20 × 28/7 = 4` → cree que reserva 4 uds
- Regla 2: `disponibleParaFull = max(0, 1−4) = 0` → no manda nada a Full
- Regla 2: Full ya sobrado (19 > 16 target) → `mandar_full = 0`
- Regla 3: `available = max(0, floor((1−2)/1)) = 0` → publica 0 en Flex
- **Resultado: 1 uds en bodega que no va a ningún canal. Paria.**

**Variante inversa: over-publishing en ABC=A**

El mismo desalineamiento produce el problema simétrico cuando `stock_bodega` es alto y la reserva matemática es grande. Caso ABC=A-ESTRELLA (vel=17, target=42, pct_flex=0.20, stock_bodega=25):

- Regla 2 nueva: `targetFlexUds = 17 × 0.20 × 42/7 = 20.4` → reserva 21 uds
- Regla 2 nueva: `disponibleParaFull = 25 − 21 = 4` → manda solo 4 a Full
- Regla 3: `available = max(0, floor((25−2)/1)) = 23` → ML publica 23 en Flex
- **Gap invertido: ML puede vender 23 uds por Flex, pero el motor cree que 21 están reservadas para el próximo ciclo Full. Si Flex efectivamente vende 23, el motor no detecta que ese canal consumió stock que contabilizaba para Full → subestima reposición a Full → Full entra en quiebre antes de lo previsto.**

Misma raíz causal (3 reglas no se hablan), efecto simétrico opuesto. P9 en substancia no es solo "paria": es **desalineamiento bidireccional** entre reserva matemática y publicación efectiva.

**Impacto agregado (Q3, 2026-04-21):**

| Caso | Total | ABC A/B | ESTRELLA |
|---|---|---|---|
| Paria (stock_bodega bajo, reserva supera bodega) | 10 SKUs / 15 uds | 8 | 3 |

**Impacto estructural (Q2b, ventana 6d de historia disponible):** 25 SKUs con "daño real" definido como `≥3 ventas Flex en 90d AND ≥4 de 6 días recientes con stock_bodega ≤ 2`. De esos, 18 son ABC A/B y 13 son ESTRELLA. Nota: `stock_snapshots` solo tiene 6 días de historia (P6 bloquea análisis más profundo).

**Fix conceptual:** colapsar Regla 2 y Regla 3 en una función única que devuelva la partición real del bodega, no una reserva matemática:

```ts
function particionBodega(stockBodega: number, buffer: number, flexObjetivo: boolean) {
  const paraFlex = flexObjetivo ? Math.max(0, stockBodega - buffer) : 0;
  const paraFull = stockBodega - paraFlex;
  return { paraFlex, paraFull };
}
```

Regla 2 usaría `paraFull` como base para `mandar_full`. Regla 3 publicaría `paraFlex / inner_pack`. Misma fuente de verdad para ambas decisiones.

**Viola Regla 5 de `.claude/rules/inventory-policy.md`** ("Fuentes duplicadas del mismo dato → fuente única canónica + lecturas derivadas"). El stock_bodega efectivo vivo en 3 lugares distintos (motor, mandar_full, publicación ML) sin fuente canónica.

---

## Las 3 reglas Full/Flex no se hablan entre sí

Hallazgo estructural que **precede y explica P1-P4**: la lógica Full/Flex no está en un solo lugar del motor. Son 3 reglas paralelas con orígenes independientes:

| Regla | Qué decide | Archivo:línea | Base de cálculo |
|---|---|---|---|
| 1 — pct | Qué % de la velocidad asignar a cada canal | `intelligence.ts:1085-1093` | Margen (hardcoded 80/20 o 70/30) |
| 2 — split mandar_full | Cuánto stock bodega reservar para Flex | `intelligence.ts:1661-1667` | `vel × pct × target / 7` (reserva matemática) |
| 3 — publicación ML | Cuánto publicar en Flex | `stock-sync/route.ts:129` | `stock_bodega − buffer` (resta fija) |

**Ninguna de las 3 sabe de las otras.** Convergen por casualidad cuando los números son grandes, divergen sistemáticamente cuando son chicos (que es la mayoría del catálogo C de BANVA).

**Ejemplo de divergencia con `stock_bodega=5`, `pct_flex=0.20`, `target=28`, `vel=5`:**
- Regla 2 cree que hay 4 uds "para Flex" disponibles
- Regla 3 publica `5 − 2 = 3` uds en ML Flex
- Operativamente vendibles: 3, no 4
- Gap de 1 uds que el motor nunca detecta

**Con `stock_bodega=1` (caso TXV24QLBRBA15):**
- Regla 2 cree que tiene 1 uds "para Flex" (faltan 3 según su target)
- Regla 3 publica 0 (buffer suprime)
- Regla 1 nunca detecta que Flex no está vendiendo porque `margen_flex=0` mantiene el default 0.20 activo
- Las 3 reglas "funcionan" individualmente pero el canal está muerto

**P1, P2, P3, P4 son síntomas de este problema estructural.** Un fix aislado a cualquiera de ellos sin unificar las 3 reglas deja vivos los otros síntomas.

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

## Resumen: 9 problemas encadenados + 1 hallazgo estructural superior

**Hallazgo estructural:** las 3 reglas Full/Flex no se hablan entre sí (pct hardcoded en `intelligence.ts:1085-1093`, split mandar_full en `intelligence.ts:1661-1667`, publicación ML en `stock-sync/route.ts:129`). P1-P4 y P9 son síntomas de esta desalineación.

| # | Problema | Código | Efecto | Severidad |
|---|---|---|---|---|
| 1 | Stock fantasma Flex (buffer=2 no visible en motor) | `stock-sync/route.ts:129,137` vs `intelligence.ts` no lo resta | Motor trata stock no-publicable como disponible | Alta |
| 2 | vel_flex confunde demanda vs oferta | Loop intelligence.ts, fórmula vel_flex | Selection bias, señal rota | Alta |
| 3 | pct_flex hardcoded en 0.20 o 0.30 (Q5: 245+52 SKUs) | `intelligence.ts:1085-1093` | Sin política per-SKU, selection bias pega default | Media |
| 4 | mandar_full refuerza vicioso | `intelligence.ts:1665-1667` | Nueva reposición se va toda a Full | Alta |
| 5 | en_quiebre_bodega mal definido | `intelligence.ts:2038-2039` | No registra quiebre efectivo del canal | Media |
| 6 | Sin snapshot histórico de stock publicado (hoy solo 6d) | Data modeling | Imposible auditoría retrospectiva | Alta (bloquea fix) |
| 7 | Bug SS=0 en Recalc pedir_proveedor | `intelligence.ts:1676` vs `1800` orden invertido | 43 SKUs / 397 uds suprimidas; SKU testigo LITAF400G4PBL (ABC=A, ESTRELLA) con 77 uds suprimidas | Crítica |
| 8 | necesita_pedir usa ROP viejo, no cantidad_objetivo Fase B | `intelligence.ts:1811` | Alertas no disparan para los 43 del P7 | Alta |
| 9 | Stock zombi por reserva teórica Flex (bidireccional) | `intelligence.ts:1665-1667` + `stock-sync/route.ts:129` | 10 SKUs paria / 15 uds hoy; también over-publishing en ABC=A | Alta |

**Severidad combinada:** crítica. El motor toma decisiones sobre un estado distorsionado sistemáticamente. Los SKUs más rentables (ABC=A, ESTRELLAs) son los más afectados por P7+P8+P9 inverso. El canal Flex muere silenciosamente en SKUs con rotación mixta por P1-P4+P9 directo.

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

Ninguno de los 9 está cubierto hoy. Al hacer PRs, agregar en `src/lib/__tests__/intelligence-flex.test.ts`:

1. **SKU con stock_bodega=1, buffer=2:** stock_efectivo debe ser 0, cob_total debe excluirlo, pedir debe considerarlo faltante.
2. **SKU con stock_bodega=3, buffer=2:** stock_efectivo debe ser 1, ML publica 1 en Flex.
3. **SKU con stock_total==demanda_ciclo y SS>0:** pedir debe ser ceil(SS), no 0.
4. **SKU con stock_total < cantidad_objetivo pero > ROP:** necesita_pedir debe ser true (después del fix P8).
5. **SKU con vel_flex=0 por 30 días y stock_bodega=1:** debe entrar en en_quiebre_bodega efectivo.
6. **SKU con vel_flex cayendo:** pct_flex no debe caer abajo de un piso si flex_objetivo=true (post-fix P6).
7. **SKU con ramp-up activo:** pedir_proveedor_sin_rampup debe reflejar el Fase B correcto con SS real.
8. **SKU ABC=A con stock_bodega=25, vel=17, pct_flex=0.20, target=42 (P9 inverso):** la función `particionBodega()` debe devolver `paraFlex=23` (stock_bodega−buffer) y `paraFull=2`. Sin función, asegurar que `mandar_full` refleja la partición efectiva, no la reserva matemática 20.4.
9. **SKU no ABC=A con stock_bodega=1 (P9 paria):** `mandar_full=0` Y `publicar_flex=0` Y `pedir_proveedor>0`. Hoy las 3 condiciones son verdaderas pero ninguna alerta se dispara.

---

## Qué buscar al auditar

Al revisar otros SKUs o procesos:

1. Cualquier decisión que use `stock_bodega` directo (sin restar buffer) → candidato a Problema 1/4.
2. Cualquier métrica basada en `vel_flex` sin normalizar por exposición → candidato a Problema 2.
3. Cualquier flag tipo `en_quiebre_*` que compare stock con 0 en lugar de con umbral → candidato a Problema 5.
4. Cualquier write de `r.X` que dependa de `r.Y` donde `r.Y` se asigna después en el código → candidato a Problema 7.
5. Cualquier fórmula que mezcle ROP clásico con cantidad_objetivo Fase B → candidato a Problema 8.
6. Cualquier decisión que calcule "reserva teórica" sin consultar la publicación efectiva (`ml_items_map.stock_flex_cache` o derivado de buffer) → candidato a Problema 9.

Grep útil:

```bash
grep -n "stock_bodega" src/lib/intelligence.ts | grep -v "buffer"
grep -n "vel_flex" src/lib/intelligence.ts | grep -v "expuesto"
grep -n "r\\.safety_stock_completo" src/lib/intelligence.ts  # verificar que todas las lecturas son POSTERIORES a las escrituras
grep -n "r\\.stock_total\\|stockTotal" src/lib/intelligence.ts  # ver dónde se computa y si usa efectivo
```

---

# Anexo A — Diseño de fix estructural (2026-04-21)

Tres bloques cerrados: contrato de función canon (B4.1), flag `flex_objetivo` (B4.2-B4.3), orden de PRs (B4.4). Con ajustes técnicos 1-3 y decisiones comerciales 1-3 aceptadas.

## A1. Función canon `calcularEstadoFlexFull`

**Archivo nuevo:** `src/lib/flex-full.ts`. Función pura, sin I/O, testeable en aislamiento.

```ts
export interface FlexFullContext {
  // identidad
  sku_origen: string;
  // stock físico
  stock_bodega: number;
  stock_full: number;
  stock_en_transito: number;
  // demanda/política
  vel_ponderada: number;
  pct_full: number;               // necesario para targetFullUds
  target_dias_full: number;       // por ABC (42/28/14)
  flex_objetivo: boolean;
  // ML constraints
  buffer_ml: number;              // 2 default, 4 si sku_origen compartido
  inner_pack: number;             // 1 default
  // meta
  abc: "A" | "B" | "C";
}

export interface FlexFullState {
  // Partición REAL del bodega
  para_flex: number;              // stock_bodega − buffer si flex_objetivo, 0 si no
  para_full: number;              // stock_bodega − para_flex
  // Decisiones operativas
  publicar_flex: number;          // floor(para_flex / inner_pack)
  mandar_full: number;            // max(0, min(targetFullUds − stFull − enTransito, para_full))
  // Señales diagnósticas
  flex_activo: boolean;           // publicar_flex > 0
  flex_bloqueado_por_stock: boolean; // flex_objetivo=true && 0 < stock_bodega < buffer_ml
  gap_fantasma: number;           // para_flex − publicar_flex × inner_pack (remanente)
  reserva_ignorada: boolean;      // dummy TRUE cuando se compare contra fórmula vieja (diag)
}

export function calcularEstadoFlexFull(ctx: FlexFullContext): FlexFullState {
  const para_flex = ctx.flex_objetivo
    ? Math.max(0, ctx.stock_bodega - ctx.buffer_ml)
    : 0;
  const para_full = ctx.stock_bodega - para_flex;
  const publicar_flex = Math.floor(para_flex / ctx.inner_pack);
  const gap_fantasma = para_flex - (publicar_flex * ctx.inner_pack);
  const flex_bloqueado_por_stock =
    ctx.flex_objetivo && ctx.stock_bodega > 0 && ctx.stock_bodega < ctx.buffer_ml;

  const targetFullUds = ctx.vel_ponderada * ctx.pct_full * ctx.target_dias_full / 7;
  const deficit_full = targetFullUds - ctx.stock_full - ctx.stock_en_transito;
  const mandar_full = Math.max(0, Math.min(Math.ceil(deficit_full), para_full));

  return {
    para_flex, para_full, publicar_flex, mandar_full,
    flex_activo: publicar_flex > 0,
    flex_bloqueado_por_stock,
    gap_fantasma,
    reserva_ignorada: false,
  };
}
```

**Casos borde cubiertos:**

| stock_bodega | buffer | flex_objetivo | para_flex | para_full | publicar_flex | flex_bloqueado_por_stock |
|---|---|---|---|---|---|---|
| 0 | 2 | true | 0 | 0 | 0 | false (stock_bodega=0) |
| 1 | 2 | true | 0 | 1 | 0 | **true** (<buffer) |
| 2 | 2 | true | 0 | 2 | 0 | false (=buffer, no <) |
| 3 | 2 | true | 1 | 2 | 1 | false |
| 25 | 2 | true | 23 | 2 | 23 | false |
| 25 | 2 | false | 0 | 25 | 0 | false |
| 5 | 2 | true | 3 | 2 | 1 | false (inner_pack=3: 3/3=1, gap=0) |
| 5 | 2 | true | 3 | 2 | 1 | false (inner_pack=2: 3/2=1, gap=1) |

**Call sites a migrar (3):**

1. `src/lib/intelligence.ts:1307-1314` (mandar_full viejo)
2. `src/lib/intelligence.ts:1661-1667` (mandar_full Fase B)
3. `src/app/api/ml/stock-sync/route.ts:125-145` (publicación ML)
4. `src/lib/reposicion.ts:156-157` (tercer site detectado en grep, revisar si aplica)

## A2. [ROLLBACK 2026-04-22] Alerta `flex_bloqueado_por_stock` eliminada

Propuesta original era una alerta 🟡 que dispara cuando `flex_objetivo=true` y `0 < stock_bodega < buffer_ml`. Se implementó en PR3 y se eliminó en rollback (v59) junto con el flag `flex_objetivo`. La política actual es "todo SKU activo vive en Flex si stock_bodega > buffer" — sin flag, la alerta no tenía semántica.

## A3. Nueva alerta `reponer_proactivo` (en PR1)

Agregar al union `AlertaIntel` y al PASO 19 (`intelligence.ts:1773+`):

```ts
if (r.pedir_proveedor > 0 && !r.necesita_pedir) {
  alertas.push("reponer_proactivo");
}
```

Urgencia: 🟡 Info. Cubre los 43 SKUs del P7 que post-fix van a tener `pedir_proveedor>0` pero `necesita_pedir=false` (porque `necesita_pedir` sigue usando ROP clásico).

## A4. [ROLLBACK 2026-04-22] Flag `flex_objetivo` eliminado — política actual

El flag `productos.flex_objetivo` (agregado en v57, migración inicial 125 SKUs) se eliminó en v59. No aportaba valor operativo:

1. La publicación ML nunca dependió del flag (revert parcial commit `9030d98`).
2. El motor usaba el flag solo para decidir `para_flex = 0` si `flex_objetivo=false`, pero la política real es "todo SKU con stock > buffer publica Flex" → el flag era metadato dormido.
3. La alerta `flex_bloqueado_por_stock` (PR3) perdía semántica sin el flag — eliminada junto al rollback.

**Política canónica actual (post v59):**

```
para_flex = max(0, stock_bodega − buffer_ml)
para_full = stock_bodega − para_flex
```

Sin opt-in por SKU. Los SKUs con `stock_bodega ≤ buffer` simplemente no llegan a publicar en Flex (caso borde de la aritmética, no un bloqueo de política).

## A5. Query diff pre/post PR3

**Pre-deploy (sábado AM):**

```sql
CREATE TABLE IF NOT EXISTS deploy_pr3_pre_snapshot AS
SELECT sku_origen, stock_bodega, mandar_full, pedir_proveedor, accion, pct_flex
FROM sku_intelligence;
```

**Post-deploy (tras primer recálculo):**

```sql
SELECT pre.sku_origen, pre.mandar_full AS mandar_full_antes,
       si.mandar_full AS mandar_full_despues,
       si.mandar_full - pre.mandar_full AS delta,
       si.accion, si.flex_objetivo
FROM deploy_pr3_pre_snapshot pre
JOIN sku_intelligence si USING (sku_origen)
WHERE pre.mandar_full != si.mandar_full
ORDER BY ABS(si.mandar_full - pre.mandar_full) DESC;
```

## A6. Grafo de PRs

```
PR1 (solo) ─ fix P7+P8 + alerta reponer_proactivo (esta semana)
              └ rehabilita 43 SKUs de pedidos suprimidos
              └ SKU testigo LITAF400G4PBL con 77 uds

PR2 → PR3 → PR4
       │      └ P5 en_quiebre_bodega efectivo (alertas +50-100 SKUs)
       └ sábado deploy, diff Slack/WhatsApp antes lunes

     PR5 (paralelo a PR2+PR3+PR4, empieza inmediato)
          └ P6 snapshot histórico stock publicado
          └ acumula data para PR6

PR6 (+30d después de PR5) ─ P2+P3 vel_flex ajustada por exposición
```

| PR | Cuándo | Depende de | Scope |
|---|---|---|---|
| PR1 | Esta semana | — | Fix P7+P8, alerta `reponer_proactivo`, 8 tests |
| PR2 | Próxima semana | — | Schema `flex_objetivo`, migración, UI toggle |
| PR3 | Sábado post-PR2 | PR2 | Función canon + colapso Reglas 2+3 + alerta `flex_bloqueado_por_stock` |
| PR4 | Post-PR3 | PR3 | Redefinir `en_quiebre_bodega` vía `publicar_flex` |
| PR5 | En paralelo a PR2 | — | Schema `stock_flex_publicado` en snapshots + history |
| PR6 | +30d post-PR5 prod | PR5 acumulando datos | `vel_flex_ajustada` y pct_flex dinámico con piso |

## A7. Riesgos operativos del Sprint

- **PR1:** pedir_proveedor sube para 43 SKUs. Sugerencia al operador, no OC automática. 397 uds adicionales en sugerencias de compra.
- **PR3:** 10 SKUs con stock paria ven `mandar_full > 0` súbitamente. Reversible con toggle `flex_objetivo=false` por SKU.
- **PR3 + migración A4:** 391 SKUs pasan de "reserva matemática Flex" a "todo disponible Full". Cambio macro de distribución stock. Mitigación: deploy sábado, diff compartido antes del lunes.
- **PR4:** `en_quiebre_bodega` empieza a marcar ~50-100 SKUs antes silenciados. Revisar triage antes del deploy.
