import { NextResponse } from "next/server";
import { mlGet, getMLConfig } from "@/lib/ml";

/**
 * GET /api/ml/diagnostico
 * Verifica que el token OAuth corresponda al seller_id configurado.
 * Llama a /users/me y compara con ml_config.
 */
export async function GET() {
  try {
    const config = await getMLConfig();
    if (!config) {
      return NextResponse.json({ ok: false, error: "No hay ml_config en DB" });
    }

    const sellerIdConfigurado = config.seller_id || "(no configurado)";

    // Llamar a /users/me con el token actual
    const me = await mlGet<{ id: number; nickname: string; site_id: string; seller_reputation?: { level_id: string } }>("/users/me");
    if (!me) {
      return NextResponse.json({
        ok: false,
        error: "Token inválido o expirado — /users/me falló",
        seller_id_configurado: sellerIdConfigurado,
      });
    }

    const coincide = String(me.id) === String(sellerIdConfigurado);

    return NextResponse.json({
      ok: coincide,
      seller_id_configurado: sellerIdConfigurado,
      seller_id_token: me.id,
      nickname: me.nickname,
      site_id: me.site_id,
      coincide,
      mensaje: coincide
        ? "El token corresponde al seller configurado"
        : `DESAJUSTE: el token es de seller ${me.id} (${me.nickname}) pero ml_config tiene seller_id=${sellerIdConfigurado}. Debes re-autenticar OAuth con la cuenta correcta o actualizar seller_id en ml_config.`,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
