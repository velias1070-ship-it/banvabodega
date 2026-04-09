import { NextRequest, NextResponse } from "next/server";
import { ensureValidToken } from "@/lib/ml";

/**
 * Debug endpoint — hace GET crudo a ML API y devuelve el response tal cual.
 * Uso: /api/ml/debug?path=/user-products/MLCU3754508253/stock
 */
export async function GET(req: NextRequest) {
  const path = req.nextUrl.searchParams.get("path");
  if (!path) return NextResponse.json({ error: "falta ?path=/..." }, { status: 400 });

  try {
    const token = await ensureValidToken();
    if (!token) {
      return NextResponse.json({ path, error: "ensureValidToken returned null", token_present: false });
    }

    const url = `https://api.mercadolibre.com${path}`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const text = await resp.text();
    let parsed: unknown = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }

    return NextResponse.json({
      path,
      url,
      status: resp.status,
      ok: resp.ok,
      token_prefix: token.slice(0, 12),
      token_len: token.length,
      response_text: parsed ? null : text.slice(0, 500),
      response: parsed,
    });
  } catch (err) {
    return NextResponse.json({ path, error: String(err) }, { status: 500 });
  }
}
