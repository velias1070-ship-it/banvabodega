# Inventario de thresholds de pricing — Fase 0

**Fecha:** 2026-04-27
**Objetivo:** listar TODOS los umbrales/reglas que hoy gobiernan decisiones de pricing en BANVA, con `archivo:linea`, fuente (código/DB) y referencia al manual cuando aplica. Sin código, solo documento.

**Por qué importa:** decidir óptimo (rule sets versionados, shadow mode, decision log) vs light (tabla key/value sin versionar) depende de cuántas reglas hay y qué tan seguido cambian. Este inventario es el insumo para esa decisión.

**Convención:** `H` = hardcoded en TypeScript, `DB` = `pricing_cuadrante_config` u otra tabla, `M` = referencia explícita al manual `BANVA_Pricing_Investigacion_Comparada` o `Engines_a_Escala`.

---

## 1. Tabla maestra (resumen — 36 reglas)

| # | Regla | Valor actual | Fuente | Archivo | Manual |
|---|-------|--------------|--------|---------|--------|
| 1 | Markdown nivel 1 (aging) | -20% a 90d sin venta | H | `markdown-auto/route.ts:147-152` | `Investigacion_Comparada:197` |
| 2 | Markdown nivel 2 (aging) | -40% a 120d sin venta | H | `markdown-auto/route.ts:147-152` | idem |
| 3 | Markdown nivel 3 (aging) | -60% a 180d sin venta | H | `markdown-auto/route.ts:147-152` | idem |
| 4 | Valle muerte mín | $19.990 CLP | H | `pricing.ts:24` | `Engines_a_Escala` valle muerte ML CL |
| 5 | Valle muerte máx | $23.000 CLP | H | `pricing.ts:25` | idem |
| 6 | Subtipo REVISAR liquidar | dead_stock OR ≥180d sin mov | H | `pricing.ts:433` | `Investigacion_Comparada:197` |
| 7 | Subtipo REVISAR sin stock | stock=0 AND uds_30d=0 | H | `pricing.ts:434` | Deep_Research §3 |
| 8 | Subtipo REVISAR nuevo | <60d desde primera venta | H | `pricing.ts:435` | — |
| 9 | Override revisar_sano | margen 15%, desc 20% | H | `pricing.ts:496-499` | — |
| 10 | Override revisar_sin_stock | margen 20%, desc 10%, no_postular | H | `pricing.ts:500-505` | — |
| 11 | Override revisar_nuevo | margen 15%, desc 15%, no_postular | H | `pricing.ts:506-511` | — |
| 12 | Trigger aging reclasif | >120d sin movimiento | H | `triggers-reclasificacion/route.ts:106` | `Investigacion_Comparada:235` |
| 13 | Trigger crecimiento | +20% MoM por 3 meses | H | `triggers-reclasificacion/route.ts:126-129` | idem |
| 14 | Trigger margen bajo | <15% por 2 meses | H | `triggers-reclasificacion/route.ts:140-142` | idem |
| 15 | Pareto clase A | ≤80% acumulado | H | `intelligence.ts:1684` | clásico ABC |
| 16 | Pareto clase B | ≤95% acumulado | H | `intelligence.ts:1685` | idem |
| 17 | Distribución Full/Flex | 80/20 | H | `intelligence.ts:1147-1155` | — |
| 18 | Recovery rampup post-quiebre | vel_30d < vel_pre × 80% | H | `intelligence.ts:1719-1732` | — |
| 19 | Cooldown ventana | 24h | H | `pricing.ts:297` | `Engines_a_Escala` |
| 20 | Cooldown max bajadas | 2 en ventana | H | `pricing.ts:298` | idem |
| 21 | Margen mín ESTRELLA | 8% | DB | `pricing_cuadrante_config` v74 | `Investigacion_Comparada:148` |
| 22 | Margen mín VOLUMEN | 5% | DB | idem | idem |
| 23 | Margen mín CASHCOW | 20% | DB | idem | idem |
| 24 | Margen mín REVISAR | 0% | DB | idem | idem |
| 25 | Fallback margen mín | 15% | H | `pricing.ts:440` | — |
| 26 | CMAA umbral alerta | <8% | H | `cmaa-real/route.ts:11, 95` | `Investigacion_Comparada:329` |
| 27 | CMAA ventana | 60d sostenidos | H | `cmaa-real/route.ts:12` | idem |
| 28 | Cobertura mín postular | 28d | H | `pricing.ts:35` | — |
| 29 | Cobertura sobrestock | >90d | H | `pricing.ts:40` | — |
| 30 | Target días clase A | 42d | H | `intelligence.ts:384-388` | — |
| 31 | Target días clase B | 28d | H | idem | — |
| 32 | Target días clase C | 14d | H | idem | — |
| 33 | KVI descuento máx | 20% off lista | H | `pricing.ts:203` | — |
| 34 | Defender descuento máx | 10% off lista | H | `pricing.ts:213` | `Investigacion_Comparada:630` (10% diario) |
| 35 | Margen colchón warning | +3pp sobre mín | H | `pricing.ts:234` | — |
| 36 | Tendencia velocidad | ±15% | H | `intelligence.ts:524-526` | — |

**Rampup post-quiebre** (matriz separada — 12 celdas, ver §6).

**Governance temporal 10/25/25%** (`Investigacion_Comparada:630`): **NO IMPLEMENTADO**. El único gate parecido es defender ≤10% (#34), que es por postulación, no por ventana temporal.

---

## 2. Markdown ladder (aging-driven)

`src/app/api/pricing/markdown-auto/route.ts:147-152`

```
diasSinVenta < 90  → no postular
diasSinVenta ≥ 90  → -20%
diasSinVenta ≥ 120 → -40%
diasSinVenta ≥ 180 → -60%
```

**Manual:** `Investigacion_Comparada:197` ("Dog/descontinuar: >90-180d slow; >180-365d dead stock"). El ladder está **alineado** con el manual.

**Cambios candidatos:** descuentos por nivel y umbrales en días son lo más obvio que un PM querría calibrar (ej: ¿es muy agresivo bajar -60% a 180d? ¿debería ser -40% para quilts y -60% para sábanas?). 4 valores movibles.

---

## 3. Valle muerte (ML CL fuerza envío gratis sin compensar)

`src/lib/pricing.ts:24-25`

```
VALLE_MUERTE_MIN = 19990
VALLE_MUERTE_MAX = 23000
```

**Origen:** política ML CL. Cambia cuando ML cambia el rango. Histórico: ML lo movió en 2024 y 2025.

**Cambios candidatos:** 2 valores. Cambian raramente pero cuando cambian son urgentes.

---

## 4. Subtipos REVISAR (criterios + overrides)

`src/lib/pricing.ts:418-514`

**Criterios de clasificación (4):**
- `revisar_liquidar`: dead_stock OR dias_sin_mov ≥ 180
- `revisar_sin_stock`: stock=0 AND uds=0
- `revisar_nuevo`: dias_desde_primera < 60
- `revisar_sano`: default

**Overrides por subtipo (3 sets × 3 valores = 9 valores):**

| subtipo | margen_min | desc_max | no_postular |
|---------|------------|----------|-------------|
| revisar_sano | 15% | 20% | false |
| revisar_sin_stock | 20% | 10% | true |
| revisar_nuevo | 15% | 15% | true |

**Manual:** parcial. `Investigacion_Comparada:197` cubre liquidar; "gobierno de surtido" cubre sin_stock. El "nuevo <60d" no está prescrito explícitamente en el manual revisado.

**Cambios candidatos:** 13 valores movibles. Alta probabilidad de calibración (los overrides afectan directo cuántos SKUs se postulan).

---

## 5. Triggers de reclasificación

`src/app/api/pricing/triggers-reclasificacion/route.ts`

**3 implementados:**
- aging: `dias_sin_mov > 120`
- crecimiento: `MoM > 20% por 3 meses consecutivos`
- margen: `< 15% por 2 meses consecutivos`

**2 pendientes (`Investigacion_Comparada:235`):**
- Buy Box drop 20pp/7d (requiere price_to_win histórico — Task #20)
- Competidor agresivo -10% UE (requiere scraping/Nubimetrics)

**Cambios candidatos:** 8 valores movibles (umbral, ventana, meses consecutivos por trigger).

---

## 6. Pareto + cuadrante

`src/lib/intelligence.ts:1670-1689, 1749-1760`

**Cortes Pareto (3 valores):**
- A: ≤80% acumulado
- B: ≤95% acumulado
- C: resto

**Eje principal:** `margen_neto_30d` (luego ingreso, luego unidades).

**Matriz cuadrante (deterministic):**
- ESTRELLA = A_margen ∧ A_unidades
- CASHCOW = A_margen ∧ ¬A_unidades
- VOLUMEN = ¬A_margen ∧ A_unidades
- REVISAR = resto

**Override recovery rampup:** si `dias_en_quiebre=0 ∧ vel_30d < vel_pre×0.8` → mantener cuadrante previo (1 valor: 80%).

**Distribución Full/Flex:** 80/20 default cuando no hay reglas específicas (1 valor).

**Cambios candidatos:** 5 valores. Pareto cuts y recovery threshold son los más sensibles — moverlos cambia la composición de cada cuadrante.

---

## 7. Rampup post-quiebre (matriz)

`src/lib/rampup.ts:4-16`

| días sin stock | propio | proveedor |
|---------------|--------|-----------|
| 1-14 | 1.00 | 1.00 |
| 15-30 | 0.50 | 1.00 |
| 31-60 | 0.50 | 0.75 |
| 61-120 | 0.30 | 0.75 |
| 121-365 | 0.00 | 0.50 |

**12 valores movibles** (5 buckets × 2 columnas + límites de los buckets).

---

## 8. Cooldown anti race-to-the-bottom

`src/lib/pricing.ts:297-298`

- Ventana: 24h
- Max bajadas: 2

**2 valores movibles.** Es el mecanismo que evita que el algoritmo se autopisotee (postula promo → ML obliga otro -10% → cooldown corta).

---

## 9. Pisos por cuadrante (DB — `pricing_cuadrante_config` v74)

`supabase-v74-pricing-cuadrante-config.sql`

| cuadrante | margen_min | politica | acos_obj | desc_max | desc_max_kvi |
|-----------|------------|----------|----------|----------|--------------|
| ESTRELLA | 8% | exprimir | 13% | 10% | 8% |
| VOLUMEN | 5% | seguir | 18% | 25% | 15% |
| CASHCOW | 20% | defender | 7% | 10% | 8% |
| REVISAR | 0% | liquidar | 5% | 60% | 30% |
| _DEFAULT | 15% | seguir | 12% | 20% | 10% |

**25 valores en DB.** Esto **ya es editable** vía UI (`AdminPricingConfig.tsx`). Es el único bloque de reglas que hoy se puede mover sin deploy.

**Manual:** `Investigacion_Comparada:148` prescribe los límites de margen mínimo y la política por cuadrante. Los valores actuales están alineados con el manual.

---

## 10. CMAA — alerta portfolio pruning

`src/app/api/pricing/cmaa-real/route.ts:11-12, 95`

- Umbral CMAA: 8%
- Ventana sostenida: 60d
- Acción: portfolio pruning

**2 valores movibles.** Manual: `Investigacion_Comparada:329`.

---

## 11. Cobertura

`src/lib/pricing.ts:35, 40` y `src/lib/intelligence.ts:384-388`

- Cobertura mín postular promo: 28d
- Cobertura sobrestock warning: 90d
- Cob_objetivo: 40d
- Cob_maxima: 60d
- Target días por clase ABC: 42d / 28d / 14d

**7 valores movibles.**

---

## 12. ROP / Service level

`src/lib/intelligence.ts:1212-1216`

- Z 97% = 1.88
- Z 95% = 1.65
- Z 80% (default) = 1.28

**3 valores movibles** (más bien constantes estadísticas, raramente se mueven — es el `nivel de servicio` que se mueve).

---

## 13. Forecast quality alerts

`src/lib/intelligence.ts:648, 652-654`

- Tracking signal: |TS| > 4 → alerta
- Bias: |bias| > vel_ponderada × 0.3 → alerta
- Mín semanas evaluadas: 4 (TS), 8 (bias)

**4 valores movibles.**

---

## 14. Otros gates

| Regla | Valor | Archivo |
|-------|-------|---------|
| KVI desc máx | 20% off | `pricing.ts:203` |
| Defender desc máx | 10% off | `pricing.ts:213` |
| Margen colchón warning | +3pp | `pricing.ts:234` |
| Tendencia velocidad | ±15% | `intelligence.ts:524-526` |
| Quiebre prolongado rama 1 | ≥14d ∧ vel_pre>2 | `intelligence.ts:40-45` |
| Quiebre prolongado rama 2 | ≥7d (ESTRELLA/CASHCOW) | idem |
| Edad mínima TSB | 60d | `intelligence.ts:473-474` |
| Imputación 30d | 4.3 semanas | `intelligence.ts:1013, 1444, 1637, 1650, 1663` |

**11 valores movibles.**

---

## 15. Conteo total y categorización

| Categoría | Reglas | Movibles |
|-----------|--------|----------|
| Markdown ladder | 1 set | 4 |
| Valle muerte | 1 set | 2 |
| Subtipos REVISAR | 4 criterios + 3 overrides | 13 |
| Triggers reclasificación | 5 (3 implementados) | 8 |
| Pareto + cuadrante | 1 set | 5 |
| Rampup matrix | 1 matrix | 12 |
| Cooldown | 1 set | 2 |
| Pisos por cuadrante (DB) | 5 cuadrantes × 5 cols | 25 |
| CMAA | 1 set | 2 |
| Cobertura | 1 set | 7 |
| ROP / service level | 1 set | 3 |
| Forecast quality | 1 set | 4 |
| Otros gates | 11 | 11 |
| **TOTAL** | **~36 reglas** | **~98 valores movibles** |

**Hardcoded en TS:** ~73 valores (74%).
**En DB editable:** ~25 valores (26%, todos en `pricing_cuadrante_config`).

---

## 16. Clasificación por frecuencia esperada de cambio

**Estables (cambian <1×/año):**
- Pareto cuts (15-17)
- ROP / Z-scores (12)
- Imputación 4.3 semanas (cte. matemática)
- Valle muerte (cuando ML lo cambia)

**Medio (cambian 1-3×/año):**
- Margen mínimos por cuadrante (21-24, ya en DB)
- Política default por cuadrante (DB)
- Triggers de reclasificación (12-14)
- Forecast quality thresholds (13)

**Alta calibración (cambian mensualmente al inicio):**
- Markdown ladder (1-3)
- Subtipos REVISAR criterios + overrides (6-11)
- Cobertura mín postular (28-29)
- Targets por clase ABC (30-32)
- Cooldown (19-20)
- Descuentos máximos (33-34)
- Rampup matrix (12 celdas)

**Conteo de "alta calibración":** ~35 valores. Estos son los que se va a querer mover seguido durante los primeros 3 meses de operación viva.

---

## 17. Implicaciones para la decisión — alineamiento con manual

**Lo que dice `Engines_a_Escala`:**
- **Línea 5 (tesis):** *"rules engine custom en TypeScript + Postgres con JSONB validado por pg_jsonschema, **content-addressable rule sets para versioning**, y **append-only decision log estilo Modern Treasury**"*.
- **Línea 156:** columnas tipadas para lo que filtrás (priority, validez temporal, status, scope) + JSONB para AST de predicados, con `pg_jsonschema` CHECK.
- **Línea 180:** "Empieza custom TS" (vs Drools/Camunda/GoRules).
- **Líneas 182-205 (§3.4):** schema explícito:
  ```sql
  pricing_rule_sets (id, content_hash UNIQUE, parent_id, ...)
  pricing_rule_set_pointers (channel: production|canary|shadow, rule_set_id)
  ```
  Promote = update 1 row. Rollback = update al hash previo. Bucketing canary stable hashing.
- **Líneas 209-223 (§3.5):** `pricing_decision_log` append-only con `rule_set_hash REFERENCES pricing_rule_sets(content_hash)`.
- **Línea 543:** shadow mode 4 semanas → canary 5%→25%→100%.
- **Línea 596:** two-person rule para cambios en producción.

**Conclusión alineada al manual:** el camino prescrito NO es key/value plano. Es **rule sets content-addressable + decision log + shadow/canary** desde el inicio.

**Plan correcto (alineado a fuente):**
1. **Fase 1** — Migración SQL con las 3 tablas + `pg_jsonschema` CHECK al JSONB del rule. Cargar rule set v1.0.0 con los ~35 valores de alta calibración del §16.
2. **Fase 2** — Migrar lecturas: `markdown-auto`, `pricing.ts`, `triggers-reclasificacion` y demás endpoints leen del rule set activo del pointer `production`. Fallback al hardcoded si el rule set no carga.
3. **Fase 3** — Shadow mode + canary 5%→25%→100% con stable hashing.
4. **Fase 4** — UI admin para editar rule sets (publish nueva versión, ver diff, promote/rollback) — `pricing_cuadrante_config` actual queda como caso particular del modelo general, o se migra al rule set.

**Disonancia detectada:** una iteración previa de este documento recomendaba un atajo (tabla key/value sin versionar). Ese atajo se aparta del manual `Engines_a_Escala:5, 182-205`. Se descarta.

---

## 18. Pendientes detectados

1. **Governance 10/25/25%** del manual `Investigacion_Comparada:630` no está implementado. Solo existe el gate per-postulación de defender ≤10%. Falta: límite de cambios por SKU por ventana temporal (diaria, semanal, mensual).
2. **Triggers 1 y 3** (Buy Box drop, competidor agresivo) pendientes de data externa.
3. **Aging fix** (cutoff queryMovimientos 60→400d) ya commiteado pero **inerte hasta 2026-04-26 + 60d** (la tabla `movimientos` solo tiene data desde 2026-02-26). Alternativa: cambiar fuente de `dias_sin_movimiento` de `movimientos` a `ventas_ml_cache` para arreglar inmediatamente.

---

**Próximo paso si Vicente aprueba la recomendación pragmática:** crear migración SQL `vXX-pricing-global-config.sql` con esquema key/value para los 35 valores de alta calibración, mapear a la UI de admin, y documentar cuáles vienen de DB vs cuáles siguen hardcoded (los estables).
