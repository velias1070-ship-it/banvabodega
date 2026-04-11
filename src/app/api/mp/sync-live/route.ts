import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import crypto from "crypto";

export const maxDuration = 60;

const MP_BASE_URL = "https://api.mercadopago.com";
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || "";

function refHash(prefix: string, id: string): string {
  return crypto.createHash("sha256").update(`${prefix}_${id}`).digest("hex").slice(0, 32);
}

interface MPMovement {
  id: number;
  type?: string;
  date_created?: string;
  amount?: number;
  description?: string;
  status?: string;
}

/**
 * POST /api/mp/sync-live
 * Body: { dias?: number }
 * Trae movimientos recientes (default 7 días) directamente de la API de MP
 * sin esperar a release reports. Usa /v1/account/movements/search.
 */
export async function POST(req: NextRequest) {
  if (!MP_ACCESS_TOKEN) {
    return NextResponse.json({ error: "MP_ACCESS_TOKEN no configurado" }, { status: 500 });
  }

  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  try {
    const body = await req.json().catch(() => ({}));
    const dias = body.dias || 7;

    const log: string[] = [];

    // Empresa
    const { data: empresas } = await sb.from("empresas").select("id").limit(1);
    const empresaId = empresas?.[0]?.id;
    if (!empresaId) return NextResponse.json({ error: "Sin empresa" }, { status: 500 });

    const { data: cuentas } = await sb.from("cuentas_bancarias")
      .select("id").eq("empresa_id", empresaId).eq("banco", "MercadoPago").limit(1);
    const cuentaBancariaId = cuentas?.[0]?.id || null;

    const fechaDesde = new Date(Date.now() - dias * 86400_000).toISOString();
    log.push(`Buscando movimientos desde ${fechaDesde.slice(0, 10)} (últimos ${dias} días)`);

    // Intentar varios endpoints de MP para encontrar movimientos
    let movimientos: MPMovement[] = [];

    // 1. Intento: account movements search
    try {
      const url = `${MP_BASE_URL}/v1/account/movements/search?range=date_created&begin_date=${fechaDesde}&end_date=${new Date().toISOString()}&limit=100`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
        signal: AbortSignal.timeout(30000),
      });
      if (res.ok) {
        const data = await res.json();
        const results = data.results || data.movements || [];
        log.push(`account/movements: ${results.length} resultados`);
        movimientos = results;
      } else {
        log.push(`account/movements: ${res.status}`);
      }
    } catch (e) {
      log.push(`account/movements error: ${e instanceof Error ? e.message : "?"}`);
    }

    // 2. Fallback: payments search filtrado por type=payout
    if (movimientos.length === 0) {
      try {
        const url = `${MP_BASE_URL}/v1/payments/search?sort=date_created&criteria=desc&range=date_created&begin_date=${fechaDesde}&end_date=${new Date().toISOString()}&limit=100`;
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
          signal: AbortSignal.timeout(30000),
        });
        if (res.ok) {
          const data = await res.json();
          const results = data.results || [];
          log.push(`payments/search: ${results.length} resultados`);
          // Filtrar solo retiros (payouts)
          movimientos = results.filter((p: { operation_type?: string; payment_type_id?: string }) =>
            p.operation_type === "payout" || p.operation_type === "money_transfer" || p.payment_type_id === "account_money"
          );
        } else {
          log.push(`payments/search: ${res.status}`);
        }
      } catch (e) {
        log.push(`payments/search error: ${e instanceof Error ? e.message : "?"}`);
      }
    }

    if (movimientos.length === 0) {
      return NextResponse.json({
        ok: false,
        mensaje: "No se encontraron movimientos via API directa. Usa Sync MP normal o pide un release report.",
        log,
      });
    }

    // Convertir a formato movimientos_banco
    const rows = movimientos.map((m: MPMovement) => {
      const sourceId = String(m.id);
      const fecha = m.date_created ? m.date_created.slice(0, 10) : new Date().toISOString().slice(0, 10);
      const monto = -Math.abs(m.amount || 0); // Egreso
      return {
        empresa_id: empresaId,
        banco: "MercadoPago",
        cuenta: null,
        fecha,
        descripcion: `RETIRO MP | $${Math.abs(m.amount || 0).toLocaleString("es-CL")}${m.description ? ` | ${m.description}` : ""}`,
        monto,
        saldo: null,
        referencia: `MP-RETIRO-${sourceId}`,
        origen: "api" as const,
        cuenta_bancaria_id: cuentaBancariaId,
        referencia_unica: refHash("mp_retiro", sourceId),
        metadata: JSON.stringify({ tipo: "retiro_live", source_id: sourceId, monto: Math.abs(m.amount || 0) }),
      };
    });

    log.push(`${rows.length} movimientos procesados`);

    // Dedup contra DB
    const allRefs = rows.map(r => r.referencia_unica);
    const existingRefs = new Set<string>();
    for (let i = 0; i < allRefs.length; i += 100) {
      const batch = allRefs.slice(i, i + 100);
      const { data: existing } = await sb.from("movimientos_banco")
        .select("referencia_unica").eq("empresa_id", empresaId).in("referencia_unica", batch);
      for (const r of (existing || [])) existingRefs.add(r.referencia_unica);
    }

    const newRows = rows.filter(r => !existingRefs.has(r.referencia_unica));
    log.push(`Dedup: ${rows.length} encontrados, ${existingRefs.size} ya existían, ${newRows.length} nuevos`);

    let inserted = 0;
    for (let i = 0; i < newRows.length; i += 500) {
      const batch = newRows.slice(i, i + 500);
      const { error } = await sb.from("movimientos_banco").insert(batch);
      if (error) { log.push(`ERROR: ${error.message}`); }
      else inserted += batch.length;
    }

    return NextResponse.json({ ok: true, retiros_nuevos: inserted, total_encontrados: rows.length, log });
  } catch (err) {
    console.error("[MP Sync Live] Error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
