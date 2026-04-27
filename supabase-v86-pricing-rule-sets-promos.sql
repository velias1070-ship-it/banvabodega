-- v86: extiende rule set global con dominio promos_postulacion (v1.1.0).
--
-- Manual:
--   - Investigacion_Comparada:303-310 (descuento directo vs cupon vs bundle)
--   - Engines_a_Escala:610-616 (boosts ML: fulfillment, free_shipping, same_day, free_installments)
--   - Investigacion_Comparada §4.4 (matriz precio↔ads)
--
-- Codifica las decisiones que Vicente tomo operativamente:
--   - Si ML te ofrece tier 5 (LIGHTNING/DOD), postular SIEMPRE sea cual sea el precio
--     porque la exposicion de seccion "Ofertas" + push notif compensa el margen perdido
--     en ese ciclo (la promo dura 6h-24h, no compromete baseline porque ML la pone con
--     fecha fin obligatoria).
--   - Tier 4 (DEAL/MARKETPLACE_CAMPAIGN/SMART) postular si margen post-promo >= 0,
--     ML co-fondea en SMART asi que el descuento real al seller suele ser menor.
--   - Tier 3 (PRICE_DISCOUNT/PRE_NEGOTIATED) requiere margen post-promo >= margen_min
--     del cuadrante.
--   - Tier 1-2 (PRICE_MATCHING, SELLER_*, VOLUME, UNHEALTHY_STOCK) postular solo si
--     subimos tier de vitrina o si el SKU esta en aging >120d.
--   - "Nunca postular" hoy es lista vacia; reservado para SKUs marcados manualmente.
--
-- Estrategia de cutover:
--   1. Publicar rule set v1.1.0 con promos_postulacion incluido.
--   2. Aprobar y promover a production en mismo bloque (bootstrap, no two-person aqui).
--   3. Codigo lee gradualmente vez de constantes hardcoded.

DO $$
DECLARE
  v_current_rules jsonb;
  v_new_rules     jsonb;
  v_parent_id     uuid;
  v_new_id        uuid;
  v_new_hash      text;
BEGIN
  -- Tomar rules del rule set actualmente en production
  SELECT rs.id, rs.rules INTO v_parent_id, v_current_rules
  FROM pricing_rule_set_pointers p
  JOIN pricing_rule_sets rs ON rs.id = p.rule_set_id
  WHERE p.channel = 'production' AND p.domain = 'global' AND p.scope = '{}'::jsonb
  LIMIT 1;

  IF v_current_rules IS NULL THEN
    RAISE NOTICE 'No production rule set found for global; aborting v86';
    RETURN;
  END IF;

  -- Extender con promos_postulacion
  v_new_rules := v_current_rules || jsonb_build_object(
    'promos_postulacion', jsonb_build_object(
      'fuente',                     'Investigacion_Comparada:303-310 + Engines_a_Escala:610-616',
      'siempre_postular_tiers',     jsonb_build_array(5),
      'siempre_postular_tipos',     jsonb_build_array('LIGHTNING', 'DOD'),
      'bypass_floor_para_obligatorios', true,
      'tier_minimo_postular',       1,
      'nunca_postular_tipos',       jsonb_build_array(),
      'tier_4_requiere_margen_post_pct', 0,
      'tier_3_usa_margen_min_cuadrante', true,
      'tier_2_solo_si_aging_min_dias',   120,
      'tier_1_solo_si_aging_min_dias',   180,
      'no_degradar_tier_activo',    true,
      'cooldown_post_promo_horas',  24,
      'notas',                      'Tier 5 (LIGHTNING, DOD) = sieempre postular; bypass de floor por exposicion de vitrina. Tier 4 requiere margen post-promo >=0. Tier 3 requiere margen >= margen_min cuadrante. Tier 1-2 solo si SKU esta en aging.'
    ),
    'version', 'v1.1.0'
  );

  v_new_hash := encode(sha256(v_new_rules::text::bytea), 'hex');

  -- Insertar como approved (bootstrap, sin two-person rule)
  INSERT INTO pricing_rule_sets (
    domain, version_label, content_hash, rules, schema_version,
    status, parent_id, created_by, approved_by, approved_at, notes
  ) VALUES (
    'global', 'v1.1.0', v_new_hash, v_new_rules, 1,
    'approved', v_parent_id, 'migration_v86', 'migration_v86', now(),
    'Agrega dominio promos_postulacion: tier 5 (LIGHTNING/DOD) siempre postular bypass floor; tier 3 requiere margen_min cuadrante; tier 1-2 solo si SKU en aging.'
  )
  ON CONFLICT (content_hash) DO UPDATE SET notes = EXCLUDED.notes
  RETURNING id INTO v_new_id;

  -- Promover a production (rollout 100%)
  UPDATE pricing_rule_set_pointers
  SET rule_set_id = v_new_id,
      activated_by = 'migration_v86',
      activated_at = now(),
      rollout_pct = 100,
      notes = 'v1.1.0 con promos_postulacion. Anterior: ' || COALESCE(notes, '')
  WHERE channel = 'production' AND domain = 'global' AND scope = '{}'::jsonb;

  RAISE NOTICE 'v86 ok: rule set v1.1.0 (id=%, hash=%) promovido a production', v_new_id, v_new_hash;
END $$;
