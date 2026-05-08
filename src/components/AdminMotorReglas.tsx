"use client";
import { useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase";

// Editor de las tablas que dictan las decisiones del motor de inteligencia:
//   - policy_templates: cell ABC×XYZ → service_level, z, target_dias_full/flex, action
//   - markdown_policy:  cell + dias_extra_threshold → liquidacion_accion + descuento_pct
//   - seasonal_categories: categorías que activan ajuste de z para "low_confidence_seasonal"
//   - intel_config: targets globales legacy (target_dias_a/b/c)
// Cada tabla tiene su propia tab con form de edición inline.

type Tab = "templates" | "markdown" | "seasonal" | "intel";

interface PolicyTemplate {
  cell: string;
  action: string | null;
  service_level: number | null;
  z_value: number | null;
  target_dias_full: number;
  target_dias_flex: number;
  source_ref: string | null;
}

interface MarkdownPolicy {
  cell: string;
  dias_extra_threshold: number;
  descuento_pct: number;
  liquidacion_accion: string;
}

interface SeasonalCategory {
  category: string;
  is_active: boolean;
}

interface IntelConfig {
  id: string;
  target_dias_a: number;
  target_dias_b: number;
  target_dias_c: number;
  updated_at: string;
}

export default function AdminMotorReglas() {
  const [tab, setTab] = useState<Tab>("templates");
  return (
    <div style={{ padding: 16 }}>
      <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Reglas del Motor</h2>
      <p style={{ fontSize: 11, color: "var(--txt3)", marginBottom: 16, maxWidth: 800 }}>
        Parámetros que dictan las decisiones del motor (qué es URGENTE, cuándo liquidar, cuántos días de stock mantener).
        Editar acá impacta a todos los SKUs en el próximo recálculo.
      </p>
      <div style={{ display: "flex", gap: 6, marginBottom: 16, borderBottom: "1px solid var(--bg4)", paddingBottom: 8 }}>
        {([
          ["templates", "Policy Templates (por celda)"],
          ["markdown", "Liquidación (markdown policy)"],
          ["seasonal", "Categorías estacionales"],
          ["intel", "Targets globales (legacy)"],
        ] as const).map(([k, lbl]) => (
          <button key={k} onClick={() => setTab(k)}
            style={{ padding: "6px 12px", fontSize: 11, fontWeight: 600, borderRadius: 6,
              background: tab === k ? "var(--cyan)" : "var(--bg3)",
              color: tab === k ? "#000" : "var(--txt2)", border: "none", cursor: "pointer" }}>
            {lbl}
          </button>
        ))}
      </div>
      {tab === "templates" && <PolicyTemplatesTab />}
      {tab === "markdown" && <MarkdownPolicyTab />}
      {tab === "seasonal" && <SeasonalCategoriesTab />}
      {tab === "intel" && <IntelConfigTab />}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// 1. policy_templates — params por celda ABC×XYZ
// ──────────────────────────────────────────────────────────────────────

function PolicyTemplatesTab() {
  const [rows, setRows] = useState<PolicyTemplate[]>([]);
  const [edits, setEdits] = useState<Map<string, Partial<PolicyTemplate>>>(new Map());
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string>("");

  useEffect(() => { void cargar(); }, []);
  async function cargar() {
    const sb = getSupabase(); if (!sb) return;
    const { data } = await sb.from("policy_templates")
      .select("cell, action, service_level, z_value, target_dias_full, target_dias_flex, source_ref")
      .order("cell");
    setRows((data || []) as PolicyTemplate[]);
  }

  function setField(cell: string, k: keyof PolicyTemplate, v: string | number | null) {
    setEdits(prev => {
      const next = new Map(prev);
      const cur = next.get(cell) || {};
      next.set(cell, { ...cur, [k]: v });
      return next;
    });
  }
  function getVal<K extends keyof PolicyTemplate>(r: PolicyTemplate, k: K): PolicyTemplate[K] {
    const e = edits.get(r.cell);
    if (e && k in e) return e[k] as PolicyTemplate[K];
    return r[k];
  }

  async function guardar() {
    const sb = getSupabase(); if (!sb || edits.size === 0) return;
    setSaving(true); setMsg("");
    const updates: { cell: string; payload: Partial<PolicyTemplate> }[] = [];
    edits.forEach((payload, cell) => {
      if (Object.keys(payload).length > 0) updates.push({ cell, payload });
    });
    let okCount = 0, errCount = 0;
    for (const u of updates) {
      const { error } = await sb.from("policy_templates").update(u.payload).eq("cell", u.cell);
      if (error) { errCount++; console.error(`[policy_templates ${u.cell}]`, error.message); }
      else okCount++;
    }
    setMsg(`${okCount} actualizadas, ${errCount} errores. Recordá disparar /api/policy/sync-from-templates para que los cambios bajen a sku_node_policy.`);
    setEdits(new Map());
    await cargar();
    setSaving(false);
  }

  const acciones = ["reorder_normal","reorder_lt_corto","reorder_periodic","reorder_bulk","reorder_minimo","no_reorder"];

  return (
    <>
      <p style={{ fontSize: 11, color: "var(--txt3)", marginBottom: 12 }}>
        Define service level (cobertura objetivo del lead time) y target_dias_full (cuántos días de stock mantener) por cada combinación ABC × XYZ.
        BZ = SKU clase B con demanda irregular. CZ = SKU descartable (no_reorder).
        <br/><b>z_value</b> deriva del service_level: 0.95→1.65, 0.98→2.05. <b>target_dias_full</b> también es input al cálculo de liquidación (dias_extra = dio − target).
      </p>
      <div style={{ overflowX: "auto" }}>
        <table className="tbl" style={{ fontSize: 11, width: "100%" }}>
          <thead>
            <tr>
              <th>Celda</th>
              <th>Acción</th>
              <th>Service Level</th>
              <th>z value</th>
              <th>Target días Full</th>
              <th>Target días Flex</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const dirty = edits.has(r.cell);
              return (
                <tr key={r.cell} style={{ background: dirty ? "var(--amberBg)" : undefined }}>
                  <td className="mono" style={{ fontWeight: 700 }}>{r.cell}</td>
                  <td>
                    <select value={getVal(r, "action") || ""} onChange={e => setField(r.cell, "action", e.target.value || null)}
                      style={{ background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", padding: "2px 4px", fontSize: 10, borderRadius: 4 }}>
                      <option value="">(null)</option>
                      {acciones.map(a => <option key={a} value={a}>{a}</option>)}
                    </select>
                  </td>
                  <td>
                    <input type="number" step="0.01" value={getVal(r, "service_level") ?? ""}
                      onChange={e => setField(r.cell, "service_level", e.target.value === "" ? null : Number(e.target.value))}
                      style={{ width: 70, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", padding: "2px 4px", fontSize: 11, borderRadius: 4, fontFamily: "var(--font-mono)" }} />
                  </td>
                  <td>
                    <input type="number" step="0.01" value={getVal(r, "z_value") ?? ""}
                      onChange={e => setField(r.cell, "z_value", e.target.value === "" ? null : Number(e.target.value))}
                      style={{ width: 70, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", padding: "2px 4px", fontSize: 11, borderRadius: 4, fontFamily: "var(--font-mono)" }} />
                  </td>
                  <td>
                    <input type="number" value={getVal(r, "target_dias_full") ?? 0}
                      onChange={e => setField(r.cell, "target_dias_full", Number(e.target.value) || 0)}
                      style={{ width: 60, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", padding: "2px 4px", fontSize: 11, borderRadius: 4, fontFamily: "var(--font-mono)" }} />
                  </td>
                  <td>
                    <input type="number" value={getVal(r, "target_dias_flex") ?? 0}
                      onChange={e => setField(r.cell, "target_dias_flex", Number(e.target.value) || 0)}
                      style={{ width: 60, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", padding: "2px 4px", fontSize: 11, borderRadius: 4, fontFamily: "var(--font-mono)" }} />
                  </td>
                  <td style={{ fontSize: 9, color: "var(--txt3)", maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.source_ref || ""}>{r.source_ref}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <BotonesGuardar dirty={edits.size} saving={saving} onSave={guardar} onDescartar={() => setEdits(new Map())} msg={msg} />
    </>
  );
}

// ──────────────────────────────────────────────────────────────────────
// 2. markdown_policy — thresholds de liquidación por celda
// ──────────────────────────────────────────────────────────────────────

function MarkdownPolicyTab() {
  const [rows, setRows] = useState<MarkdownPolicy[]>([]);
  const [edits, setEdits] = useState<Map<string, Partial<MarkdownPolicy>>>(new Map());
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string>("");

  useEffect(() => { void cargar(); }, []);
  async function cargar() {
    const sb = getSupabase(); if (!sb) return;
    const { data } = await sb.from("markdown_policy")
      .select("cell, dias_extra_threshold, descuento_pct, liquidacion_accion")
      .order("cell").order("dias_extra_threshold");
    setRows((data || []) as MarkdownPolicy[]);
  }

  function key(r: MarkdownPolicy) { return `${r.cell}|${r.dias_extra_threshold}`; }

  function setField(r: MarkdownPolicy, k: keyof MarkdownPolicy, v: string | number) {
    setEdits(prev => {
      const next = new Map(prev);
      const k2 = key(r);
      const cur = next.get(k2) || {};
      next.set(k2, { ...cur, [k]: v });
      return next;
    });
  }
  function getVal<K extends keyof MarkdownPolicy>(r: MarkdownPolicy, k: K): MarkdownPolicy[K] {
    const e = edits.get(key(r));
    if (e && k in e) return e[k] as MarkdownPolicy[K];
    return r[k];
  }

  async function guardar() {
    const sb = getSupabase(); if (!sb || edits.size === 0) return;
    setSaving(true); setMsg("");
    let okCount = 0, errCount = 0;
    const tareas: Array<{ k2: string; payload: Partial<MarkdownPolicy> }> = [];
    edits.forEach((payload, k2) => tareas.push({ k2, payload }));
    for (const t of tareas) {
      const [cell, threshStr] = t.k2.split("|");
      const { error } = await sb.from("markdown_policy")
        .update(t.payload).eq("cell", cell).eq("dias_extra_threshold", Number(threshStr));
      if (error) { errCount++; console.error(`[markdown ${t.k2}]`, error.message); }
      else okCount++;
    }
    setMsg(`${okCount} actualizadas, ${errCount} errores.`);
    setEdits(new Map());
    await cargar();
    setSaving(false);
  }

  return (
    <>
      <p style={{ fontSize: 11, color: "var(--txt3)", marginBottom: 12 }}>
        Cuando un SKU tiene <b>dias_extra</b> (días de stock por encima del target) que supera un threshold, el motor le pone una acción de liquidación.
        Esto <b>capa qty_a_comprar a 0</b> en Pedido a Proveedor.
        <br/>Ejemplo BZ: 38 días extra → matchea threshold &gt;30 → <code>descuento_10</code>.
      </p>
      <div style={{ overflowX: "auto" }}>
        <table className="tbl" style={{ fontSize: 11, width: "100%" }}>
          <thead>
            <tr>
              <th>Celda</th>
              <th>Días extra threshold (&gt;)</th>
              <th>Descuento %</th>
              <th>Acción liquidación</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const dirty = edits.has(key(r));
              return (
                <tr key={key(r)} style={{ background: dirty ? "var(--amberBg)" : undefined }}>
                  <td className="mono" style={{ fontWeight: 700 }}>{r.cell}</td>
                  <td className="mono">{r.dias_extra_threshold}</td>
                  <td>
                    <input type="number" step="0.01" value={getVal(r, "descuento_pct")}
                      onChange={e => setField(r, "descuento_pct", Number(e.target.value) || 0)}
                      style={{ width: 80, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", padding: "2px 4px", fontSize: 11, borderRadius: 4, fontFamily: "var(--font-mono)" }} />
                  </td>
                  <td>
                    <select value={getVal(r, "liquidacion_accion")}
                      onChange={e => setField(r, "liquidacion_accion", e.target.value)}
                      style={{ background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", padding: "2px 4px", fontSize: 10, borderRadius: 4 }}>
                      {["descuento_10","liquidar_activa","precio_costo","monitorear","no_aplica"].map(a => <option key={a} value={a}>{a}</option>)}
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <BotonesGuardar dirty={edits.size} saving={saving} onSave={guardar} onDescartar={() => setEdits(new Map())} msg={msg} />
    </>
  );
}

// ──────────────────────────────────────────────────────────────────────
// 3. seasonal_categories — toggle por categoría
// ──────────────────────────────────────────────────────────────────────

function SeasonalCategoriesTab() {
  const [rows, setRows] = useState<SeasonalCategory[]>([]);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string>("");
  const [nueva, setNueva] = useState("");

  useEffect(() => { void cargar(); }, []);
  async function cargar() {
    const sb = getSupabase(); if (!sb) return;
    const { data } = await sb.from("seasonal_categories")
      .select("category, is_active").order("category");
    setRows((data || []) as SeasonalCategory[]);
  }

  async function toggle(category: string, current: boolean) {
    const sb = getSupabase(); if (!sb) return;
    setSaving(true);
    const { error } = await sb.from("seasonal_categories")
      .update({ is_active: !current }).eq("category", category);
    if (error) setMsg(`Error: ${error.message}`); else setMsg(`${category}: ${!current ? "activada" : "desactivada"}`);
    await cargar();
    setSaving(false);
  }

  async function agregar() {
    const sb = getSupabase(); if (!sb || !nueva.trim()) return;
    setSaving(true);
    const { error } = await sb.from("seasonal_categories")
      .insert({ category: nueva.trim().toLowerCase(), is_active: true });
    if (error) setMsg(`Error: ${error.message}`); else { setMsg(`agregada: ${nueva}`); setNueva(""); }
    await cargar();
    setSaving(false);
  }

  return (
    <>
      <p style={{ fontSize: 11, color: "var(--txt3)", marginBottom: 12 }}>
        Categorías marcadas como estacionales reciben un <b>z efectivo más alto (1.88)</b> cuando el SKU es XYZ Y o Z, sobreescribiendo el z del template.
        Esto infla el safety stock para SKUs con baja confianza estadística pero patrón estacional conocido.
      </p>
      <div style={{ display: "flex", gap: 6, marginBottom: 12, alignItems: "center" }}>
        <input type="text" value={nueva} onChange={e => setNueva(e.target.value)} placeholder="nueva categoría (lowercase)"
          style={{ padding: "4px 8px", fontSize: 11, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", borderRadius: 4, width: 240 }} />
        <button onClick={agregar} disabled={!nueva.trim() || saving}
          style={{ padding: "4px 12px", fontSize: 11, fontWeight: 600, background: "var(--green)", color: "#000", border: "none", borderRadius: 4, cursor: "pointer" }}>
          + Agregar
        </button>
      </div>
      <table className="tbl" style={{ fontSize: 11 }}>
        <thead>
          <tr><th>Categoría</th><th>Estacional</th></tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.category}>
              <td className="mono">{r.category}</td>
              <td>
                <button onClick={() => toggle(r.category, r.is_active)} disabled={saving}
                  style={{ padding: "3px 10px", fontSize: 10, fontWeight: 600, borderRadius: 4,
                    background: r.is_active ? "var(--green)" : "var(--bg3)",
                    color: r.is_active ? "#000" : "var(--txt3)", border: "none", cursor: "pointer" }}>
                  {r.is_active ? "ACTIVA" : "inactiva"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {msg && <p style={{ fontSize: 11, marginTop: 8, color: "var(--cyan)" }}>{msg}</p>}
    </>
  );
}

// ──────────────────────────────────────────────────────────────────────
// 4. intel_config — targets globales legacy
// ──────────────────────────────────────────────────────────────────────

function IntelConfigTab() {
  const [row, setRow] = useState<IntelConfig | null>(null);
  const [edits, setEdits] = useState<Partial<IntelConfig>>({});
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string>("");

  useEffect(() => { void cargar(); }, []);
  async function cargar() {
    const sb = getSupabase(); if (!sb) return;
    const { data } = await sb.from("intel_config")
      .select("id, target_dias_a, target_dias_b, target_dias_c, updated_at")
      .eq("id", "main").single();
    if (data) setRow(data as IntelConfig);
  }

  async function guardar() {
    const sb = getSupabase(); if (!sb || !row || Object.keys(edits).length === 0) return;
    setSaving(true);
    const { error } = await sb.from("intel_config")
      .update({ ...edits, updated_at: new Date().toISOString() }).eq("id", "main");
    if (error) setMsg(`Error: ${error.message}`); else { setMsg("Guardado."); setEdits({}); }
    await cargar();
    setSaving(false);
  }

  if (!row) return <p style={{ color: "var(--txt3)", fontSize: 11 }}>Cargando…</p>;
  function val<K extends keyof IntelConfig>(k: K): IntelConfig[K] {
    return (k in edits ? edits[k] : row?.[k]) as IntelConfig[K];
  }

  return (
    <>
      <p style={{ fontSize: 11, color: "var(--txt3)", marginBottom: 12 }}>
        Targets globales (legacy, motor viejo). El motor nuevo prefiere <code>policy_templates.target_dias_full</code> por celda.
        Estos valores siguen leyéndose en algunos paths de <code>intelligence.ts</code>.
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "200px 100px", gap: 8, alignItems: "center", maxWidth: 400 }}>
        <label style={{ fontSize: 11 }}>Target días A:</label>
        <input type="number" value={val("target_dias_a")} onChange={e => setEdits({ ...edits, target_dias_a: Number(e.target.value) || 0 })}
          style={{ padding: "4px 6px", background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", borderRadius: 4, fontSize: 11, fontFamily: "var(--font-mono)" }} />
        <label style={{ fontSize: 11 }}>Target días B:</label>
        <input type="number" value={val("target_dias_b")} onChange={e => setEdits({ ...edits, target_dias_b: Number(e.target.value) || 0 })}
          style={{ padding: "4px 6px", background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", borderRadius: 4, fontSize: 11, fontFamily: "var(--font-mono)" }} />
        <label style={{ fontSize: 11 }}>Target días C:</label>
        <input type="number" value={val("target_dias_c")} onChange={e => setEdits({ ...edits, target_dias_c: Number(e.target.value) || 0 })}
          style={{ padding: "4px 6px", background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", borderRadius: 4, fontSize: 11, fontFamily: "var(--font-mono)" }} />
      </div>
      <p style={{ fontSize: 10, color: "var(--txt3)", marginTop: 8 }}>Última actualización: {row.updated_at}</p>
      <BotonesGuardar dirty={Object.keys(edits).length} saving={saving} onSave={guardar} onDescartar={() => setEdits({})} msg={msg} />
    </>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function BotonesGuardar({ dirty, saving, onSave, onDescartar, msg }:
  { dirty: number; saving: boolean; onSave: () => void; onDescartar: () => void; msg: string }) {
  return (
    <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center" }}>
      <button onClick={onSave} disabled={dirty === 0 || saving}
        style={{ padding: "6px 16px", fontSize: 11, fontWeight: 700, borderRadius: 6,
          background: dirty > 0 ? "var(--green)" : "var(--bg3)",
          color: dirty > 0 ? "#000" : "var(--txt3)", border: "none",
          cursor: dirty > 0 && !saving ? "pointer" : "default" }}>
        {saving ? "Guardando..." : `Guardar (${dirty})`}
      </button>
      {dirty > 0 && (
        <button onClick={onDescartar} disabled={saving}
          style={{ padding: "6px 12px", fontSize: 11, fontWeight: 600, borderRadius: 6,
            background: "var(--bg3)", color: "var(--txt2)", border: "1px solid var(--bg4)", cursor: "pointer" }}>
          Descartar
        </button>
      )}
      {msg && <span style={{ fontSize: 10, color: "var(--cyan)", marginLeft: 8 }}>{msg}</span>}
    </div>
  );
}
