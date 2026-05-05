---
sprint: 5.5.2
title: Revert filtros estado_sku='agotar' (motor viejo + cron policy)
date: 2026-05-04 PM
owner: Vicente Elías
tags: [batch:20260504-revert-agotar-filter] [reversal]
related:
  - docs/sprints/sprint-5.5.1-alineacion-agotar.md
  - docs/policies/estados-sku.md
  - docs/discovery/estados-y-flags-2026-05-04.md
  - supabase/migrations/20260504190000_revert_agotar_filter_sync_templates.sql
  - supabase/migrations/20260504190100_revert_agotar_comment_estado_sku.sql
---

# Sprint 5.5.2 — Revert filtros `agotar` (motor viejo + cron policy)

## Decisión owner (2026-05-04 PM)

**`estado_sku='agotar'` es SOLO un toggle de buffer Flex=0.**

NO debe:
- Bloquear recompra al proveedor.
- Excluir el SKU del motor de inteligencia (viejo o nuevo).
- Cambiar `accion`, `pedir_proveedor` u otros campos calculados.
- Sacarlo de `sku_node_policy`, `v_compras_pendientes` o `v_reposicion_explain`.

Sí debe (único efecto):
- Hacer que `/api/ml/stock-sync` y `/api/ml/activate-with-stock` publiquen el
  stock con `buffer = 0` en lugar de `2` (default) o `4` (sku_origen compartido).

## Contexto — por qué se revierte el cambio del mismo día AM

La sesión AM 2026-05-04 formalizó una doctrina más amplia:

- Cron `sync-from-templates` filtraba `WHERE estado_sku = 'activo' OR IS NULL`
  → excluía `agotar` de `sku_node_policy` (introducido en sprint 4.3a / sprint 2).
- Sprint 5.5.1 agregó PASO 10c en `intelligence.ts` que hacía
  `pedir_proveedor=0` y `accion=AGOTAR_NO_RECOMPRA` para SKUs `agotar`.

**Caso testigo que disparó la revisión** — `JSAFAB422P20S` (Trópico Rosa):

- 2026-04-28: owner emitió **OC-006 a Idetex** pidiendo más unidades del SKU.
- 2026-04-29: owner marcó `estado_sku='agotar'` desde UI.

**Intención real del owner**: "publicar todo el stock disponible sin buffer
mientras llega la OC. Seguir comprando, seguir vendiendo, seguir en motor."

**Comportamiento sistema (versión AM)**:
- Motor nuevo lo invisibilizaba (no aparecía en `v_compras_pendientes`).
- Motor viejo (post sprint 5.5.1) le ponía `pedir_proveedor=0` y
  `accion='AGOTAR_NO_RECOMPRA'` aunque hubiera demanda y proveedor con stock.

**Conclusión**: la doctrina amplia de `agotar` contradecía el caso de uso real.
Owner recategorizó: `agotar` ≠ "no recomprar". `agotar` = "publicar sin buffer".

Si en algún momento se quiere "no recomprar", existen mecanismos separados
(motor lo decide por celda CZ + `no_reorder`, o owner marca `descontinuado`).

## Cambios aplicados

### 1. `src/lib/intelligence.ts` — revert PASO 10c

- **Removido** PASO 10c (líneas 2060-2074 del sprint 5.5.1).
- **Removido** `AGOTAR_NO_RECOMPRA` y `DESCONTINUADO` del type `AccionIntel`
  (volvió a la lista pre-5.5.1).
- Resultado: motor viejo procesa SKUs `agotar` exactamente como `activo`
  para `pedir_proveedor` y `accion`. Sin override.

Diff neto vs. pre-sprint-5.5.1: cero (revert completo).

### 2. Migration `20260504190000` — revert filtro cron

`refresh_sku_node_policy_from_templates()` ahora usa:

```sql
WHERE estado_sku IS DISTINCT FROM 'descontinuado'
```

en lugar de:

```sql
WHERE estado_sku = 'activo' OR estado_sku IS NULL
```

Resultado: incluye `agotar` (y cualquier valor futuro distinto de
`descontinuado`) en el refresh de `sku_node_policy`. Solo `descontinuado`
sigue excluido (su doctrina sigue intacta: fuera de catálogo).

Backfill inmediato corrido en la migration. Validación post-deploy:
- 22 SKUs `agotar` ahora con fila en `sku_node_policy` (antes 0).
- 0 SKUs `descontinuado` con fila (invariante mantenido).

### 3. Migration `20260504190100` — revert COMMENT ON COLUMN

Reescribe el COMMENT de `productos.estado_sku` para reflejar la nueva doctrina
(buffer Flex=0 únicamente, no afecta motor ni recompra).

### 4. `docs/policies/estados-sku.md` — reescritura

- Tabla de comportamiento actualizada: `agotar` ahora es "calcula normal" en
  todos los componentes excepto `/api/ml/stock-sync` (buffer=0).
- Sección "Por qué se revirtió" agregada explicando el caso JSAFAB422P20S.
- Mental model corto al frente: "agotar es SOLO el toggle de buffer Flex".
- Casos límite re-redactados.

## Validación post-deploy

```sql
-- Pre-revert: 22 agotar SKUs, 0 con policy
-- Post-revert: 22 agotar SKUs, 22 con policy ✓
SELECT 
  COUNT(*) FILTER (WHERE p.estado_sku = 'agotar') AS agotar_total,
  COUNT(DISTINCT snp.sku_origen) FILTER (WHERE p.estado_sku = 'agotar') AS in_policy
FROM productos p
LEFT JOIN sku_node_policy snp ON snp.sku_origen = p.sku;
```

Próximo cron `recalcular-todo` (motor viejo): los 22 SKUs `agotar` recuperan
su `pedir_proveedor` natural calculado por velocidad/cobertura/quiebre.
Próximo cron `sync-from-templates` (ya disparado en la migration): no-op
(idempotente, las 22 filas ya están).

## Lo que NO cambia

- `/api/ml/stock-sync` y `/api/ml/activate-with-stock`: siguen aplicando
  `buffer=0` para `agotar`. **Único efecto real del flag**.
- UI panel inventario: 3 botones radio + bulk + badges siguen iguales.
- audit_log: cero cambios al contrato.
- `descontinuado`: doctrina intacta (fuera de catálogo, sin policy, sin
  pricing, no se publica). Cron sigue excluyéndolo.
- `INTEL_USE_NEW_ENGINE` flag: sin cambios.

## Reversibilidad

Si en el futuro la doctrina vuelve a ser "agotar bloquea compras":

1. Re-aplicar el bloque PASO 10c en `intelligence.ts` (16 LOC).
2. Re-aplicar el filtro `estado_sku='activo' OR IS NULL` en
   `refresh_sku_node_policy_from_templates`.
3. Migrar el COMMENT al texto previo.

Sin tag `[non-reversible]` esta vez — el revert es de un cambio reciente y
todo se puede rehacer en otra dirección.

## Archivos tocados

- `src/lib/intelligence.ts` — revert (-18 LOC).
- `supabase/migrations/20260504190000_revert_agotar_filter_sync_templates.sql` — cron RPC.
- `supabase/migrations/20260504190100_revert_agotar_comment_estado_sku.sql` — comment.
- `docs/policies/estados-sku.md` — reescritura.
- `docs/sprints/sprint-5.5.2-revert-agotar-filter.md` — este doc.

---

## Adendum 2026-05-04 PM (post Sprint 5.5.4)

La corrección AM dejó intacta una copia espejo del mismo filtro en la vista
`v_trend_detection`. Resultado: los 22 SKUs `agotar` reincorporados a
`sku_node_policy` esta mañana quedaron con `tendencia/cell_efectiva = NULL`
hasta que el cron diario los marcase `'insuficiente_data'` (mentira) mañana
12:00 UTC.

Detectado por discovery operativo (motor viejo vs motor nuevo) y completado
en Sprint 5.5.4 (`docs/sprints/sprint-5.5.4-revert-trend-agotar.md`) el mismo
día PM aplicando Regla 2 inventory-policy.

Sprint 5.5.5 cerró el barrido completo: 4 sub-sprints completaron el revert:

| Sprint | Hora | Superficie |
|---|---|---|
| 5.5.2 | AM | `refresh_sku_node_policy_from_templates()` |
| 5.5.4 | PM | `v_trend_detection` |
| 5.5.5 | PM | `v_safety_stock` (CTE supplier_lt) |
| ✓ | PM | Auditoría grep + Postgres prod confirmó 0 ocurrencias remanentes |

Impacto neto del barrido:
- 22 SKUs `agotar` reincorporados a `sku_node_policy` con tendencia/cell_efectiva.
- LT real del proveedor (5d) en lugar de default (14d) → -23 unidades en cola
  de OC (de 179 a 156 totales para los 22 agotar).

**Lección**: cuando se revierte un filtro de tabla, hacer grep de
`pg_get_viewdef` por la misma firma `estado_sku = 'activo' OR IS NULL` ANTES
de cerrar el sprint padre. En este caso el filtro estaba en 4 superficies y
solo se detectaron las 3 restantes por discovery operativo posterior. La
lección queda documentada en sprint 5.5.5 con regla canónica de filtro
(`IS DISTINCT FROM 'descontinuado'`) y recomendación de lint CI.

---

*Sprint ejecutado por Claude Opus 4.7 (1M context) el 2026-05-04 PM bajo
`feedback_banvabodega_autonomy`. Revierte sprint 5.5.1 mismo día AM por
clarificación owner sobre la semántica de `agotar`. Adendum agregado tras
Sprint 5.5.4 mismo día PM.*
