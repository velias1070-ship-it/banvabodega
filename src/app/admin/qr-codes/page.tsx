"use client";
import { useState, useEffect, useRef } from "react";
import { LOCS } from "@/lib/store";
import Link from "next/link";

export default function QRCodesPage() {
  const [mounted, setMounted] = useState(false);
  const [selectedZone, setSelectedZone] = useState("all");
  const [qrSize, setQrSize] = useState(200);
  const [generating, setGenerating] = useState(false);
  const [qrImages, setQrImages] = useState<Record<string,string>>({});
  const printRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setMounted(true); }, []);

  const filteredLocs = selectedZone === "all" ? LOCS : LOCS.filter(l => l.startsWith(selectedZone));

  const generateQRs = async () => {
    setGenerating(true);
    try {
      const QRCode = (await import("qrcode")).default;
      const imgs: Record<string,string> = {};
      for (const loc of filteredLocs) {
        const qrData = "BANVA-LOC:" + loc;
        imgs[loc] = await QRCode.toDataURL(qrData, {
          width: qrSize,
          margin: 1,
          color: { dark: "#000000", light: "#ffffff" },
          errorCorrectionLevel: "H"
        });
      }
      setQrImages(imgs);
    } catch (e) {
      console.error(e);
    }
    setGenerating(false);
  };

  const handlePrint = () => {
    const content = printRef.current;
    if (!content) return;
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(`<!DOCTYPE html><html><head><title>QR Ubicaciones BANVA</title>
      <style>
        body{font-family:Arial,sans-serif;margin:0;padding:20px}
        .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:15px;page-break-inside:auto}
        .qr-card{border:2px solid #333;border-radius:8px;padding:12px;text-align:center;page-break-inside:avoid}
        .qr-card img{width:${qrSize}px;height:${qrSize}px}
        .loc-code{font-size:28px;font-weight:900;font-family:monospace;margin-top:8px;letter-spacing:2px}
        .zone-label{font-size:12px;color:#666;margin-top:4px}
        @media print{.no-print{display:none}}
      </style></head><body>`);
    w.document.write('<button class="no-print" onclick="window.print()" style="padding:12px 24px;font-size:16px;margin-bottom:20px;cursor:pointer">Imprimir</button>');
    w.document.write('<div class="grid">');
    for (const loc of filteredLocs) {
      if (!qrImages[loc]) continue;
      const zone = loc.startsWith("P") ? "Pallet Piso" : "Estante Nv." + loc.split("-")[2];
      w.document.write(`<div class="qr-card"><img src="${qrImages[loc]}"/><div class="loc-code">${loc}</div><div class="zone-label">Zona ${loc[0]} - ${zone}</div></div>`);
    }
    w.document.write('</div></body></html>');
    w.document.close();
  };

  if (!mounted) return null;

  return (
    <div className="app">
      <div className="topbar">
        <Link href="/admin"><button className="back-btn">&#8592; Admin</button></Link>
        <h1>QR Ubicaciones</h1>
        <div style={{fontSize:11,color:"var(--txt3)"}}>{filteredLocs.length} ubicaciones</div>
      </div>
      <div style={{padding:16}}>
        <div className="card">
          <div className="card-title">Configuracion</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:12}}>
            <div className="form-group">
              <label className="form-label">Zona</label>
              <select className="form-select" value={selectedZone} onChange={e=>setSelectedZone(e.target.value)}>
                <option value="all">Todas ({LOCS.length})</option>
                <option value="P-">Pallets ({LOCS.filter(l=>l.startsWith("P-")).length})</option>
                <option value="E-">Estantes ({LOCS.filter(l=>l.startsWith("E-")).length})</option>
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Tamano QR</label>
              <select className="form-select" value={qrSize} onChange={e=>setQrSize(Number(e.target.value))}>
                <option value={150}>Pequeno (150px)</option>
                <option value={200}>Mediano (200px)</option>
                <option value={300}>Grande (300px)</option>
              </select>
            </div>
          </div>
          <button className="btn-primary" onClick={generateQRs} disabled={generating}>
            {generating ? "Generando..." : "Generar QR Codes"}
          </button>
        </div>

        {Object.keys(qrImages).length > 0 && (
          <>
            <button onClick={handlePrint} style={{width:"100%",padding:14,borderRadius:"var(--radius)",background:"linear-gradient(135deg,#059669,var(--green))",color:"#fff",fontWeight:700,fontSize:14,marginBottom:16}}>
              Abrir para Imprimir ({Object.keys(qrImages).length} QRs)
            </button>
            <div ref={printRef} style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:10}}>
              {filteredLocs.map(loc => qrImages[loc] ? (
                <div key={loc} style={{background:"#fff",borderRadius:10,padding:12,textAlign:"center"}}>
                  <img src={qrImages[loc]} alt={loc} style={{width:qrSize/2,height:qrSize/2}}/>
                  <div style={{fontSize:18,fontWeight:900,fontFamily:"'JetBrains Mono',monospace",color:"#000",marginTop:4,letterSpacing:1}}>{loc}</div>
                  <div style={{fontSize:10,color:"#666"}}>{loc.startsWith("P")?"Pallet":"Estante"}</div>
                </div>
              ) : null)}
            </div>
          </>
        )}

        <div className="card" style={{marginTop:16}}>
          <div className="card-title">Instrucciones</div>
          <div style={{fontSize:12,color:"var(--txt2)",lineHeight:1.7}}>
            <p>1. Selecciona la zona y tamano deseado</p>
            <p>2. Click en &quot;Generar QR Codes&quot;</p>
            <p>3. Click en &quot;Abrir para Imprimir&quot; - se abre en nueva ventana</p>
            <p>4. Imprime en papel adhesivo o normal</p>
            <p>5. Recorta cada QR y pegalo en el estante correspondiente</p>
            <p style={{marginTop:8,color:"var(--cyan)",fontWeight:600}}>Cada QR contiene el codigo de ubicacion (ej: BANVA-LOC:A-01-1). El escaner del operador lo lee automaticamente.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
