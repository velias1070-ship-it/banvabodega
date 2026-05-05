---
sprint: 8
title: Promoción motor nuevo a default + cleanup post-refactor
date: 2026-05-05
owner: Vicente Elías
tags: [sprint:8] [cleanup] [motor-nuevo-default]
related:
  - docs/sprints/sprint-7.md
  - docs/policies/motor-canonico.md (pendiente Fase 5)
  - src/lib/feature-flags.ts
---

# Sprint 8 — Cleanup post-refactor

## Objetivo

Promover motor nuevo a default operativo, marcar motor viejo como deprecated, consolidar crons y documentar el sistema canónico. **NO se borra código** del motor viejo en este sprint (espera cooldown 30d → Sprint 9+).

## Reglas operativas

- Después de **cada fase**: PARAR y reportar. NO avanzar sin OK.
- NO push intermedio entre fases.
- Mínimo **24h con motor nuevo como default** antes de Fase 2.
- Kill-switch local vía `localStorage` debe estar validado **antes** de cambiar el default.

## Estado por fase

| Fase | Tarea | Estado |
|---|---|---|
| 0 | Validación pre-promoción top 50 SKUs | ✅ APROBADA (50/50 OK, 9 diff documentadas) |
| 1 | Promover motor nuevo a default | ⏳ pendiente OK kill-switch |
| 2 | `/admin/reposicion-suggestions` cleanup | — |
| 3 | `@deprecated` en motor viejo | — |
| 4 | Consolidación crons | — |
| 5 | Documentación final | — |

---

## Fase 0 — Validación pre-promoción ✅

**Universo:** top 50 SKUs por `vel_ponderada` (rangos 22.10 → 4.08 uds/sem).

**Resultados:**

| Métrica | Valor |
|---|---|
| Match en `accion` | 41/50 (82%) |
| Avg delta `pedir_proveedor` | 4.58 uds (bias −0.30 ≈ neutro) |
| Avg delta `mandar_full` | 3.50 uds (bias **−3.02** = nuevo manda menos) |
| Red flags `pedir > 5 uds` | 15 SKUs |
| Red flags `mandar > 5 uds` | 10 SKUs |

**Veredicto del owner:** 50/50 SKUs revisados son operativamente correctos. Las 9 divergencias en `accion` son justificadas por mejoras del motor nuevo, no errores.

### Patrón documentado: "URGENTE viejo → PLANIFICAR/OK nuevo justificado"

4 SKUs en validación Fase 0 cayeron en este patrón:

| SKU | Viejo → Nuevo | Picking en camino |
|---|---|---|
| JSAFAB427P20S | URGENTE → PLANIFICAR | 16 uds |
| TXV23QLAT20BE | EN_TRANSITO → OK | 32 uds |
| JSECBQ001P20Z | EN_TRANSITO → PLANIFICAR | 20 uds |
| ALPCMPRCL4575 | mandar 33 → 0 | picking activo cubre déficit |

**Causa:** motor viejo no ve picking_session activos hacia Full (lane `bodega_to_full` no implementado en `intelligence.ts`). El motor nuevo (Sprint 7 Fase 0.A) sí lo ve y descuenta correctamente del déficit.

**Veredicto operacional:** motor nuevo correcto. Marcar estos SKUs como URGENTE/EN_TRANSITO genera decisiones agresivas sin necesidad real (pedir más al proveedor, repriorizar picking). Capital y atención mal asignados.

### Caso testigo — JSAFAB427P20S

| Variable | Viejo | Nuevo |
|---|---|---|
| `stock_total` | 17 | 17 (idéntico, no race condition) |
| `vel_diaria` | 1.38 | 1.38 |
| `vel_ponderada` (sem) | 9.69 | 9.69 |
| `dio` | 12.28 | 12.28 |
| `cob_full` | 13.54d | — |
| `picking activo bodega→Full` | — | **16 uds** |
| `accion` | URGENTE | **PLANIFICAR** |

**Inventario efectivo nuevo** = `stock_total 17 + picking 16 = 33 uds` → `~24d cobertura`.

**Test ramas URGENTE motor nuevo:**

```
Rama 1 — cob_full bajo ROP:
  cob_full 13.54  <  reorder_point 12  →  FALSE

Rama 2 — cobertura cruda <7d (Sprint 7 Fase 1.1):
  stock_total 17  <  vel_pond_sem 9.69  →  FALSE
```

Ambas ramas FALSE → motor nuevo correctamente NO marca URGENTE → **PLANIFICAR es la decisión correcta**.

---

## Fase 1 — Promoción motor nuevo a default

**Estado:** pendiente validación kill-switch + OK del owner.

### Archivos involucrados

- **Flag:** `src/lib/feature-flags.ts` (definición + resolución).
- **Consumidor principal:** `src/components/AdminInteligencia.tsx:524, 615`.
- **Endpoint nuevo:** `/api/intelligence/sku-venta-v2`.
- **Endpoint viejo:** `/api/intelligence/sku-venta`.

### Resolución del flag (orden de precedencia)

```
1. localStorage["banva_ff_INTEL_USE_NEW_ENGINE"]   ← override por usuario, browser
2. process.env.NEXT_PUBLIC_INTEL_USE_NEW_ENGINE    ← deploy-wide
3. fallback hardcoded (default false)              ← actual
```

### Estado actual (pre-promoción)

- `NEXT_PUBLIC_INTEL_USE_NEW_ENGINE` **NO está seteada en Vercel** (Production, Preview, ni Development).
- Resultado: motor nuevo se activa **solo por localStorage** (caso por caso del owner).
- Default operativo: motor viejo.

### Cómo se hará el cambio

Opción elegida: **modificar `readEnv()` en `feature-flags.ts`** para invertir el default:

```ts
case FEATURE_FLAGS.INTEL_USE_NEW_ENGINE:
  // Sprint 8 Fase 1 (2026-05-05): default invertido a true.
  // Para apagar globalmente: NEXT_PUBLIC_INTEL_USE_NEW_ENGINE=false en Vercel.
  // Para apagar local: localStorage.setItem("banva_ff_INTEL_USE_NEW_ENGINE", "false")
  return process.env.NEXT_PUBLIC_INTEL_USE_NEW_ENGINE !== "false";
```

Razón: queda en git (auditable, revertible con un commit) y mantiene la posibilidad de apagar globalmente vía env si surge incidente.

### Cómo revertir

| Severidad | Acción | Tiempo |
|---|---|---|
| Solo mi navegador | `localStorage.setItem("banva_ff_INTEL_USE_NEW_ENGINE", "false")` + reload | inmediato |
| Toda la org | Setear `NEXT_PUBLIC_INTEL_USE_NEW_ENGINE=false` en Vercel + redeploy | ~2 min |
| Total (rollback código) | `git revert <commit>` + push | ~3 min |

### Casos testigo a monitorear post-deploy

- **JSAFAB422P20S** (operativo normal con OC abierta).
- **Top 11 URGENTE** del motor nuevo: validar que sean operativamente correctos.
- **Casos del patrón "viejo URGENTE → nuevo PLANIFICAR"** documentados arriba: confirmar que NO desaparecen del radar (siguen visibles, solo no marcados rojo).

### Plan de validación pre-deploy

Owner valida en navegador (manual, NO automatizable desde aquí):

```
PASO 1 — Activar override local:
  Devtools → Console:
    localStorage.setItem("banva_ff_INTEL_USE_NEW_ENGINE", "true")
    location.reload()
  Abrir /admin tab "Inteligencia".
  Confirmar: muestra columnas del motor nuevo (cell, qty_a_comprar,
  pre_full_target, mandar_full_uds, liquidacion_accion).

PASO 2 — Apagar override local:
  Devtools → Console:
    localStorage.setItem("banva_ff_INTEL_USE_NEW_ENGINE", "false")
    location.reload()
  Confirmar: vuelve al motor viejo (columnas legacy).

PASO 3 — Limpiar override:
  localStorage.removeItem("banva_ff_INTEL_USE_NEW_ENGINE")
  location.reload()
  Confirmar: vuelve al default actual (motor viejo, default false).
```

Solo después de validar PASOs 1-3 OK, cambiar el default en `feature-flags.ts` y deployar.

### Plan de validación post-deploy (sin localStorage)

```
1. Owner abre /admin tab "Inteligencia" (sin tocar localStorage).
2. Debe ver columnas del motor nuevo por default.
3. Filtrar accion='URGENTE' → 11 SKUs (no 25).
4. Filtrar accion='MANDAR_FULL' con is_new_sku=false → 7 SKUs.
5. Click ⓘ → debe abrir narrativa del v_sku_explanation.
```

### Stop tras Fase 1

Mínimo **24h** con motor nuevo activo en producción antes de avanzar a Fase 2. Si surge issue operativo, `/admin/reposicion-suggestions` sigue funcionando como vista alternativa de debug.
