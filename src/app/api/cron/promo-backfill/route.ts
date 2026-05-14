import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Reconciliacion nocturna venta <-> ml_price_history.
 *
 * Si una promo expiro entre la compra y el sync de la venta, promoSnapshot
 * dentro de upsertOrderToVentasCache retorna null y ventas_ml_cache queda
 * con promo_name_aplicada = NULL. Este cron rescata el dato cruzando con
 * ml_price_history en una ventana de +-1 dia alrededor de la fecha de venta.
 *
 * Idempotente: solo escribe sobre filas con promo_name_aplicada IS NULL.
 * Response observable: { updated, rows_examined, window_days }.
 *
 * Query param `days` (default 60): ventana hacia atras desde hoy.
 */
async function ejecutar(days: number) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const { data: candidatos, error: errSel } = await sb.rpc("promo_backfill_candidatos", { p_days: days });
  if (errSel) {
    // Fallback: si la RPC no existe, hacer el match en SQL puro via execute_sql equivalent.
    console.error(`[promo-backfill] rpc missing or failed: ${errSel.message}`);
    return NextResponse.json({ ok: false, error: errSel.message, hint: "missing RPC promo_backfill_candidatos" }, { status: 500 });
  }

  const list = (candidatos || []) as Array<{
    id: string;
    promo_name: string;
    promo_pct: number | null;
    precio_lista: number | null;
  }>;

  if (list.length === 0) {
    return NextResponse.json({ ok: true, updated: 0, rows_examined: 0, window_days: days });
  }

  let updated = 0;
  const errors: string[] = [];
  for (let i = 0; i < list.length; i += 100) {
    const chunk = list.slice(i, i + 100);
    for (const row of chunk) {
      const { error } = await sb.from("ventas_ml_cache")
        .update({
          promo_name_aplicada: row.promo_name,
          promo_pct_aplicada: row.promo_pct,
          ...(row.precio_lista ? { price_lista_aplicada: row.precio_lista } : {}),
        })
        .eq("id", row.id)
        .is("promo_name_aplicada", null);
      if (error) errors.push(`${row.id}: ${error.message}`);
      else updated++;
    }
  }

  return NextResponse.json({
    ok: errors.length === 0,
    updated,
    rows_examined: list.length,
    window_days: days,
    errors: errors.slice(0, 5),
  });
}

export async function GET(req: NextRequest) {
  const days = Math.max(1, Math.min(365, parseInt(req.nextUrl.searchParams.get("days") || "60", 10)));
  return ejecutar(days);
}
export async function POST(req: NextRequest) {
  const days = Math.max(1, Math.min(365, parseInt(req.nextUrl.searchParams.get("days") || "60", 10)));
  return ejecutar(days);
}
