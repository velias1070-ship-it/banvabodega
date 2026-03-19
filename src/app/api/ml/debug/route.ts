import { NextRequest, NextResponse } from "next/server";
import { mlGetRaw } from "@/lib/ml";

/**
 * Debug endpoint — hace GET crudo a ML API y devuelve el response tal cual.
 * Uso: /api/ml/debug?path=/user-products/MLCU3754508253/stock
 */
export async function GET(req: NextRequest) {
  const path = req.nextUrl.searchParams.get("path");
  if (!path) return NextResponse.json({ error: "falta ?path=/..." }, { status: 400 });

  try {
    const raw = await mlGetRaw(path);
    return NextResponse.json({ path, response: raw });
  } catch (err) {
    return NextResponse.json({ path, error: String(err) }, { status: 500 });
  }
}
