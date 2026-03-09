"use client";
import { useState, useEffect, useCallback, useMemo } from "react";
import {
  fetchMovimientosBanco,
  fetchRcvCompras,
  fetchRcvVentas,
  fetchConciliaciones,
  upsertConciliacion,
  updateMovimientoBanco,
  insertFeedback,
  upsertRegla,
} from "@/lib/db";
import type {
  DBEmpresa, DBMovimientoBanco, DBRcvCompra, DBRcvVenta, DBConciliacion,
  DBReglaConciliacion, CondicionRegla,
} from "@/lib/db";

// ==================== HELPERS ====================

const fmtMoney = (n: number) => n.toLocaleString("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
const fmtDate = (d: string | null) => d ? new Date(d + "T12:00:00").toLocaleDateString("es-CL", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—";

// Nombre tipo documento
const TIPO_DOC: Record<number | string, string> = {
  33: "Factura", 34: "Fact. Exenta", 39: "Boleta", 41: "Boleta Ex.",
  46: "Fact. Compra", 52: "Guía Desp.", 56: "Nota Débito", 61: "Nota Crédito",
};

// Documento unificado para matching (compra o venta)
interface DocUnificado {
  id: string;
  tipo: "compra" | "venta";
  tipo_doc: string;
  tipo_doc_num: number | string;
  nro: string;
  rut: string;
  razon_social: string;
  fecha: string;
  monto_neto: number;
  monto_total: number;
  score: number; // Score de matching 0-100
}

// ==================== LÓGICA DE MATCHING ====================

// Calcular score de match entre un movimiento banco y un documento RCV
function calcularScore(mov: DBMovimientoBanco, doc: DocUnificado): number {
  let score = 0;
  const movAbs = Math.abs(mov.monto);
  const docAbs = Math.abs(doc.monto_total);
  const docNeto = Math.abs(doc.monto_neto);

  // Match exacto por monto total (+40 puntos)
  if (movAbs === docAbs) {
    score += 40;
  }
  // Match por monto neto sin IVA (+30 puntos)
  else if (movAbs === docNeto) {
    score += 30;
  }
  // Diferencia < 5% (+20 puntos)
  else if (docAbs > 0 && Math.abs(movAbs - docAbs) / docAbs < 0.05) {
    score += 20;
  }
  // Diferencia < 10% (+10 puntos)
  else if (docAbs > 0 && Math.abs(movAbs - docAbs) / docAbs < 0.10) {
    score += 10;
  }

  // Fecha cercana: ±5 días (+25 puntos), ±15 días (+15), ±30 días (+5)
  if (mov.fecha && doc.fecha) {
    const movDate = new Date(mov.fecha + "T12:00:00").getTime();
    const docDate = new Date(doc.fecha + "T12:00:00").getTime();
    const diffDias = Math.abs(movDate - docDate) / (1000 * 60 * 60 * 24);
    if (diffDias <= 5) score += 25;
    else if (diffDias <= 15) score += 15;
    else if (diffDias <= 30) score += 5;
  }

  // RUT en descripción del movimiento (+20 puntos)
  if (doc.rut && mov.descripcion) {
    const rutClean = doc.rut.replace(/\./g, "").replace(/-/g, "").toUpperCase();
    const descClean = (mov.descripcion || "").replace(/\./g, "").replace(/-/g, "").toUpperCase();
    if (descClean.includes(rutClean)) {
      score += 20;
    }
    // RUT parcial (sin DV)
    const rutBody = rutClean.slice(0, -1);
    if (rutBody.length >= 6 && descClean.includes(rutBody)) {
      score += 10;
    }
  }

  // Razón social en descripción (+15 puntos)
  if (doc.razon_social && mov.descripcion) {
    const rsWords = doc.razon_social.toUpperCase().split(/\s+/).filter(w => w.length > 3);
    const desc = (mov.descripcion || "").toUpperCase();
    const matchedWords = rsWords.filter(w => desc.includes(w));
    if (matchedWords.length >= 2) score += 15;
    else if (matchedWords.length === 1) score += 8;
  }

  return Math.min(score, 100);
}

// Extraer condiciones automáticas de un match para sugerir regla
function extraerCondicionesRegla(mov: DBMovimientoBanco, doc: DocUnificado): CondicionRegla[] {
  const condiciones: CondicionRegla[] = [];
  const desc = (mov.descripcion || "").toUpperCase();

  // Buscar palabras clave de la razón social en la descripción
  if (doc.razon_social) {
    const rsWords = doc.razon_social.toUpperCase().split(/\s+/).filter(w => w.length > 3);
    const matchedWords = rsWords.filter(w => desc.includes(w));
    if (matchedWords.length > 0) {
      condiciones.push({
        campo: "descripcion",
        operador: "contiene",
        valor: matchedWords[0], // Usar la primera palabra más relevante
      });
    }
  }

  // Condición por rango de monto (±10% del monto)
  if (mov.monto > 0) {
    condiciones.push({ campo: "monto", operador: "mayor_que", valor: 0 });
  } else {
    condiciones.push({ campo: "monto", operador: "menor_que", valor: 0 });
  }

  return condiciones;
}

// ==================== COMPONENTE PRINCIPAL ====================

export default function ConciliacionSplitView({
  empresa,
  periodo,
}: {
  empresa: DBEmpresa;
  periodo: string;
}) {
  const [movBanco, setMovBanco] = useState<DBMovimientoBanco[]>([]);
  const [compras, setCompras] = useState<DBRcvCompra[]>([]);
  const [ventas, setVentas] = useState<DBRcvVenta[]>([]);
  const [conciliaciones, setConciliaciones] = useState<DBConciliacion[]>([]);
  const [loading, setLoading] = useState(true);

  // Movimiento seleccionado
  const [selectedMov, setSelectedMov] = useState<DBMovimientoBanco | null>(null);
  // Documento seleccionado para confirmar
  const [selectedDoc, setSelectedDoc] = useState<DocUnificado | null>(null);

  // Filtro para movimientos
  const [movFilter, setMovFilter] = useState<"todos" | "pendiente" | "conciliado">("pendiente");

  // Modal de crear regla
  const [showRuleModal, setShowRuleModal] = useState(false);
  const [ruleFromMatch, setRuleFromMatch] = useState<{ mov: DBMovimientoBanco; doc: DocUnificado } | null>(null);
  const [ruleName, setRuleName] = useState("");
  const [ruleCondiciones, setRuleCondiciones] = useState<CondicionRegla[]>([]);

  // Estado de feedback guardado
  const [feedbackMsg, setFeedbackMsg] = useState<string | null>(null);

  // Cargar datos
  const load = useCallback(async () => {
    if (!empresa.id) return;
    setLoading(true);
    const [m, c, v, conc] = await Promise.all([
      fetchMovimientosBanco(empresa.id),
      fetchRcvCompras(empresa.id, periodo),
      fetchRcvVentas(empresa.id, periodo),
      fetchConciliaciones(empresa.id),
    ]);
    setMovBanco(m); setCompras(c); setVentas(v); setConciliaciones(conc);
    setLoading(false);
  }, [empresa.id, periodo]);

  useEffect(() => { load(); }, [load]);

  // IDs ya conciliados
  const concMovIds = useMemo(() =>
    new Set(conciliaciones.filter(c => c.estado !== "rechazado").map(c => c.movimiento_banco_id)),
    [conciliaciones]
  );
  const concCompraIds = useMemo(() =>
    new Set(conciliaciones.filter(c => c.estado !== "rechazado" && c.rcv_compra_id).map(c => c.rcv_compra_id)),
    [conciliaciones]
  );
  const concVentaIds = useMemo(() =>
    new Set(conciliaciones.filter(c => c.estado !== "rechazado" && c.rcv_venta_id).map(c => c.rcv_venta_id)),
    [conciliaciones]
  );

  // Movimientos filtrados
  const movFiltrados = useMemo(() => {
    if (movFilter === "pendiente") return movBanco.filter(m => !concMovIds.has(m.id!));
    if (movFilter === "conciliado") return movBanco.filter(m => concMovIds.has(m.id!));
    return movBanco;
  }, [movBanco, concMovIds, movFilter]);

  // Documentos sin conciliar (unificados compras + ventas)
  const docsSinConciliar = useMemo((): DocUnificado[] => {
    const docs: DocUnificado[] = [];
    for (const c of compras) {
      if (concCompraIds.has(c.id!)) continue;
      docs.push({
        id: c.id!, tipo: "compra", tipo_doc: TIPO_DOC[c.tipo_doc] || String(c.tipo_doc),
        tipo_doc_num: c.tipo_doc,
        nro: c.nro_doc || "", rut: c.rut_proveedor || "", razon_social: c.razon_social || "",
        fecha: c.fecha_docto || "", monto_neto: c.monto_neto || 0, monto_total: c.monto_total || 0, score: 0,
      });
    }
    for (const v of ventas) {
      if (concVentaIds.has(v.id!)) continue;
      docs.push({
        id: v.id!, tipo: "venta", tipo_doc: TIPO_DOC[v.tipo_doc] || String(v.tipo_doc),
        tipo_doc_num: v.tipo_doc,
        nro: v.folio || v.nro || "", rut: v.rut_emisor || "", razon_social: "",
        fecha: v.fecha_docto || "", monto_neto: v.monto_neto || 0, monto_total: v.monto_total || 0, score: 0,
      });
    }
    return docs;
  }, [compras, ventas, concCompraIds, concVentaIds]);

  // Sugerencias para el movimiento seleccionado (ordenadas por score)
  const sugerencias = useMemo((): DocUnificado[] => {
    if (!selectedMov) return [];
    return docsSinConciliar
      .map(doc => ({ ...doc, score: calcularScore(selectedMov, doc) }))
      .filter(doc => doc.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);
  }, [selectedMov, docsSinConciliar]);

  // Mostrar mensaje temporal de feedback
  const showFeedback = (msg: string) => {
    setFeedbackMsg(msg);
    setTimeout(() => setFeedbackMsg(null), 3000);
  };

  // Confirmar match manual — con feedback loop
  const handleConfirmar = async () => {
    if (!selectedMov || !selectedDoc || !empresa.id) return;

    // 1. Guardar la conciliación
    const c: DBConciliacion = {
      empresa_id: empresa.id,
      movimiento_banco_id: selectedMov.id!,
      rcv_compra_id: selectedDoc.tipo === "compra" ? selectedDoc.id : null,
      rcv_venta_id: selectedDoc.tipo === "venta" ? selectedDoc.id : null,
      confianza: selectedDoc.score / 100,
      estado: "confirmado",
      tipo_partida: "match",
      metodo: "manual",
      notas: null,
      created_by: "admin",
    };
    await upsertConciliacion(c);

    // 2. Actualizar estado del movimiento banco
    await updateMovimientoBanco(selectedMov.id!, { estado_conciliacion: "conciliado" } as Partial<DBMovimientoBanco>);

    // 3. Guardar feedback para aprendizaje del agente conciliador
    await insertFeedback({
      empresa_id: empresa.id,
      agente: "conciliador",
      accion_sugerida: {
        tipo: "match_confirmado",
        movimiento_id: selectedMov.id,
        documento_id: selectedDoc.id,
        documento_tipo: selectedDoc.tipo,
        score: selectedDoc.score,
      },
      accion_correcta: {
        tipo: "match_confirmado",
        movimiento_id: selectedMov.id,
        documento_id: selectedDoc.id,
        documento_tipo: selectedDoc.tipo,
      },
      contexto: {
        monto_mov: selectedMov.monto,
        descripcion_mov: selectedMov.descripcion,
        monto_doc: selectedDoc.monto_total,
        rut_doc: selectedDoc.rut,
        razon_social_doc: selectedDoc.razon_social,
        banco: selectedMov.banco,
      },
    });

    showFeedback("Match confirmado y feedback guardado");

    // 4. Ofrecer crear regla automática
    const movRef = selectedMov;
    const docRef = selectedDoc;
    const condiciones = extraerCondicionesRegla(movRef, docRef);

    setSelectedMov(null);
    setSelectedDoc(null);
    await load();

    // Solo sugerir si hay condiciones útiles (al menos una de descripción)
    if (condiciones.some(c => c.campo === "descripcion")) {
      setRuleFromMatch({ mov: movRef, doc: docRef });
      setRuleCondiciones(condiciones);
      setRuleName(`Auto: ${docRef.razon_social || docRef.rut || "Match"}`);
      setShowRuleModal(true);
    }
  };

  // Rechazar sugerencia y elegir otro doc — guardar feedback de corrección
  const handleRechazarYCorregir = async (docCorrecto: DocUnificado) => {
    if (!selectedMov || !selectedDoc || !empresa.id) return;

    // Guardar feedback: la sugerencia era incorrecta, el usuario eligió otro
    await insertFeedback({
      empresa_id: empresa.id,
      agente: "conciliador",
      accion_sugerida: {
        tipo: "match_rechazado",
        movimiento_id: selectedMov.id,
        documento_sugerido_id: selectedDoc.id,
        documento_sugerido_tipo: selectedDoc.tipo,
        score_sugerido: selectedDoc.score,
      },
      accion_correcta: {
        tipo: "match_corregido",
        movimiento_id: selectedMov.id,
        documento_correcto_id: docCorrecto.id,
        documento_correcto_tipo: docCorrecto.tipo,
        score_correcto: docCorrecto.score,
      },
      contexto: {
        monto_mov: selectedMov.monto,
        descripcion_mov: selectedMov.descripcion,
        monto_doc_sugerido: selectedDoc.monto_total,
        monto_doc_correcto: docCorrecto.monto_total,
        banco: selectedMov.banco,
      },
    });

    // Ahora seleccionar el doc correcto para confirmar
    setSelectedDoc(docCorrecto);
    showFeedback("Corrección registrada — confirma el match");
  };

  // Ignorar movimiento (marcarlo como ignorado) — con feedback
  const handleIgnorar = async () => {
    if (!selectedMov || !empresa.id) return;
    await updateMovimientoBanco(selectedMov.id!, { estado_conciliacion: "ignorado" } as Partial<DBMovimientoBanco>);

    // Feedback: el usuario decidió ignorar este movimiento
    await insertFeedback({
      empresa_id: empresa.id,
      agente: "conciliador",
      accion_sugerida: null,
      accion_correcta: {
        tipo: "ignorado",
        movimiento_id: selectedMov.id,
      },
      contexto: {
        monto_mov: selectedMov.monto,
        descripcion_mov: selectedMov.descripcion,
        banco: selectedMov.banco,
      },
    });

    setSelectedMov(null);
    showFeedback("Movimiento ignorado");
    load();
  };

  // Guardar regla sugerida
  const handleGuardarRegla = async () => {
    if (!ruleFromMatch || ruleCondiciones.length === 0) return;

    const regla: DBReglaConciliacion = {
      nombre: ruleName || "Regla automática",
      activa: true,
      prioridad: 50,
      condiciones: ruleCondiciones,
      accion_auto: false, // Por defecto requiere confirmación
      confianza_minima: 0.80,
      categoria_cuenta_id: null,
      stats_matches: 0,
    };
    await upsertRegla(regla);

    // Feedback: regla creada desde match
    if (empresa.id) {
      await insertFeedback({
        empresa_id: empresa.id,
        agente: "conciliador",
        accion_sugerida: null,
        accion_correcta: {
          tipo: "regla_creada",
          nombre: ruleName,
          condiciones: ruleCondiciones,
        },
        contexto: {
          desde_match: {
            monto_mov: ruleFromMatch.mov.monto,
            descripcion_mov: ruleFromMatch.mov.descripcion,
            doc_rut: ruleFromMatch.doc.rut,
            doc_razon_social: ruleFromMatch.doc.razon_social,
          },
        },
      });
    }

    setShowRuleModal(false);
    setRuleFromMatch(null);
    showFeedback("Regla creada exitosamente");
  };

  if (loading) return <div style={{ textAlign: "center", padding: 40, color: "var(--txt3)" }}>Cargando datos de conciliación...</div>;

  // Estadísticas
  const pendientes = movBanco.filter(m => !concMovIds.has(m.id!)).length;
  const conciliados = movBanco.filter(m => concMovIds.has(m.id!)).length;
  const docsPendientes = docsSinConciliar.length;

  return (
    <div>
      {/* Mensaje de feedback temporal */}
      {feedbackMsg && (
        <div style={{
          position: "fixed", top: 20, right: 20, zIndex: 9999,
          padding: "10px 20px", borderRadius: 10,
          background: "var(--greenBg)", border: "1px solid var(--greenBd)",
          color: "var(--green)", fontSize: 13, fontWeight: 600,
          animation: "fadeIn 0.3s",
        }}>
          {feedbackMsg}
        </div>
      )}

      {/* Modal crear regla automática */}
      {showRuleModal && ruleFromMatch && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 9998,
          background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center",
        }} onClick={() => setShowRuleModal(false)}>
          <div className="card" style={{ padding: 24, maxWidth: 480, width: "90%" }} onClick={e => e.stopPropagation()}>
            <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Crear regla automática</h3>
            <p style={{ fontSize: 12, color: "var(--txt3)", marginBottom: 16 }}>
              Basado en el match que acabas de confirmar, se puede crear una regla para futuros matches similares.
            </p>

            {/* Nombre de la regla */}
            <div style={{ marginBottom: 12 }}>
              <label className="form-label">Nombre de la regla</label>
              <input className="form-input" value={ruleName} onChange={e => setRuleName(e.target.value)}
                style={{ fontSize: 13 }} placeholder="Ej: Pago proveedor X" />
            </div>

            {/* Condiciones detectadas */}
            <div style={{ marginBottom: 16 }}>
              <label className="form-label">Condiciones detectadas</label>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {ruleCondiciones.map((cond, i) => (
                  <div key={i} style={{
                    padding: "8px 12px", borderRadius: 8, background: "var(--bg3)",
                    display: "flex", alignItems: "center", gap: 8, fontSize: 12,
                  }}>
                    <span style={{ fontWeight: 600, color: "var(--cyan)", minWidth: 80 }}>{cond.campo}</span>
                    <span style={{ color: "var(--txt3)" }}>{cond.operador}</span>
                    <span className="mono" style={{ fontWeight: 600 }}>{String(cond.valor)}</span>
                    <button onClick={() => setRuleCondiciones(ruleCondiciones.filter((_, j) => j !== i))}
                      style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--red)", cursor: "pointer", fontSize: 14 }}>
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* Info del match original */}
            <div style={{ padding: 10, borderRadius: 8, background: "var(--bg)", marginBottom: 16, fontSize: 11, color: "var(--txt3)" }}>
              <div>Movimiento: <span className="mono" style={{ color: "var(--txt)" }}>{fmtMoney(ruleFromMatch.mov.monto)}</span> — {ruleFromMatch.mov.descripcion}</div>
              <div>Documento: {ruleFromMatch.doc.tipo === "compra" ? "Compra" : "Venta"} #{ruleFromMatch.doc.nro} — {ruleFromMatch.doc.razon_social || ruleFromMatch.doc.rut}</div>
            </div>

            {/* Botones */}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setShowRuleModal(false)}
                style={{ padding: "8px 16px", borderRadius: 8, background: "var(--bg3)", color: "var(--txt)", fontSize: 12, border: "1px solid var(--bg4)", cursor: "pointer" }}>
                No, gracias
              </button>
              <button onClick={handleGuardarRegla} disabled={ruleCondiciones.length === 0}
                className="scan-btn green" style={{ padding: "8px 20px", fontSize: 12 }}>
                Crear regla
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Conciliación</h2>
        <div style={{ display: "flex", gap: 12, fontSize: 12, color: "var(--txt3)" }}>
          <span><span className="mono" style={{ fontWeight: 700, color: "var(--amber)" }}>{pendientes}</span> mov. pendientes</span>
          <span><span className="mono" style={{ fontWeight: 700, color: "var(--green)" }}>{conciliados}</span> conciliados</span>
          <span><span className="mono" style={{ fontWeight: 700, color: "var(--cyan)" }}>{docsPendientes}</span> docs sin match</span>
        </div>
      </div>

      {/* Barra de confirmación */}
      {selectedMov && selectedDoc && (
        <div style={{
          padding: 12, background: "var(--cyanBg)", borderRadius: 10,
          border: "1px solid var(--cyanBd)", marginBottom: 12,
          display: "flex", justifyContent: "space-between", alignItems: "center",
        }}>
          <div style={{ fontSize: 12 }}>
            <span style={{ fontWeight: 600 }}>Match:</span>{" "}
            <span className="mono">{fmtMoney(selectedMov.monto)}</span> ↔{" "}
            {selectedDoc.tipo === "compra" ? "Compra" : "Venta"} #{selectedDoc.nro}{" "}
            <span className="mono">{fmtMoney(selectedDoc.monto_total)}</span>{" "}
            <span style={{ color: "var(--cyan)", fontWeight: 600 }}>(Score: {selectedDoc.score}%)</span>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={() => { setSelectedMov(null); setSelectedDoc(null); }}
              style={{ padding: "6px 12px", borderRadius: 8, background: "var(--bg3)", color: "var(--txt)", fontSize: 11, border: "1px solid var(--bg4)", cursor: "pointer" }}>
              Cancelar
            </button>
            <button onClick={handleConfirmar} className="scan-btn green" style={{ padding: "6px 14px", fontSize: 11 }}>
              Confirmar match
            </button>
          </div>
        </div>
      )}

      {/* Split view */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        {/* IZQUIERDA: Movimientos banco */}
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <h3 style={{ fontSize: 14, fontWeight: 700, color: "var(--cyan)", margin: 0 }}>
              Banco ({movFiltrados.length})
            </h3>
            <div style={{ display: "flex", gap: 4 }}>
              {(["pendiente", "conciliado", "todos"] as const).map(f => (
                <button key={f} onClick={() => setMovFilter(f)}
                  style={{
                    padding: "3px 8px", borderRadius: 4, fontSize: 10, fontWeight: 600, cursor: "pointer",
                    background: movFilter === f ? "var(--cyanBg)" : "var(--bg3)",
                    color: movFilter === f ? "var(--cyan)" : "var(--txt3)",
                    border: movFilter === f ? "1px solid var(--cyanBd)" : "1px solid var(--bg4)",
                  }}>
                  {f === "pendiente" ? "Pendientes" : f === "conciliado" ? "Conciliados" : "Todos"}
                </button>
              ))}
            </div>
          </div>

          <div style={{ maxHeight: 600, overflowY: "auto" }}>
            {movFiltrados.length === 0 ? (
              <div style={{ textAlign: "center", padding: 24, color: "var(--txt3)", fontSize: 12 }}>
                {movFilter === "pendiente" ? "Todos conciliados" : "Sin movimientos"}
              </div>
            ) : movFiltrados.map(m => {
              const isSelected = selectedMov?.id === m.id;
              const isConciliado = concMovIds.has(m.id!);
              return (
                <div key={m.id}
                  onClick={() => { if (!isConciliado) { setSelectedMov(m); setSelectedDoc(null); }}}
                  style={{
                    padding: 10, marginBottom: 4, borderRadius: 8, cursor: isConciliado ? "default" : "pointer",
                    border: isSelected ? "2px solid var(--cyan)" : "1px solid var(--bg4)",
                    background: isSelected ? "var(--cyanBg)" : isConciliado ? "var(--bg)" : "var(--bg2)",
                  }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                    <span className="mono" style={{ fontSize: 11 }}>{fmtDate(m.fecha)}</span>
                    <span className="mono" style={{ fontSize: 14, fontWeight: 700, color: m.monto >= 0 ? "var(--green)" : "var(--red)" }}>
                      {fmtMoney(m.monto)}
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: "var(--txt2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {m.descripcion || "—"}
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: 2 }}>
                    <span style={{ fontSize: 9, color: "var(--txt3)", textTransform: "uppercase" }}>{m.banco}</span>
                    {isConciliado && (
                      <span style={{ fontSize: 9, fontWeight: 700, color: "var(--green)", padding: "1px 6px", borderRadius: 3, background: "var(--greenBg)" }}>
                        CONCILIADO
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Botón ignorar movimiento */}
          {selectedMov && !selectedDoc && (
            <button onClick={handleIgnorar}
              style={{ marginTop: 8, width: "100%", padding: "8px 0", borderRadius: 8, background: "var(--bg3)", color: "var(--txt3)", fontSize: 11, fontWeight: 600, border: "1px solid var(--bg4)", cursor: "pointer" }}>
              Ignorar este movimiento
            </button>
          )}
        </div>

        {/* DERECHA: Documentos sugeridos */}
        <div>
          <h3 style={{ fontSize: 14, fontWeight: 700, color: "var(--cyan)", marginBottom: 8 }}>
            {selectedMov ? `Sugerencias (${sugerencias.length})` : "Selecciona un movimiento"}
          </h3>

          {!selectedMov ? (
            <div style={{ textAlign: "center", padding: 40, color: "var(--txt3)" }}>
              <div style={{ fontSize: 32, marginBottom: 8 }}>👈</div>
              <div style={{ fontSize: 13 }}>Selecciona un movimiento del banco para ver documentos sugeridos</div>
            </div>
          ) : sugerencias.length === 0 ? (
            <div style={{ textAlign: "center", padding: 40, color: "var(--txt3)" }}>
              <div style={{ fontSize: 32, marginBottom: 8 }}>🔍</div>
              <div style={{ fontSize: 13, marginBottom: 4 }}>Sin sugerencias de match</div>
              <div style={{ fontSize: 11 }}>No se encontraron documentos RCV que coincidan por monto, fecha o RUT</div>
            </div>
          ) : (
            <div style={{ maxHeight: 600, overflowY: "auto" }}>
              {sugerencias.map(doc => {
                const isSelected = selectedDoc?.id === doc.id;
                // Color del score
                const scoreColor = doc.score >= 60 ? "var(--green)" : doc.score >= 30 ? "var(--amber)" : "var(--txt3)";
                const scoreBg = doc.score >= 60 ? "var(--greenBg)" : doc.score >= 30 ? "var(--amberBg)" : "var(--bg3)";

                return (
                  <div key={doc.id}
                    onClick={() => {
                      // Si ya hay un doc seleccionado y el user elige otro → es corrección
                      if (selectedDoc && selectedDoc.id !== doc.id) {
                        handleRechazarYCorregir(doc);
                      } else {
                        setSelectedDoc(doc);
                      }
                    }}
                    style={{
                      padding: 10, marginBottom: 4, borderRadius: 8, cursor: "pointer",
                      border: isSelected ? "2px solid var(--cyan)" : "1px solid var(--bg4)",
                      background: isSelected ? "var(--cyanBg)" : "var(--bg2)",
                    }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        {/* Badge tipo */}
                        <span style={{
                          fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4,
                          background: doc.tipo === "compra" ? "var(--redBg)" : "var(--greenBg)",
                          color: doc.tipo === "compra" ? "var(--red)" : "var(--green)",
                        }}>
                          {doc.tipo === "compra" ? "COMPRA" : "VENTA"}
                        </span>
                        <span style={{ fontSize: 10, color: "var(--txt3)" }}>{doc.tipo_doc}</span>
                        <span className="mono" style={{ fontSize: 11, fontWeight: 600 }}>#{doc.nro}</span>
                      </div>
                      {/* Score */}
                      <span className="mono" style={{
                        fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 6,
                        background: scoreBg, color: scoreColor,
                      }}>
                        {doc.score}%
                      </span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                      <span style={{ fontSize: 11, color: "var(--txt2)" }}>
                        {doc.razon_social || doc.rut || "—"}
                      </span>
                      <span className="mono" style={{ fontSize: 13, fontWeight: 700 }}>
                        {fmtMoney(doc.monto_total)}
                      </span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span className="mono" style={{ fontSize: 10, color: "var(--txt3)" }}>
                        {fmtDate(doc.fecha)}
                      </span>
                      <span className="mono" style={{ fontSize: 10, color: "var(--txt3)" }}>
                        Neto: {fmtMoney(doc.monto_neto)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Conciliaciones confirmadas */}
      {conciliaciones.filter(c => c.estado === "confirmado").length > 0 && (
        <div style={{ marginTop: 24 }}>
          <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>
            Conciliaciones confirmadas ({conciliaciones.filter(c => c.estado === "confirmado").length})
          </h3>
          <div style={{ overflowX: "auto" }}>
            <table className="tbl" style={{ fontSize: 11 }}>
              <thead>
                <tr><th>Método</th><th>Tipo</th><th>Confianza</th><th>Regla</th><th>Fecha</th></tr>
              </thead>
              <tbody>
                {conciliaciones.filter(c => c.estado === "confirmado").slice(0, 20).map((c, i) => (
                  <tr key={c.id || i}>
                    <td style={{ textTransform: "capitalize" }}>{c.metodo || "—"}</td>
                    <td>{c.rcv_compra_id ? "Compra" : c.rcv_venta_id ? "Venta" : "—"}</td>
                    <td className="mono">{c.confianza !== null ? `${Math.round(c.confianza * 100)}%` : "—"}</td>
                    <td className="mono" style={{ fontSize: 10 }}>{c.regla_id ? c.regla_id.slice(0, 8) : "—"}</td>
                    <td className="mono">{c.created_at ? new Date(c.created_at).toLocaleDateString("es-CL") : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
