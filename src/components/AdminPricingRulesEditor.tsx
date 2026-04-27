"use client";
import { useEffect, useState } from "react";

/**
 * AdminPricingRulesEditor — UI para ver/editar/publicar/promover el rule set
 * de pricing global. Manual: BANVA_Pricing_Engines_a_Escala §3.4 (linea 184-205).
 *
 * Flujo:
 *  - Tab "Activo": muestra rule set en production con resumen por dominio
 *  - "Editar": abre textarea con JSON, valida, publica nueva version
 *  - Tab "Historial": versiones con botones Aprobar / Promover
 */

type RuleSetMeta = {
  id: string;
  domain: string;
  version_label: string;
  content_hash: string;
  status: "draft" | "approved" | "deprecated";
  created_by: string | null;
  created_at: string;
  approved_by: string | null;
  approved_at: string | null;
  notes: string | null;
};

type Pointer = {
  channel: string;
  domain: string;
  rule_set_id: string;
  rollout_pct: number;
  activated_by: string | null;
  activated_at: string;
  notes: string | null;
};

type ActiveResp = {
  rule_set: {
    rule_set_id: string;
    version_label: string;
    content_hash: string;
    rules: Record<string, unknown>;
    schema_version: number;
  };
};

type ListResp = { rule_sets: RuleSetMeta[]; pointers: Pointer[] };

const RULE_DESCRIPTIONS: Record<string, { titulo: string; resumen: (v: any) => string; manual: string }> = {
  markdown_ladder:        { titulo: "🪙 Markdown ladder", resumen: (v) => `${v.min_dias_para_postular}d → ${v.niveles?.map((n: any) => `${n.dias_min}d=-${n.descuento_pct}%`).join(", ")}`, manual: "Comparada:197" },
  valle_muerte:           { titulo: "🚫 Valle muerte ML",  resumen: (v) => `No postular entre $${v.min_clp?.toLocaleString("es-CL")} y $${v.max_clp?.toLocaleString("es-CL")}`, manual: "Engines" },
  promos_postulacion:     { titulo: "🎯 Promos: cuándo postular", resumen: (v) => `Tiers obligatorios: ${(v.siempre_postular_tiers||[]).join(",")} | Tipos obligatorios: ${(v.siempre_postular_tipos||[]).join(", ")}${v.bypass_floor_para_obligatorios ? " (bypass floor)" : ""}`, manual: "Comparada:303-310" },
  subtipo_revisar:        { titulo: "🔍 Subtipos REVISAR", resumen: (v) => `liquidar ≥${v.criterios?.liquidar_dias_sin_mov_min}d, nuevo ≤${v.criterios?.nuevo_dias_desde_primera_max}d`, manual: "Comparada:197" },
  triggers_reclasificacion: { titulo: "🔄 Triggers reclasif", resumen: (v) => `aging ≥${v.aging?.dias_sin_movimiento_min}d, MoM ≥${v.crecimiento?.mom_pct_min}%×${v.crecimiento?.meses_consecutivos}m, margen ≤${v.margen_bajo?.margen_pct_max}%×${v.margen_bajo?.meses_consecutivos}m`, manual: "Comparada:235" },
  pareto:                 { titulo: "📊 Pareto ABC", resumen: (v) => `A=${v.umbral_clase_a}%, B=${v.umbral_clase_b}%`, manual: "ABC clásico" },
  recovery_rampup:        { titulo: "📈 Recovery rampup", resumen: (v) => `vel_30d ≥${v.vel_30d_min_pct_de_pre_quiebre}% del pre-quiebre`, manual: "—" },
  distribucion_default:   { titulo: "📦 Distribución default", resumen: (v) => `Full ${v.full_pct}% / Flex ${v.flex_pct}%`, manual: "—" },
  rampup_post_quiebre:    { titulo: "⚡ Rampup post-quiebre", resumen: (v) => `${v.buckets?.length ?? 0} buckets`, manual: "—" },
  cooldown:               { titulo: "❄️ Cooldown bajadas", resumen: (v) => `${v.ventana_horas}h, max ${v.max_bajadas_en_ventana} bajadas`, manual: "Engines:593" },
  cmaa_alerta:            { titulo: "💸 CMAA alerta", resumen: (v) => `<${v.umbral_pct}% × ${v.ventana_dias}d`, manual: "Comparada:329" },
  cobertura:              { titulo: "📅 Cobertura", resumen: (v) => `min ${v.min_postular_dias}d, A=${v.target_dias_a}/B=${v.target_dias_b}/C=${v.target_dias_c}`, manual: "—" },
  service_level_z:        { titulo: "📐 Service level Z",   resumen: (v) => `97%=${v.z_97}, 95%=${v.z_95}, 80%=${v.z_80}`, manual: "estadística" },
  forecast_quality_alerts:{ titulo: "🎯 Forecast quality", resumen: (v) => `tracking_signal=${v.tracking_signal_umbral}, bias≥${v.bias_pct_de_vel_umbral}%`, manual: "—" },
  gates:                  { titulo: "🚪 Gates descuento", resumen: (v) => `KVI max ${v.kvi_descuento_max_pct}%, defender max ${v.defender_descuento_max_pct}%`, manual: "—" },
  quiebre_prolongado:     { titulo: "⏳ Quiebre prolongado", resumen: (v) => `r1: ${v.rama_1_dias_min}d+vel≥${v.rama_1_vel_pre_min} | r2: ${v.rama_2_dias_min}d+vel×${v.vel_pre_factor_vs_act}`, manual: "—" },
  tsb:                    { titulo: "🆕 TSB edad mínima", resumen: (v) => `${v.edad_minima_dias}d`, manual: "—" },
  imputacion:             { titulo: "🔢 Imputación", resumen: (v) => `${v.semanas_en_30d} semanas/30d`, manual: "—" },
  cuadrantes:             { titulo: "🎲 Cuadrantes", resumen: (v) => `ESTRELLA m≥${v.ESTRELLA?.margen_min_pct}% / VOLUMEN m≥${v.VOLUMEN?.margen_min_pct}% / CASHCOW m≥${v.CASHCOW?.margen_min_pct}% / REVISAR m≥${v.REVISAR?.margen_min_pct}%`, manual: "Comparada:148" },
  governance:             { titulo: "⚖️ Governance %/cambio", resumen: (v) => `${v.status} — ${v.max_change_pct_diario}%/día, ${v.max_change_pct_semanal}%/sem`, manual: "Comparada:630" },
};

const truncHash = (h: string | null | undefined) => (h ? `${h.slice(0, 7)}…` : "—");
const fmtDate   = (d: string | null | undefined) => (d ? new Date(d).toLocaleString("es-CL", { dateStyle: "short", timeStyle: "short" }) : "—");

export default function AdminPricingRulesEditor() {
  const [tab, setTab] = useState<"activo" | "historial" | "editor">("activo");
  const [active, setActive] = useState<ActiveResp["rule_set"] | null>(null);
  const [list, setList] = useState<ListResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [draftJson, setDraftJson] = useState<string>("");
  const [versionLabel, setVersionLabel] = useState("");
  const [createdBy, setCreatedBy] = useState("");
  const [editorNotes, setEditorNotes] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [publishMsg, setPublishMsg] = useState<string | null>(null);

  async function loadActive() {
    setLoading(true); setError(null);
    try {
      const r = await fetch("/api/pricing/rule-sets?channel=production&domain=global");
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "load_failed");
      setActive(j.rule_set);
      setDraftJson(JSON.stringify(j.rule_set.rules, null, 2));
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }

  async function loadList() {
    setLoading(true); setError(null);
    try {
      const r = await fetch("/api/pricing/rule-sets?list=1&domain=global");
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "list_failed");
      setList(j);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }

  useEffect(() => { loadActive(); loadList(); }, []);

  async function publish() {
    setPublishMsg(null);
    if (!createdBy.trim()) { setPublishMsg("⚠️ Falta campo 'Quién publica'"); return; }
    if (!versionLabel.trim()) { setPublishMsg("⚠️ Falta version_label (ej: v1.2.0)"); return; }
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(draftJson); } catch (e: any) { setPublishMsg(`⚠️ JSON inválido: ${e.message}`); return; }

    setPublishing(true);
    try {
      const r = await fetch("/api/pricing/rule-sets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rules: parsed,
          version_label: versionLabel.trim(),
          created_by: createdBy.trim(),
          notes: editorNotes.trim() || null,
          parent_id: active?.rule_set_id,
          domain: "global",
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "publish_failed");
      setPublishMsg(j.was_new
        ? `✅ Publicado ${versionLabel} (hash ${truncHash(j.content_hash)}). Falta APROBAR (con otra persona) y PROMOVER en Historial.`
        : `ℹ️ Mismo content_hash que ${truncHash(j.content_hash)}, no se creó duplicado.`);
      await loadList();
    } catch (e: any) { setPublishMsg(`❌ ${e.message}`); }
    finally { setPublishing(false); }
  }

  async function approve(id: string) {
    const who = window.prompt("Quién aprueba? (debe ser distinto al creator)");
    if (!who?.trim()) return;
    try {
      const r = await fetch("/api/pricing/rule-sets", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rule_set_id: id, approved_by: who.trim() }),
      });
      const j = await r.json();
      if (!r.ok) { alert(`Error: ${j.error}`); return; }
      await loadList();
    } catch (e: any) { alert(`Error: ${e.message}`); }
  }

  async function promote(id: string, channel: "production" | "canary" | "shadow") {
    const who = window.prompt(`Quién promueve a ${channel}?`);
    if (!who?.trim()) return;
    let rolloutPct = 100;
    if (channel === "canary") {
      const pct = window.prompt("Rollout % (0-100)?", "5");
      if (!pct) return;
      rolloutPct = Math.max(0, Math.min(100, parseInt(pct, 10) || 0));
    }
    if (!window.confirm(`¿Confirmar promover a ${channel} (${rolloutPct}%)? Esto cambia las decisiones del motor en vivo.`)) return;
    try {
      const r = await fetch("/api/pricing/rule-sets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rule_set_id: id, channel, rollout_pct: rolloutPct, activated_by: who.trim(), domain: "global" }),
      });
      const j = await r.json();
      if (!r.ok) { alert(`Error: ${j.error}`); return; }
      await loadActive(); await loadList();
    } catch (e: any) { alert(`Error: ${e.message}`); }
  }

  const productionPointer = list?.pointers?.find((p) => p.channel === "production" && p.domain === "global");

  return (
    <div className="card" style={{ padding: 16 }}>
      <h3 style={{ margin: "0 0 4px", fontSize: 18 }}>📜 Reglas de pricing — Editor</h3>
      <div style={{ fontSize: 12, color: "var(--txt2)", marginBottom: 12 }}>
        Manual: <span className="mono">Engines_a_Escala §3.4</span>. Edición → Publish → Approve (otra persona) → Promote.
        En production hoy: <strong>{active?.version_label || "—"}</strong> · hash <span className="mono">{truncHash(active?.content_hash)}</span>
        {productionPointer && <> · activado {fmtDate(productionPointer.activated_at)} por <strong>{productionPointer.activated_by || "—"}</strong></>}
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        {(["activo", "editor", "historial"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: "6px 12px",
              border: tab === t ? "1px solid var(--cyan)" : "1px solid var(--bg4)",
              background: tab === t ? "var(--cyanBg)" : "var(--bg3)",
              color: tab === t ? "var(--cyan)" : "var(--txt2)",
              borderRadius: 6, fontSize: 13, cursor: "pointer",
            }}
          >
            {t === "activo" ? "📋 Resumen activo" : t === "editor" ? "✏️ Editor JSON" : "📚 Historial / Promote"}
          </button>
        ))}
        <button onClick={() => { loadActive(); loadList(); }} disabled={loading}
          style={{ marginLeft: "auto", padding: "6px 12px", border: "1px solid var(--bg4)", background: "var(--bg3)", color: "var(--txt2)", borderRadius: 6, fontSize: 13, cursor: "pointer" }}>
          {loading ? "..." : "🔄 Recargar"}
        </button>
      </div>

      {error && (
        <div style={{ padding: 8, background: "var(--redBg)", border: "1px solid var(--redBd)", color: "var(--red)", borderRadius: 6, fontSize: 12, marginBottom: 8 }}>
          ❌ {error}
        </div>
      )}

      {tab === "activo" && active && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 8 }}>
          {Object.entries(active.rules).filter(([k]) => k !== "version" && k !== "domain" && k !== "fuente").map(([k, v]) => {
            const meta = RULE_DESCRIPTIONS[k];
            return (
              <div key={k} style={{ padding: 10, background: "var(--bg3)", border: "1px solid var(--bg4)", borderRadius: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{meta?.titulo || k}</div>
                <div style={{ fontSize: 11, color: "var(--txt2)", marginBottom: 4 }} className="mono">
                  {meta?.resumen?.(v) || "—"}
                </div>
                {meta?.manual && <div style={{ fontSize: 10, color: "var(--txt3)" }}>📖 {meta.manual}</div>}
              </div>
            );
          })}
        </div>
      )}

      {tab === "editor" && (
        <div>
          <div style={{ padding: 8, background: "var(--amberBg)", border: "1px solid var(--amberBd)", color: "var(--amber)", borderRadius: 6, fontSize: 12, marginBottom: 8 }}>
            ⚠️ Editar JSON crudo. El sistema valida sintaxis pero NO la lógica. Cambio en producción requiere:
            <br />1. Publicar (acá) — crea draft con content_hash
            <br />2. Aprobar en Historial (debe ser otra persona, two-person rule)
            <br />3. Promover a production en Historial
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
            <input className="form-input" placeholder="version_label (ej v1.2.0)" value={versionLabel} onChange={(e) => setVersionLabel(e.target.value)} />
            <input className="form-input" placeholder="Quién publica (tu nombre)"  value={createdBy} onChange={(e) => setCreatedBy(e.target.value)} />
          </div>
          <input className="form-input" placeholder="Notas (qué cambia y por qué)" value={editorNotes} onChange={(e) => setEditorNotes(e.target.value)} style={{ marginBottom: 8, width: "100%" }} />
          <textarea
            value={draftJson}
            onChange={(e) => setDraftJson(e.target.value)}
            spellCheck={false}
            className="mono"
            style={{ width: "100%", minHeight: 420, padding: 10, background: "var(--bg)", border: "1px solid var(--bg4)", color: "var(--txt)", borderRadius: 6, fontSize: 12, lineHeight: 1.5, resize: "vertical" }}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
            <button onClick={publish} disabled={publishing}
              style={{ padding: "8px 16px", background: "var(--cyan)", color: "var(--bg)", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
              {publishing ? "Publicando..." : "📤 Publicar versión"}
            </button>
            <button onClick={() => active && setDraftJson(JSON.stringify(active.rules, null, 2))}
              style={{ padding: "8px 12px", border: "1px solid var(--bg4)", background: "var(--bg3)", color: "var(--txt2)", borderRadius: 6, fontSize: 13, cursor: "pointer" }}>
              ↩️ Revertir al activo
            </button>
            {publishMsg && <span style={{ fontSize: 12, color: publishMsg.startsWith("✅") ? "var(--green)" : publishMsg.startsWith("ℹ️") ? "var(--cyan)" : "var(--red)" }}>{publishMsg}</span>}
          </div>
        </div>
      )}

      {tab === "historial" && list && (
        <div style={{ overflowX: "auto" }}>
          <table className="tbl" style={{ width: "100%", fontSize: 12 }}>
            <thead>
              <tr>
                <th>Versión</th><th>Hash</th><th>Status</th><th>Created</th><th>Approved</th><th>En</th><th style={{ textAlign: "right" }}>Acción</th>
              </tr>
            </thead>
            <tbody>
              {list.rule_sets.map((rs) => {
                const ptrs = list.pointers.filter((p) => p.rule_set_id === rs.id);
                const channels = ptrs.map((p) => `${p.channel}${p.rollout_pct < 100 ? `(${p.rollout_pct}%)` : ""}`).join(", ");
                return (
                  <tr key={rs.id}>
                    <td><strong>{rs.version_label}</strong>{rs.notes && <div style={{ fontSize: 10, color: "var(--txt2)", maxWidth: 280 }}>{rs.notes}</div>}</td>
                    <td className="mono">{truncHash(rs.content_hash)}</td>
                    <td>
                      <span style={{
                        padding: "2px 6px", borderRadius: 4, fontSize: 10,
                        background: rs.status === "approved" ? "var(--greenBg)" : rs.status === "draft" ? "var(--amberBg)" : "var(--bg4)",
                        color:      rs.status === "approved" ? "var(--green)"   : rs.status === "draft" ? "var(--amber)"   : "var(--txt3)",
                      }}>{rs.status}</span>
                    </td>
                    <td><div>{rs.created_by || "—"}</div><div style={{ fontSize: 10, color: "var(--txt3)" }}>{fmtDate(rs.created_at)}</div></td>
                    <td>{rs.approved_by ? <><div>{rs.approved_by}</div><div style={{ fontSize: 10, color: "var(--txt3)" }}>{fmtDate(rs.approved_at)}</div></> : "—"}</td>
                    <td>{channels || "—"}</td>
                    <td style={{ textAlign: "right" }}>
                      {rs.status === "draft" && (
                        <button onClick={() => approve(rs.id)} style={{ padding: "4px 8px", background: "var(--greenBg)", color: "var(--green)", border: "1px solid var(--greenBd)", borderRadius: 4, fontSize: 11, cursor: "pointer", marginRight: 4 }}>
                          ✓ Aprobar
                        </button>
                      )}
                      {rs.status === "approved" && (
                        <>
                          <button onClick={() => promote(rs.id, "production")} style={{ padding: "4px 8px", background: "var(--cyanBg)", color: "var(--cyan)", border: "1px solid var(--cyanBd)", borderRadius: 4, fontSize: 11, cursor: "pointer", marginRight: 4 }}>
                            🚀 Production
                          </button>
                          <button onClick={() => promote(rs.id, "canary")} style={{ padding: "4px 8px", background: "var(--bg3)", color: "var(--txt2)", border: "1px solid var(--bg4)", borderRadius: 4, fontSize: 11, cursor: "pointer" }}>
                            🐤 Canary
                          </button>
                        </>
                      )}
                    </td>
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
