# Sprint 5 — Migración /inteligencia → motor nuevo (read-only)

**Fecha:** 2026-05-04
**Owner:** Vicente Elías
**Tag:** `[batch:20260504-sprint5]`
**Scope:** **Solo lecturas**. Cero migración SQL. Cero cambio de cron. Cero modificación a `intelligence.ts`.

---

## Decisión owner — Camino A

Aprobado el 2026-05-04 por owner basándose en `docs/policies/frontera-reposicion-pricing.md`:

> _"Reposición v2 lee desde `sku_node_policy` + `policy_templates` + nuevas vistas. `sku_intelligence` es cache del motor de inteligencia, **no canónica** para pricing ni para reposición. Las canónicas son `policy_templates` + `sku_node_policy` (Reposición)."_

Camino A (canónico) reemplaza al Camino C (mejorar el viejo) y al Camino B (descartar el nuevo).

Antecedentes:
- `docs/discovery/inteligencia-migration-2026-05-04.md` — mapping campo a campo y análisis de riesgos.
- `docs/discovery/comparacion-viejo-vs-nuevo-2026-05-04.md` — diferencia +30% en CLP total y razón estructural (`pre_full_target`).
- `docs/discovery/pricing-architecture-2026-05-04.md` — separación lógica pricing/reposición.

---

## Scope reducido aprobado

### IN scope (Sprint 5)
1. **Crear** type compartido `IntelExplainRow` (`src/types/inteligencia.ts`).
2. **Crear** sistema de feature flags (`src/lib/feature-flags.ts`) con override por localStorage + env var.
3. **Crear** endpoint `/api/intelligence/sku-venta-v2/route.ts` que deriva de `v_reposicion_explain` + parallel-fetch a `sku_intelligence` para campos caso C.
4. **Modificar** `AdminInteligencia.tsx` (cargarOrigen y cargarVenta) para ramificar por flag.
5. **Documentar** decisión + rollout playbook.

### OUT of scope (futuros sprints)
- Sprint 5.1 — cleanup post-validación: borrar `/admin/reposicion-suggestions` (vista intermedia) y endpoint `/api/intelligence/sku-venta` legacy cuando owner valide.
- Sprint 6 — migrar **escrituras**: mover storage de `vel_objetivo` y `_bulk` (descontinuar / estacional) fuera de `sku_intelligence` a tablas autoritativas (`sku_node_policy.manual_override` o tabla nueva).
- Sprint 6+ — extraer pricing/markdown de `sku_intelligence` a `markdown_state` (per `frontera-reposicion-pricing.md` §4).

### NO se toca en Sprint 5 (anti-scope explícito)
- `src/lib/intelligence.ts` — motor escritor del cache.
- `src/lib/intelligence-queries.ts` — queries del motor.
- `/api/intelligence/recalcular` — cron 11:00 UTC sigue igual.
- `/api/intelligence/sku/[sku_origen]` PATCH (vel_objetivo) — Sprint 6+.
- `/api/intelligence/sku/_bulk` — Sprint 6+.
- `pricing.ts`, `markdown-auto`, Op Limpieza, P17 (paso 17) de intelligence.ts.
- Vista "Accuracy" (`forecast_*`) — sigue en sku_intelligence.
- `SkuExplainPanel.tsx` (ya migrado en Sprint 4.2).
- Archivos pricing untracked de la sesión paralela.

---

## Cómo activar el flag para validar

### Opción A — Override por usuario (browser, instantáneo, no requiere deploy)

Vicente abre el panel admin y en devtools (consola):

```js
localStorage.setItem("banva_ff_INTEL_USE_NEW_ENGINE", "true");
location.reload();
```

Para apagar:

```js
localStorage.removeItem("banva_ff_INTEL_USE_NEW_ENGINE");
location.reload();
```

Este override es **per-browser**. No afecta a otros usuarios.

### Opción B — Flag global (deploy-wide)

Después de validar con la opción A, prender en Vercel:

1. Vercel dashboard → Project `banvabodega` → Settings → Environment Variables.
2. Agregar `NEXT_PUBLIC_INTEL_USE_NEW_ENGINE=true` para Production.
3. Redeploy (o esperar al próximo push).

**Default:** `false`. Mientras la env var no exista o no sea "true", todos los usuarios siguen viendo motor viejo.

### Cómo distinguir motor viejo vs nuevo en la UI

El endpoint v2 retorna `motor: "nuevo"` y cada fila lleva `motor_fuente: "nuevo"`. Si curl devuelve eso, el flag está ON desde el server. La tabla SKU Origen no marca explícitamente — pero las nuevas columnas `cell_efectiva`, `tendencia`, `promocion_activa` aparecen pobladas solo cuando viene del motor nuevo.

---

## Cómo revertir si algo sale mal

### Flag está en localStorage (Opción A activa)
1. Devtools → consola → `localStorage.removeItem("banva_ff_INTEL_USE_NEW_ENGINE")`.
2. Reload. Vuelve al motor viejo. **Sin downtime, sin deploy.**

### Flag está en env var (Opción B activa)
1. Vercel → env vars → cambiar `NEXT_PUBLIC_INTEL_USE_NEW_ENGINE=false` o eliminar.
2. Redeploy. **Tarda ~2 min.**

### Endpoint v2 da error pero v1 sigue OK
- Default del flag es false → nadie usa v2 salvo override explícito.
- Investigar v2 sin urgencia.
- No requiere rollback de código.

### AdminInteligencia.tsx se rompe completamente
1. `git revert <commit-sprint5>`.
2. Push → Vercel rebuildea.
3. Componente vuelve al estado pre-Sprint 5.

### v_reposicion_explain falla
- Sin precedente — la vista existe desde Sprint 4.3a y se rebuildeo en 4.3b/b.1.
- Si fallara: el flag-on rompe SKU Origen y SKU Venta. Apagar flag inmediatamente.

---

## Próximos sprints

### Sprint 5.1 — Cleanup post-validación

**Cuándo:** después de que owner valide el motor nuevo en producción.

**Scope:**
- Borrar `/admin/reposicion-suggestions` (vista intermedia introducida en Sprint 4 — `v_reposicion_dashboard`). Toda su funcionalidad queda absorbida por `/inteligencia` con el flag ON.
- Borrar el endpoint legacy `/api/intelligence/sku-venta` (v1).
- Renombrar `/api/intelligence/sku-venta-v2` → `/api/intelligence/sku-venta` (consolidación).
- Quitar la rama `if (useNewEngine)` de `cargarOrigen` y `cargarVenta` — el motor nuevo pasa a ser default sin flag.
- Eliminar `INTEL_USE_NEW_ENGINE` del catálogo de `feature-flags.ts`.
- Tag: `[batch:20260504-sprint5.1] [non-reversible:remove-legacy-endpoint]`.

### Sprint 6 — Migrar escrituras fuera de sku_intelligence

**Cuándo:** ETA Q3 2026 per `frontera-reposicion-pricing.md` §4.

**Scope:**
- Crear tabla `markdown_state` para campos pricing.
- Mover `vel_objetivo` a `sku_node_policy.manual_override_velocidad` (o tabla nueva).
- Mover `_bulk` (descontinuar / estacional) a `sku_node_policy`.
- Backfill desde `sku_intelligence`.
- Migrar lectores (paneles `AdminMargenes`, `AdminInteligencia`, agente pricing).
- Dropear los campos pricing de `sku_intelligence` con `[non-reversible:pricing-moved-to-markdown_state]`.

---

## Tests SQL ejecutados (4/4 PASS)

| # | Test | Resultado |
|---|---|---|
| T1 | `v_reposicion_explain` devuelve filas | PASS — 186 filas |
| T2 | Merge `v_reposicion_explain` × `sku_intelligence` | PASS — 186 SKUs merged, 186 con abc, 67 con qty_a_comprar |
| T3 | Paridad `qty_a_comprar` entre `v_reposicion_explain` y `v_compras_pendientes` | PASS — 67 SKUs coinciden, 0 diff |
| T4 | Exposición de tendencia y promoción (campos exclusivos motor nuevo) | PASS — 23 con promo activa, 97 con tendencia ≠ estable |

---

## Archivos creados / modificados

| Archivo | Tipo | LOC |
|---|---|---:|
| `src/types/inteligencia.ts` | NUEVO | ~115 |
| `src/lib/feature-flags.ts` | NUEVO | ~85 |
| `src/app/api/intelligence/sku-venta-v2/route.ts` | NUEVO | ~290 |
| `src/components/AdminInteligencia.tsx` | MODIFICADO | +85 / -10 |
| `docs/sprints/sprint-5-migracion-inteligencia.md` | NUEVO (este doc) | ~200 |
| `docs/policies/frontera-reposicion-pricing.md` | MODIFICADO | +5 |
| `CONVENTIONS.md` | MODIFICADO | +20 |

**Total:** 3 archivos nuevos de código + 1 modificado, 3 archivos de docs.

---

## Validación owner — checklist sugerida

Cuando Vicente quiera validar:

1. Abrir `/admin` → tab "Inteligencia".
2. Devtools consola: `localStorage.setItem("banva_ff_INTEL_USE_NEW_ENGINE", "true"); location.reload();`.
3. Verificar:
   - [ ] Tabla "SKU Venta" carga sin errores.
   - [ ] Tabla "SKU Origen" carga sin errores.
   - [ ] Columna "Pedir" muestra valores derivados de `qty_a_comprar` (motor nuevo). Comparar contra discovery `comparacion-viejo-vs-nuevo-2026-05-04.md` Top 20 absoluto.
   - [ ] Columnas operativas críticas (Acción, ABC, Cuadrante, Alertas) siguen visibles (vienen de sku_intelligence en parallel-fetch).
   - [ ] Banner KPIs no rompe (totales pueden cambiar — esperable).
   - [ ] Export CSV funciona sin error.
   - [ ] Export OC a Excel funciona sin error.
4. Si todo OK → cambiar env var en Vercel a `true` (Opción B).
5. Programar Sprint 5.1.

*Sprint generado por Claude Opus 4.7 (1M context) el 2026-05-04 bajo `feedback_banvabodega_autonomy`.*
