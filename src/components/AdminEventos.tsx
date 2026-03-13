"use client";
import { useState, useEffect, useCallback } from "react";
import { getSupabase } from "@/lib/supabase";

// ============================================
// Tipos
// ============================================

interface EventoDemanda {
  id: string;
  nombre: string;
  fecha_inicio: string;
  fecha_fin: string;
  fecha_prep_desde: string;
  multiplicador: number;
  categorias: string[];
  notas: string | null;
  activo: boolean;
  multiplicador_real: number | null;
  evaluado: boolean;
  created_at: string;
}

interface EventoForm {
  nombre: string;
  fecha_inicio: string;
  fecha_fin: string;
  fecha_prep_desde: string;
  multiplicador: string;
  categorias: string;
  notas: string;
  activo: boolean;
}

const emptyForm: EventoForm = {
  nombre: "",
  fecha_inicio: "",
  fecha_fin: "",
  fecha_prep_desde: "",
  multiplicador: "2.0",
  categorias: "",
  notas: "",
  activo: true,
};

// ============================================
// Componente principal
// ============================================

export default function AdminEventos() {
  const [eventos, setEventos] = useState<EventoDemanda[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<EventoForm>(emptyForm);
  const [editId, setEditId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);

  const hoy = new Date().toISOString().split("T")[0];

  const cargar = useCallback(async () => {
    setLoading(true);
    const sb = getSupabase();
    if (!sb) { setLoading(false); return; }
    const { data } = await sb.from("eventos_demanda")
      .select("*")
      .order("fecha_inicio", { ascending: true });
    setEventos((data || []) as EventoDemanda[]);
    setLoading(false);
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  const guardar = useCallback(async () => {
    const sb = getSupabase();
    if (!sb) return;
    if (!form.nombre || !form.fecha_inicio || !form.fecha_fin || !form.fecha_prep_desde) {
      alert("Completa nombre, fecha inicio, fecha fin y fecha preparacion");
      return;
    }
    setSaving(true);
    const row = {
      nombre: form.nombre.trim(),
      fecha_inicio: form.fecha_inicio,
      fecha_fin: form.fecha_fin,
      fecha_prep_desde: form.fecha_prep_desde,
      multiplicador: parseFloat(form.multiplicador) || 2.0,
      categorias: form.categorias.trim() ? form.categorias.split(",").map(s => s.trim()).filter(Boolean) : [],
      notas: form.notas.trim() || null,
      activo: form.activo,
    };
    if (editId) {
      await sb.from("eventos_demanda").update(row).eq("id", editId);
    } else {
      await sb.from("eventos_demanda").insert(row);
    }
    setShowForm(false);
    setEditId(null);
    setForm(emptyForm);
    await cargar();
    setSaving(false);
  }, [form, editId, cargar]);

  const editar = useCallback((ev: EventoDemanda) => {
    setForm({
      nombre: ev.nombre,
      fecha_inicio: ev.fecha_inicio,
      fecha_fin: ev.fecha_fin,
      fecha_prep_desde: ev.fecha_prep_desde,
      multiplicador: String(ev.multiplicador),
      categorias: (ev.categorias || []).join(", "),
      notas: ev.notas || "",
      activo: ev.activo,
    });
    setEditId(ev.id);
    setShowForm(true);
  }, []);

  const eliminar = useCallback(async (id: string) => {
    if (!confirm("Eliminar este evento?")) return;
    const sb = getSupabase();
    if (!sb) return;
    await sb.from("eventos_demanda").delete().eq("id", id);
    await cargar();
  }, [cargar]);

  const toggleActivo = useCallback(async (ev: EventoDemanda) => {
    const sb = getSupabase();
    if (!sb) return;
    await sb.from("eventos_demanda").update({ activo: !ev.activo }).eq("id", ev.id);
    await cargar();
  }, [cargar]);

  const evaluar = useCallback(async (ev: EventoDemanda) => {
    const input = prompt("Multiplicador real observado (ej: 1.8):");
    if (!input) return;
    const val = parseFloat(input);
    if (isNaN(val) || val <= 0) { alert("Valor invalido"); return; }
    const sb = getSupabase();
    if (!sb) return;
    await sb.from("eventos_demanda").update({ multiplicador_real: val, evaluado: true }).eq("id", ev.id);
    await cargar();
  }, [cargar]);

  // Clasificar eventos
  const activos = eventos.filter(e => e.activo && e.fecha_fin >= hoy);
  const enPrep = activos.filter(e => e.fecha_prep_desde <= hoy && e.fecha_inicio > hoy);
  const enCurso = activos.filter(e => e.fecha_inicio <= hoy && e.fecha_fin >= hoy);
  const proximos = activos.filter(e => e.fecha_prep_desde > hoy);
  const pasados = eventos.filter(e => e.fecha_fin < hoy || !e.activo);

  const estadoEvento = (e: EventoDemanda): { label: string; color: string } => {
    if (!e.activo) return { label: "Inactivo", color: "var(--txt3)" };
    if (e.fecha_inicio <= hoy && e.fecha_fin >= hoy) return { label: "En curso", color: "var(--green)" };
    if (e.fecha_prep_desde <= hoy && e.fecha_inicio > hoy) return { label: "Preparacion", color: "var(--amber)" };
    if (e.fecha_fin < hoy) return { label: "Finalizado", color: "var(--txt3)" };
    return { label: "Proximo", color: "var(--blue)" };
  };

  if (loading) return <div style={{ padding: 24, color: "var(--txt3)" }}>Cargando eventos...</div>;

  return (
    <div style={{ padding: "0 4px" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, flexWrap: "wrap", gap: 8 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Eventos de Demanda</h2>
          <div style={{ fontSize: 11, color: "var(--txt3)", marginTop: 2 }}>Eventos estacionales que ajustan la velocidad de demanda proyectada</div>
        </div>
        <button
          onClick={() => { setForm(emptyForm); setEditId(null); setShowForm(true); }}
          style={{ padding: "8px 16px", borderRadius: 8, background: "var(--cyanBg)", color: "var(--cyan)", fontWeight: 600, fontSize: 12, border: "1px solid var(--cyanBd)" }}
        >
          + Nuevo Evento
        </button>
      </div>

      {/* KPIs */}
      <div className="kpi-grid" style={{ marginBottom: 16 }}>
        <div className="kpi"><div className="kpi-value" style={{ color: "var(--green)" }}>{enCurso.length}</div><div className="kpi-label">En Curso</div></div>
        <div className="kpi"><div className="kpi-value" style={{ color: "var(--amber)" }}>{enPrep.length}</div><div className="kpi-label">En Preparacion</div></div>
        <div className="kpi"><div className="kpi-value" style={{ color: "var(--blue)" }}>{proximos.length}</div><div className="kpi-label">Proximos</div></div>
        <div className="kpi"><div className="kpi-value" style={{ color: "var(--txt3)" }}>{pasados.length}</div><div className="kpi-label">Pasados</div></div>
      </div>

      {/* Formulario */}
      {showForm && (
        <div className="card" style={{ marginBottom: 16, padding: 16 }}>
          <h3 style={{ margin: "0 0 12px 0", fontSize: 14, fontWeight: 700 }}>{editId ? "Editar Evento" : "Nuevo Evento"}</h3>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div style={{ gridColumn: "1 / -1" }}>
              <label className="form-label">Nombre</label>
              <input className="form-input" value={form.nombre} onChange={e => setForm({ ...form, nombre: e.target.value })} placeholder="Ej: Cyber Day Mayo" />
            </div>
            <div>
              <label className="form-label">Fecha Inicio</label>
              <input className="form-input" type="date" value={form.fecha_inicio} onChange={e => setForm({ ...form, fecha_inicio: e.target.value })} />
            </div>
            <div>
              <label className="form-label">Fecha Fin</label>
              <input className="form-input" type="date" value={form.fecha_fin} onChange={e => setForm({ ...form, fecha_fin: e.target.value })} />
            </div>
            <div>
              <label className="form-label">Inicio Preparacion</label>
              <input className="form-input" type="date" value={form.fecha_prep_desde} onChange={e => setForm({ ...form, fecha_prep_desde: e.target.value })} />
            </div>
            <div>
              <label className="form-label">Multiplicador Demanda</label>
              <input className="form-input" type="number" step="0.1" min="1" value={form.multiplicador} onChange={e => setForm({ ...form, multiplicador: e.target.value })} />
            </div>
            <div style={{ gridColumn: "1 / -1" }}>
              <label className="form-label">Categorias (separadas por coma, vacio = todas)</label>
              <input className="form-input" value={form.categorias} onChange={e => setForm({ ...form, categorias: e.target.value })} placeholder="Ej: Sabanas, Toallas" />
            </div>
            <div style={{ gridColumn: "1 / -1" }}>
              <label className="form-label">Notas</label>
              <input className="form-input" value={form.notas} onChange={e => setForm({ ...form, notas: e.target.value })} placeholder="Observaciones..." />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input type="checkbox" checked={form.activo} onChange={e => setForm({ ...form, activo: e.target.checked })} id="ev-activo" />
              <label htmlFor="ev-activo" style={{ fontSize: 12, color: "var(--txt2)" }}>Activo</label>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
            <button
              onClick={guardar}
              disabled={saving}
              style={{ padding: "8px 20px", borderRadius: 8, background: "var(--greenBg)", color: "var(--green)", fontWeight: 600, fontSize: 12, border: "1px solid var(--greenBd)" }}
            >
              {saving ? "Guardando..." : editId ? "Actualizar" : "Crear"}
            </button>
            <button
              onClick={() => { setShowForm(false); setEditId(null); setForm(emptyForm); }}
              style={{ padding: "8px 20px", borderRadius: 8, background: "var(--bg3)", color: "var(--txt3)", fontWeight: 600, fontSize: 12, border: "1px solid var(--bg4)" }}
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      {/* Lista de eventos */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {eventos.map(ev => {
          const est = estadoEvento(ev);
          const diasPara = Math.ceil((new Date(ev.fecha_inicio).getTime() - Date.now()) / 86400000);
          return (
            <div key={ev.id} className="card" style={{ padding: 14, opacity: !ev.activo || ev.fecha_fin < hoy ? 0.6 : 1 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    <span style={{ fontWeight: 700, fontSize: 14 }}>{ev.nombre}</span>
                    <span style={{ padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 600, color: est.color, background: est.color + "22", border: `1px solid ${est.color}44` }}>
                      {est.label}
                    </span>
                    {est.label === "Proximo" && diasPara > 0 && (
                      <span style={{ fontSize: 10, color: "var(--txt3)" }}>en {diasPara}d</span>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 16, fontSize: 11, color: "var(--txt2)", flexWrap: "wrap" }}>
                    <span>Prep: <span className="mono">{ev.fecha_prep_desde}</span></span>
                    <span>Evento: <span className="mono">{ev.fecha_inicio}</span> a <span className="mono">{ev.fecha_fin}</span></span>
                    <span>Mult: <span className="mono" style={{ color: "var(--cyan)", fontWeight: 600 }}>{ev.multiplicador}x</span></span>
                    {ev.evaluado && ev.multiplicador_real != null && (
                      <span>Real: <span className="mono" style={{ color: ev.multiplicador_real >= ev.multiplicador ? "var(--green)" : "var(--amber)", fontWeight: 600 }}>{ev.multiplicador_real}x</span></span>
                    )}
                  </div>
                  {ev.categorias && ev.categorias.length > 0 && (
                    <div style={{ marginTop: 4, display: "flex", gap: 4, flexWrap: "wrap" }}>
                      {ev.categorias.map((c, i) => (
                        <span key={i} style={{ padding: "1px 6px", borderRadius: 3, fontSize: 10, background: "var(--bg4)", color: "var(--txt2)" }}>{c}</span>
                      ))}
                    </div>
                  )}
                  {ev.notas && <div style={{ fontSize: 11, color: "var(--txt3)", marginTop: 4 }}>{ev.notas}</div>}
                </div>
                <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                  <button onClick={() => editar(ev)} style={{ padding: "4px 10px", borderRadius: 6, background: "var(--bg3)", color: "var(--txt2)", fontSize: 11, border: "1px solid var(--bg4)" }}>Editar</button>
                  <button onClick={() => toggleActivo(ev)} style={{ padding: "4px 10px", borderRadius: 6, background: "var(--bg3)", color: ev.activo ? "var(--amber)" : "var(--green)", fontSize: 11, border: "1px solid var(--bg4)" }}>
                    {ev.activo ? "Desactivar" : "Activar"}
                  </button>
                  {ev.fecha_fin < hoy && !ev.evaluado && (
                    <button onClick={() => evaluar(ev)} style={{ padding: "4px 10px", borderRadius: 6, background: "var(--blueBg)", color: "var(--blue)", fontSize: 11, border: "1px solid var(--blueBd)" }}>Evaluar</button>
                  )}
                  <button onClick={() => eliminar(ev.id)} style={{ padding: "4px 10px", borderRadius: 6, background: "var(--bg3)", color: "var(--red)", fontSize: 11, border: "1px solid var(--bg4)" }}>Eliminar</button>
                </div>
              </div>
            </div>
          );
        })}
        {eventos.length === 0 && (
          <div style={{ textAlign: "center", padding: 40, color: "var(--txt3)" }}>No hay eventos. Crea uno para ajustar la demanda proyectada en periodos estacionales.</div>
        )}
      </div>
    </div>
  );
}
