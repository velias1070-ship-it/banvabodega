"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import { getStore, saveStore, activePositions, posContents, skuPositions, skuTotal, getMapConfig, saveMapConfig, savePositionMap, findProduct, initStore } from "@/lib/store";
import type { Position, MapObject, MapConfig, Product } from "@/lib/store";
import Link from "next/link";

const COLORS = {
  pallet: "#10b981", shelf: "#3b82f6", desk: "#6366f1",
  door: "#f59e0b", wall: "#64748b", zone: "#06b6d4", label: "#94a3b8"
};
const KIND_LABELS: Record<string, string> = {
  desk: "Escritorio", door: "Entrada/Puerta", wall: "Pared/Muro", zone: "Zona", label: "Etiqueta"
};
const DEFAULT_POS = { mw: 2, mh: 2 };

export default function MapaPage() {
  const [mounted, setMounted] = useState(false);
  const [mode, setMode] = useState<"edit"|"view">("edit");
  const [cfg, setCfg] = useState<MapConfig>({ gridW: 20, gridH: 14, objects: [] });
  const [positions, setPositions] = useState<Position[]>([]);
  const [selected, setSelected] = useState<{ type: "pos"|"obj"; id: string } | null>(null);
  const [dragging, setDragging] = useState<{ type: "pos"|"obj"; id: string; ox: number; oy: number } | null>(null);
  const [resizing, setResizing] = useState<{ type: "pos"|"obj"; id: string } | null>(null);
  const [searchSku, setSearchSku] = useState("");
  const [highlightPos, setHighlightPos] = useState<string[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const [cellSize, setCellSize] = useState(40);
  const [,setTick] = useState(0);
  const refresh = () => setTick(t => t + 1);

  useEffect(() => { initStore().then(() => setMounted(true)); }, []);
  useEffect(() => {
    if (!mounted) return;
    setCfg(getMapConfig());
    setPositions(getStore().positions);
    // Auto-place unplaced positions
    const s = getStore();
    let col = 2, row = 4;
    s.positions.forEach(p => {
      if (p.mx === undefined) {
        p.mx = col; p.my = row; p.mw = 2; p.mh = 2;
        col += 3; if (col > cfg.gridW - 3) { col = 2; row += 3; }
      }
    });
    saveStore();
    setPositions([...s.positions]);
  }, [mounted]);

  useEffect(() => {
    const handleResize = () => {
      if (containerRef.current) {
        const w = containerRef.current.clientWidth;
        setCellSize(Math.max(24, Math.floor((w - 20) / cfg.gridW)));
      }
    };
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [cfg.gridW]);

  const saveCfg = useCallback((c: MapConfig) => { setCfg(c); saveMapConfig(c); }, []);

  // ---- Drag & Resize handlers ----
  const getGridPos = (clientX: number, clientY: number) => {
    if (!containerRef.current) return { gx: 0, gy: 0 };
    const rect = containerRef.current.getBoundingClientRect();
    return { gx: Math.floor((clientX - rect.left) / cellSize), gy: Math.floor((clientY - rect.top) / cellSize) };
  };

  const handlePointerDown = (e: React.PointerEvent, type: "pos"|"obj", id: string, isResize?: boolean) => {
    e.stopPropagation(); e.preventDefault();
    setSelected({ type, id });
    if (mode !== "edit") return;
    const { gx, gy } = getGridPos(e.clientX, e.clientY);
    if (isResize) { setResizing({ type, id }); }
    else { setDragging({ type, id, ox: gx, oy: gy }); }
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragging && !resizing) return;
    const { gx, gy } = getGridPos(e.clientX, e.clientY);

    if (dragging) {
      const dx = gx - dragging.ox; const dy = gy - dragging.oy;
      if (dx === 0 && dy === 0) return;
      if (dragging.type === "pos") {
        const p = positions.find(x => x.id === dragging.id);
        if (p) {
          p.mx = Math.max(0, Math.min(cfg.gridW - (p.mw||2), (p.mx||0) + dx));
          p.my = Math.max(0, Math.min(cfg.gridH - (p.mh||2), (p.my||0) + dy));
          savePositionMap(p.id, p.mx, p.my, p.mw||2, p.mh||2);
          setPositions([...getStore().positions]);
        }
      } else {
        const o = cfg.objects.find(x => x.id === dragging.id);
        if (o) {
          o.mx = Math.max(0, Math.min(cfg.gridW - o.mw, o.mx + dx));
          o.my = Math.max(0, Math.min(cfg.gridH - o.mh, o.my + dy));
          saveCfg({ ...cfg });
        }
      }
      setDragging({ ...dragging, ox: gx, oy: gy });
    }

    if (resizing) {
      if (resizing.type === "pos") {
        const p = positions.find(x => x.id === resizing.id);
        if (p) {
          const nw = Math.max(1, gx - (p.mx||0) + 1);
          const nh = Math.max(1, gy - (p.my||0) + 1);
          p.mw = Math.min(nw, cfg.gridW - (p.mx||0));
          p.mh = Math.min(nh, cfg.gridH - (p.my||0));
          savePositionMap(p.id, p.mx||0, p.my||0, p.mw, p.mh);
          setPositions([...getStore().positions]);
        }
      } else {
        const o = cfg.objects.find(x => x.id === resizing.id);
        if (o) {
          o.mw = Math.max(1, Math.min(gx - o.mx + 1, cfg.gridW - o.mx));
          o.mh = Math.max(1, Math.min(gy - o.my + 1, cfg.gridH - o.my));
          saveCfg({ ...cfg });
        }
      }
    }
  };

  const handlePointerUp = () => { setDragging(null); setResizing(null); };

  // ---- Add/Remove objects ----
  const addObject = (kind: MapObject["kind"]) => {
    const id = kind + "_" + Date.now();
    const newObj: MapObject = { id, label: KIND_LABELS[kind] || kind, kind, mx: 1, my: 1, mw: kind === "wall" ? 6 : 3, mh: kind === "wall" ? 1 : 2, color: COLORS[kind] };
    saveCfg({ ...cfg, objects: [...cfg.objects, newObj] });
    setSelected({ type: "obj", id });
  };

  const removeSelected = () => {
    if (!selected) return;
    if (selected.type === "obj") {
      saveCfg({ ...cfg, objects: cfg.objects.filter(o => o.id !== selected.id) });
    }
    setSelected(null);
  };

  // ---- Search highlight ----
  const doSearch = (q: string) => {
    setSearchSku(q);
    if (q.length < 2) { setHighlightPos([]); return; }
    const prods = findProduct(q);
    const posIds: string[] = [];
    prods.forEach(p => skuPositions(p.sku).forEach(sp => { if (!posIds.includes(sp.pos)) posIds.push(sp.pos); }));
    setHighlightPos(posIds);
  };

  // ---- Selected item props ----
  const getSelectedItem = () => {
    if (!selected) return null;
    if (selected.type === "pos") return positions.find(p => p.id === selected.id);
    return cfg.objects.find(o => o.id === selected.id);
  };
  const selectedItem = getSelectedItem();

  const updateSelectedLabel = (label: string) => {
    if (!selected) return;
    if (selected.type === "pos") {
      const p = positions.find(x => x.id === selected.id);
      if (p) { p.label = label; saveStore(); setPositions([...getStore().positions]); }
    } else {
      const o = cfg.objects.find(x => x.id === selected.id);
      if (o) { o.label = label; saveCfg({ ...cfg }); }
    }
  };

  const updateSelectedColor = (color: string) => {
    if (!selected) return;
    if (selected.type === "pos") {
      const p = positions.find(x => x.id === selected.id);
      if (p) { p.color = color; saveStore(); setPositions([...getStore().positions]); }
    } else {
      const o = cfg.objects.find(x => x.id === selected.id);
      if (o) { o.color = color; saveCfg({ ...cfg }); }
    }
  };

  if (!mounted) return null;

  const mapW = cfg.gridW * cellSize;
  const mapH = cfg.gridH * cellSize;

  return (
    <div className="app-admin">
      <div className="admin-topbar">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Link href="/admin"><button className="back-btn">&#8592; Admin</button></Link>
          <h1 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>Mapa de Bodega</h1>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button onClick={() => setMode("edit")} style={{ padding: "6px 14px", borderRadius: 6, fontSize: 12, fontWeight: 600, background: mode === "edit" ? "var(--cyanBg)" : "var(--bg3)", color: mode === "edit" ? "var(--cyan)" : "var(--txt3)", border: `1px solid ${mode === "edit" ? "var(--cyan)" : "var(--bg4)"}` }}>Editar</button>
          <button onClick={() => setMode("view")} style={{ padding: "6px 14px", borderRadius: 6, fontSize: 12, fontWeight: 600, background: mode === "view" ? "var(--greenBg)" : "var(--bg3)", color: mode === "view" ? "var(--green)" : "var(--txt3)", border: `1px solid ${mode === "view" ? "var(--green)" : "var(--bg4)"}` }}>Operador</button>
        </div>
      </div>

      <div style={{ display: "flex", minHeight: "calc(100vh - 52px)" }}>
        {/* Sidebar tools */}
        <div style={{ width: 220, background: "var(--bg2)", borderRight: "1px solid var(--bg4)", padding: 12, overflow: "auto", flexShrink: 0 }} className="desktop-only">
          {mode === "edit" ? <>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--txt3)", marginBottom: 8, textTransform: "uppercase", letterSpacing: ".05em" }}>Agregar objeto</div>
            {(["desk", "door", "wall", "zone", "label"] as const).map(k => (
              <button key={k} onClick={() => addObject(k)} style={{ width: "100%", padding: "8px 10px", marginBottom: 4, borderRadius: 6, background: "var(--bg3)", border: "1px solid var(--bg4)", color: "var(--txt2)", fontSize: 12, textAlign: "left", display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ width: 12, height: 12, borderRadius: 3, background: COLORS[k], display: "inline-block" }} />{KIND_LABELS[k]}
              </button>
            ))}

            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--txt3)", margin: "16px 0 8px", textTransform: "uppercase", letterSpacing: ".05em" }}>Tamaño bodega</div>
            <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 9, color: "var(--txt3)" }}>Ancho</div>
                <input type="number" className="form-input mono" value={cfg.gridW} onChange={e => saveCfg({ ...cfg, gridW: Math.max(8, parseInt(e.target.value) || 20) })} style={{ fontSize: 12, padding: 6 }} />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 9, color: "var(--txt3)" }}>Alto</div>
                <input type="number" className="form-input mono" value={cfg.gridH} onChange={e => saveCfg({ ...cfg, gridH: Math.max(6, parseInt(e.target.value) || 14) })} style={{ fontSize: 12, padding: 6 }} />
              </div>
            </div>

            {selected && selectedItem && <>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--cyan)", margin: "16px 0 8px", textTransform: "uppercase" }}>Seleccionado</div>
              <div style={{ fontSize: 10, color: "var(--txt3)", marginBottom: 4 }}>{selected.type === "pos" ? "Posición" : "Objeto"}: {selected.id}</div>
              <input className="form-input" value={(selectedItem as any).label || ""} onChange={e => updateSelectedLabel(e.target.value)} placeholder="Nombre..." style={{ fontSize: 12, marginBottom: 6 }} />
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 8 }}>
                {["#10b981", "#3b82f6", "#f59e0b", "#ef4444", "#6366f1", "#06b6d4", "#64748b", "#ec4899"].map(c => (
                  <button key={c} onClick={() => updateSelectedColor(c)} style={{ width: 24, height: 24, borderRadius: 4, background: c, border: ((selectedItem as any).color || "#10b981") === c ? "3px solid #fff" : "2px solid var(--bg4)" }} />
                ))}
              </div>
              {selected.type === "obj" && <button onClick={removeSelected} style={{ width: "100%", padding: 8, borderRadius: 6, background: "var(--redBg)", color: "var(--red)", fontSize: 11, fontWeight: 600, border: "1px solid var(--red)" }}>Eliminar objeto</button>}
            </>}
          </> : <>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--txt3)", marginBottom: 8, textTransform: "uppercase", letterSpacing: ".05em" }}>Buscar producto</div>
            <input className="form-input mono" value={searchSku} onChange={e => doSearch(e.target.value.toUpperCase())} placeholder="SKU o nombre..." style={{ fontSize: 12, marginBottom: 8 }} />
            {highlightPos.length > 0 && (
              <div style={{ fontSize: 11, color: "var(--green)", marginBottom: 8 }}>En {highlightPos.length} posición{highlightPos.length > 1 ? "es" : ""}: {highlightPos.join(", ")}</div>
            )}
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--txt3)", margin: "12px 0 8px", textTransform: "uppercase" }}>Leyenda</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, fontSize: 11 }}><span style={{ width: 12, height: 12, borderRadius: 3, background: COLORS.pallet, display: "inline-block" }} />Pallet</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, fontSize: 11 }}><span style={{ width: 12, height: 12, borderRadius: 3, background: COLORS.shelf, display: "inline-block" }} />Estante</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, fontSize: 11 }}><span style={{ width: 12, height: 12, borderRadius: 3, background: COLORS.door, display: "inline-block" }} />Entrada</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, fontSize: 11 }}><span style={{ width: 12, height: 12, borderRadius: 3, background: COLORS.desk, display: "inline-block" }} />Escritorio</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, fontSize: 11 }}><span style={{ width: 14, height: 14, borderRadius: 50, background: "#fbbf24", border: "3px solid #10b981", display: "inline-block" }} />Producto aquí</div>
          </>}
        </div>

        {/* Map canvas */}
        <div style={{ flex: 1, overflow: "auto", padding: 16, background: "var(--bg)" }}>
          {/* Mobile search (view mode) */}
          {mode === "view" && <div className="mobile-only" style={{ marginBottom: 12 }}>
            <input className="form-input mono" value={searchSku} onChange={e => doSearch(e.target.value.toUpperCase())} placeholder="Buscar SKU para ubicar..." style={{ fontSize: 13 }} />
            {highlightPos.length > 0 && <div style={{ fontSize: 12, color: "var(--green)", marginTop: 4, fontWeight: 600 }}>Ir a: {highlightPos.join(", ")}</div>}
          </div>}

          <div ref={containerRef} style={{ width: mapW, height: mapH, position: "relative", background: "var(--bg2)", border: "2px solid var(--bg4)", borderRadius: 8, touchAction: "none", minWidth: mapW }}
            onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onClick={() => { if (!dragging && !resizing) setSelected(null); }}>
            {/* Grid lines */}
            <svg width={mapW} height={mapH} style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none", opacity: mode === "edit" ? 0.15 : 0.05 }}>
              {Array.from({ length: cfg.gridW + 1 }).map((_, i) => <line key={"v" + i} x1={i * cellSize} y1={0} x2={i * cellSize} y2={mapH} stroke="var(--txt3)" strokeWidth={1} />)}
              {Array.from({ length: cfg.gridH + 1 }).map((_, i) => <line key={"h" + i} x1={0} y1={i * cellSize} x2={mapW} y2={i * cellSize} stroke="var(--txt3)" strokeWidth={1} />)}
            </svg>

            {/* Static objects */}
            {cfg.objects.map(o => {
              const isSelected = selected?.type === "obj" && selected.id === o.id;
              return (
                <div key={o.id} onPointerDown={e => handlePointerDown(e, "obj", o.id)}
                  style={{ position: "absolute", left: o.mx * cellSize, top: o.my * cellSize, width: o.mw * cellSize, height: o.mh * cellSize, background: o.color + "22", border: `2px ${isSelected ? "solid" : "dashed"} ${o.color}`, borderRadius: 4, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", cursor: mode === "edit" ? "move" : "default", zIndex: isSelected ? 20 : 5, boxShadow: isSelected ? `0 0 0 2px ${o.color}` : "none", userSelect: "none" }}>
                  <div style={{ fontSize: Math.max(9, Math.min(13, cellSize * 0.3)), fontWeight: 700, color: o.color, textAlign: "center", lineHeight: 1.2, padding: 2, overflow: "hidden" }}>{o.label}</div>
                  {mode === "edit" && isSelected && (
                    <div onPointerDown={e => handlePointerDown(e, "obj", o.id, true)} style={{ position: "absolute", bottom: -4, right: -4, width: 12, height: 12, background: o.color, borderRadius: 2, cursor: "nwse-resize" }} />
                  )}
                </div>
              );
            })}

            {/* Position blocks */}
            {positions.filter(p => p.active).map(p => {
              const mx = p.mx ?? 0, my = p.my ?? 0, mw = p.mw ?? 2, mh = p.mh ?? 2;
              const color = p.color || COLORS[p.type];
              const isSelected = selected?.type === "pos" && selected.id === p.id;
              const isHighlight = highlightPos.includes(p.id);
              const items = posContents(p.id);
              const totalQ = items.reduce((s, i) => s + i.qty, 0);

              return (
                <div key={p.id} onPointerDown={e => handlePointerDown(e, "pos", p.id)}
                  style={{ position: "absolute", left: mx * cellSize, top: my * cellSize, width: mw * cellSize, height: mh * cellSize, background: isHighlight ? color + "44" : color + "18", border: `2px solid ${isHighlight ? "#fbbf24" : color}`, borderRadius: 6, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", cursor: mode === "edit" ? "move" : "default", zIndex: isSelected ? 20 : 10, boxShadow: isSelected ? `0 0 0 2px #fff, 0 0 12px ${color}44` : isHighlight ? `0 0 16px ${color}66, 0 0 0 3px #fbbf24` : "none", userSelect: "none", transition: "box-shadow .2s" }}>
                  <div className="mono" style={{ fontSize: Math.max(12, Math.min(20, cellSize * 0.45)), fontWeight: 800, color, lineHeight: 1 }}>{p.id}</div>
                  {(mw * cellSize > 50) && <div style={{ fontSize: Math.max(7, Math.min(10, cellSize * 0.22)), color: "var(--txt3)", marginTop: 1, textAlign: "center", lineHeight: 1.1, overflow: "hidden", maxWidth: "100%", padding: "0 2px" }}>{p.label}</div>}
                  {totalQ > 0 && (mh * cellSize > 40) && <div className="mono" style={{ fontSize: Math.max(8, Math.min(11, cellSize * 0.25)), color: "var(--blue)", fontWeight: 600, marginTop: 1 }}>{totalQ} uds</div>}
                  {isHighlight && <div style={{ position: "absolute", top: -6, right: -6, width: 14, height: 14, borderRadius: "50%", background: "#fbbf24", border: "2px solid var(--green)", animation: "pulse 1s infinite" }} />}
                  {mode === "edit" && isSelected && (
                    <div onPointerDown={e => handlePointerDown(e, "pos", p.id, true)} style={{ position: "absolute", bottom: -4, right: -4, width: 12, height: 12, background: color, borderRadius: 2, cursor: "nwse-resize" }} />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
