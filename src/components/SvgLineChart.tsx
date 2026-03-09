"use client";
import { useState, useMemo, useRef } from "react";

// Serie de datos para el gráfico
export interface ChartSeries {
  label: string;
  color: string;
  data: { x: string; y: number }[];
  dashed?: boolean;       // Línea punteada
  fillColor?: string;     // Color de relleno para área bajo la curva
}

interface SvgLineChartProps {
  series: ChartSeries[];
  height?: number;        // default 280
  formatY?: (n: number) => string;
  gridLines?: number;     // cantidad de líneas de grid Y (default 5)
}

// Formato compacto de montos ($1.2M, $450K)
function shortMoney(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${Math.round(abs / 1_000)}K`;
  return `${sign}$${Math.round(abs)}`;
}

const fmtMoney = (n: number) =>
  n.toLocaleString("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });

export default function SvgLineChart({
  series,
  height = 280,
  formatY = shortMoney,
  gridLines: gridCount = 5,
}: SvgLineChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState<{ si: number; di: number; cx: number; cy: number } | null>(null);

  // Padding interno del gráfico
  const padL = 65, padR = 16, padT = 16, padB = 40;

  // Recolectar todos los puntos X únicos (fechas) y valores Y
  const { allX, minY, maxY } = useMemo(() => {
    const xSet = new Set<string>();
    let min = Infinity, max = -Infinity;
    for (const s of series) {
      for (const d of s.data) {
        xSet.add(d.x);
        if (d.y < min) min = d.y;
        if (d.y > max) max = d.y;
      }
    }
    // Padding vertical 10%
    const range = max - min || 1;
    min -= range * 0.1;
    max += range * 0.1;
    return { allX: Array.from(xSet).sort(), minY: min, maxY: max };
  }, [series]);

  if (allX.length === 0) {
    return (
      <div style={{ textAlign: "center", padding: 40, color: "var(--txt3)", fontSize: 13 }}>
        Sin datos para graficar
      </div>
    );
  }

  // Usamos un viewBox fijo de 800 de ancho para responsividad
  const vw = 800;
  const chartW = vw - padL - padR;
  const chartH = height - padT - padB;

  // Escalas
  const scaleX = (idx: number) => padL + (allX.length > 1 ? (idx / (allX.length - 1)) * chartW : chartW / 2);
  const scaleY = (v: number) => padT + chartH - ((v - minY) / (maxY - minY)) * chartH;

  // Líneas de grid Y
  const grids = Array.from({ length: gridCount }, (_, i) => {
    const val = minY + ((maxY - minY) * i) / (gridCount - 1);
    return { val, y: scaleY(val) };
  });

  // Labels eje X (mostrar máx ~10 labels para no saturar)
  const xStep = Math.max(1, Math.ceil(allX.length / 10));
  const xLabels = allX.filter((_, i) => i % xStep === 0 || i === allX.length - 1).map(x => {
    const idx = allX.indexOf(x);
    // Formato corto: "01/03"
    const parts = x.split("-");
    const label = parts.length === 3 ? `${parts[2]}/${parts[1]}` : x;
    return { x: scaleX(idx), label };
  });

  // Generar puntos de polyline para una serie
  const linePoints = (s: ChartSeries) =>
    s.data.map(d => {
      const xi = allX.indexOf(d.x);
      return `${scaleX(xi)},${scaleY(d.y)}`;
    }).join(" ");

  // Polígono para área fill
  const areaPoints = (s: ChartSeries) => {
    const pts = s.data.map(d => {
      const xi = allX.indexOf(d.x);
      return { cx: scaleX(xi), cy: scaleY(d.y) };
    });
    if (pts.length === 0) return "";
    const baseY = scaleY(minY);
    const top = pts.map(p => `${p.cx},${p.cy}`).join(" ");
    return `${pts[0].cx},${baseY} ${top} ${pts[pts.length - 1].cx},${baseY}`;
  };

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <svg viewBox={`0 0 ${vw} ${height}`} style={{ width: "100%", height: "auto", display: "block" }}>
        {/* Grid horizontal */}
        {grids.map((g, i) => (
          <g key={i}>
            <line x1={padL} y1={g.y} x2={vw - padR} y2={g.y}
              stroke="var(--bg4)" strokeWidth={1} strokeDasharray="4 4" />
            <text x={padL - 8} y={g.y + 4} textAnchor="end" fill="var(--txt3)" fontSize={10}
              fontFamily="JetBrains Mono, monospace">
              {formatY(g.val)}
            </text>
          </g>
        ))}

        {/* Línea base 0 si el rango cruza 0 */}
        {minY < 0 && maxY > 0 && (
          <line x1={padL} y1={scaleY(0)} x2={vw - padR} y2={scaleY(0)}
            stroke="var(--txt3)" strokeWidth={1} strokeDasharray="2 2" opacity={0.5} />
        )}

        {/* Labels eje X */}
        {xLabels.map((xl, i) => (
          <text key={i} x={xl.x} y={height - 8} textAnchor="middle" fill="var(--txt3)" fontSize={9}
            fontFamily="JetBrains Mono, monospace">
            {xl.label}
          </text>
        ))}

        {/* Series */}
        {series.map((s, si) => (
          <g key={si}>
            {/* Área fill */}
            {s.fillColor && s.data.length > 1 && (
              <polygon points={areaPoints(s)} fill={s.fillColor} opacity={0.15} />
            )}
            {/* Línea */}
            {s.data.length > 1 ? (
              <polyline points={linePoints(s)} fill="none" stroke={s.color} strokeWidth={2}
                strokeDasharray={s.dashed ? "6 4" : undefined}
                strokeLinecap="round" strokeLinejoin="round" />
            ) : (
              /* Punto único */
              <circle cx={scaleX(allX.indexOf(s.data[0].x))} cy={scaleY(s.data[0].y)}
                r={5} fill={s.color} />
            )}
            {/* Puntos hover */}
            {s.data.map((d, di) => {
              const xi = allX.indexOf(d.x);
              const cx = scaleX(xi);
              const cy = scaleY(d.y);
              const isHovered = hovered?.si === si && hovered?.di === di;
              return (
                <circle key={di} cx={cx} cy={cy} r={isHovered ? 5 : 12}
                  fill={isHovered ? s.color : "transparent"} stroke={isHovered ? s.color : "none"} strokeWidth={2}
                  style={{ cursor: "pointer" }}
                  onMouseEnter={() => setHovered({ si, di, cx, cy })}
                  onMouseLeave={() => setHovered(null)} />
              );
            })}
          </g>
        ))}
      </svg>

      {/* Tooltip flotante */}
      {hovered && (() => {
        const s = series[hovered.si];
        const d = s.data[hovered.di];
        // Calcular posición del tooltip como % del contenedor
        const leftPct = (hovered.cx / vw) * 100;
        const topPct = (hovered.cy / height) * 100;
        return (
          <div style={{
            position: "absolute",
            left: `${leftPct}%`, top: `${topPct}%`,
            transform: "translate(-50%, -110%)",
            background: "var(--bg2)", border: "1px solid var(--bg4)",
            borderRadius: 8, padding: "6px 10px", fontSize: 11,
            pointerEvents: "none", whiteSpace: "nowrap", zIndex: 10,
            boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
          }}>
            <div style={{ fontWeight: 600, color: s.color, marginBottom: 2 }}>{s.label}</div>
            <div className="mono" style={{ fontWeight: 700 }}>{fmtMoney(d.y)}</div>
            <div style={{ color: "var(--txt3)", fontSize: 10 }}>{d.x}</div>
          </div>
        );
      })()}

      {/* Leyenda */}
      {series.length > 1 && (
        <div style={{ display: "flex", gap: 16, justifyContent: "center", marginTop: 8 }}>
          {series.map((s, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--txt2)" }}>
              <div style={{
                width: 16, height: 3, background: s.color, borderRadius: 2,
                ...(s.dashed ? { backgroundImage: `repeating-linear-gradient(90deg, ${s.color} 0 4px, transparent 4px 8px)`, background: "none" } : {}),
              }} />
              {s.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
