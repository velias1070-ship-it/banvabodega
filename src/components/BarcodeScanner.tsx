"use client";
import { useEffect, useRef, useState } from "react";
interface Props { onScan: (code: string) => void; active: boolean; label?: string; }
export default function BarcodeScanner({ onScan, active, label }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const scanRef = useRef<any>(null);
  const [err, setErr] = useState("");
  const [ready, setReady] = useState(false);
  const lastCode = useRef("");
  const lastTime = useRef(0);
  useEffect(() => {
    if (!active) { if (scanRef.current) { try { scanRef.current.stop().catch(()=>{}); } catch {} scanRef.current = null; } setReady(false); return; }
    let alive = true;
    async function go() {
      try {
        const { Html5Qrcode } = await import("html5-qrcode");
        if (!alive || !boxRef.current) return;
        const id = "bscan-" + Date.now();
        boxRef.current.innerHTML = "";
        const d = document.createElement("div"); d.id = id; boxRef.current.appendChild(d);
        const sc = new Html5Qrcode(id); scanRef.current = sc;
        await sc.start({ facingMode: "environment" }, { fps: 10, qrbox: { width: 260, height: 140 }, aspectRatio: 1.5 },
          (text: string) => {
            const now = Date.now();
            if (text === lastCode.current && now - lastTime.current < 2000) return;
            lastCode.current = text; lastTime.current = now;
            if (navigator.vibrate) navigator.vibrate(100);
            onScan(text);
          }, () => {}
        );
        if (alive) setReady(true);
      } catch (e: any) { if (alive) { setErr(e?.message || "No se pudo abrir la camara"); setReady(false); } }
    }
    go();
    return () => { alive = false; if (scanRef.current) { try { scanRef.current.stop().catch(()=>{}); } catch {} scanRef.current = null; } };
  }, [active, onScan]);
  if (!active) return null;
  return (
    <div style={{ position: "relative", borderRadius: 12, overflow: "hidden", background: "#000", marginBottom: 12 }}>
      {label && <div style={{ position: "absolute", top: 10, left: "50%", transform: "translateX(-50%)", zIndex: 10, background: "rgba(0,0,0,0.75)", color: "#fff", padding: "6px 16px", borderRadius: 20, fontSize: 12, fontWeight: 700, whiteSpace: "nowrap" }}>{label}</div>}
      <div ref={boxRef} style={{ width: "100%", minHeight: 200 }} />
      {!ready && !err && <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#94a3b8", fontSize: 13 }}>Abriendo camara...</div>}
      {err && <div style={{ padding: 24, textAlign: "center" }}><div style={{ fontSize: 13, color: "#ef4444", marginBottom: 8 }}>{err}</div><div style={{ fontSize: 11, color: "#94a3b8" }}>Da permiso de camara al navegador</div></div>}
    </div>
  );
}
