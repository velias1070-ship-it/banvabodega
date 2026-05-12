import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

// GET /api/health/motor-status
//
// Devuelve estado de salud del motor de inteligencia. Pensado para que
// Viki (cron en droplet) lo consulte cada hora y mande WhatsApp si detecta
// algo mal. No requiere auth — es read-only y no expone datos sensibles.
//
// Response shape:
//   {
//     ok: boolean,                    // true si todo verde
//     timestamp: string,              // momento del check
//     checks: {
//       sku_intelligence: {
//         total_skus, last_update_at, hours_since_update,
//         status: "ok" | "warn" | "fail"
//       },
//       sku_node_policy: { ... mismo shape ... },
//       audit_log_recent_errors: { count_last_24h, samples }
//     },
//     alerts: string[]                // mensajes ya formateados para WA
//   }
//
// Reglas:
//   - sku_intelligence vieja > 26h → warn ; > 48h → fail
//   - sku_node_policy vieja > 26h → warn ; > 48h → fail
//   - cron_policy_sync con error en últimas 24h → warn
//   - rows_affected=0 últimas 2 corridas → warn (cron corre pero no actualiza)
//
// Defensa contra DB saturada:
//   - count: "estimated" (pg_class.reltuples, instantáneo, error <5%)
//   - cada query envuelta en withTimeout (3s) — si una falla, el check va
//     a warn pero el endpoint responde
//   - maxDuration 10s en Vercel como último recurso

export const dynamic = "force-dynamic";
export const maxDuration = 10;

interface Check {
  status: "ok" | "warn" | "fail";
  message?: string;
  data?: Record<string, unknown>;
}

async function withTimeout<T>(
  p: PromiseLike<T>,
  ms: number,
  label: string,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  return Promise.race([
    Promise.resolve(p).then((value) => ({ ok: true as const, value })),
    new Promise<{ ok: false; error: string }>((resolve) =>
      setTimeout(
        () => resolve({ ok: false as const, error: `timeout ${ms}ms on ${label}` }),
        ms,
      ),
    ),
  ]);
}

const QUERY_TIMEOUT_MS = 3000;

export async function GET(_req: NextRequest) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ ok: false, error: "no_db" }, { status: 500 });

  const now = new Date();
  const checks: Record<string, Check> = {};
  const alerts: string[] = [];

  // 1. sku_intelligence freshness
  const siRes = await withTimeout(
    sb.from("sku_intelligence")
      .select("updated_at").order("updated_at", { ascending: false }).limit(1),
    QUERY_TIMEOUT_MS,
    "sku_intelligence.updated_at",
  );
  const siCountRes = await withTimeout(
    sb.from("sku_intelligence")
      .select("*", { count: "estimated", head: true }),
    QUERY_TIMEOUT_MS,
    "sku_intelligence.count",
  );

  if (!siRes.ok || !siCountRes.ok) {
    const which = !siRes.ok ? siRes.error : siCountRes.ok ? "" : siCountRes.error;
    checks.sku_intelligence = { status: "warn", message: `query_timeout: ${which}` };
    alerts.push("🟡 motor-status no pudo medir sku_intelligence (timeout)");
  } else {
    const si = siRes.value.data;
    const siCount = siCountRes.value.count;
    if (si && si.length > 0) {
      const last = new Date((si[0] as { updated_at: string }).updated_at);
      const hours = (now.getTime() - last.getTime()) / 3600000;
      const status: Check["status"] = hours > 48 ? "fail" : hours > 26 ? "warn" : "ok";
      checks.sku_intelligence = {
        status,
        data: { total_skus: siCount, last_update_at: last.toISOString(), hours_since_update: Math.round(hours * 10) / 10 },
      };
      if (status === "fail") alerts.push(`🔴 Motor viejo (sku_intelligence) sin actualizar hace ${Math.round(hours)}h. Cron recalcular caído.`);
      else if (status === "warn") alerts.push(`🟡 Motor viejo (sku_intelligence) hace ${Math.round(hours)}h sin update. Verificar cron.`);
    } else {
      checks.sku_intelligence = { status: "fail", message: "tabla vacía" };
      alerts.push("🔴 sku_intelligence está vacío. Motor caído.");
    }
  }

  // 2. sku_node_policy freshness
  const snpRes = await withTimeout(
    sb.from("sku_node_policy")
      .select("updated_at").order("updated_at", { ascending: false }).limit(1),
    QUERY_TIMEOUT_MS,
    "sku_node_policy.updated_at",
  );
  const snpCountRes = await withTimeout(
    sb.from("sku_node_policy")
      .select("*", { count: "estimated", head: true }),
    QUERY_TIMEOUT_MS,
    "sku_node_policy.count",
  );

  if (!snpRes.ok || !snpCountRes.ok) {
    const which = !snpRes.ok ? snpRes.error : snpCountRes.ok ? "" : snpCountRes.error;
    checks.sku_node_policy = { status: "warn", message: `query_timeout: ${which}` };
    alerts.push("🟡 motor-status no pudo medir sku_node_policy (timeout)");
  } else {
    const snp = snpRes.value.data;
    const snpCount = snpCountRes.value.count;
    if (snp && snp.length > 0) {
      const last = new Date((snp[0] as { updated_at: string }).updated_at);
      const hours = (now.getTime() - last.getTime()) / 3600000;
      const status: Check["status"] = hours > 48 ? "fail" : hours > 26 ? "warn" : "ok";
      checks.sku_node_policy = {
        status,
        data: { total_rows: snpCount, last_update_at: last.toISOString(), hours_since_update: Math.round(hours * 10) / 10 },
      };
      if (status === "fail") alerts.push(`🔴 Motor nuevo (sku_node_policy) sin sync hace ${Math.round(hours)}h. Cron sync-from-templates caído.`);
      else if (status === "warn") alerts.push(`🟡 Motor nuevo (sku_node_policy) hace ${Math.round(hours)}h sin sync.`);
    } else {
      checks.sku_node_policy = { status: "fail", message: "tabla vacía" };
      alerts.push("🔴 sku_node_policy está vacío. Templates no propagados.");
    }
  }

  // 3. Audit log: últimos errores de crons del motor
  const cutoff = new Date(now.getTime() - 24 * 3600000).toISOString();
  const auditRes = await withTimeout(
    sb.from("audit_log")
      .select("accion, resultado, created_at")
      .in("accion", ["cron_policy_sync", "cron_recalcular"])
      .gte("created_at", cutoff)
      .order("created_at", { ascending: false })
      .limit(20),
    QUERY_TIMEOUT_MS,
    "audit_log",
  );

  if (!auditRes.ok) {
    checks.audit_log_recent_errors = { status: "warn", message: `query_timeout: ${auditRes.error}` };
    alerts.push("🟡 motor-status no pudo medir audit_log (timeout)");
  } else {
    const auditRows = (auditRes.value.data || []) as Array<{ accion: string; resultado: Record<string, unknown> | null; created_at: string }>;
    const errores = auditRows.filter(r => {
      const res = r.resultado || {};
      return res.error || (res.rows_affected != null && Number(res.rows_affected) === 0);
    });
    checks.audit_log_recent_errors = {
      status: errores.length > 0 ? "warn" : "ok",
      data: { total_24h: auditRows.length, errors: errores.length, samples: errores.slice(0, 3) },
    };
    if (errores.length > 0) {
      alerts.push(`🟡 ${errores.length} corridas de cron con error o rows_affected=0 últimas 24h.`);
    }
  }

  // 4. Stock health: SKUs activos sin costo (sin_costo es bloqueante)
  const sinCostoRes = await withTimeout(
    sb.from("sku_intelligence")
      .select("*", { count: "estimated", head: true })
      .eq("costo_fuente", null)
      .gt("vel_ponderada", 0),
    QUERY_TIMEOUT_MS,
    "skus_sin_costo_con_venta",
  );

  if (!sinCostoRes.ok) {
    checks.skus_sin_costo_con_venta = { status: "warn", message: `query_timeout: ${sinCostoRes.error}` };
    alerts.push("🟡 motor-status no pudo medir skus_sin_costo_con_venta (timeout)");
  } else {
    const sinCosto = sinCostoRes.value.count;
    if (sinCosto && sinCosto > 5) {
      alerts.push(`🟡 ${sinCosto} SKUs vendiendo sin costo registrado.`);
    }
    checks.skus_sin_costo_con_venta = {
      status: (sinCosto || 0) > 20 ? "warn" : "ok",
      data: { count: sinCosto || 0 },
    };
  }

  const overall: "ok" | "warn" | "fail" =
    Object.values(checks).some(c => c.status === "fail") ? "fail"
    : Object.values(checks).some(c => c.status === "warn") ? "warn"
    : "ok";

  return NextResponse.json({
    ok: overall === "ok",
    overall,
    timestamp: now.toISOString(),
    checks,
    alerts,
  });
}
