"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getSupabase } from "@/lib/supabase";

const fmt = (n: number) => "$" + Math.round(n).toLocaleString("es-CL");

type CfwaRow = { day: string; amount: number };

export default function CostosFullCard() {
  const [rows, setRows] = useState<CfwaRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<string | null>(null);

  const load = useCallback(async () => {
    const sb = getSupabase(); if (!sb) return;
    setLoading(true);
    setError(null);
    try {
      const sinceDate = new Date();
      sinceDate.setDate(sinceDate.getDate() - 90);
      const since = sinceDate.toISOString().slice(0, 10);
      const { data, error } = await sb
        .from("ml_billing_cfwa")
        .select("day, amount")
        .gte("day", since)
        .order("day", { ascending: false });
      if (error) throw error;
      const agg = new Map<string, number>();
      for (const r of data || []) {
        agg.set(r.day, (agg.get(r.day) || 0) + Number(r.amount));
      }
      const flat: CfwaRow[] = Array.from(agg.entries()).map(([day, amount]) => ({ day, amount }));
      flat.sort((a, b) => b.day.localeCompare(a.day));
      setRows(flat);

      const { data: log } = await sb
        .from("ml_billing_cfwa_sync_log")
        .select("ran_at")
        .order("ran_at", { ascending: false })
        .limit(1);
      if (log?.[0]?.ran_at) setLastSync(log[0].ran_at);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function triggerSync() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/ml/billing-cfwa-sync", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.errors?.join(" | ") || "sync failed");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  const kpis = useMemo(() => {
    const now = new Date();
    const mesActual = now.toISOString().slice(0, 7);
    const last7Date = new Date();
    last7Date.setDate(last7Date.getDate() - 7);
    const last7Cutoff = last7Date.toISOString().slice(0, 10);

    let mesTotal = 0, mesDias = 0;
    let last7 = 0, last7Dias = 0;
    let total90 = 0;
    for (const r of rows) {
      total90 += r.amount;
      if (r.day.startsWith(mesActual)) { mesTotal += r.amount; mesDias++; }
      if (r.day >= last7Cutoff) { last7 += r.amount; last7Dias++; }
    }
    const promMes = mesDias > 0 ? mesTotal / mesDias : 0;
    const promLast7 = last7Dias > 0 ? last7 / last7Dias : 0;
    return { mesTotal, mesDias, promMes, last7, last7Dias, promLast7, total90 };
  }, [rows]);

  const maxAmount = Math.max(...rows.map(r => r.amount), 1);
  const chartRows = rows.slice(0, 30).reverse();

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, gap: 10, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700 }}>🏬 Costos Full — Almacenamiento (CFWA)</div>
          <div style={{ fontSize: 10, color: "var(--txt3)" }}>
            Montos con IVA · {rows.length} días cargados
            {lastSync && ` · último sync ${new Date(lastSync).toLocaleString("es-CL", { dateStyle: "short", timeStyle: "short" })}`}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            onClick={triggerSync}
            disabled={loading}
            style={{ padding: "4px 10px", borderRadius: 4, fontSize: 11, fontWeight: 600, background: "var(--cyanBg)", color: "var(--cyan)", border: "1px solid var(--cyanBd)", cursor: loading ? "wait" : "pointer" }}
            title="Llamar /api/ml/billing-cfwa-sync ahora (trae período actual + anterior)"
          >
            {loading ? "Sync..." : "🔄 Sync ahora"}
          </button>
          <button
            onClick={() => setExpanded(e => !e)}
            style={{ padding: "4px 10px", borderRadius: 4, fontSize: 11, fontWeight: 600, background: "var(--bg4)", color: "var(--txt2)", border: "1px solid var(--bg4)", cursor: "pointer" }}
          >
            {expanded ? "Ocultar tabla" : "Ver tabla"}
          </button>
        </div>
      </div>

      {error && (
        <div style={{ padding: "8px 12px", borderRadius: 6, fontSize: 11, background: "var(--redBg)", color: "var(--red)", border: "1px solid var(--red)", marginBottom: 10 }}>
          ⚠ {error}
        </div>
      )}

      {rows.length === 0 && !loading && (
        <div style={{ fontSize: 11, color: "var(--txt3)", fontStyle: "italic" }}>
          Aún no hay datos. Presiona &quot;Sync ahora&quot; para hacer la primera carga.
        </div>
      )}

      {rows.length > 0 && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 12, fontSize: 11 }}>
            <Kpi label="Mes en curso" value={fmt(kpis.mesTotal)} sub={`${kpis.mesDias}d · prom ${fmt(kpis.promMes)}/día`} />
            <Kpi label="Últimos 7 días" value={fmt(kpis.last7)} sub={`prom ${fmt(kpis.promLast7)}/día`} />
            <Kpi label="Últimos 90d (total)" value={fmt(kpis.total90)} sub={`${rows.length} días`} />
            <Kpi label="Último día" value={rows[0] ? fmt(rows[0].amount) : "—"} sub={rows[0]?.day || ""} />
          </div>

          <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 100, marginBottom: 8 }}>
            {chartRows.map(r => {
              const h = Math.max(4, (r.amount / maxAmount) * 95);
              return (
                <div key={r.day} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", minWidth: 0 }}
                  title={`${r.day}: ${fmt(r.amount)}`}>
                  <div style={{ width: "80%", maxWidth: 30, height: h, background: "var(--amberBg)", borderRadius: "3px 3px 0 0", border: "1px solid var(--amberBd)" }} />
                  <div style={{ fontSize: 8, color: "var(--txt3)", marginTop: 3, transform: chartRows.length > 15 ? "rotate(-45deg)" : undefined, whiteSpace: "nowrap" }}>{r.day.slice(5)}</div>
                </div>
              );
            })}
          </div>

          {expanded && (
            <div style={{ marginTop: 12, maxHeight: 360, overflowY: "auto", border: "1px solid var(--bg4)", borderRadius: 6 }}>
              <table className="tbl" style={{ width: "100%", fontSize: 11 }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left", padding: "6px 10px" }}>Día</th>
                    <th style={{ textAlign: "right", padding: "6px 10px" }}>CFWA (c/IVA)</th>
                    <th style={{ textAlign: "right", padding: "6px 10px" }}>Neto (÷1.19)</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.day} style={{ borderTop: "1px solid var(--bg4)" }}>
                      <td style={{ padding: "6px 10px", fontFamily: "var(--font-mono, monospace)" }}>{r.day}</td>
                      <td style={{ padding: "6px 10px", textAlign: "right", fontFamily: "var(--font-mono, monospace)", fontWeight: 600 }}>{fmt(r.amount)}</td>
                      <td style={{ padding: "6px 10px", textAlign: "right", color: "var(--txt3)", fontFamily: "var(--font-mono, monospace)" }}>{fmt(r.amount / 1.19)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ padding: "8px 10px", background: "var(--bg3)", borderRadius: 6, border: "1px solid var(--bg4)" }}>
      <div style={{ fontSize: 9, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 700, fontFamily: "var(--font-mono, monospace)", marginTop: 2 }}>{value}</div>
      {sub && <div style={{ fontSize: 9, color: "var(--txt3)", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}
