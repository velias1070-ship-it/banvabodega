import { NextRequest, NextResponse } from "next/server";
import { mlGet } from "@/lib/ml";
import { getServerSupabase } from "@/lib/supabase-server";

export const maxDuration = 300;

interface MLItemAttr {
  id: string;
  name: string;
  value_name: string | null;
  value_struct?: { number: number; unit: string } | null;
}

interface MLItem {
  id: string;
  status?: string;
  attributes?: MLItemAttr[];
}

type DimensionFields = {
  ml_largo_cm: number | null;
  ml_ancho_cm: number | null;
  ml_alto_cm: number | null;
  ml_peso_gr: number | null;
};

// Parsea un atributo de longitud a cm. ML expone value_struct {number, unit}
// o value_name "30 cm"/"300 mm"/"0.3 m". Devuelve null si no parsea.
function parseLongitudCm(attr: MLItemAttr | undefined): number | null {
  if (!attr) return null;
  // Preferir value_struct (tipado)
  if (attr.value_struct && typeof attr.value_struct.number === "number") {
    const n = attr.value_struct.number;
    const u = (attr.value_struct.unit || "").toLowerCase();
    if (u === "cm") return Math.round(n * 10) / 10;
    if (u === "mm") return Math.round((n / 10) * 10) / 10;
    if (u === "m")  return Math.round(n * 100 * 10) / 10;
  }
  // Fallback parse value_name
  if (attr.value_name) {
    const m = attr.value_name.trim().match(/^([0-9]+(?:[.,][0-9]+)?)\s*(cm|mm|m)?$/i);
    if (m) {
      const n = Number(m[1].replace(",", "."));
      const u = (m[2] || "cm").toLowerCase();
      if (u === "cm") return Math.round(n * 10) / 10;
      if (u === "mm") return Math.round((n / 10) * 10) / 10;
      if (u === "m")  return Math.round(n * 100 * 10) / 10;
    }
  }
  return null;
}

// Parsea peso a gramos. ML usa kg/g/gr/mg.
function parsePesoGr(attr: MLItemAttr | undefined): number | null {
  if (!attr) return null;
  if (attr.value_struct && typeof attr.value_struct.number === "number") {
    const n = attr.value_struct.number;
    const u = (attr.value_struct.unit || "").toLowerCase();
    if (u === "g" || u === "gr") return Math.round(n);
    if (u === "kg") return Math.round(n * 1000);
    if (u === "mg") return Math.round(n / 1000);
  }
  if (attr.value_name) {
    const m = attr.value_name.trim().match(/^([0-9]+(?:[.,][0-9]+)?)\s*(g|gr|kg|mg)?$/i);
    if (m) {
      const n = Number(m[1].replace(",", "."));
      const u = (m[2] || "g").toLowerCase();
      if (u === "g" || u === "gr") return Math.round(n);
      if (u === "kg") return Math.round(n * 1000);
      if (u === "mg") return Math.round(n / 1000);
    }
  }
  return null;
}

function extractDim(attrs: MLItemAttr[] | undefined): DimensionFields {
  const find = (id: string) => attrs?.find(a => a.id === id);
  return {
    ml_largo_cm: parseLongitudCm(find("PACKAGE_LENGTH")),
    ml_ancho_cm: parseLongitudCm(find("PACKAGE_WIDTH")),
    ml_alto_cm:  parseLongitudCm(find("PACKAGE_HEIGHT")),
    ml_peso_gr:  parsePesoGr(find("PACKAGE_WEIGHT")),
  };
}

/**
 * POST /api/ml/sync-dimensiones-ml
 *
 * Body opcional: { skus?: string[], limit?: number, dry_run?: boolean }
 *
 * Recorre ml_items_map activos, fetch /items/{id} con attributes filter, lee
 * PACKAGE_LENGTH/WIDTH/HEIGHT/WEIGHT y escribe SOLO en columnas ml_* de
 * productos. NO toca columnas BANVA.
 *
 * Response observable (regla 4 inventory-policy):
 *   { processed, updated, sin_atributos_count, sin_atributos_skus, errores, dry_run }
 */
export async function POST(req: NextRequest) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  let body: { skus?: string[]; limit?: number; dry_run?: boolean } = {};
  try { body = await req.json(); } catch { /* no body */ }
  const { skus: skusFilter, limit = 1000, dry_run = false } = body;

  // Trae items activos. Si viene filtro de skus, usarlo. Un item por sku
  // (si el sku tiene multiples item_id por variation_id, agarra el primero
  // — todos comparten el mismo bulto).
  const itemsQuery = sb
    .from("ml_items_map")
    .select("sku, item_id")
    .eq("activo", true)
    .order("sku")
    .limit(limit);
  const itemsRes = skusFilter && skusFilter.length > 0
    ? await itemsQuery.in("sku", skusFilter)
    : await itemsQuery;
  if (itemsRes.error) {
    console.error("[sync-dimensiones-ml] items query failed:", itemsRes.error.message);
    return NextResponse.json({ error: itemsRes.error.message }, { status: 500 });
  }
  const items = itemsRes.data || [];
  // Deduplicar por sku (un sku puede tener multiples item_id)
  const itemsBySku = new Map<string, string>();
  for (const it of items) {
    if (!itemsBySku.has(it.sku)) itemsBySku.set(it.sku, it.item_id);
  }
  const targets = Array.from(itemsBySku.entries());

  let updated = 0;
  let sinAtributos = 0;
  const sinAtributosSkus: string[] = [];
  const errores: Array<{ sku: string; item_id: string; error: string }> = [];

  for (const [sku, itemId] of targets) {
    try {
      const item = await mlGet<MLItem>(`/items/${itemId}?attributes=id,status,attributes`);
      if (!item) {
        errores.push({ sku, item_id: itemId, error: "items_get_null" });
        continue;
      }
      const dim = extractDim(item.attributes);
      const tieneAlgo = dim.ml_largo_cm !== null || dim.ml_ancho_cm !== null
        || dim.ml_alto_cm !== null || dim.ml_peso_gr !== null;
      if (!tieneAlgo) {
        sinAtributos += 1;
        if (sinAtributosSkus.length < 50) sinAtributosSkus.push(sku);
        continue;
      }
      if (dry_run) {
        updated += 1;
        continue;
      }
      // Update solo ml_* + ml_dim_synced_at. No tocar columnas BANVA.
      const { error: upErr } = await sb
        .from("productos")
        .update({
          ml_largo_cm: dim.ml_largo_cm,
          ml_ancho_cm: dim.ml_ancho_cm,
          ml_alto_cm: dim.ml_alto_cm,
          ml_peso_gr: dim.ml_peso_gr,
          ml_dim_synced_at: new Date().toISOString(),
        })
        .eq("sku", sku);
      if (upErr) {
        errores.push({ sku, item_id: itemId, error: `update: ${upErr.message}` });
        continue;
      }
      updated += 1;
    } catch (e) {
      errores.push({ sku, item_id: itemId, error: e instanceof Error ? e.message : String(e) });
    }
    // Pequeño delay para no saturar el rate limit ML
    await new Promise(r => setTimeout(r, 50));
  }

  return NextResponse.json({
    processed: targets.length,
    updated,
    sin_atributos_count: sinAtributos,
    sin_atributos_skus: sinAtributosSkus,
    errores,
    dry_run,
  });
}
