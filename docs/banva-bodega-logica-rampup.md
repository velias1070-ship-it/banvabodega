# Lógica post-quiebre: velPre histórica + enQuiebreProlongado + rampup

Este documento describe la pipeline de reposición post-quiebre en `src/lib/intelligence.ts`, en el orden en que el motor la aplica. Referencias a fuentes:

- **Manual Inventarios Parte 1 §1.1** — buffer de capacidad (test-and-learn Zara).
- **Manual Parte 1 §2.4** — ESTRELLA nunca sin stock, alerta temprana.
- **Manual Parte 2 §7.4** — penalización ranking ML post-quiebre.
- **Manual Parte 3 Error #5** — ranking ML se degrada durante quiebre de proveedor.
- **Guía Completa §Patologías** — "quiebre crónico de A's: reconstruir vel histórica, no usar velPonderada instantánea".

---

## 1. `velPreQuiebre` — velocidad histórica

**Problema resuelto.** Antes: `velPreQuiebre = velPonderada` al entrar en quiebre. Capturaba la velocidad *del instante*, que para un SKU ya sin stock está aplastada. Los SKUs con historia real de ventas (ej. TEXCCWTILL10P vendía ~20 u/sem antes del quiebre) quedaban con `vel_pre` artificialmente bajo y el motor pedía poco.

**Fix.** `velPreQuiebre = max(vel60d, velPonderada)`:

- `vel60d` ya excluye semanas en quiebre (`semanasActivas60d`, línea 737 del motor). Representa la demanda real pre-quiebre.
- `velPonderada` se mantiene como fallback para SKUs sin 60 días de historia (nuevos).
- En rama "continúa en quiebre": además `Math.max(velHistorica, prev.vel_pre_quiebre)` para recuperar SKUs con valor bajo persistido de corridas previas.

Implementación: `src/lib/intelligence.ts` paso 14b líneas ~969–1000.

---

## 2. `esQuiebreProlongadoProtegido(r)` — 3 ramas OR

Determina si el motor debe dimensionar `pedir_proveedor` usando `vel_pre_quiebre` (no la velocidad actual aplastada).

**Rama 1 — Zara genérica.**
`dias_en_quiebre >= 14 && vel_pre > 2 && vel_ponderada > 0`
Caso estándar: el SKU lleva al menos 2 semanas en quiebre y tenía demanda histórica robusta.

**Rama 2 — protección ESTRELLA / CASHCOW.**
`dias_en_quiebre >= 7 && cuadrante IN (ESTRELLA, CASHCOW) && vel_pre > vel_act × 2`
SKUs de alto margen que el quiebre está aplastando: basta 7 días para proteger si la velocidad cayó a la mitad. Alerta temprana (Manual Parte 1 §2.4).

**Rama 3 — quiebre de proveedor.**
`es_quiebre_proveedor === true && vel_pre > vel_act × 2`
Sin umbral de días: si la caída de velocidad viene del proveedor y no del producto, reponer sin esperar. Cubre ranking ML degradado (Manual Parte 3 Error #5).

**Preconds comunes:** `stock_full === 0` (agotado real) y `vel_pre_quiebre > 0`.

Implementación: `src/lib/intelligence.ts` función `esQuiebreProlongadoProtegido(r)` al inicio del módulo. Se usa en los recálculos de `pedir_proveedor` (post-ABC) y en la dedup de alts.

**Nota de orden:** Paso 11 (cuadrante) se movió antes del recálculo de pedir para que `r.cuadrante` esté disponible al evaluar la rama 2.

---

## 3. Factor `rampup` — matriz post-quiebre

Aplicado sobre `pedir_proveedor` *después* del cálculo del motor. Objetivo: test-and-learn estilo Zara — no pedir al target completo cuando el SKU viene de quiebre hasta validar la demanda.

**Matriz (`src/lib/rampup.ts`):**

| días en quiebre | quiebre propio | quiebre proveedor |
|---|---|---|
| `null` / 0 | 1.00 no_aplica | 1.00 no_aplica |
| 1–14 | 1.00 fresco | 1.00 fresco |
| 15–30 | **0.50** zara | 1.00 fresco |
| 31–60 | 0.50 zara | **0.75** medio |
| 61–120 | **0.30** reactivar | 0.75 medio |
| 121–365 | **0.00** discontinuar | **0.50** relanzar |

- **Quiebre propio** = el motor no detecta agotamiento del proveedor, la falla es interna (ej. plan de reposición).
- **Quiebre de proveedor** = `es_quiebre_proveedor === true` (catálogo marca stock 0 o producto en estado sin_stock_proveedor). Menos castigo porque no es culpa del SKU.
- `no_aplica` (factor 1.0) — SKU sin días en quiebre o historia incompleta (`dias_en_quiebre = null`).

**Columnas persistidas en `sku_intelligence`:**

- `factor_rampup_aplicado NUMERIC(3,2)` — el factor efectivamente aplicado.
- `pedir_proveedor_sin_rampup INTEGER` — cantidad del motor ANTES del ajuste (para auditoría).
- `rampup_motivo TEXT` — texto legible del camino de la matriz.

**Cálculo final:** `pedir_proveedor = round(pedir_proveedor_sin_rampup × factor_rampup_aplicado)`.

---

## 4. `dias_en_quiebre` — cálculo calendario saneado

**Problema resuelto.** Antes: `diasEnQuiebre = COUNT(*)` de filas en `stock_snapshots.en_quiebre_full=true`. Los SKUs con historia larga sacaban COUNT de 3.000–6.900 filas.

**Fix.** Días calendario desde el primer snapshot válido:

```ts
const fechasQuiebreValidas = quiebresDelSku
  .filter(q => q.en_quiebre_full && q.fecha)
  .map(q => new Date(q.fecha))
  .filter(d => d.getFullYear() >= 2020) // guard contra epoch/datos corruptos
  .sort((a, b) => a.getTime() - b.getTime());
const primerQuiebre = fechasQuiebreValidas[0] ?? null;
const diasQuiebre = primerQuiebre
  ? Math.min(365, Math.floor((hoyMs - primerQuiebre.getTime()) / 86400000))
  : 0;
```

- Cap a **365 días**: valores mayores → `null` (historia incompleta).
- Guard `>= 2020`: evita snapshots corruptos con año 2007 o anteriores.
- Si no hay snapshot válido, `diasEnQuiebre = null`.

**Migración SQL aplicada** (`rampup_dias_en_quiebre_fix_20260416`):
- Backup `_backup_sku_intelligence_dias_quiebre_20260416`.
- `UPDATE sku_intelligence SET dias_en_quiebre = NULL WHERE dias_en_quiebre > 365 OR < 0`.
- `ALTER TABLE ADD COLUMN factor_rampup_aplicado / pedir_proveedor_sin_rampup / rampup_motivo`.

---

## 5. Consumidores de `dias_en_quiebre`

NULL-safe. Comportamiento con `null`:

| Consumidor | Archivo:Línea | Comportamiento NULL |
|---|---|---|
| `enQuiebreProlongado` flag (paso 14b) | intelligence.ts:977 | `(diasEnQuiebre ?? 0) >= 14` → false (sin protección Zara clásica) |
| `esQuiebreProlongadoProtegido` | intelligence.ts (helper) | `(r.dias_en_quiebre ?? 0) >= 14` → false; rama 3 (proveedor) puede disparar igual |
| `calcularFactorRampup` | rampup.ts | null → factor 1.0, motivo `no_aplica` |
| `diasEfectivos` oportunidad perdida | intelligence.ts:958 | `Math.max(diasQuiebre, diasEnQuiebre ?? 0)` |
| Imputaciones ingreso/margen/uds 30d | intelligence.ts:1243+ | `(r.dias_en_quiebre ?? 0) >= 14` → no imputa |
| Render UI "Estrellas en quiebre" | AdminInteligencia.tsx:1532 | `dias_en_quiebre !== null ? Xd : "—"` con tooltip "Historia incompleta" |

**Regla 90 días / liquidación:** usa `dio - target_dias_full`, **NO** `dias_en_quiebre`. Independiente del fix.

---

## 6. Ejemplos concretos

### TXSB144IRK10P — Sábana Rocket Infantil 10P (A / ESTRELLA)

- Historia 30–120d pre-quiebre: **43 uds / 90 días** ≈ 3.3 u/sem.
- Quiebre actual: 55 días, prov_ag=true.

**Cálculo:**
1. `velPonderada = 1.80 u/sem` (aplastada por quiebre).
2. `vel60d = 3.34` (excluye semanas en quiebre).
3. `velPreQuiebre = max(3.34, 1.80) = 4.11` (viene de `vel60d` más ajuste por prev).
4. `esQuiebreProlongadoProtegido` → rama 2 (ESTRELLA + d_q≥7 + velPre 4.11 > 1.8×2=3.6) → **true**.
5. Motor pide con `velPre=4.11` sobre target_dias_A=42 → **25 uds**.
6. Rampup `quiebre_proveedor_medio_ranking_ml_degradado` (d_q=55, prov_ag, 31-120) → factor 0.75 → **final 19 uds**.

**Sin el fix del bloque 5** habría pedido 8 uds (`velPre=1.80` aplastado).

### TEXCCWTILL10P — Cubrecolchón Illusions Waterproof 10P (B / REVISAR)

- Historia 30–120d: **254 uds** ≈ 19.8 u/sem.
- Quiebre actual: 49 días, prov_ag=true.

**Cálculo:**
1. `velPonderada = 6.18`, `vel60d ≈ 25`, `velPreQuiebre = 24.89`.
2. `esQuiebreProlongadoProtegido`:
   - Rama 1 (Zara genérica): d_q=49 ≥ 14 ✓, velPre=24.89 > 2 ✓, velAct > 0 ✓ → **true**.
   - Rama 2 **NO** aplicaría (es REVISAR, no ESTRELLA/CASHCOW) — **intencional**: el cuadrante REVISAR no recibe protección temprana, debe esperar al umbral Zara de 14 días.
   - Rama 3 aplicaría (prov_ag + velPre > velAct×2) → **true** independientemente.
3. Motor usa `velPre=24.89` → pide **100 uds**.
4. Rampup `quiebre_proveedor_medio` (d_q=49, prov_ag, 31-120) → 0.75 → **final 75 uds**.

**Sin el fix del bloque 5** habría pedido 19 uds (`velPre=6.18` aplastado).

### Por qué REVISAR SÍ se beneficia del fix velPre pero NO de la rama 2

- El fix de `velPre` (bloque 5) es **universal**: cualquier SKU con historia limpia (`vel60d > velPonderada`) se beneficia, porque el motor siempre usa `velPre` cuando `esQuiebreProlongado` dispara.
- La rama 2 de `esQuiebreProlongadoProtegido` es **selectiva**: solo acorta el umbral de días (de 14 a 7) para ESTRELLA/CASHCOW, que son los que tienen prioridad estratégica.
- Un REVISAR con 8 días de quiebre y vel_pre alto **no dispara rama 2 ni rama 1** (d_q < 14). Pero sí dispararía rama 3 si hay quiebre de proveedor con caída de velocidad.

---

## 7. Validación post-deploy (2026-04-16)

Recalc sobre 431 SKUs en prod tras PRs #261, #262, #263:

- 0 SKUs con `dias_en_quiebre > 365`.
- Distribución poblada en buckets intermedios (15-30, 31-60, 61-120, 121-365).
- 39 SKUs con `factor_rampup_aplicado != 1.0` (ajuste real vs default).
- Motor total 1233 uds → final 1044 uds (ahorro rampup **189 uds = 15.3%**).
- 5 SKUs ejemplo ESTRELLA/CASHCOW pasaron de velPre=velAct a velPre=2-4× velAct; pedidos subieron 2-4×.

---

## 8. Rollback

- Código: `git revert <sha>` + redeploy (PRs #261, #262, #263 squash).
- Datos: `UPDATE sku_intelligence SET dias_en_quiebre = b.dias_en_quiebre FROM _backup_sku_intelligence_dias_quiebre_20260416 b WHERE sku_intelligence.sku_origen = b.sku_origen;`.
- Columnas nuevas (`factor_rampup_aplicado`, `pedir_proveedor_sin_rampup`, `rampup_motivo`) se pueden dejar en la tabla; no rompen lógica vieja (defaults 1.0/0/no_aplica).
