-- =============================================================================
-- Sprint 1 — Multi-bodega foundation: nodes + lanes + sku_node_policy + views
-- =============================================================================
-- Owner: Vicente Elías
-- Fecha: 2026-05-02
-- Decisiones cerradas: H5 Camino C (Reposición v2 lee sku_node_policy; Pricing/
--   markdown sigue en sku_intelligence hasta Sprint 6). Plural inglés (3A).
--   YYYYMMDDHHMMSS (4B). CDMP (1A).
--
-- Aditivo: NO modifica filas en tablas existentes. Sólo CREATE TYPE/TABLE/VIEW
-- + INSERT seeds + COMMENT. Rollback: DROP en orden inverso (ver baseline.json).
--
-- Validación: tests/sprint1_validation.sql (12 tests). Doc: docs/sprints/sprint-1-...md.
-- Frontera Reposición/Pricing: docs/policies/frontera-reposicion-pricing.md.
-- =============================================================================

-- STEP 1: Enums de tipo (CDMP físico).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='node_type_enum') THEN
    CREATE TYPE node_type_enum AS ENUM ('warehouse','fulfillment','supplier_ref');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='lane_type_enum') THEN
    CREATE TYPE lane_type_enum AS ENUM ('inbound','transfer','outbound');
  END IF;
END $$;

COMMENT ON TYPE node_type_enum IS
  'Tipo de nodo logístico. warehouse=bodega propia (BANVA Central). fulfillment=Full ML (gestión ML). supplier_ref=referencia a proveedor (no inventario propio, usado para lanes inbound).';

COMMENT ON TYPE lane_type_enum IS
  'Tipo de lane (arco logístico). inbound=proveedor→nodo propio. transfer=nodo propio→nodo propio. outbound=nodo propio→cliente final (no usado todavía, reservado).';


-- STEP 2: Tabla nodes (CDMP físico — concepto "Nodo Logístico").
CREATE TABLE IF NOT EXISTS nodes (
  id           text PRIMARY KEY,
  display_name text NOT NULL,
  node_type    node_type_enum NOT NULL,
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  nodes IS
  'Nodos logísticos del modelo multi-bodega (Sprint 1, decisión H5 Camino C). Hoy: bodega_central + full_ml + supplier_generic. Futuro: full_ml_split por bodega Full real (Colina, Tucapel...), bodega_outlet, etc.';
COMMENT ON COLUMN nodes.id           IS 'PK textual (snake_case). Usada como FK en lanes/sku_node_policy/views.';
COMMENT ON COLUMN nodes.display_name IS 'Etiqueta legible para UI (admin panel reposición Sprint 2+).';
COMMENT ON COLUMN nodes.node_type    IS 'warehouse | fulfillment | supplier_ref. Determina semántica de stock (propio / ML-managed / no-inventario).';


-- STEP 3: Tabla lanes (CDMP físico — concepto "Lane / Arco Logístico").
CREATE TABLE IF NOT EXISTS lanes (
  id              text PRIMARY KEY,
  from_node_id    text NOT NULL REFERENCES nodes(id),
  to_node_id      text NOT NULL REFERENCES nodes(id),
  lane_type       lane_type_enum NOT NULL,
  lead_time_days  integer NOT NULL CHECK (lead_time_days >= 0),
  cost_factor     numeric(10,4) DEFAULT 0 CHECK (cost_factor >= 0),
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (from_node_id <> to_node_id)
);

CREATE INDEX IF NOT EXISTS idx_lanes_from_to ON lanes(from_node_id, to_node_id);

COMMENT ON TABLE  lanes IS
  'Arcos del grafo logístico (Sprint 1). Cada lane = par origen/destino con lead time y cost factor. Usado por SS King Method (Sprint 2) y forecast ROP (Sprint 2+).';
COMMENT ON COLUMN lanes.lead_time_days IS 'Lead time típico en días calendario. Override a nivel SKU vía sku_node_policy.lead_time_override_days.';
COMMENT ON COLUMN lanes.cost_factor   IS 'Reservado para Sprint 4+ (cost-aware optimization). 0 = no usar todavía.';


-- STEP 4: Tabla sku_node_policy (CDMP físico — concepto "Política por SKU×Nodo").
-- Composite PK (sku_origen, node_id). Reposición v2 (Sprint 2) lee desde acá.
-- Default = lookup por celda ABC×XYZ + node_type en policy_templates.
CREATE TABLE IF NOT EXISTS sku_node_policy (
  sku_origen                 text NOT NULL REFERENCES productos(sku),
  node_id                    text NOT NULL REFERENCES nodes(id),
  service_level_override     numeric(4,3),
  z_value_override           numeric(4,3),
  target_dias_override       integer,
  reorder_action_override    policy_action_enum,
  lead_time_override_days    integer,
  rampup_factor_override     numeric(4,3),
  override_reason            text,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sku_origen, node_id)
);

CREATE INDEX IF NOT EXISTS idx_sku_node_policy_node ON sku_node_policy(node_id);

COMMENT ON TABLE  sku_node_policy IS
  'Overrides por SKU×Nodo sobre policy_templates (celda ABC×XYZ). Sin filas = el motor usa el template canónico para esa celda. Sprint 2 (Reposición v2) lee desde acá.';
COMMENT ON COLUMN sku_node_policy.service_level_override  IS 'Override puntual del service_level de la celda. NULL = usar template.';
COMMENT ON COLUMN sku_node_policy.z_value_override        IS 'Override del z (King Method). NULL = usar template.';
COMMENT ON COLUMN sku_node_policy.target_dias_override    IS 'Override del target_dias_full. NULL = usar template.';
COMMENT ON COLUMN sku_node_policy.reorder_action_override IS 'Override de la acción canónica (compra_proveedor, restock_full_desde_central, etc.). NULL = usar template.';
COMMENT ON COLUMN sku_node_policy.lead_time_override_days IS 'Override del lead time del lane que alimenta este nodo. NULL = usar lanes.lead_time_days.';
COMMENT ON COLUMN sku_node_policy.rampup_factor_override  IS 'Override del rampup post-quiebre (PRs #261-264). NULL = usar default por celda.';
COMMENT ON COLUMN sku_node_policy.override_reason         IS 'Justificación libre. Obligatorio si hay al menos un override no-NULL (validación a nivel app, no enforced por trigger).';


-- STEP 5: Seeds — 3 nodos canónicos + 2 lanes operativos.
INSERT INTO nodes (id, display_name, node_type, notes) VALUES
  ('bodega_central',   'Bodega BANVA Central', 'warehouse',    'Bodega propia. SSoT operativa (stock table). Punto de despacho Flex y de inbound a Full.'),
  ('full_ml',          'Full MercadoLibre',    'fulfillment',  'Bodegas Full agregadas (Colina + otras). Stock ML-managed; lectura via stock_full_cache.'),
  ('supplier_generic', 'Proveedores',          'supplier_ref', 'Nodo agregado de proveedores. No tiene stock propio; lane inbound representa OCs en tránsito.')
ON CONFLICT (id) DO NOTHING;

INSERT INTO lanes (id, from_node_id, to_node_id, lane_type, lead_time_days, notes) VALUES
  ('supplier_to_bodega', 'supplier_generic', 'bodega_central', 'inbound',  21, 'Lead time típico textil Chile (recepción factura + transporte). Override por SKU vía sku_node_policy.lead_time_override_days.'),
  ('bodega_to_full',     'bodega_central',   'full_ml',        'transfer', 5,  'Inbound a Full ML (handover ML transit + ingreso bodega Colina). Reposición v2 usará este lead time para target_dias_full.')
ON CONFLICT (id) DO NOTHING;


-- STEP 6: VIEW v_stock_por_nodo (CDMP modelo lógico — "Stock unificado por SKU×Nodo").
-- Lee SOLO de fuentes canónicas (Regla 5 inventory-policy.md): stock + stock_full_cache.
-- NO lee ml_items_map.stock_full_cache (deprecada en v58, sync espejo).
-- Bodega central agrega por sku_origen. Full ML expande sku_venta vía composicion_venta
-- y suma al sku_origen correspondiente. SKUs sin composición se cuentan como
-- sku_origen=sku_venta (auto-heal trivial, project_banva_sku_sync_autoheal).
CREATE OR REPLACE VIEW v_stock_por_nodo AS
  WITH stock_bodega AS (
    SELECT
      UPPER(TRIM(s.sku))                AS sku_origen,
      'bodega_central'::text            AS node_id,
      SUM(s.cantidad)::numeric          AS qty_on_hand,
      SUM(COALESCE(s.qty_reserved, 0))::numeric AS qty_reserved,
      MAX(s.updated_at)                 AS as_of
    FROM stock s
    GROUP BY UPPER(TRIM(s.sku))
  ),
  -- Full con composición → expandimos a sku_origen, ponderado por unidades.
  stock_full_via_composicion AS (
    SELECT
      UPPER(TRIM(cv.sku_origen))                                                    AS sku_origen,
      'full_ml'::text                                                               AS node_id,
      SUM((sfc.cantidad * COALESCE(cv.unidades, 1))::numeric)                       AS qty_on_hand,
      0::numeric                                                                    AS qty_reserved,
      MAX(sfc.updated_at)                                                           AS as_of
    FROM stock_full_cache sfc
    JOIN composicion_venta cv ON UPPER(TRIM(cv.sku_venta)) = UPPER(TRIM(sfc.sku_venta))
    GROUP BY UPPER(TRIM(cv.sku_origen))
  ),
  -- Full sin composición (orphan) → tratamos sku_venta como sku_origen.
  stock_full_directo AS (
    SELECT
      UPPER(TRIM(sfc.sku_venta))    AS sku_origen,
      'full_ml'::text               AS node_id,
      sfc.cantidad::numeric         AS qty_on_hand,
      0::numeric                    AS qty_reserved,
      sfc.updated_at                AS as_of
    FROM stock_full_cache sfc
    WHERE NOT EXISTS (
      SELECT 1 FROM composicion_venta cv
      WHERE UPPER(TRIM(cv.sku_venta)) = UPPER(TRIM(sfc.sku_venta))
    )
  ),
  stock_full_unificado AS (
    SELECT sku_origen, node_id, SUM(qty_on_hand)::numeric AS qty_on_hand,
           SUM(qty_reserved)::numeric AS qty_reserved, MAX(as_of) AS as_of
    FROM (
      SELECT * FROM stock_full_via_composicion
      UNION ALL
      SELECT * FROM stock_full_directo
    ) u
    GROUP BY sku_origen, node_id
  )
  SELECT * FROM stock_bodega
  UNION ALL
  SELECT * FROM stock_full_unificado;

COMMENT ON VIEW v_stock_por_nodo IS
  'Stock unificado por SKU×Nodo (Sprint 1). Fuentes canónicas: stock (bodega_central, agregado por UPPER(TRIM(sku))) y stock_full_cache (full_ml, expandido vía composicion_venta o sku_venta directo si sin composición). NO lee ml_items_map.stock_full_cache (DEPRECADA v58). qty_reserved=0 para Full (ML lo gestiona).';


-- STEP 7: VIEW v_in_transit_por_nodo (Sprint 1 — OCs como inbound a bodega_central).
-- Estados canónicos del motor (intelligence-queries.ts:384): PENDIENTE, EN_TRANSITO,
-- RECIBIDA_PARCIAL. Sólo cuenta líneas con saldo (cantidad_pedida > cantidad_recibida).
-- ETA = fecha_esperada (nullable). Sprint 2 podrá derivar ETA de fecha_emision +
-- lead_time del lane si fecha_esperada es NULL.
CREATE OR REPLACE VIEW v_in_transit_por_nodo AS
  SELECT
    UPPER(TRIM(ocl.sku_origen))                                                     AS sku_origen,
    'bodega_central'::text                                                          AS to_node_id,
    'supplier_generic'::text                                                        AS from_node_id,
    'supplier_to_bodega'::text                                                      AS lane_id,
    SUM((ocl.cantidad_pedida - COALESCE(ocl.cantidad_recibida, 0))::numeric)        AS qty_in_transit,
    MIN(oc.fecha_esperada)                                                          AS earliest_eta,
    MIN(oc.fecha_emision)                                                           AS earliest_fecha_emision
  FROM ordenes_compra_lineas ocl
  JOIN ordenes_compra oc ON oc.id = ocl.orden_id
  WHERE oc.estado IN ('PENDIENTE', 'EN_TRANSITO', 'RECIBIDA_PARCIAL')
    AND ocl.cantidad_pedida > COALESCE(ocl.cantidad_recibida, 0)
  GROUP BY UPPER(TRIM(ocl.sku_origen));

COMMENT ON VIEW v_in_transit_por_nodo IS
  'Inbound a bodega_central desde proveedores (Sprint 1). Suma saldo OCs abiertas. Estados alineados con intelligence-queries.ts:384 (PENDIENTE/EN_TRANSITO/RECIBIDA_PARCIAL). earliest_eta de fecha_esperada (nullable). Reposición v2 (Sprint 2) lo cruza con v_stock_por_nodo para calcular cobertura efectiva.';


-- STEP 8: Tabla sentinel para auditoría de lecturas a columnas/tablas legacy.
-- Sprint 2+ usa esto para vigilar si algún consumer todavía lee la columna
-- ml_items_map.stock_full_cache (DEPRECADA v58) o el campo legacy
-- ordenes_compra.fecha_emitida (que nunca existió pero el spec original lo
-- mencionaba — registramos el alias para detectar copia-paste futura).
CREATE TABLE IF NOT EXISTS _deprecated_column_reads (
  id           bigserial PRIMARY KEY,
  source_path  text NOT NULL,
  column_path  text NOT NULL,
  detected_at  timestamptz NOT NULL DEFAULT now(),
  notes        text
);

COMMENT ON TABLE _deprecated_column_reads IS
  'Registro append-only de lecturas a columnas/tablas deprecadas detectadas en runtime (Sprint 2+ instrumentation). Insertar fila desde código cuando se detecte un consumer leyendo legacy. Permite priorizar limpieza por frecuencia real, no por suposición.';


-- =============================================================================
-- Fin migración Sprint 1.
-- Ver tests/sprint1_validation.sql para validaciones post-deploy (12 tests).
-- =============================================================================
