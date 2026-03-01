import { NextRequest, NextResponse } from "next/server";
import { exchangeCodeForTokens } from "@/lib/ml";

/**
 * OAuth callback from MercadoLibre.
 * ML redirects here with ?code=xxx after user authorizes.
 */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");

  if (!code) {
    return NextResponse.redirect(new URL("/admin?ml_error=no_code", req.url));
  }

  // Build redirect URI (must match what was used in the authorization URL)
  const redirectUri = `${req.nextUrl.origin}/api/ml/auth`;

  const success = await exchangeCodeForTokens(code, redirectUri);

  if (success) {
    return NextResponse.redirect(new URL("/admin?ml_auth=success", req.url));
  } else {
    return NextResponse.redirect(new URL("/admin?ml_error=token_exchange_failed", req.url));
  }
}
