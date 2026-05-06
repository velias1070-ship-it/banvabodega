"use client";
/**
 * Panel "Ver Catálogo" — tabla completa de proveedor_catalogo con edición
 * inline del precio acordado y drill-down a historia de precios facturados.
 *
 * Owner pidió visibilidad completa del catálogo de precios acordados:
 *  - filtros por proveedor + búsqueda SKU
 *  - edición inline de precio_neto (ajusta el precio acordado)
 *  - flag "zombi" si fue poblado por cleanup pre-Chunk3 (sospechoso)
 *  - historia: precios facturados de recepcion_lineas vs precio acordado
 */
import { useEffect, useState, useMemo, useCallback } from "react";
import { getSupabase } from "@/lib/supabase";

type CatRow = {
  id: string;
  proveedor: string;
  sku_origen: string;
  nombre: string | null;
  inner_pack: number | null;
  precio_neto: number;
  stock_disponible: number | null;
  updated_at: string | null;
  updated_by: string | null;
  motivo_ultimo_cambio: string | null;
  es_principal: boolean;
};

type RecLineHist = {
  recepcion_id: string;
  costo_unitario: number;
  qty_factura: number;
  qty_recibida: number;
  folio: string;
  proveedor_rec: string;
  fecha: string;
};

const fmtMoney = (n: number) =>
  n === 0 ? "$0" : (n >= 0 ? "" : "−") + "$" + Math.abs(Math.round(n)).toLocaleString("es-CL");
const fmtDate = (d: string | null | undefined) => {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("es-CL", { day: "2-digit", month: "2-digit", year: "2-digit" });
};

const ZOMBI_MARKER = "cleanup_pre_chunk3_2026_05_05";

export default function CatalogoVerPanel() {
  const [rows, setRows] = useState<CatRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filtroProveedor, setFiltroProveedor] = useState<string>("todos");
  const [search, setSearch] = useState("");
  const [soloPrincipal, setSoloPrincipal] = useState(true);
  const [soloZombi, setSoloZombi] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editPrecio, setEditPrecio] = useState<string>("");
  const [historiaSku, setHistoriaSku] = useState<{ sku: string; proveedor: string } | null>(null);

  const cargar = useCallback(async () => {
    setLoading(true);
    const sb = getSupabase();
    if (!sb) { setLoading(false); return; }
    // Paginar (Supabase tiene cap de 1000 por query)
    const all: CatRow[] = [];
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await sb.from("proveedor_catalogo")
        .select("id, proveedor, sku_origen, nombre, inner_pack, precio_neto, stock_disponible, updated_at, updated_by, motivo_ultimo_cambio, es_principal")
        .order("proveedor")
        .order("sku_origen")
        .range(from, from + PAGE - 1);
      if (error) {
        console.error("[CatalogoVerPanel] fetch:", error.message);
        break;
      }
      const chunk = (data || []) as CatRow[];
      all.push(...chunk);
      if (chunk.length < PAGE) break;
    }
    setRows(all);
    setLoading(false);
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  const proveedoresUnicos = useMemo(() =>
    Array.from(new Set(rows.map(r => r.proveedor))).sort(),
    [rows],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase();
    return rows.filter(r => {
      if (soloPrincipal && !r.es_principal) return false;
      if (filtroProveedor !== "todos" && r.proveedor !== filtroProveedor) return false;
      if (soloZombi && r.updated_by !== ZOMBI_MARKER) return false;
      if (q) {
        const hit = r.sku_origen.toUpperCase().includes(q)
          || (r.nombre || "").toUpperCase().includes(q);
        if (!hit) return false;
      }
      return true;
    });
  }, [rows, search, filtroProveedor, soloPrincipal, soloZombi]);

  const stats = useMemo(() => ({
    total: rows.length,
    principal: rows.filter(r => r.es_principal).length,
    zombi: rows.filter(r => r.es_principal && r.updated_by === ZOMBI_MARKER).length,
    sin_precio: rows.filter(r => r.es_principal && (!r.precio_neto || r.precio_neto <= 0)).length,
  }), [rows]);

  const guardarPrecio = async (row: CatRow) => {
    const nuevo = parseFloat(editPrecio);
    if (!Number.isFinite(nuevo) || nuevo < 0) {
      alert("Precio inválido");
      return;
    }
    const sb = getSupabase();
    if (!sb) return;
    const { error } = await sb.from("proveedor_catalogo").update({
      precio_neto: nuevo,
      updated_at: new Date().toISOString(),
      updated_by: "admin_ui",
      motivo_ultimo_cambio: `edicion manual UI 2026-05-06: precio anterior ${row.precio_neto}`,
    }).eq("id", row.id);
    if (error) {
      alert("Error al guardar: " + error.message);
      return;
    }
    setEditId(null);
    setEditPrecio("");
    await cargar();
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>📚 Catálogo de precios acordados</h2>
          <div style={{ fontSize: 11, color: "var(--txt3)", marginTop: 4 }}>
            Precios pactados con cada proveedor. Sirve de baseline para detectar discrepancias en facturas entrantes.
          </div>
        </div>
        <button onClick={cargar} disabled={loading}
          style={{ padding: "6px 12px", borderRadius: 6, background: "var(--bg3)", color: "var(--txt2)", border: "1px solid var(--bg4)", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
          {loading ? "Cargando..." : "⟳ Recargar"}
        </button>
      </div>

      {/* KPIs */}
      <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 8, marginBottom: 12 }}>
        <div className="kpi">
          <div style={{ fontSize: 10, color: "var(--txt3)", textTransform: "uppercase" }}>Total entradas</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{stats.total}</div>
        </div>
        <div className="kpi" style={{ borderLeft: "3px solid var(--cyan)" }}>
          <div style={{ fontSize: 10, color: "var(--txt3)", textTransform: "uppercase" }}>Principal (1 por SKU)</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: "var(--cyan)" }}>{stats.principal}</div>
        </div>
        <div className="kpi" style={{ borderLeft: "3px solid var(--amber)" }}>
          <div style={{ fontSize: 10, color: "var(--txt3)", textTransform: "uppercase" }}>Zombi (cleanup)</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: "var(--amber)" }}>{stats.zombi}</div>
        </div>
        <div className="kpi" style={{ borderLeft: "3px solid var(--red)" }}>
          <div style={{ fontSize: 10, color: "var(--txt3)", textTransform: "uppercase" }}>Sin precio (≤$0)</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: "var(--red)" }}>{stats.sin_precio}</div>
        </div>
      </div>

      {/* Filtros */}
      <div className="card" style={{ padding: 12, marginBottom: 12 }}>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 10, color: "var(--txt3)", marginBottom: 3, textTransform: "uppercase" }}>Proveedor</div>
            <select value={filtroProveedor} onChange={e => setFiltroProveedor(e.target.value)}
              style={{ padding: "6px 10px", borderRadius: 6, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", fontSize: 12, minWidth: 180 }}>
              <option value="todos">Todos</option>
              {proveedoresUnicos.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontSize: 10, color: "var(--txt3)", marginBottom: 3, textTransform: "uppercase" }}>Buscar SKU/nombre</div>
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="JSCNAE187 o jgo sabanas..."
              style={{ width: "100%", padding: "6px 10px", borderRadius: 6, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", fontSize: 12 }} />
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--txt2)", cursor: "pointer", paddingTop: 14 }}>
            <input type="checkbox" checked={soloPrincipal} onChange={e => setSoloPrincipal(e.target.checked)} />
            Solo principales
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--amber)", cursor: "pointer", paddingTop: 14 }}>
            <input type="checkbox" checked={soloZombi} onChange={e => setSoloZombi(e.target.checked)} />
            Solo zombi (cleanup)
          </label>
          <div style={{ alignSelf: "flex-end", fontSize: 11, color: "var(--txt3)" }}>
            {filtered.length} de {rows.length}
          </div>
        </div>
      </div>

      {/* Tabla */}
      {loading ? (
        <div className="card" style={{ padding: 24, textAlign: "center", color: "var(--txt3)" }}>Cargando…</div>
      ) : filtered.length === 0 ? (
        <div className="card" style={{ padding: 24, textAlign: "center", color: "var(--txt3)" }}>
          Sin entradas con los filtros actuales.
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: "auto" }}>
          <table className="tbl" style={{ width: "100%", fontSize: 11 }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: "8px 10px" }}>Proveedor</th>
                <th style={{ textAlign: "left", padding: "8px 10px" }}>SKU origen</th>
                <th style={{ textAlign: "left", padding: "8px 10px" }}>Nombre</th>
                <th style={{ textAlign: "right", padding: "8px 10px" }}>Inner pack</th>
                <th style={{ textAlign: "right", padding: "8px 10px" }}>Precio neto (acordado)</th>
                <th style={{ textAlign: "left", padding: "8px 10px" }}>Última act.</th>
                <th style={{ textAlign: "left", padding: "8px 10px" }}>Origen</th>
                <th style={{ textAlign: "center", padding: "8px 10px" }}>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 500).map(r => {
                const isZombi = r.updated_by === ZOMBI_MARKER;
                const isEdit = editId === r.id;
                const isPrincipal = r.es_principal;
                return (
                  <tr key={r.id} style={{
                    borderTop: "1px solid var(--bg4)",
                    background: isZombi ? "rgba(245,158,11,0.04)" : "transparent",
                  }}>
                    <td style={{ padding: "6px 10px" }}>
                      {r.proveedor}
                      {!isPrincipal && <span style={{ marginLeft: 4, fontSize: 9, padding: "1px 5px", borderRadius: 3, background: "var(--bg3)", color: "var(--txt3)" }}>alt</span>}
                    </td>
                    <td className="mono" style={{ padding: "6px 10px", fontWeight: 700 }}>{r.sku_origen}</td>
                    <td style={{ padding: "6px 10px", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {r.nombre || <span style={{ color: "var(--txt3)" }}>—</span>}
                    </td>
                    <td className="mono" style={{ padding: "6px 10px", textAlign: "right" }}>
                      {r.inner_pack ?? "—"}
                    </td>
                    <td className="mono" style={{ padding: "6px 10px", textAlign: "right", fontWeight: 700 }}>
                      {isEdit ? (
                        <input type="number" value={editPrecio} onChange={e => setEditPrecio(e.target.value)}
                          autoFocus
                          onKeyDown={e => { if (e.key === "Enter") guardarPrecio(r); if (e.key === "Escape") setEditId(null); }}
                          style={{ width: 100, padding: "2px 6px", borderRadius: 4, background: "var(--bg)", color: "var(--txt)", border: "1px solid var(--cyan)", fontSize: 11, fontFamily: "JetBrains Mono, monospace", textAlign: "right" }} />
                      ) : (
                        <span style={{ color: r.precio_neto > 0 ? "var(--cyan)" : "var(--red)" }}>
                          {fmtMoney(r.precio_neto)}
                        </span>
                      )}
                    </td>
                    <td style={{ padding: "6px 10px", fontSize: 10, color: "var(--txt3)" }}>
                      {fmtDate(r.updated_at)}
                    </td>
                    <td style={{ padding: "6px 10px", fontSize: 10 }}>
                      {isZombi ? (
                        <span title="Heredado del cleanup pre-Chunk3 — puede estar contaminado con sobrecargo de factura previa"
                          style={{ color: "var(--amber)", fontWeight: 700 }}>
                          ⚠ zombi
                        </span>
                      ) : r.updated_by === "admin" || r.updated_by === "admin_ui" ? (
                        <span style={{ color: "var(--green)" }}>✓ manual</span>
                      ) : r.updated_by?.startsWith("aprobacion_disc") ? (
                        <span style={{ color: "var(--cyan)" }}>auto disc</span>
                      ) : (
                        <span style={{ color: "var(--txt3)" }}>{r.updated_by || "—"}</span>
                      )}
                    </td>
                    <td style={{ padding: "6px 10px", textAlign: "center", whiteSpace: "nowrap" }}>
                      {isEdit ? (
                        <>
                          <button onClick={() => guardarPrecio(r)}
                            style={{ padding: "3px 8px", borderRadius: 4, background: "var(--green)", color: "#0a0e17", fontSize: 10, fontWeight: 700, border: "none", marginRight: 3, cursor: "pointer" }}>
                            ✓ Guardar
                          </button>
                          <button onClick={() => setEditId(null)}
                            style={{ padding: "3px 8px", borderRadius: 4, background: "var(--bg3)", color: "var(--txt2)", fontSize: 10, fontWeight: 700, border: "1px solid var(--bg4)", cursor: "pointer" }}>
                            Cancelar
                          </button>
                        </>
                      ) : (
                        <>
                          <button onClick={() => { setEditId(r.id); setEditPrecio(String(r.precio_neto)); }}
                            style={{ padding: "3px 8px", borderRadius: 4, background: "var(--bg3)", color: "var(--cyan)", fontSize: 10, fontWeight: 700, border: "1px solid var(--bg4)", marginRight: 3, cursor: "pointer" }}>
                            ✎ Editar
                          </button>
                          <button onClick={() => setHistoriaSku({ sku: r.sku_origen, proveedor: r.proveedor })}
                            style={{ padding: "3px 8px", borderRadius: 4, background: "var(--bg3)", color: "var(--txt2)", fontSize: 10, fontWeight: 700, border: "1px solid var(--bg4)", cursor: "pointer" }}>
                            📜 Historia
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {filtered.length > 500 && (
            <div style={{ padding: 10, textAlign: "center", fontSize: 10, color: "var(--txt3)" }}>
              Mostrando primeros 500. Refiná filtro para ver el resto.
            </div>
          )}
        </div>
      )}

      {historiaSku && <HistoriaPreciosModal sku={historiaSku.sku} proveedor={historiaSku.proveedor} onClose={() => setHistoriaSku(null)} />}
    </div>
  );
}

// ============================================================================
// Modal de historia de precios
// ============================================================================

function HistoriaPreciosModal({ sku, proveedor, onClose }: { sku: string; proveedor: string; onClose: () => void }) {
  const [historia, setHistoria] = useState<RecLineHist[]>([]);
  const [catalogoActual, setCatalogoActual] = useState<CatRow | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const sb = getSupabase();
      if (!sb) { setLoading(false); return; }
      // Catálogo actual
      const { data: catData } = await sb.from("proveedor_catalogo")
        .select("*").eq("sku_origen", sku).eq("es_principal", true).maybeSingle();
      setCatalogoActual(catData as CatRow | null);

      // Historia de precios facturados (recepcion_lineas)
      const { data: linData } = await sb.from("recepcion_lineas")
        .select("recepcion_id, costo_unitario, qty_factura, qty_recibida, recepciones(folio, proveedor, created_at, estado)")
        .eq("sku", sku)
        .order("recepcion_id");
      type LinRow = {
        recepcion_id: string;
        costo_unitario: number | null;
        qty_factura: number;
        qty_recibida: number;
        recepciones: { folio: string; proveedor: string; created_at: string; estado: string }
                   | { folio: string; proveedor: string; created_at: string; estado: string }[]
                   | null;
      };
      const hist: RecLineHist[] = [];
      for (const l of (linData || []) as unknown as LinRow[]) {
        const recRaw = l.recepciones;
        const rec = Array.isArray(recRaw) ? recRaw[0] : recRaw;
        if (!rec || rec.estado === "ANULADA") continue;
        if ((l.costo_unitario ?? 0) <= 0) continue;
        hist.push({
          recepcion_id: l.recepcion_id,
          costo_unitario: l.costo_unitario as number,
          qty_factura: l.qty_factura || 0,
          qty_recibida: l.qty_recibida || 0,
          folio: rec.folio,
          proveedor_rec: rec.proveedor,
          fecha: rec.created_at,
        });
      }
      hist.sort((a, b) => b.fecha.localeCompare(a.fecha));
      setHistoria(hist);
      setLoading(false);
    })();
  }, [sku]);

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 9999,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: "var(--bg2)", borderRadius: 12, border: "1px solid var(--bg4)",
        padding: 20, maxWidth: 720, width: "100%", maxHeight: "90vh", overflow: "auto",
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>
            📜 Historia de precios — <span className="mono">{sku}</span>
          </h3>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--txt3)", fontSize: 18, cursor: "pointer" }}>×</button>
        </div>
        <div style={{ fontSize: 11, color: "var(--txt3)", marginBottom: 12 }}>
          Proveedor (catálogo): {proveedor}
        </div>

        {/* Precio acordado actual */}
        {catalogoActual && (
          <div className="card" style={{ padding: 10, marginBottom: 12, borderLeft: "3px solid var(--cyan)" }}>
            <div style={{ fontSize: 10, color: "var(--txt3)", textTransform: "uppercase", marginBottom: 4 }}>
              Precio acordado actual
            </div>
            <div className="mono" style={{ fontSize: 16, fontWeight: 700, color: "var(--cyan)" }}>
              {fmtMoney(catalogoActual.precio_neto)}
            </div>
            <div style={{ fontSize: 10, color: "var(--txt3)", marginTop: 4 }}>
              Última actualización: {fmtDate(catalogoActual.updated_at)} por {catalogoActual.updated_by || "—"}
              {catalogoActual.motivo_ultimo_cambio && (
                <div style={{ marginTop: 2, fontStyle: "italic" }}>{catalogoActual.motivo_ultimo_cambio}</div>
              )}
            </div>
          </div>
        )}

        {/* Historia facturada */}
        <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>
          Precios facturados (recepciones, {historia.length} entradas)
        </div>
        {loading ? (
          <div style={{ padding: 12, textAlign: "center", fontSize: 11, color: "var(--txt3)" }}>Cargando…</div>
        ) : historia.length === 0 ? (
          <div style={{ padding: 12, textAlign: "center", fontSize: 11, color: "var(--txt3)" }}>Sin recepciones previas con costo registrado.</div>
        ) : (
          <table className="tbl" style={{ width: "100%", fontSize: 10 }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: "6px 8px" }}>Fecha</th>
                <th style={{ textAlign: "left", padding: "6px 8px" }}>Folio</th>
                <th style={{ textAlign: "left", padding: "6px 8px" }}>Proveedor</th>
                <th style={{ textAlign: "right", padding: "6px 8px" }}>Qty fact.</th>
                <th style={{ textAlign: "right", padding: "6px 8px" }}>Qty rec.</th>
                <th style={{ textAlign: "right", padding: "6px 8px" }}>Precio facturado</th>
                <th style={{ textAlign: "right", padding: "6px 8px" }}>Δ vs acordado</th>
              </tr>
            </thead>
            <tbody>
              {historia.map((h, i) => {
                const acordado = catalogoActual?.precio_neto || 0;
                const delta = acordado > 0 ? h.costo_unitario - acordado : 0;
                const deltaPct = acordado > 0 ? (delta / acordado) * 100 : 0;
                return (
                  <tr key={i} style={{ borderTop: "1px solid var(--bg4)" }}>
                    <td style={{ padding: "5px 8px" }}>{fmtDate(h.fecha)}</td>
                    <td className="mono" style={{ padding: "5px 8px" }}>{h.folio}</td>
                    <td style={{ padding: "5px 8px" }}>{h.proveedor_rec}</td>
                    <td className="mono" style={{ padding: "5px 8px", textAlign: "right" }}>{h.qty_factura}</td>
                    <td className="mono" style={{ padding: "5px 8px", textAlign: "right", color: h.qty_recibida !== h.qty_factura ? "var(--amber)" : "var(--txt2)" }}>
                      {h.qty_recibida}
                    </td>
                    <td className="mono" style={{ padding: "5px 8px", textAlign: "right", fontWeight: 700 }}>{fmtMoney(h.costo_unitario)}</td>
                    <td className="mono" style={{ padding: "5px 8px", textAlign: "right", color: Math.abs(delta) < 1 ? "var(--green)" : delta > 0 ? "var(--red)" : "var(--cyan)", fontWeight: 700 }}>
                      {acordado > 0
                        ? `${delta > 0 ? "+" : ""}${fmtMoney(delta)} (${deltaPct > 0 ? "+" : ""}${deltaPct.toFixed(1)}%)`
                        : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
