# supabase/pending-mov/

Drafts del **Sprint 1 (mov)** paralelo: limpieza de motivos en la tabla
`movimientos`. **Baja prioridad** — se aplica después del Sprint 1 (sales).

Estos archivos no se ejecutaron nunca. Quedan como drafts hasta que Vicente
dé luz verde.

## Contenido

- `v51-limpieza-motivos.sql` — crea tabla `eventos_operativos`, mueve motivos
  no-contables (`reparacion_stock`, `reclasificacion`, `reasignacion_formato`,
  `despick`, `cancelacion_ml`, `operario_skip_scan`, `regularizacion_historica`),
  renombra motivos legacy al whitelist final (`ajuste_entrada` →
  `ajuste_conteo_positivo`, etc.) y aplica las correcciones manuales de los
  8 casos sucios decididos por Vicente el 2026-04-15 (Grupo A, B y C).

- `v52-check-motivo-whitelist.sql` — aplica `CHECK constraint` sobre
  `movimientos.motivo` con whitelist por `tipo`. Requiere que v51 esté
  aplicada y que el código TypeScript ya emita solo los motivos nuevos (ver
  lista de call-sites a refactorear en la conversación del sprint).

## Pre-requisitos antes de aplicar

1. Investigar el call-site del webhook que emitió `motivo='despacho_ml'` los
   3 movimientos del 2026-03-25 (hallazgo del diagnóstico: no está en código
   TS vigente, fue un INSERT manual o código muerto). Confirmar que no va a
   seguir disparándose después del CHECK.

2. Refactorear los ~14 call-sites TS que emiten motivos legacy (lista
   detallada en la conversación del diagnóstico de Sprint 1 mov). Sin eso,
   aplicar v52 rompe los writes en caliente.

3. Correr primero v51 en staging, validar con
   `SELECT motivo, tipo, COUNT(*) FROM movimientos GROUP BY 1,2 ORDER BY 1,2;`
   que no queda nada fuera del whitelist, y recién entonces v52.

## Por qué están acá y no en root

El root del repo tiene ~48 archivos `supabase-v*.sql` de migraciones
aplicadas. Para no ensuciar esa carpeta con drafts que todavía no se
ejecutaron, viven acá separados. Cuando se apliquen, se mueven al root con
los números siguientes disponibles.
