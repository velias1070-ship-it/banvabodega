# Auditorías del WMS BANVA

Revisiones del estado del sistema en momentos específicos. Sirven para tres cosas:

1. **Saber qué se decidió y por qué** — antes de un PR grande se hace una preauditoría con datos reales; queda como evidencia detrás de cada decisión técnica
2. **Trackear gaps abiertos** — la auditoría forense lista todo lo que falta; se cruza contra el código actual para ver qué se cerró y qué sigue pendiente
3. **Alimentar reglas duras** — `.claude/rules/inventory-policy.md` salió de bugs documentados acá

## Cuándo agregar un archivo a esta carpeta

- **Auditoría forense**: fotografía completa del sistema vs un estándar (manuales, ISO, etc.). Hacer cada 3-6 meses o tras un cambio estructural mayor.
- **Preauditoría de PR**: antes de un cambio que afecta motor de inteligencia, sync ML, o reposición. Documenta hipótesis + datos + criterio de éxito.

## Cuándo NO sirve un archivo y se puede archivar/borrar

- Cuando el PR de la preauditoría ya está en producción **y** los hallazgos están todos resueltos (no quedan items abiertos en el doc)
- Cuando una auditoría forense fue reemplazada por una más reciente con el mismo alcance

Si dudás, **no borres** — mover a `historico/` es preferible. El "por qué se decidió X" suele ser más valioso que el "qué hicimos hoy".

## Índice

### 🟢 Vigentes (consultar antes de tocar dominios relacionados)

| Archivo | Tipo | Lo que cubre | Items abiertos clave |
|---|---|---|---|
| [auditoria-inventarios-vs-codigo-2026-04-25.md](auditoria-inventarios-vs-codigo-2026-04-25.md) | Forense | 25 prácticas de los 6 manuales en `docs/manuales/inventarios/` mapeadas al código. ~67% cumplimiento. | Reservaciones explícitas, lotes/series, cycle counting auto, EOQ, Holt-Winters por categoría |
| [banva-bodega-auditoria-2026-04-18.md](banva-bodega-auditoria-2026-04-18.md) | Forense | Comparativa amplia (63 requisitos) contra estándares clase mundial. 33% cumplimiento. | Pausa ads OOS automática, σ_LT real desde OCs, KVI/PLC tagging, ceremonias S&OP |
| [banva-bodega-pr7-preauditoria-oc-recepcion.md](banva-bodega-pr7-preauditoria-oc-recepcion.md) | Preauditoría | Vinculación OC ↔ recepciones. App Etiquetas inserta `orden_compra_id=NULL`. | Selector dropdown de OC en `~/banva1/` (cross-repo) |
| [banva-bodega-pr6b-preauditoria.md](banva-bodega-pr6b-preauditoria.md) | Preauditoría | Pausa automática de ads en SKUs OOS. **NO IMPLEMENTADO** (verificado 2026-04-25: no existe migración v57 con columnas `ad_*`, no hay cron `ads-pause-oos`, no hay función `pauseProductAd`). | Implementar todo el plan: migración + endpoint + cron + UI. Ahorro proyectado ~$2.1M CLP/año. ~1 día de trabajo. |

### 🟡 Histórico parcial (PR desplegado, items diferidos abiertos)

| Archivo | Lo que se hizo | Lo que sigue abierto |
|---|---|---|
| [banva-bodega-pr3-preauditoria.md](banva-bodega-pr3-preauditoria.md) | TSB Fase A: 104 SKUs en shadow mode (`tsb_modelo_usado='tsb'`) | Fase C (activación operativa) — espera ≥4 semanas reales post 2026-05-18 |
| [banva-bodega-pr4-preauditoria.md](banva-bodega-pr4-preauditoria.md) | PR4 Fase 1: flag `es_estacional` (v54), 67/533 SKUs marcados manualmente | Fase 2 (detección autocorrelación lag-12) — julio 2026 / Fase 3 (Holt-Winters) — enero 2027 |

### ⚫ Histórico cerrado (referencia de "por qué se hizo así")

| Archivo | Por qué se mantiene |
|---|---|
| [banva-bodega-pr6b-pivot-preauditoria.md](banva-bodega-pr6b-pivot-preauditoria.md) | Reconciliador de stock ML cada hora ya en producción. Documenta el pivote desde "pausar ads" a "fix stock fantasma". Útil si vuelven a aparecer SKUs desincronizados. |

## Cómo usar este README

- Antes de crear una nueva auditoría, leer las vigentes para no duplicar análisis
- Antes de un PR sobre inventario / ML sync / reposición, buscar si hay preauditoría histórica relacionada
- Si un doc cambia de estado (vigente → histórico parcial → cerrado), actualizar este README en el mismo commit
