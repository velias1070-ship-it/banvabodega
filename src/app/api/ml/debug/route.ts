import { NextRequest, NextResponse } from "next/server";
import { ensureValidToken, getMLConfig, saveMLConfig } from "@/lib/ml";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Debug endpoint — hace GET crudo a ML API y devuelve el response tal cual.
 * Uso: /api/ml/debug?path=/user-products/MLCU3754508253/stock
 *      /api/ml/debug?refresh=1   (forzar refresh manual y mostrar resultado)
 */
export async function GET(req: NextRequest) {
  const showEnv = req.nextUrl.searchParams.get("env");
  if (showEnv) {
    return NextResponse.json({
      test_mode: process.env.NEXT_PUBLIC_TEST_MODE,
      supabase_url: (process.env.NEXT_PUBLIC_SUPABASE_URL || "").slice(0, 50),
      supabase_test_url: (process.env.NEXT_PUBLIC_SUPABASE_TEST_URL || "").slice(0, 50),
      vercel_env: process.env.VERCEL_ENV,
      vercel_url: process.env.VERCEL_URL,
    });
  }

  const showConfig = req.nextUrl.searchParams.get("config");
  if (showConfig) {
    const cfg = await getMLConfig();
    if (!cfg) return NextResponse.json({ error: "no config" });
    return NextResponse.json({
      seller_id: cfg.seller_id,
      access_token_prefix: cfg.access_token.slice(0, 35),
      access_token_suffix: cfg.access_token.slice(-15),
      access_token_len: cfg.access_token.length,
      refresh_token_prefix: cfg.refresh_token.slice(0, 25),
      token_expires_at: cfg.token_expires_at,
      updated_at: cfg.updated_at,
      now: new Date().toISOString(),
    });
  }

  const refresh = req.nextUrl.searchParams.get("refresh");
  if (refresh) {
    const cfg = await getMLConfig();
    if (!cfg) return NextResponse.json({ error: "no ml_config" });

    const resp = await fetch("https://api.mercadolibre.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: cfg.client_id,
        client_secret: cfg.client_secret,
        refresh_token: cfg.refresh_token,
      }),
    });
    const text = await resp.text();
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { /* */ }
    let saved = false;
    if (resp.ok && body && typeof body === "object") {
      const data = body as { access_token?: string; refresh_token?: string; expires_in?: number };
      if (data.access_token && data.expires_in) {
        await saveMLConfig({
          access_token: data.access_token,
          refresh_token: data.refresh_token || cfg.refresh_token,
          token_expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
        });
        saved = true;
      }
    }
    return NextResponse.json({
      manual_refresh: true,
      status: resp.status,
      ok: resp.ok,
      saved_to_db: saved,
      client_id: cfg.client_id,
      refresh_token_prefix: cfg.refresh_token.slice(0, 12),
      refresh_token_len: cfg.refresh_token.length,
      response: body || text.slice(0, 800),
    });
  }

  const path = req.nextUrl.searchParams.get("path");
  if (!path) return NextResponse.json({ error: "falta ?path=/... o ?refresh=1" }, { status: 400 });

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
      token_prefix: token.slice(0, 35),
      token_suffix: token.slice(-15),
      token_len: token.length,
      response_text: parsed ? null : text.slice(0, 500),
      response: parsed,
    });
  } catch (err) {
    return NextResponse.json({ path, error: String(err) }, { status: 500 });
  }
}
