import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { mlGet, ensureValidToken } from "@/lib/ml";

export const maxDuration = 300;

const SITE_ID = "MLC";
const SAFE_METRICS = [
  "clicks", "prints", "ctr", "cost", "cpc", "acos", "roas", "cvr", "sov",
  "direct_amount", "indirect_amount", "total_amount",
  "direct_units_quantity", "indirect_units_quantity", "units_quantity",
  "direct_items_quantity", "indirect_items_quantity",
  "organic_units_quantity", "organic_items_quantity", "organic_units_amount",
].join(",");

const JOB_NAME = "campaigns_daily";
const EARLY_RETURN_MIN = 30;

interface AdsCampaignDay {
  id: number;
  name?: string;
  status?: string;
  strategy?: string | null;
  acos_target?: number | null;
  budget?: number | null;
  metrics?: {
    clicks?: number; prints?: number; ctr?: number; cost?: number; cpc?: number;
    acos?: number; roas?: number; cvr?: number; sov?: number;
    direct_amount?: number; indirect_amount?: number; total_amount?: number;
    direct_units_quantity?: number; indirect_units_quantity?: number;
    direct_items_quantity?: number; indirect_items_quantity?: number;
    organic_units_quantity?: number; organic_items_quantity?: number; organic_units_amount?: number;
  };
}

function isAuthorized(req: NextRequest): boolean {
  const cron = req.headers.get("authorization") === `Bearer ${process.env.CRON_SECRET}`;
  const internal = req.headers.get("x-internal") === "1";
  const local = process.env.NODE_ENV === "development";
  const admin = (req.headers.get("referer") || "").includes("/admin");
  return cron || internal || local || admin;
}

async function syncOneDay(advertiserId: string, date: string, sb: ReturnType<typeof getServerSupabase>) {
  if (!sb) throw new Error("no_db");
  const url = `/marketplace/advertising/${SITE_ID}/advertisers/${advertiserId}/product_ads/campaigns/search` +
    `?limit=50&date_from=${date}&date_to=${date}&metrics=${SAFE_METRICS}`;
  const resp = await mlGet<{ results?: AdsCampaignDay[]; paging?: { total: number } }>(url, { "api-version": "2" });
  if (!resp || !Array.isArray(resp.results)) return { rows: 0, ok: false };

  const rows = resp.results.map(c => {
    const m = c.metrics || {};
    return {
      campaign_id: c.id,
      date,
      prints: m.prints ?? null,
      clicks: m.clicks ?? null,
      cpc: m.cpc ?? null,
      ctr: m.ctr ?? null,
      cvr: m.cvr ?? null,
      sov: m.sov ?? null,
      // Bloqueados por tier — quedan NULL (ver §1.1 preauditoría)
      impression_share: null,
      top_impression_share: null,
      lost_by_budget: null,
      lost_by_rank: null,
      cost: m.cost ?? null,
      direct_amount: m.direct_amount ?? null,
      indirect_amount: m.indirect_amount ?? null,
      total_amount: m.total_amount ?? null,
      acos_real: m.acos ?? null,
      acos_benchmark: null,
      roas_real: m.roas ?? null,
      direct_units: m.direct_units_quantity ?? null,
      indirect_units: m.indirect_units_quantity ?? null,
      organic_units: m.organic_units_quantity ?? null,
      direct_items: m.direct_items_quantity ?? null,
      indirect_items: m.indirect_items_quantity ?? null,
      organic_items: m.organic_items_quantity ?? null,
      organic_amount: m.organic_units_amount ?? null,
      acos_target: c.acos_target ?? null,
      budget: c.budget ?? null,
      strategy: c.strategy ?? null,
      status: c.status ?? null,
      synced_at: new Date().toISOString(),
    };
  });

  if (rows.length === 0) return { rows: 0, ok: true };
  const { error } = await sb.from("ml_campaigns_daily_cache").upsert(rows, { onConflict: "campaign_id,date" });
  if (error) throw new Error(`upsert failed: ${error.message}`);
  return { rows: rows.length, ok: true };
}

async function recordHealth(sb: ReturnType<typeof getServerSupabase>, success: boolean, errMsg?: string) {
  if (!sb) return;
  const now = new Date().toISOString();
  if (success) {
    await sb.from("ml_sync_health").update({
      last_attempt_at: now, last_success_at: now, last_error: null, consecutive_failures: 0,
    }).eq("job_name", JOB_NAME);
  } else {
    const { data } = await sb.from("ml_sync_health").select("consecutive_failures").eq("job_name", JOB_NAME).single();
    const prev = (data as { consecutive_failures: number } | null)?.consecutive_failures ?? 0;
    await sb.from("ml_sync_health").update({
      last_attempt_at: now, last_error: errMsg ?? "unknown", consecutive_failures: prev + 1,
    }).eq("job_name", JOB_NAME);
  }
}

function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  const start = new Date(from + "T00:00:00Z");
  const end = new Date(to + "T00:00:00Z");
  for (const d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const body = await req.json().catch(() => ({}));
  const action = (body.action as string | undefined) ?? "sync";
  const isBackfill = action === "backfill";

  // Early-return de 30min para sync normal (no para backfill)
  if (!isBackfill) {
    const { data: health } = await sb.from("ml_sync_health").select("last_success_at").eq("job_name", JOB_NAME).single();
    const last = (health as { last_success_at: string | null } | null)?.last_success_at;
    if (last && Date.now() - new Date(last).getTime() < EARLY_RETURN_MIN * 60 * 1000) {
      return NextResponse.json({ status: "skipped", reason: "ran_recently", last_success_at: last });
    }
  }

  // Resolver advertiser_id
  const { data: cfg } = await sb.from("ml_config").select("advertiser_id").eq("id", "main").single();
  const advertiserId = (cfg as { advertiser_id: string } | null)?.advertiser_id;
  if (!advertiserId) {
    await recordHealth(sb, false, "no_advertiser_id");
    return NextResponse.json({ error: "no_advertiser_id" }, { status: 500 });
  }

  // Token check (fuerza refresh si es necesario)
  const token = await ensureValidToken();
  if (!token) {
    await recordHealth(sb, false, "no_valid_token");
    return NextResponse.json({ error: "no_valid_token" }, { status: 500 });
  }

  // Rango de fechas
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const dateFrom = (body.date_from as string | undefined) ?? (isBackfill ? "2026-01-01" : yesterday);
  const dateTo = (body.date_to as string | undefined) ?? (isBackfill ? today : yesterday);

  // Validar rango
  const startMs = new Date(dateFrom + "T00:00:00Z").getTime();
  const endMs = new Date(dateTo + "T00:00:00Z").getTime();
  if (isNaN(startMs) || isNaN(endMs) || startMs > endMs) {
    return NextResponse.json({ error: "invalid_date_range", date_from: dateFrom, date_to: dateTo }, { status: 400 });
  }

  let totalRows = 0;
  let daysProcessed = 0;
  const errors: string[] = [];
  const startTime = Date.now();
  const TIME_LIMIT = 280_000; // dejar margen sobre maxDuration=300

  for (const day of dateRange(dateFrom, dateTo)) {
    if (Date.now() - startTime > TIME_LIMIT) {
      errors.push(`time_limit reached at ${day}`);
      break;
    }
    try {
      const r = await syncOneDay(advertiserId, day, sb);
      totalRows += r.rows;
      daysProcessed++;
    } catch (err) {
      errors.push(`${day}: ${String(err)}`);
    }
    if (isBackfill) await new Promise(r => setTimeout(r, 500)); // spacing para backfill
  }

  const ok = errors.length === 0 || daysProcessed > 0;
  await recordHealth(sb, ok, errors.length > 0 ? errors.slice(0, 3).join(" | ") : undefined);

  return NextResponse.json({
    status: ok ? "ok" : "error",
    action,
    date_from: dateFrom,
    date_to: dateTo,
    days_processed: daysProcessed,
    rows_upserted: totalRows,
    errors: errors.length > 0 ? errors : undefined,
  });
}

export async function GET(req: NextRequest) {
  return POST(req);
}
