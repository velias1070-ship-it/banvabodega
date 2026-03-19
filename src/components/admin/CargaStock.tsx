"use client";
import React, { useState, useEffect, useCallback, useRef } from "react";
import { getStore, saveStore, fmtMoney, skuTotal, findProduct, importStockFromSheet, wasStockImported, activePositions, recordBulkMovements, posContents, getUnassignedStock, assignPosition, recordMovement, getVentasPorSkuOrigen, SIN_ETIQUETAR } from "@/lib/store";
import type { InReason, OutReason } from "@/lib/store";
import type { Product, Position } from "@/lib/store";

function CargaStock({ refresh }: { refresh: () => void }) {
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{imported:number;skipped:number;totalUnits:number}|null>(null);
  const [imported, setImported] = useState(false);
  const [,setTick] = useState(0);
  const positions = activePositions().filter(p => p.id !== "SIN_ASIGNAR");

  useEffect(() => { setImported(wasStockImported()); }, []);

  const doImport = async () => {
    if (!confirm("Esto importará las unidades de la columna K de tu Google Sheet y las dejará en posición 'SIN_ASIGNAR' para que luego les asignes ubicación.\n\n¿Continuar?")) return;
    setImporting(true);
    const result = await importStockFromSheet();
    setImportResult(result);
    setImported(true);
    setImporting(false);
    refresh();
  };

  const unassigned = getUnassignedStock();
  const totalUnassigned = unassigned.reduce((s, u) => s + u.qty, 0);

  // Split assign state: each SKU can have multiple {pos, qty} rows
  const [splits, setSplits] = useState<Record<string, {pos:string;qty:number}[]>>({});

  return (
    <div>
      {/* Step 1: Import */}
      <div className="card">
        <div className="card-title">Paso 1 — Importar stock desde Google Sheet</div>
        {!imported ? (
          <div>
            <p style={{fontSize:12,color:"var(--txt2)",marginBottom:12,lineHeight:1.6}}>
              Lee la columna K (unidades) de tu Sheet sincronizado y carga el stock actual de cada SKU.
              Las unidades quedarán en posición "SIN_ASIGNAR" hasta que les asignes ubicación en el Paso 2.
            </p>
            <button onClick={doImport} disabled={importing}
              style={{width:"100%",padding:14,borderRadius:10,background:importing?"var(--bg3)":"var(--green)",color:importing?"var(--txt3)":"#fff",fontWeight:700,fontSize:14}}>
              {importing ? "Importando..." : "Importar stock desde Sheet"}
            </button>
          </div>
        ) : (
          <div>
            <div style={{padding:"10px 14px",background:"var(--greenBg)",border:"1px solid var(--greenBd)",borderRadius:8,fontSize:12}}>
              <span style={{color:"var(--green)",fontWeight:700}}>Stock importado</span>
              {importResult && <span style={{color:"var(--txt2)",marginLeft:8}}>— {importResult.imported} SKUs, {importResult.totalUnits.toLocaleString()} unidades</span>}
            </div>
            <button onClick={()=>{
              if(!confirm("Reimportar? Esto reemplazará el stock en SIN_ASIGNAR con los datos actuales del Sheet (no duplica)."))return;
              if(typeof window!=="undefined")localStorage.removeItem("banva_stock_imported");
              setImported(false);setImportResult(null);
            }} style={{marginTop:8,padding:"6px 14px",borderRadius:6,background:"var(--bg3)",color:"var(--amber)",fontSize:11,fontWeight:600,border:"1px solid var(--bg4)"}}>
              Reimportar (seguro, no duplica)
            </button>
          </div>
        )}
      </div>

      {/* Step 2: Assign positions */}
      {unassigned.length > 0 && (
        <div className="card" style={{marginTop:12}}>
          <div className="card-title">Paso 2 — Asignar posiciones ({unassigned.length} SKUs, {totalUnassigned.toLocaleString()} uds sin ubicación)</div>

          {/* Quick assign all to same position */}
          <div style={{padding:"10px 14px",background:"var(--bg2)",borderRadius:8,marginBottom:12,display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
            <span style={{fontSize:11,fontWeight:600,color:"var(--txt3)"}}>Asignar todos (100%) a una posición:</span>
            <select className="form-select" id="bulkPos" style={{fontSize:11,padding:6,flex:"1",maxWidth:200}}>
              <option value="">— Posición —</option>
              {positions.map(p=><option key={p.id} value={p.id}>{p.id} — {p.label}</option>)}
            </select>
            <button onClick={()=>{
              const sel = (document.getElementById("bulkPos") as HTMLSelectElement)?.value;
              if(!sel) return;
              const newA: Record<string, {pos:string;qty:number}[]> = {};
              unassigned.forEach(u => { newA[u.sku] = [{pos:sel,qty:u.qty}]; });
              setSplits(newA);
            }} style={{padding:"6px 14px",borderRadius:6,background:"var(--blue)",color:"#fff",fontSize:11,fontWeight:700}}>Aplicar a todos</button>
          </div>

          {/* Confirm all button */}
          {(() => {
            const ready = unassigned.filter(u => {
              const sp = splits[u.sku];
              if(!sp || sp.length===0) return false;
              const total = sp.reduce((s,r)=>s+r.qty,0);
              return total === u.qty && sp.every(r=>r.pos && r.qty>0);
            });
            return ready.length > 0 ? (
              <button onClick={()=>{
                if(!confirm(`Asignar ${ready.length} SKUs a sus posiciones?`))return;
                let count=0;
                ready.forEach(u=>{
                  const sp = splits[u.sku];
                  sp.forEach(r=>{ if(assignPosition(u.sku,r.pos,r.qty)) count++; });
                });
                setSplits({});setTick(t=>t+1);refresh();
                alert(`${count} asignaciones realizadas`);
              }} style={{width:"100%",padding:12,borderRadius:10,background:"var(--green)",color:"#fff",fontWeight:700,fontSize:13,marginBottom:12}}>
                Confirmar {ready.length} SKUs listos para asignar
              </button>
            ) : null;
          })()}

          {/* SKU list */}
          {unassigned.map(u => {
            const sp = splits[u.sku] || [];
            const assigned = sp.reduce((s,r)=>s+r.qty,0);
            const remaining = u.qty - assigned;
            const isComplete = remaining === 0 && sp.every(r=>r.pos && r.qty>0);
            const isOver = remaining < 0;

            return (
              <div key={u.sku} style={{padding:"12px 14px",marginBottom:8,borderRadius:8,background:isComplete?"var(--greenBg)":isOver?"var(--redBg)":"var(--bg2)",border:`1px solid ${isComplete?"var(--greenBd)":isOver?"var(--red)":"var(--bg3)"}`}}>
                {/* Header */}
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:sp.length>0?8:0}}>
                  <div>
                    <span className="mono" style={{fontWeight:700,fontSize:13}}>{u.sku}</span>
                    <span style={{fontSize:11,color:"var(--txt3)",marginLeft:8}}>{u.name}</span>
                  </div>
                  <div style={{textAlign:"right"}}>
                    <span className="mono" style={{fontWeight:700,color:"var(--blue)",fontSize:15}}>{u.qty}</span>
                    <span style={{fontSize:10,color:"var(--txt3)",marginLeft:4}}>uds</span>
                    {sp.length > 0 && remaining !== 0 && (
                      <div style={{fontSize:10,color:isOver?"var(--red)":"var(--amber)",fontWeight:600}}>
                        {isOver ? `${Math.abs(remaining)} de más` : `${remaining} sin asignar`}
                      </div>
                    )}
                    {isComplete && <div style={{fontSize:10,color:"var(--green)",fontWeight:700}}>Listo</div>}
                  </div>
                </div>

                {/* Split rows */}
                {sp.map((row, idx) => (
                  <div key={idx} style={{display:"flex",gap:6,alignItems:"center",marginBottom:4}}>
                    <select className="form-select" value={row.pos} onChange={e=>{
                      const n=[...sp]; n[idx]={...n[idx],pos:e.target.value}; setSplits(s=>({...s,[u.sku]:n}));
                    }} style={{fontSize:11,padding:6,flex:1}}>
                      <option value="">Posición...</option>
                      {positions.map(p=><option key={p.id} value={p.id}>{p.id} — {p.label}</option>)}
                    </select>
                    <input type="number" min={1} max={u.qty} value={row.qty||""} onFocus={e=>e.target.select()} onChange={e=>{
                      const n=[...sp]; n[idx]={...n[idx],qty:Math.max(0,parseInt(e.target.value)||0)}; setSplits(s=>({...s,[u.sku]:n}));
                    }} style={{width:70,textAlign:"center",padding:6,borderRadius:6,border:"1px solid var(--bg4)",background:"var(--bg1)",color:"var(--txt1)",fontSize:12,fontWeight:700}} placeholder="Cant"/>
                    <button onClick={()=>{
                      const n=sp.filter((_,i)=>i!==idx); setSplits(s=>({...s,[u.sku]:n}));
                    }} style={{padding:"4px 8px",borderRadius:4,background:"var(--bg3)",color:"var(--red)",fontSize:12,fontWeight:700,border:"1px solid var(--bg4)"}}>✕</button>
                  </div>
                ))}

                {/* Add row / quick buttons */}
                <div style={{display:"flex",gap:6,marginTop:sp.length>0?4:0,flexWrap:"wrap"}}>
                  {sp.length === 0 && (
                    <button onClick={()=>{
                      setSplits(s=>({...s,[u.sku]:[{pos:"",qty:u.qty}]}));
                    }} style={{padding:"6px 12px",borderRadius:6,background:"var(--bg3)",color:"var(--blue)",fontSize:11,fontWeight:600,border:"1px solid var(--bg4)"}}>
                      Todo a 1 posición
                    </button>
                  )}
                  <button onClick={()=>{
                    const defQty = Math.max(0, remaining);
                    setSplits(s=>({...s,[u.sku]:[...sp,{pos:"",qty:defQty}]}));
                  }} style={{padding:"6px 12px",borderRadius:6,background:"var(--bg3)",color:"var(--txt2)",fontSize:11,fontWeight:600,border:"1px solid var(--bg4)"}}>
                    + Dividir en otra posición
                  </button>
                  {isComplete && (
                    <button onClick={()=>{
                      sp.forEach(r=>{ assignPosition(u.sku,r.pos,r.qty); });
                      setSplits(s=>{const n={...s};delete n[u.sku];return n;});
                      setTick(t=>t+1);refresh();
                    }} style={{padding:"6px 14px",borderRadius:6,background:"var(--green)",color:"#fff",fontSize:11,fontWeight:700,marginLeft:"auto"}}>
                      Asignar
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {imported && unassigned.length === 0 && (
        <div className="card" style={{marginTop:12,textAlign:"center",padding:24}}>
          <div style={{fontSize:16,fontWeight:700,color:"var(--green)",marginBottom:4}}>Todo el stock tiene posición asignada</div>
          <div style={{fontSize:12,color:"var(--txt3)"}}>Puedes ver el inventario completo en la pestaña Inventario</div>
        </div>
      )}

      {/* Bulk paste with positions */}
      <CargaMasivaPosiciones refresh={refresh} />

      {/* Export / Import CSV */}
      <ExportImportCSV refresh={refresh} />
    </div>
  );
}

function CargaMasivaPosiciones({ refresh }: { refresh: () => void }) {
  const [pasteText, setPasteText] = useState("");
  const [parsed, setParsed] = useState<{pos:string;sku:string;qty:number;name:string;valid:boolean;error?:string}[]>([]);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ok:number;err:number}|null>(null);

  const doParse = () => {
    if (!pasteText.trim()) return;
    const lines = pasteText.split("\n").map(l => l.trim()).filter(l => l.length > 0);
    const items: typeof parsed = [];
    const s = getStore();
    const posSet = new Set(activePositions().map(p => p.id));

    for (const line of lines) {
      // Support tab, comma, semicolon, or multiple spaces as separator
      const parts = line.split(/[\t,;]+|\s{2,}/).map(p => p.trim()).filter(p => p);
      if (parts.length < 3) {
        items.push({ pos: "", sku: line, qty: 0, name: "", valid: false, error: "Formato: Posición | SKU | Cantidad" });
        continue;
      }
      const pos = parts[0].toUpperCase();
      const sku = parts[1].toUpperCase();
      const qty = parseInt(parts[2]) || 0;

      const prod = s.products[sku];
      const errors: string[] = [];
      if (!posSet.has(pos)) errors.push(`Posición "${pos}" no existe`);
      if (!prod) errors.push(`SKU "${sku}" no encontrado`);
      if (qty <= 0) errors.push("Cantidad inválida");

      items.push({
        pos, sku, qty, name: prod?.name || "?",
        valid: errors.length === 0, error: errors.join(", "),
      });
    }
    setParsed(items);
    setResult(null);
  };

  const doImport = async () => {
    const valid = parsed.filter(p => p.valid);
    if (valid.length === 0) return;
    if (!confirm(`Importar ${valid.length} líneas de stock con posición asignada?\n\nEsto AGREGA al stock existente (no reemplaza).`)) return;
    setLoading(true);
    let ok = 0, err = 0;
    for (const item of valid) {
      try {
        recordMovement({
          ts: new Date().toISOString(), type: "in", reason: "ajuste_entrada" as InReason,
          sku: item.sku, pos: item.pos, qty: item.qty,
          who: "Admin", note: "Carga masiva con posición",
        });
        ok++;
      } catch { err++; }
    }
    setResult({ ok, err });
    setLoading(false);
    setPasteText("");
    setParsed([]);
    refresh();
  };

  const validCount = parsed.filter(p => p.valid).length;
  const errorCount = parsed.filter(p => !p.valid).length;
  const totalUnits = parsed.filter(p => p.valid).reduce((s, p) => s + p.qty, 0);

  return (
    <div className="card" style={{marginTop:12}}>
      <div className="card-title">📋 Carga masiva con posiciones</div>
      <p style={{fontSize:12,color:"var(--txt3)",marginBottom:8,lineHeight:1.5}}>
        Pega datos con formato: <strong>Posición  SKU  Cantidad</strong> (separado por tab, coma o punto y coma). Una línea por entrada.
      </p>
      <div style={{padding:"8px 12px",background:"var(--bg2)",borderRadius:6,marginBottom:10,fontSize:11,fontFamily:"'JetBrains Mono',monospace",color:"var(--txt3)"}}>
        Ejemplo:<br/>
        1  SAB-180-BL  25<br/>
        1  ALM-VISCO  10<br/>
        3  TOA-70-GR  50<br/>
        E1-1  FUN-50-NE  12
      </div>
      <textarea
        value={pasteText} onChange={e => { setPasteText(e.target.value); setParsed([]); setResult(null); }}
        placeholder={"Posición\tSKU\tCantidad\n1\tSAB-180-BL\t25\n3\tTOA-70-GR\t50"}
        style={{width:"100%",minHeight:120,padding:10,borderRadius:8,border:"1px solid var(--bg4)",background:"var(--bg1)",color:"var(--txt)",fontSize:12,fontFamily:"'JetBrains Mono',monospace",resize:"vertical",marginBottom:8}}
      />
      <div style={{display:"flex",gap:8,marginBottom:12}}>
        <button onClick={doParse} disabled={!pasteText.trim()}
          style={{flex:1,padding:10,borderRadius:8,fontWeight:700,fontSize:13,background:pasteText.trim()?"var(--cyan)":"var(--bg3)",color:pasteText.trim()?"#000":"var(--txt3)"}}>
          Previsualizar ({pasteText.split("\n").filter(l=>l.trim()).length} líneas)
        </button>
        {parsed.length > 0 && <button onClick={()=>{setPasteText("");setParsed([]);}} style={{padding:"10px 16px",borderRadius:8,background:"var(--bg3)",color:"var(--txt3)",fontSize:12,fontWeight:600,border:"1px solid var(--bg4)"}}>Limpiar</button>}
      </div>

      {result && (
        <div style={{padding:"10px 14px",background:"var(--greenBg)",border:"1px solid var(--greenBd)",borderRadius:8,marginBottom:12,fontSize:12}}>
          <span style={{color:"var(--green)",fontWeight:700}}>Importado: {result.ok} entradas, {totalUnits.toLocaleString()} unidades</span>
          {result.err > 0 && <span style={{color:"var(--red)",marginLeft:8}}>{result.err} errores</span>}
        </div>
      )}

      {parsed.length > 0 && (
        <>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
            <div style={{fontSize:11}}>
              <span style={{color:"var(--green)",fontWeight:700}}>{validCount} OK</span>
              {errorCount > 0 && <span style={{color:"var(--red)",fontWeight:700,marginLeft:8}}>{errorCount} errores</span>}
              <span style={{color:"var(--txt3)",marginLeft:8}}>({totalUnits.toLocaleString()} uds)</span>
            </div>
          </div>
          <div style={{maxHeight:300,overflow:"auto",border:"1px solid var(--bg4)",borderRadius:8,marginBottom:12}}>
            {parsed.map((p, i) => (
              <div key={i} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 10px",borderBottom:"1px solid var(--bg3)",background:p.valid?"transparent":"var(--redBg)",fontSize:11}}>
                <span style={{width:8,height:8,borderRadius:"50%",background:p.valid?"var(--green)":"var(--red)",flexShrink:0}}/>
                <span className="mono" style={{fontWeight:700,color:"var(--cyan)",minWidth:40}}>{p.pos}</span>
                <span className="mono" style={{fontWeight:700,minWidth:100}}>{p.sku}</span>
                <span style={{flex:1,color:"var(--txt3)"}}>{p.name}</span>
                <span className="mono" style={{fontWeight:700,color:"var(--blue)"}}>{p.qty}</span>
                {p.error && <span style={{color:"var(--red)",fontSize:10}}>⚠ {p.error}</span>}
              </div>
            ))}
          </div>
          {validCount > 0 && (
            <button onClick={doImport} disabled={loading}
              style={{width:"100%",padding:14,borderRadius:10,fontWeight:700,fontSize:14,color:"#fff",background:"linear-gradient(135deg,#059669,var(--green))",opacity:loading?0.5:1}}>
              {loading ? "Importando..." : `IMPORTAR ${validCount} líneas — ${totalUnits.toLocaleString()} unidades`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

// ==================== EXPORT / IMPORT CSV INVENTARIO ====================
function ExportImportCSV({ refresh }: { refresh: () => void }) {
  const [mode, setMode] = useState<"export"|"import">("export");
  const [importText, setImportText] = useState("");
  const [parsed, setParsed] = useState<{sku:string;name:string;stock:number;pos:string;valid:boolean;error?:string;isNew?:boolean}[]>([]);
  const [importMode, setImportMode] = useState<"add"|"replace">("add");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ok:number;err:number;units:number}|null>(null);

  const doExport = () => {
    const s = getStore();
    const rows: string[] = [];
    rows.push(["sku_origen","nombre","sku_venta","etiquetado","unidades_pack","stock","posicion"].join(","));

    for (const [sku, svMap] of Object.entries(s.stockDetalle)) {
      const prod = s.products[sku];
      const name = prod?.name || "";
      const ventas = getVentasPorSkuOrigen(sku);

      for (const [skuVenta, posMap] of Object.entries(svMap)) {
        for (const [pos, qty] of Object.entries(posMap)) {
          if (qty <= 0) continue;
          const isSinEtiquetar = skuVenta === SIN_ETIQUETAR;
          const venta = ventas.find(v => v.skuVenta === skuVenta);
          rows.push([
            csvEscape(sku),
            csvEscape(name),
            csvEscape(isSinEtiquetar ? "" : skuVenta),
            isSinEtiquetar ? "Sin etiquetar" : "Etiquetado",
            venta ? String(venta.unidades) : "",
            String(qty),
            csvEscape(pos),
          ].join(","));
        }
      }
    }

    // SKUs in stock but not in stockDetalle (fallback)
    for (const [sku, posMap] of Object.entries(s.stock)) {
      if (s.stockDetalle[sku]) continue;
      const prod = s.products[sku];
      for (const [pos, qty] of Object.entries(posMap)) {
        if (qty <= 0) continue;
        rows.push([
          csvEscape(sku),
          csvEscape(prod?.name || ""),
          "",
          "Sin etiquetar",
          "",
          String(qty),
          csvEscape(pos),
        ].join(","));
      }
    }

    const csv = rows.join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `banva_inventario_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const doExportSimple = () => {
    // Simplified: one row per (sku, pos), ventas joined
    const s = getStore();
    const rows: string[] = [];
    rows.push(["sku_origen","nombre","stock","posicion"].join(","));

    for (const [sku, posMap] of Object.entries(s.stock)) {
      const prod = s.products[sku];
      for (const [pos, qty] of Object.entries(posMap)) {
        if (qty <= 0) continue;
        rows.push([csvEscape(sku), csvEscape(prod?.name || ""), String(qty), csvEscape(pos)].join(","));
      }
    }

    const csv = rows.join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `banva_stock_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const doParse = () => {
    if (!importText.trim()) return;
    const lines = importText.split("\n").map(l => l.trim()).filter(l => l.length > 0);
    const items: typeof parsed = [];
    const s = getStore();
    const posSet = new Set(activePositions().map(p => p.id));
    posSet.add("SIN_ASIGNAR");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Skip header row
      if (i === 0 && /sku_origen|sku|nombre/i.test(line)) continue;

      // Parse CSV (handle quoted fields)
      const parts = parseCSVLine(line);
      
      // We need at minimum: sku_origen, and stock, posicion 
      // Full format: sku_origen, nombre, unidades, codigo_ml, sku_venta, stock, posicion
      // Simple format: sku_origen, stock, posicion  OR  sku_origen, nombre, stock, posicion
      let sku = "", name = "", stock = 0, pos = "";

      if (parts.length >= 7) {
        // Full format: sku_origen, nombre, unidades, codigo_ml, sku_venta, stock, posicion
        sku = parts[0].toUpperCase().trim();
        name = parts[1].trim();
        stock = parseInt(parts[5]) || 0;
        pos = parts[6].toUpperCase().trim();
      } else if (parts.length >= 4) {
        // 4-col: sku_origen, nombre, stock, posicion
        sku = parts[0].toUpperCase().trim();
        name = parts[1].trim();
        stock = parseInt(parts[2]) || 0;
        pos = parts[3].toUpperCase().trim();
      } else if (parts.length >= 3) {
        // 3-col: sku_origen, stock, posicion  OR  posicion, sku, stock (legacy)
        const maybeQty = parseInt(parts[2]);
        const maybeQty1 = parseInt(parts[1]);
        if (!isNaN(maybeQty) && isNaN(maybeQty1)) {
          // sku, ???, stock → sku, posicion, stock? or sku, stock, posicion?
          // Check if parts[2] looks like a number and parts[1] like a position
          if (posSet.has(parts[1].toUpperCase().trim())) {
            // sku, posicion, stock
            sku = parts[0].toUpperCase().trim();
            pos = parts[1].toUpperCase().trim();
            stock = maybeQty;
          } else {
            // sku, stock, posicion
            sku = parts[0].toUpperCase().trim();
            stock = parseInt(parts[1]) || 0;
            pos = parts[2].toUpperCase().trim();
          }
        } else if (!isNaN(maybeQty1)) {
          // posicion, sku, stock (legacy format)
          pos = parts[0].toUpperCase().trim();
          sku = parts[1].toUpperCase().trim();
          stock = maybeQty;
        } else {
          sku = parts[0].toUpperCase().trim();
          stock = parseInt(parts[1]) || 0;
          pos = parts[2].toUpperCase().trim();
        }
      } else {
        items.push({ sku: line, name: "", stock: 0, pos: "", valid: false, error: "Formato no reconocido" });
        continue;
      }

      const prod = s.products[sku];
      const errors: string[] = [];
      if (!sku) errors.push("SKU vacío");
      if (!prod) errors.push(`SKU "${sku}" no existe`);
      if (stock <= 0) errors.push("Stock inválido");
      if (!pos) errors.push("Posición vacía");
      if (pos && !posSet.has(pos)) errors.push(`Posición "${pos}" no existe`);

      items.push({
        sku, name: name || prod?.name || "?", stock, pos,
        valid: errors.length === 0, error: errors.join(", "),
        isNew: !prod,
      });
    }
    setParsed(items);
    setResult(null);
  };

  const doImport = async () => {
    const valid = parsed.filter(p => p.valid);
    if (valid.length === 0) return;
    const totalUnits = valid.reduce((s, p) => s + p.stock, 0);
    
    const modeText = importMode === "replace" 
      ? "⚠️ REEMPLAZAR: Se borrará TODO el stock actual y se cargará solo lo del CSV."
      : "AGREGAR: Se sumará el stock del CSV al existente.";
    
    if (!confirm(`${modeText}\n\n${valid.length} líneas, ${totalUnits.toLocaleString()} unidades.\n\n¿Continuar?`)) return;
    
    setLoading(true);
    let ok = 0, err = 0;

    if (importMode === "replace") {
      // Clear ALL existing stock first
      const s = getStore();
      for (const [sku, posMap] of Object.entries(s.stock)) {
        for (const [pos, qty] of Object.entries(posMap)) {
          if (qty > 0) {
            recordMovement({
              ts: new Date().toISOString(), type: "out", reason: "ajuste_salida" as OutReason,
              sku, pos, qty, who: "Admin", note: "CSV import — reset stock",
            });
          }
        }
      }
    }

    // Now add all lines
    for (const item of valid) {
      try {
        recordMovement({
          ts: new Date().toISOString(), type: "in", reason: "ajuste_entrada" as InReason,
          sku: item.sku, pos: item.pos, qty: item.stock,
          who: "Admin", note: `CSV import${importMode === "replace" ? " (reemplazo)" : ""}`,
        });
        ok++;
      } catch { err++; }
    }

    setResult({ ok, err, units: totalUnits });
    setLoading(false);
    setImportText("");
    setParsed([]);
    refresh();
  };

  const validCount = parsed.filter(p => p.valid).length;
  const errorCount = parsed.filter(p => !p.valid).length;
  const totalUnits = parsed.filter(p => p.valid).reduce((s, p) => s + p.stock, 0);

  // Count current stock for export info
  const s = getStore();
  const stockEntries = Object.entries(s.stock).reduce((count, [, posMap]) => 
    count + Object.values(posMap).filter(q => q > 0).length, 0);
  const totalStockUnits = Object.values(s.stock).reduce((total, posMap) => 
    total + Object.values(posMap).reduce((s, q) => s + Math.max(0, q), 0), 0);

  return (
    <div className="card" style={{marginTop:12}}>
      <div className="card-title">📤📥 Exportar / Importar CSV</div>
      
      <div style={{display:"flex",gap:4,marginBottom:12}}>
        <button onClick={()=>{setMode("export");setParsed([]);setResult(null);}}
          style={{flex:1,padding:10,borderRadius:8,fontWeight:700,fontSize:13,
            background:mode==="export"?"var(--cyan)":"var(--bg3)",
            color:mode==="export"?"#000":"var(--txt3)",
            border:`1px solid ${mode==="export"?"var(--cyan)":"var(--bg4)"}`}}>
          📤 Exportar
        </button>
        <button onClick={()=>{setMode("import");setResult(null);}}
          style={{flex:1,padding:10,borderRadius:8,fontWeight:700,fontSize:13,
            background:mode==="import"?"var(--green)":"var(--bg3)",
            color:mode==="import"?"#fff":"var(--txt3)",
            border:`1px solid ${mode==="import"?"var(--green)":"var(--bg4)"}`}}>
          📥 Importar
        </button>
      </div>

      {mode === "export" && (
        <div>
          <div style={{padding:"10px 14px",background:"var(--bg2)",borderRadius:8,marginBottom:12,fontSize:12,color:"var(--txt2)",lineHeight:1.6}}>
            <strong>{stockEntries}</strong> registros · <strong>{totalStockUnits.toLocaleString()}</strong> unidades totales
          </div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            <button onClick={doExport}
              style={{flex:1,padding:12,borderRadius:8,fontWeight:700,fontSize:13,
                background:"var(--cyan)",color:"#000",minWidth:160}}>
              📤 Completo (con ventas ML)
            </button>
            <button onClick={doExportSimple}
              style={{flex:1,padding:12,borderRadius:8,fontWeight:700,fontSize:13,
                background:"var(--bg3)",color:"var(--cyan)",border:"1px solid var(--cyan)33",minWidth:160}}>
              📤 Simple (SKU + stock + pos)
            </button>
          </div>
          <div style={{marginTop:8,fontSize:10,color:"var(--txt3)",lineHeight:1.5}}>
            <strong>Completo:</strong> sku_origen, nombre, sku_venta, etiquetado, unidades_pack, stock, posicion<br/>
            <strong>Simple:</strong> sku_origen, nombre, stock, posicion
          </div>
        </div>
      )}

      {mode === "import" && (
        <div>
          <div style={{marginBottom:10}}>
            <div style={{fontSize:11,fontWeight:700,marginBottom:6}}>Modo de importación:</div>
            <div style={{display:"flex",gap:6}}>
              <button onClick={()=>setImportMode("add")}
                style={{flex:1,padding:"8px 12px",borderRadius:6,fontSize:12,fontWeight:700,
                  background:importMode==="add"?"var(--greenBg)":"var(--bg3)",
                  color:importMode==="add"?"var(--green)":"var(--txt3)",
                  border:`1px solid ${importMode==="add"?"var(--green)33":"var(--bg4)"}`}}>
                ➕ Agregar al existente
              </button>
              <button onClick={()=>setImportMode("replace")}
                style={{flex:1,padding:"8px 12px",borderRadius:6,fontSize:12,fontWeight:700,
                  background:importMode==="replace"?"var(--amberBg)":"var(--bg3)",
                  color:importMode==="replace"?"var(--amber)":"var(--txt3)",
                  border:`1px solid ${importMode==="replace"?"var(--amber)33":"var(--bg4)"}`}}>
                🔄 Reemplazar todo
              </button>
            </div>
            {importMode === "replace" && (
              <div style={{marginTop:6,padding:"6px 10px",background:"var(--amberBg)",borderRadius:6,fontSize:10,color:"var(--amber)",lineHeight:1.5}}>
                ⚠️ Reemplazar borra TODO el stock actual y carga solo lo del CSV. Úsalo para un conteo completo de inventario.
              </div>
            )}
          </div>

          <p style={{fontSize:11,color:"var(--txt3)",marginBottom:6,lineHeight:1.5}}>
            Pega CSV o datos separados por tab/coma. Acepta formato completo (7 cols) o simple (3-4 cols). La primera fila de encabezado se ignora automáticamente.
          </p>
          <div style={{padding:"6px 10px",background:"var(--bg2)",borderRadius:6,marginBottom:8,fontSize:10,fontFamily:"'JetBrains Mono',monospace",color:"var(--txt3)"}}>
            sku_origen, nombre, unidades, codigo_ml, sku_venta, stock, posicion<br/>
            SAB-180-BL, Sábana 180 Blanca, 1, MLC123, PACK-SAB, 25, 1<br/>
            — o simplemente —<br/>
            SAB-180-BL, 25, 1
          </div>

          <div style={{display:"flex",gap:6,marginBottom:8}}>
            <textarea
              value={importText} onChange={e => { setImportText(e.target.value); setParsed([]); setResult(null); }}
              placeholder="Pega datos CSV aquí..."
              style={{flex:1,minHeight:120,padding:10,borderRadius:8,border:"1px solid var(--bg4)",background:"var(--bg1)",color:"var(--txt)",fontSize:12,fontFamily:"'JetBrains Mono',monospace",resize:"vertical"}}
            />
          </div>

          {/* Upload CSV file */}
          <div style={{display:"flex",gap:8,marginBottom:12}}>
            <label style={{flex:1,padding:10,borderRadius:8,background:"var(--bg3)",color:"var(--txt2)",fontSize:12,fontWeight:600,textAlign:"center",cursor:"pointer",border:"1px dashed var(--bg4)"}}>
              📎 Subir archivo CSV
              <input type="file" accept=".csv,.txt,.tsv" hidden onChange={e => {
                const file = e.target.files?.[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = ev => {
                  const text = ev.target?.result as string;
                  setImportText(text);
                  setParsed([]);
                  setResult(null);
                };
                reader.readAsText(file);
                e.target.value = "";
              }}/>
            </label>
            <button onClick={doParse} disabled={!importText.trim()}
              style={{padding:"10px 20px",borderRadius:8,fontWeight:700,fontSize:13,
                background:importText.trim()?"var(--cyan)":"var(--bg3)",
                color:importText.trim()?"#000":"var(--txt3)"}}>
              Previsualizar
            </button>
          </div>

          {result && (
            <div style={{padding:"10px 14px",background:"var(--greenBg)",border:"1px solid var(--greenBd)",borderRadius:8,marginBottom:12,fontSize:12}}>
              <span style={{color:"var(--green)",fontWeight:700}}>
                ✓ Importado: {result.ok} líneas, {result.units.toLocaleString()} unidades
                {importMode === "replace" && " (stock anterior reemplazado)"}
              </span>
              {result.err > 0 && <span style={{color:"var(--red)",marginLeft:8}}>{result.err} errores</span>}
            </div>
          )}

          {parsed.length > 0 && (
            <>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                <div style={{fontSize:11}}>
                  <span style={{color:"var(--green)",fontWeight:700}}>{validCount} OK</span>
                  {errorCount > 0 && <span style={{color:"var(--red)",fontWeight:700,marginLeft:8}}>{errorCount} errores</span>}
                  <span style={{color:"var(--txt3)",marginLeft:8}}>({totalUnits.toLocaleString()} uds)</span>
                </div>
                <button onClick={()=>{setParsed([]);setImportText("");}}
                  style={{padding:"4px 10px",borderRadius:4,background:"var(--bg3)",color:"var(--txt3)",fontSize:10,fontWeight:600,border:"1px solid var(--bg4)"}}>Limpiar</button>
              </div>
              <div style={{maxHeight:300,overflow:"auto",border:"1px solid var(--bg4)",borderRadius:8,marginBottom:12}}>
                {parsed.map((p, i) => (
                  <div key={i} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 10px",borderBottom:"1px solid var(--bg3)",background:p.valid?"transparent":"var(--redBg)",fontSize:11}}>
                    <span style={{width:8,height:8,borderRadius:"50%",background:p.valid?"var(--green)":"var(--red)",flexShrink:0}}/>
                    <span className="mono" style={{fontWeight:700,minWidth:100}}>{p.sku}</span>
                    <span style={{flex:1,color:"var(--txt3)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.name}</span>
                    <span className="mono" style={{fontWeight:700,color:"var(--blue)",minWidth:36,textAlign:"right"}}>{p.stock}</span>
                    <span className="mono" style={{fontWeight:600,color:"var(--cyan)",minWidth:40}}>{p.pos}</span>
                    {p.error && <span style={{color:"var(--red)",fontSize:9}}>⚠ {p.error}</span>}
                  </div>
                ))}
              </div>
              {validCount > 0 && (
                <button onClick={doImport} disabled={loading}
                  style={{width:"100%",padding:14,borderRadius:10,fontWeight:700,fontSize:14,color:"#fff",
                    background:importMode==="replace"
                      ?"linear-gradient(135deg,#d97706,#f59e0b)"
                      :"linear-gradient(135deg,#059669,var(--green))",
                    opacity:loading?0.5:1}}>
                  {loading ? "Importando..." 
                    : importMode==="replace" 
                      ? `🔄 REEMPLAZAR stock — ${validCount} líneas, ${totalUnits.toLocaleString()} uds`
                      : `➕ AGREGAR ${validCount} líneas — ${totalUnits.toLocaleString()} uds`
                  }
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function csvEscape(val: string): string {
  if (!val) return "";
  if (val.includes(",") || val.includes('"') || val.includes("\n")) {
    return '"' + val.replace(/"/g, '""') + '"';
  }
  return val;
}

function parseCSVLine(line: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i+1] === '"') { current += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else current += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === "," || ch === "\t" || ch === ";") { parts.push(current); current = ""; }
      else current += ch;
    }
  }
  parts.push(current);
  return parts;
}


export default CargaStock;
