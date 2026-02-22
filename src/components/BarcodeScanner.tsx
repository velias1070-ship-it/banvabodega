"use client";
import { useEffect, useRef, useState } from "react";

interface ScannerProps {
  onScan: (code: string) => void;
  active: boolean;
  label?: string;
}

export default function BarcodeScanner({ onScan, active, label }: ScannerProps) {
  const videoRef = useRef<HTMLDivElement>(null);
  const scannerRef = useRef<any>(null);
  const [error, setError] = useState("");
  const [cameraReady, setCameraReady] = useState(false);
  const lastScanRef = useRef("");
  const lastScanTimeRef = useRef(0);

  useEffect(() => {
    if (!active) {
      if (scannerRef.current) {
        try { scannerRef.current.stop().catch(() => {}); } catch {}
        scannerRef.current = null;
      }
      setCameraReady(false);
      return;
    }

    let mounted = true;

    async function startScanner() {
      try {
        // Dynamic import to avoid SSR issues
        const { Html5Qrcode } = await import("html5-qrcode");

        if (!mounted || !videoRef.current) return;

        const scannerId = "banva-scanner-" + Date.now();
        const container = videoRef.current;
        container.innerHTML = "";
        const div = document.createElement("div");
        div.id = scannerId;
        container.appendChild(div);

        const scanner = new Html5Qrcode(scannerId);
        scannerRef.current = scanner;

        await scanner.start(
          { facingMode: "environment" },
          {
            fps: 10,
            qrbox: { width: 280, height: 160 },
            aspectRatio: 1.5,
          },
          (decodedText: string) => {
            // Debounce: ignore same code within 2 seconds
            const now = Date.now();
            if (decodedText === lastScanRef.current && now - lastScanTimeRef.current < 2000) return;
            lastScanRef.current = decodedText;
            lastScanTimeRef.current = now;

            // Vibrate if supported
            if (navigator.vibrate) navigator.vibrate(100);

            onScan(decodedText);
          },
          () => {} // ignore errors during scanning
        );

        if (mounted) setCameraReady(true);
      } catch (err: any) {
        if (mounted) {
          setError(err?.message || "No se pudo acceder a la cámara");
          setCameraReady(false);
        }
      }
    }

    startScanner();

    return () => {
      mounted = false;
      if (scannerRef.current) {
        try { scannerRef.current.stop().catch(() => {}); } catch {}
        scannerRef.current = null;
      }
    };
  }, [active, onScan]);

  if (!active) return null;

  return (
    <div style={{ position: "relative", borderRadius: 12, overflow: "hidden", background: "#000", marginBottom: 12 }}>
      {label && (
        <div style={{
          position: "absolute", top: 10, left: "50%", transform: "translateX(-50%)",
          zIndex: 10, background: "rgba(0,0,0,0.7)", color: "#fff", padding: "6px 16px",
          borderRadius: 20, fontSize: 12, fontWeight: 700, letterSpacing: "0.03em",
          backdropFilter: "blur(4px)", whiteSpace: "nowrap",
        }}>
          {label}
        </div>
      )}
      <div ref={videoRef} style={{ width: "100%", minHeight: 200 }} />
      {!cameraReady && !error && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--txt3)", fontSize: 13 }}>
          Iniciando cámara...
        </div>
      )}
      {error && (
        <div style={{ padding: 24, textAlign: "center" }}>
          <div style={{ fontSize: 13, color: "var(--red)", marginBottom: 8 }}>⚠️ {error}</div>
          <div style={{ fontSize: 11, color: "var(--txt3)" }}>Asegúrate de dar permiso de cámara al navegador</div>
        </div>
      )}
    </div>
  );
}
