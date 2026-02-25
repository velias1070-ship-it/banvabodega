"use client";
import { useState, useEffect, useRef } from "react";
import { getStore, activePositions, posContents, skuPositions, getMapConfig, findProduct, initStore } from "@/lib/store";
import type { Position } from "@/lib/store";
import Link from "next/link";

const COLORS: Record<string,string> = { pallet: "#10b981", shelf: "#3b82f6", desk: "#6366f1", door: "#f59e0b", wall: "#64748b", zone: "#06b6d4", label: "#94a3b8" };

export default function MapaOperador() {
  const [mounted, setMounted] = useState(false);
  const [q, setQ] = useState("");
  const [highlightPos, setHighlightPos] = useState<string[]>([]);
  const [highlightSku, setHighlightSku] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const [cellSize, setCellSize] = useState(32);

  useEffect(() => { initStore().then(() => setMounted(true)); }, []);
  const cfg = mounted ? getMapConfig() : { gridW: 20, gridH: 14, objects: [] };
  const positions = mounted ? getStore().positions.filter(p => p.active) : [];

  useEffect(() => {
    const handleResize = () => {
      if (containerRef.current) {
        const w = containerRef.current.parentElement?.clientWidth || 360;
        setCellSize(Math.max(18, Math.floor((w - 32) / cfg.gridW)));
      }
    };
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [cfg.gridW, mounted]);

  const doSearch = (val: string) => {
    setQ(val);
    if (val.length < 2) { setHighlightPos([]); setHighlightSku(""); return; }
    const prods = findProduct(val);
    const posIds: string[] = [];
    let skuName = "";
    prods.forEach(p => { skuName = p.sku + " — " + p.name; skuPositions(p.sku).forEach(sp => { if (!posIds.includes(sp.pos)) posIds.push(sp.pos); }); });
    setHighlightPos(posIds);
    setHighlightSku(prods.length === 1 ? skuName : prods.length > 1 ? prods.length + " productos encontrados" : "");
  };

  if (!mounted) return null;
  const mapW = cfg.gridW * cellSize;
  const mapH = cfg.gridH * cellSize;

  return (
    <div className="app">
      <div className="topbar">
        <Link href="/operador"><button className="back-btn">&#8592;</button></Link>
        <h1>Mapa Bodega</h1>
      </div>
      <div style={{ padding: 12 }}>
        <div className="card">
          <input className="form-input mono" value={q} onChange={e => doSearch(e.target.value.toUpperCase())} placeholder="Buscar SKU para ubicar en mapa..." style={{ fontSize: 14 }} />
          {highlightPos.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 12, color: "var(--green)", fontWeight: 700 }}>{highlightSku}</div>
              <div style={{ fontSize: 12, color: "var(--txt2)", marginTop: 2 }}>
                Ir a posición{highlightPos.length > 1 ? "es" : ""}: {highlightPos.map((p, i) => (
                  <span key={p} className="mono" style={{ fontWeight: 700, color: "var(--green)", fontSize: 14 }}>{i > 0 ? ", " : ""}{p}</span>
                ))}
              </div>
              {highlightPos.map(pid => {
                const items = posContents(pid);
                const skuItems = items.filter(it => findProduct(q).some(p => p.sku === it.sku));
                return skuItems.map(it => (
                  <div key={pid+it.sku} className="mini-row" style={{ marginTop: 4 }}>
                    <span className="mono" style={{ fontWeight: 700, color: "var(--green)", fontSize: 13 }}>{pid}</span>
                    <span style={{ fontSize: 11, color: "var(--txt3)", flex: 1 }}>{it.name}</span>
                    <span className="mono" style={{ fontWeight: 700, color: "var(--blue)", fontSize: 13 }}>{it.qty} uds</span>
                  </div>
                ));
              })}
            </div>
          )}
          {q.length >= 2 && highlightPos.length === 0 && <div style={{ marginTop: 6, fontSize: 12, color: "var(--amber)" }}>No se encontró en bodega</div>}
        </div>

        <div style={{ overflow: "auto", borderRadius: 8 }}>
          <div ref={containerRef} style={{ width: mapW, height: mapH, position: "relative", background: "var(--bg2)", border: "2px solid var(--bg4)", borderRadius: 8, margin: "0 auto" }}>
            {/* Grid */}
            <svg width={mapW} height={mapH} style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none", opacity: 0.06 }}>
              {Array.from({ length: cfg.gridW + 1 }).map((_, i) => <line key={"v" + i} x1={i * cellSize} y1={0} x2={i * cellSize} y2={mapH} stroke="var(--txt3)" strokeWidth={1} />)}
              {Array.from({ length: cfg.gridH + 1 }).map((_, i) => <line key={"h" + i} x1={0} y1={i * cellSize} x2={mapW} y2={i * cellSize} stroke="var(--txt3)" strokeWidth={1} />)}
            </svg>
            {/* Objects */}
            {cfg.objects.map(o => (
              <div key={o.id} style={{ position: "absolute", left: o.mx * cellSize, top: o.my * cellSize, width: o.mw * cellSize, height: o.mh * cellSize, background: o.color + "22", border: `2px dashed ${o.color}`, borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 5 }}>
                <div style={{ fontSize: Math.max(8, cellSize * 0.28), fontWeight: 700, color: o.color, textAlign: "center" }}>{o.label}</div>
              </div>
            ))}
            {/* Positions */}
            {positions.map(p => {
              const mx = p.mx ?? 0, my = p.my ?? 0, mw = p.mw ?? 2, mh = p.mh ?? 2;
              const color = p.color || COLORS[p.type] || "#10b981";
              const isHL = highlightPos.includes(p.id);
              const items = posContents(p.id);
              const totalQ = items.reduce((s, i) => s + i.qty, 0);
              return (
                <div key={p.id} style={{ position: "absolute", left: mx * cellSize, top: my * cellSize, width: mw * cellSize, height: mh * cellSize, background: isHL ? color + "44" : color + "15", border: `2px solid ${isHL ? "#fbbf24" : color}`, borderRadius: 6, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", zIndex: isHL ? 20 : 10, boxShadow: isHL ? `0 0 20px ${color}66, 0 0 0 3px #fbbf24` : "none", transition: "all .3s" }}>
                  <div className="mono" style={{ fontSize: Math.max(11, cellSize * 0.4), fontWeight: 800, color, lineHeight: 1 }}>{p.id}</div>
                  {totalQ > 0 && mh * cellSize > 36 && <div className="mono" style={{ fontSize: Math.max(7, cellSize * 0.22), color: "var(--txt3)", marginTop: 1 }}>{totalQ}</div>}
                  {isHL && <div style={{ position: "absolute", top: -6, right: -6, width: 14, height: 14, borderRadius: "50%", background: "#fbbf24", border: "2px solid var(--green)", animation: "pulse 1s infinite" }} />}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
