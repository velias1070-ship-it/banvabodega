"use client";
import React, { useState, useEffect, useCallback, useRef } from "react";
import { getStore, fmtMoney, getSkusVenta, getComponentesPorSkuVenta, getVentasPorSkuOrigen, findProduct, getRecepcionesActivas, getRecepcionLineas, actualizarLineaRecepcion, getRecepciones } from "@/lib/store";
import type { Product, DBRecepcionLinea } from "@/lib/store";
import { fetchActiveFlexShipments } from "@/lib/db";
import type { ShipmentWithItems } from "@/lib/db";

// ==================== ADMIN ETIQUETAS ====================
function AdminEtiquetas() {
  const [subTab, setSubTab] = useState<"productos"|"bultos">("productos");

  return (
    <div>
      <div style={{display:"flex",gap:8,marginBottom:16}}>
        <button onClick={()=>setSubTab("productos")} style={{padding:"8px 18px",borderRadius:8,background:subTab==="productos"?"var(--cyan)":"var(--bg3)",color:subTab==="productos"?"#fff":"var(--txt2)",fontWeight:subTab==="productos"?700:500,fontSize:13,border:subTab==="productos"?"none":"1px solid var(--bg4)",cursor:"pointer"}}>🏷️ Productos</button>
        <button onClick={()=>setSubTab("bultos")} style={{padding:"8px 18px",borderRadius:8,background:subTab==="bultos"?"var(--cyan)":"var(--bg3)",color:subTab==="bultos"?"#fff":"var(--txt2)",fontWeight:subTab==="bultos"?700:500,fontSize:13,border:subTab==="bultos"?"none":"1px solid var(--bg4)",cursor:"pointer"}}>📦 Bultos</button>
      </div>
      {subTab==="productos" && <EtiquetasProductos/>}
      {subTab==="bultos" && <EtiquetasBultos/>}
    </div>
  );
}

function EtiquetasBultos() {
  const [file, setFile] = useState<File|null>(null);
  const [previews, setPreviews] = useState<string[]>([]);
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [labelCount, setLabelCount] = useState(0);
  const [cols, setCols] = useState(3);
  const [rangeFrom, setRangeFrom] = useState("");
  const [rangeTo, setRangeTo] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const processFile = async (f: File) => {
    setFile(f);
    setPreviews([]);
    setLabelCount(0);
    setGenerating(true);
    setProgress(0);
    try {
      const pdfjsLib = await import("pdfjs-dist");
      pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.js";
      const arrayBuf = await f.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuf, disableAutoFetch: true, isEvalSupported: false }).promise;
      const numPages = pdf.numPages;
      const prevs: string[] = [];
      let total = 0;

      for (let p = 1; p <= numPages; p++) {
        const page = await pdf.getPage(p);
        const vp = page.getViewport({ scale: 2 });
        const canvas = document.createElement("canvas");
        canvas.width = vp.width;
        canvas.height = vp.height;
        const ctx = canvas.getContext("2d")!;
        await page.render({ canvasContext: ctx, viewport: vp }).promise;

        // Split into `cols` columns
        const colW = Math.floor(canvas.width / cols);
        for (let c = 0; c < cols; c++) {
          const crop = document.createElement("canvas");
          crop.width = colW;
          crop.height = canvas.height;
          const cctx = crop.getContext("2d")!;
          cctx.drawImage(canvas, c * colW, 0, colW, canvas.height, 0, 0, colW, canvas.height);

          // Check if this crop has content (not just white)
          const imgData = cctx.getImageData(0, 0, crop.width, crop.height);
          let nonWhite = 0;
          for (let i = 0; i < imgData.data.length; i += 16) {
            if (imgData.data[i] < 240 || imgData.data[i+1] < 240 || imgData.data[i+2] < 240) {
              nonWhite++;
              if (nonWhite > 100) break;
            }
          }
          if (nonWhite > 100) {
            prevs.push(crop.toDataURL("image/jpeg", 0.85));
            total++;
          }
        }
        setProgress(Math.round((p / numPages) * 50));
      }
      setPreviews(prevs);
      setLabelCount(total);
    } catch (e) {
      alert("Error procesando PDF: " + e);
    }
    setGenerating(false);
    setProgress(0);
  };

  const getFilteredPreviews = () => {
    const from = rangeFrom ? Math.max(1, parseInt(rangeFrom)) : 1;
    const to = rangeTo ? Math.min(previews.length, parseInt(rangeTo)) : previews.length;
    if (isNaN(from) || isNaN(to) || from > to || from > previews.length) return [];
    return previews.slice(from - 1, to);
  };

  const filteredCount = getFilteredPreviews().length;

  const generatePDF = async () => {
    const filtered = getFilteredPreviews();
    if (filtered.length === 0) return;
    setGenerating(true);
    setProgress(0);
    try {
      // @ts-ignore
      const { jsPDF } = await import("jspdf");
      // 10cm x 15cm = 100mm x 150mm, portrait
      const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: [100, 150] });

      for (let i = 0; i < filtered.length; i++) {
        if (i > 0) doc.addPage([100, 150], "portrait");

        const img = new Image();
        img.src = filtered[i];
        await new Promise<void>((resolve) => {
          if (img.complete) { resolve(); return; }
          img.onload = () => resolve();
        });

        // Fit image into 10x15cm maintaining aspect ratio
        const imgAspect = img.width / img.height;
        const pageAspect = 100 / 150;
        let w: number, h: number, x: number, y: number;

        if (imgAspect > pageAspect) {
          // Image is wider proportionally — fit to width
          w = 96; // 2mm margin each side
          h = w / imgAspect;
          x = 2;
          y = (150 - h) / 2;
        } else {
          // Image is taller — fit to height
          h = 146; // 2mm margin top/bottom
          w = h * imgAspect;
          x = (100 - w) / 2;
          y = 2;
        }

        doc.addImage(filtered[i], "JPEG", x, y, w, h);
        setProgress(Math.round(((i + 1) / filtered.length) * 100));
      }
      const fromLabel = rangeFrom ? parseInt(rangeFrom) : 1;
      const toLabel = rangeTo ? parseInt(rangeTo) : previews.length;
      const suffix = (rangeFrom || rangeTo) ? `_${fromLabel}-${toLabel}` : "";
      doc.save(`etiquetas_bultos_10x15${suffix}.pdf`);
    } catch (e) {
      alert("Error generando PDF: " + e);
    }
    setGenerating(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f && f.type === "application/pdf") processFile(f);
  };

  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
        <div>
          <h2 style={{fontSize:18,fontWeight:700,margin:0}}>📦 Etiquetas de Bultos</h2>
          <p style={{fontSize:12,color:"var(--txt3)",margin:0}}>Sube el PDF de MercadoLibre y genera etiquetas individuales de 10×15 cm</p>
        </div>
      </div>

      {/* Config: columns per page */}
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:16,padding:12,background:"var(--bg2)",borderRadius:10,border:"1px solid var(--bg3)"}}>
        <span style={{fontSize:12,fontWeight:600,color:"var(--txt2)"}}>Etiquetas por fila en PDF original:</span>
        {[2,3,4].map(n=>(
          <button key={n} onClick={()=>{setCols(n);if(file)processFile(file);}}
            style={{padding:"6px 14px",borderRadius:6,background:cols===n?"var(--cyan)":"var(--bg3)",color:cols===n?"#fff":"var(--txt2)",fontSize:13,fontWeight:cols===n?700:500,border:cols===n?"none":"1px solid var(--bg4)",cursor:"pointer"}}>
            {n}
          </button>
        ))}
      </div>

      {/* Upload zone */}
      <div
        onDrop={handleDrop}
        onDragOver={e=>e.preventDefault()}
        onClick={()=>fileRef.current?.click()}
        style={{padding:40,textAlign:"center",border:"2px dashed var(--bg4)",borderRadius:14,cursor:"pointer",background:"var(--bg2)",marginBottom:16,transition:"border-color 0.2s"}}
        onDragEnter={e=>{e.preventDefault();(e.currentTarget as HTMLElement).style.borderColor="var(--cyan)";}}
        onDragLeave={e=>{(e.currentTarget as HTMLElement).style.borderColor="var(--bg4)";}}
      >
        <input ref={fileRef} type="file" accept=".pdf" style={{display:"none"}} onChange={e=>{
          const f = e.target.files?.[0];
          if (f) processFile(f);
        }}/>
        <div style={{fontSize:40,marginBottom:8}}>📄</div>
        <div style={{fontSize:14,fontWeight:600,color:"var(--txt)"}}>
          {file ? file.name : "Arrastra o haz clic para subir el PDF de MercadoLibre"}
        </div>
        <div style={{fontSize:11,color:"var(--txt3)",marginTop:4}}>Solo archivos PDF</div>
      </div>

      {/* Progress bar */}
      {generating && (
        <div style={{marginBottom:16}}>
          <div style={{background:"var(--bg3)",borderRadius:8,height:8,overflow:"hidden"}}>
            <div style={{width:`${progress}%`,height:"100%",background:"var(--cyan)",borderRadius:8,transition:"width 0.2s"}}/>
          </div>
          <div style={{fontSize:11,color:"var(--txt3)",marginTop:4,textAlign:"center"}}>Procesando... {progress}%</div>
        </div>
      )}

      {/* Preview */}
      {previews.length > 0 && (
        <div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12,flexWrap:"wrap",gap:8}}>
            <div style={{fontSize:14,fontWeight:700}}>
              Vista previa — {labelCount} etiquetas detectadas
            </div>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <div style={{display:"flex",alignItems:"center",gap:6,padding:"6px 10px",background:"var(--bg2)",borderRadius:8,border:"1px solid var(--bg3)"}}>
                <span style={{fontSize:11,color:"var(--txt3)",whiteSpace:"nowrap"}}>Rango:</span>
                <input type="text" inputMode="numeric" placeholder="1" value={rangeFrom} onChange={e=>setRangeFrom(e.target.value.replace(/\D/g,""))}
                  style={{width:42,padding:"4px 6px",background:"var(--bg3)",border:"1px solid var(--bg4)",borderRadius:5,color:"var(--txt)",fontSize:12,textAlign:"center"}}/>
                <span style={{fontSize:11,color:"var(--txt3)"}}>a</span>
                <input type="text" inputMode="numeric" placeholder={String(previews.length)} value={rangeTo} onChange={e=>setRangeTo(e.target.value.replace(/\D/g,""))}
                  style={{width:42,padding:"4px 6px",background:"var(--bg3)",border:"1px solid var(--bg4)",borderRadius:5,color:"var(--txt)",fontSize:12,textAlign:"center"}}/>
                {(rangeFrom || rangeTo) && (
                  <button onClick={()=>{setRangeFrom("");setRangeTo("");}}
                    style={{padding:"2px 6px",background:"none",border:"none",color:"var(--txt3)",cursor:"pointer",fontSize:12}}>✕</button>
                )}
              </div>
              <button onClick={generatePDF} disabled={generating || filteredCount === 0}
                style={{padding:"12px 24px",borderRadius:10,background:filteredCount===0?"var(--bg4)":"var(--green)",color:"#fff",fontSize:14,fontWeight:700,border:"none",cursor:"pointer",opacity:generating?0.5:1}}>
                {generating ? `Generando... ${progress}%` : `📄 Descargar PDF 10×15 — ${filteredCount} página${filteredCount!==1?"s":""}`}
              </button>
            </div>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill, minmax(140px, 1fr))",gap:8,maxHeight:500,overflow:"auto",padding:4}}>
            {previews.map((src, i) => {
              const num = i + 1;
              const from = rangeFrom ? Math.max(1, parseInt(rangeFrom)) : 1;
              const to = rangeTo ? Math.min(previews.length, parseInt(rangeTo)) : previews.length;
              const inRange = !rangeFrom && !rangeTo ? true : (num >= from && num <= to);
              return (
              <div key={i} onClick={()=>{if(!rangeFrom){setRangeFrom(String(num));setRangeTo(String(num));}else if(rangeFrom && rangeTo===rangeFrom){setRangeTo(String(num));}else{setRangeFrom(String(num));setRangeTo("");}}}
                style={{background:"#fff",borderRadius:8,overflow:"hidden",border:inRange?"2px solid var(--cyan)":"1px solid var(--bg4)",opacity:inRange?1:0.4,position:"relative",cursor:"pointer",transition:"opacity 0.15s, border 0.15s"}}>
                <img src={src} alt={`Etiqueta ${num}`} style={{width:"100%",display:"block"}}/>
                <div style={{position:"absolute",bottom:4,right:4,background:inRange?"var(--cyan)":"rgba(0,0,0,0.7)",color:"#fff",padding:"2px 6px",borderRadius:4,fontSize:10,fontWeight:700}}>
                  {num}
                </div>
              </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function EtiquetasProductos() {
  const [q, setQ] = useState("");
  const [queue, setQueue] = useState<{ code: string; name: string; sku: string; qty: number }[]>([]);
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [mode, setMode] = useState<"manual"|"recepcion">("manual");
  const [toast, setToast] = useState("");
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const s = getStore();
  const results = q.length >= 2 ? findProduct(q).slice(0, 10) : [];

  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(""), 2500); };

  // Get the ML barcode code for a product (the code on the label like YJIH30730)
  const getMLCode = (sku: string): string => {
    const prod = s.products[sku];
    if (!prod) return "";
    // Check composicion_venta for this SKU as skuOrigen
    const ventas = getVentasPorSkuOrigen(sku);
    if (ventas.length > 0 && ventas[0].codigoMl) return ventas[0].codigoMl;
    if (prod.mlCode) return prod.mlCode;
    return "";
  };

  const getSkuVenta = (sku: string): string => {
    const ventas = getVentasPorSkuOrigen(sku);
    if (ventas.length > 0 && ventas[0].skuVenta) return ventas[0].skuVenta;
    return sku;
  };

  const addToQueue = (sku: string, qty: number = 1) => {
    const prod = s.products[sku];
    if (!prod) return;
    const code = getMLCode(sku);
    const skuV = getSkuVenta(sku);
    const existing = queue.find(i => i.code === (code || sku) && i.sku === skuV);
    if (existing) {
      setQueue(queue.map(i => i === existing ? { ...i, qty: i.qty + qty } : i));
    } else {
      setQueue([...queue, { code: code || sku, name: prod.name, sku: skuV, qty }]);
    }
    showToast(`+${qty} ${prod.name.slice(0, 30)}`);
  };

  // Load from a recepcion
  const loadFromRecepcion = async () => {
    const recs = await getRecepciones();
    const active = recs.filter(r => r.estado !== "CERRADA");
    if (active.length === 0) { alert("No hay recepciones activas"); return; }
    const rec = active[0]; // latest
    const lineas = await getRecepcionLineas(rec.id!);
    const newQueue: typeof queue = [];
    for (const l of lineas) {
      const prod = s.products[l.sku];
      if (!prod) continue;
      const code = getMLCode(l.sku);
      const skuV = getSkuVenta(l.sku);
      const qty = l.qty_recibida || l.qty_factura || 0;
      if (qty > 0) {
        newQueue.push({ code: code || l.sku, name: prod.name, sku: skuV, qty });
      }
    }
    setQueue(newQueue);
    showToast(`Cargado ${newQueue.length} productos de ${rec.proveedor}`);
  };

  const totalLabels = queue.reduce((s, i) => s + i.qty, 0);

  const generateBarcode = (code: string): string => {
    try {
      const canvas = document.createElement("canvas");
      const JsBarcode = (window as any).JsBarcode;
      if (!JsBarcode) return "";
      JsBarcode(canvas, code, { format: "CODE128", width: 2.5, height: 80, displayValue: false, margin: 2 });
      return canvas.toDataURL("image/png");
    } catch { return ""; }
  };

  // Load JsBarcode on mount
  useEffect(() => {
    if (typeof window !== "undefined" && !(window as any).JsBarcode) {
      import("jsbarcode").then(mod => { (window as any).JsBarcode = mod.default || mod; });
    }
  }, []);

  const generatePDF = async (item: typeof queue[0]) => {
    // @ts-ignore
    const { jsPDF } = await import("jspdf");
    const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: [40, 60] });
    const barcodeImg = generateBarcode(item.code);
    if (barcodeImg) doc.addImage(barcodeImg, "PNG", 3, 2, 54, 16);
    doc.setFontSize(12);
    doc.setFont("helvetica", "bold");
    doc.text(item.code, 30, 22, { align: "center" });
    doc.setFontSize(6);
    doc.setFont("helvetica", "normal");
    const lines = doc.splitTextToSize(item.name, 54);
    doc.text(lines.slice(0, 3), 30, 26, { align: "center" });
    if (item.sku) {
      doc.setFontSize(8);
      doc.setFont("helvetica", "bold");
      doc.text(`Cod. Universal: ${item.sku}`, 30, 37, { align: "center" });
    }
    return doc;
  };

  const downloadSingle = async (item: typeof queue[0]) => {
    const doc = await generatePDF(item);
    const safeName = item.name.replace(/[^a-zA-Z0-9áéíóúñÁÉÍÓÚÑ\s-]/g, "").slice(0, 80).trim();
    doc.save(`${safeName}.pdf`);
  };

  const downloadAllZip = async () => {
    if (queue.length === 0) return;
    setGenerating(true);
    setProgress(0);
    try {
      const JSZip = (await import("jszip")).default;
      const zip = new JSZip();
      let count = 0;
      const total = queue.reduce((s, i) => s + i.qty, 0);
      for (const item of queue) {
        for (let c = 0; c < item.qty; c++) {
          const doc = await generatePDF(item);
          const blob = doc.output("blob");
          const safeName = item.name.replace(/[^a-zA-Z0-9áéíóúñÁÉÍÓÚÑ\s-]/g, "").slice(0, 80).trim();
          const suffix = item.qty > 1 ? `_${c + 1}` : "";
          zip.file(`${safeName}${suffix}.pdf`, blob);
          count++;
          setProgress(Math.round((count / total) * 100));
        }
      }
      const zipBlob = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement("a");
      a.href = url; a.download = "etiquetas.zip"; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { alert("Error generando etiquetas: " + e); }
    setGenerating(false);
  };

  const downloadAllSinglePDF = async () => {
    if (queue.length === 0) return;
    setGenerating(true);
    setProgress(0);
    try {
      // @ts-ignore
      const { jsPDF } = await import("jspdf");
      const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: [40, 60] });
      let pageIdx = 0;
      const total = queue.reduce((s, i) => s + i.qty, 0);
      let count = 0;
      for (const item of queue) {
        for (let c = 0; c < item.qty; c++) {
          if (pageIdx > 0) doc.addPage([60, 40], "landscape");
          const barcodeImg = generateBarcode(item.code);
          if (barcodeImg) doc.addImage(barcodeImg, "PNG", 3, 2, 54, 16);
          doc.setFontSize(12);
          doc.setFont("helvetica", "bold");
          doc.text(item.code, 30, 22, { align: "center" });
          doc.setFontSize(6);
          doc.setFont("helvetica", "normal");
          const lines = doc.splitTextToSize(item.name, 54);
          doc.text(lines.slice(0, 3), 30, 26, { align: "center" });
          if (item.sku) {
            doc.setFontSize(8);
            doc.setFont("helvetica", "bold");
            doc.text(`Cod. Universal: ${item.sku}`, 30, 37, { align: "center" });
          }
          pageIdx++;
          count++;
          setProgress(Math.round((count / total) * 100));
        }
      }
      doc.save("etiquetas.pdf");
    } catch (e) { alert("Error: " + e); }
    setGenerating(false);
  };

  return (
    <div>
      {toast && (
        <div style={{position:"fixed",top:60,left:"50%",transform:"translateX(-50%)",zIndex:200,background:"var(--bg2)",
          border:"2px solid var(--green)",color:"var(--green)",padding:"10px 20px",borderRadius:10,fontSize:13,fontWeight:700,boxShadow:"0 8px 30px rgba(0,0,0,0.5)"}}>
          {toast}
        </div>
      )}
      <canvas ref={canvasRef} style={{display:"none"}}/>

      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
        <div>
          <h2 style={{fontSize:18,fontWeight:700,margin:0}}>🖨️ Etiquetas</h2>
          <p style={{fontSize:12,color:"var(--txt3)",margin:0}}>Genera etiquetas con código de barras para tus productos</p>
        </div>
        <div style={{display:"flex",gap:6}}>
          <button onClick={loadFromRecepcion} style={{padding:"8px 14px",borderRadius:8,background:"var(--bg3)",color:"var(--cyan)",fontSize:11,fontWeight:600,border:"1px solid var(--bg4)"}}>
            📦 Cargar de recepción
          </button>
          <button onClick={()=>setQueue([])} disabled={queue.length===0} style={{padding:"8px 14px",borderRadius:8,background:"var(--bg3)",color:"var(--red)",fontSize:11,fontWeight:600,border:"1px solid var(--bg4)",opacity:queue.length===0?0.4:1}}>
            🗑️ Limpiar
          </button>
        </div>
      </div>

      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
        {/* LEFT: Search & Add */}
        <div>
          <div style={{padding:16,background:"var(--bg2)",borderRadius:10,border:"1px solid var(--bg3)",marginBottom:12}}>
            <div style={{fontSize:13,fontWeight:700,marginBottom:8}}>Buscar producto</div>
            <input className="form-input" value={q} onChange={e=>setQ(e.target.value)}
              placeholder="SKU, nombre, código ML..." style={{fontSize:14,padding:12,marginBottom:8}}/>
            
            {results.length > 0 && (
              <div style={{maxHeight:400,overflow:"auto"}}>
                {results.map(p => {
                  const mlCode = getMLCode(p.sku);
                  const skuV = getSkuVenta(p.sku);
                  return (
                    <div key={p.sku} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 8px",borderBottom:"1px solid var(--bg3)",cursor:"pointer"}}
                      onClick={()=>addToQueue(p.sku, 1)}>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontSize:13,fontWeight:700,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.name}</div>
                        <div style={{fontSize:11,color:"var(--txt3)"}}>
                          <span className="mono">{p.sku}</span>
                          {mlCode && <span> · ML: <strong style={{color:"var(--cyan)"}}>{mlCode}</strong></span>}
                          {skuV !== p.sku && <span> · Venta: <strong>{skuV}</strong></span>}
                        </div>
                      </div>
                      <button onClick={e=>{e.stopPropagation();addToQueue(p.sku, 1);}}
                        style={{padding:"6px 12px",borderRadius:6,background:"var(--greenBg)",color:"var(--green)",fontSize:11,fontWeight:700,border:"1px solid var(--green)33",cursor:"pointer",flexShrink:0}}>
                        + Agregar
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {q.length >= 2 && results.length === 0 && (
              <div style={{textAlign:"center",padding:16,color:"var(--txt3)",fontSize:12}}>Sin resultados</div>
            )}
          </div>

          {/* Bulk add */}
          <BulkAddEtiquetas onAdd={(items) => {
            for (const item of items) addToQueue(item.sku, item.qty);
          }}/>
        </div>

        {/* RIGHT: Queue & Download */}
        <div>
          <div style={{padding:16,background:"var(--bg2)",borderRadius:10,border:"1px solid var(--bg3)",marginBottom:12}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
              <div style={{fontSize:14,fontWeight:700}}>Cola de impresión</div>
              <div style={{padding:"4px 10px",borderRadius:6,background:"var(--cyanBg)",color:"var(--cyan)",fontSize:12,fontWeight:700}}>
                {queue.length} productos · {totalLabels} etiquetas
              </div>
            </div>

            {queue.length === 0 ? (
              <div style={{textAlign:"center",padding:24,color:"var(--txt3)"}}>
                <div style={{fontSize:32,marginBottom:8}}>🏷️</div>
                <div style={{fontSize:13}}>Busca productos y agrégalos</div>
              </div>
            ) : (
              <div style={{maxHeight:350,overflow:"auto"}}>
                {queue.map((item, i) => (
                  <div key={i} style={{display:"flex",alignItems:"center",gap:8,padding:"10px 0",borderBottom:"1px solid var(--bg3)"}}>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:12,fontWeight:700,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{item.name}</div>
                      <div style={{fontSize:10,color:"var(--txt3)"}}>
                        <span className="mono" style={{color:"var(--cyan)"}}>{item.code}</span>
                        {" · "}SKU: <span className="mono">{item.sku}</span>
                      </div>
                    </div>
                    <div style={{display:"flex",alignItems:"center",gap:4}}>
                      <button onClick={()=>setQueue(queue.map((q,j)=>j===i?{...q,qty:Math.max(1,q.qty-1)}:q))}
                        style={{width:24,height:24,borderRadius:4,background:"var(--bg3)",color:"var(--txt2)",fontSize:14,fontWeight:700,border:"1px solid var(--bg4)",cursor:"pointer",lineHeight:"22px"}}>−</button>
                      <input className="mono" value={item.qty}
                        onFocus={e=>e.target.select()} onChange={e=>setQueue(queue.map((q,j)=>j===i?{...q,qty:Math.max(1,parseInt(e.target.value)||1)}:q))}
                        style={{width:40,textAlign:"center",padding:4,borderRadius:4,background:"var(--bg3)",color:"var(--txt)",border:"1px solid var(--bg4)",fontSize:13,fontWeight:700}}/>
                      <button onClick={()=>setQueue(queue.map((q,j)=>j===i?{...q,qty:q.qty+1}:q))}
                        style={{width:24,height:24,borderRadius:4,background:"var(--bg3)",color:"var(--txt2)",fontSize:14,fontWeight:700,border:"1px solid var(--bg4)",cursor:"pointer",lineHeight:"22px"}}>+</button>
                    </div>
                    <button onClick={()=>downloadSingle(item)} title="Descargar 1"
                      style={{padding:"4px 8px",borderRadius:4,background:"var(--bg3)",color:"var(--txt3)",fontSize:10,border:"1px solid var(--bg4)",cursor:"pointer"}}>
                      📄
                    </button>
                    <button onClick={()=>setQueue(queue.filter((_,j)=>j!==i))}
                      style={{padding:"4px 8px",borderRadius:4,background:"var(--redBg)",color:"var(--red)",fontSize:10,border:"1px solid var(--red)33",cursor:"pointer"}}>
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Download buttons */}
          {queue.length > 0 && (
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              {generating && (
                <div style={{background:"var(--bg3)",borderRadius:8,height:8,overflow:"hidden"}}>
                  <div style={{width:`${progress}%`,height:"100%",background:"var(--cyan)",borderRadius:8,transition:"width 0.2s"}}/>
                </div>
              )}
              <button onClick={downloadAllSinglePDF} disabled={generating}
                style={{width:"100%",padding:14,borderRadius:10,background:"var(--green)",color:"#fff",fontSize:14,fontWeight:700,border:"none",cursor:"pointer",opacity:generating?0.5:1}}>
                {generating ? `Generando... ${progress}%` : `📄 Un solo PDF — ${totalLabels} páginas`}
              </button>
              <button onClick={downloadAllZip} disabled={generating}
                style={{width:"100%",padding:12,borderRadius:10,background:"var(--bg3)",color:"var(--cyan)",fontSize:13,fontWeight:600,border:"1px solid var(--bg4)",cursor:"pointer",opacity:generating?0.5:1}}>
                {generating ? `Generando... ${progress}%` : `📥 ZIP de PDFs individuales`}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Bulk add from text (paste SKU + QTY)
function BulkAddEtiquetas({ onAdd }: { onAdd: (items: { sku: string; qty: number }[]) => void }) {
  const [raw, setRaw] = useState("");
  const [open, setOpen] = useState(false);
  const s = getStore();

  const doParse = () => {
    const lines = raw.trim().split("\n").filter(l => l.trim());
    const items: { sku: string; qty: number }[] = [];
    const errors: string[] = [];
    for (const line of lines) {
      const parts = line.trim().split(/[\s,;\t]+/);
      const sku = parts[0]?.trim();
      const qty = parts.length > 1 ? parseInt(parts[1]) || 1 : 1;
      if (!sku) continue;
      // Try to find by SKU, SKU Venta, or ML code
      const found = findProduct(sku);
      if (found.length > 0) {
        items.push({ sku: found[0].sku, qty });
      } else {
        errors.push(`"${sku}" no encontrado`);
      }
    }
    if (items.length > 0) {
      onAdd(items);
      setRaw("");
      setOpen(false);
    }
    if (errors.length > 0) alert("No encontrados:\n" + errors.join("\n"));
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} style={{width:"100%",padding:12,borderRadius:8,background:"var(--bg2)",color:"var(--txt3)",fontSize:12,fontWeight:600,border:"1px dashed var(--bg4)",cursor:"pointer"}}>
        📋 Pegar lista de productos (SKU + Cantidad)
      </button>
    );
  }

  return (
    <div style={{padding:14,background:"var(--bg2)",borderRadius:10,border:"1px solid var(--bg3)"}}>
      <div style={{fontSize:13,fontWeight:700,marginBottom:8}}>Pegar lista</div>
      <textarea className="form-input mono" value={raw} onChange={e => setRaw(e.target.value)}
        placeholder={"QLRM-30-BC 15\nSAB-180-BL 10\nBOLMATCUERCAF2L 4"}
        rows={5} style={{fontSize:11,lineHeight:1.5,resize:"vertical",marginBottom:8}}/>
      <div style={{display:"flex",gap:6}}>
        <button onClick={doParse} disabled={!raw.trim()} style={{padding:"8px 16px",borderRadius:6,background:"var(--green)",color:"#fff",fontSize:12,fontWeight:700,border:"none",cursor:"pointer"}}>
          Agregar
        </button>
        <button onClick={() => setOpen(false)} style={{padding:"8px 16px",borderRadius:6,background:"var(--bg3)",color:"var(--txt3)",fontSize:12,border:"1px solid var(--bg4)",cursor:"pointer"}}>
          Cancelar
        </button>
      </div>
    </div>
  );
}


export default AdminEtiquetas;
