import { NextRequest, NextResponse } from "next/server";
import { mlPut } from "@/lib/ml";
import { getServerSupabase } from "@/lib/supabase-server";

/**
 * Update an existing ML item (pause, activate, close, change price, etc.).
 * PUT body: { item_id: string, updates: { status?: string, price?: number, ... } }
 */
export async function PUT(req: NextRequest) {
  try {
    const { item_id, updates } = await req.json();
    if (!item_id || !updates) {
      return NextResponse.json({ error: "item_id and updates required" }, { status: 400 });
    }

    const result = await mlPut<{ id: string; status: string; price: number }>(`/items/${item_id}`, updates);
    if (!result) {
      return NextResponse.json({ error: "ML API update failed" }, { status: 502 });
    }

    // Update local cache + audit log
    const sb = getServerSupabase();
    if (sb) {
      // Capturar precio anterior antes del update para trazabilidad
      const { data: prev } = await sb.from("ml_items_map")
        .select("price, status_ml, titulo, sku")
        .eq("item_id", item_id)
        .limit(1);
      const prevRow = (prev || [])[0] as { price?: number; status_ml?: string; titulo?: string; sku?: string } | undefined;

      const localUpdates: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (updates.status) localUpdates.status_ml = updates.status;
      if (updates.price) localUpdates.price = updates.price;
      if (updates.title) localUpdates.titulo = updates.title;
      await sb.from("ml_items_map").update(localUpdates).eq("item_id", item_id);

      // Audit log: registra cambios manuales a items ML. Await para garantizar
      // que el insert se ejecute antes de retornar (Supabase PromiseLike no
      // corre sin await/then — feedback_supabase_promiselike).
      const { error: logErr } = await sb.from("admin_actions_log").insert({
        accion: "ml_item_update",
        entidad: "ml_items_map",
        entidad_id: item_id,
        detalle: {
          sku: prevRow?.sku || null,
          updates,
          prev: {
            price: prevRow?.price ?? null,
            status: prevRow?.status_ml ?? null,
            titulo: prevRow?.titulo ?? null,
          },
          result: { id: result.id, status: result.status, price: result.price },
        },
      });
      if (logErr) console.error(`[item_update_log] insert failed for ${item_id}: ${logErr.message}`);
    }

    return NextResponse.json({ item: result });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
