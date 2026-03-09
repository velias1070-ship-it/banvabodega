-- ============================================
-- BANVA WMS — v11: Arquitectura de Agentes IA
-- ============================================

-- Tabla agent_config — Configuración de cada agente
CREATE TABLE IF NOT EXISTS agent_config (
  id text PRIMARY KEY, -- 'reposicion', 'inventario', 'rentabilidad', 'recepcion', 'orquestador'
  nombre_display text NOT NULL,
  descripcion text,
  model text DEFAULT 'claude-sonnet-4-20250514',
  system_prompt_base text,
  activo boolean DEFAULT true,
  max_tokens_input integer DEFAULT 50000,
  max_tokens_output integer DEFAULT 4000,
  schedule text, -- cron expression nullable
  last_run_at timestamptz,
  last_run_tokens integer,
  last_run_cost_usd numeric,
  config_extra jsonb DEFAULT '{}',
  updated_at timestamptz DEFAULT now()
);

-- Tabla agent_insights — Lo que producen los agentes
CREATE TABLE IF NOT EXISTS agent_insights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agente text REFERENCES agent_config(id),
  run_id uuid,
  tipo text CHECK (tipo IN ('alerta', 'sugerencia', 'analisis', 'resumen')),
  severidad text CHECK (severidad IN ('critica', 'alta', 'media', 'info')),
  categoria text,
  titulo text NOT NULL,
  contenido text,
  datos jsonb,
  skus_relacionados text[],
  estado text DEFAULT 'nuevo' CHECK (estado IN ('nuevo', 'visto', 'aceptado', 'rechazado', 'corregido')),
  feedback_texto text,
  feedback_at timestamptz,
  created_at timestamptz DEFAULT now(),
  expires_at timestamptz
);

-- Tabla agent_rules — Reglas aprendidas por feedback
CREATE TABLE IF NOT EXISTS agent_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agente text REFERENCES agent_config(id),
  regla text NOT NULL,
  contexto text,
  origen text CHECK (origen IN ('feedback_admin', 'manual', 'sistema')),
  origen_insight_id uuid REFERENCES agent_insights(id),
  prioridad integer DEFAULT 5,
  veces_aplicada integer DEFAULT 0,
  activa boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Tabla agent_runs — Registro de cada ejecución
CREATE TABLE IF NOT EXISTS agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agente text REFERENCES agent_config(id),
  trigger text CHECK (trigger IN ('cron', 'manual', 'evento', 'chat')),
  estado text DEFAULT 'corriendo' CHECK (estado IN ('corriendo', 'completado', 'error')),
  tokens_input integer,
  tokens_output integer,
  costo_usd numeric,
  duracion_ms integer,
  insights_generados integer,
  error_mensaje text,
  datos_snapshot_hash text,
  created_at timestamptz DEFAULT now(),
  completed_at timestamptz
);

-- Tabla agent_conversations — Chat con el orquestador
CREATE TABLE IF NOT EXISTS agent_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL,
  role text CHECK (role IN ('user', 'assistant')),
  contenido text NOT NULL,
  agentes_invocados text[],
  tokens_usados integer,
  created_at timestamptz DEFAULT now()
);

-- Tabla agent_data_snapshots — Snapshots para reproducibilidad
CREATE TABLE IF NOT EXISTS agent_data_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo text NOT NULL,
  hash text UNIQUE NOT NULL,
  datos jsonb,
  created_at timestamptz DEFAULT now()
);

-- ============================================
-- Índices
-- ============================================
CREATE INDEX IF NOT EXISTS idx_agent_insights_agente_estado ON agent_insights(agente, estado, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_insights_skus ON agent_insights USING GIN(skus_relacionados);
CREATE INDEX IF NOT EXISTS idx_agent_rules_agente ON agent_rules(agente, activa);
CREATE INDEX IF NOT EXISTS idx_agent_runs_agente ON agent_runs(agente, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_conversations_session ON agent_conversations(session_id, created_at);

-- ============================================
-- RLS — Políticas permisivas (igual que el resto del sistema)
-- ============================================
ALTER TABLE agent_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_insights ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_data_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agent_config_all" ON agent_config FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "agent_insights_all" ON agent_insights FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "agent_rules_all" ON agent_rules FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "agent_runs_all" ON agent_runs FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "agent_conversations_all" ON agent_conversations FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "agent_data_snapshots_all" ON agent_data_snapshots FOR ALL USING (true) WITH CHECK (true);

-- ============================================
-- Datos iniciales — Configuración de agentes
-- ============================================
INSERT INTO agent_config (id, nombre_display, descripcion, model, system_prompt_base, config_extra) VALUES
(
  'reposicion',
  'Reposición',
  'Analiza stock, velocidad de venta y cobertura para sugerir reposición a Full y pedidos a proveedor',
  'claude-sonnet-4-20250514',
  'Eres un analista experto en gestión de inventario y reposición para un warehouse de e-commerce en Chile (MercadoLibre).

Tu trabajo es analizar los datos de stock, velocidad de venta por canal (Full y Flex), cobertura en días, y datos de proveedor para generar insights accionables.

Prioridades:
1. Detectar SKUs agotados o por agotarse (cobertura < 14 días) — severidad crítica o alta
2. Identificar oportunidades de envío a Full (stock en bodega sin enviar)
3. Alertar sobre exceso de stock (cobertura > 60 días)
4. Sugerir pedidos a proveedor cuando el stock total es insuficiente
5. Detectar anomalías en velocidad (cambios bruscos semana a semana)
6. Identificar SKUs donde la distribución Full/Flex no es óptima según márgenes

Reglas de negocio:
- Punto de reorden: 14 días de cobertura
- Objetivo de cobertura: 45 días (o 30 días si margen Flex > margen Full)
- Cobertura máxima antes de exceso: 60 días
- Los envíos a Full deben respetar inner_pack del producto
- Considerar que Full tiene tiempo de procesamiento (no es inmediato)',
  '{"cobObjetivo": 45, "puntoReorden": 14, "cobMaxima": 60}'
),
(
  'inventario',
  'Inventario',
  'Analiza discrepancias de stock, sugiere conteos cíclicos prioritarios y detecta anomalías',
  'claude-sonnet-4-20250514',
  'Eres un analista experto en control de inventario para un warehouse de e-commerce en Chile.

Tu trabajo es analizar el estado del inventario, detectar discrepancias, sugerir conteos cíclicos prioritarios y encontrar anomalías.

Prioridades:
1. SKUs con discrepancias recientes en conteos — severidad alta
2. SKUs de alta rotación sin conteo reciente (>30 días) — sugerir conteo
3. Posiciones con múltiples SKUs que podrían generar confusión
4. Stock negativo o cero en SKUs activos (con ventas recientes)
5. Movimientos inusuales (cantidades atípicas, horarios fuera de rango)
6. SKUs sin etiquetar que requieren etiqueta

Responde con sugerencias específicas de conteo para el día, priorizando por impacto en ventas.',
  '{}'
),
(
  'rentabilidad',
  'Rentabilidad',
  'Analiza márgenes por SKU y canal, detecta productos no rentables y sugiere optimizaciones',
  'claude-sonnet-4-20250514',
  'Eres un analista experto en rentabilidad de e-commerce para un seller de MercadoLibre Chile.

Tu trabajo es analizar márgenes por SKU y por canal (Full vs Flex), detectar productos no rentables, y sugerir optimizaciones de distribución.

Prioridades:
1. SKUs con margen negativo — severidad crítica
2. SKUs donde el canal actual no es el óptimo (ej: vendiendo por Full cuando Flex es más rentable)
3. Tendencias de margen: SKUs cuyo margen está bajando semana a semana
4. Oportunidades de mejora: productos con buen margen que podrían vender más
5. Costos de envío anómalos
6. Impacto de comisiones ML en la rentabilidad

Usa datos concretos: porcentajes, montos en CLP, comparaciones.',
  '{}'
),
(
  'recepcion',
  'Recepción',
  'Analiza recepciones de mercadería, detecta discrepancias de costo y cantidad con proveedores',
  'claude-sonnet-4-20250514',
  'Eres un analista experto en recepción de mercadería y control de proveedores para un warehouse en Chile.

Tu trabajo es analizar las recepciones recientes, detectar patrones de discrepancias y sugerir acciones correctivas.

Prioridades:
1. Discrepancias de cantidad recurrentes por proveedor — severidad alta
2. Discrepancias de costo > 2% entre factura y precio esperado
3. Recepciones pendientes o atrasadas
4. Proveedores con patrón de envíos incompletos
5. Productos que frecuentemente llegan dañados o con SKU erróneo
6. Tiempos de recepción anómalos (muy lentos o muy rápidos)

Sugiere acciones concretas: reclamar, actualizar precio, cambiar proveedor, etc.',
  '{}'
),
(
  'orquestador',
  'Orquestador',
  'Agente conversacional que responde preguntas del admin integrando insights de todos los agentes',
  'claude-sonnet-4-20250514',
  'Eres el asistente de gestión de BANVA Bodega, un warehouse de e-commerce en Chile que vende por MercadoLibre (Full y Flex).

Tienes acceso a insights generados por agentes especializados:
- **Reposición**: stock, velocidad, cobertura, envíos a Full, pedidos a proveedor
- **Inventario**: discrepancias, conteos cíclicos, anomalías de stock
- **Rentabilidad**: márgenes por SKU y canal, optimización de distribución
- **Recepción**: discrepancias con proveedores, costos, calidad

Responde en español, de forma concisa y accionable. Cuando cites datos, sé específico (SKUs, números, fechas). Si no tienes datos suficientes para responder, dilo claramente.

Puedes sugerir ejecutar un agente específico si la pregunta requiere datos frescos.',
  '{}'
)
ON CONFLICT (id) DO NOTHING;
