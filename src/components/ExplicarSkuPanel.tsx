"use client";

import React, { useEffect, useMemo, useState } from "react";

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

interface SkuVentaVinc {
  sku_venta: string;
  unidades: number;
  tipo_relacion: string;
  stock_full_uds_venta: number;
  stock_full_uds_origen: number;
}

interface AlternativoVinc {
  sku_origen: string;
  nombre: string | null;
  stock_bodega: number;
  stock_total: number;
  pedir_proveedor: number;
  via: "explicito" | "auto_detectado";
}

interface Vinculaciones {
  skus_venta: SkuVentaVinc[];
  alternativos: AlternativoVinc[];
  agrupacion: "individual" | "multi_venta" | "con_alternativos" | "multi_venta_con_alternativos";
}

interface ExplainResponse {
  sku_origen: string;
  calculado_at: string;
  verificacion_summary: {
    total_metricas_verificables: number;
    match_ok: number;
    discrepancias: { metrica: string; calculado: number; motor: number; delta: number }[];
  };
  vinculaciones: Vinculaciones;
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

const tipoColor = (tipo: InputCrudo["tipo"]): string => {
  switch (tipo) {
    case "fuente": return "var(--cyan)";
    case "constante": return "var(--amber)";
    case "metrica": return "var(--blue)";
    case "derivado": return "var(--green)";
  }
};

const tipoIcon = (tipo: InputCrudo["tipo"]): string => {
  switch (tipo) {
    case "fuente": return "DB";
    case "constante": return "K";
    case "metrica": return "→";
    case "derivado": return "ƒ";
  }
};

// Categorización de métricas en secciones temáticas. El orden importa: dentro
// de cada sección las métricas se renderizan en este orden.
const SECCIONES: { titulo: string; emoji: string; descripcion: string; metricas: string[] }[] = [
  {
    titulo: "Identidad & clasificación",
    emoji: "🏷️",
    descripcion: "Quién es este SKU y dónde cae en la matriz.",
    metricas: ["sku_origen", "nombre", "costo_unitario", "abc", "abc_pre_quiebre", "xyz", "cuadrante", "cv"],
  },
  {
    titulo: "Demanda",
    emoji: "📈",
    descripcion: "Velocidad de venta histórica y ajustes por evento/quiebre.",
    metricas: ["vel_7d", "vel_30d", "vel_60d", "vel_ponderada", "vel_pre_quiebre", "multiplicador_evento", "vel_ajustada_evento", "pct_full", "pct_flex"],
  },
  {
    titulo: "Stock & cobertura",
    emoji: "📦",
    descripcion: "Inventario disponible y a cuántos días alcanza.",
    metricas: ["stock_full", "stock_bodega", "stock_en_transito", "stock_total", "cob_full", "target_dias_full", "dio", "gmroi"],
  },
  {
    titulo: "Safety stock & ROP",
    emoji: "🛡️",
    descripcion: "Colchón estadístico y punto de reorden.",
    metricas: ["desviacion_std", "lead_time_usado_dias", "nivel_servicio", "safety_stock_simple", "safety_stock_completo", "rop_calculado", "necesita_pedir"],
  },
  {
    titulo: "Quiebre & ramp-up",
    emoji: "⏱️",
    descripcion: "Estado de quiebre y factor de ajuste post-quiebre.",
    metricas: ["dias_en_quiebre", "fecha_entrada_quiebre", "es_quiebre_proveedor", "factor_rampup_aplicado"],
  },
  {
    titulo: "Decisiones",
    emoji: "🎯",
    descripcion: "Qué hace el motor con todo lo anterior.",
    metricas: ["mandar_full", "publicar_flex", "pedir_proveedor_sin_rampup", "pedir_proveedor", "pedir_proveedor_bultos", "accion", "prioridad"],
  },
];

function ChipInput({ inp, onJump }: { inp: InputCrudo; onJump: (ref: string) => void }) {
  const color = tipoColor(inp.tipo);
  const icon = tipoIcon(inp.tipo);
  const clickable = inp.tipo === "metrica" && inp.ref;
  return (
    <span
      onClick={clickable ? () => onJump(inp.ref!) : undefined}
      title={inp.fuente || inp.formula || inp.nota || ""}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 6px",
        borderRadius: 4,
        background: color + "15",
        border: `1px solid ${color}40`,
        fontSize: 10,
        cursor: clickable ? "pointer" : "default",
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ color, fontWeight: 700, fontSize: 9 }}>{icon}</span>
      <span style={{ color: "var(--txt2)" }}>{inp.nombre}</span>
      <span className="mono" style={{ color: "var(--txt)", fontWeight: 600 }}>{fmt(inp.valor)}</span>
    </span>
  );
}

function InputTree({ inp, onJump, depth = 0 }: { inp: InputCrudo; onJump: (ref: string) => void; depth?: number }) {
  const color = tipoColor(inp.tipo);
  const tieneSubInputs = inp.inputs && inp.inputs.length > 0;
  return (
    <div style={{ marginLeft: depth * 14, paddingTop: 4, paddingBottom: 4, borderLeft: depth > 0 ? `1px solid ${color}30` : "none", paddingLeft: depth > 0 ? 8 : 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10 }}>
        <span style={{ color, fontWeight: 700, fontSize: 9, minWidth: 18, textAlign: "center" }}>{tipoIcon(inp.tipo)}</span>
        <span style={{ color: "var(--txt2)" }}>{inp.nombre}</span>
        <span style={{ color: "var(--txt3)" }}>=</span>
        <span className="mono" style={{ color: "var(--txt)", fontWeight: 600 }}>{fmt(inp.valor)}</span>
        {inp.tipo === "metrica" && inp.ref && (
          <button
            onClick={() => onJump(inp.ref!)}
            title={`Ir a ${inp.ref}`}
            style={{ background: "var(--blueBg)", color: "var(--blue)", border: "1px solid var(--blueBd)", borderRadius: 3, fontSize: 8, padding: "0 4px", cursor: "pointer" }}
          >
            ver
          </button>
        )}
      </div>
      {(inp.fuente || inp.formula || inp.nota) && (
        <div style={{ fontSize: 9, color: "var(--txt3)", marginLeft: 24, marginTop: 1 }}>
          {inp.fuente && <span>📂 {inp.fuente}</span>}
          {inp.formula && <span style={{ fontFamily: "JetBrains Mono, monospace" }}>{inp.formula}</span>}
          {inp.nota && <span style={{ color: "var(--amber)" }}> · {inp.nota}</span>}
        </div>
      )}
      {tieneSubInputs && inp.inputs!.map((sub, i) => <InputTree key={i} inp={sub} onJump={onJump} depth={depth + 1} />)}
    </div>
  );
}

function MetricaCardCompacto({
  nombre,
  m,
  onJump,
  expandido,
  onToggle,
}: {
  nombre: string;
  m: MetricaExplicada;
  onJump: (ref: string) => void;
  expandido: boolean;
  onToggle: () => void;
}) {
  const valorStr = fmt(m.valor);
  const verifColor = m.verificacion ? (m.verificacion.match ? "var(--green)" : "var(--amber)") : null;
  const verifIcon = m.verificacion ? (m.verificacion.match ? "✓" : "⚠") : null;
  return (
    <div
      id={`metrica-${nombre}`}
      style={{
        background: "var(--bg3)",
        border: `1px solid ${verifColor && !m.verificacion?.match ? "var(--amberBd)" : "var(--bg4)"}`,
        borderRadius: 6,
        padding: 8,
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <div onClick={onToggle} style={{ display: "flex", alignItems: "baseline", gap: 8, cursor: "pointer" }}>
        <span style={{ fontSize: 9, color: "var(--txt3)", flex: 1, fontFamily: "JetBrains Mono, monospace" }}>{nombre}</span>
        {verifColor && <span style={{ fontSize: 10, color: verifColor }}>{verifIcon}</span>}
        <span style={{ fontSize: 8, color: "var(--txt3)" }}>{expandido ? "−" : "+"}</span>
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
        <span className="mono" style={{ fontSize: 16, color: "var(--txt)", fontWeight: 700 }}>{valorStr}</span>
        {m.unidad && <span style={{ fontSize: 9, color: "var(--txt3)" }}>{m.unidad}</span>}
      </div>
      {m.formula && (
        <div style={{ fontSize: 9, color: "var(--txt2)", fontFamily: "JetBrains Mono, monospace", lineHeight: 1.4, wordBreak: "break-word" }}>
          {m.formula}
        </div>
      )}
      {m.inputs && m.inputs.length > 0 && !expandido && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 2 }}>
          {m.inputs.slice(0, 6).map((inp, i) => <ChipInput key={i} inp={inp} onJump={onJump} />)}
          {m.inputs.length > 6 && <span style={{ fontSize: 9, color: "var(--txt3)", alignSelf: "center" }}>+{m.inputs.length - 6}</span>}
        </div>
      )}
      {expandido && (
        <>
          {m.nota && (
            <div style={{ fontSize: 10, color: "var(--amber)", padding: 4, background: "var(--amberBg)", borderRadius: 4, border: "1px solid var(--amberBd)" }}>
              {m.nota}
            </div>
          )}
          {m.inputs && m.inputs.length > 0 && (
            <div style={{ marginTop: 4, padding: 6, background: "var(--bg2)", borderRadius: 4 }}>
              {m.inputs.map((inp, i) => <InputTree key={i} inp={inp} onJump={onJump} />)}
            </div>
          )}
          {m.verificacion && (
            <div style={{ fontSize: 9, padding: 4, background: m.verificacion.match ? "var(--greenBg)" : "var(--amberBg)", borderRadius: 4, color: m.verificacion.match ? "var(--green)" : "var(--amber)" }}>
              <span style={{ fontWeight: 700 }}>{m.verificacion.match ? "✓ Verificado" : "⚠ Discrepancia"}</span>
              {" · "}guardado en DB: <span className="mono">{fmt(m.verificacion.motor)}</span>
              {" · "}recalculado desde fórmula: <span className="mono">{fmt(m.verificacion.calculado)}</span>
              {!m.verificacion.match && m.verificacion.delta !== undefined && (
                <> {" · "}Δ <span className="mono">{m.verificacion.delta.toFixed(2)}</span></>
              )}
            </div>
          )}
          {(m.codigo || m.doc) && (
            <div style={{ fontSize: 9, color: "var(--txt3)", display: "flex", gap: 8, flexWrap: "wrap" }}>
              {m.codigo && <span>📁 <span className="mono">{m.codigo}</span></span>}
              {m.doc && <span>📖 <span className="mono">{m.doc}</span></span>}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function VinculacionesPanel({ v }: { v: Vinculaciones }) {
  if (v.agrupacion === "individual") return null;
  return (
    <div style={{ background: "var(--bg3)", border: "1px solid var(--bg4)", borderRadius: 8, padding: 12, marginBottom: 12 }}>
      <div style={{ fontSize: 11, color: "var(--txt2)", marginBottom: 8, fontWeight: 700 }}>
        🔗 Vinculaciones ({v.agrupacion.replace(/_/g, " ")})
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        {/* SKUs Venta */}
        <div>
          <div style={{ fontSize: 10, color: "var(--cyan)", fontWeight: 700, marginBottom: 4 }}>
            SKUs venta vinculados ({v.skus_venta.length})
          </div>
          {v.skus_venta.length === 0 ? (
            <div style={{ fontSize: 10, color: "var(--txt3)", fontStyle: "italic" }}>Ninguno</div>
          ) : (
            <table style={{ width: "100%", fontSize: 9 }}>
              <thead>
                <tr style={{ color: "var(--txt3)", borderBottom: "1px solid var(--bg4)" }}>
                  <th style={{ textAlign: "left", padding: 2 }}>SKU venta</th>
                  <th style={{ textAlign: "right", padding: 2 }}>×uds</th>
                  <th style={{ textAlign: "right", padding: 2 }}>St.Full venta</th>
                  <th style={{ textAlign: "right", padding: 2 }}>= origen</th>
                </tr>
              </thead>
              <tbody>
                {v.skus_venta.map(s => (
                  <tr key={s.sku_venta}>
                    <td className="mono" style={{ padding: 2, color: "var(--txt)" }}>{s.sku_venta}</td>
                    <td className="mono" style={{ padding: 2, textAlign: "right", color: "var(--txt2)" }}>{s.unidades}</td>
                    <td className="mono" style={{ padding: 2, textAlign: "right", color: "var(--txt2)" }}>{s.stock_full_uds_venta}</td>
                    <td className="mono" style={{ padding: 2, textAlign: "right", color: "var(--cyan)", fontWeight: 700 }}>{s.stock_full_uds_origen}</td>
                  </tr>
                ))}
                {v.skus_venta.length > 1 && (
                  <tr style={{ borderTop: "1px solid var(--bg4)" }}>
                    <td colSpan={3} style={{ padding: 2, color: "var(--txt3)", fontStyle: "italic" }}>Σ stock_full origen</td>
                    <td className="mono" style={{ padding: 2, textAlign: "right", color: "var(--cyan)", fontWeight: 700 }}>
                      {v.skus_venta.reduce((s, x) => s + x.stock_full_uds_origen, 0)}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>

        {/* Alternativos */}
        <div>
          <div style={{ fontSize: 10, color: "var(--amber)", fontWeight: 700, marginBottom: 4 }}>
            Alternativos ({v.alternativos.length})
          </div>
          {v.alternativos.length === 0 ? (
            <div style={{ fontSize: 10, color: "var(--txt3)", fontStyle: "italic" }}>Ninguno</div>
          ) : (
            <table style={{ width: "100%", fontSize: 9 }}>
              <thead>
                <tr style={{ color: "var(--txt3)", borderBottom: "1px solid var(--bg4)" }}>
                  <th style={{ textAlign: "left", padding: 2 }}>SKU origen</th>
                  <th style={{ textAlign: "right", padding: 2 }}>St.Bod</th>
                  <th style={{ textAlign: "right", padding: 2 }}>St.Tot</th>
                  <th style={{ textAlign: "right", padding: 2 }}>Pedir</th>
                  <th style={{ textAlign: "left", padding: 2 }}>vía</th>
                </tr>
              </thead>
              <tbody>
                {v.alternativos.map(a => (
                  <tr key={a.sku_origen}>
                    <td className="mono" style={{ padding: 2, color: "var(--txt)" }} title={a.nombre || ""}>{a.sku_origen}</td>
                    <td className="mono" style={{ padding: 2, textAlign: "right", color: "var(--txt2)" }}>{a.stock_bodega}</td>
                    <td className="mono" style={{ padding: 2, textAlign: "right", color: "var(--txt2)" }}>{a.stock_total}</td>
                    <td className="mono" style={{ padding: 2, textAlign: "right", color: a.pedir_proveedor > 0 ? "var(--amber)" : "var(--txt3)" }}>{a.pedir_proveedor || "—"}</td>
                    <td style={{ padding: 2, fontSize: 8, color: "var(--txt3)" }}>{a.via}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      <div style={{ fontSize: 9, color: "var(--txt3)", marginTop: 6, paddingTop: 6, borderTop: "1px solid var(--bg4)" }}>
        El motor agrega stock de bodega de los alternativos y stock full de los SKUs venta (multiplicado por unidades). Las métricas de abajo ya están agregadas.
      </div>
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
        const open: Record<string, boolean> = {};
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

  // Métricas no categorizadas (para sección "Otros")
  const metricasCategorizadasSet = useMemo(() => {
    const s = new Set<string>();
    for (const sec of SECCIONES) for (const m of sec.metricas) s.add(m);
    return s;
  }, []);

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
        width: "min(900px, 100vw)",
        background: "var(--bg)",
        borderLeft: "2px solid var(--bg4)",
        zIndex: 9999,
        display: "flex",
        flexDirection: "column",
        boxShadow: "-4px 0 20px rgba(0,0,0,0.5)",
      };

  return (
    <div style={wrapperStyle}>
      {/* HEADER STICKY */}
      <div
        style={{
          padding: 14,
          borderBottom: "1px solid var(--bg4)",
          display: "flex",
          alignItems: "center",
          gap: 10,
          background: "var(--bg2)",
          position: "sticky",
          top: 0,
          zIndex: 5,
        }}
      >
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, color: "var(--txt3)" }}>Trazabilidad de cálculos</div>
          <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 16, color: "var(--txt)", fontWeight: 700 }}>{skuOrigen}</div>
          {data && data.metricas.nombre && (
            <div style={{ fontSize: 11, color: "var(--txt2)" }}>{String(data.metricas.nombre.valor)}</div>
          )}
          {data && (
            <div style={{ fontSize: 10, color: "var(--txt3)", marginTop: 2 }}>
              calc {new Date(data.calculado_at).toLocaleString("es-CL")}
              {" · "}
              <span style={{ color: data.verificacion_summary.match_ok === data.verificacion_summary.total_metricas_verificables ? "var(--green)" : "var(--amber)" }}>
                {data.verificacion_summary.match_ok}/{data.verificacion_summary.total_metricas_verificables} fórmulas verificadas
              </span>
              {data.vinculaciones && data.vinculaciones.agrupacion !== "individual" && (
                <> · <span style={{ color: "var(--cyan)" }}>{data.vinculaciones.agrupacion.replace(/_/g, " ")}</span></>
              )}
            </div>
          )}
        </div>
        {data && data.metricas.accion && (
          <div style={{ padding: "4px 10px", borderRadius: 4, background: "var(--bg3)", border: "1px solid var(--bg4)" }}>
            <div style={{ fontSize: 8, color: "var(--txt3)", textTransform: "uppercase" }}>acción</div>
            <div className="mono" style={{ fontSize: 11, color: "var(--txt)", fontWeight: 700 }}>{String(data.metricas.accion.valor)}</div>
          </div>
        )}
        {onClose && (
          <button
            onClick={onClose}
            style={{ background: "var(--bg3)", border: "1px solid var(--bg4)", color: "var(--txt)", padding: "6px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12 }}
          >
            Cerrar ✕
          </button>
        )}
      </div>

      {/* BODY */}
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
            {/* Discrepancias */}
            {data.verificacion_summary.discrepancias.length > 0 && (
              <div style={{ marginBottom: 12, padding: 10, background: "var(--amberBg)", border: "1px solid var(--amberBd)", borderRadius: 6 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "var(--amber)", marginBottom: 4 }}>
                  ⚠ {data.verificacion_summary.discrepancias.length} discrepancia(s) entre fórmula documentada y motor
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {data.verificacion_summary.discrepancias.map((d) => (
                    <button
                      key={d.metrica}
                      onClick={() => jump(d.metrica)}
                      style={{ background: "var(--bg3)", border: "1px solid var(--amberBd)", color: "var(--amber)", padding: "2px 8px", borderRadius: 3, fontSize: 10, cursor: "pointer", fontFamily: "JetBrains Mono, monospace" }}
                    >
                      {d.metrica} (Δ{d.delta > 0 ? "+" : ""}{d.delta.toFixed(1)})
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Vinculaciones (si hay alternativos o multi-venta) */}
            {data.vinculaciones && <VinculacionesPanel v={data.vinculaciones} />}

            {/* Leyenda de tipos */}
            <div style={{ fontSize: 9, color: "var(--txt3)", marginBottom: 10, padding: 6, background: "var(--bg2)", borderRadius: 4, display: "flex", gap: 12, flexWrap: "wrap" }}>
              <span><span style={{ color: tipoColor("fuente"), fontWeight: 700 }}>DB</span> lee de tabla</span>
              <span><span style={{ color: tipoColor("constante"), fontWeight: 700 }}>K</span> constante</span>
              <span><span style={{ color: tipoColor("metrica"), fontWeight: 700 }}>→</span> ref a otra métrica</span>
              <span><span style={{ color: tipoColor("derivado"), fontWeight: 700 }}>ƒ</span> derivado in-line</span>
              <span style={{ marginLeft: "auto", color: "var(--txt3)" }}>Click en card para ver detalle completo</span>
            </div>

            {/* Secciones temáticas */}
            {SECCIONES.map(sec => {
              const metricasEnSec = sec.metricas.filter(name => data.metricas[name]);
              if (metricasEnSec.length === 0) return null;
              return (
                <div key={sec.titulo} style={{ marginBottom: 16 }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6, paddingBottom: 4, borderBottom: "2px solid var(--bg4)" }}>
                    <span style={{ fontSize: 14 }}>{sec.emoji}</span>
                    <span style={{ fontSize: 12, fontWeight: 700, color: "var(--txt)", textTransform: "uppercase", letterSpacing: 0.5 }}>{sec.titulo}</span>
                    <span style={{ fontSize: 10, color: "var(--txt3)", flex: 1 }}>{sec.descripcion}</span>
                    <span style={{ fontSize: 9, color: "var(--txt3)" }}>{metricasEnSec.length} métricas</span>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 8 }}>
                    {metricasEnSec.map(name => (
                      <MetricaCardCompacto
                        key={name}
                        nombre={name}
                        m={data.metricas[name]}
                        onJump={jump}
                        expandido={!!openMap[name]}
                        onToggle={() => toggle(name)}
                      />
                    ))}
                  </div>
                </div>
              );
            })}

            {/* Otras métricas no categorizadas */}
            {(() => {
              const otras = Object.entries(data.metricas).filter(([n]) => !metricasCategorizadasSet.has(n));
              if (otras.length === 0) return null;
              return (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6, paddingBottom: 4, borderBottom: "2px solid var(--bg4)" }}>
                    <span style={{ fontSize: 14 }}>📋</span>
                    <span style={{ fontSize: 12, fontWeight: 700, color: "var(--txt)", textTransform: "uppercase", letterSpacing: 0.5 }}>Otras métricas</span>
                    <span style={{ fontSize: 9, color: "var(--txt3)" }}>{otras.length} métricas</span>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 8 }}>
                    {otras.map(([name, m]) => (
                      <MetricaCardCompacto
                        key={name}
                        nombre={name}
                        m={m}
                        onJump={jump}
                        expandido={!!openMap[name]}
                        onToggle={() => toggle(name)}
                      />
                    ))}
                  </div>
                </div>
              );
            })()}
          </>
        )}
      </div>
    </div>
  );
}
