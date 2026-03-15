import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { getDistributedStock, getItemUserProductId, updateFlexStock } from "@/lib/ml";

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
 * POST — Sync specific SKUs immediately with detailed diagnostics.
 * Body: { skus: string[], quantities?: Record<string, number>, force?: boolean }
 * force=true bypasses the safety block (stock >10 → 0).
 */
export async function POST(req: NextRequest) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  try {
    const body = await req.json();
    const skus: string[] = body.skus || [];
    const overrides: Record<string, number> | undefined = body.quantities;
    const force: boolean = body.force === true;

    if (skus.length === 0) {
      return NextResponse.json({ error: "no_skus" }, { status: 400 });
    }

    let synced = 0;
    const results: Record<string, { ok: boolean; reason: string; qty?: number }> = {};

    for (const sku of skus) {
      try {
        // 1. Get mappings for this SKU
        const { data: mappings } = await sb.from("ml_items_map")
          .select("*")
          .eq("sku", sku)
          .eq("activo", true);

        if (!mappings || mappings.length === 0) {
          results[sku] = { ok: false, reason: "Sin mapeo en ml_items_map" };
          continue;
        }

        // 2. Calculate quantity to send
        let available: number;
        if (overrides && overrides[sku] !== undefined) {
          available = Math.max(0, overrides[sku]);
        } else {
          const { data: stockRows } = await sb.from("stock").select("cantidad").eq("sku", sku);
          const totalStock = (stockRows || []).reduce((s: number, r: { cantidad: number }) => s + r.cantidad, 0);
          const { data: pedidos } = await sb.from("pedidos_flex")
            .select("cantidad")
            .eq("sku_venta", sku)
            .in("estado", ["PENDIENTE", "EN_PICKING"]);
          const committed = (pedidos || []).reduce((s: number, p: { cantidad: number }) => s + p.cantidad, 0);
          available = Math.max(0, totalStock - committed);
        }

        let skuSynced = false;
        const skuErrors: string[] = [];

        for (const map of mappings) {
          // 3. Safety block check (skip if force=true)
          if (!force && available === 0 && map.ultimo_stock_enviado && map.ultimo_stock_enviado > 10) {
            skuErrors.push(`Safety block: último envío fue ${map.ultimo_stock_enviado}, ahora sería 0. Usa 'Forzar' para confirmar.`);
            continue;
          }

          // 4. Resolve user_product_id
          let userProductId = map.user_product_id;
          if (!userProductId) {
            userProductId = await getItemUserProductId(map.item_id);
            if (!userProductId) {
              skuErrors.push(`No se pudo resolver user_product_id para item ${map.item_id}`);
              continue;
            }
            await sb.from("ml_items_map").update({ user_product_id: userProductId }).eq("id", map.id);
          }

          // 5. GET current stock version
          const stockData = await getDistributedStock(userProductId);
          if (!stockData) {
            skuErrors.push(`No se pudo leer stock de ML para ${userProductId}`);
            continue;
          }

          // 6. PUT with version
          let result = await updateFlexStock(userProductId, available, stockData.version);

          // Retry on version conflict
          if (!result.ok && result.error === "VERSION_CONFLICT") {
            const freshStock = await getDistributedStock(userProductId);
            if (freshStock) {
              result = await updateFlexStock(userProductId, available, freshStock.version);
            }
          }

          if (result.ok) {
            await sb.from("ml_items_map").update({
              ultimo_sync: new Date().toISOString(),
              ultimo_stock_enviado: available,
              stock_version: (stockData.version || 0) + 1,
            }).eq("id", map.id);
            skuSynced = true;
          } else {
            skuErrors.push(`PUT falló para ${userProductId}: ${result.error || "error desconocido"}`);
          }
        }

        if (skuSynced) {
          synced++;
          results[sku] = { ok: true, reason: "OK", qty: available };
        } else {
          results[sku] = { ok: false, reason: skuErrors.join("; ") || "Error desconocido" };
        }
      } catch (err) {
        results[sku] = { ok: false, reason: String(err) };
      }
    }

    // Clear synced SKUs from queue
    const syncedSkus = Object.entries(results).filter(([, r]) => r.ok).map(([sku]) => sku);
    if (syncedSkus.length > 0) {
      await sb.from("stock_sync_queue").delete().in("sku", syncedSkus);
    }

    return NextResponse.json({ synced, total: skus.length, results });
  } catch (err) {
    console.error("[Stock Compare POST] Error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
