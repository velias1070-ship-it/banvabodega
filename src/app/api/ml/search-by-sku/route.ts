import { NextRequest, NextResponse } from "next/server";
import { mlGet } from "@/lib/ml";
import { getServerSupabase } from "@/lib/supabase-server";

/**
 * Busca items ML por seller_sku SIN filtrar por status (incluye closed,
 * under_review, inactive). Complemento al sync regular que solo trae
 * active+paused y deja items cerrados invisibles en ml_items_map.
 *
 * GET  /api/ml/search-by-sku?sku=XXX
 *   -> Lista items ML que matchean el seller_sku, cualquiera sea su status.
 *
 * POST /api/ml/search-by-sku
 *   body: { sku, item_id, sku_venta? }
 *   -> Crea/actualiza mapping en ml_items_map (activo=true). El sync
 *      siguiente completa el resto de los campos (titulo, price, etc).
 */

interface MLSearchResult {
  id: string;
  title: string;
  status: string;
  available_quantity: number;
  last_updated: string;
  permalink: string;
  seller_custom_field?: string | null;
  attributes?: Array<{ id: string; value_name: string }>;
}

export async function GET(req: NextRequest) {
  const sku = (req.nextUrl.searchParams.get("sku") || "").trim().toUpperCase();
  if (!sku) return NextResponse.json({ error: "sku required" }, { status: 400 });

  try {
    const me = await mlGet<{ id: number }>("/users/me");
    if (!me) return NextResponse.json({ error: "ML auth failed" }, { status: 502 });

    const allStatuses = ["active", "paused", "closed", "under_review", "inactive"];
    const found: MLSearchResult[] = [];
    const seen = new Set<string>();

    for (const status of allStatuses) {
      const res = await mlGet<{ results: string[] }>(
        `/users/${me.id}/items/search?seller_sku=${encodeURIComponent(sku)}&status=${status}&limit=50`
      );
      for (const id of res?.results || []) {
        if (seen.has(id)) continue;
        seen.add(id);
        const item = await mlGet<MLSearchResult>(`/items/${id}?attributes=id,title,status,available_quantity,last_updated,permalink,seller_custom_field,attributes`);
        if (item) found.push(item);
      }
    }

    const sb = getServerSupabase();
    let yaMapeados: string[] = [];
    if (sb && found.length > 0) {
      const { data } = await sb.from("ml_items_map")
        .select("item_id")
        .in("item_id", found.map(f => f.id));
      yaMapeados = (data || []).map((r: {item_id:string}) => r.item_id);
    }

    return NextResponse.json({
      sku,
      items: found.map(i => ({
        item_id: i.id,
        title: i.title,
        status: i.status,
        available_quantity: i.available_quantity,
        last_updated: i.last_updated,
        permalink: i.permalink,
        seller_custom_field: i.seller_custom_field,
        ya_mapeado: yaMapeados.includes(i.id),
      })),
      total: found.length,
    });
  } catch (err) {
    console.error("[search-by-sku] error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { sku?: string; item_id?: string; sku_venta?: string };
    const sku = (body.sku || "").trim().toUpperCase();
    const itemId = (body.item_id || "").trim();
    if (!sku || !itemId) return NextResponse.json({ error: "sku and item_id required" }, { status: 400 });

    const sb = getServerSupabase();
    if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

    const item = await mlGet<{ id: string; title: string; status: string; available_quantity: number; seller_custom_field: string | null }>(
      `/items/${itemId}?attributes=id,title,status,available_quantity,seller_custom_field`
    );
    if (!item) return NextResponse.json({ error: `item ${itemId} no existe en ML` }, { status: 404 });

    const skuVenta = (body.sku_venta || item.seller_custom_field || sku).toUpperCase();

    const { error } = await sb.from("ml_items_map").upsert({
      sku: skuVenta,
      item_id: itemId,
      sku_origen: sku,
      sku_venta: skuVenta,
      titulo: item.title,
      status_ml: item.status,
      activo: true,
      available_quantity: item.available_quantity,
      updated_at: new Date().toISOString(),
    }, { onConflict: "sku,item_id" });

    if (error) return NextResponse.json({ error: `upsert failed: ${error.message}` }, { status: 500 });

    await sb.from("stock_sync_queue").upsert(
      { sku: skuVenta, created_at: new Date().toISOString() },
      { onConflict: "sku" }
    );

    await sb.from("audit_log").insert({
      accion: "ml_items_map:manual_link",
      entidad: "ml_items_map",
      entidad_id: itemId,
      params: { sku, item_id: itemId, sku_venta: skuVenta, title: item.title, status: item.status },
      operario: "admin",
    });

    return NextResponse.json({ ok: true, sku, sku_venta: skuVenta, item_id: itemId, status: item.status, title: item.title });
  } catch (err) {
    console.error("[search-by-sku POST] error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
