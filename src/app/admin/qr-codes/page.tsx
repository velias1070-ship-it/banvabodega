"use client";
import { useState, useEffect } from "react";
import { getStore, activePositions, initStore } from "@/lib/store";
import Link from "next/link";

export default function QRCodesPage() {
  const [mounted, setMounted] = useState(false);
  const [filterType, setFilterType] = useState("all");
  const [qrSize, setQrSize] = useState(200);
  const [generating, setGenerating] = useState(false);
  const [qrImages, setQrImages] = useState<Record<string,string>>({});

  useEffect(() => { initStore().then(() => setMounted(true)); }, []);

  const positions = activePositions();
  const filtered = filterType === "all" ? positions : positions.filter(p => p.type === filterType);

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

  const handlePrint = () => {
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(`<!DOCTYPE html><html><head><title>QR Posiciones BANVA</title>
      <style>
        body{font-family:Arial,sans-serif;margin:0;padding:20px}
        .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:15px}
        .qr-card{border:3px solid #000;border-radius:8px;padding:16px;text-align:center;page-break-inside:avoid}
        .qr-card img{width:${qrSize}px;height:${qrSize}px}
        .pos-id{font-size:48px;font-weight:900;font-family:monospace;margin-bottom:8px;letter-spacing:3px}
        .pos-label{font-size:14px;color:#666;margin-top:6px}
        @media print{.no-print{display:none}.qr-card{border:3px solid #000}}
      </style></head><body>`);
    w.document.write('<button class="no-print" onclick="window.print()" style="padding:12px 24px;font-size:16px;margin-bottom:20px;cursor:pointer;font-weight:bold">IMPRIMIR</button>');
    w.document.write('<div class="grid">');
    for (const pos of filtered) {
      if (!qrImages[pos.id]) continue;
      w.document.write(`<div class="qr-card"><div class="pos-id">${pos.id}</div><img src="${qrImages[pos.id]}"/><div class="pos-label">${pos.label}</div></div>`);
    }
    w.document.write('</div></body></html>');
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
              <select className="form-select" value={filterType} onChange={e=>setFilterType(e.target.value)}>
                <option value="all">Todas ({positions.length})</option>
                <option value="pallet">Pallets ({positions.filter(p=>p.type==="pallet").length})</option>
                <option value="shelf">Estantes ({positions.filter(p=>p.type==="shelf").length})</option>
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Tamano QR</label>
              <select className="form-select" value={qrSize} onChange={e=>setQrSize(Number(e.target.value))}>
                <option value={150}>Pequeno</option>
                <option value={200}>Mediano</option>
                <option value={300}>Grande</option>
              </select>
            </div>
          </div>
          <button className="btn-primary" onClick={generateQRs} disabled={generating}>{generating ? "Generando..." : "Generar QR Codes"}</button>
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
