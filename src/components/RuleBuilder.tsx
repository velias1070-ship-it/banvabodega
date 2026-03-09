"use client";
import { useState, useEffect } from "react";
import {
  fetchReglasConciliacion,
  upsertRegla,
  deleteRegla,
  fetchPlanCuentasHojas,
} from "@/lib/db";
import type { DBReglaConciliacion, CondicionRegla, DBPlanCuentas } from "@/lib/db";

// ==================== CONSTANTES ====================

// Campos disponibles para condiciones
const CAMPOS: { value: CondicionRegla["campo"]; label: string }[] = [
  { value: "descripcion", label: "Descripción" },
  { value: "monto", label: "Monto" },
  { value: "banco", label: "Banco" },
  { value: "referencia", label: "Referencia" },
];

// Operadores por tipo de campo
const OPERADORES_TEXTO: { value: CondicionRegla["operador"]; label: string }[] = [
  { value: "contiene", label: "Contiene" },
  { value: "no_contiene", label: "No contiene" },
  { value: "igual", label: "Es igual a" },
];

const OPERADORES_NUMERO: { value: CondicionRegla["operador"]; label: string }[] = [
  { value: "mayor_que", label: "Mayor que" },
  { value: "menor_que", label: "Menor que" },
  { value: "igual", label: "Igual a" },
  { value: "entre", label: "Entre" },
];

// Formatear moneda CLP
const fmtMoney = (n: number) => n.toLocaleString("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });

// ==================== EDITOR DE CONDICIÓN ====================

function CondicionEditor({
  condicion,
  onChange,
  onRemove,
}: {
  condicion: CondicionRegla;
  onChange: (c: CondicionRegla) => void;
  onRemove: () => void;
}) {
  const esMonto = condicion.campo === "monto";
  const operadores = esMonto ? OPERADORES_NUMERO : OPERADORES_TEXTO;

  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6 }}>
      {/* Campo */}
      <select value={condicion.campo}
        onChange={(e) => onChange({ ...condicion, campo: e.target.value as CondicionRegla["campo"], valor: "" })}
        style={{ background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", borderRadius: 6, padding: "4px 8px", fontSize: 11, width: 110 }}>
        {CAMPOS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
      </select>

      {/* Operador */}
      <select value={condicion.operador}
        onChange={(e) => onChange({ ...condicion, operador: e.target.value as CondicionRegla["operador"] })}
        style={{ background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", borderRadius: 6, padding: "4px 8px", fontSize: 11, width: 110 }}>
        {operadores.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>

      {/* Valor */}
      <input
        type={esMonto ? "number" : "text"}
        value={condicion.valor}
        onChange={(e) => onChange({ ...condicion, valor: esMonto ? Number(e.target.value) : e.target.value })}
        placeholder={esMonto ? "0" : "texto..."}
        style={{ background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", borderRadius: 6, padding: "4px 8px", fontSize: 11, flex: 1 }}
      />

      {/* Valor 2 (para "entre") */}
      {condicion.operador === "entre" && (
        <>
          <span style={{ fontSize: 11, color: "var(--txt3)" }}>y</span>
          <input
            type="number"
            value={condicion.valor2 || ""}
            onChange={(e) => onChange({ ...condicion, valor2: Number(e.target.value) })}
            placeholder="0"
            style={{ background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", borderRadius: 6, padding: "4px 8px", fontSize: 11, width: 80 }}
          />
        </>
      )}

      {/* Eliminar condición */}
      <button onClick={onRemove}
        style={{ width: 24, height: 24, borderRadius: 6, background: "var(--redBg)", color: "var(--red)", border: "none", cursor: "pointer", fontSize: 12, fontWeight: 700 }}>
        ×
      </button>
    </div>
  );
}

// ==================== FORMULARIO REGLA ====================

function ReglaForm({
  regla,
  cuentasHoja,
  onSave,
  onCancel,
}: {
  regla: DBReglaConciliacion | null;
  cuentasHoja: DBPlanCuentas[];
  onSave: (r: DBReglaConciliacion) => void;
  onCancel: () => void;
}) {
  const [nombre, setNombre] = useState(regla?.nombre || "");
  const [prioridad, setPrioridad] = useState(regla?.prioridad || 99);
  const [condiciones, setCondiciones] = useState<CondicionRegla[]>(regla?.condiciones || []);
  const [accionAuto, setAccionAuto] = useState(regla?.accion_auto || false);
  const [confianzaMin, setConfianzaMin] = useState(regla?.confianza_minima || 0.80);
  const [categoriaId, setCategoriaId] = useState(regla?.categoria_cuenta_id || "");

  const addCondicion = () => {
    setCondiciones([...condiciones, { campo: "descripcion", operador: "contiene", valor: "" }]);
  };

  const updateCondicion = (idx: number, c: CondicionRegla) => {
    const next = [...condiciones];
    next[idx] = c;
    setCondiciones(next);
  };

  const removeCondicion = (idx: number) => {
    setCondiciones(condiciones.filter((_, i) => i !== idx));
  };

  const handleSave = () => {
    if (!nombre.trim() || condiciones.length === 0) return;
    onSave({
      id: regla?.id,
      nombre: nombre.trim(),
      activa: regla?.activa ?? true,
      prioridad,
      condiciones,
      accion_auto: accionAuto,
      confianza_minima: confianzaMin,
      categoria_cuenta_id: categoriaId || null,
      stats_matches: regla?.stats_matches || 0,
    });
  };

  return (
    <div className="card" style={{ padding: 16, marginBottom: 16 }}>
      <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>
        {regla?.id ? "Editar regla" : "Nueva regla de conciliación"}
      </h3>

      {/* Nombre y prioridad */}
      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 8, marginBottom: 12 }}>
        <div>
          <label className="form-label">Nombre</label>
          <input className="form-input" value={nombre} onChange={(e) => setNombre(e.target.value)}
            placeholder="ej: Liquidación MercadoPago" style={{ fontSize: 13 }} />
        </div>
        <div>
          <label className="form-label">Prioridad (menor = primero)</label>
          <input className="form-input mono" type="number" value={prioridad}
            onChange={(e) => setPrioridad(Number(e.target.value))} min={1} max={99} style={{ fontSize: 13 }} />
        </div>
      </div>

      {/* Condiciones */}
      <div style={{ marginBottom: 12 }}>
        <label className="form-label">Condiciones (todas deben cumplirse)</label>
        {condiciones.map((c, i) => (
          <CondicionEditor key={i} condicion={c} onChange={(nc) => updateCondicion(i, nc)} onRemove={() => removeCondicion(i)} />
        ))}
        <button onClick={addCondicion}
          style={{ padding: "4px 12px", borderRadius: 6, background: "var(--bg3)", color: "var(--cyan)", border: "1px solid var(--bg4)", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
          + Agregar condición
        </button>
      </div>

      {/* Categoría contable */}
      <div style={{ marginBottom: 12 }}>
        <label className="form-label">Categoría contable (opcional)</label>
        <select className="form-input" value={categoriaId} onChange={(e) => setCategoriaId(e.target.value)} style={{ fontSize: 12 }}>
          <option value="">— Sin categoría —</option>
          {cuentasHoja.map((c) => (
            <option key={c.id} value={c.id}>{c.codigo} — {c.nombre}</option>
          ))}
        </select>
      </div>

      {/* Auto-conciliación + confianza */}
      <div style={{ display: "flex", gap: 24, alignItems: "center", marginBottom: 16 }}>
        <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
          <input type="checkbox" checked={accionAuto} onChange={(e) => setAccionAuto(e.target.checked)} />
          Auto-conciliar (sin confirmación manual)
        </label>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 11, color: "var(--txt3)" }}>Confianza mín:</span>
          <input type="range" min={0.5} max={1} step={0.05} value={confianzaMin}
            onChange={(e) => setConfianzaMin(Number(e.target.value))}
            style={{ width: 100 }} />
          <span className="mono" style={{ fontSize: 12, fontWeight: 600, color: "var(--cyan)" }}>
            {Math.round(confianzaMin * 100)}%
          </span>
        </div>
      </div>

      {/* Botones */}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button onClick={onCancel}
          style={{ padding: "6px 14px", borderRadius: 8, background: "var(--bg3)", color: "var(--txt)", fontSize: 12, border: "1px solid var(--bg4)" }}>
          Cancelar
        </button>
        <button onClick={handleSave} disabled={!nombre.trim() || condiciones.length === 0}
          className="scan-btn green" style={{ padding: "6px 16px", fontSize: 12 }}>
          Guardar
        </button>
      </div>
    </div>
  );
}

// ==================== COMPONENTE PRINCIPAL ====================

export default function RuleBuilder() {
  const [reglas, setReglas] = useState<DBReglaConciliacion[]>([]);
  const [cuentasHoja, setCuentasHoja] = useState<DBPlanCuentas[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingRegla, setEditingRegla] = useState<DBReglaConciliacion | null | "new">(null);

  const load = async () => {
    setLoading(true);
    const [r, c] = await Promise.all([
      fetchReglasConciliacion(),
      fetchPlanCuentasHojas(),
    ]);
    setReglas(r);
    setCuentasHoja(c);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  // Guardar regla (crear o editar)
  const handleSave = async (r: DBReglaConciliacion) => {
    await upsertRegla(r);
    setEditingRegla(null);
    load();
  };

  // Eliminar regla
  const handleDelete = async (id: string) => {
    if (!confirm("¿Eliminar esta regla?")) return;
    await deleteRegla(id);
    load();
  };

  // Toggle activa
  const handleToggle = async (r: DBReglaConciliacion) => {
    await upsertRegla({ ...r, activa: !r.activa });
    load();
  };

  if (loading) return <div style={{ textAlign: "center", padding: 40, color: "var(--txt3)" }}>Cargando reglas...</div>;

  // Resumen
  const activas = reglas.filter((r) => r.activa).length;
  const totalMatches = reglas.reduce((s, r) => s + (r.stats_matches || 0), 0);

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Reglas de Conciliación</h2>
          <div style={{ fontSize: 12, color: "var(--txt3)", marginTop: 2 }}>
            {activas} activas de {reglas.length} · {totalMatches} matches totales
          </div>
        </div>
        <button onClick={() => setEditingRegla("new")}
          className="scan-btn blue" style={{ padding: "6px 16px", fontSize: 12 }}>
          {editingRegla === "new" ? "Cancelar" : "+ Nueva regla"}
        </button>
      </div>

      {/* Formulario */}
      {editingRegla && (
        <ReglaForm
          regla={editingRegla === "new" ? null : editingRegla}
          cuentasHoja={cuentasHoja}
          onSave={handleSave}
          onCancel={() => setEditingRegla(null)}
        />
      )}

      {/* Lista de reglas */}
      {reglas.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: "center" }}>
          <div style={{ fontSize: 24, marginBottom: 8 }}>⚙️</div>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Sin reglas de conciliación</div>
          <div style={{ fontSize: 12, color: "var(--txt3)" }}>Ejecuta la migración v8 o crea reglas manualmente</div>
        </div>
      ) : (
        <div>
          {reglas.map((r) => {
            const cuenta = r.categoria_cuenta_id ? cuentasHoja.find((c) => c.id === r.categoria_cuenta_id) : null;
            return (
              <div key={r.id} className="card" style={{ padding: 14, marginBottom: 8, opacity: r.activa ? 1 : 0.5 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {/* Prioridad */}
                    <span className="mono" style={{
                      width: 28, height: 28, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center",
                      background: "var(--cyanBg)", color: "var(--cyan)", fontWeight: 700, fontSize: 13,
                    }}>
                      {r.prioridad}
                    </span>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 600 }}>{r.nombre}</div>
                      <div style={{ fontSize: 11, color: "var(--txt3)", display: "flex", gap: 8, marginTop: 2 }}>
                        <span>{r.condiciones.length} condicion{r.condiciones.length !== 1 ? "es" : ""}</span>
                        <span>·</span>
                        <span className="mono">{r.stats_matches} matches</span>
                        {r.accion_auto && (
                          <>
                            <span>·</span>
                            <span style={{ color: "var(--green)" }}>Auto ≥{Math.round(r.confianza_minima * 100)}%</span>
                          </>
                        )}
                        {cuenta && (
                          <>
                            <span>·</span>
                            <span style={{ color: "var(--amber)" }}>{cuenta.codigo}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    {/* Toggle activa */}
                    <button onClick={() => handleToggle(r)}
                      style={{
                        width: 36, height: 20, borderRadius: 10, border: "none", cursor: "pointer",
                        background: r.activa ? "var(--green)" : "var(--bg4)", position: "relative", transition: "background 0.2s",
                      }}>
                      <div style={{
                        width: 16, height: 16, borderRadius: 8, background: "#fff",
                        position: "absolute", top: 2, left: r.activa ? 18 : 2, transition: "left 0.2s",
                      }} />
                    </button>
                    <button onClick={() => setEditingRegla(r)}
                      style={{ padding: "4px 10px", borderRadius: 6, background: "var(--bg3)", color: "var(--txt2)", border: "1px solid var(--bg4)", fontSize: 11, cursor: "pointer" }}>
                      Editar
                    </button>
                    <button onClick={() => handleDelete(r.id!)}
                      style={{ padding: "4px 10px", borderRadius: 6, background: "var(--redBg)", color: "var(--red)", border: "none", fontSize: 11, cursor: "pointer" }}>
                      Eliminar
                    </button>
                  </div>
                </div>

                {/* Condiciones en línea */}
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  {r.condiciones.map((c, i) => (
                    <span key={i} style={{
                      fontSize: 10, padding: "2px 8px", borderRadius: 4,
                      background: "var(--bg3)", border: "1px solid var(--bg4)", color: "var(--txt2)",
                    }}>
                      {c.campo} <span style={{ color: "var(--cyan)" }}>{c.operador}</span>{" "}
                      <span className="mono" style={{ fontWeight: 600 }}>
                        {typeof c.valor === "number" ? fmtMoney(c.valor) : `"${c.valor}"`}
                      </span>
                      {c.operador === "entre" && c.valor2 !== undefined && (
                        <> y <span className="mono" style={{ fontWeight: 600 }}>{fmtMoney(c.valor2)}</span></>
                      )}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
