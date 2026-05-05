---
discovery: memoria-pre-quiebre
date: 2026-05-04 PM
owner: Vicente Elías
mode: read-only
tags: [discovery] [pre-quiebre] [abc] [motor-viejo-vs-nuevo]
related:
  - docs/discovery/comparacion-viejo-vs-nuevo-2026-05-04.md
  - src/lib/intelligence.ts (PASO 14b líneas 1320-1404, restauración 1807-1825)
  - función SQL calc_sku_node_policy_row()
---

# Discovery — Memoria de identidad pre-quiebre (D1-D7)

## TL;DR

1. **El motor viejo SÍ tiene memoria pre-quiebre robusta**: snapshot al entrar
   en quiebre + preservación durante quiebre + restauración en rampup
   post-recuperación + imputación de unidades históricas.
2. **El motor nuevo (`calc_sku_node_policy_row`) NO lee `abc_pre_quiebre`**.
   Solo lee `abc_unidades` (clasificación actual).
3. **HOY no se manifiesta el bug masivamente** porque el motor viejo computa
   `abc_unidades` con unidades **imputadas** desde `vel_pre_quiebre × 4.3` cuando
   hay quiebre prolongado. Así `abc_unidades` preserva la clase histórica → el
   motor nuevo lee A correctamente.
4. **Fragilidad latente**: la imputación tiene umbral `vel_pre_quiebre > 2`. SKUs
   con vel histórica baja-A (e.g., 1.5/sem) en quiebre 60d **NO entran** a la
   imputación → `abc_unidades` colapsa a C → motor nuevo asigna cell CY/CZ →
   `qty_a_comprar=0` → quiebre eterno.
5. **Universo afectado HOY**: 1 SKU (`TXV23QLAT20AQ`) con `abc_pre='A'` y
   `dias_en_quiebre=15`. Está OK por la imputación. Pero si entra a 60d con
   vel_pre_quiebre<2 caería al hueco. Catálogo no tiene casos críticos hoy.

---

## D1 — ¿Cómo se computa `abc_pre_quiebre` en el motor viejo?

Lógica en `src/lib/intelligence.ts` PASO 14b (líneas 1320-1404):

### Snapshot al entrar en quiebre

```ts
// línea 1383-1385
abcPreQuiebre = (prev?.abc === "A" || prev?.abc === "B" || prev?.abc === "C")
  ? prev.abc
  : null;
```

Si el SKU acaba de entrar en quiebre (`enQuiebreAhora=true && previaFecha=null`),
toma `abc_pre_quiebre = abc del snapshot previo`. La doctrina del comentario
(líneas 1371-1376) cita un caso histórico:

> Caso histórico: 4 SKUs (TXTPBL105200S, JSAFAB426P20S, TXV23QLAT15BE,
> TXV24QLBRMR25) quedaron atrapados en C con abc_ingreso=A.

Sin la asignación, el loop posterior asigna `abc=C` por margen bajo →
degradación permanente.

### Preservación durante quiebre

```ts
// línea 1366-1368
velPreQuiebre = Math.max(velHistorica, prev?.vel_pre_quiebre ?? 0);
margenUnitarioPreQuiebre = prev?.margen_unitario_pre_quiebre || 0;
abcPreQuiebre = prev?.abc_pre_quiebre ?? null;
```

Mientras el SKU continúe en quiebre (`enQuiebreAhora && previaFecha != null`),
se mantienen los 3 campos pre.

### Liberación al recuperar

```ts
// línea 1387-1402
} else if (prev && (prev.dias_en_quiebre ?? 0) > 0 && stFull > 0) {
  if (prev.vel_pre_quiebre > 2 && vel7d > prev.vel_pre_quiebre * 1.5) {
    esCatchUp = true;
  }
  if (vel30d > 0 && !esCatchUp) {
    // 3+ semanas vendiendo → reset completo
    velPreQuiebre = 0;
    margenUnitarioPreQuiebre = 0;
    abcPreQuiebre = null;
  } else {
    // Primeras semanas — preservar
    velPreQuiebre = prev.vel_pre_quiebre;
    abcPreQuiebre = prev.abc_pre_quiebre;
  }
}
```

Liberación: `dias_en_quiebre>0 PASA→0 + stFull>0 + vel30d>0 + NO catch-up`.
Antes de eso, sigue preservado.

### Restauración en ventana rampup

```ts
// línea 1807-1818
for (const r of rows) {
  const abcPre = r.abc_pre_quiebre;
  const enVentanaRampup = r.dias_en_quiebre === 0
    && r.vel_pre_quiebre > 0
    && r.vel_7d > 0
    && r.vel_30d < r.vel_pre_quiebre * 0.8;
  const perderiaClase = (abcPre === "A" && r.abc !== "A")
    || (abcPre === "B" && r.abc === "C");
  if (enVentanaRampup && perderiaClase && (abcPre === "A" || abcPre === "B")) {
    r.abc = abcPre;  // ← restaura
  }
}
```

Mientras `vel_30d < 80% × vel_pre_quiebre` y SKU está vendiendo (`vel_7d>0`),
restaura `abc = abc_pre_quiebre`. Auto-apaga cuando vel_30d se recupera.

### Asignación tardía (catch-up)

```ts
// línea 1821-1825
for (const r of rows) {
  if ((r.dias_en_quiebre ?? 0) > 0 && !r.abc_pre_quiebre) {
    r.abc_pre_quiebre = r.abc;
  }
}
```

Para SKUs que ya estaban en quiebre cuando se introdujo la lógica (sin
`abc_pre_quiebre` previo), asigna el `abc` actual como mejor proxy.

---

## D2 — Otros campos `pre_quiebre`

Lista completa en `sku_intelligence`:

| Campo | Tipo | Snapshot al entrar | Preserva durante | Libera |
|---|---|---|---|---|
| `vel_pre_quiebre` | numeric | `velHistorica = max(vel60d, velPonderada)` | `prev.vel_pre_quiebre` | reset 0 |
| `margen_unitario_pre_quiebre` | numeric | `margenProm` o prev fallback | `prev.margen_unitario_pre_quiebre` | reset 0 |
| `abc_pre_quiebre` | text A/B/C/null | `prev.abc` si era A/B/C | `prev.abc_pre_quiebre` | reset null |
| `vel_flex_pre_quiebre` | numeric | (no setea — viene del prev) | `prev?.vel_flex_pre_quiebre || 0` | (mismo flujo) |

Los 4 campos siguen el mismo ciclo de vida.

---

## D3 — ¿El motor nuevo lee `abc_pre_quiebre`?

**No**. La vista `v_classification_sku_origen` no existe — el motor nuevo usa
la función `calc_sku_node_policy_row()` que es invocada por
`refresh_sku_node_policy_from_templates()` (cron diario).

Cuerpo relevante:

```sql
CREATE OR REPLACE FUNCTION calc_sku_node_policy_row(...)
DECLARE v_abc text; v_xyz text;
BEGIN
  ...
  SELECT si.abc_unidades, si.xyz, si.vel_ponderada
    INTO v_abc, v_xyz, v_vel_pond
   FROM sku_intelligence si
  WHERE si.sku_origen = p_sku_origen LIMIT 1;
  ...
  v_cell := v_abc || v_xyz;  -- ← cell del motor nuevo
  ...
END;
```

**Solo lee `abc_unidades`**. Si `abc_unidades=C` → cell `CY/CZ` → policy_template
`CY/CZ` con `target_dias_full` bajo → `qty_a_comprar` casi cero.

### ¿Por qué el bug NO se manifiesta hoy?

Porque el motor viejo computa `abc_unidades` con **imputación de unidades
históricas**. En `intelligence.ts:1746-1748`:

```ts
const enQuiebreImputableUds = (r.dias_en_quiebre ?? 0) >= 14 && r.vel_pre_quiebre > 2;
if (enQuiebreImputableUds) {
  const udsImputado = Math.round(r.vel_pre_quiebre * 4.3);
  // ... este udsImputado se usa para recomputar abc_unidades
}
```

Cuando un SKU lleva ≥14d en quiebre Y `vel_pre_quiebre>2`, el motor sustituye
`uds_30d` por la imputación histórica. El cálculo de `abc_unidades` se hace
con esa imputación → preserva A.

**Fragilidad**: el umbral `vel_pre_quiebre > 2` deja afuera estrellas con
velocidad histórica baja (p.ej. 1.5/sem). Esos SKUs en quiebre prolongado
caerían al hueco.

---

## D4 — `es_quiebre_proveedor` vs quiebre_propio

Lógica en `intelligence.ts:1330-1331`:

```ts
let esQuiebreProveedor = !tieneStockProv
  || (!prod || prod.estado_sku === "sin_stock_proveedor");
```

Donde `tieneStockProv` (línea 973):

```ts
const stockProveedor: number | null = provCat?.stock_disponible ?? null;
const tieneStockProv = stockProveedor === null ? true : stockProveedor > 0;
```

Semántica:

| `proveedor_catalogo.stock_disponible` | `tieneStockProv` | `es_quiebre_proveedor` |
|---|---|---|
| `NULL` (nunca importado) | `true` (optimista) | `false` |
| `0` (importado, agotado) | `false` | `true` |
| `> 0` | `true` | `false` |

**No se snapshotea** — se re-evalúa en cada cron. Si el proveedor recibe stock,
el flag pasa a false inmediatamente. La doctrina actual (línea 1327-1329) lo
aclara:

> Flag re-evaluado SIEMPRE contra el catálogo actual — no se arrastra del
> estado previo. La semántica ahora es "el proveedor está agotado HOY", no
> "estaba agotado cuando el SKU entró en quiebre".

`quiebre_propio` no es un campo explícito — se infiere por exclusión:
`enQuiebreAhora && !es_quiebre_proveedor`.

---

## D5/D6 — Universo de "estrellas en quiebre prolongado" HOY

### Distribución completa de `abc_pre_quiebre`

| `abc_pre` | `abc_actual` | SKUs | en_quiebre | quiebre_prolongado (>14d) | quiebre_largo (>60d) |
|---|---|---|---|---|---|
| A | A | 17 | 13 | **1** | 0 |
| B | A | 1 | 0 | 0 | 0 |
| B | B | 10 | 9 | 0 | 0 |
| C | B | 2 | 0 | 0 | 0 |
| C | C | 37 | 20 | 1 | 0 |
| **NULL** | A | **82** | 0 | 0 | 0 |
| **NULL** | B | **75** | 0 | 0 | 0 |
| **NULL** | C | **285** | 0 | 0 | 0 |

**Hallazgos**:
1. **442 SKUs con `abc_pre_quiebre=NULL`** (87% del catálogo). Esto NO es bug
   — el campo se popula solo cuando un SKU entra en quiebre. SKUs que nunca
   quebraron lo tienen `NULL` correctamente.
2. **Cero SKUs con quiebre largo (>60d)**. El catálogo está en buena salud.
3. **Solo 1 SKU en el escenario de riesgo**: `TXV23QLAT20AQ`.

### Caso testigo: TXV23QLAT20AQ (Quilt Atenas 20P Aqua)

| Campo | Valor |
|---|---|
| abc, abc_unidades, abc_margen | A, A, A |
| abc_pre_quiebre | A |
| dias_en_quiebre | 15 |
| es_quiebre_proveedor | true |
| vel_pre_quiebre | 3.86 |
| vel_ponderada (actual) | 2.14 |
| xyz | Y |
| stock_total | 0 |
| cell, cell_efectiva | AY, AY |
| tendencia | recuperacion_post_quiebre |
| motor_nuevo qty_a_comprar | 20 |
| motor_viejo pedir_proveedor | 28 |
| motor_viejo accion | AGOTADO_SIN_PROVEEDOR |

**Sano**: ambos motores piden compra agresiva (motor viejo 28, motor nuevo 20).
La diferencia de 8 uds (28%) viene del rampup factor del motor viejo y
diferente target_dias.

`vel_pre_quiebre=3.86 > 2` → entra a la imputación → `abc_unidades=A` se
preserva → motor nuevo asigna cell `AY` → compra correctamente.

---

## D7 — Recomendación de implementación

### Estado actual: el problema NO es activo, pero la fragilidad es real

El motor viejo provee 4 capas de protección:

1. **Snapshot** de abc al entrar quiebre (línea 1383).
2. **Preservación** durante quiebre (línea 1368).
3. **Restauración rampup** post-recuperación (líneas 1807-1818).
4. **Imputación de uds_30d** desde vel_pre_quiebre × 4.3 (línea 1748) → preserva
   `abc_unidades`.

La capa #4 es la que **conecta** el motor viejo con el motor nuevo: como `abc_unidades`
está preservado, `calc_sku_node_policy_row` lee A y todo funciona. La memoria pre-quiebre
está implícitamente expuesta al motor nuevo vía `abc_unidades`.

**Pero la imputación tiene umbral `vel_pre_quiebre > 2`**. SKUs con vel histórica
1-2 en quiebre prolongado caen al hueco: `abc_unidades` no se imputa → colapsa
a C → motor nuevo entierra el SKU en CY/CZ.

### Opciones de implementación (de menos a más invasivo)

#### Opción A — Bajar el umbral de imputación en motor viejo

Cambiar `vel_pre_quiebre > 2` por `vel_pre_quiebre > 0.5` (intelligence.ts:1746).

**Costo**: ~30 min. 1 línea modificada. Plus tests.

**Riesgo**: SKUs con vel histórica muy baja (e.g., 0.5/sem = 2/mes) podrían
inflar artificialmente abc_unidades. Mitigación: combinar con `dias_en_quiebre>=21`
para evitar reactivos.

**Pros**: el cambio se propaga al motor nuevo sin tocar SQL.
**Contras**: parche en motor viejo que vamos a deprecar (Sprint 6).

#### Opción B — Agregar `abc_pre_quiebre` a `sku_node_policy` y `calc_sku_node_policy_row`

Pasos:
1. `ALTER TABLE sku_node_policy ADD COLUMN abc_pre_quiebre text` con CHECK ('A','B','C',NULL).
2. Modificar `calc_sku_node_policy_row()`:
   ```sql
   SELECT si.abc_unidades, si.xyz, si.vel_ponderada, si.abc_pre_quiebre, si.dias_en_quiebre
     INTO v_abc, v_xyz, v_vel_pond, v_abc_pre, v_dias_q FROM sku_intelligence si...
   
   v_abc_efectivo := CASE
     WHEN v_dias_q > 14 AND v_abc_pre IS NOT NULL THEN
       GREATEST(v_abc, v_abc_pre)  -- 'A' > 'B' > 'C' por orden alfabético
     ELSE v_abc
   END;
   v_cell := v_abc_efectivo || v_xyz;
   ```
3. Recrear `v_safety_stock`, `v_compras_pendientes`, `v_reposicion_explain` por CASCADE.

**Costo**: ~3-4h (migration + tests + cascade).

**Pros**: arregla la raíz en motor nuevo. Compatible con Sprint 6 (motor nuevo
gana la memoria que el viejo tiene).
**Contras**: agrega complejidad al motor nuevo justo cuando estamos
simplificándolo.

#### Opción C — Modificar `v_safety_stock` para leer `cell_efectiva` con preservación

Más quirúrgica que B: en `v_safety_stock` agregar a `politica_efectiva` un join
con `sku_intelligence` para componer `cell_efectiva = abc_pre || xyz` cuando
`dias_en_quiebre > 14`.

**Costo**: ~2h.

**Pros**: cambio localizado en una vista, sin migration de columna nueva.
**Contras**: lógica de negocio en SQL es menos legible que en una RPC.

### Recomendación

**Opción A** es la más limpia HOY: parche de 1 línea en motor viejo, atiende
la fragilidad sin sobrecargar el motor nuevo. Compatible con Sprint 6 (cuando
deprecamos el motor viejo, la lógica se moverá al nuevo).

**Opción B** debería formar parte de Sprint 6 cuando se porten las 4 funciones
del motor viejo al nuevo (memoria `project_banva_rampup_pendiente` enumera
las funciones a portar). `abc_pre_quiebre` puede ser la 5ta función portada.

**Opción C** es solo si la doctrina del motor nuevo se quiere mantener pura
(SQL views) sin tocar el motor viejo. Más compleja, no la recomiendo.

### Compatibilidad con doctrina Sprint 4.3a

Sprint 4.3a estableció `target_dias_flex` per-cell-per-template. La memoria
pre-quiebre encaja sin conflicto: si un SKU está en cell efectiva 'AY' (en
lugar de 'CY'), aplica el `target_dias_flex` de AY automáticamente. No hay
contradicción.

---

## Conclusiones

1. **El motor viejo está bien diseñado en este aspecto**. Tiene memoria
   pre-quiebre con liberación correcta y restauración en rampup.
2. **El motor nuevo hereda la protección de manera implícita** vía
   `abc_unidades` (que el viejo preserva con imputación). Funciona HOY.
3. **Universo afectado HOY: 1 SKU**, en posición sana. No urge.
4. **Fragilidad**: el umbral `vel_pre_quiebre > 2` para imputación de
   unidades. SKUs con vel histórica baja-A caerían al hueco si entran a
   quiebre largo. Hoy no hay casos.
5. **Recomendación**: Opción A (parche de 1 línea en motor viejo) si urge.
   Opción B (port a motor nuevo) como parte de Sprint 6.

---

*Discovery ejecutado por Claude Opus 4.7 (1M context) el 2026-05-04 PM bajo
`feedback_banvabodega_autonomy`. Read-only — sin modificaciones a schema,
datos ni código.*
