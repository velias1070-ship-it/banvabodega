import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { mlPut, getDistributedStock, getItemUserProductId } from "@/lib/ml";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const STORE_ID = "73722087";
const NETWORK_NODE_ID = "CLP19538063212";

/**
 * POST /api/ml/activate-warehouse?sku=XXX[&qty=0][&dry_run=1]
 *
 * Para SKUs cuyo user_product en ML no tiene seller_warehouse declarado
 * (ergo el cron de stock-sync sale con no_stock_type), hace el PUT inicial
 * con x-version=1 para CREAR el slot. Una vez creado, el cron normal lo
 * va a poblar con la quantity real en el siguiente tick.
 *
 * Default: qty=0 (solo activa el slot, no toca venta).
 * dry_run=1: muestra qué haría sin pegarle a ML.
 */
export async function POST(req: NextRequest) {
  const sku = req.nextUrl.searchParams.get("sku")?.toUpperCase();
  const qty = parseInt(req.nextUrl.searchParams.get("qty") || "0", 10);
  const dryRun = req.nextUrl.searchParams.get("dry_run") === "1";

  if (!sku) return NextResponse.json({ error: "falta ?sku=XXX" }, { status: 400 });

  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no supabase" }, { status: 500 });

  const { data: maps } = await sb.from("ml_items_map")
    .select("id, sku, item_id, user_product_id, ultimo_sync, status_ml, inventory_id")
    .eq("sku", sku)
    .eq("activo", true);

  if (!maps || maps.length === 0) {
    return NextResponse.json({ error: `SKU "${sku}" no encontrado en ml_items_map activo` });
  }

  const results: unknown[] = [];

  for (const map of maps as Array<{ id: string; sku: string; item_id: string; user_product_id: string | null; ultimo_sync: string | null; status_ml: string | null; inventory_id: string | null }>) {
    let upId = map.user_product_id;
    if (!upId) {
      upId = await getItemUserProductId(map.item_id);
      if (!upId) {
        results.push({ sku, item_id: map.item_id, error: "no se pudo resolver user_product_id" });
        continue;
      }
      await sb.from("ml_items_map").update({ user_product_id: upId }).eq("id", map.id);
    }

    const stockBefore = await getDistributedStock(upId);
    const hasSellerWarehouse = (stockBefore?.locations || []).some(l => l.type === "seller_warehouse");

    const body = {
      locations: [
        { store_id: STORE_ID, network_node_id: NETWORK_NODE_ID, quantity: qty },
      ],
    };

    if (dryRun) {
      results.push({
        sku, item_id: map.item_id, user_product_id: upId,
        ya_tiene_seller_warehouse: hasSellerWarehouse,
        stock_actual: stockBefore?.locations,
        version_actual: stockBefore?.version,
        body_que_se_enviaria: body,
        x_version_que_se_enviaria: String(stockBefore?.version ?? 1),
        dry_run: true,
      });
      continue;
    }

    if (hasSellerWarehouse) {
      results.push({
        sku, item_id: map.item_id, user_product_id: upId,
        skipped: "ya tiene seller_warehouse — usar el cron normal",
      });
      continue;
    }

    try {
      const xVersion = String(stockBefore?.version ?? 1);
      const resp = await mlPut(
        `/user-products/${upId}/stock/type/seller_warehouse`,
        body,
        { "x-version": xVersion },
      );

      const stockAfter = await getDistributedStock(upId);

      void sb.from("audit_log").insert({
        accion: "warehouse_activate:ok",
        entidad: "ml_items_map",
        entidad_id: upId,
        params: { sku, item_id: map.item_id, body, x_version: xVersion, locations_after: stockAfter?.locations },
      });

      results.push({
        sku, item_id: map.item_id, user_product_id: upId,
        ok: true,
        x_version_enviado: xVersion,
        ml_response: resp,
        stock_after: stockAfter?.locations,
      });
    } catch (err) {
      const msg = String(err);
      void sb.from("audit_log").insert({
        accion: "warehouse_activate:error",
        entidad: "ml_items_map",
        entidad_id: upId,
        params: { sku, item_id: map.item_id, body },
        error: msg,
      });
      results.push({
        sku, item_id: map.item_id, user_product_id: upId,
        ok: false,
        error: msg,
      });
    }
  }

  return NextResponse.json({ ok: true, results });
}

export async function GET(req: NextRequest) {
  return POST(req);
}
