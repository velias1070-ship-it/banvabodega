"use client";
import { useEffect, useRef, useState } from "react";
interface Props { onScan: (code: string) => void; active: boolean; label?: string; }
export default function BarcodeScanner({ onScan, active, label }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const scanRef = useRef<any>(null);
  const [err, setErr] = useState("");
  const [ready, setReady] = useState(false);
  const [lastScanned, setLastScanned] = useState("");
  const lastCode = useRef("");
  const lastTime = useRef(0);
  useEffect(() => {
    if (!active) { if (scanRef.current) { try { scanRef.current.stop().catch(()=>{}); } catch {} scanRef.current = null; } setReady(false); return; }
    let alive = true;
    async function go() {
      try {
        const { Html5Qrcode, Html5QrcodeSupportedFormats } = await import("html5-qrcode") as any;
        if (!alive || !boxRef.current) return;
        const id = "bscan-" + Date.now();
        boxRef.current.innerHTML = "";
        const d = document.createElement("div"); d.id = id; boxRef.current.appendChild(d);
        const sc = new Html5Qrcode(id, {
          formatsToSupport: [
            Html5QrcodeSupportedFormats.QR_CODE,
            Html5QrcodeSupportedFormats.CODE_128,
            Html5QrcodeSupportedFormats.CODE_39,
            Html5QrcodeSupportedFormats.EAN_13,
            Html5QrcodeSupportedFormats.EAN_8,
            Html5QrcodeSupportedFormats.UPC_A,
            Html5QrcodeSupportedFormats.UPC_E,
            Html5QrcodeSupportedFormats.ITF,
            Html5QrcodeSupportedFormats.CODE_93,
          ],
          verbose: false,
        });
        scanRef.current = sc;
        await sc.start(
          { facingMode: "environment" },
          { fps: 15, qrbox: { width: 280, height: 120 }, aspectRatio: 1.7 },
          (text: string) => {
            const now = Date.now();
            if (text === lastCode.current && now - lastTime.current < 3000) return;
            lastCode.current = text; lastTime.current = now;
            if (navigator.vibrate) navigator.vibrate([80, 40, 80]);
            setLastScanned(text);
            onScan(text);
          }, () => {}
        );
        if (alive) setReady(true);
      } catch (e: any) { if (alive) { setErr(e?.message || "No se pudo abrir la cámara"); setReady(false); } }
    }
    go();
    return () => { alive = false; if (scanRef.current) { try { scanRef.current.stop().catch(()=>{}); } catch {} scanRef.current = null; } };
  }, [active, onScan]);
  if (!active) return null;
  return (
    <div style={{ position: "relative", borderRadius: 12, overflow: "hidden", background: "#000", marginBottom: 12 }}>
      {label && <div style={{ position: "absolute", top: 10, left: "50%", transform: "translateX(-50%)", zIndex: 10, background: "rgba(0,0,0,0.75)", color: "#fff", padding: "6px 16px", borderRadius: 20, fontSize: 12, fontWeight: 700, whiteSpace: "nowrap" }}>{label}</div>}
      <div ref={boxRef} style={{ width: "100%", minHeight: 220 }} />
      {/* Scan guide overlay */}
      {ready && (
        <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", width: 260, height: 80, border: "2px solid #10b98188", borderRadius: 8, pointerEvents: "none", zIndex: 5 }}>
          <div style={{ position: "absolute", top: -22, left: "50%", transform: "translateX(-50%)", fontSize: 10, color: "#10b981", fontWeight: 600, whiteSpace: "nowrap", background: "rgba(0,0,0,0.6)", padding: "2px 8px", borderRadius: 4 }}>
            Centra el código de barras aquí
          </div>
        </div>
      )}
      {!ready && !err && <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#94a3b8", fontSize: 13 }}>Abriendo cámara...</div>}
      {err && <div style={{ padding: 24, textAlign: "center" }}><div style={{ fontSize: 13, color: "#ef4444", marginBottom: 8 }}>{err}</div><div style={{ fontSize: 11, color: "#94a3b8" }}>Da permiso de cámara al navegador</div></div>}
      {lastScanned && <div style={{ position: "absolute", bottom: 8, left: "50%", transform: "translateX(-50%)", background: "rgba(16,185,129,0.9)", color: "#fff", padding: "4px 14px", borderRadius: 20, fontSize: 11, fontWeight: 700, zIndex: 10 }}>Leído: {lastScanned}</div>}
    </div>
  );
}
