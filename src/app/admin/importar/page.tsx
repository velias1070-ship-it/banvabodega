"use client";
import { useState, useEffect } from "react";
import { getStore, updateStore, PROVEEDORES, CATEGORIAS } from "@/lib/store";
import type { SKUData } from "@/lib/store";
import Link from "next/link";

interface ImportRow { sku:string;desc:string;cat:string;prov:string;cost:number;price:number;reorder:number;mlCode:string;valid:boolean;error?:string; }

function parseCSV(text: string): string[][] {
  const lines = text.split("\n").map(l => l.trim()).filter(l => l.length > 0);
  return lines.map(l => {
    const cells: string[] = [];
    let current = "", inQuotes = false;
    for (let i = 0; i < l.length; i++) {
      const ch = l[i];
      if (ch === '"') { inQuotes = !inQuotes; }
      else if ((ch === ',' || ch === ';' || ch === '\t') && !inQuotes) { cells.push(current.trim()); current = ""; }
      else { current += ch; }
    }
    cells.push(current.trim());
    return cells;
  });
}

export default function ImportarPage() {
  const [mounted, setMounted] = useState(false);
  const [csvText, setCsvText] = useState("");
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [imported, setImported] = useState(0);
  const [step, setStep] = useState<"input"|"preview"|"done">("input");

  useEffect(() => setMounted(true), []);

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => { setCsvText(ev.target?.result as string || ""); };
    reader.readAsText(file);
  };

  const preview = () => {
    const parsed = parseCSV(csvText);
    if (parsed.length < 2) { alert("El archivo necesita al menos una fila de encabezado y una de datos"); return; }
    const headers = parsed[0].map(h => h.toLowerCase().replace(/[^a-z]/g, ""));
    const iSku = headers.findIndex(h => h.includes("sku") || h === "codigo" || h === "code");
    const iDesc = headers.findIndex(h => h.includes("desc") || h.includes("nombre") || h.includes("name"));
    const iCat = headers.findIndex(h => h.includes("cat") || h.includes("tipo"));
    const iProv = headers.findIndex(h => h.includes("prov") || h.includes("supplier"));
    const iCost = headers.findIndex(h => h.includes("cost") || h.includes("costo"));
    const iPrice = headers.findIndex(h => h.includes("prec") || h.includes("price") || h.includes("precio"));
    const iReorder = headers.findIndex(h => h.includes("reor") || h.includes("minimo") || h.includes("min"));
    const iMl = headers.findIndex(h => h.includes("ml") || h.includes("mercadolibre") || h.includes("code128") || h.includes("barcode"));

    const db = getStore().db;
    const importRows: ImportRow[] = [];
    for (let i = 1; i < parsed.length; i++) {
      const r = parsed[i];
      const sku = iSku >= 0 ? r[iSku]?.toUpperCase().trim() : "";
      const desc = iDesc >= 0 ? r[iDesc]?.trim() : "";
      const cat = iCat >= 0 ? r[iCat]?.trim() : "Toallas";
      const prov = iProv >= 0 ? r[iProv]?.trim() : "Idetex";
      const cost = iCost >= 0 ? parseInt(r[iCost]?.replace(/[^0-9]/g, "")) || 0 : 0;
      const price = iPrice >= 0 ? parseInt(r[iPrice]?.replace(/[^0-9]/g, "")) || 0 : 0;
      const reorder = iReorder >= 0 ? parseInt(r[iReorder]) || 20 : 20;
      const mlCode = iMl >= 0 ? r[iMl]?.trim() : "";

      let valid = true, error = "";
      if (!sku) { valid = false; error = "Sin SKU"; }
      else if (db[sku]) { valid = false; error = "Ya existe"; }
      else if (!desc) { valid = false; error = "Sin descripcion"; }

      importRows.push({ sku, desc, cat, prov, cost, price, reorder, mlCode, valid, error });
    }
    setRows(importRows);
    setStep("preview");
  };

  const doImport = () => {
    const store = getStore();
    const db = store.db;
    let count = 0;
    for (const r of rows) {
      if (!r.valid) continue;
      db[r.sku] = { d: r.desc, cat: r.cat, prov: r.prov, cost: r.cost, price: r.price, locs: {}, transit: 0, full: 0, reorder: r.reorder, sales30: 0, mlCode: r.mlCode };
      count++;
    }
    updateStore({ db });
    setImported(count);
    setStep("done");
  };

  if (!mounted) return null;
  const validCount = rows.filter(r => r.valid).length;
  const invalidCount = rows.filter(r => !r.valid).length;

  return (
    <div className="app">
      <div className="topbar">
        <Link href="/admin"><button className="back-btn">&#8592; Admin</button></Link>
        <h1>Importar SKUs</h1>
        <div style={{fontSize:11,color:"var(--txt3)"}}>{Object.keys(getStore().db).length} SKUs actuales</div>
      </div>
      <div style={{padding:16}}>
        {step === "input" && <>
          <div className="card">
            <div className="card-title">Cargar archivo CSV</div>
            <input type="file" accept=".csv,.tsv,.txt" onChange={handleFile} style={{marginBottom:12,fontSize:13,color:"var(--txt2)"}}/>
            <div style={{fontSize:11,color:"var(--txt3)",marginBottom:12}}>O pega el contenido directamente:</div>
            <textarea className="form-input mono" value={csvText} onChange={e=>setCsvText(e.target.value)} placeholder={"SKU,Descripcion,Categoria,Proveedor,Costo,Precio,Reorden,CodigoML\nTOA-0099,Toalla Nueva,Toallas,Container,5200,14990,30,MLC-123456"} rows={8} style={{resize:"vertical",fontFamily:"'JetBrains Mono',monospace",fontSize:11,lineHeight:1.6}}/>
            <button className="btn-primary" onClick={preview} style={{marginTop:12}} disabled={!csvText.trim()}>Previsualizar</button>
          </div>
          <div className="card">
            <div className="card-title">Formato esperado</div>
            <div style={{fontSize:12,color:"var(--txt2)",lineHeight:1.7}}>
              <p>El sistema detecta automaticamente las columnas por nombre. Columnas soportadas:</p>
              <div style={{overflowX:"auto",marginTop:8}}>
              <table className="tbl">
                <thead><tr><th>Columna</th><th>Requerida</th><th>Ejemplo</th></tr></thead>
                <tbody>
                  <tr><td className="mono">SKU / Codigo</td><td style={{color:"var(--red)",fontWeight:700}}>Si</td><td className="mono">TOA-0099</td></tr>
                  <tr><td className="mono">Descripcion / Nombre</td><td style={{color:"var(--red)",fontWeight:700}}>Si</td><td className="mono">Toalla Diseno 099</td></tr>
                  <tr><td className="mono">Categoria / Tipo</td><td style={{color:"var(--txt3)"}}>No</td><td className="mono">Toallas</td></tr>
                  <tr><td className="mono">Proveedor / Supplier</td><td style={{color:"var(--txt3)"}}>No</td><td className="mono">Container</td></tr>
                  <tr><td className="mono">Costo / Cost</td><td style={{color:"var(--txt3)"}}>No</td><td className="mono">5200</td></tr>
                  <tr><td className="mono">Precio / Price</td><td style={{color:"var(--txt3)"}}>No</td><td className="mono">14990</td></tr>
                  <tr><td className="mono">Reorden / Min</td><td style={{color:"var(--txt3)"}}>No</td><td className="mono">30</td></tr>
                  <tr><td className="mono">CodigoML / Barcode</td><td style={{color:"var(--txt3)"}}>No</td><td className="mono">MLC-882734</td></tr>
                </tbody>
              </table>
              </div>
              <p style={{marginTop:8}}>Separadores: coma, punto y coma, o tab. El sistema detecta automaticamente.</p>
            </div>
          </div>
        </>}

        {step === "preview" && <>
          <div className="card">
            <div className="card-title">Preview - {rows.length} filas detectadas</div>
            <div style={{display:"flex",gap:10,marginBottom:12}}>
              <div style={{flex:1,padding:10,borderRadius:8,background:"var(--greenBg)",border:"1px solid var(--greenBd)",textAlign:"center"}}>
                <div style={{fontSize:10,color:"var(--green)",fontWeight:600}}>VALIDOS</div>
                <div className="mono" style={{fontSize:20,fontWeight:700,color:"var(--green)"}}>{validCount}</div>
              </div>
              {invalidCount > 0 && <div style={{flex:1,padding:10,borderRadius:8,background:"var(--redBg)",border:"1px solid var(--redBd)",textAlign:"center"}}>
                <div style={{fontSize:10,color:"var(--red)",fontWeight:600}}>ERRORES</div>
                <div className="mono" style={{fontSize:20,fontWeight:700,color:"var(--red)"}}>{invalidCount}</div>
              </div>}
            </div>
          </div>
          <div style={{overflowX:"auto"}}>
          <table className="tbl">
            <thead><tr><th></th><th>SKU</th><th>Desc</th><th>Cat</th><th>Prov</th><th>Costo</th><th>Precio</th></tr></thead>
            <tbody>{rows.slice(0,50).map((r,i) => (
              <tr key={i} style={{opacity:r.valid?1:0.5}}>
                <td>{r.valid?<span style={{color:"var(--green)"}}>OK</span>:<span style={{color:"var(--red)",fontSize:10}}>{r.error}</span>}</td>
                <td className="mono" style={{fontSize:11,fontWeight:600}}>{r.sku}</td>
                <td style={{fontSize:11}}>{r.desc}</td>
                <td style={{fontSize:10}}>{r.cat}</td>
                <td style={{fontSize:10}}>{r.prov}</td>
                <td className="mono" style={{fontSize:10}}>{r.cost}</td>
                <td className="mono" style={{fontSize:10}}>{r.price}</td>
              </tr>
            ))}</tbody>
          </table>
          </div>
          {rows.length>50&&<div style={{fontSize:11,color:"var(--txt3)",marginTop:8}}>Mostrando 50 de {rows.length} filas</div>}
          <div style={{display:"flex",gap:8,marginTop:16}}>
            <button onClick={()=>{setStep("input");setRows([]);}} style={{flex:1,padding:12,borderRadius:"var(--radius)",background:"var(--bg3)",color:"var(--txt2)",fontWeight:600,fontSize:13,border:"1px solid var(--bg4)"}}>Volver</button>
            <button className="btn-primary" style={{flex:2}} onClick={doImport} disabled={validCount===0}>Importar {validCount} SKUs</button>
          </div>
        </>}

        {step === "done" && <div className="card" style={{textAlign:"center",padding:32}}>
          <div style={{fontSize:48,marginBottom:12}}>{"✅"}</div>
          <div style={{fontSize:20,fontWeight:700,marginBottom:8}}>{imported} SKUs importados</div>
          <div style={{fontSize:13,color:"var(--txt2)",marginBottom:16}}>Total en sistema: {Object.keys(getStore().db).length} SKUs</div>
          <div style={{display:"flex",gap:8}}>
            <button onClick={()=>{setStep("input");setCsvText("");setRows([]);}} style={{flex:1,padding:12,borderRadius:"var(--radius)",background:"var(--bg3)",color:"var(--txt2)",fontWeight:600,fontSize:13,border:"1px solid var(--bg4)"}}>Importar mas</button>
            <Link href="/admin" style={{flex:1}}><button className="btn-primary">Ir a Admin</button></Link>
          </div>
        </div>}
      </div>
    </div>
  );
}