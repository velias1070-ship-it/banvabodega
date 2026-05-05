-- Sprint 7 Fase 3 — Tabla markdown_policy + ENUM
-- batch:20260505-sprint-7-fase3 | sprint:7 | fase:3
--
-- Porta P17 motor viejo (intelligence.ts:2121-2137) a tabla parametrizable.
-- Lookup: WHERE cell=X AND dias_extra > threshold ORDER BY threshold DESC LIMIT 1.
-- Por celda × threshold (9 cells × 3 thresholds = 27 rows). Override opcional
-- por SKU vía sku_node_policy.liquidacion_override.

CREATE TYPE liquidacion_accion_enum AS ENUM (
  'descuento_10',
  'liquidar_activa',
  'precio_costo'
);

CREATE TABLE markdown_policy (
  cell text NOT NULL,
  dias_extra_threshold int NOT NULL,
  descuento_pct numeric(4,3) NOT NULL,
  liquidacion_accion liquidacion_accion_enum NOT NULL,
  PRIMARY KEY (cell, dias_extra_threshold)
);

COMMENT ON TABLE markdown_policy IS
  'Sprint 7 Fase 3: tabla parametrizable de doctrina markdown. Reemplaza P17 hardcodeado en intelligence.ts:2121. Lookup: WHERE cell=X AND dias_extra > threshold ORDER BY threshold DESC LIMIT 1. Aplica solo a SKUs con abc=C o cuadrante=REVISAR + vel_ponderada>0 (filtro de elegibilidad en calc_sku_node_policy_row).';

ALTER TABLE markdown_policy ENABLE ROW LEVEL SECURITY;
CREATE POLICY markdown_policy_all ON markdown_policy FOR ALL USING (true) WITH CHECK (true);

INSERT INTO markdown_policy (cell, dias_extra_threshold, descuento_pct, liquidacion_accion) VALUES
  ('AX', 30, 0.10, 'descuento_10'), ('AX', 60, 0.25, 'liquidar_activa'), ('AX', 90, 0.40, 'precio_costo'),
  ('AY', 30, 0.10, 'descuento_10'), ('AY', 60, 0.25, 'liquidar_activa'), ('AY', 90, 0.40, 'precio_costo'),
  ('AZ', 30, 0.10, 'descuento_10'), ('AZ', 60, 0.25, 'liquidar_activa'), ('AZ', 90, 0.40, 'precio_costo'),
  ('BX', 30, 0.10, 'descuento_10'), ('BX', 60, 0.25, 'liquidar_activa'), ('BX', 90, 0.40, 'precio_costo'),
  ('BY', 30, 0.10, 'descuento_10'), ('BY', 60, 0.25, 'liquidar_activa'), ('BY', 90, 0.40, 'precio_costo'),
  ('BZ', 30, 0.10, 'descuento_10'), ('BZ', 60, 0.25, 'liquidar_activa'), ('BZ', 90, 0.40, 'precio_costo'),
  ('CX', 30, 0.10, 'descuento_10'), ('CX', 60, 0.25, 'liquidar_activa'), ('CX', 90, 0.40, 'precio_costo'),
  ('CY', 30, 0.10, 'descuento_10'), ('CY', 60, 0.25, 'liquidar_activa'), ('CY', 90, 0.40, 'precio_costo'),
  ('CZ', 30, 0.10, 'descuento_10'), ('CZ', 60, 0.25, 'liquidar_activa'), ('CZ', 90, 0.40, 'precio_costo');

ALTER TABLE sku_node_policy
  ADD COLUMN dias_extra int,
  ADD COLUMN liquidacion_accion liquidacion_accion_enum,
  ADD COLUMN liquidacion_descuento_sugerido numeric(4,3),
  ADD COLUMN liquidacion_override liquidacion_accion_enum DEFAULT NULL;

COMMENT ON COLUMN sku_node_policy.dias_extra IS
  'Sprint 7 Fase 3: dias_extra = MAX(0, ROUND(dio - target_dias_full)). Solo poblado para SKUs elegibles (abc=C o cuadrante=REVISAR + vel>0).';
COMMENT ON COLUMN sku_node_policy.liquidacion_accion IS
  'Sprint 7 Fase 3: accion de liquidación derivada por lookup en markdown_policy. NULL si no aplica liquidación.';
COMMENT ON COLUMN sku_node_policy.liquidacion_descuento_sugerido IS
  'Sprint 7 Fase 3: porcentaje sugerido (0.10/0.25/0.40). Owner aplica manualmente en pricing.';
COMMENT ON COLUMN sku_node_policy.liquidacion_override IS
  'Sprint 7 Fase 3: forzado manual del owner. Si NOT NULL, ignora cálculo automático y usa este valor.';
