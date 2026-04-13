"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { fmtCLP } from "@/lib/ml-shipping";

type MarginRow = {
  item_id: string;
  sku: string;
  titulo: string;
  category_id: string | null;
  listing_type: string | null;
  price_ml: number;
  precio_venta: number;
  tiene_promo: boolean;
  promo_type: string | null;
  promo_pct: number | null;
  costo_neto: number;
  costo_bruto: number;
  peso_facturable: number;
  tramo_label: string | null;
  comision_pct: number;
  comision_clp: number;
  envio_clp: number;
  margen_clp: number;
  margen_pct: number;
  zona: "barato" | "medio" | "caro" | null;
  synced_at: string;
  sync_error: string | null;
};

type SortKey =
  | "sku"
  | "titulo"
  | "precio_venta"
  | "costo_bruto"
  | "comision_clp"
  | "envio_clp"
  | "margen_clp"
  | "margen_pct"
  | "peso_facturable";

type ZonaFilter = "all" | "barato" | "medio" | "caro";
type MarginFilter = "all" | "neg" | "low" | "mid" | "high";

export default function AdminMargenes() {
  const [rows, setRows] = useState<MarginRow[]>([]);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Refresh state
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null);
  const [progress, setProgress] = useState({ processed: 0, total: 0 });

  // Filters
  const [q, setQ] = useState("");
  const [zona, setZona] = useState<ZonaFilter>("all");
  const [marginF, setMarginF] = useState<MarginFilter>("all");
  const [soloPromo, setSoloPromo] = useState(false);
  const [soloDead, setSoloDead] = useState(false);

  // Sort
  const [sortKey, setSortKey] = useState<SortKey>("margen_pct");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const loadCache = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/ml/margin-cache");
      const data = await res.json();
      setRows(data.items || []);
      setLastSync(data.last_sync || null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadCache(); }, [loadCache]);

  const handleRefresh = async () => {
    setRefreshing(true);
    setRefreshMsg("Iniciando...");
    setProgress({ processed: 0, total: 0 });
    try {
      let offset = 0;
      const limit = 15;
      while (true) {
        const res = await fetch(`/api/ml/margin-cache/refresh?offset=${offset}&limit=${limit}`, { method: "POST" });
        const data = await res.json();
        if (!res.ok) {
          setRefreshMsg(`Error: ${data.error || res.statusText}`);
          break;
        }
        setProgress({ processed: data.processed, total: data.total });
        setRefreshMsg(`Procesando ${data.processed}/${data.total}...`);
        offset = data.processed;
        if (data.done || data.chunk === 0) {
          setRefreshMsg(`Refresh completo: ${data.processed} items`);
          break;
        }
      }
      await loadCache();
    } catch (e) {
      setRefreshMsg(`Error: ${e instanceof Error ? e.message : "?"}`);
    } finally {
      setRefreshing(false);
      setTimeout(() => setRefreshMsg(null), 5000);
    }
  };

  const filtered = useMemo(() => {
    const qLower = q.trim().toLowerCase();
    let list = rows.filter(r => {
      if (qLower && !(r.sku.toLowerCase().includes(qLower) || r.titulo.toLowerCase().includes(qLower) || r.item_id.toLowerCase().includes(qLower))) return false;
      if (zona !== "all" && r.zona !== zona) return false;
      if (soloPromo && !r.tiene_promo) return false;
      // Dead zone: precio_venta en [19990, 28250] (aprox) donde margen < sweet spot bajo threshold
      if (soloDead) {
        if (r.precio_venta < 19990) return false;
        if (r.margen_pct >= 22) return false;
      }
      if (marginF === "neg" && r.margen_pct >= 0) return false;
      if (marginF === "low" && (r.margen_pct < 0 || r.margen_pct >= 15)) return false;
      if (marginF === "mid" && (r.margen_pct < 15 || r.margen_pct >= 30)) return false;
      if (marginF === "high" && r.margen_pct < 30) return false;
      return true;
    });
    list = [...list].sort((a, b) => {
      const av = a[sortKey] as number | string;
      const bv = b[sortKey] as number | string;
      if (typeof av === "number" && typeof bv === "number") {
        return sortDir === "asc" ? av - bv : bv - av;
      }
      return sortDir === "asc"
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
    });
    return list;
  }, [rows, q, zona, marginF, soloPromo, soloDead, sortKey, sortDir]);

  const toggleSort = (k: SortKey) => {
    if (k === sortKey) setSortDir(d => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(k); setSortDir("asc"); }
  };

  // KPIs
  const kpi = useMemo(() => {
    const count = filtered.length;
    const neg = filtered.filter(r => r.margen_clp < 0).length;
    const avgPct = count > 0 ? filtered.reduce((s, r) => s + Number(r.margen_pct), 0) / count : 0;
    const totalMargen = filtered.reduce((s, r) => s + r.margen_clp, 0);
    return { count, neg, avgPct, totalMargen };
  }, [filtered]);

  const SortHeader = ({ k, label, align = "right" }: { k: SortKey; label: string; align?: "left" | "right" }) => (
    <th
      onClick={() => toggleSort(k)}
      style={{
        padding: "10px 8px",
        textAlign: align,
        fontSize: 10,
        color: sortKey === k ? "var(--cyan)" : "var(--txt3)",
        cursor: "pointer",
        userSelect: "none",
        whiteSpace: "nowrap",
      }}
    >
      {label} {sortKey === k ? (sortDir === "asc" ? "▲" : "▼") : ""}
    </th>
  );

  const pct = progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0;
  const lastSyncLabel = lastSync ? new Date(lastSync).toLocaleString("es-CL") : "nunca";

  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: "var(--cyan)" }}>Márgenes por publicación</div>
          <div style={{ fontSize: 10, color: "var(--txt3)", marginTop: 2 }}>
            Último refresh: {lastSyncLabel} · {rows.length} items en cache
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {refreshMsg && (
            <div style={{ fontSize: 11, color: "var(--txt2)", padding: "4px 8px", background: "var(--bg3)", borderRadius: 4 }}>
              {refreshMsg}
              {refreshing && progress.total > 0 && <span style={{ marginLeft: 6, color: "var(--cyan)" }}>({pct}%)</span>}
            </div>
          )}
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="scan-btn blue"
            style={{ padding: "8px 14px", fontSize: 12, cursor: refreshing ? "wait" : "pointer" }}
          >
            {refreshing ? "Refrescando..." : "🔄 Refrescar"}
          </button>
        </div>
      </div>

      {refreshing && progress.total > 0 && (
        <div style={{ height: 4, background: "var(--bg3)", borderRadius: 2, marginBottom: 12, overflow: "hidden" }}>
          <div style={{ height: "100%", background: "var(--cyan)", width: `${pct}%`, transition: "width 0.3s" }} />
        </div>
      )}

      {/* KPIs */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 14 }}>
        <Kpi label="Items filtrados" value={String(kpi.count)} color="var(--cyan)" />
        <Kpi label="En pérdida" value={String(kpi.neg)} color={kpi.neg > 0 ? "var(--red)" : "var(--green)"} />
        <Kpi label="Margen promedio" value={`${kpi.avgPct.toFixed(1)}%`} color={kpi.avgPct > 15 ? "var(--green)" : kpi.avgPct > 0 ? "var(--amber)" : "var(--red)"} />
        <Kpi label="Margen total" value={fmtCLP(kpi.totalMargen)} color={kpi.totalMargen > 0 ? "var(--green)" : "var(--red)"} />
      </div>

      {/* Filtros */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 14, alignItems: "center" }}>
        <input
          type="text"
          placeholder="Buscar SKU, título o item ID..."
          value={q}
          onChange={e => setQ(e.target.value)}
          className="form-input"
          style={{ flex: "1 1 240px", minWidth: 200 }}
        />
        <select value={zona} onChange={e => setZona(e.target.value as ZonaFilter)} className="form-input" style={{ flex: "0 0 auto" }}>
          <option value="all">Todas las zonas</option>
          <option value="barato">Barato (&lt;$9.990)</option>
          <option value="medio">Medio ($9.990-$19.989)</option>
          <option value="caro">Caro (≥$19.990)</option>
        </select>
        <select value={marginF} onChange={e => setMarginF(e.target.value as MarginFilter)} className="form-input" style={{ flex: "0 0 auto" }}>
          <option value="all">Todos los márgenes</option>
          <option value="neg">En pérdida (&lt;0%)</option>
          <option value="low">Bajo (0-15%)</option>
          <option value="mid">Medio (15-30%)</option>
          <option value="high">Alto (≥30%)</option>
        </select>
        <label style={{ fontSize: 11, color: "var(--txt2)", display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
          <input type="checkbox" checked={soloPromo} onChange={e => setSoloPromo(e.target.checked)} /> Con promo activa
        </label>
        <label style={{ fontSize: 11, color: "var(--txt2)", display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
          <input type="checkbox" checked={soloDead} onChange={e => setSoloDead(e.target.checked)} /> Solo dead zone
        </label>
      </div>

      {/* Tabla */}
      {loading ? (
        <div style={{ padding: 40, textAlign: "center", color: "var(--txt3)" }}>Cargando...</div>
      ) : filtered.length === 0 ? (
        <div style={{ padding: 40, textAlign: "center", color: "var(--txt3)" }}>
          {rows.length === 0
            ? 'Sin datos en cache. Presiona "🔄 Refrescar" para cargar.'
            : "Sin resultados para los filtros actuales."}
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
            <thead>
              <tr style={{ borderBottom: "2px solid var(--bg4)" }}>
                <SortHeader k="sku" label="SKU" align="left" />
                <SortHeader k="titulo" label="Título" align="left" />
                <SortHeader k="peso_facturable" label="Peso" />
                <SortHeader k="precio_venta" label="Precio venta" />
                <SortHeader k="costo_bruto" label="Costo+IVA" />
                <SortHeader k="comision_clp" label="Comisión" />
                <SortHeader k="envio_clp" label="Envío" />
                <SortHeader k="margen_clp" label="Margen" />
                <SortHeader k="margen_pct" label="%" />
                <th style={{ padding: "10px 8px", textAlign: "center", fontSize: 10, color: "var(--txt3)" }}>Zona</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => {
                const negColor = r.margen_clp < 0 ? "var(--red)" : r.margen_pct < 15 ? "var(--amber)" : "var(--green)";
                return (
                  <tr key={r.item_id} style={{ borderBottom: "1px solid var(--bg4)" }}>
                    <td className="mono" style={{ padding: "9px 8px", fontSize: 10, color: "var(--txt2)" }}>
                      <div>{r.sku}</div>
                      <div style={{ fontSize: 9, color: "var(--txt3)" }}>{r.item_id}</div>
                    </td>
                    <td style={{ padding: "9px 8px", maxWidth: 260 }}>
                      <div style={{ fontSize: 11, color: "var(--txt)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.titulo}</div>
                      {r.tiene_promo && (
                        <div style={{ fontSize: 9, color: "var(--amber)" }}>
                          {r.promo_type} −{r.promo_pct}% (lista {fmtCLP(r.price_ml)})
                        </div>
                      )}
                    </td>
                    <td className="mono" style={{ padding: "9px 8px", textAlign: "right", fontSize: 10, color: "var(--txt3)" }}>
                      {r.peso_facturable ? `${(r.peso_facturable / 1000).toFixed(1)} kg` : "—"}
                      {r.tramo_label && <div style={{ fontSize: 8 }}>{r.tramo_label}</div>}
                    </td>
                    <td className="mono" style={{ padding: "9px 8px", textAlign: "right", fontWeight: 700 }}>{fmtCLP(r.precio_venta)}</td>
                    <td className="mono" style={{ padding: "9px 8px", textAlign: "right", color: "var(--txt2)", fontSize: 10 }}>{fmtCLP(r.costo_bruto)}</td>
                    <td className="mono" style={{ padding: "9px 8px", textAlign: "right", color: "var(--txt2)", fontSize: 10 }}>{fmtCLP(r.comision_clp)}</td>
                    <td className="mono" style={{ padding: "9px 8px", textAlign: "right", color: "var(--txt2)", fontSize: 10 }}>{fmtCLP(r.envio_clp)}</td>
                    <td className="mono" style={{ padding: "9px 8px", textAlign: "right", color: negColor, fontWeight: 700 }}>{fmtCLP(r.margen_clp)}</td>
                    <td className="mono" style={{ padding: "9px 8px", textAlign: "right", color: negColor, fontSize: 10 }}>{Number(r.margen_pct).toFixed(1)}%</td>
                    <td style={{ padding: "9px 8px", textAlign: "center", fontSize: 9, textTransform: "uppercase", color: "var(--txt3)" }}>{r.zona || "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Kpi({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ background: "var(--bg3)", borderRadius: 8, padding: "10px 12px", border: "1px solid var(--bg4)" }}>
      <div style={{ fontSize: 9, color: "var(--txt3)", textTransform: "uppercase", marginBottom: 4 }}>{label}</div>
      <div className="mono" style={{ fontSize: 16, fontWeight: 700, color }}>{value}</div>
    </div>
  );
}
