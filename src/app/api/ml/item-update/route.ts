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

    // Update local cache
    const sb = getServerSupabase();
    if (sb) {
      const localUpdates: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (updates.status) localUpdates.status_ml = updates.status;
      if (updates.price) localUpdates.price = updates.price;
      await sb.from("ml_items_map").update(localUpdates).eq("item_id", item_id);
    }

    return NextResponse.json({ item: result });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
