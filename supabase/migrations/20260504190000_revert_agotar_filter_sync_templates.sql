-- Sprint 5.5.2 — Revertir filtro estado_sku='agotar' en cron sync-from-templates
-- Owner: Vicente Elías | 2026-05-04 | Tag: [batch:20260504-revert-agotar-filter]
-- Discovery: docs/discovery/estados-y-flags-2026-05-04.md
-- Doctrina nueva: docs/policies/estados-sku.md (revisión 2026-05-04 PM)
--
-- DECISIÓN OWNER 2026-05-04:
-- 'agotar' es SOLO un toggle de buffer Flex=0 ("vender al máximo sin reserva").
-- NO debe bloquear recompra ni excluir del motor de inteligencia.
--
-- Caso testigo: JSAFAB422P20S — owner emitió OC-006 a Idetex el 2026-04-28 y
-- al día siguiente marcó 'agotar' (intención: seguir comprando + vender sin
-- buffer). El filtro `estado_sku = 'activo' OR IS NULL` excluía agotar de
-- sku_node_policy, invisibilizándolo del motor nuevo. Comportamiento incorrecto
-- según la decisión owner formalizada hoy.
--
-- CAMBIO: refresh_sku_node_policy_from_templates() ahora incluye SKUs 'agotar'
-- (los procesa como cualquier 'activo'/NULL). Solo 'descontinuado' queda
-- excluido (doctrina de descontinuado intacta: fuera de catálogo, sin policy,
-- sin pricing markdown, sin motor).
--
-- Nota: 100% RPC redefinition. Cero cambio de schema. Idempotente. Reversible
-- (volver a versión sprint 4.3a si fuera necesario).

CREATE OR REPLACE FUNCTION refresh_sku_node_policy_from_templates()
RETURNS TABLE (rows_affected integer) LANGUAGE plpgsql AS $$
DECLARE v_count integer;
BEGIN
  WITH
    skus_activos AS (
      -- Sprint 5.5.2 (revert): incluir 'agotar'. Solo 'descontinuado' excluido.
      -- 'agotar' es SOLO buffer Flex=0; el motor sigue procesándolo normal.
      SELECT sku FROM productos
       WHERE estado_sku IS DISTINCT FROM 'descontinuado'
    ),
    nodos_inv AS (
      SELECT id FROM nodes WHERE node_type IN ('warehouse','fulfillment')
    ),
    combos AS (
      SELECT s.sku AS sku_origen, n.id AS node_id
        FROM skus_activos s CROSS JOIN nodos_inv n
    ),
    upserted AS (
      INSERT INTO sku_node_policy (
        sku_origen, node_id, cell, service_level, z_value, target_dias_full,
        target_dias_flex, action, velocidad_observada, velocidad_censurada,
        dias_quiebre_window_30d, xyz_confidence, policy_status, source_template,
        manual_override, created_at, updated_at
      )
      SELECT
        c.sku_origen, c.node_id, calc.cell, calc.service_level, calc.z_value,
        calc.target_dias_full, calc.target_dias_flex, calc.action,
        calc.velocidad_observada, calc.velocidad_censurada,
        calc.dias_quiebre_window_30d, calc.xyz_confidence, calc.policy_status,
        calc.source_template, false, now(), now()
      FROM combos c
      CROSS JOIN LATERAL calc_sku_node_policy_row(c.sku_origen, c.node_id) calc
      ON CONFLICT (sku_origen, node_id) DO UPDATE SET
        cell                    = EXCLUDED.cell,
        service_level           = EXCLUDED.service_level,
        z_value                 = EXCLUDED.z_value,
        target_dias_full        = EXCLUDED.target_dias_full,
        target_dias_flex        = EXCLUDED.target_dias_flex,
        action                  = EXCLUDED.action,
        velocidad_observada     = EXCLUDED.velocidad_observada,
        xyz_confidence          = EXCLUDED.xyz_confidence,
        policy_status           = EXCLUDED.policy_status,
        source_template         = EXCLUDED.source_template,
        updated_at              = now()
        WHERE sku_node_policy.manual_override = false
      RETURNING 1
    )
  SELECT COUNT(*)::integer INTO v_count FROM upserted;
  RETURN QUERY SELECT v_count;
END;
$$;

COMMENT ON FUNCTION refresh_sku_node_policy_from_templates IS
  'Sprint 5.5.2 (revert agotar filter, 2026-05-04): incluye SKUs estado_sku=agotar
   en el refresh (solo descontinuado queda excluido). agotar es SOLO toggle de
   buffer Flex=0; no debe bloquear recompra ni invisibilizar del motor.
   Preserva manual_override=true. Idempotente.';

-- Backfill inmediato: reincorpora los 22 agotar al sku_node_policy.
SELECT * FROM refresh_sku_node_policy_from_templates();

-- Validar invariante: 'descontinuado' sigue fuera, 'agotar' adentro.
DO $$
DECLARE
  v_descontinuados_in_policy integer;
  v_agotar_in_policy integer;
  v_agotar_total integer;
BEGIN
  SELECT COUNT(*) INTO v_descontinuados_in_policy
    FROM sku_node_policy snp
    JOIN productos p ON p.sku = snp.sku_origen
   WHERE p.estado_sku = 'descontinuado';
  IF v_descontinuados_in_policy > 0 THEN
    RAISE EXCEPTION 'Sprint 5.5.2 invariant: % descontinuados aparecen en sku_node_policy (no debe pasar)', v_descontinuados_in_policy;
  END IF;

  SELECT COUNT(*) INTO v_agotar_total FROM productos WHERE estado_sku = 'agotar';
  SELECT COUNT(DISTINCT snp.sku_origen) INTO v_agotar_in_policy
    FROM sku_node_policy snp
    JOIN productos p ON p.sku = snp.sku_origen
   WHERE p.estado_sku = 'agotar';
  -- Debe ser igual: cada SKU agotar tiene fila en al menos un nodo.
  IF v_agotar_in_policy < v_agotar_total THEN
    RAISE EXCEPTION 'Sprint 5.5.2 invariant: % agotar SKUs no entraron a sku_node_policy (esperado: %)',
      v_agotar_total - v_agotar_in_policy, v_agotar_total;
  END IF;
END $$;
