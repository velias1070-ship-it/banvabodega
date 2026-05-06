"use client";
/**
 * Banner inline que se muestra dentro del detalle de la factura en
 * AdminRecepciones cuando una línea tiene una discrepancia de costo
 * pendiente o aprobada (Chunk 6).
 *
 * Banner amber con info de costos + botones inline para Aprobar / Rechazar / Dejar pendiente.
 * Si la disc ya está APROBADA, muestra botón "↩ Revertir aprobación".
 */
import { useState } from "react";
import type { DBDiscrepanciaCosto } from "@/lib/db";
import DiscrepanciaActionsModal from "./DiscrepanciaActionsModal";

interface Props {
  disc: DBDiscrepanciaCosto;
  onResuelto: () => void;
}

const fmtMoney = (n: number) =>
  (n >= 0 ? "" : "−") + "$" + Math.abs(Math.round(n)).toLocaleString("es-CL");
const fmtPct = (n: number) => (n >= 0 ? "+" : "") + Number(n).toFixed(1) + "%";

export default function RecepcionDiscBanner({ disc, onResuelto }: Props) {
  const [modal, setModal] = useState<"aprobar" | "rechazar" | "revertir" | null>(null);

  if (disc.estado === "APROBADO") {
    return (
      <>
        <div style={{
          padding: "8px 12px", borderRadius: 6, marginTop: 6,
          background: "rgba(16,185,129,0.08)",
          border: "1px solid rgba(16,185,129,0.30)",
          display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
        }}>
          <span style={{ fontSize: 11, color: "var(--green)", fontWeight: 700 }}>
            ✅ Disc aprobada
          </span>
          <span className="mono" style={{ fontSize: 11, fontWeight: 700, color: "var(--txt)", padding: "1px 6px", borderRadius: 3, background: "var(--bg3)" }}>
            {disc.sku}
          </span>
          <span style={{ fontSize: 11, color: "var(--txt2)" }}>
            costo final {fmtMoney(disc.costo_factura)}
          </span>
          {disc.es_puntual && (
            <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 3, background: "var(--bg3)", color: "var(--cyan)", fontWeight: 600 }}>
              PUNTUAL
            </span>
          )}
          {disc.claim_estado === "ESPERANDO_NC" && disc.claim_monto_pendiente && (
            <span style={{
              fontSize: 10, padding: "2px 6px", borderRadius: 3,
              background: "rgba(245,158,11,0.15)", color: "var(--amber)", fontWeight: 700,
              border: "1px solid var(--amberBd)",
            }}>
              ⏳ esperando NC por {fmtMoney(disc.claim_monto_pendiente)}
            </span>
          )}
          {disc.claim_estado === "RESUELTO_CON_NC" && (
            <span style={{
              fontSize: 10, padding: "2px 6px", borderRadius: 3,
              background: "rgba(16,185,129,0.15)", color: "var(--green)", fontWeight: 700,
            }}>
              ✓ reconciliada con NC
            </span>
          )}
          <div style={{ flex: 1 }} />
          <button
            onClick={() => setModal("revertir")}
            style={{
              padding: "4px 10px", borderRadius: 5, background: "var(--bg3)",
              color: "var(--amber)", fontSize: 10, fontWeight: 700,
              border: "1px solid var(--amberBd)", cursor: "pointer",
            }}
          >
            ↩ Revertir aprobación
          </button>
        </div>
        {modal && (
          <DiscrepanciaActionsModal
            modo={modal}
            discId={disc.id!}
            sku={disc.sku}
            costoFactura={disc.costo_factura}
            costoCatalogo={disc.costo_diccionario}
            onCerrar={() => setModal(null)}
            onResuelto={onResuelto}
          />
        )}
      </>
    );
  }

  if (disc.estado !== "PENDIENTE") {
    // RECHAZADO: mostrar info compacta sin botones
    return (
      <div style={{
        padding: "6px 10px", borderRadius: 6, marginTop: 6, fontSize: 10,
        background: "rgba(239,68,68,0.06)", border: "1px solid rgba(239,68,68,0.25)",
        color: "var(--txt2)",
      }}>
        ❌ Disc rechazada {disc.notas ? `— ${disc.notas}` : ""}
      </div>
    );
  }

  // PENDIENTE: banner principal con acciones
  return (
    <>
      <div style={{
        padding: "10px 12px", borderRadius: 6, marginTop: 6,
        background: "rgba(245,158,11,0.10)",
        border: "1px solid var(--amberBd)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, color: "var(--amber)", fontWeight: 700 }}>
            ⚠️ Discrepancia de costo
          </span>
          <span className="mono" style={{ fontSize: 11, fontWeight: 700, color: "var(--txt)", padding: "1px 6px", borderRadius: 3, background: "var(--bg3)" }}>
            {disc.sku}
          </span>
          <span style={{ fontSize: 11, color: "var(--txt2)" }}>
            acordado <strong className="mono">{fmtMoney(disc.costo_diccionario)}</strong>
            {" "}vs factura <strong className="mono">{fmtMoney(disc.costo_factura)}</strong>
          </span>
          <span style={{
            fontSize: 10, fontWeight: 700,
            color: disc.diferencia >= 0 ? "var(--red)" : "var(--green)",
            padding: "1px 6px", borderRadius: 3,
            background: disc.diferencia >= 0 ? "rgba(239,68,68,0.15)" : "rgba(16,185,129,0.15)",
          }}>
            {fmtPct(disc.porcentaje)}
          </span>
        </div>

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button
            onClick={() => setModal("aprobar")}
            style={{
              padding: "6px 12px", borderRadius: 5, background: "var(--green)",
              color: "#0a0e17", fontSize: 11, fontWeight: 700, border: "none", cursor: "pointer",
            }}
          >
            ✅ Aprobar
          </button>
          <button
            onClick={() => setModal("rechazar")}
            style={{
              padding: "6px 12px", borderRadius: 5, background: "var(--red)",
              color: "#fff", fontSize: 11, fontWeight: 700, border: "none", cursor: "pointer",
            }}
          >
            ❌ Rechazar
          </button>
          <button
            disabled
            title="La disc queda PENDIENTE — no hace falta acción explícita"
            style={{
              padding: "6px 12px", borderRadius: 5, background: "transparent",
              color: "var(--txt3)", fontSize: 11, fontWeight: 600,
              border: "1px solid var(--bg4)", cursor: "not-allowed",
            }}
          >
            💤 Dejar pendiente
          </button>
        </div>
      </div>

      {modal && (
        <DiscrepanciaActionsModal
          modo={modal}
          discId={disc.id!}
          sku={disc.sku}
          costoFactura={disc.costo_factura}
          costoCatalogo={disc.costo_diccionario}
          onCerrar={() => setModal(null)}
          onResuelto={onResuelto}
        />
      )}
    </>
  );
}
