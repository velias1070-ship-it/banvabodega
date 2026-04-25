"use client";

import { useEffect, useMemo, useState } from "react";

/**
 * Pricing Config — defaults por cuadrante + overrides por SKU.
 *
 * Granularidad jerarquica que prescribe BANVA_Pricing_Ajuste_Plan §5 +
 * Investigacion_Comparada §6.2: defaults por cuadrante (ESTRELLA/VOLUMEN/CASHCOW/
 * REVISAR + _DEFAULT fallback), override por SKU si hay razon documentada.
 */

type CuadranteRow = {
  cuadrante: string;
  margen_min_pct: number;
  politica_default: "defender" | "seguir" | "exprimir" | "liquidar";
  acos_objetivo_pct: number | null;
  descuento_max_pct: number | null;
  descuento_max_kvi_pct: number | null;
  canal_preferido: string | null;
  notas: string | null;
  updated_at?: string;
};

type SkuRow = {
  sku: string;
  nombre: string;
  categoria: string | null;
  proveedor: string | null;
  costo: number | null;
  costo_promedio: number | null;
  precio: number | null;
  precio_piso: number | null;
  margen_minimo_pct: number | null;
  politica_pricing: string | null;
  es_kvi: boolean | null;
  auto_postular: boolean | null;
  estado_sku: string | null;
  cuadrante: string | null;
  abc: string | null;
  abc_ingreso: string | null;
  abc_unidades: string | null;
  xyz: string | null;
  vel_ponderada: number | null;
  stock_total: number | null;
  margen_full_30d: number | null;
  precio_actual: number | null;
  dias_en_quiebre: number | null;
  factor_rampup: number | null;
};

const POLITICAS = ["defender", "seguir", "exprimir", "liquidar"] as const;
const CANALES = ["full", "flex", "mixto"] as const;
const CUAD_LABELS: Record<string, string> = {
  ESTRELLA: "Estrella (alto vol + alto margen)",
  VOLUMEN: "Crecimiento (alto vol + bajo margen)",
  CASHCOW: "Rentabilidad (bajo vol + alto margen)",
  REVISAR: "Dudoso (bajo vol + bajo margen)",
  _DEFAULT: "Sin cuadrante (fallback)",
};

const fmtCLP = (n: number | null | undefined) => n == null ? "—" : `$${Math.round(n).toLocaleString("es-CL")}`;
const fmtPct = (n: number | null | undefined) => n == null ? "—" : `${Number(n).toFixed(1)}%`;

export default function AdminPricingConfig() {
  const [cuadrantes, setCuadrantes] = useState<CuadranteRow[]>([]);
  const [skus, setSkus] = useState<SkuRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingCuad, setSavingCuad] = useState<string | null>(null);
  const [savingSku, setSavingSku] = useState<string | null>(null);
  const [filtroCuad, setFiltroCuad] = useState<string>("");
  const [filtroQ, setFiltroQ] = useState<string>("");
  const [filtroOverrides, setFiltroOverrides] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [c, s] = await Promise.all([
        fetch("/api/pricing-config/cuadrantes").then(r => r.json()),
        fetch("/api/pricing-config/skus").then(r => r.json()),
      ]);
      setCuadrantes(c.rows || []);
      setSkus(s.rows || []);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);

  const cuadranteByName = useMemo(() => {
    const m = new Map<string, CuadranteRow>();
    for (const c of cuadrantes) m.set(c.cuadrante, c);
    return m;
  }, [cuadrantes]);

  const skusFiltrados = useMemo(() => {
    let out = skus;
    if (filtroCuad) out = out.filter(s => (s.cuadrante || "_DEFAULT") === filtroCuad);
    if (filtroQ) {
      const q = filtroQ.toLowerCase();
      out = out.filter(s =>
        s.sku.toLowerCase().includes(q) ||
        (s.nombre || "").toLowerCase().includes(q) ||
        (s.proveedor || "").toLowerCase().includes(q)
      );
    }
    if (filtroOverrides) {
      out = out.filter(s =>
        s.precio_piso != null ||
        (s.margen_minimo_pct != null && s.margen_minimo_pct !== 15) ||
        (s.politica_pricing && s.politica_pricing !== "seguir") ||
        s.es_kvi || s.auto_postular
      );
    }
    return out.slice(0, 500);
  }, [skus, filtroCuad, filtroQ, filtroOverrides]);

  const margenEfectivo = (s: SkuRow): { val: number; fuente: "sku" | "cuadrante" | "default" } => {
    if (s.margen_minimo_pct != null && s.margen_minimo_pct !== 15) return { val: s.margen_minimo_pct, fuente: "sku" };
    const cu = cuadranteByName.get(s.cuadrante || "_DEFAULT") || cuadranteByName.get("_DEFAULT");
    if (cu) return { val: cu.margen_min_pct, fuente: "cuadrante" };
    return { val: 15, fuente: "default" };
  };

  const politicaEfectiva = (s: SkuRow): { val: string; fuente: "sku" | "cuadrante" | "default" } => {
    if (s.politica_pricing && s.politica_pricing !== "seguir") return { val: s.politica_pricing, fuente: "sku" };
    const cu = cuadranteByName.get(s.cuadrante || "_DEFAULT") || cuadranteByName.get("_DEFAULT");
    if (cu) return { val: cu.politica_default, fuente: "cuadrante" };
    return { val: "seguir", fuente: "default" };
  };

  const saveCuadrante = async (row: CuadranteRow, patch: Partial<CuadranteRow>) => {
    setSavingCuad(row.cuadrante);
    try {
      const resp = await fetch("/api/pricing-config/cuadrantes", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cuadrante: row.cuadrante, ...patch }),
      });
      if (!resp.ok) {
        const err = await resp.json();
        alert(`Error: ${err.error}`);
        return;
      }
      setCuadrantes(prev => prev.map(c => c.cuadrante === row.cuadrante ? { ...c, ...patch } : c));
    } finally {
      setSavingCuad(null);
    }
  };

  const saveSku = async (sku: string, patch: Partial<SkuRow>) => {
    setSavingSku(sku);
    try {
      const resp = await fetch("/api/pricing-config/skus", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sku, ...patch }),
      });
      if (!resp.ok) {
        const err = await resp.json();
        alert(`Error: ${err.error}`);
        return;
      }
      setSkus(prev => prev.map(s => s.sku === sku ? { ...s, ...patch } : s));
    } finally {
      setSavingSku(null);
    }
  };

  if (loading) return <div style={{ padding: 20, color: "var(--txt2)" }}>Cargando…</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>

      <div className="card" style={{ padding: 16 }}>
        <div style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 18, color: "var(--txt)" }}>💰 Pricing Config — Defaults por cuadrante</h2>
          <div style={{ fontSize: 12, color: "var(--txt3)", marginTop: 4 }}>
            Manual: <code style={{ color: "var(--cyan)" }}>BANVA_Pricing_Ajuste_Plan §5</code> + <code style={{ color: "var(--cyan)" }}>Investigacion_Comparada §6.2</code>. Override jerárquico: SKU &gt; cuadrante &gt; default.
          </div>
        </div>

        <div style={{ overflowX: "auto" }}>
          <table className="tbl" style={{ width: "100%", fontSize: 12 }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>Cuadrante</th>
                <th>Margen mín %</th>
                <th>Política default</th>
                <th>ACOS obj %</th>
                <th>Desc max %</th>
                <th>Desc max KVI %</th>
                <th>Canal</th>
                <th style={{ textAlign: "left" }}>Notas</th>
              </tr>
            </thead>
            <tbody>
              {cuadrantes.map(c => (
                <tr key={c.cuadrante} style={{ opacity: savingCuad === c.cuadrante ? 0.5 : 1 }}>
                  <td style={{ fontWeight: 700, color: "var(--cyan)" }}>
                    {c.cuadrante}
                    <div style={{ fontSize: 10, color: "var(--txt3)", fontWeight: 400 }}>{CUAD_LABELS[c.cuadrante] || ""}</div>
                  </td>
                  <td>
                    <input type="number" step="0.5" defaultValue={c.margen_min_pct}
                      onBlur={e => {
                        const v = parseFloat(e.target.value);
                        if (!Number.isNaN(v) && v !== c.margen_min_pct) void saveCuadrante(c, { margen_min_pct: v });
                      }}
                      style={inputStyle} />
                  </td>
                  <td>
                    <select defaultValue={c.politica_default}
                      onChange={e => {
                        const v = e.target.value as CuadranteRow["politica_default"];
                        if (v !== c.politica_default) void saveCuadrante(c, { politica_default: v });
                      }}
                      style={inputStyle}>
                      {POLITICAS.map(p => <option key={p} value={p}>{p}</option>)}
                    </select>
                  </td>
                  <td>
                    <input type="number" step="0.5" defaultValue={c.acos_objetivo_pct ?? ""}
                      onBlur={e => {
                        const v = e.target.value === "" ? null : parseFloat(e.target.value);
                        if (v !== c.acos_objetivo_pct) void saveCuadrante(c, { acos_objetivo_pct: v });
                      }}
                      style={inputStyle} />
                  </td>
                  <td>
                    <input type="number" step="1" defaultValue={c.descuento_max_pct ?? ""}
                      onBlur={e => {
                        const v = e.target.value === "" ? null : parseFloat(e.target.value);
                        if (v !== c.descuento_max_pct) void saveCuadrante(c, { descuento_max_pct: v });
                      }}
                      style={inputStyle} />
                  </td>
                  <td>
                    <input type="number" step="1" defaultValue={c.descuento_max_kvi_pct ?? ""}
                      onBlur={e => {
                        const v = e.target.value === "" ? null : parseFloat(e.target.value);
                        if (v !== c.descuento_max_kvi_pct) void saveCuadrante(c, { descuento_max_kvi_pct: v });
                      }}
                      style={inputStyle} />
                  </td>
                  <td>
                    <select defaultValue={c.canal_preferido || ""}
                      onChange={e => {
                        const v = e.target.value || null;
                        if (v !== c.canal_preferido) void saveCuadrante(c, { canal_preferido: v });
                      }}
                      style={inputStyle}>
                      <option value="">—</option>
                      {CANALES.map(p => <option key={p} value={p}>{p}</option>)}
                    </select>
                  </td>
                  <td style={{ fontSize: 11, color: "var(--txt3)", maxWidth: 280 }}>{c.notas}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ padding: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 18, color: "var(--txt)" }}>📋 Lista por SKU — overrides</h2>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input
              placeholder="Buscar SKU/nombre/proveedor"
              value={filtroQ}
              onChange={e => setFiltroQ(e.target.value)}
              style={{ ...inputStyle, width: 200 }}
            />
            <select value={filtroCuad} onChange={e => setFiltroCuad(e.target.value)} style={inputStyle}>
              <option value="">Todos cuadrantes</option>
              {cuadrantes.map(c => <option key={c.cuadrante} value={c.cuadrante}>{c.cuadrante}</option>)}
            </select>
            <label style={{ fontSize: 12, color: "var(--txt2)", display: "flex", alignItems: "center", gap: 4 }}>
              <input type="checkbox" checked={filtroOverrides} onChange={e => setFiltroOverrides(e.target.checked)} />
              Solo con override
            </label>
          </div>
        </div>

        <div style={{ fontSize: 11, color: "var(--txt3)", marginBottom: 8 }}>
          Mostrando {skusFiltrados.length} de {skus.length} SKUs. <span style={{ color: "var(--green)" }}>Verde</span> = override SKU, gris = default cuadrante.
        </div>

        <div style={{ overflowX: "auto", maxHeight: "60vh" }}>
          <table className="tbl" style={{ width: "100%", fontSize: 11 }}>
            <thead style={{ position: "sticky", top: 0, background: "var(--bg2)", zIndex: 1 }}>
              <tr>
                <th style={{ textAlign: "left" }}>SKU</th>
                <th style={{ textAlign: "left" }}>Nombre</th>
                <th>Cuadrante</th>
                <th>ABC</th>
                <th>XYZ</th>
                <th>Vel/d</th>
                <th>Stock</th>
                <th title="Días en quiebre">Q</th>
                <th>Costo prom.</th>
                <th>Precio actual</th>
                <th>Margen 30d</th>
                <th>Precio piso</th>
                <th>Margen mín %</th>
                <th>Política</th>
                <th>KVI</th>
                <th>Auto-post.</th>
              </tr>
            </thead>
            <tbody>
              {skusFiltrados.map(s => {
                const me = margenEfectivo(s);
                const pe = politicaEfectiva(s);
                return (
                  <tr key={s.sku} style={{ opacity: savingSku === s.sku ? 0.5 : 1 }}>
                    <td className="mono" style={{ fontWeight: 600 }}>{s.sku}</td>
                    <td style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.nombre}</td>
                    <td style={{ textAlign: "center" }}>
                      <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, background: "var(--bg3)", color: cuadColor(s.cuadrante) }}>
                        {s.cuadrante || "—"}
                      </span>
                    </td>
                    <td style={{ textAlign: "center", color: "var(--txt2)" }}>{s.abc || "—"}</td>
                    <td style={{ textAlign: "center", color: "var(--txt2)" }}>{s.xyz || "—"}</td>
                    <td style={{ textAlign: "right", color: "var(--txt2)" }}>{s.vel_ponderada != null ? Number(s.vel_ponderada).toFixed(2) : "—"}</td>
                    <td style={{ textAlign: "right", color: "var(--txt2)" }}>{s.stock_total ?? "—"}</td>
                    <td style={{ textAlign: "right", color: s.dias_en_quiebre && s.dias_en_quiebre > 0 ? "var(--red)" : "var(--txt3)" }}>
                      {s.dias_en_quiebre && s.dias_en_quiebre > 0 ? `${s.dias_en_quiebre}d` : "—"}
                    </td>
                    <td style={{ textAlign: "right" }}>{fmtCLP(s.costo_promedio)}</td>
                    <td style={{ textAlign: "right" }}>{fmtCLP(s.precio_actual)}</td>
                    <td style={{ textAlign: "right" }}>{fmtPct(s.margen_full_30d)}</td>
                    <td>
                      <input type="number" step="100" defaultValue={s.precio_piso ?? ""}
                        onBlur={e => {
                          const v = e.target.value === "" ? null : parseFloat(e.target.value);
                          if (v !== s.precio_piso) void saveSku(s.sku, { precio_piso: v });
                        }}
                        placeholder="—"
                        style={{ ...inputStyle, width: 80, color: s.precio_piso != null ? "var(--green)" : "var(--txt)" }} />
                    </td>
                    <td>
                      <input type="number" step="0.5" defaultValue={s.margen_minimo_pct ?? ""}
                        onBlur={e => {
                          const v = e.target.value === "" ? null : parseFloat(e.target.value);
                          if (v !== s.margen_minimo_pct) void saveSku(s.sku, { margen_minimo_pct: v });
                        }}
                        placeholder={`${me.val}`}
                        style={{ ...inputStyle, width: 60, color: me.fuente === "sku" ? "var(--green)" : "var(--txt3)" }}
                        title={`Efectivo: ${me.val}% (${me.fuente})`} />
                    </td>
                    <td>
                      <select defaultValue={s.politica_pricing || ""}
                        onChange={e => {
                          const v = e.target.value || null;
                          if (v !== s.politica_pricing) void saveSku(s.sku, { politica_pricing: v });
                        }}
                        style={{ ...inputStyle, width: 90, color: pe.fuente === "sku" ? "var(--green)" : "var(--txt3)" }}
                        title={`Efectivo: ${pe.val} (${pe.fuente})`}>
                        <option value="">—</option>
                        {POLITICAS.map(p => <option key={p} value={p}>{p}</option>)}
                      </select>
                    </td>
                    <td style={{ textAlign: "center" }}>
                      <input type="checkbox" defaultChecked={s.es_kvi === true}
                        onChange={e => void saveSku(s.sku, { es_kvi: e.target.checked })} />
                    </td>
                    <td style={{ textAlign: "center" }}>
                      <input type="checkbox" defaultChecked={s.auto_postular === true}
                        onChange={e => void saveSku(s.sku, { auto_postular: e.target.checked })} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: "var(--bg3)",
  border: "1px solid var(--bg4)",
  color: "var(--txt)",
  padding: "4px 6px",
  borderRadius: 4,
  fontSize: 11,
  width: 70,
};

function cuadColor(c: string | null): string {
  if (c === "ESTRELLA") return "var(--cyan)";
  if (c === "VOLUMEN") return "var(--blue)";
  if (c === "CASHCOW") return "var(--green)";
  if (c === "REVISAR") return "var(--amber)";
  return "var(--txt3)";
}
