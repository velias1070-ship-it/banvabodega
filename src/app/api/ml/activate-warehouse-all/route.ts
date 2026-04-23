import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { mlPut, getDistributedStock, getItemUserProductId } from "@/lib/ml";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 60;

const STORE_ID = "73722087";
const NETWORK_NODE_ID = "CLP19538063212";
const THROTTLE_MS = 350;

/**
 * POST /api/ml/activate-warehouse-all[?dry_run=1][&limit=N]
 *
 * Bulk: encuentra todas las ml_items_map active sin ultimo_sync (ergo sin slot
 * seller_warehouse en ML) y activa el slot con quantity=0. Cada activación se
 * encola en stock_sync_queue para que el cron normal pueble el quantity real.
 *
 * Throttle 350ms entre PUTs para no quemar rate limit ML.
 */
export async function POST(req: NextRequest) {
  const dryRun = req.nextUrl.searchParams.get("dry_run") === "1";
  const limit = parseInt(req.nextUrl.searchParams.get("limit") || "100", 10);

  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const { data: targets, error: selErr } = await sb.from("ml_items_map")
    .select("id, sku, item_id, user_product_id")
    .eq("status_ml", "active")
    .eq("activo", true)
    .is("ultimo_sync", null)
    .limit(limit);

  if (selErr) {
    return NextResponse.json({ error: `select failed: ${selErr.message}` }, { status: 500 });
  }

  const list = (targets || []) as Array<{ id: string; sku: string; item_id: string; user_product_id: string | null }>;

  if (list.length === 0) {
    return NextResponse.json({ ok: true, total: 0, message: "no hay SKUs sin ultimo_sync para activar" });
  }

  if (dryRun) {
    return NextResponse.json({
      ok: true, dry_run: true, total: list.length,
      candidates: list.map(t => ({ sku: t.sku, item_id: t.item_id, user_product_id: t.user_product_id })),
    });
  }

  const startTime = Date.now();
  const TIME_LIMIT = 55_000;
  const results: Array<{ sku: string; status: string; error?: string }> = [];
  let activated = 0;
  let skipped = 0;
  let failed = 0;

  for (const map of list) {
    if (Date.now() - startTime > TIME_LIMIT) {
      results.push({ sku: "(time limit)", status: "remaining", error: `${list.length - results.length} SKUs sin procesar` });
      break;
    }

    let upId = map.user_product_id;
    if (!upId) {
      upId = await getItemUserProductId(map.item_id);
      if (!upId) { failed++; results.push({ sku: map.sku, status: "fail", error: "no user_product_id" }); continue; }
      await sb.from("ml_items_map").update({ user_product_id: upId }).eq("id", map.id);
    }

    try {
      const stockBefore = await getDistributedStock(upId);
      const hasSellerWarehouse = (stockBefore?.locations || []).some(l => l.type === "seller_warehouse");

      if (hasSellerWarehouse) {
        skipped++;
        results.push({ sku: map.sku, status: "skipped (ya tenía slot)" });
        continue;
      }

      const xVersion = String(stockBefore?.version ?? 1);
      await mlPut(
        `/user-products/${upId}/stock/type/seller_warehouse`,
        { locations: [{ store_id: STORE_ID, network_node_id: NETWORK_NODE_ID, quantity: 0 }] },
        { "x-version": xVersion },
      );

      await sb.from("stock_sync_queue")
        .upsert({ sku: map.sku, created_at: new Date().toISOString() }, { onConflict: "sku" });

      void sb.from("audit_log").insert({
        accion: "warehouse_activate:ok",
        entidad: "ml_items_map",
        entidad_id: upId,
        params: { sku: map.sku, item_id: map.item_id, x_version: xVersion, source: "bulk" },
      });

      activated++;
      results.push({ sku: map.sku, status: "activated" });
    } catch (err) {
      const msg = String(err);
      void sb.from("audit_log").insert({
        accion: "warehouse_activate:error",
        entidad: "ml_items_map",
        entidad_id: upId,
        params: { sku: map.sku, item_id: map.item_id, source: "bulk" },
        error: msg,
      });
      failed++;
      results.push({ sku: map.sku, status: "fail", error: msg.slice(0, 200) });
    }

    await new Promise(r => setTimeout(r, THROTTLE_MS));
  }

  return NextResponse.json({
    ok: true, total: list.length, activated, skipped, failed,
    results,
  });
}

export async function GET(req: NextRequest) {
  return POST(req);
}
