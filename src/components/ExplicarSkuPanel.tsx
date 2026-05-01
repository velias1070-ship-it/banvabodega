"use client";

import React, { useEffect, useState } from "react";

interface InputCrudo {
  nombre: string;
  valor: number | string | null;
  tipo: "fuente" | "constante" | "metrica" | "derivado";
  fuente?: string;
  ref?: string;
  formula?: string;
  inputs?: InputCrudo[];
  nota?: string;
}

interface MetricaExplicada {
  valor: number | string | boolean | null;
  unidad?: string;
  formula?: string;
  inputs?: InputCrudo[];
  policy?: string;
  codigo?: string;
  doc?: string;
  verificacion?: {
    calculado: number;
    motor: number;
    match: boolean;
    delta?: number;
  };
  nota?: string;
}

interface ExplainResponse {
  sku_origen: string;
  calculado_at: string;
  verificacion_summary: {
    total_metricas_verificables: number;
    match_ok: number;
    discrepancias: { metrica: string; calculado: number; motor: number; delta: number }[];
  };
  metricas: Record<string, MetricaExplicada>;
}

const fmt = (v: unknown): string => {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (Number.isInteger(v)) return v.toString();
    return v.toFixed(2);
  }
  return String(v);
};

const tipoColor = (t: InputCrudo["tipo"]): string => {
  if (t === "fuente") return "var(--cyan)";
  if (t === "constante") return "var(--amber)";
  if (t === "metrica") return "var(--blue)";
  if (t === "derivado") return "var(--green)";
  return "var(--txt2)";
};

const tipoLabel = (t: InputCrudo["tipo"]): string => {
  if (t === "fuente") return "DB";
  if (t === "constante") return "K";
  if (t === "metrica") return "→";
  if (t === "derivado") return "ƒ";
  return "?";
};

function InputNodo({ inp, onJump, depth = 0 }: { inp: InputCrudo; onJump: (ref: string) => void; depth?: number }) {
  const [expanded, setExpanded] = useState(depth < 2);
  const tieneSubinputs = (inp.inputs?.length || 0) > 0;
  const esRef = inp.tipo === "metrica" && inp.ref;

  return (
    <div style={{ marginLeft: depth * 12, marginTop: 4, fontSize: 11, lineHeight: 1.4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span
          title={`Tipo: ${inp.tipo}`}
          style={{
            display: "inline-block",
            minWidth: 14,
            textAlign: "center",
            color: tipoColor(inp.tipo),
            fontSize: 10,
            fontWeight: 700,
          }}
        >
          {tipoLabel(inp.tipo)}
        </span>
        <span style={{ color: "var(--txt2)" }}>{inp.nombre}</span>
        <span style={{ color: "var(--txt)", fontFamily: "JetBrains Mono, monospace" }}>= {fmt(inp.valor)}</span>
        {esRef && (
          <button
            onClick={() => onJump(inp.ref!)}
            title={`Ver definición de ${inp.ref}`}
            style={{ background: "none", border: "1px solid var(--bg4)", color: "var(--blue)", fontSize: 9, padding: "1px 4px", borderRadius: 3, cursor: "pointer" }}
          >
            ir a def
          </button>
        )}
        {tieneSubinputs && (
          <button
            onClick={() => setExpanded(!expanded)}
            style={{ background: "none", border: "none", color: "var(--txt3)", cursor: "pointer", fontSize: 10 }}
          >
            {expanded ? "▾" : "▸"}
          </button>
        )}
      </div>
      {inp.formula && (
        <div style={{ marginLeft: 20, color: "var(--txt3)", fontFamily: "JetBrains Mono, monospace", fontSize: 10 }}>
          ƒ: {inp.formula}
        </div>
      )}
      {inp.fuente && (
        <div style={{ marginLeft: 20, color: tipoColor("fuente"), fontSize: 10 }}>
          📦 {inp.fuente}
        </div>
      )}
      {inp.nota && (
        <div style={{ marginLeft: 20, color: "var(--amber)", fontSize: 10, fontStyle: "italic" }}>
          ⓘ {inp.nota}
        </div>
      )}
      {expanded && tieneSubinputs && (
        <div style={{ borderLeft: "1px dashed var(--bg4)", marginLeft: 6, marginTop: 2 }}>
          {inp.inputs!.map((sub, i) => (
            <InputNodo key={i} inp={sub} onJump={onJump} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

function MetricaCard({
  nombre,
  m,
  onJump,
  open,
  onToggle,
}: {
  nombre: string;
  m: MetricaExplicada;
  onJump: (ref: string) => void;
  open: boolean;
  onToggle: () => void;
}) {
  const valorColor = m.verificacion ? (m.verificacion.match ? "var(--green)" : "var(--red)") : "var(--txt)";

  return (
    <div id={`metrica-${nombre}`} style={{ background: "var(--bg2)", border: "1px solid var(--bg4)", borderRadius: 8, padding: 10, marginBottom: 8 }}>
      <div onClick={onToggle} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
        <span style={{ color: "var(--txt3)", fontSize: 12 }}>{open ? "▾" : "▸"}</span>
        <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 12, color: "var(--txt)", fontWeight: 700 }}>{nombre}</span>
        <span style={{ marginLeft: "auto", fontFamily: "JetBrains Mono, monospace", fontSize: 13, color: valorColor }}>
          {fmt(m.valor)}
          {m.unidad && <span style={{ color: "var(--txt3)", fontSize: 10, marginLeft: 4 }}>{m.unidad}</span>}
        </span>
        {m.verificacion && (
          <span
            title={m.verificacion.match ? "Reproducción coincide con motor" : `Discrepancia: motor=${m.verificacion.motor} calc=${m.verificacion.calculado}`}
            style={{ fontSize: 12, color: m.verificacion.match ? "var(--green)" : "var(--red)" }}
          >
            {m.verificacion.match ? "✓" : "⚠"}
          </span>
        )}
      </div>

      {open && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px dashed var(--bg4)" }}>
          {m.formula && (
            <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "var(--cyan)", marginBottom: 4 }}>
              ƒ: {m.formula}
            </div>
          )}
          {m.nota && (
            <div style={{ fontSize: 10, color: "var(--amber)", fontStyle: "italic", marginBottom: 4 }}>
              ⓘ {m.nota}
            </div>
          )}
          {m.policy && (
            <div style={{ fontSize: 10, color: "var(--green)", marginBottom: 4 }}>
              🛡 Policy: {m.policy}
            </div>
          )}
          {m.codigo && (
            <div style={{ fontSize: 10, color: "var(--txt3)", marginBottom: 4, fontFamily: "JetBrains Mono, monospace" }}>
              💾 {m.codigo}
            </div>
          )}
          {m.doc && (
            <div style={{ fontSize: 10, color: "var(--blue)", marginBottom: 8 }}>
              📖 {m.doc}
            </div>
          )}
          {m.verificacion && (
            <div style={{ fontSize: 10, color: m.verificacion.match ? "var(--green)" : "var(--red)", marginBottom: 8, padding: "4px 6px", background: m.verificacion.match ? "var(--greenBg)" : "var(--redBg)", borderRadius: 4 }}>
              Verificación: motor={m.verificacion.motor} · calculado={m.verificacion.calculado} ·
              delta={m.verificacion.delta != null ? m.verificacion.delta.toFixed(2) : "0"} → {m.verificacion.match ? "MATCH" : "DISCREPANCIA"}
            </div>
          )}
          {m.inputs && m.inputs.length > 0 && (
            <div>
              <div style={{ fontSize: 10, color: "var(--txt2)", marginBottom: 4 }}>Inputs:</div>
              {m.inputs.map((inp, i) => (
                <InputNodo key={i} inp={inp} onJump={onJump} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function ExplicarSkuPanel({ skuOrigen, onClose, inline = false }: { skuOrigen: string; onClose?: () => void; inline?: boolean }) {
  const [data, setData] = useState<ExplainResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openMap, setOpenMap] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setData(null);
    setError(null);
    fetch(`/api/intelligence/sku/${encodeURIComponent(skuOrigen)}/explain`)
      .then(async (r) => {
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.error || `HTTP ${r.status}`);
        }
        return r.json();
      })
      .then((j) => {
        setData(j);
        // Abrir por default las métricas con discrepancia o las clave
        const open: Record<string, boolean> = {};
        const claves = ["mandar_full", "pedir_proveedor", "accion", "vel_ponderada", "rop_calculado"];
        for (const k of claves) open[k] = true;
        for (const d of j.verificacion_summary?.discrepancias || []) open[d.metrica] = true;
        setOpenMap(open);
      })
      .catch((e) => setError(e.message));
  }, [skuOrigen]);

  const toggle = (n: string) => setOpenMap((m) => ({ ...m, [n]: !m[n] }));

  const jump = (ref: string) => {
    setOpenMap((m) => ({ ...m, [ref]: true }));
    setTimeout(() => {
      const el = document.getElementById(`metrica-${ref}`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 50);
  };

  const wrapperStyle: React.CSSProperties = inline
    ? {
        background: "var(--bg2)",
        border: "1px solid var(--bg4)",
        borderRadius: 8,
        display: "flex",
        flexDirection: "column",
        maxHeight: "calc(100vh - 220px)",
      }
    : {
        position: "fixed",
        top: 0,
        right: 0,
        bottom: 0,
        width: "min(560px, 100vw)",
        background: "var(--bg)",
        borderLeft: "2px solid var(--bg4)",
        zIndex: 9999,
        display: "flex",
        flexDirection: "column",
        boxShadow: "-4px 0 20px rgba(0,0,0,0.5)",
      };

  return (
    <div style={wrapperStyle}>
      <div style={{ padding: 14, borderBottom: "1px solid var(--bg4)", display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, color: "var(--txt3)" }}>Explicación de cálculos</div>
          <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 14, color: "var(--txt)", fontWeight: 700 }}>{skuOrigen}</div>
          {data && (
            <div style={{ fontSize: 10, color: "var(--txt3)", marginTop: 2 }}>
              calc {new Date(data.calculado_at).toLocaleString("es-CL")} ·
              {" "}<span style={{ color: data.verificacion_summary.match_ok === data.verificacion_summary.total_metricas_verificables ? "var(--green)" : "var(--amber)" }}>
                {data.verificacion_summary.match_ok}/{data.verificacion_summary.total_metricas_verificables} verificadas OK
              </span>
            </div>
          )}
        </div>
        {onClose && (
          <button
            onClick={onClose}
            style={{ background: "var(--bg3)", border: "1px solid var(--bg4)", color: "var(--txt)", padding: "6px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12 }}
          >
            Cerrar ✕
          </button>
        )}
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: 12 }}>
        {error && (
          <div style={{ padding: 12, background: "var(--redBg)", color: "var(--red)", border: "1px solid var(--redBd)", borderRadius: 6 }}>
            Error: {error}
          </div>
        )}
        {!data && !error && (
          <div style={{ color: "var(--txt2)", fontSize: 12 }}>Cargando…</div>
        )}
        {data && (
          <>
            {data.verificacion_summary.discrepancias.length > 0 && (
              <div style={{ marginBottom: 10, padding: 10, background: "var(--amberBg)", border: "1px solid var(--amberBd)", borderRadius: 6 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "var(--amber)", marginBottom: 4 }}>
                  ⚠ {data.verificacion_summary.discrepancias.length} discrepancia(s) entre fórmula y motor
                </div>
                {data.verificacion_summary.discrepancias.map((d) => (
                  <div key={d.metrica} style={{ fontSize: 10, color: "var(--amber)" }}>
                    • <button onClick={() => jump(d.metrica)} style={{ background: "none", border: "none", color: "var(--blue)", cursor: "pointer", padding: 0, fontSize: 10, textDecoration: "underline" }}>{d.metrica}</button>: motor={d.motor} calc={d.calculado} (Δ {d.delta.toFixed(2)})
                  </div>
                ))}
              </div>
            )}

            <div style={{ fontSize: 10, color: "var(--txt3)", marginBottom: 8, padding: 6, background: "var(--bg2)", borderRadius: 4 }}>
              <span style={{ color: tipoColor("fuente") }}>DB</span> = lee de tabla ·
              {" "}<span style={{ color: tipoColor("constante") }}>K</span> = constante ·
              {" "}<span style={{ color: tipoColor("metrica") }}>→</span> = referencia a otra métrica ·
              {" "}<span style={{ color: tipoColor("derivado") }}>ƒ</span> = derivado in-line
            </div>

            {Object.entries(data.metricas).map(([nombre, m]) => (
              <MetricaCard
                key={nombre}
                nombre={nombre}
                m={m}
                onJump={jump}
                open={!!openMap[nombre]}
                onToggle={() => toggle(nombre)}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}
