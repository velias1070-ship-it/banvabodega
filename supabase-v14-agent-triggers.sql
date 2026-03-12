-- =============================================================
-- V14: Agent Triggers — Sistema de triggers y reglas para agentes IA
-- =============================================================

-- Tabla de triggers
CREATE TABLE IF NOT EXISTS agent_triggers (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  agente text NOT NULL,
  nombre text NOT NULL,
  tipo text NOT NULL CHECK (tipo IN ('tiempo', 'evento', 'manual')),
  configuracion jsonb NOT NULL DEFAULT '{}',
  activo boolean DEFAULT true,
  ultima_ejecucion timestamptz,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE agent_triggers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "triggers_all" ON agent_triggers FOR ALL USING (true) WITH CHECK (true);

-- Índices
CREATE INDEX IF NOT EXISTS idx_agent_triggers_agente ON agent_triggers(agente);
CREATE INDEX IF NOT EXISTS idx_agent_triggers_tipo ON agent_triggers(tipo);
CREATE INDEX IF NOT EXISTS idx_agent_triggers_activo ON agent_triggers(activo);

-- =============================================================
-- Datos iniciales
-- =============================================================

INSERT INTO agent_triggers (agente, nombre, tipo, configuracion) VALUES
-- Reposición
('reposicion', 'Órdenes importadas', 'evento', '{"evento": "ordenes_importadas", "condicion": "cantidad_nuevas > 0"}'),
('reposicion', 'Stock proveedor actualizado', 'evento', '{"evento": "proveedor_cargado"}'),
('reposicion', 'Revisión L/J', 'tiempo', '{"intervalo": "semanal", "hora": "08:00", "dias": ["lun", "jue"]}'),
('reposicion', 'Cobertura crítica', 'evento', '{"evento": "picking_completado"}'),

-- Rentabilidad
('rentabilidad', 'Órdenes importadas', 'evento', '{"evento": "ordenes_importadas", "condicion": "cantidad_nuevas > 0"}'),
('rentabilidad', 'Costo aprobado', 'evento', '{"evento": "costo_aprobado"}'),
('rentabilidad', 'Revisión semanal', 'tiempo', '{"intervalo": "semanal", "hora": "09:00", "dias": ["lun"]}'),

-- Inventario
('inventario', 'Recepción completada', 'evento', '{"evento": "recepcion_completada"}'),
('inventario', 'Picking completado', 'evento', '{"evento": "picking_completado"}'),
('inventario', 'Conteo cíclico', 'tiempo', '{"intervalo": "diario", "hora": "08:00", "dias": ["lun", "mar", "mie", "jue", "vie", "sab"]}'),
('inventario', 'Dead stock', 'tiempo', '{"intervalo": "semanal", "hora": "08:00", "dias": ["lun"]}'),

-- Recepción
('recepcion', 'Recepción cerrada', 'evento', '{"evento": "recepcion_cerrada"}'),
('recepcion', 'Discrepancia costo', 'evento', '{"evento": "discrepancia_costo_detectada"}'),
('recepcion', 'Revisión mensual', 'tiempo', '{"intervalo": "mensual", "dia_mes": 1, "hora": "08:00"}'),

-- Observador
('observador', 'Revisión semanal', 'tiempo', '{"intervalo": "semanal", "hora": "17:00", "dias": ["vie"]}'),
('observador', 'Acciones acumuladas', 'evento', '{"evento": "acciones_acumuladas", "condicion": "count > 50"}');

-- =============================================================
-- Actualizar modelos de agentes
-- =============================================================

UPDATE agent_config SET model = 'claude-opus-4-6' WHERE id = 'orquestador';
UPDATE agent_config SET model = 'claude-sonnet-4-6' WHERE id = 'reposicion';
UPDATE agent_config SET model = 'claude-sonnet-4-6' WHERE id = 'rentabilidad';
UPDATE agent_config SET model = 'claude-sonnet-4-6' WHERE id = 'recepcion';
UPDATE agent_config SET model = 'claude-haiku-4-5-20251001' WHERE id = 'inventario';
UPDATE agent_config SET model = 'claude-haiku-4-5-20251001' WHERE id = 'observador';
