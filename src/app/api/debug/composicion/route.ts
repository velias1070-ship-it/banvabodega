import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const sku = req.nextUrl.searchParams.get("sku") || "";
  if (!sku) return NextResponse.json({ error: "param sku required" }, { status: 400 });

  const skuUp = sku.toUpperCase();

  // Search as sku_venta
  const { data: asVenta } = await sb.from("composicion_venta").select("*").ilike("sku_venta", `%${skuUp}%`);
  // Search as sku_origen
  const { data: asOrigen } = await sb.from("composicion_venta").select("*").ilike("sku_origen", `%${skuUp}%`);
  // Search in productos
  const { data: producto } = await sb.from("productos").select("sku, sku_venta, nombre, codigo_ml, categoria, proveedor").ilike("sku", `%${skuUp}%`);

  return NextResponse.json({
    composicion_como_venta: asVenta || [],
    composicion_como_origen: asOrigen || [],
    productos: producto || [],
  });
}
