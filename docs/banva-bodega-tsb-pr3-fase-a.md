# PR3 Fase A — TSB shadow mode

Fecha: 2026-04-17. Sobre `af1dcbf` (PR2). **Migración no aplicada** — aplicar post-merge.

## Qué hace

El motor ahora corre TSB (Teunter-Syntetos-Babai) en paralelo al SMA ponderado y persiste el resultado en `sku_intelligence.vel_ponderada_tsb`. **No se consume para ninguna decisión.** Fase B compara TSB vs SMA sobre datos reales; Fase C decide si activar.

## Decisión sobre `primera_venta`

**Columna dedicada** en `sku_intelligence` (tu voto y el mío). Computada desde `queryPrimeraVentaPorSkuOrigen()` (nueva, en `intelligence-queries.ts`): `MIN(fecha_date)` de `ventas_ml_cache` expandido a `sku_origen` vía `composicion_venta`. Una query al arranque de `recalcularTodo`, ~100 ms.

## Política de selección de modelo (`seleccionarModeloZ`)

| Caso | Modelo |
|---|---|
| `xyz !== 'Z'` | `sma_ponderado` |
| `primera_venta IS NULL` | `sma_ponderado` (fallback seguro) |
| `xyz='Z' && días desde primera venta < 60` | `sma_ponderado` (puerta anti-ramp-up) |
| `xyz='Z' && ≥ 60 días` | **`tsb`** |

No hay 3 modelos simultáneos — sólo SMA o TSB.

## Archivos

| Archivo | LOC | Estado |
|---|---:|---|
| `supabase-v53-tsb.sql` | 20 | nuevo, **no aplicado** |
| `src/lib/tsb.ts` | 160 | nuevo (módulo puro) |
| `src/lib/__tests__/tsb.test.ts` | 160 | nuevo (14 tests verdes) |
| `src/lib/intelligence.ts` | +70 | SkuIntelRow +6 campos, Paso 10b nuevo, rowToUpsert +6 |
| `src/lib/intelligence-queries.ts` | +50 | `queryPrimeraVentaPorSkuOrigen` |
| `src/app/api/intelligence/recalcular/route.ts` | +20 | fetch + input + upsert propagados |
| `scripts/sanity-tsb.ts` | 150 | nuevo (offline, sin tocar DB) |
| `docs/banva-bodega-tsb-pr3-fase-a.md` | este | nuevo |

## Comando de aplicación

```
mcp__supabase__apply_migration name="v53_tsb" query="$(cat ~/banvabodega/supabase-v53-tsb.sql)"
```

O copy-paste en el SQL Editor:

```sql
ALTER TABLE sku_intelligence
  ADD COLUMN IF NOT EXISTS vel_ponderada_tsb      numeric NULL,
  ADD COLUMN IF NOT EXISTS tsb_alpha              numeric NULL,
  ADD COLUMN IF NOT EXISTS tsb_beta               numeric NULL,
  ADD COLUMN IF NOT EXISTS tsb_modelo_usado       text    NULL CHECK (tsb_modelo_usado IN ('sma_ponderado','tsb')),
  ADD COLUMN IF NOT EXISTS primera_venta          date    NULL,
  ADD COLUMN IF NOT EXISTS dias_desde_primera_venta int   NULL;

CREATE INDEX IF NOT EXISTS idx_sku_intel_tsb_modelo
  ON sku_intelligence(tsb_modelo_usado)
  WHERE tsb_modelo_usado IS NOT NULL;
```

## Sanity check offline (sin tocar DB)

`scripts/sanity-tsb.ts` ejecuta la misma lógica que correría el motor, sobre los 163 SKUs Z con vel>0:

```
Régimen:
  sma_ponderado : 74  (bajo puerta 60d o sin primera_venta)
  tsb           : 89  (maduros)

Distribución |delta TSB vs SMA|:
  |δ| ≤ 5%       20 SKUs
  5-20%          18 SKUs
  20-50%         25 SKUs
  50-100%        20 SKUs
  > 100%          6 SKUs

Total con |δ| > 20%: 51 / 89 (57%)
```

**Lectura:** 22% de los Z maduros tienen TSB casi idéntico al SMA. El 57% que difiere >20 % es el universo real donde Fase B va a discriminar si TSB acierta mejor. Ninguno de los Top 5 es ESTRELLA/CASHCOW — todos REVISAR C con SMA muy bajo (~0-0.8 uds/sem) donde TSB agresivamente sube (+157 % a +336 %). Caso de manual: si el SKU realmente tiene esos z/p, TSB tiene razón; si es ruido, SMA. Fase B lo resuelve.

### Top 5 diferencia TSB vs SMA (Z maduros)

| SKU | Cuadr. | ABC | SMA | TSB | Δ% | z | p |
|---|---|---|---:|---:|---:|---:|---:|
| TXTLLPY1018PA (Toalla Playa) | REVISAR | C | 0.12 | 0.52 | +336% | 2.20 | 0.24 |
| TXPMMF15PGLXY (Plumón Galaxy) | REVISAR | C | 0.02 | 0.08 | +289% | 4.00 | 0.02 |
| TXSC2PVLGRAFT (Cortinas Velo) | REVISAR | C | 0.80 | 2.39 | +199% | 6.05 | 0.40 |
| TXV24QLBRCN20 (Quilt Bruselas) | REVISAR | C | 0.12 | 0.32 | +167% | 1.00 | 0.32 |
| 9788471510211 (Biblia del Niño) | REVISAR | C | 0.34 | 0.87 | +157% | 2.60 | 0.34 |

## Runtime / overhead

Medido offline: 163 SKUs evaluados en ~1.5 s (incluye queries Supabase). Sólo los 89 corren TSB con grid search (α,β ∈ {0.1,0.2,0.3,0.4} × 4 × 4 = 16 corridas walk-forward por SKU) → **~5–8 ms por SKU** en el grid search. Para el motor completo con 533 SKUs, de los cuales ~89 hacen TSB, overhead estimado: **+0.5 s sobre ~9 s** (+5-6 %). Coherente con la pre-auditoría §3.

El sanity check "in-DB" (162 SKUs Z con `vel_ponderada_tsb` persistido tras recálculo) requiere aplicar v53 primero.

## Tests

| Archivo | Tests | Estado |
|---|---:|---|
| `src/lib/__tests__/tsb.test.ts` | 14 | verde |
| `src/lib/__tests__/forecast-accuracy.test.ts` | 13 | verde |
| `src/lib/__tests__/reposicion.test.ts` | 40 | verde |
| **Total** | **67** | **67/67** |

Los tests TSB cubren: intermitente clásica, decaimiento/obsolescencia, ramp-up, todos ceros, <8 semanas (NULL), exactamente 8 semanas, auto-calibración, α/β custom, puerta bajo 60d, Z maduro, X/Y sin tocar edad, primera_venta null/string/inválida.

## Criterios de activación para Fase C (documentados por adelantado)

Cuando haya ≥ 4 lunes reales de datos post-PR2 (≈ 2026-05-18) y se corra `benchmark-tsb.ts` (Fase B), TSB se activa **por default para Z maduro** sólo si se cumplen **las 3 condiciones** siguientes:

1. **Mejora WMAPE mediano ≥ 15 % absoluto** sobre los 162 SKUs Z con vel>0. Ej.: si SMA WMAPE mediana = 95 %, TSB debe ser ≤ 80 %.
2. **Cero regresión en ESTRELLA / CASHCOW clasificados como Z.** Si alguno empeora (WMAPE_TSB > WMAPE_SMA), TSB no se activa por default.
3. **Sin bias negativo sistemático.** Bias mediano de TSB en ventana 8 s no puede ser < −20 % de `vel_ponderada` (indicaría que TSB sobreestima obsolescencia).

Los 3 criterios van duramente codificados en `scripts/benchmark-tsb.ts` (Fase B, próxima semana) para que el output del benchmark diga "pasa / no pasa" sin ambigüedad interpretativa.

**Si falla alguno**: TSB queda como columna informativa (shadow permanente). Iteramos parámetros o descartamos. La UI de Fase C puede mostrar la comparación sin activar el modelo.

## Qué NO tocó esta fase

- UI — no hay tab ni columna nueva en AdminInteligencia (viene en Fase C)
- Alertas — cero alertas TSB (vienen en Fase C si el modelo pasa)
- `vel_ponderada`, `accion`, `pedir_proveedor`, `mandar_full` siguen intocados
- Safety stock específico por Z (tu hallazgo §6 de la pre-auditoría: impacto marginal)

## Próximo paso (Fase B — próxima semana)

`scripts/benchmark-tsb.ts`: recalcula TSB retroactivo sobre los 4 lunes evaluables (2026-03-09, 03-16, 03-23, 03-30) usando ventas hasta cada lunes y actuales = semana siguiente. Compara WMAPE/bias/TS TSB vs SMA ya persistido. Output: tabla con veredicto de los 3 criterios. Decisión Fase C depende del output.
