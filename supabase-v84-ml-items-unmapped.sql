-- v84: Observabilidad de items ML que syncStockFull no logra mapear.
--
-- Contexto: catalog listings tienen seller_custom_field=null y resolveSkuVenta()
-- no los puede asociar a un producto. Antes de v84, esos items se descartaban
-- silenciosamente. Ahora la segunda pasada (herencia vía user_product_id contra
-- ml_items_map ya mapeado) cubre el caso "catalog enganchado al mismo
-- user_product que un marketplace conocido". Los que siguen unmapped post-segunda
-- pasada se persisten acá y se notifican via WhatsApp (notifications_outbox).
--
-- No reemplaza ml_items_map: items acá no participan de stock_sync ni
-- intelligence. Es solo una bandeja de entrada operativa.

CREATE TABLE IF NOT EXISTS ml_items_unmapped (
  item_id text PRIMARY KEY,
  titulo text,
  user_product_id text,
  catalog_listing boolean NOT NULL DEFAULT false,
  status_ml text,
  primera_vez_visto timestamptz NOT NULL DEFAULT now(),
  ultima_vez_visto timestamptz NOT NULL DEFAULT now(),
  notificado boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ml_items_unmapped_pendientes
  ON ml_items_unmapped(ultima_vez_visto DESC)
  WHERE notificado = false;

CREATE INDEX IF NOT EXISTS idx_ml_items_unmapped_user_product
  ON ml_items_unmapped(user_product_id)
  WHERE user_product_id IS NOT NULL;

ALTER TABLE ml_items_unmapped ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "permissive" ON ml_items_unmapped;
CREATE POLICY "permissive" ON ml_items_unmapped USING (true) WITH CHECK (true);
