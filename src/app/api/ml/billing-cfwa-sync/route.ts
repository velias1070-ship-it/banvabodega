import { NextRequest, NextResponse } from "next/server";
import { mlGetRaw } from "@/lib/ml";
import { getServerSupabase } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 300;

/**
 * Sync CFWA (almacenamiento Full) diario.
 *
 * Consulta los períodos ML indicados (por defecto: actual + anterior) filtrando
 * por subtypes=CFWA, pagina con from_id cursor respetando rate limit 5/min,
 * y hace upsert en ml_billing_cfwa por detail_id.
 *
 * Uso:
 *   GET /api/ml/billing-cfwa-sync                 (actual + anterior)
 *   GET /api/ml/billing-cfwa-sync?periods=2026-02-01,2026-03-01,2026-04-01
 *
 * Los montos persistidos son BRUTOS (con IVA) — ver memoria
 * project_ml_billing_api.md.
 */

const SYNC_SECRET = process.env.ML_SYNC_SECRET || "";

function isAuthorized(req: NextRequest): boolean {
  const authHeader = req.headers.get("authorization");
  const querySecret = req.nextUrl.searchParams.get("secret");
  const isVercelCron = authHeader === `Bearer ${process.env.CRON_SECRET}`;
  const isManual = SYNC_SECRET && querySecret === SYNC_SECRET;
  const isLocalDev = process.env.NODE_ENV === "development";
  return isVercelCron || isManual || isLocalDev || !SYNC_SECRET;
}

type CfwaRow = {
  charge_info?: {
    detail_id?: number;
    detail_sub_type?: string;
    detail_amount?: number;
    creation_date_time?: string;
    legal_document_number?: string;
    legal_document_status?: string;
    transaction_detail?: string;
  };
  discount_info?: {
    charge_amount_without_discount?: number;
    discount_amount?: number;
  };
  document_info?: { document_id?: number };
  marketplace_info?: { marketplace?: string };
};

type BillingResp = {
  results?: CfwaRow[];
  last_id?: number | string;
  total?: number;
  errors?: unknown[];
};

function currentPeriodKey(): string {
  // Período ML corta ~día 26. Si estamos antes del 27, el período actual es
  // el mes en curso (key YYYY-MM-01). Si es ≥27, ya empezó el del mes siguiente.
  const d = new Date();
  const day = d.getUTCDate();
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  if (day >= 27) {
    const next = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 };
    return `${next.y}-${String(next.m).padStart(2, "0")}-01`;
  }
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

function previousPeriodKey(key: string): string {
  const [y, m] = key.split("-").map(Number);
  if (m === 1) return `${y - 1}-12-01`;
  return `${y}-${String(m - 1).padStart(2, "0")}-01`;
}

async function syncPeriod(periodKey: string): Promise<{ upserted: number; pages: number; error?: string }> {
  const sb = getServerSupabase();
  if (!sb) return { upserted: 0, pages: 0, error: "no_db" };

  let fromId = "0";
  let pages = 0;
  let upserted = 0;
  const pageSize = 1000;
  const maxPages = 20;

  while (pages < maxPages) {
    const qs = new URLSearchParams({
      document_type: "BILL",
      limit: String(pageSize),
      sort_by: "ID",
      order_by: "ASC",
      from_id: fromId,
      detail_sub_types: "CFWA",
    });
    const path = `/billing/integration/periods/key/${periodKey}/group/ML/details?${qs.toString()}`;

    // Retry con backoff en 429
    let data: BillingResp | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      data = await mlGetRaw(path) as BillingResp | null;
      if (data) break;
      await new Promise(r => setTimeout(r, 20000 * (attempt + 1)));
    }
    if (!data) {
      return { upserted, pages, error: `ml_failed at page ${pages + 1} period ${periodKey}` };
    }

    const page = Array.isArray(data.results) ? data.results : [];
    pages++;

    if (page.length > 0) {
      const batch = page
        .filter(r => r.charge_info?.detail_id && r.charge_info?.detail_sub_type === "CFWA")
        .map(r => {
          const ci = r.charge_info!;
          const di = r.discount_info || {};
          const day = (ci.creation_date_time || "").slice(0, 10);
          return {
            detail_id: ci.detail_id,
            day,
            amount: Number(ci.detail_amount || 0),
            gross: Number(di.charge_amount_without_discount ?? ci.detail_amount ?? 0),
            discount: Number(di.discount_amount ?? 0),
            creation_date_time: ci.creation_date_time,
            document_id: r.document_info?.document_id ?? null,
            legal_document_number: ci.legal_document_number ?? null,
            legal_document_status: ci.legal_document_status ?? null,
            period_key: periodKey,
            marketplace: r.marketplace_info?.marketplace ?? null,
            transaction_detail: ci.transaction_detail ?? null,
            updated_at: new Date().toISOString(),
          };
        });

      if (batch.length > 0) {
        const { error } = await sb.from("ml_billing_cfwa").upsert(batch, { onConflict: "detail_id" });
        if (error) return { upserted, pages, error: `upsert failed: ${error.message}` };
        upserted += batch.length;
      }
    }

    const nextFromId = data.last_id;
    if (!nextFromId || page.length < pageSize) break;
    if (String(nextFromId) === fromId) break;
    fromId = String(nextFromId);

    // Rate limit 5/min. 15s entre páginas.
    await new Promise(r => setTimeout(r, 15000));
  }

  return { upserted, pages };
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const t0 = Date.now();
  const url = req.nextUrl;
  const periodsParam = url.searchParams.get("periods");
  const periods: string[] = periodsParam
    ? periodsParam.split(",").map(p => p.trim()).filter(Boolean)
    : [currentPeriodKey(), previousPeriodKey(currentPeriodKey())];

  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const results: Record<string, { upserted: number; pages: number; error?: string }> = {};
  let totalUpserted = 0;
  const errors: string[] = [];

  for (const periodKey of periods) {
    const res = await syncPeriod(periodKey);
    results[periodKey] = res;
    totalUpserted += res.upserted;
    if (res.error) errors.push(`${periodKey}: ${res.error}`);
  }

  const ms = Date.now() - t0;

  // Log del sync
  try {
    await sb.from("ml_billing_cfwa_sync_log").insert({
      periods_scanned: periods,
      rows_upserted: totalUpserted,
      rows_unchanged: null,
      errors: errors.length > 0 ? errors.join(" | ") : null,
      ms,
    });
  } catch { /* no-op */ }

  return NextResponse.json({
    ok: errors.length === 0,
    periods_scanned: periods,
    total_upserted: totalUpserted,
    per_period: results,
    errors,
    ms,
  });
}
