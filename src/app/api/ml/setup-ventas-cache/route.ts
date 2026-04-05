import { NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

/**
 * One-time setup: create ventas_ml_cache table.
 * Visit /api/ml/setup-ventas-cache to run.
 */
export async function GET() {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  try {
    const { error } = await sb.rpc("exec_sql", {
      sql: `
        CREATE TABLE IF NOT EXISTS ventas_ml_cache (
          id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
          order_id TEXT NOT NULL,
          order_number TEXT,
          fecha TEXT,
          fecha_date DATE,
          cliente TEXT,
          razon_social TEXT,
          sku_venta TEXT NOT NULL,
          nombre_producto TEXT,
          cantidad INTEGER DEFAULT 1,
          canal TEXT,
          precio_unitario NUMERIC DEFAULT 0,
          subtotal NUMERIC DEFAULT 0,
          comision_unitaria NUMERIC DEFAULT 0,
          comision_total NUMERIC DEFAULT 0,
          costo_envio NUMERIC DEFAULT 0,
          ingreso_envio NUMERIC DEFAULT 0,
          ingreso_adicional_tc NUMERIC DEFAULT 0,
          total NUMERIC DEFAULT 0,
          total_neto NUMERIC DEFAULT 0,
          logistic_type TEXT,
          estado TEXT,
          documento_tributario TEXT,
          estado_documento TEXT,
          created_at TIMESTAMPTZ DEFAULT now(),
          updated_at TIMESTAMPTZ DEFAULT now(),
          UNIQUE(order_id, sku_venta)
        );
        CREATE INDEX IF NOT EXISTS idx_ventas_ml_cache_fecha ON ventas_ml_cache(fecha_date);
        CREATE INDEX IF NOT EXISTS idx_ventas_ml_cache_order ON ventas_ml_cache(order_id);
        ALTER TABLE ventas_ml_cache ENABLE ROW LEVEL SECURITY;
        DO $$ BEGIN
          CREATE POLICY ventas_ml_cache_all ON ventas_ml_cache FOR ALL USING (true) WITH CHECK (true);
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$;
        NOTIFY pgrst, 'reload schema';
      `
    });

    if (error) {
      // If exec_sql RPC doesn't exist, try direct query via REST
      // The table might already exist — try a simple insert test
      const { error: testError } = await sb.from("ventas_ml_cache").select("id").limit(1);
      if (testError) {
        return NextResponse.json({ error: error.message, test_error: testError.message, hint: "Run the SQL from supabase-v37-ventas-ml-cache.sql in Supabase SQL Editor" }, { status: 500 });
      }
      return NextResponse.json({ status: "table_exists", message: "Table already exists, schema cache may need reload" });
    }

    return NextResponse.json({ status: "ok", message: "Table created successfully" });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
