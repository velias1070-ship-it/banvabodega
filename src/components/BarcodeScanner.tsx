"use client";
import { useEffect, useRef, useState, useCallback } from "react";

// ==================== TYPES ====================
type ScanMode = "barcode" | "qr" | "auto";

interface Props {
  onScan: (code: string) => void;
  active: boolean;
  label?: string;
  /** Kept for API compatibility — keyboard wedge works for all formats */
  mode?: ScanMode;
  /** Placeholder text for the input */
  placeholder?: string;
  /** Auto-refocus input after scan (default true) */
  autoRefocus?: boolean;
}

// ==================== KEYBOARD WEDGE SCANNER INPUT ====================
export default function BarcodeScanner({
  onScan,
  active,
  label,
  mode = "auto",
  placeholder,
  autoRefocus = true,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const lastCode = useRef("");
  const lastTime = useRef(0);
  const onScanRef = useRef(onScan);

  const [value, setValue] = useState("");
  const [lastScanned, setLastScanned] = useState("");
  const [flash, setFlash] = useState(false);

  useEffect(() => { onScanRef.current = onScan; }, [onScan]);

  // Dedup: ignore same code within 800ms (scanner can double-fire)
  const DEDUP_MS = 800;

  // Auto-focus when active
  useEffect(() => {
    if (active && inputRef.current) {
      inputRef.current.focus();
    }
  }, [active]);

  // Re-focus on blur (keep scanner input always ready)
  const handleBlur = useCallback(() => {
    if (active && autoRefocus) {
      // Small delay to allow intentional clicks elsewhere
      setTimeout(() => {
        if (inputRef.current && document.activeElement !== inputRef.current) {
          inputRef.current.focus();
        }
      }, 200);
    }
  }, [active, autoRefocus]);

  const handleSubmit = useCallback((code: string) => {
    const trimmed = code.trim();
    if (!trimmed) return;

    const now = Date.now();
    if (trimmed === lastCode.current && now - lastTime.current < DEDUP_MS) {
      setValue("");
      return;
    }

    lastCode.current = trimmed;
    lastTime.current = now;

    // Visual feedback
    setLastScanned(trimmed);
    setFlash(true);
    setTimeout(() => setFlash(false), 400);
    if (navigator.vibrate) navigator.vibrate(50);

    // Fire callback and clear
    onScanRef.current(trimmed);
    setValue("");

    // Re-focus for next scan
    if (autoRefocus) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [autoRefocus]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSubmit(value);
    }
  }, [value, handleSubmit]);

  if (!active) return null;

  const isBarcode = mode === "barcode";
  const accentColor = isBarcode ? "#f59e0b" : "#10b981";
  const defaultPlaceholder = isBarcode
    ? "Escanea código de barras..."
    : mode === "qr"
      ? "Escanea código QR..."
      : "Escanea código...";

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

      {/* Scanner input */}
      <div style={{ padding: 12 }}>
        <input
          ref={inputRef}
          type="text"
          inputMode="none"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          placeholder={placeholder || defaultPlaceholder}
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

        {/* Status indicator */}
        <div style={{
          marginTop: 8,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          fontSize: 11,
          color: `${accentColor}99`,
        }}>
          <span style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: accentColor,
            animation: "pulse 2s ease-in-out infinite",
          }} />
          Listo para escanear — apunta el lector al código
          <style>{`@keyframes pulse { 0%,100% { opacity: 0.4; } 50% { opacity: 1; } }`}</style>
        </div>
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
