-- v76: notifications_outbox
-- Outbox pattern: Vercel inserta, Viki polea cada 1m y entrega via ~/.whatsapp-channel/outbound/.
-- Genérica (whatsapp/email/slack/...) y reutilizable para todas las notificaciones futuras.
-- Retención 90d para auditoría retroactiva.

CREATE TABLE IF NOT EXISTS notifications_outbox (
  id BIGSERIAL PRIMARY KEY,
  channel TEXT NOT NULL,                      -- 'whatsapp' | 'email' | 'slack' | ...
  destination TEXT NOT NULL,                  -- chat_id, email, etc.
  payload JSONB NOT NULL,                     -- { text, attachments, ... }
  status TEXT NOT NULL DEFAULT 'pending',     -- 'pending' | 'sent' | 'failed'
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_outbox_pending
  ON notifications_outbox(created_at)
  WHERE status = 'pending';

ALTER TABLE notifications_outbox ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "permissive" ON notifications_outbox;
CREATE POLICY "permissive" ON notifications_outbox USING (true) WITH CHECK (true);
