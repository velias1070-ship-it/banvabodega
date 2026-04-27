/**
 * /api/pricing/rule-sets — CRUD de rule sets versionados.
 *
 * Manual: BANVA_Pricing_Engines_a_Escala §3.4 (lineas 182-205) — content-addressable
 * rule sets con publish -> approve (two-person) -> promote.
 *
 * GET    ?channel=production&domain=global   -> rule set activo
 * GET    ?list=1                              -> historial completo
 * POST   { rules, version_label, notes }     -> publica draft (idempotente por content_hash)
 * PATCH  { rule_set_id, approved_by }        -> aprueba draft (two-person)
 * PUT    { rule_set_id, channel, rollout_pct } -> promueve a canal
 *
 * No usa auth server-side (regla del repo). El campo created_by/approved_by
 * llega del cliente (sessionStorage admin) y queda en el log.
 */
import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import {
  loadActiveRuleSet,
  publishRuleSet,
  approveRuleSet,
  promoteRuleSet,
  type Channel,
  type Domain,
} from "@/lib/pricing-rules";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const list = sp.get("list") === "1";
  const channel = (sp.get("channel") || "production") as Channel;
  const domain  = (sp.get("domain")  || "global") as Domain;

  if (list) {
    const sb = getServerSupabase();
    if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

    const { data, error } = await sb
      .from("pricing_rule_sets")
      .select("id, domain, version_label, content_hash, status, created_by, created_at, approved_by, approved_at, notes, schema_version")
      .eq("domain", domain)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const { data: pointers } = await sb
      .from("pricing_rule_set_pointers")
      .select("channel, domain, rule_set_id, rollout_pct, activated_by, activated_at, notes")
      .eq("domain", domain);

    return NextResponse.json({ rule_sets: data || [], pointers: pointers || [] });
  }

  const rs = await loadActiveRuleSet(channel, domain);
  if (!rs) return NextResponse.json({ error: "no_active_rule_set" }, { status: 404 });
  return NextResponse.json({ rule_set: rs });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as
    | { rules?: Record<string, unknown>; version_label?: string; notes?: string; created_by?: string; parent_id?: string; domain?: Domain }
    | null;
  if (!body || !body.rules || !body.version_label || !body.created_by) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  const result = await publishRuleSet({
    domain:        body.domain || "global",
    version_label: body.version_label,
    rules:         body.rules,
    parent_id:     body.parent_id,
    created_by:    body.created_by,
    notes:         body.notes,
  });
  if (!result) return NextResponse.json({ error: "publish_failed" }, { status: 500 });
  return NextResponse.json(result);
}

export async function PATCH(req: NextRequest) {
  const body = await req.json().catch(() => null) as
    | { rule_set_id?: string; approved_by?: string }
    | null;
  if (!body?.rule_set_id || !body?.approved_by) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  const r = await approveRuleSet(body.rule_set_id, body.approved_by);
  if (!r.ok) return NextResponse.json({ error: r.error || "approve_failed" }, { status: 400 });
  return NextResponse.json({ ok: true });
}

export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => null) as
    | { rule_set_id?: string; channel?: Channel; domain?: Domain; rollout_pct?: number; activated_by?: string; notes?: string }
    | null;
  if (!body?.rule_set_id || !body?.channel || !body?.activated_by) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  const r = await promoteRuleSet({
    rule_set_id:  body.rule_set_id,
    channel:      body.channel,
    domain:       body.domain || "global",
    rollout_pct:  body.rollout_pct ?? 100,
    activated_by: body.activated_by,
    notes:        body.notes,
  });
  if (!r.ok) return NextResponse.json({ error: r.error || "promote_failed" }, { status: 400 });
  return NextResponse.json({ ok: true });
}
