import { NextRequest, NextResponse } from "next/server";
import { mlGet, mlPut } from "@/lib/ml";

export const maxDuration = 120;

interface MLItemAttrs {
  id: string;
  title: string;
  status: string;
  attributes: Array<{ id: string; name: string; value_name: string | null }>;
}

/**
 * POST /api/ml/bulk-attr-sync
 * Body: { item_ids: string[], action: "design_from_color" | "color_from_design" }
 *
 * Para cada item, lee el atributo origen y lo copia al destino.
 */
export async function POST(req: NextRequest) {
  try {
    const { item_ids, action } = await req.json() as { item_ids: string[]; action: string };
    if (!item_ids?.length || !action) {
      return NextResponse.json({ error: "item_ids y action requeridos" }, { status: 400 });
    }

    const [srcAttr, dstAttr] = action === "design_from_color"
      ? ["COLOR", "FABRIC_DESIGN"]
      : ["FABRIC_DESIGN", "COLOR"];

    const results: Array<{ item_id: string; title: string; src: string; dst: string; ok: boolean; error?: string }> = [];

    for (const itemId of item_ids.slice(0, 50)) {
      // Fetch current attributes
      const item = await mlGet<MLItemAttrs>(`/items/${itemId}?attributes=id,title,status,attributes`);
      if (!item) {
        results.push({ item_id: itemId, title: "?", src: "", dst: "", ok: false, error: "No encontrado" });
        continue;
      }

      const srcVal = item.attributes?.find(a => a.id === srcAttr)?.value_name || "";
      const dstVal = item.attributes?.find(a => a.id === dstAttr)?.value_name || "";

      if (!srcVal) {
        results.push({ item_id: itemId, title: item.title, src: srcVal, dst: dstVal, ok: false, error: `Sin ${srcAttr}` });
        continue;
      }

      if (srcVal === dstVal) {
        results.push({ item_id: itemId, title: item.title, src: srcVal, dst: dstVal, ok: true, error: "Ya iguales" });
        continue;
      }

      // Update
      try {
        await mlPut(`/items/${itemId}`, { attributes: [{ id: dstAttr, value_name: srcVal }] });
        results.push({ item_id: itemId, title: item.title, src: srcVal, dst: srcVal, ok: true });
      } catch (e) {
        results.push({ item_id: itemId, title: item.title, src: srcVal, dst: dstVal, ok: false, error: e instanceof Error ? e.message : String(e) });
      }

      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 300));
    }

    const ok = results.filter(r => r.ok).length;
    const failed = results.filter(r => !r.ok).length;

    return NextResponse.json({ ok, failed, total: results.length, results });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
