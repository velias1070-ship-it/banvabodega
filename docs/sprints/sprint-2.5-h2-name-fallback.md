# Sprint 2.5 — Hot fix mitigación H2 vía name fallback

**Owner:** Vicente Elías
**Fecha:** 2026-05-02
**Branch:** `sprint-2.5-h2-name-fallback`
**Tag:** `[batch:20260503-2]`
**Migración:** `supabase/migrations/20260503130000_sprint25_h2_name_fallback.sql`
**Tests:** `tests/sprint25_validation.sql` (8/8 PASS)
**Decisión activada:** H2 (xyz status quo + flag confidence estacional) — Camino C híbrido

## Contexto

El audit post-Sprint 2 detectó **13 SKUs estacionales en celdas activas Y/Z sin
flag `low_confidence_seasonal`**:

- 6 plumones (`textil-infantil`, `textil` u `otros`)
- 5 mantas (escondidas en `textil`)
- 1 frazada (escondida en `textil`)
- 1 quilt residual

Causa raíz: `productos.categoria` está agregada en 5 buckets (`textil=215`,
`otros=97`, `textil-infantil=29`, `quilt=N`, `alfombras=N`). Plumones, mantas y
frazadas adultas viven dentro de `textil`/`otros`, por lo que la regla 1 de
`calc_sku_node_policy_row` (`seasonal_categories` × `productos.categoria`) los
deja fuera del flag aún siendo estacionales obvios.

Sin esta mitigación, el agente Reposición v2 (Sprint 4) recomendaría buffer
lean (z=1.28) para 13 SKUs durante peak estacional Chile (mayo-julio), con
impacto material en quiebres frente a temporada.

## Decisión: Camino C híbrido

Se evaluaron 4 opciones:

| Camino | Descripción | Trade-off |
|---|---|---|
| A | Solo regex sobre `productos.nombre` | Frágil a typos |
| B | Columna `productos.sub_categoria` poblada manualmente | Trabajo manual + mantenimiento |
| C | **Híbrido**: mantener regla 1 (categoría) + agregar regla 2 (nombre con word boundaries) | Cobertura máxima sin trabajo manual |
| D | No hacer nada | 13 SKUs ciegos durante peak |

**Owner eligió C** (Camino híbrido). Mantiene infraestructura existente
(`seasonal_categories`) y agrega regex conservador como fallback.

## Cambios

### 1. Schema: nueva columna `seasonal_match_source`

```sql
ALTER TABLE sku_node_policy ADD COLUMN seasonal_match_source text;
ALTER TABLE sku_node_policy ADD CONSTRAINT sku_node_policy_seasonal_match_source_check
  CHECK (seasonal_match_source IS NULL
         OR seasonal_match_source IN ('category','name_pattern','manual','none'));
```

Permite rastrear cobertura de cada heurística por separado para futuros
audits (¿qué % matchea por categoría vs nombre? ¿drift de la regex?).

### 2. Función: regla 6b en `calc_sku_node_policy_row`

Patrón regex POSIX case-insensitive con word boundaries (`\m`, `\M`):

```sql
v_match_name := v_nombre ~* '\m(plumon|plumón|frazada|frazadas|manta|mantas|s[aá]bana\s+t[eé]rmica)\M';
```

Términos elegidos por ser **inequívocos** en el catálogo BANVA:

- `plumon`/`plumón` — siempre estacional invierno
- `frazada`/`frazadas` — siempre estacional invierno
- `manta`/`mantas` — estacional invierno (excluye `mantel` por word boundary natural — `\M` rompe entre `manta` y `mantel`)
- `sabana termica`/`sábana térmica` — estacional invierno (sábanas comunes NO son estacionales por sí mismas)

Prioridad de attribution: `category > name_pattern > none`. Si un SKU matchea
por ambas, gana `category` (más estable, declarativo).

### 3. Refresh: incluye nueva columna

`refresh_sku_node_policy_from_templates()` recompila INSERT/UPDATE para
propagar `seasonal_match_source` por upsert. `manual_override=true` sigue
preservado.

## Resultados post-deploy

```
Distribución seasonal_match_source (974 filas total):
  category:     198
  name_pattern:  28
  none:         748
  null:           0
```

- **24 nuevas filas** (12 SKUs × 2 nodos) flagged `low_confidence_seasonal` por `name_pattern`:
  - **6 plumones infantiles**: Babsy, Boy, Girl, Galaxy, Jungle, Starfish
  - **5 mantas Flannel Illusions**: Arena, Celeste, Gris, Olivo, Rosa
  - **1 frazada saquito bebé**
- **4 filas en cell AX por name_pattern** mantienen `xyz_confidence='high'` y `z=2.05` por
  ser alta demanda predecible — consistente con H2: el flag conservador solo aplica si
  además XYZ ∈ {Y,Z}.
- 13/13 SKUs identificados en audit ahora cubiertos.

## Tests (8/8 PASS)

| # | Check | Resultado |
|---|---|---|
| T01 | columna `seasonal_match_source` existe | PASS |
| T02 | plumones Y/Z active flagged | PASS (12) |
| T03 | mantas Y/Z active flagged | PASS (10) |
| T04 | frazadas Y/Z active flagged | PASS (2) |
| T05 | name_pattern + low_confidence ⇒ z=1.88 | PASS (24) |
| T06 | manteles NO falsamente flagged | PASS |
| T07 | distribución `seasonal_match_source` | category=198 name_pattern=28 none=748 |
| T08 | idempotencia (hash equal post-refresh) | PASS |

## Frontera Reposición/Pricing

Sin cambios. El flag `low_confidence_seasonal` y el `z_value` derivado siguen
viviendo del lado **Reposición** (z + target_dias_full + buffer). Pricing ML
no consume `seasonal_match_source`. Compatible con la división lógica del
Sprint 1 (`docs/policies/frontera-reposicion-pricing.md`).

## Decisión arquitectónica futura

Este hot fix es **mitigación temporal hasta Sprint 7+** que introducirá
`v_cv_52sem` (CV deseasonalizado por descomposición de tendencia y
estacionalidad). El CV deseasonalizado permitirá recategorizar XYZ con la
volatilidad **residual** (no la estacional), eliminando el sesgo que hoy mete
plumones en Y/Z.

Cuando ese cambio aterrice, evaluar:

1. ¿`seasonal_match_source` sigue agregando valor o el CV deseasonalizado lo absorbe?
2. ¿La regla 6b se vuelve obsoleta o sigue como guard-rail?
3. ¿`seasonal_categories` se reduce a casos edge?

## Coordinación con sesión paralela

Sin conflicto: Sprint 2.5 toca `sku_node_policy` y `calc_sku_node_policy_row`.
La sesión paralela (pricing) no toca esa tabla ni función. Numeración de
migraciones independiente (`20260503130000` vs track ads v80+).

## Referencias

- Audit data en historial de la conversación (sesión 2026-05-02).
- Sprint 2 baseline: `docs/sprints/sprint-2-populate-policy.md`.
- Frontera lógica: `docs/policies/frontera-reposicion-pricing.md`.
- H2 decisión: `docs/inventory/decisiones-cerradas.md` (si existe) o conversación owner.
