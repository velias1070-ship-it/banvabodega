"use client";
/**
 * Modal del operador cuando una línea de recepción tiene discrepancia
 * de costo (Chunk 5, plan §6.1).
 *
 * Aparece ANTES del INSERT en movimientos. El operador elige entre:
 *   1. Ubicar con el precio acordado (catálogo) — es la decisión por
 *      defecto. Crea disc PENDIENTE y deja que admin la resuelva luego.
 *   2. Pausar la línea — no ubica, marca pausada y manda WhatsApp a Vicente.
 *
 * Decisiones intencionales:
 *   - No hay opción "ubicar con costo facturado" desde acá. Si Vicente
 *     decide aceptar el costo facturado, lo aprueba desde admin.
 *   - El componente es presentational. Toda la persistencia la hace
 *     el caller (page.tsx) en `onUbicarConAcordado` / `onPausar`.
 */
import { useState } from "react";

interface Props {
  visible: boolean;
  sku: string;
  costoFacturado: number;
  costoAcordado: number;
  abc: "A" | "B" | "C" | null;
  saving: boolean;
  onUbicarConAcordado: () => void | Promise<void>;
  onPausar: (motivo?: string) => void | Promise<void>;
  onCancelar: () => void;
}

const fmtMoney = (n: number) => "$" + Math.round(n).toLocaleString("es-CL");

export default function OperadorDiscrepanciaModal({
  visible, sku, costoFacturado, costoAcordado, abc,
  saving, onUbicarConAcordado, onPausar, onCancelar,
}: Props) {
  const [confirmandoPausa, setConfirmandoPausa] = useState(false);

  if (!visible) return null;

  const diff = costoFacturado - costoAcordado;
  const pct = costoAcordado > 0 ? (diff / costoAcordado) * 100 : 0;
  const pctTxt = (pct >= 0 ? "+" : "") + pct.toFixed(1) + "%";
  const diffTxt = (diff >= 0 ? "+" : "") + fmtMoney(diff);
  const colorDiff = diff > 0 ? "var(--red)" : "var(--amber)";
  const abcTxt = abc ? `Clase ${abc}` : "Sin ABC";

  return (
    <div
      onClick={() => !saving && onCancelar()}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)",
        zIndex: 9999, display: "flex", alignItems: "flex-end",
        justifyContent: "center", padding: 0,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: "var(--bg2)", width: "100%", maxWidth: 480,
          borderTopLeftRadius: 16, borderTopRightRadius: 16,
          border: "1px solid var(--bg4)", borderBottom: "none",
          padding: 18, paddingBottom: "calc(18px + env(safe-area-inset-bottom))",
          maxHeight: "85vh", overflow: "auto",
        }}
      >
        {/* Header */}
        <div style={{ marginBottom: 14, textAlign: "center" }}>
          <div style={{ fontSize: 12, color: "var(--amber)", fontWeight: 700, letterSpacing: 0.5 }}>
            ⚠️ DISCREPANCIA DE COSTO
          </div>
          <div className="mono" style={{ fontSize: 18, fontWeight: 700, marginTop: 4 }}>
            {sku}
          </div>
          <div style={{ fontSize: 10, color: "var(--txt3)", marginTop: 2 }}>
            {abcTxt}
          </div>
        </div>

        {/* Costos */}
        <div style={{
          display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12,
        }}>
          <div style={{ padding: 12, background: "var(--bg3)", borderRadius: 8, textAlign: "center" }}>
            <div style={{ fontSize: 10, color: "var(--txt3)", marginBottom: 4 }}>Acordado</div>
            <div className="mono" style={{ fontSize: 18, fontWeight: 700, color: "var(--green)" }}>
              {fmtMoney(costoAcordado)}
            </div>
          </div>
          <div style={{ padding: 12, background: "var(--bg3)", borderRadius: 8, textAlign: "center" }}>
            <div style={{ fontSize: 10, color: "var(--txt3)", marginBottom: 4 }}>Factura</div>
            <div className="mono" style={{ fontSize: 18, fontWeight: 700, color: "var(--amber)" }}>
              {fmtMoney(costoFacturado)}
            </div>
          </div>
        </div>

        {/* Diferencia */}
        <div style={{
          padding: 10, background: "var(--bg3)", borderRadius: 8, marginBottom: 16, textAlign: "center",
        }}>
          <div style={{ fontSize: 10, color: "var(--txt3)" }}>Diferencia por unidad</div>
          <div className="mono" style={{ fontSize: 16, fontWeight: 700, color: colorDiff, marginTop: 2 }}>
            {diffTxt} ({pctTxt})
          </div>
        </div>

        {/* Acciones */}
        {!confirmandoPausa ? (
          <>
            <button
              disabled={saving}
              onClick={() => onUbicarConAcordado()}
              style={{
                width: "100%", padding: "16px 20px", borderRadius: 10,
                background: "var(--green)", color: "#0a0e17",
                fontSize: 15, fontWeight: 700, border: "none",
                cursor: saving ? "wait" : "pointer", marginBottom: 10,
              }}
            >
              {saving ? "Ubicando…" : `Ubicar con ${fmtMoney(costoAcordado)} (acordado)`}
            </button>

            <button
              disabled={saving}
              onClick={() => setConfirmandoPausa(true)}
              style={{
                width: "100%", padding: "14px 20px", borderRadius: 10,
                background: "var(--amberBg)", color: "var(--amber)",
                fontSize: 14, fontWeight: 700,
                border: "1px solid var(--amberBd)",
                cursor: saving ? "wait" : "pointer", marginBottom: 10,
              }}
            >
              ⏸ Pausar — avisar a Vicente
            </button>

            <button
              disabled={saving}
              onClick={onCancelar}
              style={{
                width: "100%", padding: "10px 20px", borderRadius: 10,
                background: "transparent", color: "var(--txt3)",
                fontSize: 12, fontWeight: 600, border: "1px solid var(--bg4)",
                cursor: saving ? "wait" : "pointer",
              }}
            >
              Cancelar
            </button>
          </>
        ) : (
          <ConfirmacionPausa
            saving={saving}
            onConfirmar={(motivo) => onPausar(motivo)}
            onVolver={() => setConfirmandoPausa(false)}
          />
        )}
      </div>
    </div>
  );
}

function ConfirmacionPausa({
  saving, onConfirmar, onVolver,
}: {
  saving: boolean;
  onConfirmar: (motivo?: string) => void | Promise<void>;
  onVolver: () => void;
}) {
  const [nota, setNota] = useState("");
  return (
    <>
      <div style={{ marginBottom: 12, textAlign: "center" }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--amber)", marginBottom: 4 }}>
          Confirmar pausa
        </div>
        <div style={{ fontSize: 11, color: "var(--txt3)", lineHeight: 1.5 }}>
          La línea queda pausada hasta que Vicente resuelva la discrepancia.
          Mientras, no se ubica.
        </div>
      </div>

      <div style={{ marginBottom: 12 }}>
        <label style={{ fontSize: 10, color: "var(--txt3)", display: "block", marginBottom: 4 }}>
          Nota opcional para Vicente
        </label>
        <textarea
          value={nota}
          onChange={e => setNota(e.target.value)}
          placeholder="Ej: factura no coincide con la guía…"
          rows={2}
          style={{
            width: "100%", padding: "8px 12px", borderRadius: 6,
            background: "var(--bg3)", border: "1px solid var(--bg4)",
            color: "var(--txt)", fontSize: 13, resize: "vertical",
            fontFamily: "inherit",
          }}
        />
      </div>

      <button
        disabled={saving}
        onClick={() => onConfirmar(nota.trim() || undefined)}
        style={{
          width: "100%", padding: "14px 20px", borderRadius: 10,
          background: "var(--amber)", color: "#0a0e17",
          fontSize: 14, fontWeight: 700, border: "none",
          cursor: saving ? "wait" : "pointer", marginBottom: 10,
        }}
      >
        {saving ? "Pausando…" : "Confirmar pausa"}
      </button>
      <button
        disabled={saving}
        onClick={onVolver}
        style={{
          width: "100%", padding: "10px 20px", borderRadius: 10,
          background: "transparent", color: "var(--txt3)",
          fontSize: 12, fontWeight: 600, border: "1px solid var(--bg4)",
          cursor: saving ? "wait" : "pointer",
        }}
      >
        Volver
      </button>
    </>
  );
}
