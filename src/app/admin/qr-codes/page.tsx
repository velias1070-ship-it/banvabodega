"use client";
import { useState, useEffect } from "react";
import { getStore, activePositions, initStore } from "@/lib/store";
import Link from "next/link";

export default function QRCodesPage() {
  const [mounted, setMounted] = useState(false);
  const [filterType, setFilterType] = useState("all");
  const [selectedPos, setSelectedPos] = useState("");
  const [qrSize, setQrSize] = useState(200);
  const [generating, setGenerating] = useState(false);
  const [qrImages, setQrImages] = useState<Record<string,string>>({});

  useEffect(() => { initStore().then(() => setMounted(true)); }, []);

  const positions = activePositions();
  const filteredByType = filterType === "all" ? positions : positions.filter(p => p.type === filterType);
  const filtered = selectedPos ? filteredByType.filter(p => p.id === selectedPos) : filteredByType;

  const generateQRs = async () => {
    setGenerating(true);
    try {
      const QRCode = (await import("qrcode")).default;
      const imgs: Record<string,string> = {};
      for (const pos of filtered) {
        const qrData = "BANVA-POS:" + pos.id;
        imgs[pos.id] = await QRCode.toDataURL(qrData, { width: qrSize, margin: 1, color: { dark: "#000000", light: "#ffffff" }, errorCorrectionLevel: "H" });
      }
      setQrImages(imgs);
    } catch (e) { console.error(e); }
    setGenerating(false);
  };

  // Label size: 10cm wide x 15cm tall, one QR per page
  const handlePrint = () => {
    const w = window.open("", "_blank");
    if (!w) return;
    const posesToPrint = filtered.filter(p => qrImages[p.id]);
    w.document.write(`<!DOCTYPE html><html><head><title>QR Posiciones BANVA</title>
      <style>
        @page{size:10cm 15cm;margin:0}
        *{box-sizing:border-box;margin:0;padding:0}
        body{font-family:Arial,sans-serif;margin:0;padding:0}
        .qr-page{width:10cm;height:15cm;display:flex;flex-direction:column;align-items:center;justify-content:center;page-break-after:always;padding:0.5cm;border:1px dashed #ccc}
        .qr-page:last-child{page-break-after:auto}
        .qr-page img{width:7cm;height:7cm}
        .pos-id{font-size:56px;font-weight:900;font-family:monospace;letter-spacing:4px;margin-bottom:12px}
        .pos-label{font-size:16px;color:#666;margin-top:10px}
        .banva-tag{font-size:10px;color:#999;margin-top:8px;letter-spacing:2px}
        @media print{.no-print{display:none}.qr-page{border:none}}
      </style></head><body>`);
    w.document.write('<div class="no-print" style="padding:16px;text-align:center;border-bottom:1px solid #ccc;margin-bottom:8px"><button onclick="window.print()" style="padding:12px 24px;font-size:16px;cursor:pointer;font-weight:bold;border-radius:8px;background:#059669;color:#fff;border:none">IMPRIMIR ' + posesToPrint.length + ' ETIQUETA' + (posesToPrint.length !== 1 ? 'S' : '') + '</button><div style="font-size:12px;color:#666;margin-top:6px">Cada etiqueta: 10cm x 15cm — una por hoja</div></div>');
    for (const pos of posesToPrint) {
      w.document.write(`<div class="qr-page"><div class="pos-id">${pos.id}</div><img src="${qrImages[pos.id]}"/><div class="pos-label">${pos.label}</div><div class="banva-tag">BANVA BODEGA</div></div>`);
    }
    w.document.write('</body></html>');
    w.document.close();
  };

  if (!mounted) return null;

  return (
    <div className="app">
      <div className="topbar">
        <Link href="/admin"><button className="back-btn">&#8592; Admin</button></Link>
        <h1>QR Posiciones</h1>
        <div style={{fontSize:11,color:"var(--txt3)"}}>{filtered.length} posiciones</div>
      </div>
      <div style={{padding:16}}>
        <div className="card">
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:12}}>
            <div className="form-group">
              <label className="form-label">Tipo</label>
              <select className="form-select" value={filterType} onChange={e=>{setFilterType(e.target.value);setSelectedPos("");setQrImages({});}}>
                <option value="all">Todas ({positions.length})</option>
                <option value="pallet">Pallets ({positions.filter(p=>p.type==="pallet").length})</option>
                <option value="shelf">Estantes ({positions.filter(p=>p.type==="shelf").length})</option>
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Posicion</label>
              <select className="form-select" value={selectedPos} onChange={e=>{setSelectedPos(e.target.value);setQrImages({});}}>
                <option value="">Todas ({filteredByType.length})</option>
                {filteredByType.map(p => <option key={p.id} value={p.id}>{p.id} — {p.label}</option>)}
              </select>
            </div>
          </div>
          <div style={{fontSize:11,color:"var(--txt3)",marginBottom:10,textAlign:"center"}}>
            Etiquetas de 10cm x 15cm — un QR por hoja
            {selectedPos && <span style={{color:"var(--cyan)",fontWeight:700}}> — Solo: {selectedPos}</span>}
          </div>
          <button className="btn-primary" onClick={generateQRs} disabled={generating}>{generating ? "Generando..." : `Generar QR${filtered.length === 1 ? "" : "s"} (${filtered.length})`}</button>
        </div>

        {Object.keys(qrImages).length > 0 && <>
          <button onClick={handlePrint} style={{width:"100%",padding:14,borderRadius:"var(--radius)",background:"linear-gradient(135deg,#059669,var(--green))",color:"#fff",fontWeight:700,fontSize:14,marginBottom:16}}>
            Abrir para Imprimir ({Object.keys(qrImages).length} QRs)
          </button>
          <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:10}}>
            {filtered.map(pos => qrImages[pos.id] ? (
              <div key={pos.id} style={{background:"#fff",borderRadius:10,padding:12,textAlign:"center"}}>
                <div style={{fontSize:28,fontWeight:900,fontFamily:"'JetBrains Mono',monospace",color:"#000",marginBottom:4}}>{pos.id}</div>
                <img src={qrImages[pos.id]} alt={pos.id} style={{width:qrSize/2,height:qrSize/2}}/>
                <div style={{fontSize:11,color:"#666",marginTop:4}}>{pos.label}</div>
              </div>
            ) : null)}
          </div>
        </>}

        <div className="card" style={{marginTop:16}}>
          <div className="card-title">Instrucciones</div>
          <div style={{fontSize:12,color:"var(--txt2)",lineHeight:1.7}}>
            <p>1. Genera los QR codes arriba</p>
            <p>2. Click "Abrir para Imprimir" - se abre nueva ventana</p>
            <p>3. Cada QR tiene el NUMERO DE POSICION grande arriba</p>
            <p>4. Imprime, recorta, y pega cada QR en su posicion</p>
            <p>5. El operador escanea el QR y el sistema reconoce la posicion automaticamente</p>
            <p style={{marginTop:8,color:"var(--cyan)",fontWeight:600}}>Si agregas nuevas posiciones en Admin &gt; Posiciones, vuelve aqui a generar sus QRs.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
