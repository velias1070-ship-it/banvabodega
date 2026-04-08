import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

/**
 * One-time fix: correct double deduction from picking Full bug (2026-04-06).
 * For each affected SKU:
 * 1. Delete phantom movement (-3, from liberarReserva)
 * 2. Update real movement from -4 to -3 (actual qty picked)
 * Result: stock goes from -3 to 0 (correct)
 *
 * GET ?run=1
 */
export async function GET(req: NextRequest) {
  if (!req.nextUrl.searchParams.has("run")) {
    return NextResponse.json({ error: "add ?run=1 to execute" }, { status: 400 });
  }

  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const fixes = [
    { sku: "JSAFAB434P20W", phantom: "91d22949-1091-47da-b8e4-1de389ab7a8b", real: "401b55fe-2f80-4f79-b3a1-fe812eb531af" },
    { sku: "JSAFAB435P20W", phantom: "2fff9891-ef22-42d9-91d4-8ec8d7b573a9", real: "b0289263-9841-4cf0-98b0-1f8735cd822a" },
    { sku: "JSAFAB436P20W", phantom: "544879de-b59f-43f2-8f50-a916b37acc99", real: "686f11e8-0d2f-4daf-bfec-c9ec2b8e8d0b" },
    { sku: "JSAFAB440P20W", phantom: "072ab7a9-a95d-4d72-b9df-cb260f32f9cb", real: "db82ace5-aa9f-4eaa-9ac7-e6a4cba257ac" },
    { sku: "JSAFAB441P20W", phantom: "825291e4-5951-4de5-93a2-a1490a461ef9", real: "0008c76d-5c7c-469a-aec1-6485ad1d90ff" },
    { sku: "JSAFAB442P20W", phantom: "608ea610-1529-4761-b210-c5c7b2f5e354", real: "e92d3084-dc58-4f58-bb2d-eee0380eb553" },
  ];

  const results: Array<{ sku: string; phantom_deleted: boolean; real_updated: boolean; stock_fixed: boolean }> = [];

  for (const fix of fixes) {
    // 1. Delete phantom movement (-3)
    const { error: delErr } = await sb.from("movimientos").delete().eq("id", fix.phantom);

    // 2. Update real movement: 4 → 3
    const { error: updErr } = await sb.from("movimientos").update({
      cantidad: 3,
      nota: `Envío Full: ${fix.sku} (3 uds) — Envio a Full — 2026-04-06 [corregido: pedido 4, disponible 3]`,
    }).eq("id", fix.real);

    // 3. Fix stock to 0 (4 entrada - 1 flex - 3 full = 0)
    const { error: stockErr } = await sb.from("stock").update({
      cantidad: 0,
    }).eq("sku", fix.sku);

    results.push({
      sku: fix.sku,
      phantom_deleted: !delErr,
      real_updated: !updErr,
      stock_fixed: !stockErr,
    });
  }

  return NextResponse.json({ status: "ok", fixes: results });
}
