-- v51: Tabla para persistir cargos CFWA (almacenamiento Full) diarios de ML.
-- Upsertada por cron diario que consulta /billing/integration/periods/*/details?subtypes=CFWA.
-- Los montos son BRUTOS (con IVA incluido) — ver project_ml_billing_api.md.

CREATE TABLE IF NOT EXISTS ml_billing_cfwa (
  detail_id bigint PRIMARY KEY,
  day date NOT NULL,
  amount numeric(12,2) NOT NULL,
  gross numeric(12,2),
  discount numeric(12,2),
  creation_date_time timestamptz,
  document_id bigint,
  legal_document_number text,
  legal_document_status text,
  period_key date NOT NULL,
  marketplace text,
  transaction_detail text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ml_billing_cfwa_day ON ml_billing_cfwa(day);
CREATE INDEX IF NOT EXISTS idx_ml_billing_cfwa_period ON ml_billing_cfwa(period_key);

ALTER TABLE ml_billing_cfwa ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ml_billing_cfwa_read" ON ml_billing_cfwa;
CREATE POLICY "ml_billing_cfwa_read" ON ml_billing_cfwa FOR SELECT USING (true);

DROP POLICY IF EXISTS "ml_billing_cfwa_write" ON ml_billing_cfwa;
CREATE POLICY "ml_billing_cfwa_write" ON ml_billing_cfwa FOR ALL USING (true) WITH CHECK (true);

-- Estado del último sync (para diagnóstico y detección de gaps).
CREATE TABLE IF NOT EXISTS ml_billing_cfwa_sync_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ran_at timestamptz DEFAULT now(),
  periods_scanned text[],
  rows_upserted int,
  rows_unchanged int,
  errors text,
  ms bigint
);

ALTER TABLE ml_billing_cfwa_sync_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ml_billing_cfwa_sync_log_all" ON ml_billing_cfwa_sync_log;
CREATE POLICY "ml_billing_cfwa_sync_log_all" ON ml_billing_cfwa_sync_log FOR ALL USING (true) WITH CHECK (true);
