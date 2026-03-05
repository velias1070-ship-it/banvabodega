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
  /** Kept for API compatibility */
  autoRefocus?: boolean;
}

// Singleton SDK instance
let sdkInstance: any = null;
let sdkInitPromise: Promise<any> | null = null;

async function getScanbotSDK() {
  if (sdkInstance) return sdkInstance;
  if (sdkInitPromise) return sdkInitPromise;

  sdkInitPromise = (async () => {
    const ScanbotSDK = (await import("scanbot-web-sdk/ui")).default;
    sdkInstance = ScanbotSDK;
    await ScanbotSDK.initialize({
      licenseKey: "",
      enginePath: "/wasm/",
    });
    return ScanbotSDK;
  })();

  return sdkInitPromise;
}

// Force-release any camera streams held by the browser
function releaseAllCameraStreams() {
  try {
    // Remove any lingering Scanbot overlay elements
    document.querySelectorAll('[class*="scanbot"], [id*="scanbot"]').forEach(el => el.remove());
  } catch (_) {}
}


// ==================== SCANBOT CAMERA BARCODE/QR SCANNER ====================
export default function BarcodeScanner({
  onScan,
  active,
  label,
  mode = "auto",
}: Props) {
  const onScanRef = useRef(onScan);
  const lastCode = useRef("");
  const lastTime = useRef(0);
  const mountedRef = useRef(true);

  const [lastScanned, setLastScanned] = useState("");
  const [flash, setFlash] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [manualMode, setManualMode] = useState(false);
  const [manualValue, setManualValue] = useState("");
  const manualInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { onScanRef.current = onScan; }, [onScan]);

  // Cleanup on unmount: release camera streams and remove stale overlays
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      releaseAllCameraStreams();
    };
  }, []);

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

  const startScanning = useCallback(async () => {
    try {
      // Clean up any stale overlays from previous sessions
      releaseAllCameraStreams();

      setScanning(true);
      const ScanbotSDK = await getScanbotSDK();

      if (!mountedRef.current) return;

      const config = new ScanbotSDK.UI.Config.BarcodeScannerScreenConfiguration();

      // Theme colors matching the app
      config.palette.sbColorPrimary = "#3b82f6";
      config.palette.sbColorOnPrimary = "#ffffff";
      config.palette.sbColorPositive = "#10b981";

      // Single scan mode — scan one code and return
      const useCase = new ScanbotSDK.UI.Config.SingleScanningMode();
      useCase.confirmationSheetEnabled = false;
      config.useCase = useCase;

      // Configure barcode formats based on mode
      if (mode === "qr") {
        config.scannerConfiguration.barcodeFormats = ["QR_CODE"];
        config.userGuidance.title.text = "Apuntá al código QR";
        config.viewFinder.aspectRatio = { width: 1, height: 1 };
      } else if (mode === "barcode") {
        config.scannerConfiguration.barcodeFormats = [
          "CODE_128", "CODE_39", "CODE_93",
          "EAN_13", "EAN_8",
          "UPC_A", "UPC_E",
          "CODABAR", "ITF",
          "DATABAR", "DATABAR_EXPANDED",
        ];
        config.userGuidance.title.text = "Apuntá al código de barras";
        config.viewFinder.aspectRatio = { width: 5, height: 1 };
      } else {
        config.userGuidance.title.text = "Apuntá al código";
      }

      // Spanish localization for top bar
      config.topBar.mode = "SOLID";

      // Sound & vibration
      config.sound.successBeepEnabled = true;
      config.vibration.enabled = true;

      // Launch scanner
      const result = await ScanbotSDK.UI.createBarcodeScanner(config);

      if (!mountedRef.current) return;

      if (result && result.items && result.items.length > 0) {
        handleCodeScanned(result.items[0].barcode.text);
      }
    } catch (err) {
      console.error("Scanbot error:", err);
      // If camera failed, clean up stale state so next attempt works
      releaseAllCameraStreams();
    } finally {
      if (mountedRef.current) setScanning(false);
    }
  }, [mode, handleCodeScanned]);

  // Focus manual input
  useEffect(() => {
    if (manualMode && manualInputRef.current) {
      manualInputRef.current.focus();
    }
  }, [manualMode]);

  // Pre-load SDK when component becomes active
  useEffect(() => {
    if (active && !manualMode) {
      getScanbotSDK().catch(() => {});
    }
  }, [active, manualMode]);

  if (!active) return null;

  const isBarcode = mode === "barcode";
  const isQr = mode === "qr";
  const accentColor = isBarcode ? "#f59e0b" : isQr ? "#10b981" : "#3b82f6";
  const modeLabel = isBarcode ? "código de barras" : isQr ? "código QR" : "código";
  const modeIcon = isBarcode ? "⊟" : "⊞";

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
          <span style={{ fontSize: 16 }}>{modeIcon}</span>
          {label}
        </div>
      )}

      {/* Camera scan button */}
      {!manualMode && (
        <div style={{ padding: 16, display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
          <button
            onClick={startScanning}
            disabled={scanning}
            style={{
              width: "100%",
              padding: "20px 16px",
              borderRadius: 12,
              border: `2px solid ${accentColor}`,
              background: `${accentColor}15`,
              color: accentColor,
              fontSize: 16,
              fontWeight: 700,
              cursor: scanning ? "wait" : "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 10,
              opacity: scanning ? 0.6 : 1,
            }}
          >
            <span style={{ fontSize: 24 }}>📷</span>
            {scanning ? "Abriendo cámara..." : `Escanear ${modeLabel}`}
          </button>
          <div style={{ fontSize: 11, color: `${accentColor}88`, textAlign: "center" }}>
            Toca el botón para abrir la cámara y escanear
          </div>
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
            placeholder={`Escribí o pegá el ${modeLabel}...`}
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
