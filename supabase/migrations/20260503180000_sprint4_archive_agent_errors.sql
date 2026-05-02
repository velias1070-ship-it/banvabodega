-- =============================================================================
-- Sprint 4 — Archivar errores de agent_runs (decisión Camino 1)
-- =============================================================================
-- Owner: Vicente Elías
-- Fecha: 2026-05-03
-- Tag PR: [batch:20260503-4]
--
-- Decisión owner (2026-05-03): BANVA opera Camino 1 — humanos + fórmulas
-- + dashboards. Agentes AI deshabilitados. Razón: 46.637 corridas en 30
-- días, todas en estado='error' (API key apagada para no gastar). Volumen
-- actual de 425 SKUs es manejable manualmente.
--
-- Esta migration:
--  1. Crea _archive_agent_runs_pre_2026_05 con LIKE INCLUDING ALL.
--  2. Mueve filas con created_at < now() - 1 day a la tabla archivo.
--  3. Borra esas filas de agent_runs (queda casi vacía, < 100 filas
--     correspondientes a runs en vuelo del último día).
--  4. Documenta el estado nuevo de agent_runs.
--
-- Idempotente: el INSERT/DELETE solo afectan filas con cutoff < now()-1d,
-- por lo que correr la migration de nuevo no duplica ni rompe nada.
-- Tag [non-reversible:agent-runs-pre-2026-05-archived-46k-error-rows]
-- por seguridad de Atlas (DELETE FROM trigger destructive regex).
--
-- Validación: tests/sprint4_validation.sql T1, T2.
-- =============================================================================

-- 1. Tabla archivo (idempotente).
-- Importante: NO usar el prefix _archive_* porque la naming convention de
-- Atlas solo permite _sprint{N}_, _audit_, _deprecated_. Anteponemos sprint4.
CREATE TABLE IF NOT EXISTS _sprint4_archive_agent_runs_pre_2026_05
  (LIKE agent_runs INCLUDING ALL);

COMMENT ON TABLE _sprint4_archive_agent_runs_pre_2026_05 IS
  'Sprint 4 (2026-05-03): archivo de filas de agent_runs anteriores al
   apagado de agentes AI (decisión Camino 1). Mayoría son errores con
   API key apagada. Preservadas por trazabilidad histórica. Drop futuro:
   2027-05-03 (1 año retention).';

-- 2 + 3. Mover filas con margen de 1 día (no movemos runs en vuelo del
-- último día por si quedó alguna corrida pendiente).
WITH moved AS (
  DELETE FROM agent_runs
   WHERE created_at < now() - INTERVAL '1 day'
  RETURNING *
)
INSERT INTO _sprint4_archive_agent_runs_pre_2026_05
SELECT * FROM moved
ON CONFLICT DO NOTHING;

-- 4. Reportar.
DO $$
DECLARE
  v_archived  bigint;
  v_remaining bigint;
BEGIN
  SELECT COUNT(*) INTO v_archived  FROM _sprint4_archive_agent_runs_pre_2026_05;
  SELECT COUNT(*) INTO v_remaining FROM agent_runs;
  RAISE NOTICE 'Sprint 4 archive: % filas archivadas, % filas activas restantes en agent_runs',
    v_archived, v_remaining;
END $$;

-- 5. Documentar el estado nuevo de agent_runs.
COMMENT ON TABLE agent_runs IS
  'Log de runs de agentes AI. Sprint 4 (2026-05-03): agentes deshabilitados
   por decisión Camino 1. Tabla queda con runs futuros (si se reactivan)
   o vacía. Archivo histórico en _sprint4_archive_agent_runs_pre_2026_05.';
