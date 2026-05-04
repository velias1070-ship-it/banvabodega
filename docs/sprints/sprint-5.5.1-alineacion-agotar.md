---
sprint: 5.5.1
title: Alineación motor viejo a doctrina 'agotar' / 'descontinuado'
date: 2026-05-04
owner: Vicente Elías
tags: [batch:20260504-alineacion-agotar] [non-reversible:filter-agotar-motor-viejo]
related:
  - docs/policies/estados-sku.md
  - docs/discovery/estado-sku-agotar-2026-05-04.md
  - supabase/migrations/20260504181500_doc_agotar_comment_estado_sku.sql
---

# Sprint 5.5.1 — Alineación motor viejo a doctrina 'agotar'

## Problema

`docs/policies/estados-sku.md` (formalizada hoy 2026-05-04) declara que un SKU
con `estado_sku = 'agotar'` **no debe sugerir compra al proveedor**. La idea es
"vender lo que queda al máximo, no recomprar".

El **motor nuevo** ya lo respeta vía cron `sync-from-templates`, que filtra
`WHERE estado_sku = 'activo' OR estado_sku IS NULL` antes de generar policy.
Sin policy, el SKU desaparece de `v_compras_pendientes` y `v_reposicion_explain`.

El **motor viejo** (`src/lib/intelligence.ts`) NO filtra por `agotar`. Solo
excluye `descontinuado` (línea 797). Resultado: `sku_intelligence.pedir_proveedor`
sigue calculándose para SKUs `agotar`, generando falsa señal "necesita pedir N uds"
en pantallas que leen el cache viejo.

**Caso testigo**: `JSAFAB422P20S` (Trópico Rosa) marcado `agotar` el 2026-04-29
con OC-006 emitida 1 día antes (último lote intencional). Motor viejo seguía
diciendo `pedir_proveedor=14` aunque la doctrina dice "no recomprar".

Distribución 2026-05-04: **22 SKUs agotar**, 19 actualizados últ 30d → flag
operativamente vivo.

## Decisión

**Alinear el motor viejo a la doctrina** agregando un override post-rampup
que setea `pedir_proveedor = 0` y `accion = 'AGOTAR_NO_RECOMPRA' | 'DESCONTINUADO'`
cuando `estado_sku in ('agotar', 'descontinuado')`.

Razones para hacerlo en el motor viejo en lugar de esperar deprecación:

1. Motor viejo todavía alimenta `sku_intelligence` que mucho UI lee.
2. La doctrina ya está formalizada y vinculante (per `feedback_disonancia_policy_vs_manual`).
3. Cambio quirúrgico (16 LOC), idempotente, post-rampup → no rompe cálculos previos.
4. Motor nuevo y viejo quedan alineados → cero divergencia en pantallas.

Razones para NO hacerlo en el filtro de entrada (línea 797 `descontinuado`):

- El filtro de entrada excluye al SKU del motor entero (no se calcula velocidad,
  cobertura, ROP, ABC). Para `agotar` queremos seguir calculando todo eso (sirve
  para reportería y monitoreo) — solo no queremos sugerir comprar.

## Cambio aplicado

### `src/lib/intelligence.ts`

1. Type `AccionIntel` extendido con 2 valores nuevos:
   - `AGOTAR_NO_RECOMPRA`
   - `DESCONTINUADO`

2. Nuevo `PASO 10c` post-rampup (después de PASO 10b, antes de tracking de
   quiebre Flex). 16 LOC. Itera sobre `rows`, lee `prodMap.get(sku).estado_sku`,
   y si vale `'agotar'` o `'descontinuado'`:
   - `pedir_proveedor = 0`
   - `pedir_proveedor_bultos = 0`
   - `pedir_proveedor_sin_rampup = 0`
   - `accion = 'AGOTAR_NO_RECOMPRA' | 'DESCONTINUADO'`

   Idempotente: correr 2× = mismo resultado.

## Lo que NO cambia

- `estado_sku = NULL` o `'activo'`: sin tocar (414 + 73 SKUs respectivamente).
- Velocidad, cobertura, ROP, ABC, forecast: siguen calculándose para `agotar`
  (útiles para reportería).
- Tracking de quiebre Flex: sigue corriendo (PASO post 10c).
- Cache `sku_intelligence`: se actualiza igual, solo `pedir_proveedor` y `accion`
  reflejan ahora la doctrina.
- Pricing: ortogonal a `estado_sku`, sin cambios.
- UI bulk picker: sin cambios (sigue excluyendo `agotar`/`descontinuado` del bulk
  marcar AGOTAR).

## Por qué `descontinuado` también, si ya estaba excluido

El filtro de entrada (línea 797) excluye `descontinuado` del motor — pero por
defensa en profundidad, si algún SKU `descontinuado` llegara a llegar a este
punto del flujo (p.ej. cambio de estado mid-corrida, edge case), el override
asegura que `pedir_proveedor=0`. Costo: 0. Beneficio: invariante explícito.

## Validación esperada

Próximo cron `recalcular-todo` (11:00 UTC del día siguiente, o trigger manual):

- Los **22 SKUs `agotar`** pasarán a tener `pedir_proveedor=0` y
  `accion='AGOTAR_NO_RECOMPRA'` en `sku_intelligence`.
- Los 0 SKUs `descontinuado` actuales no cambian (ya excluidos por filtro de
  entrada, pero el override es defensa en profundidad).
- Los 73 `activo` + 414 `NULL` siguen calculándose normal.
- Caso testigo `JSAFAB422P20S`: pasa de `pedir_proveedor=14` a `pedir_proveedor=0`,
  `accion=AGOTAR_NO_RECOMPRA`. Motor nuevo ya lo invisibilizaba, ahora ambos
  motores alineados.

## Reversibilidad

**No reversible** sin mover/eliminar el bloque PASO 10c. Si en el futuro la
doctrina cambia (improbable — está formalizada y vinculante), basta con
comentar el bloque o agregar feature flag.

Tag: `[non-reversible:filter-agotar-motor-viejo]` indica que el override
establece doctrina permanente. Cambios de comportamiento futuros requieren
nueva policy explícita.

## Tests

No se agregaron tests Vitest para este cambio porque:

1. El tests file `src/lib/__tests__/intelligence-flex.test.ts` tiene errores de
   tipo PRE-EXISTENTES (no relacionados con este cambio) — agregar más casos
   ahí complicaría el rescate posterior del archivo de tests.
2. El cambio es ≤16 LOC, idempotente, con condición simple (`estado_sku in (...)`).
3. Validación operativa: siguiente cron `recalcular-todo` valida en producción
   sobre los 22 SKUs `agotar` reales.

**Pendiente sprint futuro**: rescatar `intelligence-flex.test.ts` y agregar caso
para `estado_sku=agotar` en ese rescate.

## Próximos pasos

- Tag relacionado: `[batch:20260504-alineacion-agotar]`.
- Próximo cron `recalcular-todo` valida en prod.
- Si en `/admin → Inteligencia` (motor viejo) los 22 SKUs `agotar` siguen
  apareciendo con `pedir_proveedor > 0` después del próximo cron, investigar:
  el motor podría estar saltando el PASO 10c, o el cron podría no haber corrido.

## Archivos tocados

- `src/lib/intelligence.ts` — type + PASO 10c override (~18 LOC)
- `docs/sprints/sprint-5.5.1-alineacion-agotar.md` — este doc

---

*Sprint ejecutado por Claude Opus 4.7 (1M context) el 2026-05-04 bajo
`feedback_banvabodega_autonomy`. Cambio quirúrgico de comportamiento
documentado por policy `docs/policies/estados-sku.md`.*
