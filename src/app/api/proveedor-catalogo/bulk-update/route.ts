import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

/**
 * POST /api/proveedor-catalogo/bulk-update
 *
 * Body: { items: [{ sku_origen, proveedor, precio_neto, inner_pack? }] }
 *
 * Upsert con onConflict (proveedor, sku_origen). Valida:
 *  - sku_origen no vacío
 *  - proveedor no vacío
 *  - precio_neto > 0
 *
 * Devuelve { ok, escritos, omitidos: [{ sku, razon }], por_proveedor }
 */
export async function POST(req: NextRequest) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  let body: { items?: Array<{ sku_origen: string; proveedor: string; precio_neto: number; inner_pack?: number }> } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }
  const items = body.items || [];
  if (!Array.isArray(items) || items.length === 0) {
    return NextResponse.json({ error: "items vacío" }, { status: 400 });
  }

  // Cargar SKUs válidos
  const { data: prodData } = await sb.from("productos").select("sku");
  const skusValidos = new Set((prodData || []).map((p: { sku: string }) => p.sku.toUpperCase()));

  const omitidos: { sku: string; razon: string }[] = [];
  const aUpsertear: { proveedor: string; sku_origen: string; precio_neto: number; inner_pack: number; stock_disponible: null; updated_at: string }[] = [];
  const porProveedor: Record<string, number> = {};
  const now = new Date().toISOString();

  for (const it of items) {
    const sku = String(it.sku_origen || "").toUpperCase().trim();
    const proveedor = String(it.proveedor || "").trim();
    const precio = Number(it.precio_neto);
    const ip = Number(it.inner_pack) >= 1 ? Number(it.inner_pack) : 1;

    if (!sku) { omitidos.push({ sku, razon: "sku vacío" }); continue; }
    if (!proveedor) { omitidos.push({ sku, razon: "proveedor vacío" }); continue; }
    if (!skusValidos.has(sku)) { omitidos.push({ sku, razon: "SKU no existe en productos" }); continue; }
    if (!Number.isFinite(precio) || precio <= 0) { omitidos.push({ sku, razon: "precio_neto inválido" }); continue; }

    aUpsertear.push({
      proveedor, sku_origen: sku, precio_neto: precio, inner_pack: ip,
      stock_disponible: null, updated_at: now,
    });
    porProveedor[proveedor] = (porProveedor[proveedor] || 0) + 1;
  }

  if (aUpsertear.length === 0) {
    return NextResponse.json({ ok: true, escritos: 0, omitidos, por_proveedor: porProveedor });
  }

  const { error } = await sb.from("proveedor_catalogo")
    .upsert(aUpsertear, { onConflict: "proveedor,sku_origen" });
  if (error) {
    return NextResponse.json({ error: error.message, omitidos }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    escritos: aUpsertear.length,
    omitidos,
    por_proveedor: porProveedor,
  });
}
