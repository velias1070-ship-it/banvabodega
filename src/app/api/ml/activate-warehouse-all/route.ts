import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { mlPut, getDistributedStock, getItemUserProductId } from "@/lib/ml";
import { ACTIVE_WAREHOUSE } from "@/lib/ml-warehouses";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 60;

// SSoT: src/lib/ml-warehouses.ts (Regla 5 inventory-policy)
const STORE_ID = ACTIVE_WAREHOUSE.store_id;
const NETWORK_NODE_ID = ACTIVE_WAREHOUSE.network_node_id;
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

  const authHeader = req.headers.get("authorization");
  const isVercelCron = authHeader === `Bearer ${process.env.CRON_SECRET}`;
  const isLocalDev = process.env.NODE_ENV === "development";
  const isInternal = req.headers.get("x-internal") === "1";
  const referer = req.headers.get("referer") || "";
  const isAdminCall = referer.includes("/admin");

  if (!isVercelCron && !isLocalDev && !isInternal && !isAdminCall) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  // Detección dual (Fase 2 — 2026-05-12):
  //  (a) "Nunca tuvo Flex":  ultimo_sync IS NULL (lógica original)
  //  (b) "Perdió Flex":      ultimo_sync IS NOT NULL AND last_location_types
  //                          tiene valores Y NO incluye 'seller_warehouse'.
  //      (caso histórico hoy: 22 SKUs activos con stock cuyo slot fue
  //      desactivado por ML silenciosamente — invisibles al cron original).
  //
  // IMPORTANTE: filtramos `last_location_types != '{}'` para evitar falsos
  // positivos. La columna tiene default '{}' (v112), así que un SKU que
  // jamás pasó por syncStockToML quedaría categorizado como "perdió Flex"
  // sin haber tenido nunca el cache poblado. Esa es la categoría
  // "never_had", no "lost_flex".
  const { data: targets, error: selErr } = await sb.from("ml_items_map")
    .select("id, sku, item_id, user_product_id, ultimo_sync, last_location_types")
    .eq("status_ml", "active")
    .eq("activo", true)
    .or(
      "ultimo_sync.is.null," +
      "and(ultimo_sync.not.is.null,last_location_types.neq.{},last_location_types.not.cs.{seller_warehouse})",
    )
    .limit(limit);

  if (selErr) {
    return NextResponse.json({ error: `select failed: ${selErr.message}` }, { status: 500 });
  }

  type Target = {
    id: string;
    sku: string;
    item_id: string;
    user_product_id: string | null;
    ultimo_sync: string | null;
    last_location_types: string[] | null;
  };
  const list = (targets || []) as Target[];

  // Categorizar cada SKU según qué condición lo trajo. Si ultimo_sync IS NULL,
  // entra como "never_had". Si tiene ultimo_sync pero last_location_types no
  // incluye seller_warehouse, es un "lost_flex" — la categoría más grave
  // porque significa que tuvo Flex y ML lo desactivó.
  const categoryFor = (t: Target): "never_had" | "lost_flex" => {
    if (t.ultimo_sync === null) return "never_had";
    return "lost_flex";
  };

  if (list.length === 0) {
    return NextResponse.json({
      ok: true, total: 0,
      activated_never_had: 0, activated_lost_flex: 0,
      message: "no hay SKUs candidatos a activar (ni nunca_tuvo_flex ni perdio_flex)",
    });
  }

  if (dryRun) {
    return NextResponse.json({
      ok: true, dry_run: true, total: list.length,
      by_category: {
        never_had: list.filter(t => categoryFor(t) === "never_had").length,
        lost_flex: list.filter(t => categoryFor(t) === "lost_flex").length,
      },
      candidates: list.map(t => ({
        sku: t.sku, item_id: t.item_id, user_product_id: t.user_product_id,
        category: categoryFor(t),
        last_location_types: t.last_location_types,
      })),
    });
  }

  const startTime = Date.now();
  const TIME_LIMIT = 55_000;
  const results: Array<{ sku: string; status: string; category?: "never_had" | "lost_flex"; error?: string }> = [];
  let activated = 0;
  let activated_never_had = 0;
  let activated_lost_flex = 0;
  let skipped = 0;
  let failed = 0;

  for (const map of list) {
    if (Date.now() - startTime > TIME_LIMIT) {
      results.push({ sku: "(time limit)", status: "remaining", error: `${list.length - results.length} SKUs sin procesar` });
      break;
    }

    const cat = categoryFor(map);
    let upId = map.user_product_id;
    if (!upId) {
      upId = await getItemUserProductId(map.item_id);
      if (!upId) { failed++; results.push({ sku: map.sku, status: "fail", category: cat, error: "no user_product_id" }); continue; }
      await sb.from("ml_items_map").update({ user_product_id: upId }).eq("id", map.id);
    }

    try {
      const stockBefore = await getDistributedStock(upId);
      const hasSellerWarehouse = (stockBefore?.locations || []).some(l => l.type === "seller_warehouse");

      if (hasSellerWarehouse) {
        // El cache mentía o se reparó solo entre el SELECT y el GET. Aprovechamos
        // para refrescar el cache y evitar volver a intentar este SKU.
        const freshTypes = (stockBefore?.locations || []).map(l => l.type);
        await sb.from("ml_items_map")
          .update({ last_location_types: freshTypes })
          .eq("id", map.id);
        skipped++;
        results.push({ sku: map.sku, status: "skipped (ya tenía slot)", category: cat });
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
        params: { sku: map.sku, item_id: map.item_id, x_version: xVersion, source: "bulk", category: cat },
      });

      activated++;
      if (cat === "never_had") activated_never_had++;
      else activated_lost_flex++;
      results.push({ sku: map.sku, status: "activated", category: cat });
    } catch (err) {
      const msg = String(err);
      void sb.from("audit_log").insert({
        accion: "warehouse_activate:error",
        entidad: "ml_items_map",
        entidad_id: upId,
        params: { sku: map.sku, item_id: map.item_id, source: "bulk", category: cat },
        error: msg,
      });
      failed++;
      results.push({ sku: map.sku, status: "fail", category: cat, error: msg.slice(0, 200) });
    }

    await new Promise(r => setTimeout(r, THROTTLE_MS));
  }

  // Si el cron activó SKUs de la categoría "perdió Flex", logueamos un audit_log
  // distinguible. Es la señal accionable: cuando aparece, alguien (Vicente o el
  // canal WhatsApp) debe revisar por qué ML está desactivando slots.
  if (activated_lost_flex > 0 && isVercelCron) {
    void sb.from("audit_log").insert({
      accion: "warehouse_activate:lost_flex_detected",
      params: {
        count: activated_lost_flex,
        skus: results
          .filter(r => r.status === "activated" && r.category === "lost_flex")
          .map(r => r.sku)
          .slice(0, 20),
      },
    });
  }

  return NextResponse.json({
    ok: true,
    total: list.length,
    activated,
    activated_never_had,
    activated_lost_flex,
    skipped,
    failed,
    results,
  });
}

export async function GET(req: NextRequest) {
  return POST(req);
}
