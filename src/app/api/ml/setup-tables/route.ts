import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

/**
 * Create ml_shipments and ml_shipment_items tables if they don't exist.
 * Uses Supabase service role to execute DDL via rpc or direct insert test.
 * POST /api/ml/setup-tables
 */
export async function POST() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    return NextResponse.json({ error: "Missing Supabase config" }, { status: 500 });
  }

  const sb = createClient(url, key);
  const results: string[] = [];

  // Test if ml_shipments table exists by trying to select
  const { error: testShip } = await sb.from("ml_shipments").select("shipment_id").limit(1);
  if (testShip && testShip.message?.includes("does not exist")) {
    results.push("ml_shipments table does NOT exist. Please create it in Supabase SQL Editor with the SQL below.");
  } else {
    results.push("ml_shipments table exists");
  }

  // Test if ml_shipment_items table exists
  const { error: testItems } = await sb.from("ml_shipment_items").select("id").limit(1);
  if (testItems && testItems.message?.includes("does not exist")) {
    results.push("ml_shipment_items table does NOT exist. Please create it in Supabase SQL Editor with the SQL below.");
  } else {
    results.push("ml_shipment_items table exists");
  }

  const migrationSQL = `
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New Query)

-- 1. Shipments table (one row per physical package)
CREATE TABLE IF NOT EXISTS ml_shipments (
  shipment_id BIGINT PRIMARY KEY,
  order_ids BIGINT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'unknown',
  substatus TEXT,
  logistic_type TEXT NOT NULL DEFAULT 'unknown',
  handling_limit TIMESTAMPTZ,
  buffering_date TIMESTAMPTZ,
  delivery_date TIMESTAMPTZ,
  origin_type TEXT,
  store_id BIGINT,
  receiver_name TEXT,
  destination_city TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Shipment items (one row per item in a shipment)
CREATE TABLE IF NOT EXISTS ml_shipment_items (
  id SERIAL PRIMARY KEY,
  shipment_id BIGINT NOT NULL REFERENCES ml_shipments(shipment_id) ON DELETE CASCADE,
  order_id BIGINT NOT NULL,
  item_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  seller_sku TEXT NOT NULL DEFAULT '',
  variation_id BIGINT,
  quantity INT NOT NULL DEFAULT 1,
  UNIQUE(shipment_id, order_id, item_id)
);

-- 3. Indexes for fast queries
CREATE INDEX IF NOT EXISTS idx_ml_shipments_handling ON ml_shipments(handling_limit);
CREATE INDEX IF NOT EXISTS idx_ml_shipments_status ON ml_shipments(status);
CREATE INDEX IF NOT EXISTS idx_ml_shipments_logistic ON ml_shipments(logistic_type);
CREATE INDEX IF NOT EXISTS idx_ml_shipment_items_shipment ON ml_shipment_items(shipment_id);
CREATE INDEX IF NOT EXISTS idx_ml_shipments_store ON ml_shipments(store_id);

-- 4. Enable RLS (Row Level Security) — allow all for now via anon key
ALTER TABLE ml_shipments ENABLE ROW LEVEL SECURITY;
ALTER TABLE ml_shipment_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all ml_shipments" ON ml_shipments FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all ml_shipment_items" ON ml_shipment_items FOR ALL USING (true) WITH CHECK (true);
`;

  return NextResponse.json({
    status: "ok",
    results,
    migration_sql: migrationSQL,
    instructions: "Copy the migration_sql and run it in your Supabase Dashboard → SQL Editor → New Query → Run",
  });
}
