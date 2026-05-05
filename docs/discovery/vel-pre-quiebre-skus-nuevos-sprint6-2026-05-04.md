---
sprint: discovery
title: vel_pre_quiebre + SKUs nuevos + scope Sprint 6
date: 2026-05-04 PM
owner: Vicente Elías
tags: [discovery] [read-only] [pre-sprint-6]
related:
  - docs/discovery/memoria-pre-quiebre-2026-05-04.md (Parte D, sesión previa)
  - docs/sprints/sprint-5.5.5-revert-supplier-lt.md
  - src/lib/intelligence.ts (motor viejo)
  - supabase/migrations/20260504210000_sprint555_revert_agotar_supplier_lt.sql (v_safety_stock)
status: read-only — NO se modifica nada
---

# Discovery — vel_pre_quiebre, SKUs nuevos, scope Sprint 6

Discovery read-only que cierra Bloque B post-revert agotar. Tres preguntas:

- **A.** ¿Cómo usa el motor nuevo `vel_pre_quiebre`? ¿Hay gaps de cobertura vs motor viejo?
- **B.** ¿Cómo trata el motor nuevo a los SKUs nuevos? ¿Hay concepto equivalente a `esNuevo`?
- **C.** Con todo lo aprendido (D + A + B + porting de Sprint 5.5+), ¿cuál es el scope mínimo para un Sprint 6 que cierre los gaps motor viejo→nuevo?

---

## Parte A — `vel_pre_quiebre` en motor nuevo

### A1. ¿Dónde lee `vel_pre_quiebre` el motor nuevo?

Una sola superficie crítica: el CTE `demand_stats` de `v_safety_stock`.

```sql
-- v_safety_stock.demand_stats (transcrito Sprint 5.5.5)
CASE
  WHEN si.es_quiebre_proveedor = true 
    AND si.vel_pre_quiebre IS NOT NULL 
    AND si.vel_pre_quiebre > 0
    AND si.vel_pre_quiebre > (COALESCE(si.vel_ponderada, 0) * 2)  -- ★ umbral 2x estricto
  THEN si.vel_pre_quiebre
  WHEN COALESCE(si.multiplicador_evento, 1.0) > 1
  THEN COALESCE(si.vel_ponderada, 0) * si.multiplicador_evento
  ELSE COALESCE(si.vel_ponderada, 0)
END * COALESCE(si.factor_rampup_aplicado, 1.0) AS d_avg_sem
```

**Tres condiciones acumulativas** para que motor nuevo use `vel_pre_quiebre`:

1. `es_quiebre_proveedor = true` (no basta `dias_en_quiebre > 0` — exige quiebre **del proveedor**, no de bodega).
2. `vel_pre_quiebre > 0`.
3. **`vel_pre_quiebre > vel_ponderada * 2`** ← umbral muy estricto.

Comparado con motor viejo (intelligence.ts:1746-1752):

```ts
const enQuiebreImputableUds = (r.dias_en_quiebre ?? 0) >= 14 && r.vel_pre_quiebre > 2;
if (enQuiebreImputableUds) {
  const udsImputado = Math.round(r.vel_pre_quiebre * 4.3);
  r.uds_30d = Math.max(udsReal, udsImputado);
}
```

Motor viejo imputa cuando **(a)** dias_en_quiebre ≥ 14 **(b)** vel_pre_quiebre > 2 (absoluto).
Motor nuevo exige umbral relativo 2x sobre vel_ponderada — más estricto.

### A2. Caso testigo TXV23QLAT20AQ — gap real medido

Query del Sprint 5.5.5 sobre los 22 SKUs en quiebre confirmó el gap:

| SKU | vel_pond | vel_pre_quiebre | ratio | umbral 2x | qué usa |
|---|---|---|---|---|---|
| TXV23QLAT20AQ | 2.14 | 3.86 | 1.8× | 4.28 | **vel_ponderada (2.14)** ← debería usar 3.86 |
| ... otros 21 | varían | varían | — | — | mayoría usa_ponderada |

**Conclusión**: el umbral 2× del motor nuevo deja sin proteger SKUs con caída moderada de vel pre→pos quiebre (1× a 2×). El motor viejo ya tenía esta protección via imputación `uds_30d` (que después alimenta cálculos de gap/cobertura).

### A3. ¿Qué de motor viejo NO se ve reflejado en motor nuevo?

| Mecanismo motor viejo | ¿En motor nuevo? | Comentario |
|---|---|---|
| Imputación `uds_30d = vel_pre_quiebre × 4.3` cuando `dias_en_quiebre ≥ 14` | **No directo** | Motor nuevo usa `vel_ponderada` directo (calculada con semanas activas, excluyendo quiebres) |
| Threshold 2× sobre vel_ponderada | **Sí (único trigger)** | Único path para que `vel_pre_quiebre` infle `d_avg_sem` |
| Factor rampup post-quiebre | **Sí** | `factor_rampup_aplicado` multiplica al final |
| Restauración `r.abc = abc_pre_quiebre` en rampup | **Parcial** | Motor nuevo lee `abc_unidades` (snapshot), no hace runtime restoration |
| Multiplicador evento | **Sí** | `multiplicador_evento` rama explícita |

**Gap principal**: el threshold 2× es demasiado estricto. SKUs con caída pre→pos de 1.0×–1.99× (caída moderada por quiebre) no son rescatados. En motor viejo la imputación `uds_30d` **no dependía de threshold relativo** — solo absoluto (`vel_pre_quiebre > 2`).

### A4. ¿Por qué pasó esto?

El motor nuevo eligió `vel_ponderada` como fuente principal porque ya viene "limpia" de quiebres (calculada solo con `semanasActivas`, intelligence.ts:1075-1082). Eso es correcto en estado estable. Pero **durante** un quiebre prolongado, `vel_ponderada` cae junto al stock real (no hay ventas → `vel_7d` cae) y la "limpieza" no es suficiente: la `vel_ponderada` queda artificialmente baja.

El motor viejo resolvió esto con imputación cruda. El motor nuevo intentó resolverlo con threshold relativo, pero el threshold quedó muy alto para la dinámica real.

---

## Parte B — SKUs nuevos en motor nuevo

### B1. Universo de SKUs nuevos

`ml_items_map.date_created_ml` es la fuente de "fecha de creación en ML":

| Ventana | SKUs nuevos | % de catálogo activo (664) |
|---|---|---|
| ≤ 14 días | ~3 | 0.5% |
| ≤ 30 días | 14 | 2.1% |
| ≤ 60 días | 98 | 14.8% |
| ≤ 90 días | 136 | 20.5% |

**Catálogo bastante "joven"**: 1 de cada 5 SKUs activos tiene <90 días en ML.

### B2. Distribución de cell para SKUs nuevos (≤60d)

| cell | SKUs | vel_promedio | vel_pre_quiebre_prom | estrellas (>2) |
|---|---|---|---|---|
| **CZ** | **70** | 0.13 | 0.07 | 0 |
| BZ | 16 | 1.39 | 0.86 | 4 |
| AY | 4 | 4.83 | 1.30 | 3 |
| sin_cell | 4 | 0.00 | 0.00 | 0 |
| AZ | 2 | 3.84 | 0.00 | 2 |
| BY | 2 | 2.07 | 0.00 | 1 |

**Lectura**: 71% de los SKUs nuevos quedan en CZ (caja de "vender 0" o "muy baja velocidad"). El motor segrega bien las estrellas (10 SKUs nuevos llegaron a celdas A/B en <60 días), pero el grueso del catálogo nuevo está atrapado en CZ por construcción del Pareto.

### B3. Estrellas nacientes (vel_ponderada > 2) — top 11 SKUs nuevos

| SKU | días vida | vel_pond | vel_30d | uds_30d | abc | en_quiebre | cell | cell_efectiva | tendencia |
|---|---|---|---|---|---|---|---|---|---|
| TX2ALIMFP5070 | 47 | 12.25 | 10.67 | 32 | A | 0 | AY | AY | estable |
| TXALMILLVIS46 | **25** | 4.64 | 5.75 | 23 | A | 0 | AZ | AZ | estable |
| JSAFAB438P20W | 32 | 3.13 | 3.00 | 9 | A | 0 | BZ | BZ | recuperación |
| TXTLVAL4G6PAZ | 45 | 3.04 | 2.50 | 10 | A | 0 | AZ | AZ | acelerando |
| JSAFAB436P20W | 32 | 2.87 | 7.00 | 7 | B | 4 | BZ | BZ | recuperación |
| TXV25QLBRRS20 | 54 | 2.81 | 2.75 | 11 | A | 0 | AY | AY | estable |
| TXTLILL4G4PNG | 68 | 2.80 | 3.00 | 12 | A | 0 | AY | AY | acelerando_fuerte |
| JSAFAB433P20W | 32 | 2.27 | 2.00 | 4 | B | 0 | BZ | **AZ** ← promovido | acelerando |
| TXV25QLBRGR30 | 54 | 2.27 | 1.75 | 7 | B | 0 | BY | BY | estable |
| TXV25QLBRBG25 | 54 | 2.26 | 3.50 | 14 | A | 0 | AY | AY | estable |
| TXV25QLBRVD25 | 54 | 2.19 | 1.25 | 5 | B | 0 | BZ | BZ | estable |

**Observaciones**:
- TXALMILLVIS46 con **25 días de vida** ya está en AZ con `vel=4.64`. Motor lo segregó correctamente sin necesidad de flag explícito.
- JSAFAB433P20W: caso de promoción `cell_efectiva=AZ` aunque `cell=BZ` — la doctrina trend (sprint 4.3b) ya lo está moviendo solo.
- 11 SKUs <90d con vel>2 ⇒ motor SÍ los detecta, pero por velocidad observada (post-hoc), no por edad (a-priori).

### B4. Lógica `esNuevo` en motor viejo

`intelligence.ts:1480`:

```ts
const movimientoReciente = diasSinMov === null || diasSinMov <= 30;
const esNuevo = velPonderada === 0 && velPreQuiebre === 0 && stTotal > 0;

if (esNuevo && movimientoReciente && stFull === 0 && stBodega > 0) {
  const loteInicial = Math.max(innerPack, 2);
  mandarFull = Math.min(loteInicial, stBodega);
}

// Acción / prioridad:
if      (esNuevo && movimientoReciente && stFull === 0 && stBodega > 0) accion = "MANDAR_FULL"; // p=10
else if (esNuevo && movimientoReciente) accion = "NUEVO"; // p=50
```

**No es estrictamente "SKU nuevo"** — es "SKU sin ventas con stock". El guard `movimientoReciente` (≤30d sin movimiento, o NULL) discrimina genuinamente nuevo de dead stock viejo.

Efecto operativo: a un SKU con stock pero sin ventas, motor viejo le manda **lote inicial a Full** (`max(inner_pack, 2)`) para forzar exposición. Si después de eso sigue sin vender → cae a `DEAD_STOCK` (p=80).

### B5. ¿Existe equivalente en motor nuevo?

Búsqueda de flag `is_new_sku`, `sku_nuevo`, `es_nuevo` en columnas:

```
Resultado: 0 columnas relevantes en sku_node_policy ni sku_intelligence.
Único hit: recepcion_ajustes.sku_nuevo (no relacionado).
```

**Motor nuevo es ciego al concepto de "SKU nuevo".** Trabaja solo con métricas observadas (`velocidad_observada`, `velocidad_censurada`, `dias_quiebre_window_30d`). Si un SKU acaba de salir a la venta y aún no tiene ventas:

- Aparece en `sku_node_policy` con `cell=CZ` (caja default por bajo Pareto).
- `v_compras_pendientes` lo procesa con velocidad ~0 → no recomienda recompra.
- `v_safety_stock.d_avg_sem` ≈ 0 → safety_stock y reorder_point ≈ 0.
- **No hay path a "MANDAR_FULL lote inicial"** equivalente al motor viejo.

### B6. Buckets de edad — ¿en qué cell quedan los SKUs jóvenes?

| Edad | CZ | sin_cell | A/B | Total |
|---|---|---|---|---|
| 15-30d | 11 (79%) | 2 | 1 | 14 |
| 31-60d | 59 (70%) | 2 | 23 | 84 |
| 61-90d | 24 (63%) | 8 | 6 | 38 |

A los 30 días la mayoría de SKUs nuevos sigue en CZ (esperado, sin historial). Pero **incluso a los 60-90 días**, 63-70% siguen atrapados en CZ. Sin flag explícito, el motor nuevo no sabe distinguir "CZ porque es nuevo y aún no se sabe" de "CZ porque vende poco genuinamente".

---

## Parte C — Scope Sprint 6

Inventario consolidado de gaps motor viejo → motor nuevo (incluye lo de Parte D del discovery previo + Parte A + Parte B + porting Sprint 5.5+):

### C1. Items priorizados

| # | Item | Origen del gap | Esfuerzo | Impacto | Prioridad |
|---|---|---|---|---|---|
| **1** | **Bajar umbral 2× de vel_pre_quiebre** | Parte A (gap medido en TXV23QLAT20AQ) | 1h | Alto en SKUs en quiebre prolongado | P0 |
| **2** | **Flag `is_new_sku` + handling explícito** | Parte B (motor ciego a edad) | 4h | Medio (acelera ramp-up de catálogo nuevo) | P1 |
| **3** | **Acción + prioridad** (`accion`, `prioridad`, `MANDAR_FULL`/`NUEVO`/`DEAD_STOCK`) | Parte D + B (motor nuevo no expone acción operativa) | 3h | Alto (reposición operativa) | P0 |
| **4** | **abc_pre_quiebre runtime restoration** | Parte D (motor nuevo solo lee snapshot abc_unidades) | 2h | Medio (sólo edge case rampup) | P2 |
| **5** | **Eventos + multiplicador en compras** | Parte A (motor nuevo solo lo aplica en safety_stock) | 2h | Bajo (1 evento activo histórico) | P2 |
| **6** | **`mandar_full` + lote inicial** | Parte B (no existe path nuevo) | 2h | Medio (depende de #2) | P1 |
| **7** | **Antipatrón filtro `IS DISTINCT FROM 'descontinuado'` (lint CI)** | Sprint 5.5.5 lección | 1h | Bajo (preventivo) | P2 |

**Total estimado P0-P2**: ~15h.

### C2. Orden sugerido (dependencias)

1. **#1 (1h)** — Fix puntual `v_safety_stock.demand_stats`. Independiente. Standalone migration.
2. **#3 (3h)** — Acción + prioridad. Necesita decisión: ¿columna en `sku_node_policy` o `v_compras_pendientes`? Recomendación: columna persistida en `sku_node_policy` (más fácil de filtrar desde UI).
3. **#2 + #6 (4+2h = 6h)** — SKUs nuevos. Bloque cohesivo: agregar `is_new_sku` boolean en `sku_node_policy`, calcularlo en `refresh_sku_node_policy_from_templates()` desde `ml_items_map.date_created_ml < NOW() - INTERVAL '30 days'` (o ventana parametrizable), y luego usar el flag en views para forzar `mandar_full` cuando aplique.
4. **#4 (2h)** — abc_pre_quiebre runtime. Bajo retorno; postergable.
5. **#5 (2h)** — Eventos en compras. Postergable.
6. **#7 (1h)** — Lint CI. Postergable, no bloquea features.

**Sprint 6 recomendado: #1 + #3 + #2/#6 = 10h en 1-2 sesiones**. Items #4/#5/#7 a Sprint 7 si aún relevantes.

### C3. Migraciones ALTER TABLE necesarias

Solo el bloque #2 + #6 + #3 requieren cambios de schema:

**`sku_node_policy`** (item #2):
```sql
ALTER TABLE sku_node_policy 
  ADD COLUMN is_new_sku boolean NOT NULL DEFAULT false,
  ADD COLUMN dias_de_vida int;
COMMENT ON COLUMN sku_node_policy.is_new_sku IS 'Sprint 6: SKU con date_created_ml < 30d AND sin historial de ventas robusto';
```

**`sku_node_policy`** (item #3 — opción A, columna persistida):
```sql
ALTER TABLE sku_node_policy 
  ADD COLUMN accion text,
  ADD COLUMN prioridad smallint;
-- accion: enum lógico = INACTIVO|MANDAR_FULL|NUEVO|DEAD_STOCK|AGOTADO_PEDIR|URGENTE|PLANIFICAR|OK|EXCESO
COMMENT ON COLUMN sku_node_policy.accion IS 'Sprint 6: acción operativa (port motor viejo)';
```

Si se prefiere **opción B (vista derivada)**, no se necesita ALTER:

```sql
-- Crear v_sku_action que JOIN snp + vss + vcp y derive accion/prioridad
CREATE VIEW v_sku_action AS SELECT ...
```

Recomendación: **opción A** porque permite filtros rápidos en UI sin recomputar. Trade-off: el campo es derivado y requiere recálculo en cada cron.

### C4. Lo que NO va en Sprint 6

- Eliminar motor viejo (`intelligence.ts`). Motor viejo sigue siendo SSoT de `sku_intelligence` que el motor nuevo consume — el desacople es para Sprint 7+.
- Modificar `/api/ml/stock-sync` (buffer Flex=0 para `agotar` ya está estable).
- Crons nuevos. Los existentes (`recalcular-todo`, `sync-from-templates`, `sync-trend-detection`) deberían cubrir el flujo.

---

## Resumen ejecutivo

**Parte A** — `vel_pre_quiebre` está parcialmente cubierto en motor nuevo, pero el threshold relativo `> vel_ponderada × 2` deja sin proteger SKUs con caída moderada (1×–2×). Caso testigo TXV23QLAT20AQ (3.86 vs 2.14, ratio 1.8×) confirma el gap.

**Parte B** — Motor nuevo es ciego al concepto de "SKU nuevo". 71% de los 98 SKUs nuevos (≤60d) quedan en CZ. Las estrellas nacientes (11 con vel>2) son detectadas post-hoc por velocidad observada, no a-priori. Sin flag explícito, no hay path equivalente a `MANDAR_FULL` lote inicial del motor viejo.

**Parte C — Sprint 6 recomendado (~10h)**:
1. Bajar umbral vel_pre_quiebre (1h, P0).
2. Acción + prioridad persistidas en sku_node_policy (3h, P0).
3. Flag is_new_sku + lote inicial (6h, P1).

Items P2 (abc_pre_quiebre runtime, eventos en compras, lint CI) postergables a Sprint 7.

---

*Discovery ejecutado por Claude Opus 4.7 (1M context) el 2026-05-04 PM bajo `feedback_banvabodega_autonomy`. Read-only — cero modificaciones a producción. Cierra el bloque B post-revert agotar (Sprints 5.5.2 + 5.5.4 + 5.5.5).*
