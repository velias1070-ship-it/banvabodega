"use client";
import { useState, useEffect, useCallback, useRef } from "react";

// ============================================
// Tipos
// ============================================

interface AgentConfig {
  id: string;
  nombre_display: string;
  descripcion: string | null;
  model: string;
  activo: boolean;
  last_run_at: string | null;
  last_run_tokens: number | null;
  last_run_cost_usd: number | null;
}

interface AgentInsight {
  id: string;
  agente: string;
  estado: string;
  severidad: string;
  tipo: string;
  titulo: string;
  contenido: string | null;
  datos: Record<string, unknown> | null;
  skus_relacionados: string[] | null;
  feedback_texto: string | null;
  feedback_at: string | null;
  created_at: string;
}

interface AgentRule {
  id: string;
  agente: string;
  regla: string;
  contexto: string | null;
  origen: string;
  prioridad: number;
  veces_aplicada: number;
  activa: boolean;
}

interface AgentRun {
  id: string;
  agente: string;
  trigger: string;
  estado: string;
  tokens_input: number | null;
  tokens_output: number | null;
  costo_usd: number | null;
  duracion_ms: number | null;
  insights_generados: number | null;
  error_mensaje: string | null;
  created_at: string;
}

interface ChatMessage {
  role: "user" | "assistant";
  contenido: string;
  created_at?: string;
}

// ============================================
// Helpers
// ============================================

const AGENT_COLORS: Record<string, string> = {
  reposicion: "var(--cyan)",
  inventario: "var(--amber)",
  rentabilidad: "var(--green)",
  recepcion: "var(--blue)",
  orquestador: "var(--txt2)",
};

const AGENT_ICONS: Record<string, string> = {
  reposicion: "🔄",
  inventario: "📦",
  rentabilidad: "💰",
  recepcion: "📋",
  orquestador: "🤖",
};

const SEV_COLORS: Record<string, string> = {
  critica: "var(--red)",
  alta: "var(--amber)",
  media: "var(--blue)",
  info: "var(--txt3)",
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "ahora";
  if (mins < 60) return `hace ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `hace ${hours}h`;
  const days = Math.floor(hours / 24);
  return `hace ${days}d`;
}

function fmtCost(usd: number | null): string {
  if (!usd) return "$0.00";
  return `$${usd.toFixed(4)}`;
}

// ============================================
// Componente Principal
// ============================================

export default function AdminAgentes() {
  const [section, setSection] = useState<"insights" | "chat" | "rules" | "history">("insights");
  const [configs, setConfigs] = useState<AgentConfig[]>([]);
  const [insights, setInsights] = useState<AgentInsight[]>([]);
  const [rules, setRules] = useState<AgentRule[]>([]);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [runningAgent, setRunningAgent] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Filtros
  const [filtroAgente, setFiltroAgente] = useState<string>("todos");
  const [filtroSeveridad, setFiltroSeveridad] = useState<string>("todos");
  const [filtroEstado, setFiltroEstado] = useState<string>("pendientes");

  const loadData = useCallback(async () => {
    try {
      setLoadError(null);
      const res = await fetch("/api/agents/status");
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        setLoadError(errData.error || `Error cargando datos (HTTP ${res.status})`);
        return;
      }
      const data = await res.json();
      setConfigs(data.configs || []);
      setInsights(data.insights || []);
      setRules(data.rules || []);
      setRuns(data.runs || []);
    } catch (e) {
      console.error("Error cargando datos de agentes:", e);
      setLoadError(`Error de conexión: ${e}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // Resultado último run
  const [lastRunResult, setLastRunResult] = useState<{ agente: string; resumen: string | null; insights_generados: number; insights_guardados: number; costo_usd: number; error?: string; insert_error?: string } | null>(null);

  // Ejecutar agente
  const ejecutarAgente = async (agente: string) => {
    setRunningAgent(agente);
    setLastRunResult(null);
    try {
      const res = await fetch("/api/agents/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agente, trigger: "manual" }),
      });
      const data = await res.json();
      if (data.error) {
        setLastRunResult({ agente, resumen: null, insights_generados: 0, insights_guardados: 0, costo_usd: 0, error: data.error });
      } else if (data.cached) {
        setLastRunResult({ agente, resumen: data.message, insights_generados: 0, insights_guardados: 0, costo_usd: 0 });
      } else {
        setLastRunResult({
          agente,
          resumen: data.resumen || null,
          insights_generados: data.insights_generados,
          insights_guardados: data.insights_guardados ?? data.insights_generados,
          costo_usd: data.costo_usd,
          insert_error: data.insert_error || undefined,
        });
        // Si se generaron insights, mostrar la pestaña de insights
        if (data.insights_generados > 0) {
          setSection("insights");
          setFiltroAgente(agente);
          setFiltroEstado("pendientes");
        }
      }
      await loadData();
    } catch (e) {
      setLastRunResult({ agente, resumen: null, insights_generados: 0, insights_guardados: 0, costo_usd: 0, error: String(e) });
    } finally {
      setRunningAgent(null);
    }
  };

  if (loading) return <div style={{ padding: 24, color: "var(--txt3)" }}>Cargando agentes...</div>;

  const agentesActivos = configs.filter(c => c.id !== "orquestador");

  // Filtrar insights
  let insightsFiltrados = [...insights];
  if (filtroAgente !== "todos") insightsFiltrados = insightsFiltrados.filter(i => i.agente === filtroAgente);
  if (filtroSeveridad !== "todos") insightsFiltrados = insightsFiltrados.filter(i => i.severidad === filtroSeveridad);
  if (filtroEstado === "pendientes") insightsFiltrados = insightsFiltrados.filter(i => i.estado === "nuevo" || i.estado === "visto");
  else if (filtroEstado !== "todos") insightsFiltrados = insightsFiltrados.filter(i => i.estado === filtroEstado);

  // Ordenar por severidad
  const sevOrden: Record<string, number> = { critica: 0, alta: 1, media: 2, info: 3 };
  insightsFiltrados.sort((a, b) => (sevOrden[a.severidad] ?? 9) - (sevOrden[b.severidad] ?? 9));

  const insightsPendientes = insights.filter(i => i.estado === "nuevo" || i.estado === "visto").length;

  return (
    <div>
      {/* Error de carga */}
      {loadError && (
        <div className="card" style={{ padding: 16, marginBottom: 16, border: "1px solid var(--redBd)", background: "var(--redBg)" }}>
          <div style={{ color: "var(--red)", fontWeight: 700, fontSize: 14 }}>
            Error cargando datos de agentes: {loadError}
          </div>
          <div style={{ fontSize: 12, color: "var(--txt3)", marginTop: 4 }}>
            Verifica que las tablas de agentes existan en Supabase (ejecuta supabase-v11-agents.sql)
          </div>
        </div>
      )}

      {/* Dashboard de agentes */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12, marginBottom: 24 }}>
        {agentesActivos.map(ag => {
          const pendientes = insights.filter(i => i.agente === ag.id && (i.estado === "nuevo" || i.estado === "visto")).length;
          const lastRun = runs.find(r => r.agente === ag.id);
          const hasError = lastRun?.estado === "error";
          const isRunning = runningAgent === ag.id;

          return (
            <div key={ag.id} className="card" style={{ padding: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 20 }}>{AGENT_ICONS[ag.id] || "🤖"}</span>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>{ag.nombre_display}</div>
                  <div style={{ fontSize: 11, color: "var(--txt3)" }}>
                    {ag.last_run_at ? timeAgo(ag.last_run_at) : "Sin ejecutar"}
                  </div>
                </div>
                <div style={{ marginLeft: "auto" }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: hasError ? "var(--red)" : ag.last_run_at ? "var(--green)" : "var(--txt3)" }} />
                </div>
              </div>

              {pendientes > 0 && (
                <div style={{ fontSize: 12, color: "var(--amber)", fontWeight: 600, marginBottom: 8 }}>
                  {pendientes} insight{pendientes > 1 ? "s" : ""} pendiente{pendientes > 1 ? "s" : ""}
                </div>
              )}

              <button
                onClick={() => ejecutarAgente(ag.id)}
                disabled={isRunning}
                style={{
                  width: "100%", padding: "8px 0", borderRadius: 8,
                  background: isRunning ? "var(--bg3)" : "var(--bg4)",
                  color: isRunning ? "var(--txt3)" : "var(--txt)",
                  fontSize: 12, fontWeight: 600, border: "1px solid var(--bg4)",
                  cursor: isRunning ? "wait" : "pointer",
                }}
              >
                {isRunning ? "Ejecutando..." : "Ejecutar ahora"}
              </button>
            </div>
          );
        })}
      </div>

      {/* Resultado del último run */}
      {lastRunResult && (
        <div className="card" style={{
          padding: 16, marginBottom: 16,
          border: lastRunResult.error ? "1px solid var(--redBd)" : "1px solid var(--greenBd)",
          background: lastRunResult.error ? "var(--redBg)" : "var(--greenBg)",
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              {lastRunResult.error ? (
                <div style={{ color: "var(--red)", fontWeight: 700, fontSize: 14 }}>
                  Error ejecutando {lastRunResult.agente}: {lastRunResult.error}
                </div>
              ) : (
                <>
                  <div style={{ color: "var(--green)", fontWeight: 700, fontSize: 14 }}>
                    {AGENT_ICONS[lastRunResult.agente]} {lastRunResult.agente}: {lastRunResult.insights_generados} insights generados ({fmtCost(lastRunResult.costo_usd)} USD)
                  </div>
                  {lastRunResult.insights_generados > 0 && lastRunResult.insights_guardados < lastRunResult.insights_generados && (
                    <div style={{ color: "var(--red)", fontSize: 12, marginTop: 4, fontWeight: 600 }}>
                      Error: solo {lastRunResult.insights_guardados} de {lastRunResult.insights_generados} insights se guardaron en la DB
                      {lastRunResult.insert_error && (
                        <div style={{ color: "var(--amber)", fontWeight: 400, marginTop: 2 }}>
                          Detalle: {lastRunResult.insert_error}
                        </div>
                      )}
                    </div>
                  )}
                  {lastRunResult.resumen && (
                    <div style={{ color: "var(--txt2)", fontSize: 13, marginTop: 6, lineHeight: 1.5 }}>
                      {lastRunResult.resumen}
                    </div>
                  )}
                </>
              )}
            </div>
            <button onClick={() => setLastRunResult(null)} style={{ background: "none", border: "none", color: "var(--txt3)", fontSize: 16, cursor: "pointer", padding: 4 }}>✕</button>
          </div>
        </div>
      )}

      {/* Tabs de sección */}
      <div className="tabs" style={{ marginBottom: 16 }}>
        {([
          ["insights", `Insights${insightsPendientes > 0 ? ` (${insightsPendientes})` : ""}`],
          ["chat", "Chat Orquestador"],
          ["rules", "Reglas Aprendidas"],
          ["history", "Historial"],
        ] as const).map(([key, label]) => (
          <button key={key} className={`tab ${section === key ? "active-cyan" : ""}`} onClick={() => setSection(key as typeof section)}>{label}</button>
        ))}
      </div>

      {/* Contenido */}
      {section === "insights" && <InsightsPanel insights={insightsFiltrados} filtroAgente={filtroAgente} filtroSeveridad={filtroSeveridad} filtroEstado={filtroEstado}
        setFiltroAgente={setFiltroAgente} setFiltroSeveridad={setFiltroSeveridad} setFiltroEstado={setFiltroEstado}
        agentes={configs} onRefresh={loadData} onUpdateInsight={(id, estado) => {
          setInsights(prev => prev.map(i => i.id === id ? { ...i, estado } : i));
        }} />}
      {section === "chat" && <ChatPanel />}
      {section === "rules" && <RulesPanel rules={rules} agentes={configs} onRefresh={loadData} />}
      {section === "history" && <HistoryPanel runs={runs} />}
    </div>
  );
}

// ============================================
// Insights Panel
// ============================================

function InsightsPanel({ insights, filtroAgente, filtroSeveridad, filtroEstado, setFiltroAgente, setFiltroSeveridad, setFiltroEstado, agentes, onRefresh, onUpdateInsight }: {
  insights: AgentInsight[];
  filtroAgente: string; filtroSeveridad: string; filtroEstado: string;
  setFiltroAgente: (v: string) => void; setFiltroSeveridad: (v: string) => void; setFiltroEstado: (v: string) => void;
  agentes: AgentConfig[];
  onRefresh: () => void;
  onUpdateInsight: (id: string, estado: string) => void;
}) {
  const [feedbackId, setFeedbackId] = useState<string | null>(null);
  const [feedbackTexto, setFeedbackTexto] = useState("");
  const [procesando, setProcesando] = useState(false);

  const enviarFeedback = async (insightId: string, estado: "aceptado" | "rechazado" | "corregido", texto?: string) => {
    setProcesando(true);
    try {
      const res = await fetch("/api/agents/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ insight_id: insightId, estado, feedback_texto: texto }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(`Error al actualizar insight: ${data.error || res.statusText}`);
        return;
      }
      if (data.regla_generada) {
        alert(`Regla generada: "${data.regla_generada}"`);
      }
      // Actualización optimista: remover de pendientes inmediatamente
      onUpdateInsight(insightId, estado);
      setFeedbackId(null);
      setFeedbackTexto("");
      onRefresh();
    } catch (e) {
      alert(`Error: ${e}`);
    } finally {
      setProcesando(false);
    }
  };

  return (
    <div>
      {/* Filtros */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        <select className="form-input" style={{ width: "auto", fontSize: 12 }} value={filtroAgente} onChange={e => setFiltroAgente(e.target.value)}>
          <option value="todos">Todos los agentes</option>
          {agentes.filter(a => a.id !== "orquestador").map(a => (
            <option key={a.id} value={a.id}>{a.nombre_display}</option>
          ))}
        </select>
        <select className="form-input" style={{ width: "auto", fontSize: 12 }} value={filtroSeveridad} onChange={e => setFiltroSeveridad(e.target.value)}>
          <option value="todos">Todas las severidades</option>
          <option value="critica">Crítica</option>
          <option value="alta">Alta</option>
          <option value="media">Media</option>
          <option value="info">Info</option>
        </select>
        <select className="form-input" style={{ width: "auto", fontSize: 12 }} value={filtroEstado} onChange={e => setFiltroEstado(e.target.value)}>
          <option value="pendientes">Pendientes</option>
          <option value="aceptado">Aceptados</option>
          <option value="rechazado">Rechazados</option>
          <option value="corregido">Corregidos</option>
          <option value="todos">Todos</option>
        </select>
      </div>

      {insights.length === 0 && (
        <div style={{ padding: 32, textAlign: "center", color: "var(--txt3)" }}>
          No hay insights con los filtros seleccionados.
          <br /><span style={{ fontSize: 12 }}>Ejecuta un agente para generar insights.</span>
        </div>
      )}

      {insights.map(ins => (
        <div key={ins.id} className="card" style={{ padding: 16, marginBottom: 8 }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
            {/* Icono agente */}
            <span style={{ fontSize: 18, marginTop: 2 }}>{AGENT_ICONS[ins.agente] || "🤖"}</span>

            <div style={{ flex: 1 }}>
              {/* Header */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: AGENT_COLORS[ins.agente], textTransform: "uppercase" }}>
                  {ins.agente}
                </span>
                <span style={{
                  fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 4,
                  background: `${SEV_COLORS[ins.severidad]}20`, color: SEV_COLORS[ins.severidad],
                }}>
                  {ins.severidad}
                </span>
                <span style={{ fontSize: 10, color: "var(--txt3)", marginLeft: "auto" }}>
                  {timeAgo(ins.created_at)}
                </span>
              </div>

              {/* Título */}
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>{ins.titulo}</div>

              {/* Contenido */}
              {ins.contenido && (
                <div style={{ fontSize: 13, color: "var(--txt2)", lineHeight: 1.5, marginBottom: 8, whiteSpace: "pre-wrap" }}>
                  {ins.contenido}
                </div>
              )}

              {/* SKUs */}
              {ins.skus_relacionados && ins.skus_relacionados.length > 0 && (
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 8 }}>
                  {ins.skus_relacionados.map(sku => (
                    <span key={sku} className="mono" style={{
                      fontSize: 11, padding: "2px 6px", borderRadius: 4,
                      background: "var(--bg3)", border: "1px solid var(--bg4)",
                    }}>
                      {sku}
                    </span>
                  ))}
                </div>
              )}

              {/* Feedback (si ya tiene) */}
              {ins.feedback_texto && (
                <div style={{ fontSize: 12, color: "var(--txt3)", fontStyle: "italic", marginBottom: 8, padding: 8, background: "var(--bg3)", borderRadius: 6 }}>
                  Feedback: {ins.feedback_texto}
                </div>
              )}

              {/* Botones de acción */}
              {(ins.estado === "nuevo" || ins.estado === "visto") && (
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => enviarFeedback(ins.id, "aceptado")} disabled={procesando}
                    style={{ padding: "4px 12px", borderRadius: 6, background: "var(--greenBg)", border: "1px solid var(--greenBd)", color: "var(--green)", fontSize: 12, fontWeight: 600 }}>
                    ✅ Aceptar
                  </button>
                  <button onClick={() => enviarFeedback(ins.id, "rechazado")} disabled={procesando}
                    style={{ padding: "4px 12px", borderRadius: 6, background: "var(--redBg)", border: "1px solid var(--redBd)", color: "var(--red)", fontSize: 12, fontWeight: 600 }}>
                    ❌ Rechazar
                  </button>
                  <button onClick={() => setFeedbackId(feedbackId === ins.id ? null : ins.id)} disabled={procesando}
                    style={{ padding: "4px 12px", borderRadius: 6, background: "var(--amberBg)", border: "1px solid var(--amberBd)", color: "var(--amber)", fontSize: 12, fontWeight: 600 }}>
                    ✏️ Corregir
                  </button>
                </div>
              )}

              {/* Textarea de corrección */}
              {feedbackId === ins.id && (
                <div style={{ marginTop: 8 }}>
                  <textarea
                    className="form-input"
                    value={feedbackTexto}
                    onChange={e => setFeedbackTexto(e.target.value)}
                    placeholder="Escribe tu corrección o contexto adicional..."
                    style={{ width: "100%", minHeight: 60, fontSize: 13 }}
                  />
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <button
                      onClick={() => enviarFeedback(ins.id, "corregido", feedbackTexto)}
                      disabled={!feedbackTexto.trim() || procesando}
                      style={{ padding: "6px 16px", borderRadius: 6, background: "var(--cyan)", color: "#000", fontSize: 12, fontWeight: 700 }}
                    >
                      Guardar corrección
                    </button>
                    <button onClick={() => { setFeedbackId(null); setFeedbackTexto(""); }}
                      style={{ padding: "6px 16px", borderRadius: 6, background: "var(--bg3)", color: "var(--txt3)", fontSize: 12 }}>
                      Cancelar
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ============================================
// Chat Panel
// ============================================

function ChatPanel() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [sessionId] = useState(() => crypto.randomUUID());
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const enviar = async () => {
    if (!input.trim() || loading) return;
    const msg = input.trim();
    setInput("");
    setMessages(prev => [...prev, { role: "user", contenido: msg }]);
    setLoading(true);

    try {
      const res = await fetch("/api/agents/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, mensaje: msg }),
      });
      const data = await res.json();
      if (data.error) {
        setMessages(prev => [...prev, { role: "assistant", contenido: `Error: ${data.error}` }]);
      } else {
        setMessages(prev => [...prev, { role: "assistant", contenido: data.respuesta }]);
      }
    } catch (e) {
      setMessages(prev => [...prev, { role: "assistant", contenido: `Error de conexión: ${e}` }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 320px)", minHeight: 400 }}>
      {/* Mensajes */}
      <div style={{ flex: 1, overflowY: "auto", padding: 12, background: "var(--bg)", borderRadius: 10, border: "1px solid var(--bg4)", marginBottom: 12 }}>
        {messages.length === 0 && (
          <div style={{ padding: 32, textAlign: "center", color: "var(--txt3)" }}>
            <span style={{ fontSize: 24 }}>🤖</span>
            <div style={{ fontSize: 14, marginTop: 8 }}>Hola, soy el orquestador de BANVA.</div>
            <div style={{ fontSize: 12, marginTop: 4 }}>Pregúntame sobre stock, reposición, rentabilidad o recepciones.</div>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} style={{
            display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start",
            marginBottom: 8,
          }}>
            <div style={{
              maxWidth: "80%", padding: "10px 14px", borderRadius: 12,
              background: m.role === "user" ? "var(--cyan)" : "var(--bg3)",
              color: m.role === "user" ? "#000" : "var(--txt)",
              fontSize: 13, lineHeight: 1.5, whiteSpace: "pre-wrap",
            }}>
              {m.contenido}
            </div>
          </div>
        ))}

        {loading && (
          <div style={{ display: "flex", justifyContent: "flex-start", marginBottom: 8 }}>
            <div style={{ padding: "10px 14px", borderRadius: 12, background: "var(--bg3)", color: "var(--txt3)", fontSize: 13 }}>
              Pensando...
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div style={{ display: "flex", gap: 8 }}>
        <input
          className="form-input"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === "Enter" && !e.shiftKey && enviar()}
          placeholder="Escribe tu pregunta..."
          style={{ flex: 1, fontSize: 14 }}
          disabled={loading}
        />
        <button
          onClick={enviar}
          disabled={!input.trim() || loading}
          style={{
            padding: "10px 20px", borderRadius: 10,
            background: input.trim() ? "var(--cyan)" : "var(--bg3)",
            color: input.trim() ? "#000" : "var(--txt3)",
            fontWeight: 700, fontSize: 14,
          }}
        >
          Enviar
        </button>
      </div>
    </div>
  );
}

// ============================================
// Rules Panel
// ============================================

function RulesPanel({ rules, agentes, onRefresh }: { rules: AgentRule[]; agentes: AgentConfig[]; onRefresh: () => void }) {
  const [editId, setEditId] = useState<string | null>(null);
  const [editTexto, setEditTexto] = useState("");
  const [newRule, setNewRule] = useState(false);
  const [newAgente, setNewAgente] = useState("reposicion");
  const [newRegla, setNewRegla] = useState("");
  const [newPrioridad, setNewPrioridad] = useState(5);

  const toggleActiva = async (rule: AgentRule) => {
    await fetch("/api/agents/rules", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: rule.id, activa: !rule.activa }),
    });
    onRefresh();
  };

  const guardarEdicion = async (id: string) => {
    await fetch("/api/agents/rules", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, regla: editTexto }),
    });
    setEditId(null);
    onRefresh();
  };

  const eliminar = async (id: string) => {
    if (!confirm("¿Eliminar esta regla?")) return;
    await fetch(`/api/agents/rules?id=${id}`, { method: "DELETE" });
    onRefresh();
  };

  const crearRegla = async () => {
    if (!newRegla.trim()) return;
    await fetch("/api/agents/rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agente: newAgente, regla: newRegla, prioridad: newPrioridad }),
    });
    setNewRule(false);
    setNewRegla("");
    onRefresh();
  };

  // Agrupar por agente
  const rulesByAgent: Record<string, AgentRule[]> = {};
  for (const r of rules) {
    if (!rulesByAgent[r.agente]) rulesByAgent[r.agente] = [];
    rulesByAgent[r.agente].push(r);
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>Reglas aprendidas ({rules.length})</div>
        <button onClick={() => setNewRule(!newRule)}
          style={{ padding: "6px 14px", borderRadius: 6, background: "var(--cyan)", color: "#000", fontSize: 12, fontWeight: 700 }}>
          + Nueva regla
        </button>
      </div>

      {newRule && (
        <div className="card" style={{ padding: 16, marginBottom: 16 }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <select className="form-input" style={{ width: "auto", fontSize: 12 }} value={newAgente} onChange={e => setNewAgente(e.target.value)}>
              {agentes.filter(a => a.id !== "orquestador").map(a => (
                <option key={a.id} value={a.id}>{a.nombre_display}</option>
              ))}
            </select>
            <select className="form-input" style={{ width: 80, fontSize: 12 }} value={newPrioridad} onChange={e => setNewPrioridad(Number(e.target.value))}>
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => <option key={n} value={n}>P{n}</option>)}
            </select>
          </div>
          <textarea className="form-input" value={newRegla} onChange={e => setNewRegla(e.target.value)}
            placeholder="Escribe la regla en lenguaje natural..." style={{ width: "100%", minHeight: 60, fontSize: 13, marginBottom: 8 }} />
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={crearRegla} disabled={!newRegla.trim()}
              style={{ padding: "6px 16px", borderRadius: 6, background: "var(--cyan)", color: "#000", fontSize: 12, fontWeight: 700 }}>Guardar</button>
            <button onClick={() => { setNewRule(false); setNewRegla(""); }}
              style={{ padding: "6px 16px", borderRadius: 6, background: "var(--bg3)", color: "var(--txt3)", fontSize: 12 }}>Cancelar</button>
          </div>
        </div>
      )}

      {Object.entries(rulesByAgent).map(([agente, agRules]) => (
        <div key={agente} style={{ marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
            <span>{AGENT_ICONS[agente] || "🤖"}</span>
            <span style={{ fontWeight: 700, fontSize: 13, color: AGENT_COLORS[agente] }}>{agente.charAt(0).toUpperCase() + agente.slice(1)}</span>
            <span style={{ fontSize: 11, color: "var(--txt3)" }}>({agRules.length} reglas)</span>
          </div>

          {agRules.map(rule => (
            <div key={rule.id} className="card" style={{ padding: 12, marginBottom: 6, opacity: rule.activa ? 1 : 0.5 }}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                {/* Toggle */}
                <button onClick={() => toggleActiva(rule)}
                  style={{ marginTop: 2, fontSize: 16, background: "none", border: "none", cursor: "pointer", padding: 0 }}>
                  {rule.activa ? "🟢" : "⚪"}
                </button>

                <div style={{ flex: 1 }}>
                  {editId === rule.id ? (
                    <div>
                      <textarea className="form-input" value={editTexto} onChange={e => setEditTexto(e.target.value)}
                        style={{ width: "100%", minHeight: 40, fontSize: 13, marginBottom: 6 }} />
                      <div style={{ display: "flex", gap: 6 }}>
                        <button onClick={() => guardarEdicion(rule.id)}
                          style={{ padding: "4px 10px", borderRadius: 4, background: "var(--cyan)", color: "#000", fontSize: 11, fontWeight: 700 }}>Guardar</button>
                        <button onClick={() => setEditId(null)}
                          style={{ padding: "4px 10px", borderRadius: 4, background: "var(--bg3)", color: "var(--txt3)", fontSize: 11 }}>Cancelar</button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ fontSize: 13, color: "var(--txt)" }}>{rule.regla}</div>
                  )}

                  {rule.contexto && <div style={{ fontSize: 11, color: "var(--txt3)", marginTop: 4 }}>{rule.contexto}</div>}

                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, fontSize: 11, color: "var(--txt3)" }}>
                    <span>P{rule.prioridad}</span>
                    <span>·</span>
                    <span>{rule.origen}</span>
                    <span>·</span>
                    <span>Aplicada {rule.veces_aplicada}x</span>
                  </div>
                </div>

                {/* Acciones */}
                <div style={{ display: "flex", gap: 4 }}>
                  <button onClick={() => { setEditId(rule.id); setEditTexto(rule.regla); }}
                    style={{ padding: "4px 8px", borderRadius: 4, background: "var(--bg3)", color: "var(--txt2)", fontSize: 11, border: "1px solid var(--bg4)" }}>✏️</button>
                  <button onClick={() => eliminar(rule.id)}
                    style={{ padding: "4px 8px", borderRadius: 4, background: "var(--redBg)", color: "var(--red)", fontSize: 11, border: "1px solid var(--redBd)" }}>🗑️</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      ))}

      {rules.length === 0 && (
        <div style={{ padding: 32, textAlign: "center", color: "var(--txt3)" }}>
          No hay reglas aprendidas aún.
          <br /><span style={{ fontSize: 12 }}>Las reglas se generan automáticamente al corregir insights, o puedes crearlas manualmente.</span>
        </div>
      )}
    </div>
  );
}

// ============================================
// History Panel
// ============================================

function HistoryPanel({ runs }: { runs: AgentRun[] }) {
  // Calcular totales
  const costoTotal = runs.reduce((sum, r) => sum + (r.costo_usd || 0), 0);
  const tokensTotal = runs.reduce((sum, r) => sum + (r.tokens_input || 0) + (r.tokens_output || 0), 0);

  return (
    <div>
      {/* KPIs */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12, marginBottom: 16 }}>
        <div className="card" style={{ padding: 12, textAlign: "center" }}>
          <div style={{ fontSize: 20, fontWeight: 700 }}>{runs.length}</div>
          <div style={{ fontSize: 11, color: "var(--txt3)" }}>Ejecuciones (7d)</div>
        </div>
        <div className="card" style={{ padding: 12, textAlign: "center" }}>
          <div className="mono" style={{ fontSize: 20, fontWeight: 700 }}>{fmtCost(costoTotal)}</div>
          <div style={{ fontSize: 11, color: "var(--txt3)" }}>Costo total USD</div>
        </div>
        <div className="card" style={{ padding: 12, textAlign: "center" }}>
          <div className="mono" style={{ fontSize: 20, fontWeight: 700 }}>{(tokensTotal / 1000).toFixed(0)}k</div>
          <div style={{ fontSize: 11, color: "var(--txt3)" }}>Tokens usados</div>
        </div>
        <div className="card" style={{ padding: 12, textAlign: "center" }}>
          <div style={{ fontSize: 20, fontWeight: 700 }}>{runs.filter(r => r.estado === "error").length}</div>
          <div style={{ fontSize: 11, color: "var(--txt3)" }}>Errores</div>
        </div>
      </div>

      {/* Tabla */}
      <div style={{ overflowX: "auto" }}>
        <table className="tbl" style={{ width: "100%" }}>
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Agente</th>
              <th>Trigger</th>
              <th>Estado</th>
              <th>Duración</th>
              <th>Tokens</th>
              <th>Costo</th>
              <th>Insights</th>
            </tr>
          </thead>
          <tbody>
            {runs.map(run => (
              <tr key={run.id}>
                <td style={{ fontSize: 11 }}>{new Date(run.created_at).toLocaleString("es-CL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</td>
                <td>
                  <span style={{ color: AGENT_COLORS[run.agente] }}>
                    {AGENT_ICONS[run.agente]} {run.agente}
                  </span>
                </td>
                <td style={{ fontSize: 11 }}>{run.trigger}</td>
                <td>
                  <span style={{
                    fontSize: 11, fontWeight: 600,
                    color: run.estado === "completado" ? "var(--green)" : run.estado === "error" ? "var(--red)" : "var(--amber)",
                  }}>
                    {run.estado}
                  </span>
                </td>
                <td className="mono" style={{ fontSize: 11 }}>
                  {run.duracion_ms ? `${(run.duracion_ms / 1000).toFixed(1)}s` : "-"}
                </td>
                <td className="mono" style={{ fontSize: 11 }}>
                  {run.tokens_input || run.tokens_output
                    ? `${((run.tokens_input || 0) + (run.tokens_output || 0)) / 1000}k`
                    : "-"}
                </td>
                <td className="mono" style={{ fontSize: 11 }}>{fmtCost(run.costo_usd)}</td>
                <td style={{ textAlign: "center" }}>{run.insights_generados ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {runs.length === 0 && (
        <div style={{ padding: 32, textAlign: "center", color: "var(--txt3)" }}>
          No hay ejecuciones registradas.
        </div>
      )}
    </div>
  );
}
