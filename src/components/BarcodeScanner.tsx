"use client";
import { useEffect, useRef, useState, useCallback } from "react";

// ==================== TYPES ====================
type ScanMode = "barcode" | "qr" | "auto";

interface Props {
  onScan: (code: string) => void;
  active: boolean;
  label?: string;
  mode?: ScanMode;
  placeholder?: string;
  autoRefocus?: boolean;
}

// Unique ID counter for scanner elements
let scannerIdCounter = 0;

// ==================== CAMERA BARCODE/QR SCANNER ====================
export default function BarcodeScanner({
  onScan,
  active,
  label,
  mode = "auto",
  placeholder,
  autoRefocus = true,
}: Props) {
  const onScanRef = useRef(onScan);
  const scannerRef = useRef<any>(null);
  const containerIdRef = useRef(`html5-qr-scanner-${++scannerIdCounter}`);
  const lastCode = useRef("");
  const lastTime = useRef(0);

  const [lastScanned, setLastScanned] = useState("");
  const [flash, setFlash] = useState(false);
  const [error, setError] = useState("");
  const [cameraActive, setCameraActive] = useState(false);
  const [manualMode, setManualMode] = useState(false);
  const [manualValue, setManualValue] = useState("");
  const manualInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { onScanRef.current = onScan; }, [onScan]);

  const DEDUP_MS = 800;

  const handleCodeScanned = useCallback((code: string) => {
    const trimmed = code.trim();
    if (!trimmed) return;

    const now = Date.now();
    if (trimmed === lastCode.current && now - lastTime.current < DEDUP_MS) return;

    lastCode.current = trimmed;
    lastTime.current = now;

    setLastScanned(trimmed);
    setFlash(true);
    setTimeout(() => setFlash(false), 400);
    if (navigator.vibrate) navigator.vibrate([50, 30, 50]);

    onScanRef.current(trimmed);
  }, []);

  // Start/stop camera scanner
  useEffect(() => {
    if (!active || manualMode) {
      // Stop scanner if running
      if (scannerRef.current) {
        try {
          if (scannerRef.current.isScanning) {
            scannerRef.current.stop().then(() => {
              scannerRef.current.clear();
            }).catch(() => {});
          }
        } catch {}
        scannerRef.current = null;
        setCameraActive(false);
      }
      return;
    }

    let cancelled = false;

    const startScanner = async () => {
      try {
        const { Html5Qrcode, Html5QrcodeSupportedFormats } = await import("html5-qrcode");

        if (cancelled) return;

        // Determine which formats to scan based on mode
        let formatsToSupport: number[] | undefined;
        if (mode === "qr") {
          formatsToSupport = [Html5QrcodeSupportedFormats.QR_CODE];
        } else if (mode === "barcode") {
          formatsToSupport = [
            Html5QrcodeSupportedFormats.CODE_128,
            Html5QrcodeSupportedFormats.CODE_39,
            Html5QrcodeSupportedFormats.EAN_13,
            Html5QrcodeSupportedFormats.EAN_8,
            Html5QrcodeSupportedFormats.UPC_A,
            Html5QrcodeSupportedFormats.UPC_E,
            Html5QrcodeSupportedFormats.CODABAR,
            Html5QrcodeSupportedFormats.ITF,
          ];
        }
        // mode === "auto" → undefined → all formats

        const scanner = new Html5Qrcode(containerIdRef.current, { verbose: false });
        scannerRef.current = scanner;

        const qrbox = mode === "qr"
          ? { width: 220, height: 220 }
          : { width: 280, height: 120 };

        await scanner.start(
          { facingMode: "environment" },
          {
            fps: 10,
            qrbox,
            aspectRatio: 1.0,
            disableFlip: false,
            ...(formatsToSupport ? { formatsToSupport } : {}),
          },
          (decodedText) => {
            if (!cancelled) handleCodeScanned(decodedText);
          },
          () => {} // ignore per-frame errors
        );

        if (!cancelled) {
          setCameraActive(true);
          setError("");
        }
      } catch (err: any) {
        if (!cancelled) {
          const msg = err?.message || String(err);
          if (msg.includes("Permission") || msg.includes("NotAllowed")) {
            setError("Permiso de cámara denegado. Habilitá el acceso en ajustes del navegador.");
          } else if (msg.includes("NotFound") || msg.includes("Requested device not found")) {
            setError("No se encontró cámara en este dispositivo.");
          } else {
            setError("No se pudo abrir la cámara. Usá el modo manual.");
          }
          setCameraActive(false);
        }
      }
    };

    // Small delay to ensure DOM element exists
    const timer = setTimeout(startScanner, 100);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (scannerRef.current) {
        try {
          if (scannerRef.current.isScanning) {
            scannerRef.current.stop().then(() => {
              scannerRef.current?.clear();
            }).catch(() => {});
          }
        } catch {}
        scannerRef.current = null;
        setCameraActive(false);
      }
    };
  }, [active, manualMode, mode, handleCodeScanned]);

  // Focus manual input when switching to manual mode
  useEffect(() => {
    if (manualMode && manualInputRef.current) {
      manualInputRef.current.focus();
    }
  }, [manualMode]);

  if (!active) return null;

  const isBarcode = mode === "barcode";
  const isQr = mode === "qr";
  const accentColor = isBarcode ? "#f59e0b" : isQr ? "#10b981" : "#3b82f6";
  const modeLabel = isBarcode ? "código de barras" : isQr ? "código QR" : "código";

  return (
    <div style={{
      borderRadius: 12,
      overflow: "hidden",
      background: "var(--bg2, #1e293b)",
      border: `2px solid ${flash ? accentColor : `${accentColor}44`}`,
      marginBottom: 12,
      transition: "border-color 0.2s ease",
    }}>
      {/* Label */}
      {label && (
        <div style={{
          padding: "8px 14px",
          background: `${accentColor}15`,
          borderBottom: `1px solid ${accentColor}22`,
          fontSize: 12,
          fontWeight: 700,
          color: accentColor,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}>
          <span style={{ fontSize: 16 }}>{isBarcode ? "⊟" : "⊞"}</span>
          {label}
        </div>
      )}

      {/* Camera scanner area */}
      {!manualMode && (
        <div style={{ position: "relative" }}>
          <div
            id={containerIdRef.current}
            style={{
              width: "100%",
              minHeight: 250,
              background: "#000",
            }}
          />

          {/* Scanning indicator overlay */}
          {cameraActive && (
            <div style={{
              position: "absolute",
              bottom: 8,
              left: "50%",
              transform: "translateX(-50%)",
              background: "rgba(0,0,0,0.7)",
              color: accentColor,
              padding: "4px 12px",
              borderRadius: 20,
              fontSize: 11,
              fontWeight: 700,
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}>
              <span style={{
                width: 6, height: 6, borderRadius: "50%",
                background: accentColor,
                animation: "pulse 1.5s ease-in-out infinite",
              }} />
              Apuntá al {modeLabel}
              <style>{`@keyframes pulse { 0%,100% { opacity: 0.4; } 50% { opacity: 1; } }`}</style>
            </div>
          )}

          {/* Error message */}
          {error && (
            <div style={{
              position: "absolute",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
              background: "rgba(0,0,0,0.85)",
              color: "#ef4444",
              padding: "16px 20px",
              borderRadius: 12,
              fontSize: 13,
              fontWeight: 600,
              textAlign: "center",
              maxWidth: "85%",
            }}>
              {error}
            </div>
          )}
        </div>
      )}

      {/* Manual input mode */}
      {manualMode && (
        <div style={{ padding: 12 }}>
          <input
            ref={manualInputRef}
            type="text"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            value={manualValue}
            onChange={(e) => setManualValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleCodeScanned(manualValue);
                setManualValue("");
              }
            }}
            placeholder={placeholder || `Escribí o pegá el ${modeLabel}...`}
            style={{
              width: "100%",
              padding: "14px 16px",
              fontSize: 18,
              fontFamily: "monospace",
              fontWeight: 700,
              background: "var(--bg3, #0f172a)",
              color: "var(--txt1, #f1f5f9)",
              border: `1px solid ${accentColor}44`,
              borderRadius: 8,
              outline: "none",
              textAlign: "center",
              letterSpacing: 1,
            }}
          />
          <div style={{
            marginTop: 8,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            fontSize: 11,
            color: `${accentColor}99`,
          }}>
            Escribí el código y presioná Enter
          </div>
        </div>
      )}

      {/* Toggle camera/manual mode */}
      <div style={{
        display: "flex",
        justifyContent: "center",
        padding: "6px 12px 10px",
        borderTop: `1px solid ${accentColor}22`,
        background: `${accentColor}08`,
      }}>
        <button
          onClick={() => setManualMode(!manualMode)}
          style={{
            background: "none",
            border: "none",
            color: accentColor,
            fontSize: 12,
            fontWeight: 700,
            cursor: "pointer",
            padding: "4px 12px",
            borderRadius: 6,
            textDecoration: "underline",
          }}
        >
          {manualMode ? "📷 Usar cámara" : "⌨️ Ingresar manual"}
        </button>
      </div>

      {/* Last scanned feedback */}
      {lastScanned && (
        <div style={{
          padding: "6px 14px 10px",
          textAlign: "center",
          fontSize: 12,
          fontWeight: 700,
          color: accentColor,
          fontFamily: "monospace",
          borderTop: `1px solid ${accentColor}22`,
          background: `${accentColor}08`,
        }}>
          Ultimo: {lastScanned}
        </div>
      )}
    </div>
  );
}
