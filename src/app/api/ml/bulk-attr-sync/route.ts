import { NextRequest, NextResponse } from "next/server";
import { mlGet, mlPut } from "@/lib/ml";
import { getServerSupabase } from "@/lib/supabase-server";

export const maxDuration = 120;

interface MLItemAttrs {
  id: string;
  title: string;
  status: string;
  attributes: Array<{ id: string; name: string; value_name: string | null }>;
}

/**
 * POST /api/ml/bulk-attr-sync
 * Body: { item_ids: string[], action: "design_from_color" | "color_from_design" | "from_variant_name", family_prefix?: string }
 *
 * Acciones:
 * - design_from_color: copia COLOR → FABRIC_DESIGN
 * - color_from_design: copia FABRIC_DESIGN → COLOR
 * - from_variant_name: extrae nombre de variante del título y lo pone en COLOR y FABRIC_DESIGN
 */
export async function POST(req: NextRequest) {
  try {
    const { item_ids, action, family_prefix } = await req.json() as { item_ids: string[]; action: string; family_prefix?: string };
    if (!item_ids?.length || !action) {
      return NextResponse.json({ error: "item_ids y action requeridos" }, { status: 400 });
    }

    const results: Array<{ item_id: string; title: string; value: string; ok: boolean; error?: string }> = [];

    for (const itemId of item_ids.slice(0, 50)) {
      const item = await mlGet<MLItemAttrs>(`/items/${itemId}?attributes=id,title,status,attributes`);
      if (!item) {
        results.push({ item_id: itemId, title: "?", value: "", ok: false, error: "No encontrado" });
        continue;
      }

      if (action === "from_variant_name") {
        // Primero intentar con el título del cache (Supabase) que puede tener el nombre original
        let cachedTitle = "";
        const sb = getServerSupabase();
        if (sb) {
          const { data: cached } = await sb.from("ml_items_map").select("titulo").eq("item_id", itemId).limit(1);
          cachedTitle = cached?.[0]?.titulo || "";
        }
        const titleToUse = cachedTitle || item.title;

        // Extraer nombre de variante del título quitando el prefijo de familia
        let variantName = "";
        if (family_prefix && titleToUse.startsWith(family_prefix)) {
          variantName = titleToUse.slice(family_prefix.length).trim();
          // Si tiene múltiples palabras (ej "Blanco Dino"), tomar la última
          const parts = variantName.split(" ");
          if (parts.length > 1) variantName = parts[parts.length - 1];
        } else {
          const words = titleToUse.split(" ");
          variantName = words[words.length - 1];
        }

        if (!variantName) {
          results.push({ item_id: itemId, title: item.title, value: "", ok: false, error: "Sin variante en título" });
          continue;
        }

        try {
          await mlPut(`/items/${itemId}`, { attributes: [
            { id: "COLOR", value_name: variantName },
            { id: "FABRIC_DESIGN", value_name: variantName },
          ]});
          results.push({ item_id: itemId, title: item.title, value: variantName, ok: true });
        } catch (e) {
          results.push({ item_id: itemId, title: item.title, value: variantName, ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      } else {
        // copy between attributes
        const [srcAttr, dstAttr] = action === "design_from_color"
          ? ["COLOR", "FABRIC_DESIGN"]
          : ["FABRIC_DESIGN", "COLOR"];

        const srcVal = item.attributes?.find(a => a.id === srcAttr)?.value_name || "";
        const dstVal = item.attributes?.find(a => a.id === dstAttr)?.value_name || "";

        if (!srcVal) {
          results.push({ item_id: itemId, title: item.title, value: "", ok: false, error: `Sin ${srcAttr}` });
          continue;
        }
        if (srcVal === dstVal) {
          results.push({ item_id: itemId, title: item.title, value: srcVal, ok: true, error: "Ya iguales" });
          continue;
        }

        try {
          await mlPut(`/items/${itemId}`, { attributes: [{ id: dstAttr, value_name: srcVal }] });
          results.push({ item_id: itemId, title: item.title, value: srcVal, ok: true });
        } catch (e) {
          results.push({ item_id: itemId, title: item.title, value: srcVal, ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      }

      await new Promise(r => setTimeout(r, 300));
    }

    const ok = results.filter(r => r.ok).length;
    const failed = results.filter(r => !r.ok).length;

    return NextResponse.json({ ok, failed, total: results.length, results });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
