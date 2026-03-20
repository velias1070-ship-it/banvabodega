import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import crypto from "crypto";

export const maxDuration = 300;

const MP_BASE_URL = "https://api.mercadopago.com";
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || "";
const PAGE_SIZE = 50;
const MAX_PAGES = 60; // 3000 pagos max

interface MPPago {
  id: number;
  date_created: string;
  date_approved: string | null;
  transaction_amount: number;
  net_received_amount: number;
  status: string;
  description: string;
  payment_type_id: string;
  payment_method_id: string;
  installments: number;
  fee_details: { amount: number }[];
  order?: { id: number };
  external_reference?: string;
  payer?: { email?: string };
  operation_type?: string;
  point_of_interaction?: { type?: string };
}

async function mpGet(path: string, params: Record<string, string> = {}): Promise<unknown> {
  const qs = new URLSearchParams(params).toString();
  const url = `${MP_BASE_URL}${path}${qs ? "?" + qs : ""}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`MP API ${res.status}: ${await res.text().catch(() => "")}`);
  return res.json();
}

function safeDate(dt: string | null): string | null {
  if (!dt) return null;
  try {
    return new Date(dt).toISOString().slice(0, 10);
  } catch { return dt.slice(0, 10); }
}

function refHash(id: string): string {
  return crypto.createHash("sha256").update(`mp_${id}`).digest("hex").slice(0, 32);
}

/**
 * POST /api/mp/sync
 * Body: { periodo: "YYYYMM" }
 * Sincroniza pagos aprobados de MercadoPago del periodo a movimientos_banco.
 */
export async function POST(req: NextRequest) {
  if (!MP_ACCESS_TOKEN) {
    return NextResponse.json({ error: "MP_ACCESS_TOKEN no configurado" }, { status: 500 });
  }

  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  try {
    const body = await req.json();
    const { periodo } = body as { periodo: string };

    if (!periodo || !/^\d{6}$/.test(periodo)) {
      return NextResponse.json({ error: "Periodo inválido (YYYYMM)" }, { status: 400 });
    }

    const anio = parseInt(periodo.slice(0, 4));
    const mes = parseInt(periodo.slice(4, 6));
    const lastDay = new Date(anio, mes, 0).getDate();
    const fechaDesde = `${anio}-${String(mes).padStart(2, "0")}-01T00:00:00.000-03:00`;
    const fechaHasta = `${anio}-${String(mes).padStart(2, "0")}-${lastDay}T23:59:59.999-03:00`;

    // Empresa
    const { data: empresas } = await sb.from("empresas").select("id").limit(1);
    const empresaId = empresas?.[0]?.id;
    if (!empresaId) return NextResponse.json({ error: "Sin empresa" }, { status: 500 });

    // Cuenta bancaria MP
    const { data: cuentas } = await sb.from("cuentas_bancarias")
      .select("id").eq("empresa_id", empresaId).eq("banco", "MercadoPago").limit(1);
    const cuentaBancariaId = cuentas?.[0]?.id || null;

    // Paginar pagos aprobados
    const pagos: MPPago[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await mpGet("/v1/payments/search", {
        sort: "date_created",
        criteria: "desc",
        begin_date: fechaDesde,
        end_date: fechaHasta,
        status: "approved",
        limit: String(PAGE_SIZE),
        offset: String(page * PAGE_SIZE),
      }) as { results: MPPago[]; paging: { total: number } };

      if (!data.results || data.results.length === 0) break;
      pagos.push(...data.results);

      if (pagos.length >= data.paging.total) break;
      await new Promise(r => setTimeout(r, 300));
    }

    if (pagos.length === 0) {
      return NextResponse.json({ periodo, movimientos: 0, mensaje: "Sin pagos en el periodo" });
    }

    // Convertir a movimientos_banco
    const rows = pagos.map(p => {
      const fees = p.fee_details || [];
      const comision = fees.reduce((s, f) => s + (f.amount || 0), 0);
      const neto = p.net_received_amount || (p.transaction_amount - comision);
      const fecha = safeDate(p.date_approved || p.date_created);
      const descParts: string[] = [];
      const opType = p.operation_type || "";
      const poiType = p.point_of_interaction?.type || "";
      if (opType === "regular_payment") descParts.push("VENTA ML");
      else if (opType === "money_transfer") descParts.push("BONIFICACION FLEX");
      else descParts.push(opType.toUpperCase());
      if (p.description) descParts.push(p.description.slice(0, 80));

      return {
        empresa_id: empresaId,
        banco: "MercadoPago",
        cuenta: null,
        fecha,
        descripcion: descParts.join(" | "),
        monto: neto,
        saldo: null,
        referencia: `MP-${p.id}`,
        origen: "api" as const,
        cuenta_bancaria_id: cuentaBancariaId,
        referencia_unica: refHash(String(p.id)),
        metadata: JSON.stringify({
          mp_id: String(p.id),
          source: "payments_search",
          status: p.status,
          operation_type: opType,
          payment_type: p.payment_type_id,
          comision,
          monto_bruto: p.transaction_amount,
          orden_ml_id: p.order?.id ? String(p.order.id) : null,
          poi_type: poiType,
        }),
      };
    });

    // Dedup: buscar existentes por referencia_unica
    const existingRefs = new Set<string>();
    const allRefs = rows.map(r => r.referencia_unica);
    for (let i = 0; i < allRefs.length; i += 100) {
      const batch = allRefs.slice(i, i + 100);
      const { data: existing } = await sb.from("movimientos_banco")
        .select("referencia_unica")
        .eq("empresa_id", empresaId)
        .eq("banco", "MercadoPago")
        .in("referencia_unica", batch);
      for (const r of (existing || [])) existingRefs.add(r.referencia_unica);
    }

    const newRows = rows.filter(r => !existingRefs.has(r.referencia_unica));

    // Insert nuevos
    let inserted = 0;
    for (let i = 0; i < newRows.length; i += 500) {
      const batch = newRows.slice(i, i + 500);
      const { error } = await sb.from("movimientos_banco").insert(batch);
      if (error) console.error(`[MP Sync] Insert error batch ${i}:`, error.message);
      else inserted += batch.length;
    }

    // Sync log
    await sb.from("sync_log").insert({
      empresa_id: empresaId,
      periodo,
      tipo: "mercadopago",
      registros: inserted,
    });

    const bruto = pagos.reduce((s, p) => s + p.transaction_amount, 0);
    const comisionTotal = pagos.reduce((s, p) => s + (p.fee_details || []).reduce((s2, f) => s2 + (f.amount || 0), 0), 0);

    return NextResponse.json({
      periodo,
      pagos_total: pagos.length,
      ya_existentes: existingRefs.size,
      movimientos_nuevos: inserted,
      monto_bruto: bruto,
      comision_total: comisionTotal,
      monto_neto: bruto - comisionTotal,
    });
  } catch (err) {
    console.error("[MP Sync] Error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
