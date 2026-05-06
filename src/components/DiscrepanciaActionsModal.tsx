"use client";
/**
 * Modal compartido para acciones sobre discrepancias de costo (Chunk 6).
 *
 * Reusado desde:
 *   - AdminRecepciones (inline en el detalle de la factura)
 *   - AdminDiscrepancias (vista global cross-recepción)
 *
 * Soporta tres modos:
 *   - "aprobar":  input nuevoCosto + checkbox esPuntual + preview de impacto
 *   - "rechazar": radio sub-acción + notas
 *   - "revertir": confirmación + motivo obligatorio
 */
import { useState, useEffect } from "react";
import {
  aprobarNuevoCosto, rechazarNuevoCosto, revertirAprobacion,
  calcularPreviewImpactoAprobacion,
} from "@/lib/store";
import type { RechazarSubAccion } from "@/lib/store";

type Modo = "aprobar" | "rechazar" | "revertir";

interface Props {
  modo: Modo;
  discId: string;
  sku: string;
  costoFactura: number;
  costoCatalogo: number;
  onCerrar: () => void;
  onResuelto: () => void;
}

const fmtMoney = (n: number) =>
  (n >= 0 ? "" : "−") + "$" + Math.abs(Math.round(n)).toLocaleString("es-CL");

export default function DiscrepanciaActionsModal(p: Props) {
  return (
    <div
      onClick={p.onCerrar}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
        zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: "var(--bg2)", borderRadius: 12, border: "1px solid var(--bg4)",
          padding: 20, maxWidth: 520, width: "100%", maxHeight: "90vh", overflow: "auto",
        }}
      >
        {p.modo === "aprobar" && <ContentAprobar {...p} />}
        {p.modo === "rechazar" && <ContentRechazar {...p} />}
        {p.modo === "revertir" && <ContentRevertir {...p} />}
      </div>
    </div>
  );
}

// ---- Aprobar ----

function ContentAprobar({ discId, sku, costoFactura, costoCatalogo, onCerrar, onResuelto }: Props) {
  const [costo, setCosto] = useState<string>(String(costoFactura));
  const [esPuntual, setEsPuntual] = useState(false);
  const [notas, setNotas] = useState("");
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<{
    ventasAfectadas: number; costoTotalDelta: number;
  } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // Recalcular preview al cambiar nuevoCosto (debounced)
  useEffect(() => {
    const n = Number(costo);
    if (!Number.isFinite(n) || n <= 0) { setPreview(null); return; }
    setPreviewLoading(true);
    const t = setTimeout(async () => {
      try {
        const r = await calcularPreviewImpactoAprobacion({ discId, nuevoCosto: n });
        setPreview({ ventasAfectadas: r.ventasAfectadas, costoTotalDelta: r.costoTotalDelta });
      } catch {
        setPreview(null);
      } finally {
        setPreviewLoading(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [costo, discId]);

  const aplicar = async () => {
    const n = Number(costo);
    if (!Number.isFinite(n) || n <= 0) { alert("Costo inválido"); return; }
    setSaving(true);
    try {
      await aprobarNuevoCosto(discId, sku, n, {
        esPuntual,
        notas: notas.trim() || undefined,
      });
      onResuelto();
      onCerrar();
    } catch (e) {
      alert("Error al aprobar: " + (e instanceof Error ? e.message : e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <h3 style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 700 }}>✅ Aprobar costo — {sku}</h3>
      <p style={{ fontSize: 11, color: "var(--txt3)", margin: "0 0 14px" }}>
        Aplica el costo al WAC, recompute márgenes de ventas posteriores y actualiza el catálogo (excepto si es puntual).
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
        <Stat label="Acordado" value={fmtMoney(costoCatalogo)} color="var(--green)" />
        <Stat label="Factura" value={fmtMoney(costoFactura)} color="var(--amber)" />
      </div>

      <label style={{ fontSize: 11, color: "var(--txt2)", display: "block", marginBottom: 4 }}>
        Costo a aplicar (neto, sin IVA)
      </label>
      <input
        type="number" inputMode="numeric" value={costo}
        onChange={e => setCosto(e.target.value)}
        style={{
          width: "100%", padding: "8px 12px", borderRadius: 6,
          background: "var(--bg3)", border: "1px solid var(--bg4)",
          color: "var(--txt)", fontSize: 14, marginBottom: 10,
        }}
      />

      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, marginBottom: 12, cursor: "pointer" }}>
        <input type="checkbox" checked={esPuntual} onChange={e => setEsPuntual(e.target.checked)} />
        <span>Es descuento puntual (no actualizar precio acordado del catálogo)</span>
      </label>

      <label style={{ fontSize: 11, color: "var(--txt2)", display: "block", marginBottom: 4 }}>
        Notas (opcional)
      </label>
      <textarea
        value={notas} onChange={e => setNotas(e.target.value)} rows={2}
        placeholder="Ej: descuento por volumen acordado por mail con Idetex"
        style={{
          width: "100%", padding: "8px 12px", borderRadius: 6,
          background: "var(--bg3)", border: "1px solid var(--bg4)",
          color: "var(--txt)", fontSize: 12, marginBottom: 12, fontFamily: "inherit", resize: "vertical",
        }}
      />

      {/* Preview de impacto */}
      <div style={{
        padding: 10, background: "var(--bg3)", borderRadius: 8, marginBottom: 14,
        borderLeft: "3px solid var(--blue)",
      }}>
        <div style={{ fontSize: 10, color: "var(--txt3)", marginBottom: 4, fontWeight: 700, textTransform: "uppercase" }}>
          Preview de impacto
        </div>
        {previewLoading && <div style={{ fontSize: 11, color: "var(--txt3)" }}>Calculando…</div>}
        {!previewLoading && preview && (
          <div style={{ fontSize: 12 }}>
            Recomputa <strong>{preview.ventasAfectadas}</strong> venta{preview.ventasAfectadas === 1 ? "" : "s"} posterior{preview.ventasAfectadas === 1 ? "" : "es"} a la recepción.
            <br/>
            Δ costo agregado:{" "}
            <strong style={{ color: preview.costoTotalDelta >= 0 ? "var(--red)" : "var(--green)" }}>
              {fmtMoney(preview.costoTotalDelta)}
            </strong>
            <span style={{ color: "var(--txt3)" }}>
              {" "}({preview.costoTotalDelta >= 0 ? "margen baja" : "margen sube"})
            </span>
          </div>
        )}
        {!previewLoading && !preview && (
          <div style={{ fontSize: 11, color: "var(--txt3)" }}>Ingrese costo válido para ver impacto</div>
        )}
      </div>

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button
          onClick={onCerrar} disabled={saving}
          style={{
            padding: "8px 14px", borderRadius: 6, background: "var(--bg3)",
            color: "var(--txt3)", fontSize: 11, fontWeight: 600, border: "1px solid var(--bg4)", cursor: "pointer",
          }}
        >
          Cancelar
        </button>
        <button
          onClick={aplicar} disabled={saving}
          style={{
            padding: "8px 14px", borderRadius: 6, background: "var(--green)",
            color: "#0a0e17", fontSize: 11, fontWeight: 700, border: "none", cursor: "pointer",
          }}
        >
          {saving ? "Aplicando…" : "Confirmar aprobación"}
        </button>
      </div>
    </>
  );
}

// ---- Rechazar ----

function ContentRechazar({ discId, sku, onCerrar, onResuelto }: Props) {
  const [subAccion, setSubAccion] = useState<RechazarSubAccion>("corregir_factura");
  const [notas, setNotas] = useState("");
  const [saving, setSaving] = useState(false);

  const aplicar = async () => {
    setSaving(true);
    try {
      await rechazarNuevoCosto(discId, notas.trim() || undefined, subAccion);
      onResuelto();
      onCerrar();
    } catch (e) {
      alert("Error al rechazar: " + (e instanceof Error ? e.message : e));
    } finally {
      setSaving(false);
    }
  };

  const opciones: Array<{ key: RechazarSubAccion; label: string; desc: string }> = [
    {
      key: "corregir_factura",
      label: "Corregir factura ahora",
      desc: "El operador edita la línea con el costo correcto y la disc se relanza limpia.",
    },
    {
      key: "anular_linea",
      label: "Anular línea completa",
      desc: "Marca la línea como qty_factura=0. El WAC se recalcula sin esta entrada.",
    },
    {
      key: "cerrar_dejando_basura",
      label: "Cerrar dejando valor erróneo",
      desc: "⚠️ El WAC queda contaminado a propósito. Solo para casos degenerados.",
    },
  ];

  return (
    <>
      <h3 style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 700 }}>❌ Rechazar discrepancia — {sku}</h3>
      <p style={{ fontSize: 11, color: "var(--txt3)", margin: "0 0 14px" }}>
        Elegí qué hacer con la línea. Todas las opciones marcan la disc como RECHAZADO + audit.
      </p>

      {opciones.map(o => (
        <label
          key={o.key}
          onClick={() => setSubAccion(o.key)}
          style={{
            display: "block", padding: 10, marginBottom: 8, borderRadius: 8,
            background: subAccion === o.key ? "var(--bg3)" : "transparent",
            border: `1px solid ${subAccion === o.key ? "var(--blueBd)" : "var(--bg4)"}`,
            cursor: "pointer",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="radio" name="subaccion"
              checked={subAccion === o.key} onChange={() => setSubAccion(o.key)}
            />
            <span style={{ fontSize: 13, fontWeight: 700 }}>{o.label}</span>
          </div>
          <div style={{ fontSize: 11, color: "var(--txt3)", marginTop: 4, marginLeft: 22 }}>{o.desc}</div>
        </label>
      ))}

      <label style={{ fontSize: 11, color: "var(--txt2)", display: "block", marginBottom: 4, marginTop: 8 }}>
        Notas (opcional)
      </label>
      <textarea
        value={notas} onChange={e => setNotas(e.target.value)} rows={2}
        placeholder="Ej: factura mal emitida, esperando NC del proveedor"
        style={{
          width: "100%", padding: "8px 12px", borderRadius: 6,
          background: "var(--bg3)", border: "1px solid var(--bg4)",
          color: "var(--txt)", fontSize: 12, marginBottom: 14, fontFamily: "inherit", resize: "vertical",
        }}
      />

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button
          onClick={onCerrar} disabled={saving}
          style={{
            padding: "8px 14px", borderRadius: 6, background: "var(--bg3)",
            color: "var(--txt3)", fontSize: 11, fontWeight: 600, border: "1px solid var(--bg4)", cursor: "pointer",
          }}
        >
          Cancelar
        </button>
        <button
          onClick={aplicar} disabled={saving}
          style={{
            padding: "8px 14px", borderRadius: 6, background: "var(--red)",
            color: "#fff", fontSize: 11, fontWeight: 700, border: "none", cursor: "pointer",
          }}
        >
          {saving ? "Procesando…" : "Confirmar rechazo"}
        </button>
      </div>
    </>
  );
}

// ---- Revertir ----

function ContentRevertir({ discId, sku, onCerrar, onResuelto }: Props) {
  const [motivo, setMotivo] = useState("");
  const [saving, setSaving] = useState(false);

  const aplicar = async () => {
    if (!motivo.trim()) { alert("El motivo es obligatorio"); return; }
    setSaving(true);
    try {
      await revertirAprobacion(discId, motivo.trim());
      onResuelto();
      onCerrar();
    } catch (e) {
      alert("Error al revertir: " + (e instanceof Error ? e.message : e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <h3 style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 700 }}>↩ Revertir aprobación — {sku}</h3>
      <p style={{ fontSize: 11, color: "var(--txt3)", margin: "0 0 14px", lineHeight: 1.5 }}>
        Restaura el precio_neto del catálogo al snapshot tomado al aprobar, recalcula WAC, recompute ventas y vuelve la disc a PENDIENTE.
      </p>

      <label style={{ fontSize: 11, color: "var(--txt2)", display: "block", marginBottom: 4 }}>
        Motivo del reverso (obligatorio)
      </label>
      <textarea
        value={motivo} onChange={e => setMotivo(e.target.value)} rows={3}
        placeholder="Ej: aprobé con costo equivocado, hay que volver al precio acordado original"
        style={{
          width: "100%", padding: "8px 12px", borderRadius: 6,
          background: "var(--bg3)", border: "1px solid var(--bg4)",
          color: "var(--txt)", fontSize: 12, marginBottom: 14, fontFamily: "inherit", resize: "vertical",
        }}
      />

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button
          onClick={onCerrar} disabled={saving}
          style={{
            padding: "8px 14px", borderRadius: 6, background: "var(--bg3)",
            color: "var(--txt3)", fontSize: 11, fontWeight: 600, border: "1px solid var(--bg4)", cursor: "pointer",
          }}
        >
          Cancelar
        </button>
        <button
          onClick={aplicar} disabled={saving || !motivo.trim()}
          style={{
            padding: "8px 14px", borderRadius: 6,
            background: motivo.trim() ? "var(--amber)" : "var(--bg3)",
            color: "#0a0e17", fontSize: 11, fontWeight: 700, border: "none", cursor: "pointer",
          }}
        >
          {saving ? "Revirtiendo…" : "Confirmar reverso"}
        </button>
      </div>
    </>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ padding: 10, background: "var(--bg3)", borderRadius: 8, textAlign: "center" }}>
      <div style={{ fontSize: 9, color: "var(--txt3)", textTransform: "uppercase", marginBottom: 2 }}>{label}</div>
      <div className="mono" style={{ fontSize: 16, fontWeight: 700, color }}>{value}</div>
    </div>
  );
}
