"use client";

import React, { useEffect, useState, useMemo } from "react";
import { getSupabase } from "@/lib/supabase";

// PR2 — UI mínima para togglear `flex_objetivo` por SKU.
// Lee de productos JOIN sku_intelligence para mostrar contexto (ABC, cuadrante,
// vel, stock_bodega). El toggle llama al endpoint que persiste y marca auto=false.
// No cambia cálculos del motor — eso es PR3.

interface FlexRow {
  sku: string;
  nombre: string;
  categoria: string;
  proveedor: string;
  flex_objetivo: boolean;
  flex_objetivo_auto: boolean;
  flex_objetivo_motivo: string | null;
  abc: string | null;
  cuadrante: string | null;
  vel_ponderada: number;
  stock_bodega: number;
  stock_full: number;
  pct_flex: number;
}

type Filter = "todos" | "activos" | "inactivos" | "auto" | "manual";

export default function AdminFlexObjetivo() {
  const [rows, setRows] = useState<FlexRow[]>([]);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("todos");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    const sb = getSupabase();
    if (!sb) { setLoading(false); return; }

    // Fetch productos con flex_objetivo
    const { data: prods, error: perr } = await sb
      .from("productos")
      .select("sku, nombre, categoria, proveedor, flex_objetivo, flex_objetivo_auto, flex_objetivo_motivo")
      .order("sku");
    if (perr) {
      console.error("[flex-objetivo] fetch productos:", perr.message);
      setLoading(false);
      return;
    }

    // Fetch sku_intelligence para contexto
    const { data: intel, error: ierr } = await sb
      .from("sku_intelligence")
      .select("sku_origen, abc, cuadrante, vel_ponderada, stock_bodega, stock_full, pct_flex");
    if (ierr) console.error("[flex-objetivo] fetch intel:", ierr.message);

    const intelMap = new Map<string, {
      abc: string | null; cuadrante: string | null;
      vel_ponderada: number; stock_bodega: number; stock_full: number; pct_flex: number;
    }>();
    for (const r of (intel || [])) {
      intelMap.set(r.sku_origen as string, {
        abc: (r.abc as string) || null,
        cuadrante: (r.cuadrante as string) || null,
        vel_ponderada: Number(r.vel_ponderada) || 0,
        stock_bodega: Number(r.stock_bodega) || 0,
        stock_full: Number(r.stock_full) || 0,
        pct_flex: Number(r.pct_flex) || 0,
      });
    }

    const joined: FlexRow[] = (prods || []).map((p) => ({
      sku: p.sku as string,
      nombre: (p.nombre as string) || "",
      categoria: (p.categoria as string) || "",
      proveedor: (p.proveedor as string) || "",
      flex_objetivo: Boolean(p.flex_objetivo),
      flex_objetivo_auto: Boolean(p.flex_objetivo_auto),
      flex_objetivo_motivo: (p.flex_objetivo_motivo as string) || null,
      ...(intelMap.get(p.sku as string) || { abc: null, cuadrante: null, vel_ponderada: 0, stock_bodega: 0, stock_full: 0, pct_flex: 0 }),
    }));

    setRows(joined);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (filter === "activos" && !r.flex_objetivo) return false;
      if (filter === "inactivos" && r.flex_objetivo) return false;
      if (filter === "auto" && !(r.flex_objetivo && r.flex_objetivo_auto)) return false;
      if (filter === "manual" && !(r.flex_objetivo && !r.flex_objetivo_auto)) return false;
      if (q) {
        const ql = q.toLowerCase();
        if (!r.sku.toLowerCase().includes(ql) && !r.nombre.toLowerCase().includes(ql)) return false;
      }
      return true;
    });
  }, [rows, q, filter]);

  const toggle = async (sku: string, nuevoValor: boolean) => {
    setSaving(sku);
    try {
      const res = await fetch(`/api/intelligence/sku/${encodeURIComponent(sku)}/flex-objetivo`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flex_objetivo: nuevoValor }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "Error en toggle");
      setRows((prev) => prev.map((r) =>
        r.sku === sku ? { ...r, flex_objetivo: nuevoValor, flex_objetivo_auto: false, flex_objetivo_motivo: j.flex_objetivo_motivo } : r,
      ));
    } catch (err) {
      alert(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(null);
    }
  };

  const counts = useMemo(() => ({
    total: rows.length,
    activos: rows.filter((r) => r.flex_objetivo).length,
    auto: rows.filter((r) => r.flex_objetivo && r.flex_objetivo_auto).length,
    manual: rows.filter((r) => r.flex_objetivo && !r.flex_objetivo_auto).length,
  }), [rows]);

  return (
    <div>
      <div className="card">
        <div className="card-title">Política Flex por SKU</div>
        <div style={{ fontSize: 12, color: "var(--txt3)", marginBottom: 8 }}>
          <code>flex_objetivo=true</code> → SKU debe sostener stock en bodega para publicar Flex (PR3 lo consumirá). 🤖 = migrado automáticamente, pendiente de validación humana.
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
          <input
            className="form-input mono"
            placeholder="Buscar SKU o nombre..."
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ flex: 1, minWidth: 200, fontSize: 12 }}
          />
          {(["todos", "activos", "inactivos", "auto", "manual"] as Filter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              style={{
                padding: "8px 14px",
                borderRadius: 8,
                background: filter === f ? "var(--cyan)" : "var(--bg3)",
                color: filter === f ? "#fff" : "var(--txt2)",
                fontWeight: 600,
                fontSize: 12,
                border: filter === f ? "none" : "1px solid var(--bg4)",
                textTransform: "capitalize",
              }}
            >
              {f}
            </button>
          ))}
          <button onClick={load} style={{ padding: "8px 14px", borderRadius: 8, background: "var(--bg3)", color: "var(--txt2)", fontSize: 12, border: "1px solid var(--bg4)" }}>
            🔄 Recargar
          </button>
        </div>
        <div style={{ fontSize: 11, color: "var(--txt3)" }}>
          {counts.total} SKUs · {counts.activos} con flex_objetivo · {counts.auto} 🤖 auto · {counts.manual} ✋ manual · mostrando {filtered.length}
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflow: "auto" }}>
        {loading ? (
          <div style={{ padding: 20, textAlign: "center", color: "var(--txt3)" }}>Cargando...</div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>SKU</th>
                <th>Nombre</th>
                <th>ABC</th>
                <th>Cuadrante</th>
                <th style={{ textAlign: "right" }}>Vel</th>
                <th style={{ textAlign: "right" }}>St.Bodega</th>
                <th style={{ textAlign: "right" }}>St.Full</th>
                <th style={{ textAlign: "right" }}>% Flex</th>
                <th style={{ textAlign: "center" }}>Flex obj.</th>
                <th>Motivo</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.sku}>
                  <td className="mono" style={{ fontSize: 11 }}>{r.sku}</td>
                  <td style={{ fontSize: 12 }}>{r.nombre}</td>
                  <td style={{ fontSize: 12, color: r.abc === "A" ? "var(--green)" : r.abc === "B" ? "var(--amber)" : "var(--txt3)" }}>{r.abc || "—"}</td>
                  <td style={{ fontSize: 11, color: "var(--txt2)" }}>{r.cuadrante || "—"}</td>
                  <td className="mono" style={{ textAlign: "right", fontSize: 11 }}>{r.vel_ponderada.toFixed(2)}</td>
                  <td className="mono" style={{ textAlign: "right", fontSize: 11 }}>{r.stock_bodega}</td>
                  <td className="mono" style={{ textAlign: "right", fontSize: 11 }}>{r.stock_full}</td>
                  <td className="mono" style={{ textAlign: "right", fontSize: 11 }}>{(r.pct_flex * 100).toFixed(0)}%</td>
                  <td style={{ textAlign: "center" }}>
                    <button
                      disabled={saving === r.sku}
                      onClick={() => toggle(r.sku, !r.flex_objetivo)}
                      style={{
                        padding: "4px 10px",
                        borderRadius: 6,
                        background: r.flex_objetivo ? "var(--green)" : "var(--bg3)",
                        color: r.flex_objetivo ? "#fff" : "var(--txt3)",
                        fontWeight: 600,
                        fontSize: 11,
                        border: r.flex_objetivo ? "none" : "1px solid var(--bg4)",
                        cursor: saving === r.sku ? "wait" : "pointer",
                        opacity: saving === r.sku ? 0.5 : 1,
                      }}
                    >
                      {r.flex_objetivo ? (r.flex_objetivo_auto ? "🤖 ON" : "✋ ON") : "OFF"}
                    </button>
                  </td>
                  <td style={{ fontSize: 10, color: "var(--txt3)" }}>{r.flex_objetivo_motivo || "—"}</td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={10} style={{ padding: 20, textAlign: "center", color: "var(--txt3)" }}>Sin resultados</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
