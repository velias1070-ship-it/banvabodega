"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getSupabase } from "@/lib/supabase";

const ML_DIVISOR_VOLUMETRICO = 4000;

type DimRow = {
  sku: string;
  nombre: string | null;
  // BANVA (verdad)
  largo_cm: number | null;
  ancho_cm: number | null;
  alto_cm: number | null;
  peso_real_gr: number | null;
  dimensiones_origen: string | null;
  dimensiones_updated_at: string | null;
  // ML (espejo)
  ml_largo_cm: number | null;
  ml_ancho_cm: number | null;
  ml_alto_cm: number | null;
  ml_peso_gr: number | null;
  ml_dim_synced_at: string | null;
};

type Filtro = "todos" | "sin_banva" | "sin_ml" | "con_discrepancia" | "completos";

function pesoVolGr(largo: number | null, ancho: number | null, alto: number | null): number | null {
  if (!largo || !ancho || !alto) return null;
  return Math.round((largo * ancho * alto) / ML_DIVISOR_VOLUMETRICO * 1000);
}

function tieneDiscrepancia(r: DimRow): boolean {
  if (r.largo_cm === null || r.ml_largo_cm === null) return false;
  if (r.ancho_cm === null || r.ml_ancho_cm === null) return false;
  if (r.alto_cm === null || r.ml_alto_cm === null) return false;
  if (Math.abs(r.largo_cm - r.ml_largo_cm) > 5) return true;
  if (Math.abs(r.ancho_cm - r.ml_ancho_cm) > 5) return true;
  if (Math.abs(r.alto_cm - r.ml_alto_cm) > 5) return true;
  if (r.peso_real_gr && r.ml_peso_gr) {
    const dpct = Math.abs(r.peso_real_gr - r.ml_peso_gr) / r.peso_real_gr;
    if (dpct > 0.10) return true;
  }
  return false;
}

export default function AdminDimensiones() {
  const [rows, setRows] = useState<DimRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [filtro, setFiltro] = useState<Filtro>("todos");
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [editing, setEditing] = useState<DimRow | null>(null);
  const [importing, setImporting] = useState(false);
  const [importPreview, setImportPreview] = useState<{ a_escribir: number; procesados: number; omitidos: { sku: string; razon: string }[]; preview: { sku: string; largo_cm: number | null; ancho_cm: number | null; alto_cm: number | null; peso_real_gr: number | null }[]; available_sheets?: string[]; sheet_used?: string } | null>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importSheet, setImportSheet] = useState<string | null>(null);

  const fetchRows = useCallback(async () => {
    const sb = getSupabase();
    if (!sb) return;
    setLoading(true);
    const { data, error } = await sb
      .from("productos")
      .select("sku, nombre, largo_cm, ancho_cm, alto_cm, peso_real_gr, dimensiones_origen, dimensiones_updated_at, ml_largo_cm, ml_ancho_cm, ml_alto_cm, ml_peso_gr, ml_dim_synced_at")
      .order("sku");
    if (error) {
      console.error("[dimensiones] fetch failed:", error.message);
      setRows([]);
    } else {
      setRows((data || []) as DimRow[]);
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchRows(); }, [fetchRows]);

  // ---- Stats ----
  const stats = useMemo(() => {
    const total = rows.length;
    const conBanva = rows.filter(r => r.largo_cm !== null && r.ancho_cm !== null && r.alto_cm !== null && r.peso_real_gr !== null).length;
    const conMl = rows.filter(r => r.ml_largo_cm !== null && r.ml_ancho_cm !== null && r.ml_alto_cm !== null).length;
    const discrepancias = rows.filter(tieneDiscrepancia).length;
    return { total, conBanva, conMl, discrepancias };
  }, [rows]);

  // ---- Filtrado ----
  const visibles = useMemo(() => {
    let res = rows;
    if (q.trim()) {
      const qq = q.trim().toLowerCase();
      res = res.filter(r => r.sku.toLowerCase().includes(qq) || (r.nombre || "").toLowerCase().includes(qq));
    }
    switch (filtro) {
      case "sin_banva":
        res = res.filter(r => r.largo_cm === null || r.ancho_cm === null || r.alto_cm === null || r.peso_real_gr === null);
        break;
      case "sin_ml":
        res = res.filter(r => r.ml_largo_cm === null || r.ml_ancho_cm === null || r.ml_alto_cm === null);
        break;
      case "con_discrepancia":
        res = res.filter(tieneDiscrepancia);
        break;
      case "completos":
        res = res.filter(r =>
          r.largo_cm !== null && r.ancho_cm !== null && r.alto_cm !== null && r.peso_real_gr !== null
          && r.ml_largo_cm !== null && r.ml_ancho_cm !== null && r.ml_alto_cm !== null && r.ml_peso_gr !== null
        );
        break;
    }
    return res;
  }, [rows, q, filtro]);

  // ---- Acciones ----
  const dryRunImport = useCallback(async (file: File, sheet?: string) => {
    setImporting(true);
    setImportPreview(null);
    setImportFile(file);
    setImportSheet(sheet || null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const params = new URLSearchParams({ dry_run: "true" });
      if (sheet) params.set("sheet", sheet);
      const r = await fetch(`/api/dimensiones/import-excel?${params}`, { method: "POST", body: fd });
      const j = await r.json();
      if (!r.ok) {
        setSyncResult(`Error preview: ${j.error || r.statusText}${j.header_detectado ? ` · header: ${JSON.stringify(j.header_detectado)}` : ""}${j.available_sheets ? ` · hojas: ${j.available_sheets.join(", ")}` : ""}`);
        setImportFile(null);
      } else {
        setImportPreview(j);
        if (j.sheet_used) setImportSheet(j.sheet_used);
      }
    } catch (e) {
      setSyncResult(`Error: ${e instanceof Error ? e.message : String(e)}`);
      setImportFile(null);
    } finally {
      setImporting(false);
    }
  }, []);

  const aplicarImport = useCallback(async () => {
    if (!importFile || importing) return;
    setImporting(true);
    try {
      const fd = new FormData();
      fd.append("file", importFile);
      const params = new URLSearchParams();
      if (importSheet) params.set("sheet", importSheet);
      const r = await fetch(`/api/dimensiones/import-excel${params.toString() ? `?${params}` : ""}`, { method: "POST", body: fd });
      const j = await r.json();
      if (!r.ok) {
        setSyncResult(`Error: ${j.error || r.statusText}`);
      } else {
        setSyncResult(`Excel (hoja "${j.sheet_used || "?"}"): procesados ${j.procesados} · escritos ${j.escritos} · omitidos ${j.omitidos?.length || 0} · errores ${j.errores?.length || 0}`);
        setImportPreview(null);
        setImportFile(null);
        setImportSheet(null);
        await fetchRows();
      }
    } catch (e) {
      setSyncResult(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setImporting(false);
    }
  }, [importFile, importing, fetchRows]);

  const syncDesdeML = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    setSyncResult(null);
    try {
      const r = await fetch("/api/ml/sync-dimensiones-ml", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const j = await r.json();
      if (!r.ok) {
        setSyncResult(`Error: ${j.error || r.statusText}`);
      } else {
        setSyncResult(`Procesados ${j.processed} · Actualizados ${j.updated} · Sin atributos ${j.sin_atributos_count} · Errores ${j.errores?.length || 0}`);
        await fetchRows();
      }
    } catch (e) {
      setSyncResult(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSyncing(false);
    }
  }, [syncing, fetchRows]);

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <h2 style={{ margin: 0 }}>Dimensiones</h2>
        <div style={{ fontSize: 11, color: "var(--txt3)" }}>Divisor volumétrico ML Chile = {ML_DIVISOR_VOLUMETRICO}</div>
      </div>
      <div style={{ color: "var(--txt3)", fontSize: 13, marginBottom: 14 }}>
        BANVA = la verdad medida (gana sobre ML para cálculo de envío). ML = espejo de lo declarado en la publicación.
      </div>

      {/* KPIs */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10, marginBottom: 14 }}>
        <KPI label="SKUs total" value={`${stats.total}`} />
        <KPI label="Con dim BANVA" value={`${stats.conBanva} / ${stats.total}`} sub={`${stats.total > 0 ? ((stats.conBanva/stats.total)*100).toFixed(0) : 0}%`} tone={stats.conBanva === stats.total ? "green" : "amber"} />
        <KPI label="Con dim ML" value={`${stats.conMl} / ${stats.total}`} sub={`${stats.total > 0 ? ((stats.conMl/stats.total)*100).toFixed(0) : 0}%`} tone={stats.conMl >= stats.total * 0.95 ? "green" : "amber"} />
        <KPI label="Con discrepancia" value={`${stats.discrepancias}`} sub="BANVA difiere de ML" tone={stats.discrepancias > 0 ? "red" : "green"} />
      </div>

      {/* Acciones */}
      <div className="card" style={{ padding: 12, marginBottom: 14, display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
        <button className="scan-btn blue" style={{ padding: "8px 14px", fontSize: 12, opacity: syncing ? 0.6 : 1 }} disabled={syncing} onClick={syncDesdeML}>
          {syncing ? "Sincronizando..." : "↻ Sync desde ML"}
        </button>
        <label className="scan-btn green" style={{ padding: "8px 14px", fontSize: 12, opacity: importing ? 0.6 : 1, cursor: "pointer" }}>
          📁 Importar Excel
          <input
            type="file"
            accept=".xlsx,.xls"
            disabled={importing}
            style={{ display: "none" }}
            onChange={e => {
              const f = e.target.files?.[0];
              if (f) dryRunImport(f);
              e.target.value = "";
            }}
          />
        </label>
        <input
          className="form-input"
          placeholder="Buscar SKU o nombre..."
          value={q}
          onChange={e => setQ(e.target.value)}
          style={{ flex: 1, minWidth: 200 }}
        />
        <select className="form-input" value={filtro} onChange={e => setFiltro(e.target.value as Filtro)}>
          <option value="todos">Todos</option>
          <option value="sin_banva">Sin dim BANVA</option>
          <option value="sin_ml">Sin dim ML</option>
          <option value="con_discrepancia">Con discrepancia</option>
          <option value="completos">Completos (BANVA + ML)</option>
        </select>
        {syncResult && <div style={{ fontSize: 12, color: "var(--txt2)", flexBasis: "100%" }}>{syncResult}</div>}
      </div>

      {/* Tabla */}
      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ maxHeight: "70vh", overflowY: "auto" }}>
          <table className="tbl" style={{ width: "100%", fontSize: 12 }}>
            <thead style={{ position: "sticky", top: 0, background: "var(--bg2)", zIndex: 1 }}>
              <tr>
                <th style={{ textAlign: "left" }}>SKU</th>
                <th style={{ textAlign: "left" }}>Nombre</th>
                <th style={{ textAlign: "right" }}>BANVA L×A×H (cm)</th>
                <th style={{ textAlign: "right" }}>BANVA peso (g)</th>
                <th style={{ textAlign: "right" }}>ML L×A×H (cm)</th>
                <th style={{ textAlign: "right" }}>ML peso (g)</th>
                <th style={{ textAlign: "right" }}>Peso vol BANVA</th>
                <th style={{ textAlign: "right" }}>Peso vol ML</th>
                <th style={{ textAlign: "center" }}>Origen</th>
                <th style={{ textAlign: "center" }}></th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={10} style={{ padding: 20, textAlign: "center", color: "var(--txt3)" }}>Cargando...</td></tr>
              )}
              {!loading && visibles.length === 0 && (
                <tr><td colSpan={10} style={{ padding: 20, textAlign: "center", color: "var(--txt3)" }}>Sin resultados</td></tr>
              )}
              {visibles.map(r => {
                const volBanva = pesoVolGr(r.largo_cm, r.ancho_cm, r.alto_cm);
                const volMl = pesoVolGr(r.ml_largo_cm, r.ml_ancho_cm, r.ml_alto_cm);
                const disc = tieneDiscrepancia(r);
                return (
                  <tr key={r.sku} style={disc ? { background: "var(--redBg)" } : undefined}>
                    <td className="mono" style={{ fontWeight: 600 }}>{r.sku}</td>
                    <td style={{ color: "var(--txt2)", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.nombre || "—"}</td>
                    <td className="mono" style={{ textAlign: "right" }}>
                      {r.largo_cm !== null && r.ancho_cm !== null && r.alto_cm !== null
                        ? `${r.largo_cm}×${r.ancho_cm}×${r.alto_cm}`
                        : <span style={{ color: "var(--txt3)" }}>—</span>}
                    </td>
                    <td className="mono" style={{ textAlign: "right" }}>{r.peso_real_gr ?? <span style={{ color: "var(--txt3)" }}>—</span>}</td>
                    <td className="mono" style={{ textAlign: "right", color: "var(--txt2)" }}>
                      {r.ml_largo_cm !== null && r.ml_ancho_cm !== null && r.ml_alto_cm !== null
                        ? `${r.ml_largo_cm}×${r.ml_ancho_cm}×${r.ml_alto_cm}`
                        : <span style={{ color: "var(--txt3)" }}>—</span>}
                    </td>
                    <td className="mono" style={{ textAlign: "right", color: "var(--txt2)" }}>{r.ml_peso_gr ?? <span style={{ color: "var(--txt3)" }}>—</span>}</td>
                    <td className="mono" style={{ textAlign: "right" }}>{volBanva ?? <span style={{ color: "var(--txt3)" }}>—</span>}</td>
                    <td className="mono" style={{ textAlign: "right", color: "var(--txt2)" }}>{volMl ?? <span style={{ color: "var(--txt3)" }}>—</span>}</td>
                    <td style={{ textAlign: "center" }}>
                      {r.dimensiones_origen ? (
                        <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, background: origenBg(r.dimensiones_origen), color: origenColor(r.dimensiones_origen) }}>
                          {r.dimensiones_origen}
                        </span>
                      ) : <span style={{ color: "var(--txt3)" }}>—</span>}
                    </td>
                    <td style={{ textAlign: "center" }}>
                      <button
                        onClick={() => setEditing(r)}
                        style={{ fontSize: 11, padding: "4px 10px", borderRadius: 4, background: "var(--bg3)", border: "1px solid var(--bg4)", color: "var(--txt)" }}
                      >
                        Editar
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {editing && (
        <EditModal
          row={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); fetchRows(); }}
        />
      )}
      {importPreview && (
        <ImportPreviewModal
          preview={importPreview}
          fileName={importFile?.name || ""}
          loading={importing}
          onCancel={() => { setImportPreview(null); setImportFile(null); setImportSheet(null); }}
          onConfirm={aplicarImport}
          onChangeSheet={(s) => { if (importFile) dryRunImport(importFile, s); }}
        />
      )}
    </div>
  );
}

function ImportPreviewModal({ preview, fileName, loading, onCancel, onConfirm, onChangeSheet }: {
  preview: { a_escribir: number; procesados: number; omitidos: { sku: string; razon: string }[]; preview: { sku: string; largo_cm: number | null; ancho_cm: number | null; alto_cm: number | null; peso_real_gr: number | null }[]; available_sheets?: string[]; sheet_used?: string };
  fileName: string;
  loading: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  onChangeSheet: (s: string) => void;
}) {
  return (
    <div onClick={onCancel} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div className="card" onClick={e => e.stopPropagation()} style={{ padding: 18, maxWidth: 700, width: "100%", maxHeight: "85vh", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <h3 style={{ margin: 0 }}>Preview importación</h3>
          <button onClick={onCancel} style={{ fontSize: 18, color: "var(--txt3)", background: "none", border: "none" }}>✕</button>
        </div>
        <div style={{ color: "var(--txt3)", fontSize: 12, marginBottom: 12 }}>{fileName}</div>

        {preview.available_sheets && preview.available_sheets.length > 1 && (
          <div style={{ marginBottom: 12, padding: 10, background: "var(--bg3)", borderRadius: 6 }}>
            <div style={{ fontSize: 11, color: "var(--txt3)", marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>Hoja del libro</div>
            <select
              className="form-input"
              value={preview.sheet_used || preview.available_sheets[0]}
              disabled={loading}
              onChange={e => onChangeSheet(e.target.value)}
              style={{ width: "100%" }}
            >
              {preview.available_sheets.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 12 }}>
          <KPI label="Procesados" value={String(preview.procesados)} />
          <KPI label="A escribir" value={String(preview.a_escribir)} tone="green" />
          <KPI label="Omitidos" value={String(preview.omitidos.length)} tone={preview.omitidos.length > 0 ? "amber" : undefined} />
        </div>

        {preview.preview.length > 0 && (
          <>
            <div style={{ fontSize: 11, color: "var(--txt3)", marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>Primeras 10 filas</div>
            <table className="tbl" style={{ width: "100%", fontSize: 12, marginBottom: 12 }}>
              <thead><tr>
                <th style={{ textAlign: "left" }}>SKU</th>
                <th style={{ textAlign: "right" }}>Largo</th>
                <th style={{ textAlign: "right" }}>Ancho</th>
                <th style={{ textAlign: "right" }}>Alto</th>
                <th style={{ textAlign: "right" }}>Peso (g)</th>
              </tr></thead>
              <tbody>
                {preview.preview.map((r, i) => (
                  <tr key={i}>
                    <td className="mono">{r.sku}</td>
                    <td className="mono" style={{ textAlign: "right" }}>{r.largo_cm ?? "—"}</td>
                    <td className="mono" style={{ textAlign: "right" }}>{r.ancho_cm ?? "—"}</td>
                    <td className="mono" style={{ textAlign: "right" }}>{r.alto_cm ?? "—"}</td>
                    <td className="mono" style={{ textAlign: "right" }}>{r.peso_real_gr ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        {preview.omitidos.length > 0 && (
          <details style={{ marginBottom: 12 }}>
            <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--amber)" }}>
              Ver {preview.omitidos.length} omitidos
            </summary>
            <div style={{ maxHeight: 200, overflowY: "auto", background: "var(--bg3)", borderRadius: 6, padding: 8, marginTop: 6, fontSize: 11 }}>
              {preview.omitidos.map((o, i) => (
                <div key={i} className="mono" style={{ marginBottom: 2 }}>
                  <span style={{ color: "var(--amber)" }}>{o.sku}</span> · {o.razon}
                </div>
              ))}
            </div>
          </details>
        )}

        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onCancel} style={{ flex: 1, padding: "10px 14px", background: "var(--bg3)", border: "1px solid var(--bg4)", color: "var(--txt2)", borderRadius: 6 }}>Cancelar</button>
          <button onClick={onConfirm} disabled={loading || preview.a_escribir === 0} className="scan-btn green" style={{ flex: 1, padding: "10px 14px", fontSize: 13, opacity: loading || preview.a_escribir === 0 ? 0.6 : 1 }}>
            {loading ? "Aplicando..." : `Aplicar (escribir ${preview.a_escribir})`}
          </button>
        </div>
      </div>
    </div>
  );
}

function origenBg(o: string): string {
  if (o === "ml") return "var(--bg4)";
  if (o === "manual") return "var(--greenBg)";
  if (o === "excel") return "var(--cyanBg)";
  if (o === "bodega") return "var(--blueBg)";
  return "var(--bg3)";
}
function origenColor(o: string): string {
  if (o === "ml") return "var(--txt3)";
  if (o === "manual") return "var(--green)";
  if (o === "excel") return "var(--cyan)";
  if (o === "bodega") return "var(--blue)";
  return "var(--txt2)";
}

function KPI({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "green" | "red" | "amber" }) {
  const colorMap: Record<string, string> = { green: "var(--green)", red: "var(--red)", amber: "var(--amber)" };
  return (
    <div style={{ background: "var(--bg3)", padding: 12, borderRadius: 8 }}>
      <div style={{ fontSize: 10, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "var(--font-mono, JetBrains Mono, monospace)", color: tone ? colorMap[tone] : undefined, marginTop: 2 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "var(--txt3)", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function EditModal({ row, onClose, onSaved }: { row: DimRow; onClose: () => void; onSaved: () => void }) {
  const [largo, setLargo] = useState<string>(row.largo_cm !== null ? String(row.largo_cm) : "");
  const [ancho, setAncho] = useState<string>(row.ancho_cm !== null ? String(row.ancho_cm) : "");
  const [alto, setAlto]   = useState<string>(row.alto_cm  !== null ? String(row.alto_cm)  : "");
  const [peso, setPeso]   = useState<string>(row.peso_real_gr !== null ? String(row.peso_real_gr) : "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const copiarDeML = () => {
    if (row.ml_largo_cm !== null) setLargo(String(row.ml_largo_cm));
    if (row.ml_ancho_cm !== null) setAncho(String(row.ml_ancho_cm));
    if (row.ml_alto_cm  !== null) setAlto(String(row.ml_alto_cm));
    if (row.ml_peso_gr  !== null) setPeso(String(row.ml_peso_gr));
  };

  const guardar = async () => {
    if (saving) return;
    const sb = getSupabase();
    if (!sb) { setErr("Sin conexión"); return; }
    setSaving(true);
    setErr(null);
    const payload = {
      largo_cm: largo ? Number(largo) : null,
      ancho_cm: ancho ? Number(ancho) : null,
      alto_cm: alto ? Number(alto) : null,
      peso_real_gr: peso ? Number(peso) : null,
      dimensiones_origen: "manual" as const,
      dimensiones_updated_at: new Date().toISOString(),
      dimensiones_updated_by: "admin",
    };
    const { error } = await sb.from("productos").update(payload).eq("sku", row.sku);
    if (error) {
      setErr(`Error: ${error.message}`);
      setSaving(false);
      return;
    }
    setSaving(false);
    onSaved();
  };

  const largoN = Number(largo) || 0;
  const anchoN = Number(ancho) || 0;
  const altoN = Number(alto) || 0;
  const pesoN = Number(peso) || 0;
  const volPrev = (largoN > 0 && anchoN > 0 && altoN > 0)
    ? Math.round((largoN * anchoN * altoN) / ML_DIVISOR_VOLUMETRICO * 1000)
    : 0;
  const facturable = Math.max(pesoN, volPrev);

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div className="card" onClick={e => e.stopPropagation()} style={{ padding: 18, maxWidth: 480, width: "100%" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <h3 style={{ margin: 0 }}>Editar dimensiones</h3>
          <button onClick={onClose} style={{ fontSize: 18, color: "var(--txt3)", background: "none", border: "none" }}>✕</button>
        </div>
        <div className="mono" style={{ color: "var(--txt2)", fontSize: 13, marginBottom: 14 }}>{row.sku}</div>

        {(row.ml_largo_cm !== null || row.ml_ancho_cm !== null || row.ml_alto_cm !== null || row.ml_peso_gr !== null) && (
          <div className="card" style={{ background: "var(--bg3)", padding: 10, marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: "var(--txt3)", marginBottom: 4 }}>Lo que ML tiene declarado:</div>
            <div className="mono" style={{ fontSize: 12 }}>
              {row.ml_largo_cm ?? "—"} × {row.ml_ancho_cm ?? "—"} × {row.ml_alto_cm ?? "—"} cm · {row.ml_peso_gr ?? "—"} g
            </div>
            <button onClick={copiarDeML} style={{ marginTop: 6, fontSize: 11, padding: "4px 10px", borderRadius: 4, background: "var(--bg4)", color: "var(--txt2)", border: "none" }}>
              Copiar como baseline BANVA
            </button>
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 10 }}>
          <Field label="Largo (cm)"><input className="form-input" inputMode="decimal" value={largo} onChange={e => setLargo(e.target.value.replace(/[^\d.]/g, ""))} /></Field>
          <Field label="Ancho (cm)"><input className="form-input" inputMode="decimal" value={ancho} onChange={e => setAncho(e.target.value.replace(/[^\d.]/g, ""))} /></Field>
          <Field label="Alto (cm)"><input className="form-input" inputMode="decimal" value={alto} onChange={e => setAlto(e.target.value.replace(/[^\d.]/g, ""))} /></Field>
        </div>
        <Field label="Peso real (gramos)">
          <input className="form-input" inputMode="numeric" value={peso} onChange={e => setPeso(e.target.value.replace(/[^\d]/g, ""))} />
        </Field>

        {(largoN > 0 && anchoN > 0 && altoN > 0) && (
          <div style={{ padding: 8, background: "var(--bg3)", borderRadius: 6, fontSize: 12, marginBottom: 10 }}>
            Peso volumétrico: <b className="mono">{volPrev}g</b>
            {pesoN > 0 && (
              <> · Real <b className="mono">{pesoN}g</b> · ML factura: <b className="mono">{facturable}g</b></>
            )}
          </div>
        )}

        {err && <div style={{ padding: 8, background: "var(--redBg)", color: "var(--red)", borderRadius: 6, marginBottom: 10, fontSize: 12 }}>{err}</div>}

        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <button onClick={onClose} style={{ flex: 1, padding: "10px 14px", background: "var(--bg3)", border: "1px solid var(--bg4)", color: "var(--txt2)", borderRadius: 6 }}>Cancelar</button>
          <button onClick={guardar} disabled={saving} className="scan-btn green" style={{ flex: 1, padding: "10px 14px", fontSize: 13, opacity: saving ? 0.6 : 1 }}>
            {saving ? "Guardando..." : "Guardar"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="form-label" style={{ fontSize: 11, color: "var(--txt3)", marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}
