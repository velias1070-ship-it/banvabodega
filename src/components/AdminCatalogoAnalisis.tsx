"use client";
import { useEffect, useState, useMemo, useCallback } from "react";
import { getSupabase } from "@/lib/supabase";

// Vista simple para auditar el catálogo de un proveedor: ver qué SKUs ofrece
// el proveedor que NO están en `productos`, agrupados por familia (prefijo
// SKU). Distingue:
//   - Variantes de líneas que ya vendés (match) — alta señal, completar línea
//   - Líneas completamente nuevas (sin match) — exploratorio, decisión negocio
//
// MVP: solo lectura + insights. La acción "+ Crear producto" o "Agregar a OC"
// se monta arriba después, una vez que el shape de datos esté validado.

interface Proveedor { id: string; nombre_canonico: string; nombre: string | null; rut: string | null }
interface SkuNuevo { sku: string; nombre: string | null; precio_neto: number; stock_disponible: number; inner_pack: number }
interface Familia {
  familia: string;
  skus_nuevos: SkuNuevo[];
  skus_que_ya_tenemos: number;
  uds_180d_familia: number;
  top_3_vendidos: string[];
  match: boolean;
}
interface AnalisisResponse {
  ok: boolean;
  total_familias: number;
  total_skus_nuevos: number;
  skus_en_catalogo: number;
  skus_ya_creados: number;
  familias: Familia[];
  tiempo_ms: number;
}

const fmtInt = (n: number) => n.toLocaleString("es-CL");
const fmtMoney = (n: number) => "$" + Math.round(n).toLocaleString("es-CL");

export default function AdminCatalogoAnalisis() {
  const [proveedores, setProveedores] = useState<Proveedor[]>([]);
  const [proveedorId, setProveedorId] = useState<string>("");
  const [data, setData] = useState<AnalisisResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [filtro, setFiltro] = useState<"con_match"|"sin_match"|"con_stock"|"todos">("con_match");
  const [familiaExpandida, setFamiliaExpandida] = useState<string | null>(null);
  const [prefixLen, setPrefixLen] = useState(9);

  // Cargar proveedores activos
  useEffect(() => {
    const sb = getSupabase(); if (!sb) return;
    void sb.from("proveedores").select("id, nombre_canonico, nombre, rut").order("nombre_canonico").then(({ data }) => {
      setProveedores((data || []) as Proveedor[]);
      // Seleccionar Idetex por default si existe
      const idetex = (data || []).find((p: Proveedor) => p.nombre_canonico?.toLowerCase().includes("idetex"));
      if (idetex) setProveedorId(idetex.id);
    });
  }, []);

  const cargar = useCallback(async () => {
    if (!proveedorId) return;
    setLoading(true);
    setData(null);
    try {
      const res = await fetch(`/api/proveedor-catalogo/analisis?proveedor_id=${proveedorId}&prefix_len=${prefixLen}`);
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        alert(`Error: ${j.error || res.status}`);
        return;
      }
      const json = await res.json() as AnalisisResponse;
      setData(json);
    } finally { setLoading(false); }
  }, [proveedorId, prefixLen]);

  useEffect(() => { void cargar(); }, [cargar]);

  const familiasFiltradas = useMemo(() => {
    if (!data) return [];
    return data.familias.filter(f => {
      if (filtro === "con_match") return f.match;
      if (filtro === "sin_match") return !f.match;
      if (filtro === "con_stock") return f.skus_nuevos.some(s => s.stock_disponible > 0);
      return true;
    });
  }, [data, filtro]);

  const totalSkusFiltrados = useMemo(() =>
    familiasFiltradas.reduce((s, f) => s + f.skus_nuevos.length, 0), [familiasFiltradas]);

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>📦 Análisis Catálogo Proveedor</h2>
        <div style={{ fontSize: 11, color: "var(--txt3)", marginTop: 4 }}>
          Detecta SKUs del catálogo del proveedor que aún no creaste en productos. Agrupa por familia (prefijo SKU) y marca cuáles son variantes de líneas que ya vendés.
        </div>
      </div>

      {/* Selector */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, color: "var(--txt2)" }}>Proveedor:</span>
        <select value={proveedorId} onChange={e => setProveedorId(e.target.value)}
          style={{ background: "var(--bg3)", border: "1px solid var(--bg4)", color: "var(--txt)", padding: "6px 10px", borderRadius: 4, fontSize: 12 }}>
          <option value="">— Seleccionar —</option>
          {proveedores.map(p => (
            <option key={p.id} value={p.id}>{p.nombre_canonico}</option>
          ))}
          <option value="null">(sin proveedor_id asignado)</option>
        </select>
        <span style={{ fontSize: 11, color: "var(--txt2)", marginLeft: 12 }}>Prefijo (chars):</span>
        <input type="number" min={4} max={15} value={prefixLen} onChange={e => setPrefixLen(Number(e.target.value) || 9)}
          style={{ width: 50, background: "var(--bg3)", border: "1px solid var(--bg4)", color: "var(--txt)", padding: "6px 10px", borderRadius: 4, fontSize: 12 }} />
        <button onClick={() => void cargar()} disabled={loading || !proveedorId}
          style={{ padding: "6px 14px", fontSize: 11, background: "var(--cyan)", border: "none", color: "#000", fontWeight: 700, borderRadius: 4, cursor: "pointer", opacity: loading ? 0.5 : 1 }}>
          {loading ? "Cargando..." : "🔄 Recargar"}
        </button>
      </div>

      {/* KPIs */}
      {data && (
        <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap", fontSize: 11 }}>
          <span style={{ padding: "4px 10px", borderRadius: 4, background: "var(--bg3)", border: "1px solid var(--bg4)" }}>
            Catálogo: <b style={{ color: "var(--cyan)" }}>{fmtInt(data.skus_en_catalogo)}</b> SKUs
          </span>
          <span style={{ padding: "4px 10px", borderRadius: 4, background: "var(--bg3)", border: "1px solid var(--bg4)" }}>
            Ya creados: <b style={{ color: "var(--green)" }}>{fmtInt(data.skus_ya_creados)}</b>
          </span>
          <span style={{ padding: "4px 10px", borderRadius: 4, background: "var(--bg3)", border: "1px solid var(--bg4)" }}>
            Nuevos potenciales: <b style={{ color: "var(--amber)" }}>{fmtInt(data.total_skus_nuevos)}</b>
          </span>
          <span style={{ padding: "4px 10px", borderRadius: 4, background: "var(--bg3)", border: "1px solid var(--bg4)" }}>
            Familias detectadas: <b>{fmtInt(data.total_familias)}</b>
          </span>
          <span style={{ padding: "4px 10px", borderRadius: 4, background: "var(--bg3)", border: "1px solid var(--bg4)", color: "var(--txt3)" }}>
            {data.tiempo_ms}ms
          </span>
        </div>
      )}

      {/* Filtros */}
      {data && (
        <div style={{ display: "flex", gap: 4, marginBottom: 8, flexWrap: "wrap" }}>
          {([
            ["con_match", `✅ Variantes (familia conocida)`, data.familias.filter(f => f.match).length],
            ["sin_match", `🆕 Líneas nuevas`, data.familias.filter(f => !f.match).length],
            ["con_stock", `📦 Con stock proveedor`, data.familias.filter(f => f.skus_nuevos.some(s => s.stock_disponible > 0)).length],
            ["todos", `Todos`, data.familias.length],
          ] as const).map(([key, label, count]) => (
            <button key={key} onClick={() => setFiltro(key)}
              style={{ padding: "4px 10px", borderRadius: 4, fontSize: 10, fontWeight: 600,
                border: `1px solid ${filtro === key ? "var(--cyan)" : "var(--bg4)"}`,
                background: filtro === key ? "var(--cyan)" : "var(--bg3)",
                color: filtro === key ? "#000" : "var(--txt3)", cursor: "pointer" }}>
              {label} ({count})
            </button>
          ))}
        </div>
      )}

      {data && (
        <div style={{ fontSize: 10, color: "var(--txt3)", marginBottom: 6 }}>
          {familiasFiltradas.length} familias · {totalSkusFiltrados} SKUs nuevos
        </div>
      )}

      {/* Tabla familias */}
      {data && familiasFiltradas.length === 0 && (
        <div style={{ textAlign: "center", padding: 40, color: "var(--txt3)" }}>
          Sin familias en este filtro.
        </div>
      )}

      {data && familiasFiltradas.length > 0 && (
        <div style={{ border: "1px solid var(--bg4)", borderRadius: 8, overflowX: "auto" }}>
          <table className="tbl" style={{ width: "100%", minWidth: 900 }}>
            <thead>
              <tr>
                <th style={{ width: 110 }}>Familia</th>
                <th style={{ width: 70, textAlign: "center" }}>Match</th>
                <th style={{ textAlign: "right", width: 90 }}>SKUs nuevos</th>
                <th style={{ textAlign: "right", width: 110 }}>Ya tenés</th>
                <th style={{ textAlign: "right", width: 110 }}>Uds 180d</th>
                <th>Top 3 vendidos (familia)</th>
                <th>SKUs nuevos en catálogo</th>
              </tr>
            </thead>
            <tbody>
              {familiasFiltradas.map(f => {
                const expandida = familiaExpandida === f.familia;
                return (
                  <>
                    <tr key={f.familia}
                      style={{ background: expandida ? "var(--bg3)" : "transparent", cursor: "pointer" }}
                      onClick={() => setFamiliaExpandida(expandida ? null : f.familia)}>
                      <td className="mono" style={{ fontWeight: 700, fontSize: 11 }}>
                        {expandida ? "▼" : "▶"} {f.familia}
                      </td>
                      <td style={{ textAlign: "center" }}>
                        {f.match
                          ? <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 3, background: "var(--greenBg)", color: "var(--green)", fontWeight: 700 }}>✅ Conocida</span>
                          : <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 3, background: "var(--amberBg)", color: "var(--amber)", fontWeight: 700 }}>🆕 Nueva</span>
                        }
                      </td>
                      <td className="mono" style={{ textAlign: "right", fontSize: 12, fontWeight: 700, color: "var(--amber)" }}>{fmtInt(f.skus_nuevos.length)}</td>
                      <td className="mono" style={{ textAlign: "right", fontSize: 11 }}>{fmtInt(f.skus_que_ya_tenemos)}</td>
                      <td className="mono" style={{ textAlign: "right", fontSize: 11, color: f.uds_180d_familia > 100 ? "var(--cyan)" : f.uds_180d_familia > 0 ? "var(--txt2)" : "var(--txt3)", fontWeight: f.uds_180d_familia > 100 ? 700 : 400 }}>
                        {f.uds_180d_familia > 0 ? fmtInt(f.uds_180d_familia) : "—"}
                      </td>
                      <td className="mono" style={{ fontSize: 10, color: "var(--txt2)" }}>
                        {f.top_3_vendidos.length > 0 ? f.top_3_vendidos.join(", ") : "—"}
                      </td>
                      <td style={{ fontSize: 10, color: "var(--txt2)" }}>
                        {f.skus_nuevos.slice(0, 4).map(s => s.sku).join(", ")}
                        {f.skus_nuevos.length > 4 ? ` … +${f.skus_nuevos.length - 4}` : ""}
                      </td>
                    </tr>
                    {expandida && (
                      <tr key={f.familia + "_exp"}>
                        <td colSpan={7} style={{ background: "var(--bg2)", padding: 12 }}>
                          <table className="tbl" style={{ width: "100%" }}>
                            <thead>
                              <tr>
                                <th>SKU nuevo</th>
                                <th>Nombre catálogo</th>
                                <th style={{ textAlign: "right" }}>Precio neto</th>
                                <th style={{ textAlign: "right" }}>Stock prov.</th>
                                <th style={{ textAlign: "right" }}>IP</th>
                              </tr>
                            </thead>
                            <tbody>
                              {f.skus_nuevos.map(s => (
                                <tr key={s.sku}>
                                  <td className="mono" style={{ fontSize: 11, fontWeight: 600 }}>{s.sku}</td>
                                  <td style={{ fontSize: 11, color: "var(--txt2)" }}>{s.nombre || <span style={{ color: "var(--txt3)" }}>—</span>}</td>
                                  <td className="mono" style={{ textAlign: "right", fontSize: 11 }}>{s.precio_neto > 0 ? fmtMoney(s.precio_neto) : "—"}</td>
                                  <td className="mono" style={{ textAlign: "right", fontSize: 11, color: s.stock_disponible > 0 ? "var(--green)" : "var(--txt3)" }}>{fmtInt(s.stock_disponible)}</td>
                                  <td className="mono" style={{ textAlign: "right", fontSize: 11 }}>{s.inner_pack}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
