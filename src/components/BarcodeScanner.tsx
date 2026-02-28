"use client";
import { useEffect, useRef, useState, useCallback } from "react";

// ==================== TYPES ====================
type ScanMode = "barcode" | "qr" | "auto";

interface Props {
  onScan: (code: string) => void;
  active: boolean;
  label?: string;
  /** "barcode" = ultra-fast 1D scanning (ML labels), "qr" = enhanced QR scanning (positions), "auto" = all formats */
  mode?: ScanMode;
}

// Barcode-only formats for fast mode (1D only, no QR overhead)
const BARCODE_FORMATS_NATIVE = [
  "code_128", "code_39", "code_93", "ean_13", "ean_8",
  "upc_a", "upc_e", "itf", "codabar",
];
const QR_FORMATS_NATIVE = ["qr_code"];
const ALL_FORMATS_NATIVE = [
  "qr_code", "code_128", "code_39", "code_93",
  "ean_13", "ean_8", "upc_a", "upc_e", "itf",
  "codabar", "data_matrix", "aztec", "pdf417",
];

// ==================== IMAGE PREPROCESSING ====================
function applySharpen(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const imageData = ctx.getImageData(0, 0, w, h);
  const d = imageData.data;
  const copy = new Uint8ClampedArray(d);
  const kernel = [0, -1, 0, -1, 5, -1, 0, -1, 0];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      for (let c = 0; c < 3; c++) {
        let val = 0;
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            val += copy[((y + ky) * w + (x + kx)) * 4 + c] * kernel[(ky + 1) * 3 + (kx + 1)];
          }
        }
        d[(y * w + x) * 4 + c] = Math.min(255, Math.max(0, val));
      }
    }
  }
  ctx.putImageData(imageData, 0, 0);
}

function applyContrast(ctx: CanvasRenderingContext2D, w: number, h: number, factor: number) {
  const imageData = ctx.getImageData(0, 0, w, h);
  const d = imageData.data;
  const intercept = 128 * (1 - factor);
  for (let i = 0; i < d.length; i += 4) {
    d[i] = Math.min(255, Math.max(0, d[i] * factor + intercept));
    d[i + 1] = Math.min(255, Math.max(0, d[i + 1] * factor + intercept));
    d[i + 2] = Math.min(255, Math.max(0, d[i + 2] * factor + intercept));
  }
  ctx.putImageData(imageData, 0, 0);
}

function applyBinarize(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const imageData = ctx.getImageData(0, 0, w, h);
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    const gray = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    const val = gray > 128 ? 255 : 0;
    d[i] = d[i + 1] = d[i + 2] = val;
  }
  ctx.putImageData(imageData, 0, 0);
}

// ==================== BARCODE DETECTOR SUPPORT ====================
function hasBarcodeDetector(): boolean {
  return typeof window !== "undefined" && "BarcodeDetector" in window;
}

async function createNativeDetector(mode: ScanMode): Promise<any> {
  if (!hasBarcodeDetector()) return null;
  const BD = (window as any).BarcodeDetector;
  const supported = await BD.getSupportedFormats();
  const wanted = mode === "barcode" ? BARCODE_FORMATS_NATIVE
    : mode === "qr" ? QR_FORMATS_NATIVE
    : ALL_FORMATS_NATIVE;
  const formats = wanted.filter((f: string) => supported.includes(f));
  if (formats.length === 0) return null;
  return new BD({ formats });
}

// ==================== MAIN COMPONENT ====================
export default function BarcodeScanner({ onScan, active, label, mode = "auto" }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animRef = useRef<number>(0);
  const nativeDetectorRef = useRef<any>(null);
  const zxingRef = useRef<any>(null);
  const lastCode = useRef("");
  const lastTime = useRef(0);

  const isFast = mode === "barcode";

  const [err, setErr] = useState("");
  const [ready, setReady] = useState(false);
  const [lastScanned, setLastScanned] = useState("");
  const [torchOn, setTorchOn] = useState(false);
  const [torchAvail, setTorchAvail] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [zoomAvail, setZoomAvail] = useState(false);
  const [zoomMax, setZoomMax] = useState(1);
  const [enhance, setEnhance] = useState(!isFast); // OFF by default in barcode mode
  const [processing, setProcessing] = useState(false);
  const [engineLabel, setEngineLabel] = useState("");

  const onScanRef = useRef(onScan);
  useEffect(() => { onScanRef.current = onScan; }, [onScan]);

  // Deduplication: 500ms for barcode (fast), 3000ms for QR/auto
  const DEDUP_MS = isFast ? 500 : 3000;

  const handleDetection = useCallback((text: string) => {
    const now = Date.now();
    if (text === lastCode.current && now - lastTime.current < DEDUP_MS) return;
    lastCode.current = text;
    lastTime.current = now;
    if (navigator.vibrate) navigator.vibrate(isFast ? [50] : [80, 40, 80]);
    setLastScanned(text);
    onScanRef.current(text);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [DEDUP_MS, isFast]);

  // ---- START / STOP CAMERA ----
  useEffect(() => {
    if (!active) {
      stopEverything();
      setReady(false);
      return;
    }
    let alive = true;

    async function start() {
      try {
        const constraints: MediaStreamConstraints = {
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1920, min: 1280 },
            height: { ideal: 1080, min: 720 },
            // @ts-ignore
            focusMode: { ideal: "continuous" },
            // @ts-ignore
            exposureMode: { ideal: "continuous" },
            // @ts-ignore
            whiteBalanceMode: { ideal: "continuous" },
          },
          audio: false,
        };

        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        if (!alive) { stream.getTracks().forEach(t => t.stop()); return; }
        streamRef.current = stream;

        const track = stream.getVideoTracks()[0];
        if (track) {
          try {
            const caps = track.getCapabilities?.() as any;
            if (caps) {
              setTorchAvail(!!caps.torch);
              if (caps.zoom) {
                setZoomAvail(true);
                setZoomMax(Math.min(caps.zoom.max, 8));
              }
              if (caps.focusMode?.includes("continuous")) {
                await track.applyConstraints({ advanced: [{ focusMode: "continuous" } as any] });
              }
            }
          } catch {}
        }

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }

        // Init detection engines with mode-specific formats
        try {
          const native = await createNativeDetector(mode);
          if (native) {
            nativeDetectorRef.current = native;
            setEngineLabel(isFast ? "FAST" : "Nativo HD");
          }
        } catch {}

        try {
          const { Html5Qrcode, Html5QrcodeSupportedFormats } = await import("html5-qrcode") as any;
          zxingRef.current = { Html5Qrcode, Html5QrcodeSupportedFormats };
          if (!nativeDetectorRef.current) setEngineLabel(isFast ? "FAST ZX" : "ZXing");
        } catch {}

        if (alive) {
          setReady(true);
          if (isFast) startFastScan();
          else startEnhancedScan();
        }
      } catch (e: any) {
        if (alive) {
          setErr(e?.message || "No se pudo abrir la cámara");
          setReady(false);
        }
      }
    }

    start();
    return () => {
      alive = false;
      stopEverything();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, mode]);

  function stopEverything() {
    if (animRef.current) cancelAnimationFrame(animRef.current);
    animRef.current = 0;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    nativeDetectorRef.current = null;
    zxingRef.current = null;
  }

  // =============================================
  // FAST SCAN LOOP — for barcode mode
  // Every frame, detect directly from video element
  // No canvas, no preprocessing, maximum speed
  // =============================================
  function startFastScan() {
    const video = videoRef.current;
    if (!video) return;

    let pending = false;
    const processFrame = () => {
      if (!streamRef.current || !video.videoWidth || pending) {
        animRef.current = requestAnimationFrame(processFrame);
        return;
      }

      if (nativeDetectorRef.current) {
        // FAST PATH: detect directly from <video> — zero canvas overhead
        pending = true;
        nativeDetectorRef.current.detect(video).then((results: any[]) => {
          pending = false;
          if (results.length > 0) {
            handleDetection(results[0].rawValue);
          }
        }).catch(() => { pending = false; });
      } else {
        // Fallback: canvas-based ZXing (less frequent)
        fastFallbackScan(video);
      }

      animRef.current = requestAnimationFrame(processFrame);
    };

    animRef.current = requestAnimationFrame(processFrame);
  }

  // Fallback for fast mode without native BarcodeDetector
  let fallbackCounter = 0;
  function fastFallbackScan(video: HTMLVideoElement) {
    fallbackCounter++;
    if (fallbackCounter % 2 !== 0) return; // every other frame

    const canvas = canvasRef.current;
    if (!canvas) return;
    const vw = video.videoWidth;
    const vh = video.videoHeight;

    // Horizontal strip: full width, center 40% height (barcode optimized)
    const stripH = Math.floor(vh * 0.4);
    const stripY = Math.floor((vh - stripH) / 2);
    canvas.width = vw;
    canvas.height = stripH;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(video, 0, stripY, vw, stripH, 0, 0, vw, stripH);

    // Try native detector on the strip if available
    if (nativeDetectorRef.current) {
      nativeDetectorRef.current.detect(canvas).then((results: any[]) => {
        if (results.length > 0) handleDetection(results[0].rawValue);
      }).catch(() => {});
    }
  }

  // =============================================
  // ENHANCED SCAN LOOP — for qr/auto mode
  // Center crop, image preprocessing, multi-strategy
  // =============================================
  function startEnhancedScan() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    let frameCount = 0;
    const processFrame = async () => {
      if (!streamRef.current || !video.videoWidth) {
        animRef.current = requestAnimationFrame(processFrame);
        return;
      }

      frameCount++;
      if (frameCount % 3 !== 0) {
        animRef.current = requestAnimationFrame(processFrame);
        return;
      }

      const vw = video.videoWidth;
      const vh = video.videoHeight;

      const cropRatio = 0.6;
      const cx = Math.floor(vw * (1 - cropRatio) / 2);
      const cy = Math.floor(vh * (1 - cropRatio) / 2);
      const cw = Math.floor(vw * cropRatio);
      const ch = Math.floor(vh * cropRatio);

      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) { animRef.current = requestAnimationFrame(processFrame); return; }

      ctx.drawImage(video, cx, cy, cw, ch, 0, 0, cw, ch);

      if (enhance) {
        applyContrast(ctx, cw, ch, 1.4);
        applySharpen(ctx, cw, ch);
      }

      if (nativeDetectorRef.current) {
        try {
          const results = await nativeDetectorRef.current.detect(canvas);
          if (results.length > 0) {
            handleDetection(results[0].rawValue);
            animRef.current = requestAnimationFrame(processFrame);
            return;
          }
        } catch {}
      }

      // Fallback: try unprocessed frame
      if (nativeDetectorRef.current && enhance) {
        try {
          ctx.drawImage(video, cx, cy, cw, ch, 0, 0, cw, ch);
          const results = await nativeDetectorRef.current.detect(canvas);
          if (results.length > 0) {
            handleDetection(results[0].rawValue);
            animRef.current = requestAnimationFrame(processFrame);
            return;
          }
        } catch {}
      }

      // Full-frame scan every 9th processed frame
      if (frameCount % 9 === 0 && nativeDetectorRef.current) {
        try {
          canvas.width = vw;
          canvas.height = vh;
          ctx.drawImage(video, 0, 0, vw, vh);
          const results = await nativeDetectorRef.current.detect(canvas);
          if (results.length > 0) {
            handleDetection(results[0].rawValue);
          }
        } catch {}
      }

      animRef.current = requestAnimationFrame(processFrame);
    };

    animRef.current = requestAnimationFrame(processFrame);
  }

  // ---- MANUAL CAPTURE (available in all modes) ----
  const doManualCapture = useCallback(async () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    setProcessing(true);

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const canvas = document.createElement("canvas");
    canvas.width = vw;
    canvas.height = vh;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;

    const strategies = [
      () => ctx.drawImage(video, 0, 0, vw, vh),
      () => { ctx.drawImage(video, 0, 0, vw, vh); applyContrast(ctx, vw, vh, 1.6); applySharpen(ctx, vw, vh); },
      () => { ctx.drawImage(video, 0, 0, vw, vh); applyContrast(ctx, vw, vh, 2.0); },
      () => { ctx.drawImage(video, 0, 0, vw, vh); applyContrast(ctx, vw, vh, 1.3); applyBinarize(ctx, vw, vh); },
      () => { ctx.drawImage(video, 0, 0, vw, vh); applySharpen(ctx, vw, vh); applySharpen(ctx, vw, vh); },
    ];

    for (const strategy of strategies) {
      strategy();
      if (nativeDetectorRef.current) {
        try {
          const results = await nativeDetectorRef.current.detect(canvas);
          if (results.length > 0) {
            handleDetection(results[0].rawValue);
            setProcessing(false);
            return;
          }
        } catch {}
      }

      if (zxingRef.current) {
        try {
          const blob = await new Promise<Blob>((resolve) =>
            canvas.toBlob(b => resolve(b!), "image/png")
          );
          const file = new File([blob], "capture.png", { type: "image/png" });
          const { Html5Qrcode, Html5QrcodeSupportedFormats } = zxingRef.current;
          const tempId = "zxing-temp-" + Date.now();
          const tempDiv = document.createElement("div");
          tempDiv.id = tempId;
          tempDiv.style.display = "none";
          document.body.appendChild(tempDiv);
          try {
            const scanner = new Html5Qrcode(tempId, {
              formatsToSupport: isFast ? [
                Html5QrcodeSupportedFormats.CODE_128,
                Html5QrcodeSupportedFormats.CODE_39,
                Html5QrcodeSupportedFormats.EAN_13,
                Html5QrcodeSupportedFormats.EAN_8,
                Html5QrcodeSupportedFormats.UPC_A,
                Html5QrcodeSupportedFormats.UPC_E,
                Html5QrcodeSupportedFormats.ITF,
                Html5QrcodeSupportedFormats.CODE_93,
              ] : [
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
            const result = await scanner.scanFile(file, false);
            if (result) {
              handleDetection(result);
              setProcessing(false);
              tempDiv.remove();
              return;
            }
          } catch {} finally {
            tempDiv.remove();
          }
        } catch {}
      }
    }

    // Try cropped regions
    const crops = isFast ? [
      // Barcode-optimized horizontal strips
      { x: 0, y: vh * 0.3, w: vw, h: vh * 0.4 },
      { x: vw * 0.1, y: vh * 0.2, w: vw * 0.8, h: vh * 0.3 },
      { x: 0, y: vh * 0.15, w: vw, h: vh * 0.7 },
    ] : [
      { x: vw * 0.25, y: vh * 0.25, w: vw * 0.5, h: vh * 0.5 },
      { x: 0, y: 0, w: vw, h: vh * 0.5 },
      { x: 0, y: vh * 0.5, w: vw, h: vh * 0.5 },
      { x: vw * 0.1, y: vh * 0.3, w: vw * 0.8, h: vh * 0.4 },
    ];

    for (const crop of crops) {
      canvas.width = crop.w;
      canvas.height = crop.h;
      ctx.drawImage(video, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
      applyContrast(ctx, crop.w, crop.h, 1.5);
      applySharpen(ctx, crop.w, crop.h);

      if (nativeDetectorRef.current) {
        try {
          const results = await nativeDetectorRef.current.detect(canvas);
          if (results.length > 0) {
            handleDetection(results[0].rawValue);
            setProcessing(false);
            return;
          }
        } catch {}
      }
    }

    setProcessing(false);
    if (navigator.vibrate) navigator.vibrate(200);
  }, [handleDetection, isFast]);

  // ---- TORCH TOGGLE ----
  const toggleTorch = useCallback(async () => {
    if (!streamRef.current) return;
    const track = streamRef.current.getVideoTracks()[0];
    if (!track) return;
    const newVal = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: newVal } as any] });
      setTorchOn(newVal);
    } catch {}
  }, [torchOn]);

  // ---- ZOOM CONTROL ----
  const changeZoom = useCallback(async (level: number) => {
    if (!streamRef.current) return;
    const track = streamRef.current.getVideoTracks()[0];
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ zoom: level } as any] });
      setZoomLevel(level);
    } catch {}
  }, []);

  if (!active) return null;

  // Mode-specific colors and guide dimensions
  const guideColor = isFast ? "#f59e0b" : "#10b981";
  const guideW = isFast ? "85%" : "75%";
  const guideMaxW = isFast ? 340 : 300;
  const guideH = isFast ? 60 : 90;

  return (
    <div style={{ position: "relative", borderRadius: 12, overflow: "hidden", background: "#000", marginBottom: 12 }}>
      {/* Label overlay */}
      {label && (
        <div style={{
          position: "absolute", top: 10, left: "50%", transform: "translateX(-50%)", zIndex: 10,
          background: isFast ? "rgba(245,158,11,0.85)" : "rgba(0,0,0,0.75)",
          color: isFast ? "#000" : "#fff", padding: "6px 16px", borderRadius: 20,
          fontSize: 12, fontWeight: 700, whiteSpace: "nowrap",
        }}>{isFast ? "FAST " : ""}{label}</div>
      )}

      {/* Video element */}
      <video
        ref={videoRef}
        playsInline
        muted
        autoPlay
        style={{
          width: "100%", display: "block",
          minHeight: isFast ? 200 : 260,
          objectFit: "cover",
          filter: (!isFast && enhance) ? "contrast(1.1) brightness(1.05)" : "none",
        }}
      />

      {/* Hidden processing canvas */}
      <canvas ref={canvasRef} style={{ display: "none" }} />

      {/* Scan guide overlay */}
      {ready && (
        <div style={{
          position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)",
          width: guideW, maxWidth: guideMaxW, height: guideH,
          border: `2px solid ${guideColor}88`, borderRadius: 8,
          pointerEvents: "none", zIndex: 5,
        }}>
          {/* Corner brackets */}
          <div style={{ position: "absolute", top: -2, left: -2, width: 20, height: 20, borderTop: `3px solid ${guideColor}`, borderLeft: `3px solid ${guideColor}`, borderRadius: "4px 0 0 0" }} />
          <div style={{ position: "absolute", top: -2, right: -2, width: 20, height: 20, borderTop: `3px solid ${guideColor}`, borderRight: `3px solid ${guideColor}`, borderRadius: "0 4px 0 0" }} />
          <div style={{ position: "absolute", bottom: -2, left: -2, width: 20, height: 20, borderBottom: `3px solid ${guideColor}`, borderLeft: `3px solid ${guideColor}`, borderRadius: "0 0 0 4px" }} />
          <div style={{ position: "absolute", bottom: -2, right: -2, width: 20, height: 20, borderBottom: `3px solid ${guideColor}`, borderRight: `3px solid ${guideColor}`, borderRadius: "0 0 4px 0" }} />
          {/* Scanning line */}
          <div style={{
            position: "absolute", top: 0, left: 4, right: 4, height: 2,
            background: `linear-gradient(90deg, transparent, ${guideColor}, transparent)`,
            animation: isFast ? "scanLineFast 0.8s ease-in-out infinite" : "scanLine 2s ease-in-out infinite",
          }} />
          <style>{`
            @keyframes scanLine { 0%,100% { top: 0; } 50% { top: calc(100% - 2px); } }
            @keyframes scanLineFast { 0%,100% { top: 0; } 50% { top: calc(100% - 2px); } }
          `}</style>
          <div style={{
            position: "absolute", top: -22, left: "50%", transform: "translateX(-50%)",
            fontSize: 10, color: guideColor, fontWeight: 600, whiteSpace: "nowrap",
            background: "rgba(0,0,0,0.6)", padding: "2px 8px", borderRadius: 4,
          }}>
            {isFast ? "Apunta al código de barras" : "Centra el código aquí"}
          </div>
        </div>
      )}

      {/* Camera controls bar */}
      {ready && (
        <div style={{
          position: "absolute", bottom: lastScanned ? 36 : 8, left: 8, right: 8, zIndex: 10,
          display: "flex", gap: 6, justifyContent: "center", flexWrap: "wrap",
        }}>
          {/* Torch button */}
          {torchAvail && (
            <button onClick={toggleTorch} style={{
              padding: "6px 12px", borderRadius: 20, fontSize: 11, fontWeight: 700,
              background: torchOn ? "rgba(245,158,11,0.9)" : "rgba(0,0,0,0.7)",
              color: torchOn ? "#000" : "#fff", border: `1px solid ${torchOn ? "#f59e0b" : "#ffffff44"}`,
              display: "flex", alignItems: "center", gap: 4,
            }}>
              {torchOn ? "ON" : "Flash"}
            </button>
          )}

          {/* Zoom controls */}
          {zoomAvail && (
            <div style={{ display: "flex", gap: 2, background: "rgba(0,0,0,0.7)", borderRadius: 20, padding: "2px 4px", border: "1px solid #ffffff22" }}>
              {[1, 2, 3, 4].filter(z => z <= zoomMax).map(z => (
                <button key={z} onClick={() => changeZoom(z)} style={{
                  padding: "4px 10px", borderRadius: 16, fontSize: 11, fontWeight: 700, border: "none",
                  background: zoomLevel === z ? "#3b82f6" : "transparent",
                  color: zoomLevel === z ? "#fff" : "#ffffffaa",
                }}>
                  {z}x
                </button>
              ))}
            </div>
          )}

          {/* Enhancement toggle — only in QR/auto mode */}
          {!isFast && (
            <button onClick={() => setEnhance(!enhance)} style={{
              padding: "6px 12px", borderRadius: 20, fontSize: 11, fontWeight: 700,
              background: enhance ? "rgba(16,185,129,0.8)" : "rgba(0,0,0,0.7)",
              color: enhance ? "#000" : "#fff", border: `1px solid ${enhance ? "#10b981" : "#ffffff44"}`,
            }}>
              {enhance ? "HD ON" : "HD"}
            </button>
          )}

          {/* Manual capture button */}
          <button onClick={doManualCapture} disabled={processing} style={{
            padding: "6px 12px", borderRadius: 20, fontSize: 11, fontWeight: 700,
            background: processing ? "rgba(245,158,11,0.8)" : "rgba(59,130,246,0.8)",
            color: "#fff", border: "1px solid #ffffff44",
            animation: processing ? "pulse 1s ease-in-out infinite" : "none",
          }}>
            {processing ? "..." : "Capturar"}
          </button>
        </div>
      )}

      {/* Loading state */}
      {!ready && !err && (
        <div style={{
          position: "absolute", inset: 0, display: "flex", alignItems: "center",
          justifyContent: "center", color: "#94a3b8", fontSize: 13,
          flexDirection: "column", gap: 8,
        }}>
          <div style={{ animation: "pulse 1.5s ease-in-out infinite" }}>
            {isFast ? "Abriendo cámara rápida..." : "Abriendo cámara HD..."}
          </div>
          <div style={{ fontSize: 10, color: "#64748b" }}>Solicitando máxima resolución</div>
        </div>
      )}

      {/* Error state */}
      {err && (
        <div style={{ padding: 24, textAlign: "center" }}>
          <div style={{ fontSize: 13, color: "#ef4444", marginBottom: 8 }}>{err}</div>
          <div style={{ fontSize: 11, color: "#94a3b8" }}>Da permiso de cámara al navegador</div>
        </div>
      )}

      {/* Last scanned indicator */}
      {lastScanned && (
        <div style={{
          position: "absolute", bottom: 8, left: "50%", transform: "translateX(-50%)",
          background: isFast ? "rgba(245,158,11,0.9)" : "rgba(16,185,129,0.9)",
          color: isFast ? "#000" : "#fff", padding: "4px 14px",
          borderRadius: 20, fontSize: 11, fontWeight: 700, zIndex: 10,
        }}>
          {lastScanned}
        </div>
      )}

      {/* Engine & resolution info */}
      {ready && (
        <div style={{
          position: "absolute", top: label ? 38 : 10, right: 10, zIndex: 10,
          background: isFast ? "rgba(245,158,11,0.7)" : "rgba(0,0,0,0.6)",
          padding: "3px 8px", borderRadius: 8,
          fontSize: 9, color: isFast ? "#000" : "#10b98199", fontWeight: 700,
          display: "flex", gap: 6, alignItems: "center",
        }}>
          {engineLabel && <span>{engineLabel}</span>}
          {videoRef.current && videoRef.current.videoWidth > 0 && (
            <span>{videoRef.current.videoWidth}x{videoRef.current.videoHeight}</span>
          )}
        </div>
      )}
    </div>
  );
}
