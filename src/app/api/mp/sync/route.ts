import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import crypto from "crypto";

export const maxDuration = 300;

const MP_BASE_URL = "https://api.mercadopago.com";
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || "";
const PAGE_SIZE = 50;
const MAX_PAGES = 60;

interface MPPago {
  id: number;
  date_created: string;
  date_approved: string | null;
  transaction_amount: number;
  net_received_amount: number | null;
  coupon_amount: number;
  status: string;
  description: string | null;
  payment_type_id: string;
  payment_method_id: string;
  installments: number;
  fee_details: { amount: number }[];
  collector_id: number | null;
  order?: { id: number };
  payer?: { id?: string; email?: string };
  operation_type?: string;
  transaction_details?: { total_paid_amount?: number };
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

async function mpGetText(path: string): Promise<string> {
  const url = `${MP_BASE_URL}${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`MP API ${res.status}`);
  return res.text();
}

function safeDate(dt: string | null): string | null {
  if (!dt) return null;
  try { return new Date(dt).toISOString().slice(0, 10); }
  catch { return dt.slice(0, 10); }
}

function refHash(prefix: string, id: string): string {
  return crypto.createHash("sha256").update(`${prefix}_${id}`).digest("hex").slice(0, 32);
}

/**
 * POST /api/mp/sync
 * Body: { periodo: "YYYYMM" }
 * Sincroniza compras propias + retiros de MercadoPago del periodo.
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

    // ══════════════════════════════════════
    // 1. COMPRAS PROPIAS (collector_id = null)
    // ══════════════════════════════════════
    const allPagos: MPPago[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await mpGet("/v1/payments/search", {
        sort: "date_created",
        criteria: "asc",
        begin_date: fechaDesde,
        end_date: fechaHasta,
        status: "approved",
        limit: String(PAGE_SIZE),
        offset: String(page * PAGE_SIZE),
      }) as { results: MPPago[]; paging: { total: number } };

      if (!data.results || data.results.length === 0) break;
      allPagos.push(...data.results);
      if (allPagos.length >= data.paging.total) break;
      await new Promise(r => setTimeout(r, 300));
    }

    // Filtrar compras propias: collector_id es null
    const compras = allPagos.filter(p => p.collector_id === null || p.collector_id === undefined);

    const compraRows = compras.map(p => {
      const td = p.transaction_details || {};
      const totalPagado = td.total_paid_amount || p.transaction_amount;
      const cupon = p.coupon_amount || 0;
      const fecha = safeDate(p.date_approved || p.date_created);

      const descParts: string[] = ["COMPRA ML"];
      if (p.description) descParts.push(p.description.slice(0, 80));

      return {
        empresa_id: empresaId,
        banco: "MercadoPago",
        cuenta: null,
        fecha,
        descripcion: descParts.join(" | "),
        monto: -totalPagado, // negativo = egreso/gasto
        saldo: null,
        referencia: `MP-COMPRA-${p.id}`,
        origen: "api" as const,
        cuenta_bancaria_id: cuentaBancariaId,
        referencia_unica: refHash("mp_compra", String(p.id)),
        metadata: JSON.stringify({
          tipo: "compra_propia",
          mp_id: String(p.id),
          monto_producto: p.transaction_amount,
          cupon_descuento: cupon,
          total_pagado: totalPagado,
          medio_pago: p.payment_method_id,
          tipo_pago: p.payment_type_id,
          cuotas: p.installments,
          cuota_monto: p.installments > 1 ? Math.round(totalPagado / p.installments) : null,
          orden_ml: p.order?.id ? String(p.order.id) : null,
        }),
      };
    });

    // ══════════════════════════════════════
    // 2. RETIROS (PAYOUTS del settlement report)
    // ══════════════════════════════════════
    let retiroRows: typeof compraRows = [];
    try {
      // Listar settlement reports del periodo
      const reports = await mpGet("/v1/account/settlement_report/list", {
        begin_date: fechaDesde,
        end_date: fechaHasta,
      }) as Array<{ file_name: string; status: string }>;

      // Descargar el primer reporte procesado
      const processed = (reports || []).filter(r => r.status === "processed");
      if (processed.length > 0) {
        const csv = await mpGetText(`/v1/account/settlement_report/${processed[0].file_name}`);
        const lines = csv.split("\n");

        for (const line of lines.slice(1)) {
          const cols = line.split(";");
          if (cols.length < 8) continue;
          if (cols[2] !== "PAYOUTS") continue;

          const sourceId = cols[0];
          const monto = Math.abs(parseFloat(cols[3]) || 0);
          const fecha = safeDate(cols[4]);
          if (!monto || !fecha) continue;

          retiroRows.push({
            empresa_id: empresaId,
            banco: "MercadoPago",
            cuenta: null,
            fecha,
            descripcion: `RETIRO MP → Banco | $${monto.toLocaleString("es-CL")}`,
            monto: -monto, // negativo = sale de MP
            saldo: null,
            referencia: `MP-RETIRO-${sourceId}`,
            origen: "api" as const,
            cuenta_bancaria_id: cuentaBancariaId,
            referencia_unica: refHash("mp_retiro", sourceId),
            metadata: JSON.stringify({
              tipo: "retiro",
              source_id: sourceId,
              monto_retirado: monto,
            }),
          });
        }
      }
    } catch (err) {
      console.error("[MP Sync] Error obteniendo retiros:", err);
    }

    // ══════════════════════════════════════
    // 3. DEDUP E INSERT
    // ══════════════════════════════════════
    const allRows = [...compraRows, ...retiroRows];

    if (allRows.length === 0) {
      return NextResponse.json({ periodo, compras: 0, retiros: 0, mensaje: "Sin compras ni retiros en el periodo" });
    }

    // Dedup
    const existingRefs = new Set<string>();
    const allRefs = allRows.map(r => r.referencia_unica);
    for (let i = 0; i < allRefs.length; i += 100) {
      const batch = allRefs.slice(i, i + 100);
      const { data: existing } = await sb.from("movimientos_banco")
        .select("referencia_unica")
        .eq("empresa_id", empresaId)
        .in("referencia_unica", batch);
      for (const r of (existing || [])) existingRefs.add(r.referencia_unica);
    }

    const newRows = allRows.filter(r => !existingRefs.has(r.referencia_unica));

    let inserted = 0;
    for (let i = 0; i < newRows.length; i += 500) {
      const batch = newRows.slice(i, i + 500);
      const { error } = await sb.from("movimientos_banco").insert(batch);
      if (error) console.error(`[MP Sync] Insert error:`, error.message);
      else inserted += batch.length;
    }

    const newCompras = newRows.filter(r => JSON.parse(r.metadata).tipo === "compra_propia").length;
    const newRetiros = newRows.filter(r => JSON.parse(r.metadata).tipo === "retiro").length;

    // Sync log
    await sb.from("sync_log").insert({
      empresa_id: empresaId,
      periodo,
      tipo: "mercadopago",
      registros: inserted,
    });

    return NextResponse.json({
      periodo,
      compras_encontradas: compras.length,
      retiros_encontrados: retiroRows.length,
      ya_existentes: existingRefs.size,
      compras_nuevas: newCompras,
      retiros_nuevos: newRetiros,
      total_insertado: inserted,
      detalle_compras: compras.map(p => {
        const td = p.transaction_details || {};
        return {
          fecha: safeDate(p.date_approved || p.date_created),
          monto_producto: p.transaction_amount,
          cupon: p.coupon_amount || 0,
          total_pagado: td.total_paid_amount || p.transaction_amount,
          medio: p.payment_method_id,
          cuotas: p.installments,
          orden_ml: p.order?.id || null,
        };
      }),
    });
  } catch (err) {
    console.error("[MP Sync] Error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
