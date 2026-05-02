-- =============================================================================
-- Sprint 3 — Resolver inconsistencias I4, I6, I9 sin tocar fórmulas de velocidad
-- =============================================================================
-- Owner: Vicente Elías
-- Fecha: 2026-05-03
-- Tag PR: [batch:20260503-3]
--
-- Trazabilidad y guardrails sin cambiar fórmulas. Decisión owner Opción C:
-- vel_7d sigue sin censoring por ahora (post-Sprint 4 con shadow mode).
-- Sprint 3 solo agrega guardrails defensivos para que decisiones futuras
-- (Reposición v2 y Pricing v2) puedan basarse en datos confiables.
--
-- I4 — Filtro anulada divergente:
--      Tabla _lint_forbidden_patterns (lint en CI grep) + cambio en store.ts.
-- I6 — vel_objetivo sin guardrails:
--      CHECK constraint + RPC validate_vel_objetivo_input.
-- I9 — margen_neto_30d imputado en quiebre sin marker:
--      Columna margen_neto_30d_imputed en sku_intelligence y _history +
--      backfill basado en stock_snapshots (>=15 días en quiebre en ventana 30d).
--
-- Idempotente. NO toca fórmulas. NO modifica fila ya marcada manual.
-- Validación: tests/sprint3_validation.sql.
-- Ver /docs/sprints/sprint-3-traceability-guardrails.md.
-- =============================================================================

-- =============================================================================
-- I9 — STEP 1: Agregar columnas margen_neto_30d_imputed
-- =============================================================================

ALTER TABLE sku_intelligence
  ADD COLUMN IF NOT EXISTS margen_neto_30d_imputed boolean NOT NULL DEFAULT false;

ALTER TABLE sku_intelligence_history
  ADD COLUMN IF NOT EXISTS margen_neto_30d_imputed boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN sku_intelligence.margen_neto_30d_imputed IS
  'true = margen_neto_30d fue calculado por imputación (cuando SKU estaba en quiebre y no hubo ventas reales suficientes). false = margen observado de ventas reales en la ventana 30d. Sprint 3 (2026-05-03): trazabilidad de imputación. Sprint 4 Reposición v2 puede usar este flag para descontar el peso del margen imputado en decisiones de compra.';

COMMENT ON COLUMN sku_intelligence_history.margen_neto_30d_imputed IS
  'Snapshot histórico de margen_neto_30d_imputed. Backfill Sprint 3 marca true cuando el SKU estaba en quiebre la mayor parte de la ventana 30d (>=15 días).';


-- =============================================================================
-- I6 — STEP 2: Sanitizar valores absurdos antes del CHECK constraint
-- =============================================================================

CREATE TEMP TABLE _vel_objetivo_outliers AS
SELECT sku_origen, vel_ponderada, vel_objetivo,
       CASE
         WHEN vel_objetivo < 0 THEN 'negativo'
         WHEN vel_ponderada > 0 AND vel_objetivo > vel_ponderada * 100 THEN 'demasiado_alto'
         ELSE 'unknown'
       END AS razon
  FROM sku_intelligence
 WHERE vel_objetivo IS NOT NULL
   AND (vel_objetivo < 0
        OR (vel_ponderada > 0 AND vel_objetivo > vel_ponderada * 100));

DO $$
DECLARE v_count int;
BEGIN
  SELECT COUNT(*) INTO v_count FROM _vel_objetivo_outliers;
  IF v_count > 0 THEN
    RAISE NOTICE 'I6: % filas con vel_objetivo absurdo. Reseteando a NULL antes del CHECK.', v_count;
    UPDATE sku_intelligence
       SET vel_objetivo = NULL
     WHERE sku_origen IN (SELECT sku_origen FROM _vel_objetivo_outliers);
    RAISE NOTICE 'I6: % filas reseteadas.', v_count;
  ELSE
    RAISE NOTICE 'I6: cero outliers, CHECK aplica directo.';
  END IF;
END $$;

-- =============================================================================
-- I6 — STEP 3: CHECK constraint sku_intelligence_vel_objetivo_sane
-- =============================================================================

DO $$ BEGIN
  ALTER TABLE sku_intelligence
    ADD CONSTRAINT sku_intelligence_vel_objetivo_sane
    CHECK (
      vel_objetivo IS NULL
      OR (vel_objetivo >= 0
          AND (vel_ponderada IS NULL
               OR vel_ponderada = 0
               OR vel_objetivo <= vel_ponderada * 100))
    );
EXCEPTION
  WHEN duplicate_object THEN
    RAISE NOTICE 'I6: constraint sku_intelligence_vel_objetivo_sane ya existe, skip.';
END $$;

COMMENT ON CONSTRAINT sku_intelligence_vel_objetivo_sane ON sku_intelligence IS
  'I6 — Sprint 3: vel_objetivo no puede ser negativo ni más de 100x vel_ponderada. Cualquier UI o RPC que setee vel_objetivo debe pasar este filtro o usar validate_vel_objetivo_input(). Sin esto, valores absurdos se propagan a sku_intelligence_history y rompen forecast.';


-- =============================================================================
-- I6 — STEP 4: RPC validate_vel_objetivo_input
-- =============================================================================

DROP FUNCTION IF EXISTS validate_vel_objetivo_input(text, numeric);

CREATE OR REPLACE FUNCTION validate_vel_objetivo_input(
  p_sku_origen   text,
  p_vel_objetivo numeric
) RETURNS TABLE (
  is_valid             boolean,
  reason               text,
  vel_ponderada_actual numeric,
  max_aceptable        numeric
) LANGUAGE plpgsql STABLE AS $func$
DECLARE
  v_vel_ponderada numeric;
BEGIN
  SELECT si.vel_ponderada INTO v_vel_ponderada
    FROM sku_intelligence si
   WHERE si.sku_origen = p_sku_origen
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'sku_no_existe'::text, 0::numeric, 0::numeric;
    RETURN;
  END IF;

  IF p_vel_objetivo IS NULL THEN
    RETURN QUERY SELECT true, 'null_aceptable'::text, v_vel_ponderada,
      COALESCE(v_vel_ponderada * 100, 0::numeric);
    RETURN;
  END IF;

  IF p_vel_objetivo < 0 THEN
    RETURN QUERY SELECT false, 'negativo_no_permitido'::text, v_vel_ponderada,
      COALESCE(v_vel_ponderada * 100, 0::numeric);
    RETURN;
  END IF;

  IF v_vel_ponderada IS NOT NULL AND v_vel_ponderada > 0
     AND p_vel_objetivo > v_vel_ponderada * 100 THEN
    RETURN QUERY SELECT false, 'demasiado_alto_vs_vel_real'::text,
      v_vel_ponderada, v_vel_ponderada * 100;
    RETURN;
  END IF;

  RETURN QUERY SELECT true, 'ok'::text, v_vel_ponderada,
    COALESCE(v_vel_ponderada * 100, 0::numeric);
END;
$func$;

COMMENT ON FUNCTION validate_vel_objetivo_input IS
  'I6 — Sprint 3: valida vel_objetivo ANTES de update. Retorna is_valid + reason + vel_ponderada_actual + max_aceptable. La UI o cualquier RPC que setee vel_objetivo debe llamar esta función primero. Si is_valid=false, mostrar reason al usuario y NO ejecutar update. Tags: negativo_no_permitido, demasiado_alto_vs_vel_real, sku_no_existe, null_aceptable, ok.';


-- =============================================================================
-- I9 — STEP 5: Backfill margen_neto_30d_imputed para snapshots históricos
-- =============================================================================
-- Heurística: si el SKU estuvo en quiebre (full O bodega) >=15 días en la
-- ventana 30d previa al snapshot, el margen pesa más imputado que observado.
-- La función calcula imputación como vel_pre_quiebre × margen_unitario × 4.3
-- (intelligence.ts:1681-1683). Acá no recalculamos: solo marcamos el flag
-- de los snapshots existentes para trazabilidad retroactiva.

UPDATE sku_intelligence_history sih
   SET margen_neto_30d_imputed = true
  FROM (
    SELECT sih2.id, sih2.sku_origen, sih2.created_at,
           COUNT(*) FILTER (
             WHERE ss.en_quiebre_full = true OR ss.en_quiebre_bodega = true
           ) AS dias_quiebre
      FROM sku_intelligence_history sih2
      LEFT JOIN stock_snapshots ss
        ON ss.sku_origen = sih2.sku_origen
       AND ss.created_at BETWEEN sih2.created_at - INTERVAL '30 days' AND sih2.created_at
     GROUP BY sih2.id, sih2.sku_origen, sih2.created_at
  ) q
 WHERE sih.id = q.id
   AND q.dias_quiebre >= 15
   AND sih.margen_neto_30d_imputed = false;

-- Mismo backfill para la fila viva en sku_intelligence usando ventana 30d hasta ahora
UPDATE sku_intelligence si
   SET margen_neto_30d_imputed = true
 WHERE si.margen_neto_30d_imputed = false
   AND EXISTS (
     SELECT 1 FROM stock_snapshots ss
      WHERE ss.sku_origen = si.sku_origen
        AND ss.created_at >= now() - INTERVAL '30 days'
      GROUP BY ss.sku_origen
     HAVING COUNT(*) FILTER (
       WHERE ss.en_quiebre_full = true OR ss.en_quiebre_bodega = true
     ) >= 15
   );


-- =============================================================================
-- I4 — STEP 6: Tabla _lint_forbidden_patterns para CI lint
-- =============================================================================

CREATE TABLE IF NOT EXISTS _lint_forbidden_patterns (
  pattern         text PRIMARY KEY,
  reason          text NOT NULL,
  introduced_in   text,
  detected_in_files int DEFAULT 0
);

INSERT INTO _lint_forbidden_patterns (pattern, reason, introduced_in) VALUES
  ('.neq(''anulada'', true)',
   'I4 unificación: usar .eq(''anulada'', false). H27 cerrada Sprint 0.5.',
   '2026-05-03 Sprint 3'),
  ('.neq("anulada", true)',
   'I4 unificación: usar .eq("anulada", false). H27 cerrada Sprint 0.5.',
   '2026-05-03 Sprint 3')
ON CONFLICT (pattern) DO NOTHING;

COMMENT ON TABLE _lint_forbidden_patterns IS
  'I4 — Sprint 3: patrones prohibidos por lint en CI. El workflow lint-banned-patterns en GitHub Actions chequea grep en src/** y falla si encuentra match. NO se usa en runtime — es solo registry leído por scripts/lint-banned-patterns.sh.';
