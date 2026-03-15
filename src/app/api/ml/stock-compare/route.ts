import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { getDistributedStock, syncStockToML } from "@/lib/ml";

interface CompareRow {
  sku: string;
  item_id: string;
  user_product_id: string | null;
  stock_wms: number;
  stock_flex_ml: number;
  stock_full_ml: number;
  ultimo_sync: string | null;
  ultimo_stock_enviado: number | null;
}

/**
 * GET — Compare WMS stock vs ML stock for all mapped SKUs.
 * Returns array of { sku, item_id, stock_wms, stock_flex_ml, stock_full_ml, ... }
 */
export async function GET() {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  try {
    // 1. Fetch all active ML item mappings
    const { data: mappings } = await sb.from("ml_items_map")
      .select("*")
      .eq("activo", true)
      .order("sku");

    if (!mappings || mappings.length === 0) {
      return NextResponse.json({ rows: [], message: "No hay SKUs mapeados a ML" });
    }

    // 2. Fetch WMS stock for all SKUs
    const skus = Array.from(new Set(mappings.map((m: { sku: string }) => m.sku)));
    const { data: stockRows } = await sb.from("stock").select("sku, cantidad").in("sku", skus);
    const wmsStock: Record<string, number> = {};
    for (const r of stockRows || []) {
      wmsStock[r.sku] = (wmsStock[r.sku] || 0) + r.cantidad;
    }

    // 3. For each mapping, get ML distributed stock
    const rows: CompareRow[] = [];

    for (const map of mappings) {
      const upId = map.user_product_id;
      let flexQty = 0;
      let fullQty = 0;

      if (upId) {
        try {
          const stockData = await getDistributedStock(upId);
          if (stockData) {
            for (const loc of stockData.locations) {
              if (loc.type === "selling_address") flexQty = loc.quantity;
              if (loc.type === "meli_facility") fullQty = loc.quantity;
            }
          }
        } catch {
          // If ML API fails for this item, show 0
        }
      }

      rows.push({
        sku: map.sku,
        item_id: map.item_id,
        user_product_id: upId || null,
        stock_wms: wmsStock[map.sku] || 0,
        stock_flex_ml: flexQty,
        stock_full_ml: fullQty,
        ultimo_sync: map.ultimo_sync || null,
        ultimo_stock_enviado: map.ultimo_stock_enviado ?? null,
      });
    }

    return NextResponse.json({ rows });
  } catch (err) {
    console.error("[Stock Compare] Error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/**
 * POST — Sync specific SKUs immediately.
 * Body: { skus: string[], quantities?: Record<string, number> }
 * If quantities provided, use those. Otherwise calculate from WMS stock.
 */
export async function POST(req: NextRequest) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  try {
    const body = await req.json();
    const skus: string[] = body.skus || [];
    const overrides: Record<string, number> | undefined = body.quantities;

    if (skus.length === 0) {
      return NextResponse.json({ error: "no_skus" }, { status: 400 });
    }

    let synced = 0;
    const errors: string[] = [];

    for (const sku of skus) {
      try {
        let available: number;

        if (overrides && overrides[sku] !== undefined) {
          // Use override quantity (what the user wants to set in Flex)
          available = Math.max(0, overrides[sku]);
        } else {
          // Calculate: total WMS stock - committed
          const { data: stockRows } = await sb.from("stock").select("cantidad").eq("sku", sku);
          const totalStock = (stockRows || []).reduce((s: number, r: { cantidad: number }) => s + r.cantidad, 0);

          const { data: pedidos } = await sb.from("pedidos_flex")
            .select("cantidad")
            .eq("sku_venta", sku)
            .in("estado", ["PENDIENTE", "EN_PICKING"]);
          const committed = (pedidos || []).reduce((s: number, p: { cantidad: number }) => s + p.cantidad, 0);

          available = Math.max(0, totalStock - committed);
        }

        const count = await syncStockToML(sku, available);
        if (count > 0) synced++;
      } catch (err) {
        errors.push(`${sku}: ${String(err)}`);
      }
    }

    // Clear synced SKUs from queue
    if (skus.length > 0) {
      await sb.from("stock_sync_queue").delete().in("sku", skus);
    }

    return NextResponse.json({ synced, total: skus.length, errors: errors.length > 0 ? errors : undefined });
  } catch (err) {
    console.error("[Stock Compare POST] Error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
