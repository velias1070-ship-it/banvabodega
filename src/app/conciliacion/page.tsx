"use client";
import { useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import {
  fetchEmpresaDefault,
  fetchRcvCompras, fetchRcvVentas,
  upsertRcvCompras, upsertRcvVentas,
  fetchMovimientosBanco, insertMovimientosBanco, deleteMovimientosBancoByIds,
  fetchConciliaciones,
  fetchAlertas, fetchSyncLog, insertSyncLog,
} from "@/lib/db";
import type {
  DBEmpresa, DBRcvCompra, DBRcvVenta, DBMovimientoBanco,
  DBConciliacion, DBAlerta, DBSyncLog,
} from "@/lib/db";
import CsvUploader from "@/components/CsvUploader";
import type { CsvRow } from "@/components/CsvUploader";
import dynamic from "next/dynamic";

// Componentes pesados: carga dinámica para no inflar el bundle inicial
const PlanCuentasTree = dynamic(() => import("@/components/PlanCuentasTree"), { ssr: false });
const RuleBuilder = dynamic(() => import("@/components/RuleBuilder"), { ssr: false });
const ConciliacionSplitView = dynamic(() => import("@/components/ConciliacionSplitView"), { ssr: false });
const EstadoResultados = dynamic(() => import("@/components/EstadoResultados"), { ssr: false });
const FlujoCaja = dynamic(() => import("@/components/FlujoCaja"), { ssr: false });
const FlujoProyectado = dynamic(() => import("@/components/FlujoProyectado"), { ssr: false });
const TabPresupuesto = dynamic(() => import("@/components/TabPresupuesto"), { ssr: false });
const MpLiquidacionUpload = dynamic(() => import("@/components/MpLiquidacionUpload"), { ssr: false });

// ==================== AUTH (mismo patrón que admin) ====================
const ADMIN_PIN = "1234";
const AUTH_KEY = "banva_admin_auth";

function useAuth() {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    const saved = sessionStorage.getItem(AUTH_KEY);
    if (saved === "1") setOk(true);
  }, []);
  const login = (pin: string) => {
    if (pin === ADMIN_PIN) { sessionStorage.setItem(AUTH_KEY, "1"); setOk(true); return true; }
    return false;
  };
  const logout = () => { sessionStorage.removeItem(AUTH_KEY); setOk(false); };
  return { ok, login, logout };
}

function LoginGate({ onLogin }: { onLogin: (pin: string) => boolean }) {
  const [pin, setPin] = useState("");
  const [err, setErr] = useState(false);
  const submit = () => {
    if (!onLogin(pin)) { setErr(true); setPin(""); setTimeout(() => setErr(false), 1500); }
  };
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100dvh", background: "var(--bg)", padding: 24 }}>
      <div style={{ width: "100%", maxWidth: 360, textAlign: "center" }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", color: "var(--cyan)", textTransform: "uppercase", marginBottom: 6 }}>BANVA</div>
        <div style={{ fontSize: 24, fontWeight: 800, marginBottom: 4 }}>Conciliador</div>
        <div style={{ fontSize: 13, color: "var(--txt3)", marginBottom: 32 }}>Ingresa el PIN de acceso</div>
        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          <input type="password" inputMode="numeric" className="form-input mono" value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, ""))}
            onKeyDown={e => e.key === "Enter" && submit()} placeholder="PIN" maxLength={6} autoFocus
            style={{ fontSize: 24, textAlign: "center", letterSpacing: 8, padding: 16, flex: 1 }} />
        </div>
        <button onClick={submit} disabled={pin.length < 4}
          style={{ width: "100%", padding: 14, borderRadius: 10, background: pin.length >= 4 ? "var(--cyan)" : "var(--bg3)", color: pin.length >= 4 ? "#000" : "var(--txt3)", fontWeight: 700, fontSize: 14, opacity: pin.length >= 4 ? 1 : 0.5 }}>
          Entrar
        </button>
        {err && <div style={{ marginTop: 12, color: "var(--red)", fontWeight: 600, fontSize: 13 }}>PIN incorrecto</div>}
        <Link href="/" style={{ display: "inline-block", marginTop: 24, color: "var(--txt3)", fontSize: 12 }}>&#8592; Volver al inicio</Link>
      </div>
    </div>
  );
}

// ==================== HELPERS ====================
const fmtMoney = (n: number) => n.toLocaleString("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
const fmtDate = (d: string | null) => d ? new Date(d + "T12:00:00").toLocaleDateString("es-CL", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—";

// Formatear RUT chileno con puntos y guión (ej: 76.123.456-7)
function fmtRut(rut: string | null): string {
  if (!rut) return "—";
  // Limpiar: quitar puntos y espacios existentes
  const clean = rut.replace(/\./g, "").replace(/\s/g, "").trim();
  // Separar cuerpo y dígito verificador
  const dv = clean.slice(-1);
  const body = clean.slice(0, -2); // sin el guión y DV
  if (body.length < 2) return rut; // si es muy corto, devolver tal cual
  // Formatear con puntos de miles
  const formatted = body.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${formatted}-${dv}`;
}

// Nombre legible de tipo documento SII (compras + ventas)
const TIPO_DOC_NAMES: Record<number | string, string> = {
  33: "Factura",
  34: "Factura Exenta",
  39: "Boleta",
  41: "Boleta Exenta",
  46: "Factura Compra",
  52: "Guía Despacho",
  56: "Nota Débito",
  61: "Nota Crédito",
};

// Periodo actual (YYYYMM)
function currentPeriodo(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// Generar lista de periodos (años + últimos 18 meses)
function periodOptions(): { value: string; label: string }[] {
  const opts: { value: string; label: string }[] = [];
  const now = new Date();
  // Años completos (actual y anterior)
  for (let y = now.getFullYear(); y >= now.getFullYear() - 2; y--) {
    opts.push({ value: String(y), label: `Año ${y}` });
  }
  // Meses (últimos 18)
  for (let i = 0; i < 18; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const val = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
    const label = d.toLocaleDateString("es-CL", { month: "long", year: "numeric" });
    opts.push({ value: val, label: label.charAt(0).toUpperCase() + label.slice(1) });
  }
  return opts;
}

// Formatear periodo YYYYMM o YYYY a texto legible
function formatPeriodo(p: string): string {
  if (p.length === 4) return `Año ${p}`;
  const y = parseInt(p.slice(0, 4));
  const m = parseInt(p.slice(4, 6));
  const d = new Date(y, m - 1, 1);
  const label = d.toLocaleDateString("es-CL", { month: "long", year: "numeric" });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

// ==================== SII IMPORT MODAL ====================
const SII_CREDS_KEY = "banva_sii_creds";

function useSiiCreds() {
  const [creds, setCreds] = useState<{ rut: string; clave: string }>({ rut: "", clave: "" });
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(SII_CREDS_KEY);
      if (saved) setCreds(JSON.parse(saved));
    } catch { /* noop */ }
  }, []);
  const save = (rut: string, clave: string) => {
    setCreds({ rut, clave });
    sessionStorage.setItem(SII_CREDS_KEY, JSON.stringify({ rut, clave }));
  };
  const clear = () => {
    setCreds({ rut: "", clave: "" });
    sessionStorage.removeItem(SII_CREDS_KEY);
  };
  return { creds, save, clear };
}

interface SiiImportModalProps {
  tipo: "COMPRA" | "VENTA";
  empresa: DBEmpresa;
  periodoActual: string;
  onClose: () => void;
  onImported: () => void;
}

function SiiImportModal({ tipo, empresa, periodoActual, onClose, onImported }: SiiImportModalProps) {
  const sii = useSiiCreds();
  const [rut, setRut] = useState(sii.creds.rut || empresa.rut || "");
  const [clave, setClave] = useState(sii.creds.clave || "");
  const [periodo, setPeriodo] = useState(periodoActual);
  const [guardarCreds, setGuardarCreds] = useState(!!sii.creds.clave);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [resultado, setResultado] = useState<{ registros: number } | null>(null);

  const label = tipo === "COMPRA" ? "Compras" : "Ventas";

  const handleImport = async () => {
    if (!rut || !clave || !periodo) {
      setError("Completa todos los campos");
      return;
    }
    setLoading(true);
    setError("");
    setResultado(null);

    try {
      const resp = await fetch("/api/sii/rcv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rut, clave, periodo, tipo }),
      });

      const json = await resp.json();

      if (!resp.ok) {
        setError(json.error || `Error HTTP ${resp.status}`);
        setLoading(false);
        return;
      }

      if (!json.data || json.data.length === 0) {
        setResultado({ registros: 0 });
        setLoading(false);
        return;
      }

      // Guardar en Supabase
      if (tipo === "COMPRA") {
        const items = json.data.map((d: Record<string, unknown>) => ({
          ...d,
          empresa_id: empresa.id,
        }));
        await upsertRcvCompras(items);
      } else {
        const items = json.data.map((d: Record<string, unknown>) => ({
          ...d,
          empresa_id: empresa.id,
        }));
        await upsertRcvVentas(items);
      }

      // Registrar sync
      if (empresa.id) {
        await insertSyncLog({
          empresa_id: empresa.id,
          periodo,
          tipo: tipo === "COMPRA" ? "compras" : "ventas",
          registros: json.data.length,
        });
      }

      // Guardar credenciales en sesión si se pidió
      if (guardarCreds) {
        sii.save(rut, clave);
      } else {
        sii.clear();
      }

      setResultado({ registros: json.data.length });
      onImported();
    } catch (err) {
      setError(`Error de conexión: ${err instanceof Error ? err.message : "desconocido"}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
      onClick={e => { if (e.target === e.currentTarget && !loading) onClose(); }}>
      <div style={{ width: "100%", maxWidth: 420, background: "var(--bg2)", borderRadius: 16, border: "1px solid var(--bg4)", padding: 24, boxShadow: "0 20px 60px rgba(0,0,0,0.5)" }}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", color: "var(--cyan)", textTransform: "uppercase" }}>SII</div>
            <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Importar RCV {label}</h3>
          </div>
          <button onClick={onClose} disabled={loading}
            style={{ background: "var(--bg3)", border: "1px solid var(--bg4)", borderRadius: 8, padding: "6px 10px", color: "var(--txt3)", fontSize: 16, cursor: "pointer" }}>
            ✕
          </button>
        </div>

        {/* Form */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {/* Periodo selector */}
          <div>
            <label style={{ fontSize: 11, fontWeight: 600, color: "var(--txt3)", marginBottom: 4, display: "block" }}>Período a importar</label>
            <select value={periodo} onChange={e => setPeriodo(e.target.value)} disabled={loading}
              style={{ width: "100%", background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", borderRadius: 8, padding: "10px 12px", fontSize: 14, fontWeight: 600 }}>
              {periodOptions().map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>

          {/* RUT */}
          <div>
            <label style={{ fontSize: 11, fontWeight: 600, color: "var(--txt3)", marginBottom: 4, display: "block" }}>RUT Empresa</label>
            <input className="form-input mono" value={rut} onChange={e => setRut(e.target.value)} disabled={loading}
              placeholder="77994007-1" style={{ fontSize: 14, padding: "10px 12px" }} />
          </div>

          {/* Clave */}
          <div>
            <label style={{ fontSize: 11, fontWeight: 600, color: "var(--txt3)", marginBottom: 4, display: "block" }}>Clave Tributaria SII</label>
            <input type="password" className="form-input" value={clave} onChange={e => setClave(e.target.value)} disabled={loading}
              placeholder="Clave del SII" style={{ fontSize: 14, padding: "10px 12px" }}
              onKeyDown={e => { if (e.key === "Enter" && !loading) handleImport(); }} />
          </div>

          {/* Guardar creds checkbox */}
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--txt3)", cursor: "pointer" }}>
            <input type="checkbox" checked={guardarCreds} onChange={e => setGuardarCreds(e.target.checked)} />
            Recordar credenciales en esta sesión
          </label>
        </div>

        {/* Error */}
        {error && (
          <div style={{ marginTop: 12, padding: "10px 14px", background: "var(--redBg)", border: "1px solid var(--redBd)", borderRadius: 8, color: "var(--red)", fontSize: 12, fontWeight: 600 }}>
            {error}
          </div>
        )}

        {/* Resultado exitoso */}
        {resultado && (
          <div style={{ marginTop: 12, padding: "10px 14px", background: "var(--greenBg)", border: "1px solid var(--greenBd)", borderRadius: 8, color: "var(--green)", fontSize: 12, fontWeight: 600 }}>
            {resultado.registros > 0
              ? `${resultado.registros} documentos importados de ${formatPeriodo(periodo)}`
              : `No se encontraron documentos de ${label.toLowerCase()} para ${formatPeriodo(periodo)}`}
          </div>
        )}

        {/* Actions */}
        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <button onClick={onClose} disabled={loading}
            style={{ flex: 1, padding: 12, borderRadius: 10, background: "var(--bg3)", color: "var(--txt2)", fontWeight: 600, fontSize: 13, border: "1px solid var(--bg4)" }}>
            {resultado ? "Cerrar" : "Cancelar"}
          </button>
          {!resultado && (
            <button onClick={handleImport} disabled={loading || !rut || !clave}
              style={{ flex: 1, padding: 12, borderRadius: 10, background: loading ? "var(--bg4)" : "var(--cyan)", color: loading ? "var(--txt3)" : "#000", fontWeight: 700, fontSize: 13, border: "none", cursor: loading ? "not-allowed" : "pointer" }}>
              {loading ? "Consultando SII..." : `Importar ${label}`}
            </button>
          )}
        </div>

        {/* Info footer */}
        <div style={{ marginTop: 12, fontSize: 10, color: "var(--txt3)", textAlign: "center", lineHeight: 1.4 }}>
          Se conecta directamente al SII con tu clave tributaria.
          Las credenciales {guardarCreds ? "se guardan solo en esta sesión del navegador" : "no se almacenan"}.
        </div>
      </div>
    </div>
  );
}

// ==================== DASHBOARD ====================
function Dashboard({ empresa, periodo, onChangePeriodo }: { empresa: DBEmpresa; periodo: string; onChangePeriodo: (p: string) => void }) {
  const [compras, setCompras] = useState<DBRcvCompra[]>([]);
  const [ventas, setVentas] = useState<DBRcvVenta[]>([]);
  const [movBanco, setMovBanco] = useState<DBMovimientoBanco[]>([]);
  const [conciliaciones, setConciliaciones] = useState<DBConciliacion[]>([]);
  const [alertas, setAlertas] = useState<DBAlerta[]>([]);
  const [syncLogs, setSyncLogs] = useState<DBSyncLog[]>([]);
  const [reembolsosPend, setReembolsosPend] = useState<DBMovimientoBanco[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!empresa.id) return;
    setLoading(true);
    // Convertir periodo YYYYMM o YYYY → rango de fechas para movimientos banco
    const isAnual = periodo.length === 4;
    const y = parseInt(periodo.slice(0, 4));
    const m2 = isAnual ? 1 : parseInt(periodo.slice(4, 6));
    const desde = isAnual ? `${y}-01-01` : `${y}-${String(m2).padStart(2, "0")}-01`;
    const hasta = isAnual ? `${y}-12-31` : `${y}-${String(m2).padStart(2, "0")}-${new Date(y, m2, 0).getDate()}`;
    Promise.all([
      fetchRcvCompras(empresa.id, periodo),
      fetchRcvVentas(empresa.id, periodo),
      fetchMovimientosBanco(empresa.id, { desde, hasta }),
      fetchConciliaciones(empresa.id),
      fetchAlertas(empresa.id, "activa"),
      fetchSyncLog(empresa.id),
    ]).then(([c, v, m, conc, al, sl]) => {
      setCompras(c); setVentas(v); setMovBanco(m); setConciliaciones(conc); setAlertas(al); setSyncLogs(sl);
      setLoading(false);
    });
  }, [empresa.id, periodo]);

  // Función para recargar datos
  const reload = () => {
    if (!empresa.id) return;
    setLoading(true);
    const isAnual2 = periodo.length === 4;
    const y2 = parseInt(periodo.slice(0, 4));
    const m3 = isAnual2 ? 1 : parseInt(periodo.slice(4, 6));
    const d1 = isAnual2 ? `${y2}-01-01` : `${y2}-${String(m3).padStart(2, "0")}-01`;
    const d2 = isAnual2 ? `${y2}-12-31` : `${y2}-${String(m3).padStart(2, "0")}-${new Date(y2, m3, 0).getDate()}`;
    Promise.all([
      fetchRcvCompras(empresa.id!, periodo),
      fetchRcvVentas(empresa.id!, periodo),
      fetchMovimientosBanco(empresa.id!, { desde: d1, hasta: d2 }),
      fetchConciliaciones(empresa.id!),
      fetchAlertas(empresa.id!, "activa"),
      fetchSyncLog(empresa.id!),
    ]).then(([c, v, m, conc, al, sl]) => {
      setCompras(c); setVentas(v); setMovBanco(m); setConciliaciones(conc); setAlertas(al); setSyncLogs(sl);
      setLoading(false);
    });
  };

  // Sincronizar compras + ventas del SII para el periodo actual
  const handleSyncSii = async () => {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const res = await fetch("/api/sii/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ periodo, tipo: "ambos" }),
      });
      const data = await res.json();
      if (data.compras !== undefined || data.ventas !== undefined) {
        setSyncMsg(`${data.compras || 0} compras + ${data.ventas || 0} ventas importadas`);
        reload();
      } else {
        const logInfo = data.log ? `\n${data.log.join("\n")}` : "";
        setSyncMsg(`Error: ${data.error || "Error desconocido"}${logInfo}`);
      }
    } catch (e) {
      setSyncMsg(`Error de conexión: ${e instanceof Error ? e.message : "sin detalles"}`);
    } finally {
      setSyncing(false);
    }
  };

  // Sincronizar año completo — mes a mes desde el cliente
  const [syncAnualLoading, setSyncAnualLoading] = useState(false);
  const [syncAnualMsg, setSyncAnualMsg] = useState<string | null>(null);
  const handleSyncAnual = async (anio: number, tipo: string) => {
    if (!window.confirm(`Sincronizar ${tipo} de todo ${anio} desde el SII?\nSe procesara mes a mes (~1 min por mes).`)) return;
    setSyncAnualLoading(true);
    let totalC = 0, totalV = 0, errores = 0;
    for (let mes = 1; mes <= 12; mes++) {
      const per = `${anio}${String(mes).padStart(2, "0")}`;
      setSyncAnualMsg(`Sincronizando ${tipo} ${anio} — mes ${mes}/12 (${per})...`);
      try {
        const res = await fetch("/api/sii/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ periodo: per, tipo, solo_registro: true }),
        });
        const data = await res.json();
        if (data.error) { errores++; continue; }
        totalC += data.compras || 0;
        totalV += data.ventas || 0;
      } catch { errores++; }
    }
    setSyncAnualMsg(`${anio}: ${totalC} compras + ${totalV} ventas importadas (${12 - errores} meses OK${errores > 0 ? `, ${errores} con error` : ""})`);
    setSyncAnualLoading(false);
    reload();
  };

  // Exportar CSV
  const handleExportCSV = (anio: number, tipo: string) => {
    if (!empresa.id) return;
    window.open(`/api/sii/export?empresa_id=${empresa.id}&anio=${anio}&tipo=${tipo}`, "_blank");
  };

  if (loading) return <div style={{ textAlign: "center", padding: 40, color: "var(--txt3)" }}>Cargando...</div>;

  // === Periodos sincronizados (extraídos del sync_log) ===
  const periodosSincronizados = Array.from(new Set(syncLogs.map(s => s.periodo))).sort().reverse();

  // === Cálculos compras ===
  const totalCompras = compras.reduce((s, c) => s + (c.monto_total || 0), 0);
  const totalNetoCompras = compras.reduce((s, c) => s + (c.monto_neto || 0), 0);
  const totalIvaCompras = compras.reduce((s, c) => s + (c.monto_iva || 0), 0);

  // === Cálculos ventas ===
  const totalVentas = ventas.reduce((s, v) => s + (v.monto_total || 0), 0);
  const totalNetoVentas = ventas.reduce((s, v) => s + (v.monto_neto || 0), 0);
  const totalIvaVentas = ventas.reduce((s, v) => s + (v.monto_iva || 0), 0);

  // === Diferencia IVA (débito - crédito = lo que se paga al SII) ===
  const difIva = totalIvaVentas - totalIvaCompras;

  // === Desglose por tipo de documento ===
  const comprasPorTipo = compras.reduce((acc, c) => {
    const key = TIPO_DOC_NAMES[c.tipo_doc] || `Tipo ${c.tipo_doc}`;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const ventasPorTipo = ventas.reduce((acc, v) => {
    const key = TIPO_DOC_NAMES[v.tipo_doc] || `Tipo ${v.tipo_doc}`;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  // === Banco ===
  const ingresos = movBanco.filter(m => m.monto > 0).reduce((s, m) => s + m.monto, 0);
  const egresos = movBanco.filter(m => m.monto < 0).reduce((s, m) => s + m.monto, 0);

  // === Filtrar movimientos reales (excluir internos de MP) ===
  const movReales = movBanco.filter(m => {
    const desc = (m.descripcion || "").toUpperCase();
    if (desc.startsWith("VENTA ML") || desc.startsWith("BONIFICACION") || desc.startsWith("DEVOLUCION") || desc.startsWith("PAGO MP #")) return false;
    if ((desc.startsWith("COMPRA ML") || desc.startsWith("COMPRA MP"))) {
      try {
        const meta = typeof m.metadata === "string" ? JSON.parse(m.metadata) : m.metadata;
        const parsed = typeof meta === "string" ? JSON.parse(meta) : meta;
        if (parsed?.medio_pago && parsed.medio_pago !== "account_money") return false;
      } catch { /* mantener */ }
    }
    return true;
  });

  // === Conciliación (filtrada por movimientos reales del período) ===
  const movBancoIds = new Set(movReales.map(m => m.id).filter(Boolean));
  const concDelPeriodo = conciliaciones.filter(c => c.movimiento_banco_id && movBancoIds.has(c.movimiento_banco_id));
  const concPendientes = concDelPeriodo.filter(c => c.estado === "pendiente").length;
  const concConfirmadas = concDelPeriodo.filter(c => c.estado === "confirmado").length;
  const movConciliadosSet = new Set(concDelPeriodo.filter(c => c.estado !== "rechazado").map(c => c.movimiento_banco_id));
  const movSinConciliar = movReales.filter(m => !m.estado_conciliacion || m.estado_conciliacion === "pendiente").length;
  const movConciliados = movReales.filter(m => m.estado_conciliacion === "conciliado" || movConciliadosSet.has(m.id!)).length;
  const movIgnorados = movReales.filter(m => m.estado_conciliacion === "ignorado").length;
  const totalMov = movReales.length;
  const pctConciliado = totalMov > 0 ? Math.round(((movConciliados + movIgnorados) / totalMov) * 100) : 0;
  const montoSinConciliar = movReales.filter(m => !m.estado_conciliacion || m.estado_conciliacion === "pendiente").reduce((s, m) => s + Math.abs(m.monto), 0);

  // === Reembolsos pendientes a Vicente ===
  const totalReembolsoPend = reembolsosPend.reduce((s, m) => s + Math.abs(m.monto), 0);
  const reembolsosViejos = reembolsosPend.filter(m => {
    const dias = Math.floor((Date.now() - new Date(m.fecha).getTime()) / (1000 * 60 * 60 * 24));
    return dias > 15;
  });

  // === Último sync del periodo actual ===
  const syncDelPeriodo = syncLogs.filter(s => s.periodo === periodo);
  const ultimoSync = syncDelPeriodo.length > 0 ? syncDelPeriodo[0] : null;

  return (
    <div>
      {/* Header con título, botón sync y último sync */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Dashboard</h2>
          <div style={{ fontSize: 12, color: "var(--txt3)", marginTop: 2 }}>{formatPeriodo(periodo)}</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button onClick={handleSyncSii} disabled={syncing}
            style={{
              padding: "8px 16px", borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: syncing ? "wait" : "pointer",
              background: syncing ? "var(--bg4)" : "var(--cyanBg)",
              color: syncing ? "var(--txt3)" : "var(--cyan)",
              border: `1px solid ${syncing ? "var(--bg4)" : "var(--cyanBd)"}`,
              opacity: syncing ? 0.7 : 1,
            }}>
            {syncing ? "⏳ Sincronizando..." : "🔄 Sincronizar SII"}
          </button>
          {ultimoSync && (
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 10, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Último sync</div>
              <div className="mono" style={{ fontSize: 12, color: "var(--cyan)" }}>
                {ultimoSync.synced_at ? new Date(ultimoSync.synced_at).toLocaleString("es-CL", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Mensaje de sync */}
      {syncMsg && (
        <div style={{ padding: "8px 12px", borderRadius: 8, marginBottom: 12, fontSize: 12, fontWeight: 600,
          whiteSpace: "pre-wrap", maxHeight: 300, overflow: "auto",
          background: syncMsg.startsWith("Error") ? "var(--redBg)" : "var(--greenBg)",
          color: syncMsg.startsWith("Error") ? "var(--red)" : "var(--green)",
          border: `1px solid ${syncMsg.startsWith("Error") ? "var(--redBd)" : "var(--greenBd)"}` }}>
          {syncMsg}
        </div>
      )}

      {/* Sync anual + Export */}
      <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: 10, fontWeight: 600, color: "var(--txt3)" }}>Anual:</span>
        <button onClick={() => handleSyncAnual(2025, "compras")} disabled={syncAnualLoading}
          style={{ padding: "4px 10px", borderRadius: 6, fontSize: 10, fontWeight: 600, background: "var(--blueBg)", color: "var(--blue)", border: "1px solid var(--blueBd)", cursor: "pointer" }}>
          {syncAnualLoading ? "..." : "Sync Compras 2025"}
        </button>
        <button onClick={() => handleSyncAnual(2025, "ventas")} disabled={syncAnualLoading}
          style={{ padding: "4px 10px", borderRadius: 6, fontSize: 10, fontWeight: 600, background: "var(--blueBg)", color: "var(--blue)", border: "1px solid var(--blueBd)", cursor: "pointer" }}>
          {syncAnualLoading ? "..." : "Sync Ventas 2025"}
        </button>
        <span style={{ color: "var(--bg4)" }}>|</span>
        <button onClick={() => handleExportCSV(2025, "compras")}
          style={{ padding: "4px 10px", borderRadius: 6, fontSize: 10, fontWeight: 600, background: "var(--greenBg)", color: "var(--green)", border: "1px solid var(--greenBd)", cursor: "pointer" }}>
          CSV Compras 2025
        </button>
        <button onClick={() => handleExportCSV(2025, "ventas")}
          style={{ padding: "4px 10px", borderRadius: 6, fontSize: 10, fontWeight: 600, background: "var(--greenBg)", color: "var(--green)", border: "1px solid var(--greenBd)", cursor: "pointer" }}>
          CSV Ventas 2025
        </button>
      </div>
      {syncAnualMsg && (
        <div style={{ padding: "6px 10px", borderRadius: 6, marginBottom: 8, fontSize: 11, fontWeight: 600,
          background: syncAnualMsg.startsWith("Error") ? "var(--redBg)" : "var(--blueBg)",
          color: syncAnualMsg.startsWith("Error") ? "var(--red)" : "var(--blue)",
          border: `1px solid ${syncAnualMsg.startsWith("Error") ? "var(--redBd)" : "var(--blueBd)"}` }}>
          {syncAnualMsg}
        </div>
      )}

      {/* Selector rápido de periodos sincronizados */}
      {periodosSincronizados.length > 1 && (
        <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
          <span style={{ fontSize: 11, color: "var(--txt3)", alignSelf: "center", marginRight: 4 }}>Periodos:</span>
          {periodosSincronizados.map(p => (
            <button key={p} onClick={() => onChangePeriodo(p)}
              style={{
                padding: "4px 12px", borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: "pointer",
                background: p === periodo ? "var(--cyanBg)" : "var(--bg3)",
                color: p === periodo ? "var(--cyan)" : "var(--txt3)",
                border: p === periodo ? "1px solid var(--cyanBd)" : "1px solid var(--bg4)",
              }}>
              {formatPeriodo(p)}
            </button>
          ))}
        </div>
      )}

      {/* ══════ ESTADO DE CONCILIACIÓN ══════ */}
      {totalMov > 0 && (
        <div className="card" style={{ padding: 20, marginBottom: 16, borderLeft: `4px solid ${pctConciliado === 100 ? "var(--green)" : pctConciliado >= 50 ? "var(--cyan)" : "var(--amber)"}` }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", color: "var(--txt3)", textTransform: "uppercase" }}>Conciliación del período</div>
              <div style={{ fontSize: 14, fontWeight: 600, marginTop: 2 }}>{formatPeriodo(periodo)}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div className="mono" style={{ fontSize: 32, fontWeight: 800, color: pctConciliado === 100 ? "var(--green)" : pctConciliado >= 50 ? "var(--cyan)" : "var(--amber)" }}>
                {pctConciliado}%
              </div>
            </div>
          </div>

          {/* Barra de progreso */}
          <div style={{ height: 10, borderRadius: 5, background: "var(--bg4)", overflow: "hidden", marginBottom: 14 }}>
            <div style={{
              height: "100%", borderRadius: 5, transition: "width 0.5s ease",
              width: `${pctConciliado}%`,
              background: pctConciliado === 100 ? "var(--green)" : pctConciliado >= 50 ? "var(--cyan)" : "var(--amber)",
            }} />
          </div>

          {/* Métricas en fila */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
            <div>
              <div style={{ fontSize: 10, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Sin conciliar</div>
              <div className="mono" style={{ fontSize: 20, fontWeight: 700, color: movSinConciliar > 0 ? "var(--amber)" : "var(--green)" }}>{movSinConciliar}</div>
              <div style={{ fontSize: 10, color: "var(--txt3)" }}>de {totalMov} movimientos</div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Monto pendiente</div>
              <div className="mono" style={{ fontSize: 20, fontWeight: 700, color: montoSinConciliar > 0 ? "var(--amber)" : "var(--green)" }}>{fmtMoney(montoSinConciliar)}</div>
              <div style={{ fontSize: 10, color: "var(--txt3)" }}>en valor absoluto</div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Conciliados</div>
              <div className="mono" style={{ fontSize: 20, fontWeight: 700, color: "var(--green)" }}>{movConciliados}</div>
              <div style={{ fontSize: 10, color: "var(--txt3)" }}>{concPendientes > 0 ? `+ ${concPendientes} por confirmar` : "confirmados"}</div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Ignorados</div>
              <div className="mono" style={{ fontSize: 20, fontWeight: 700, color: "var(--txt3)" }}>{movIgnorados}</div>
              <div style={{ fontSize: 10, color: "var(--txt3)" }}>sin documento</div>
            </div>
          </div>
        </div>
      )}

      {/* KPIs fila 1: Compras vs Ventas */}
      <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(3, 1fr)", marginBottom: 12 }}>
        <div className="kpi">
          <div style={{ fontSize: 11, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Total Compras</div>
          <div className="mono" style={{ fontSize: 22, fontWeight: 700, color: "var(--red)" }}>{fmtMoney(totalCompras)}</div>
          <div style={{ fontSize: 11, color: "var(--txt3)" }}>{compras.length} documentos · Neto {fmtMoney(totalNetoCompras)}</div>
        </div>
        <div className="kpi">
          <div style={{ fontSize: 11, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Total Ventas</div>
          <div className="mono" style={{ fontSize: 22, fontWeight: 700, color: "var(--green)" }}>{fmtMoney(totalVentas)}</div>
          <div style={{ fontSize: 11, color: "var(--txt3)" }}>{ventas.length} documentos · Neto {fmtMoney(totalNetoVentas)}</div>
        </div>
        <div className="kpi">
          <div style={{ fontSize: 11, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Margen Neto</div>
          <div className="mono" style={{ fontSize: 22, fontWeight: 700, color: totalNetoVentas - totalNetoCompras >= 0 ? "var(--green)" : "var(--red)" }}>
            {fmtMoney(totalNetoVentas - totalNetoCompras)}
          </div>
          <div style={{ fontSize: 11, color: "var(--txt3)" }}>Ventas - Compras (sin IVA)</div>
        </div>
      </div>

      {/* KPIs fila 2: IVA */}
      <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(3, 1fr)", marginBottom: 12 }}>
        <div className="kpi">
          <div style={{ fontSize: 11, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>IVA Crédito (Compras)</div>
          <div className="mono" style={{ fontSize: 20, fontWeight: 700, color: "var(--amber)" }}>{fmtMoney(totalIvaCompras)}</div>
          <div style={{ fontSize: 11, color: "var(--txt3)" }}>IVA recuperable</div>
        </div>
        <div className="kpi">
          <div style={{ fontSize: 11, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>IVA Débito (Ventas)</div>
          <div className="mono" style={{ fontSize: 20, fontWeight: 700, color: "var(--amber)" }}>{fmtMoney(totalIvaVentas)}</div>
          <div style={{ fontSize: 11, color: "var(--txt3)" }}>IVA cobrado</div>
        </div>
        <div className="kpi" style={{ borderLeft: "3px solid var(--amber)" }}>
          <div style={{ fontSize: 11, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            {difIva >= 0 ? "IVA a pagar" : "Remanente IVA"}
          </div>
          <div className="mono" style={{ fontSize: 22, fontWeight: 700, color: difIva >= 0 ? "var(--red)" : "var(--green)" }}>
            {fmtMoney(Math.abs(difIva))}
          </div>
          <div style={{ fontSize: 11, color: "var(--txt3)" }}>Débito − Crédito</div>
        </div>
      </div>

      {/* Desglose documentos por tipo */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
        <div className="card" style={{ padding: 14 }}>
          <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 10, color: "var(--red)" }}>Documentos Compra</h3>
          {Object.keys(comprasPorTipo).length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--txt3)" }}>Sin documentos</div>
          ) : (
            Object.entries(comprasPorTipo).sort((a, b) => b[1] - a[1]).map(([tipo, qty]) => (
              <div key={tipo} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: "1px solid var(--bg4)" }}>
                <span style={{ fontSize: 12, color: "var(--txt2)" }}>{tipo}</span>
                <span className="mono" style={{ fontSize: 12, fontWeight: 600 }}>{qty}</span>
              </div>
            ))
          )}
        </div>
        <div className="card" style={{ padding: 14 }}>
          <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 10, color: "var(--green)" }}>Documentos Venta</h3>
          {Object.keys(ventasPorTipo).length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--txt3)" }}>Sin documentos</div>
          ) : (
            Object.entries(ventasPorTipo).sort((a, b) => b[1] - a[1]).map(([tipo, qty]) => (
              <div key={tipo} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: "1px solid var(--bg4)" }}>
                <span style={{ fontSize: 12, color: "var(--txt2)" }}>{tipo}</span>
                <span className="mono" style={{ fontSize: 12, fontWeight: 600 }}>{qty}</span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* KPIs fila 3: Banco */}
      <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(2, 1fr)", marginBottom: 12 }}>
        <div className="kpi">
          <div style={{ fontSize: 11, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Ingresos Banco</div>
          <div className="mono" style={{ fontSize: 18, fontWeight: 700, color: "var(--green)" }}>{fmtMoney(ingresos)}</div>
          <div style={{ fontSize: 11, color: "var(--txt3)" }}>{movBanco.filter(m => m.monto > 0).length} movimientos</div>
        </div>
        <div className="kpi">
          <div style={{ fontSize: 11, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Egresos Banco</div>
          <div className="mono" style={{ fontSize: 18, fontWeight: 700, color: "var(--red)" }}>{fmtMoney(egresos)}</div>
          <div style={{ fontSize: 11, color: "var(--txt3)" }}>{movBanco.filter(m => m.monto < 0).length} movimientos</div>
        </div>
      </div>

      {/* KPI fila 4: Reembolsos pendientes a Vicente */}
      {reembolsosPend.length > 0 && (
        <div className="card" style={{ padding: 16, marginBottom: 12, borderLeft: "3px solid var(--amber)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <h3 style={{ fontSize: 14, fontWeight: 700, margin: 0, color: "var(--amber)" }}>
              💳 Reembolsos pendientes a Vicente
            </h3>
            <div className="mono" style={{ fontSize: 22, fontWeight: 700, color: "var(--amber)" }}>
              {fmtMoney(totalReembolsoPend)}
            </div>
          </div>
          <div style={{ fontSize: 12, color: "var(--txt3)", marginBottom: 8 }}>
            {reembolsosPend.length} gasto{reembolsosPend.length !== 1 ? "s" : ""} de empresa pagado{reembolsosPend.length !== 1 ? "s" : ""} con TC personal sin reembolsar
          </div>
          {/* Alerta si hay reembolsos viejos (>15 días) */}
          {reembolsosViejos.length > 0 && (
            <div style={{
              padding: "8px 12px", borderRadius: 8, marginBottom: 10,
              background: "var(--redBg)", border: "1px solid var(--redBd)",
            }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: "var(--red)" }}>
                ⚠️ {reembolsosViejos.length} reembolso{reembolsosViejos.length !== 1 ? "s" : ""} con más de 15 días sin pagar — {fmtMoney(reembolsosViejos.reduce((s, m) => s + Math.abs(m.monto), 0))}
              </span>
            </div>
          )}
          {/* Lista de reembolsos pendientes (top 5) */}
          {reembolsosPend.slice(0, 5).map((m, i) => {
            const dias = Math.floor((Date.now() - new Date(m.fecha).getTime()) / (1000 * 60 * 60 * 24));
            return (
              <div key={m.id || i} style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                padding: "6px 0", borderBottom: i < Math.min(reembolsosPend.length, 5) - 1 ? "1px solid var(--bg4)" : "none",
              }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 500 }}>{m.descripcion}</div>
                  <div style={{ fontSize: 11, color: dias > 15 ? "var(--red)" : "var(--txt3)" }}>
                    {m.fecha} · hace {dias} día{dias !== 1 ? "s" : ""}
                  </div>
                </div>
                <div className="mono" style={{ fontSize: 13, fontWeight: 600, color: "var(--amber)" }}>
                  {fmtMoney(Math.abs(m.monto))}
                </div>
              </div>
            );
          })}
          {reembolsosPend.length > 5 && (
            <div style={{ fontSize: 11, color: "var(--txt3)", textAlign: "center", marginTop: 6 }}>
              +{reembolsosPend.length - 5} más
            </div>
          )}
        </div>
      )}

      {/* Historial de syncs del periodo */}
      {syncDelPeriodo.length > 0 && (
        <div className="card" style={{ padding: 14, marginBottom: 12 }}>
          <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>Sincronizaciones del período</h3>
          {syncDelPeriodo.map((s, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: i < syncDelPeriodo.length - 1 ? "1px solid var(--bg4)" : "none" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 4,
                  background: s.tipo === "compras" ? "var(--redBg)" : "var(--greenBg)",
                  color: s.tipo === "compras" ? "var(--red)" : "var(--green)" }}>
                  {s.tipo.toUpperCase()}
                </span>
                <span className="mono" style={{ fontSize: 12 }}>{s.registros} registros</span>
              </div>
              <span className="mono" style={{ fontSize: 11, color: "var(--txt3)" }}>
                {s.synced_at ? new Date(s.synced_at).toLocaleString("es-CL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—"}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Alertas activas */}
      {alertas.length > 0 && (
        <div className="card" style={{ padding: 16, marginBottom: 12 }}>
          <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>Alertas activas</h3>
          {alertas.slice(0, 5).map((a, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", borderTop: i > 0 ? "1px solid var(--bg4)" : "none" }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{a.titulo}</div>
                {a.descripcion && <div style={{ fontSize: 11, color: "var(--txt3)" }}>{a.descripcion}</div>}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Estado vacío */}
      {compras.length === 0 && ventas.length === 0 && movBanco.length === 0 && (
        <div className="card" style={{ padding: 32, textAlign: "center" }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>📊</div>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Sin datos para este período</div>
          <div style={{ fontSize: 12, color: "var(--txt3)" }}>Sincroniza el RCV desde el SII y sube los movimientos bancarios para comenzar</div>
        </div>
      )}
    </div>
  );
}

// ==================== RCV COMPRAS ====================
function TabRcvCompras({ empresa, periodo }: { empresa: DBEmpresa; periodo: string }) {
  const [data, setData] = useState<DBRcvCompra[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  const [tipoFilter, setTipoFilter] = useState<string>("todos");
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const isAnual = periodo.length === 4;

  const load = useCallback(async () => {
    if (!empresa.id) return;
    setLoading(true);
    if (isAnual) {
      // Cargar todos los meses del año
      const promises = [];
      for (let m = 1; m <= 12; m++) {
        promises.push(fetchRcvCompras(empresa.id!, `${periodo}${String(m).padStart(2, "0")}`));
      }
      const results = await Promise.all(promises);
      setData(results.flat());
    } else {
      const d = await fetchRcvCompras(empresa.id, periodo);
      setData(d);
    }
    setLoading(false);
  }, [empresa.id, periodo, isAnual]);

  useEffect(() => { load(); }, [load]);

  const handleSyncSii = async () => {
    setSyncing(true);
    setSyncMsg(null);
    try {
      if (isAnual) {
        // Sync mes a mes
        let totalC = 0, errores = 0;
        for (let mes = 1; mes <= 12; mes++) {
          const per = `${periodo}${String(mes).padStart(2, "0")}`;
          setSyncMsg(`Importando compras ${periodo} — mes ${mes}/12...`);
          try {
            const res = await fetch("/api/sii/sync", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ periodo: per, tipo: "compras", solo_registro: true }),
            });
            const data = await res.json();
            if (!data.error) totalC += data.compras || 0;
            else errores++;
          } catch { errores++; }
        }
        setSyncMsg(`${totalC} compras importadas del ${periodo} (${12 - errores} meses OK${errores > 0 ? `, ${errores} con error` : ""})`);
        load();
      } else {
        const res = await fetch("/api/sii/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ periodo, tipo: "compras" }),
        });
        const data = await res.json();
        if (!data.error) {
          setSyncMsg(`${data.compras || 0} compras importadas del SII`);
          if (data.compras > 0) load();
        } else {
          const logInfo = data.log ? `\n${data.log.join("\n")}` : "";
          setSyncMsg(`Error: ${data.error}${logInfo}`);
        }
      }
    } catch (e) {
      setSyncMsg(`Error de conexión: ${e instanceof Error ? e.message : "sin detalles"}`);
    } finally {
      setSyncing(false);
    }
  };

  if (loading) return <div style={{ textAlign: "center", padding: 40, color: "var(--txt3)" }}>Cargando...</div>;

  // Tipos disponibles para el filtro
  const tiposDisponibles = Array.from(new Set(data.map(c => String(c.tipo_doc))));

  // Filtrar por texto y tipo
  let filtered = data;
  if (tipoFilter !== "todos") filtered = filtered.filter(c => String(c.tipo_doc) === tipoFilter);
  if (filter) filtered = filtered.filter(c =>
    (c.razon_social || "").toLowerCase().includes(filter.toLowerCase()) ||
    (c.rut_proveedor || "").includes(filter) ||
    (c.nro_doc || "").includes(filter)
  );

  const totalNeto = filtered.reduce((s, c) => s + (c.monto_neto || 0), 0);
  const totalExento = filtered.reduce((s, c) => s + (c.monto_exento || 0), 0);
  const totalIva = filtered.reduce((s, c) => s + (c.monto_iva || 0), 0);
  const total = filtered.reduce((s, c) => s + (c.monto_total || 0), 0);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>RCV Compras</h2>
          <div style={{ fontSize: 11, color: "var(--txt3)", marginTop: 2 }}>{formatPeriodo(periodo)}</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 12, color: "var(--txt3)" }}>{filtered.length} de {data.length} docs</span>
          <span className="mono" style={{ fontSize: 14, fontWeight: 700, color: "var(--red)" }}>{fmtMoney(total)}</span>
          <button onClick={handleSyncSii} disabled={syncing}
            className="scan-btn" style={{ padding: "6px 14px", fontSize: 11, fontWeight: 600, background: "linear-gradient(135deg, #2563eb, #3b82f6)", opacity: syncing ? 0.6 : 1 }}>
            {syncing ? "Importando..." : "Importar SII"}
          </button>
          {empresa.id && (
            <button onClick={() => window.open(`/api/sii/export?empresa_id=${empresa.id}&anio=${isAnual ? periodo : periodo.slice(0, 4)}&tipo=compras`, "_blank")}
              style={{ padding: "6px 14px", fontSize: 11, fontWeight: 600, borderRadius: 8, background: "var(--greenBg)", color: "var(--green)", border: "1px solid var(--greenBd)", cursor: "pointer" }}>
              CSV
            </button>
          )}
        </div>
      </div>
      {syncMsg && (
        <div style={{ padding: "8px 12px", borderRadius: 8, marginBottom: 12, fontSize: 12, fontWeight: 600,
          whiteSpace: "pre-wrap", maxHeight: 300, overflow: "auto",
          background: syncMsg.startsWith("Error") ? "var(--redBg)" : "var(--greenBg)",
          color: syncMsg.startsWith("Error") ? "var(--red)" : "var(--green)",
          border: `1px solid ${syncMsg.startsWith("Error") ? "var(--redBd)" : "var(--greenBd)"}` }}>
          {syncMsg}
        </div>
      )}

      {/* Resumen rápido */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 12 }}>
        <div style={{ padding: 8, background: "var(--bg3)", borderRadius: 8, textAlign: "center" }}>
          <div style={{ fontSize: 10, color: "var(--txt3)" }}>Neto</div>
          <div className="mono" style={{ fontSize: 13, fontWeight: 700 }}>{fmtMoney(totalNeto)}</div>
        </div>
        <div style={{ padding: 8, background: "var(--bg3)", borderRadius: 8, textAlign: "center" }}>
          <div style={{ fontSize: 10, color: "var(--txt3)" }}>Exento</div>
          <div className="mono" style={{ fontSize: 13, fontWeight: 700 }}>{fmtMoney(totalExento)}</div>
        </div>
        <div style={{ padding: 8, background: "var(--amberBg)", borderRadius: 8, textAlign: "center" }}>
          <div style={{ fontSize: 10, color: "var(--amber)" }}>IVA</div>
          <div className="mono" style={{ fontSize: 13, fontWeight: 700, color: "var(--amber)" }}>{fmtMoney(totalIva)}</div>
        </div>
        <div style={{ padding: 8, background: "var(--redBg)", borderRadius: 8, textAlign: "center" }}>
          <div style={{ fontSize: 10, color: "var(--red)" }}>Total</div>
          <div className="mono" style={{ fontSize: 13, fontWeight: 700, color: "var(--red)" }}>{fmtMoney(total)}</div>
        </div>
      </div>

      {/* Filtros */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input className="form-input" placeholder="Buscar por proveedor, RUT o N° doc..." value={filter} onChange={e => setFilter(e.target.value)}
          style={{ fontSize: 13, flex: 1 }} />
        <select value={tipoFilter} onChange={e => setTipoFilter(e.target.value)}
          style={{ background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", borderRadius: 8, padding: "6px 10px", fontSize: 12 }}>
          <option value="todos">Todos los tipos</option>
          {tiposDisponibles.map(t => (
            <option key={t} value={t}>{TIPO_DOC_NAMES[t] || `Tipo ${t}`}</option>
          ))}
        </select>
      </div>

      {data.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: "center" }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>📄</div>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Sin compras para este período</div>
          <div style={{ fontSize: 12, color: "var(--txt3)", marginBottom: 12 }}>Importa los datos directamente desde el SII</div>
          <button onClick={handleSyncSii} disabled={syncing}
            style={{ padding: "10px 20px", borderRadius: 10, background: "var(--cyan)", color: "#000", fontWeight: 700, fontSize: 13, border: "none", cursor: syncing ? "not-allowed" : "pointer", opacity: syncing ? 0.6 : 1 }}>
            {syncing ? "Importando..." : "Importar desde SII"}
          </button>
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="tbl" style={{ fontSize: 11 }}>
            <thead>
              <tr>
                <th>Tipo</th><th>N° Doc</th><th>RUT Proveedor</th><th>Razón Social</th><th>Fecha</th>
                <th style={{ textAlign: "right" }}>Neto</th><th style={{ textAlign: "right" }}>IVA</th><th style={{ textAlign: "right" }}>Total</th><th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c, i) => (
                <tr key={c.id || i}>
                  <td>
                    <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 6px", borderRadius: 4, background: "var(--bg3)", color: "var(--txt2)", whiteSpace: "nowrap" }}>
                      {TIPO_DOC_NAMES[c.tipo_doc] || c.tipo_doc}
                    </span>
                  </td>
                  <td className="mono" style={{ fontWeight: 600 }}>{c.nro_doc || "—"}</td>
                  <td className="mono" style={{ fontSize: 10 }}>{fmtRut(c.rut_proveedor)}</td>
                  <td style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.razon_social || "—"}</td>
                  <td className="mono">{fmtDate(c.fecha_docto)}</td>
                  <td className="mono" style={{ textAlign: "right" }}>{fmtMoney(c.monto_neto || 0)}</td>
                  <td className="mono" style={{ textAlign: "right", color: "var(--amber)" }}>{fmtMoney(c.monto_iva || 0)}</td>
                  <td className="mono" style={{ textAlign: "right", fontWeight: 700 }}>{fmtMoney(c.monto_total || 0)}</td>
                  <td>
                    <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 6px", borderRadius: 4,
                      background: c.estado === "REGISTRO" ? "var(--greenBg)" : c.estado === "RECLAMADO" ? "var(--redBg)" : "var(--amberBg)",
                      color: c.estado === "REGISTRO" ? "var(--green)" : c.estado === "RECLAMADO" ? "var(--red)" : "var(--amber)" }}>
                      {c.estado}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ fontWeight: 700, background: "var(--bg3)" }}>
                <td colSpan={5} style={{ fontSize: 12 }}>TOTAL ({filtered.length} docs)</td>
                <td className="mono" style={{ textAlign: "right" }}>{fmtMoney(totalNeto)}</td>
                <td className="mono" style={{ textAlign: "right", color: "var(--amber)" }}>{fmtMoney(totalIva)}</td>
                <td className="mono" style={{ textAlign: "right", color: "var(--red)" }}>{fmtMoney(total)}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

// ==================== RCV VENTAS ====================
function TabRcvVentas({ empresa, periodo }: { empresa: DBEmpresa; periodo: string }) {
  const [data, setData] = useState<DBRcvVenta[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  const [tipoFilter, setTipoFilter] = useState<string>("todos");
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!empresa.id) return;
    setLoading(true);
    fetchRcvVentas(empresa.id, periodo).then(d => { setData(d); setLoading(false); });
  }, [empresa.id, periodo]);

  useEffect(() => { load(); }, [load]);

  const handleSyncSii = async () => {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const res = await fetch("/api/sii/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ periodo, tipo: "ventas" }),
      });
      const data = await res.json();
      if (data.status === "ok") {
        const logInfo = data.log ? `\n${data.log.join("\n")}` : "";
        setSyncMsg(`${data.ventas} ventas importadas del SII${data.ventas === 0 ? logInfo : ""}`);
        if (data.ventas > 0) load();
      } else {
        const logInfo = data.log ? `\n${data.log.join("\n")}` : "";
        setSyncMsg(`Error: ${data.error || "Error desconocido"}${logInfo}`);
      }
    } catch (e) {
      setSyncMsg(`Error de conexión: ${e instanceof Error ? e.message : "sin detalles"}`);
    } finally {
      setSyncing(false);
    }
  };

  if (loading) return <div style={{ textAlign: "center", padding: 40, color: "var(--txt3)" }}>Cargando...</div>;

  // Tipos disponibles para el filtro
  const tiposDisponibles = Array.from(new Set(data.map(v => String(v.tipo_doc))));

  // Filtrar por texto y tipo
  let filtered = data;
  if (tipoFilter !== "todos") filtered = filtered.filter(v => String(v.tipo_doc) === tipoFilter);
  if (filter) filtered = filtered.filter(v =>
    (v.razon_social || "").toLowerCase().includes(filter.toLowerCase()) ||
    (v.rut_receptor || v.rut_emisor || "").includes(filter) ||
    (v.folio || "").includes(filter) ||
    (v.nro || "").includes(filter)
  );

  const totalNeto = filtered.reduce((s, v) => s + (v.monto_neto || 0), 0);
  const totalExento = filtered.reduce((s, v) => s + (v.monto_exento || 0), 0);
  const totalIva = filtered.reduce((s, v) => s + (v.monto_iva || 0), 0);
  const total = filtered.reduce((s, v) => s + (v.monto_total || 0), 0);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>RCV Ventas</h2>
          <div style={{ fontSize: 11, color: "var(--txt3)", marginTop: 2 }}>{formatPeriodo(periodo)}</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 12, color: "var(--txt3)" }}>{filtered.length} de {data.length} docs</span>
          <span className="mono" style={{ fontSize: 14, fontWeight: 700, color: "var(--green)" }}>{fmtMoney(total)}</span>
          <button onClick={handleSyncSii} disabled={syncing}
            className="scan-btn" style={{ padding: "6px 14px", fontSize: 11, fontWeight: 600, background: "linear-gradient(135deg, #2563eb, #3b82f6)", opacity: syncing ? 0.6 : 1 }}>
            {syncing ? "Importando..." : "Importar SII"}
          </button>
        </div>
      </div>
      {syncMsg && (
        <div style={{ padding: "8px 12px", borderRadius: 8, marginBottom: 12, fontSize: 12, fontWeight: 600,
          whiteSpace: "pre-wrap", maxHeight: 300, overflow: "auto",
          background: syncMsg.startsWith("Error") ? "var(--redBg)" : "var(--greenBg)",
          color: syncMsg.startsWith("Error") ? "var(--red)" : "var(--green)",
          border: `1px solid ${syncMsg.startsWith("Error") ? "var(--redBd)" : "var(--greenBd)"}` }}>
          {syncMsg}
        </div>
      )}

      {/* Resumen rápido */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 12 }}>
        <div style={{ padding: 8, background: "var(--bg3)", borderRadius: 8, textAlign: "center" }}>
          <div style={{ fontSize: 10, color: "var(--txt3)" }}>Neto</div>
          <div className="mono" style={{ fontSize: 13, fontWeight: 700 }}>{fmtMoney(totalNeto)}</div>
        </div>
        <div style={{ padding: 8, background: "var(--bg3)", borderRadius: 8, textAlign: "center" }}>
          <div style={{ fontSize: 10, color: "var(--txt3)" }}>Exento</div>
          <div className="mono" style={{ fontSize: 13, fontWeight: 700 }}>{fmtMoney(totalExento)}</div>
        </div>
        <div style={{ padding: 8, background: "var(--amberBg)", borderRadius: 8, textAlign: "center" }}>
          <div style={{ fontSize: 10, color: "var(--amber)" }}>IVA</div>
          <div className="mono" style={{ fontSize: 13, fontWeight: 700, color: "var(--amber)" }}>{fmtMoney(totalIva)}</div>
        </div>
        <div style={{ padding: 8, background: "var(--greenBg)", borderRadius: 8, textAlign: "center" }}>
          <div style={{ fontSize: 10, color: "var(--green)" }}>Total</div>
          <div className="mono" style={{ fontSize: 13, fontWeight: 700, color: "var(--green)" }}>{fmtMoney(total)}</div>
        </div>
      </div>

      {/* Filtros */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input className="form-input" placeholder="Buscar por nombre, RUT o folio..." value={filter} onChange={e => setFilter(e.target.value)}
          style={{ fontSize: 13, flex: 1 }} />
        <select value={tipoFilter} onChange={e => setTipoFilter(e.target.value)}
          style={{ background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", borderRadius: 8, padding: "6px 10px", fontSize: 12 }}>
          <option value="todos">Todos los tipos</option>
          {tiposDisponibles.map(t => (
            <option key={t} value={t}>{TIPO_DOC_NAMES[t] || `Tipo ${t}`}</option>
          ))}
        </select>
      </div>

      {data.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: "center" }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>📄</div>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Sin ventas para este período</div>
          <div style={{ fontSize: 12, color: "var(--txt3)", marginBottom: 12 }}>Importa los datos directamente desde el SII</div>
          <button onClick={handleSyncSii} disabled={syncing}
            style={{ padding: "10px 20px", borderRadius: 10, background: "var(--cyan)", color: "#000", fontWeight: 700, fontSize: 13, border: "none", cursor: syncing ? "not-allowed" : "pointer", opacity: syncing ? 0.6 : 1 }}>
            {syncing ? "Importando..." : "Importar desde SII"}
          </button>
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="tbl" style={{ fontSize: 11 }}>
            <thead>
              <tr>
                <th>Tipo</th><th>Folio</th><th>Receptor</th><th>Fecha</th>
                <th style={{ textAlign: "right" }}>Neto</th><th style={{ textAlign: "right" }}>IVA</th><th style={{ textAlign: "right" }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((v, i) => (
                <tr key={v.id || i}>
                  <td>
                    <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 6px", borderRadius: 4, background: "var(--bg3)", color: "var(--txt2)", whiteSpace: "nowrap" }}>
                      {TIPO_DOC_NAMES[v.tipo_doc] || v.tipo_doc}
                    </span>
                  </td>
                  <td className="mono" style={{ fontWeight: 600 }}>{v.folio || v.nro || "—"}</td>
                  <td>
                    <div style={{ maxWidth: 200 }}>
                      {v.razon_social ? (
                        <>
                          <div style={{ fontSize: 11, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v.razon_social}</div>
                          <div className="mono" style={{ fontSize: 9, color: "var(--txt3)" }}>{fmtRut(v.rut_receptor || v.rut_emisor)}</div>
                        </>
                      ) : (
                        <span className="mono" style={{ fontSize: 10 }}>{fmtRut(v.rut_receptor || v.rut_emisor)}</span>
                      )}
                    </div>
                  </td>
                  <td className="mono">{fmtDate(v.fecha_docto)}</td>
                  <td className="mono" style={{ textAlign: "right" }}>{fmtMoney(v.monto_neto || 0)}</td>
                  <td className="mono" style={{ textAlign: "right", color: "var(--amber)" }}>{fmtMoney(v.monto_iva || 0)}</td>
                  <td className="mono" style={{ textAlign: "right", fontWeight: 700 }}>{fmtMoney(v.monto_total || 0)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ fontWeight: 700, background: "var(--bg3)" }}>
                <td colSpan={4} style={{ fontSize: 12 }}>TOTAL ({filtered.length} docs)</td>
                <td className="mono" style={{ textAlign: "right" }}>{fmtMoney(totalNeto)}</td>
                <td className="mono" style={{ textAlign: "right", color: "var(--amber)" }}>{fmtMoney(totalIva)}</td>
                <td className="mono" style={{ textAlign: "right", color: "var(--green)" }}>{fmtMoney(total)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

// ==================== BANCO ====================
const PAGE_SIZE_BANCO = 50;

function TabBanco({ empresa, periodo }: { empresa: DBEmpresa; periodo: string }) {
  const [data, setData] = useState<DBMovimientoBanco[]>([]);
  const [loading, setLoading] = useState(true);
  const [bancoUpload, setBancoUpload] = useState("banco_chile");
  const [showUpload, setShowUpload] = useState<false | "csv" | "liquidacion">(false);
  const [filter, setFilter] = useState("");
  const [bancoFilter, setBancoFilter] = useState("todos");
  const [tipoFilter, setTipoFilter] = useState<"todos" | "ingresos" | "egresos">("todos");
  const [descFilter, setDescFilter] = useState("todos");
  const [fechaDesde, setFechaDesde] = useState("");
  const [fechaHasta, setFechaHasta] = useState("");
  const [page, setPage] = useState(0);
  const [syncingMP, setSyncingMP] = useState(false);
  const [syncMPMsg, setSyncMPMsg] = useState<string | null>(null);

  // Convertir periodo YYYYMM → rango de fechas para filtrar
  const periodoToRange = useCallback((p: string) => {
    if (p.length === 4) {
      return { desde: `${p}-01-01`, hasta: `${p}-12-31` };
    }
    const y = parseInt(p.slice(0, 4));
    const m = parseInt(p.slice(4, 6));
    const desde = `${y}-${String(m).padStart(2, "0")}-01`;
    const lastDay = new Date(y, m, 0).getDate();
    const hasta = `${y}-${String(m).padStart(2, "0")}-${lastDay}`;
    return { desde, hasta };
  }, []);

  const load = useCallback(async () => {
    if (!empresa.id) return;
    setLoading(true);
    const { desde, hasta } = periodoToRange(periodo);
    const d = await fetchMovimientosBanco(empresa.id, { desde, hasta });
    setData(d);
    setLoading(false);
    setPage(0);
  }, [empresa.id, periodo, periodoToRange]);

  const handleSyncMP = useCallback(async () => {
    setSyncingMP(true);
    setSyncMPMsg(null);
    try {
      if (periodo.length === 4) {
        // Año completo: mes a mes
        let totalC = 0, totalR = 0;
        for (let mes = 1; mes <= 12; mes++) {
          const per = `${periodo}${String(mes).padStart(2, "0")}`;
          setSyncMPMsg(`Sync MP ${periodo} — mes ${mes}/12...`);
          try {
            const res = await fetch("/api/mp/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ periodo: per }) });
            const d = await res.json();
            if (!d.error) { totalR += d.retiros_nuevos || 0; }
          } catch { /* skip */ }
        }
        setSyncMPMsg(`${totalR} retiros importados de MP ${periodo}`);
      } else {
        const res = await fetch("/api/mp/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ periodo }) });
        const d = await res.json();
        if (d.error) setSyncMPMsg(`Error: ${d.error}`);
        else if (d.mensaje && d.retiros_nuevos === 0) setSyncMPMsg(d.mensaje);
        else setSyncMPMsg(`${d.retiros_nuevos || 0} retiros importados de MP`);
      }
      load();
    } catch (e) {
      setSyncMPMsg(`Error: ${e instanceof Error ? e.message : "sin detalles"}`);
    } finally {
      setSyncingMP(false);
    }
  }, [periodo, load]);

  useEffect(() => { load(); }, [load]);

  const handleImport = async (rows: CsvRow[]) => {
    if (!empresa.id) return;
    const items: DBMovimientoBanco[] = rows.map(r => ({
      empresa_id: empresa.id!,
      banco: bancoUpload,
      cuenta: null,
      fecha: r.fecha,
      descripcion: r.descripcion,
      monto: r.monto,
      saldo: r.saldo,
      referencia: r.referencia || null,
      origen: "csv" as const,
    }));
    await insertMovimientosBanco(items);
    setShowUpload(false);
    load();
  };

  const handleDeleteAll = async () => {
    if (!confirm("¿Eliminar todos los movimientos del periodo? Esta acción no se puede deshacer.")) return;
    const ids = data.map(d => d.id).filter(Boolean) as string[];
    if (ids.length > 0) await deleteMovimientosBancoByIds(ids);
    load();
  };

  // Bancos únicos para el filtro
  const bancosUnicos = Array.from(new Set(data.map(m => m.banco))).sort();

  // Categorías de descripción para filtro rápido
  const descCategorias = useMemo(() => {
    const cats = new Set<string>();
    for (const m of data) {
      const d = (m.descripcion || "").toUpperCase();
      if (d.startsWith("COMPRA ML")) cats.add("COMPRA ML");
      else if (d.startsWith("RETIRO MP")) cats.add("RETIRO");
      else if (d.startsWith("DEVOLUCION")) cats.add("DEVOLUCION");
      else if (d.startsWith("BONIFICACION")) cats.add("BONIFICACION");
      else if (d.startsWith("VENTA ML")) cats.add("VENTA ML");
      else if (d.startsWith("COMPRA MP")) cats.add("COMPRA MP");
      else cats.add("OTRO");
    }
    return Array.from(cats).sort();
  }, [data]);

  // Filtrado: por banco + tipo + descripcion + fecha + texto
  const filtered = data.filter(m => {
    if (bancoFilter !== "todos" && m.banco !== bancoFilter) return false;
    if (tipoFilter === "ingresos" && m.monto < 0) return false;
    if (tipoFilter === "egresos" && m.monto >= 0) return false;
    if (descFilter !== "todos") {
      const d = (m.descripcion || "").toUpperCase();
      if (descFilter === "OTRO") {
        if (["COMPRA ML", "RETIRO MP", "DEVOLUCION", "BONIFICACION", "VENTA ML", "COMPRA MP"].some(c => d.startsWith(c))) return false;
      } else if (!d.startsWith(descFilter)) return false;
    }
    if (fechaDesde && m.fecha < fechaDesde) return false;
    if (fechaHasta && m.fecha > fechaHasta) return false;
    if (filter) {
      const q = filter.toLowerCase();
      const matchDesc = (m.descripcion || "").toLowerCase().includes(q);
      const matchRef = (m.referencia || "").toLowerCase().includes(q);
      if (!matchDesc && !matchRef) return false;
    }
    return true;
  });

  // KPIs sobre TODOS los datos filtrados (no solo la página)
  const ingresos = filtered.filter(m => m.monto > 0).reduce((s, m) => s + m.monto, 0);
  const egresos = filtered.filter(m => m.monto < 0).reduce((s, m) => s + m.monto, 0);

  // Paginación
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE_BANCO);
  const pageData = filtered.slice(page * PAGE_SIZE_BANCO, (page + 1) * PAGE_SIZE_BANCO);

  // Reset página cuando cambia filtro
  useEffect(() => { setPage(0); }, [filter, bancoFilter]);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Movimientos Banco</h2>
          <div style={{ fontSize: 11, color: "var(--txt3)", marginTop: 2 }}>{formatPeriodo(periodo)} · {data.length.toLocaleString()} movimientos</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {data.length > 0 && (
            <button onClick={handleDeleteAll} style={{ padding: "6px 12px", borderRadius: 8, background: "var(--bg3)", color: "var(--red)", fontSize: 11, fontWeight: 600, border: "1px solid var(--bg4)" }}>
              Limpiar periodo
            </button>
          )}
          {showUpload ? (
            <button onClick={() => setShowUpload(false)} style={{ padding: "6px 12px", borderRadius: 8, background: "var(--bg3)", color: "var(--txt2)", fontSize: 11, fontWeight: 600, border: "1px solid var(--bg4)" }}>
              Cancelar
            </button>
          ) : (
            <>
              <button onClick={() => setShowUpload("csv")} className="scan-btn blue" style={{ padding: "6px 16px", fontSize: 12 }}>
                Subir CSV Banco
              </button>
              <button onClick={() => setShowUpload("liquidacion")} className="scan-btn" style={{ padding: "6px 16px", fontSize: 12, background: "linear-gradient(135deg, #009ee3, #00b1ea)" }}>
                Liquidación MP
              </button>
              <button onClick={handleSyncMP} disabled={syncingMP}
                style={{ padding: "6px 16px", fontSize: 12, fontWeight: 600, borderRadius: 8, background: "var(--blueBg)", color: "var(--blue)", border: "1px solid var(--blueBd)", cursor: "pointer", opacity: syncingMP ? 0.6 : 1 }}>
                {syncingMP ? "Sync MP..." : "Sync MP (Retiros)"}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Upload CSV Banco */}
      {showUpload === "csv" && (
        <div className="card" style={{ padding: 16, marginBottom: 16 }}>
          <div style={{ marginBottom: 12 }}>
            <label className="form-label">Banco / Fuente</label>
            <select value={bancoUpload} onChange={e => setBancoUpload(e.target.value)} className="form-input" style={{ fontSize: 13 }}>
              <option value="banco_chile">Banco de Chile</option>
              <option value="santander">Santander</option>
              <option value="bci">BCI</option>
              <option value="mercadopago">MercadoPago</option>
              <option value="otro">Otro</option>
            </select>
          </div>
          <CsvUploader banco={bancoUpload} onImport={handleImport} />
        </div>
      )}

      {/* Upload Liquidación MercadoPago */}
      {showUpload === "liquidacion" && (
        <div className="card" style={{ padding: 16, marginBottom: 16 }}>
          <MpLiquidacionUpload empresa={empresa} />
        </div>
      )}

      {loading ? (
        <div style={{ textAlign: "center", padding: 40, color: "var(--txt3)" }}>Cargando...</div>
      ) : data.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: "center" }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>🏦</div>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Sin movimientos en {formatPeriodo(periodo)}</div>
          <div style={{ fontSize: 12, color: "var(--txt3)" }}>Sube un CSV o sincroniza desde los scrapers</div>
        </div>
      ) : (
        <>
          {/* Resumen KPIs */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 12 }}>
            <div style={{ padding: 10, background: "var(--greenBg)", borderRadius: 10, textAlign: "center" }}>
              <div style={{ fontSize: 10, color: "var(--green)" }}>Ingresos</div>
              <div className="mono" style={{ fontSize: 15, fontWeight: 700, color: "var(--green)" }}>{fmtMoney(ingresos)}</div>
            </div>
            <div style={{ padding: 10, background: "var(--redBg)", borderRadius: 10, textAlign: "center" }}>
              <div style={{ fontSize: 10, color: "var(--red)" }}>Egresos</div>
              <div className="mono" style={{ fontSize: 15, fontWeight: 700, color: "var(--red)" }}>{fmtMoney(egresos)}</div>
            </div>
            <div style={{ padding: 10, background: "var(--blueBg)", borderRadius: 10, textAlign: "center" }}>
              <div style={{ fontSize: 10, color: "var(--blue)" }}>Neto</div>
              <div className="mono" style={{ fontSize: 15, fontWeight: 700, color: "var(--blue)" }}>{fmtMoney(ingresos + egresos)}</div>
            </div>
          </div>

          {syncMPMsg && (
            <div style={{ padding: "6px 10px", borderRadius: 6, marginBottom: 8, fontSize: 11, fontWeight: 600,
              background: syncMPMsg.startsWith("Error") ? "var(--redBg)" : "var(--blueBg)",
              color: syncMPMsg.startsWith("Error") ? "var(--red)" : "var(--blue)",
              border: `1px solid ${syncMPMsg.startsWith("Error") ? "var(--redBd)" : "var(--blueBd)"}` }}>
              {syncMPMsg}
            </div>
          )}

          {/* Filtros fila 1: tipo + categoria + banco */}
          <div style={{ display: "flex", gap: 8, marginBottom: 6, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ display: "flex", borderRadius: 6, overflow: "hidden", border: "1px solid var(--bg4)" }}>
              {(["todos", "ingresos", "egresos"] as const).map(t => (
                <button key={t} onClick={() => setTipoFilter(t)} style={{
                  padding: "5px 10px", fontSize: 10, fontWeight: 600, border: "none", cursor: "pointer",
                  background: tipoFilter === t ? (t === "ingresos" ? "var(--green)" : t === "egresos" ? "var(--red)" : "var(--cyan)") : "var(--bg3)",
                  color: tipoFilter === t ? "#000" : "var(--txt3)",
                }}>
                  {t === "todos" ? "Todos" : t === "ingresos" ? "Ingresos" : "Egresos"}
                </button>
              ))}
            </div>
            <select value={descFilter} onChange={e => setDescFilter(e.target.value)} className="form-input" style={{ fontSize: 11, width: "auto", minWidth: 130, padding: "4px 6px" }}>
              <option value="todos">Tipo: Todos</option>
              {descCategorias.map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            {bancosUnicos.length > 1 && (
              <select value={bancoFilter} onChange={e => setBancoFilter(e.target.value)} className="form-input" style={{ fontSize: 11, width: "auto", minWidth: 130, padding: "4px 6px" }}>
                <option value="todos">Banco: Todos</option>
                {bancosUnicos.map(b => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
            )}
            <div style={{ fontSize: 11, color: "var(--txt3)", whiteSpace: "nowrap" }}>
              {filtered.length.toLocaleString()} de {data.length.toLocaleString()}
            </div>
          </div>
          {/* Filtros fila 2: fechas + texto */}
          <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center" }}>
            <input type="date" className="form-input mono" value={fechaDesde} onChange={e => setFechaDesde(e.target.value)}
              style={{ fontSize: 10, padding: "4px 6px", width: 120 }} placeholder="Desde" />
            <input type="date" className="form-input mono" value={fechaHasta} onChange={e => setFechaHasta(e.target.value)}
              style={{ fontSize: 10, padding: "4px 6px", width: 120 }} placeholder="Hasta" />
            {(fechaDesde || fechaHasta) && (
              <button onClick={() => { setFechaDesde(""); setFechaHasta(""); }} style={{ padding: "3px 8px", borderRadius: 4, fontSize: 10, background: "var(--bg3)", color: "var(--txt3)", border: "1px solid var(--bg4)", cursor: "pointer" }}>
                Limpiar
              </button>
            )}
            <input className="form-input" placeholder="Buscar descripcion o referencia..." value={filter} onChange={e => setFilter(e.target.value)}
              style={{ fontSize: 11, flex: 1, padding: "4px 8px" }} />
          </div>

          {/* Tabla paginada */}
          <div style={{ overflowX: "auto" }}>
            <table className="tbl" style={{ fontSize: 11 }}>
              <thead>
                <tr>
                  <th>Fecha</th><th>Descripción</th><th>Banco</th>
                  <th style={{ textAlign: "right" }}>Monto</th><th style={{ textAlign: "right" }}>Saldo</th><th>Ref.</th>
                </tr>
              </thead>
              <tbody>
                {pageData.map((m, i) => (
                  <tr key={m.id || i}>
                    <td className="mono">{fmtDate(m.fecha)}</td>
                    <td style={{ maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.descripcion || "—"}</td>
                    <td style={{ fontSize: 10, textTransform: "uppercase" }}>{m.banco}</td>
                    <td className="mono" style={{ textAlign: "right", fontWeight: 700, color: m.monto >= 0 ? "var(--green)" : "var(--red)" }}>{fmtMoney(m.monto)}</td>
                    <td className="mono" style={{ textAlign: "right", color: "var(--txt3)" }}>{m.saldo !== null ? fmtMoney(m.saldo) : "—"}</td>
                    <td className="mono" style={{ fontSize: 10, color: "var(--txt3)", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis" }}>{m.referencia || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Paginación */}
          {totalPages > 1 && (
            <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 8, marginTop: 12, paddingBottom: 8 }}>
              <button onClick={() => setPage(0)} disabled={page === 0}
                style={{ padding: "4px 8px", borderRadius: 6, fontSize: 11, background: "var(--bg3)", color: page === 0 ? "var(--txt3)" : "var(--cyan)", border: "1px solid var(--bg4)", cursor: page === 0 ? "default" : "pointer", opacity: page === 0 ? 0.4 : 1 }}>
                ««
              </button>
              <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
                style={{ padding: "4px 10px", borderRadius: 6, fontSize: 11, background: "var(--bg3)", color: page === 0 ? "var(--txt3)" : "var(--cyan)", border: "1px solid var(--bg4)", cursor: page === 0 ? "default" : "pointer", opacity: page === 0 ? 0.4 : 1 }}>
                ‹ Anterior
              </button>
              <span className="mono" style={{ fontSize: 11, color: "var(--txt2)", padding: "0 8px" }}>
                {page + 1} / {totalPages}
              </span>
              <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}
                style={{ padding: "4px 10px", borderRadius: 6, fontSize: 11, background: "var(--bg3)", color: page >= totalPages - 1 ? "var(--txt3)" : "var(--cyan)", border: "1px solid var(--bg4)", cursor: page >= totalPages - 1 ? "default" : "pointer", opacity: page >= totalPages - 1 ? 0.4 : 1 }}>
                Siguiente ›
              </button>
              <button onClick={() => setPage(totalPages - 1)} disabled={page >= totalPages - 1}
                style={{ padding: "4px 8px", borderRadius: 6, fontSize: 11, background: "var(--bg3)", color: page >= totalPages - 1 ? "var(--txt3)" : "var(--cyan)", border: "1px solid var(--bg4)", cursor: page >= totalPages - 1 ? "default" : "pointer", opacity: page >= totalPages - 1 ? 0.4 : 1 }}>
                »»
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ==================== PÁGINA PRINCIPAL ====================
type TabKey = "dash" | "compras" | "ventas" | "banco" | "conciliacion" | "cuentas" | "reglas" | "resultados" | "flujo" | "proyectado" | "presupuesto";

export default function ConciliacionPage() {
  const [tab, setTab] = useState<TabKey>("dash");
  const [empresa, setEmpresa] = useState<DBEmpresa | null>(null);
  const [periodo, setPeriodo] = useState(currentPeriodo());
  const [loading, setLoading] = useState(true);
  const [mounted, setMounted] = useState(false);
  const auth = useAuth();

  useEffect(() => {
    setMounted(true);
    fetchEmpresaDefault().then(e => {
      setEmpresa(e);
      setLoading(false);
    });
  }, []);

  if (!mounted) return null;
  if (!auth.ok) return <LoginGate onLogin={auth.login} />;
  if (loading) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100dvh", background: "var(--bg)" }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>BANVA Conciliador</div>
        <div style={{ color: "var(--txt3)" }}>Cargando...</div>
      </div>
    </div>
  );

  const tabs: [TabKey, string, string][] = [
    ["dash", "Dashboard", "📊"],
    ["compras", "RCV Compras", "📄"],
    ["ventas", "RCV Ventas", "📄"],
    ["banco", "Banco", "🏦"],
    ["conciliacion", "Conciliación", "🔗"],
    ["cuentas", "Plan Cuentas", "📋"],
    ["reglas", "Reglas", "⚙️"],
    ["resultados", "Estado Resultados", "📈"],
    ["flujo", "Flujo Caja", "💰"],
    ["proyectado", "Flujo Proyectado", "🔮"],
    ["presupuesto", "Presupuesto", "📊"],
  ];

  return (
    <div className="app-admin">
      {/* Topbar */}
      <div className="admin-topbar">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Link href="/admin"><button className="back-btn">&#8592;</button></Link>
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", color: "var(--cyan)", textTransform: "uppercase" }}>BANVA</div>
            <h1 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>Conciliador Tributario-Bancario</h1>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {/* Selector de período */}
          <select value={periodo} onChange={e => setPeriodo(e.target.value)}
            style={{ background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", borderRadius: 8, padding: "6px 10px", fontSize: 12, fontWeight: 600 }}>
            {periodOptions().map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          {empresa && <span style={{ fontSize: 11, color: "var(--txt3)" }}>{empresa.razon_social} · {empresa.rut}</span>}
          <button onClick={auth.logout} style={{ padding: "6px 14px", borderRadius: 6, background: "var(--bg3)", color: "var(--red)", fontSize: 11, fontWeight: 600, border: "1px solid var(--bg4)" }}>Cerrar sesión</button>
        </div>
      </div>

      {/* Layout sidebar + main */}
      <div className="admin-layout">
        <nav className="admin-sidebar">
          {tabs.map(([key, label, icon]) => (
            <button key={key} className={`sidebar-btn ${tab === key ? "active" : ""}`} onClick={() => setTab(key)}>
              <span className="sidebar-icon">{icon}</span>
              <span className="sidebar-label">{label}</span>
            </button>
          ))}
          <div style={{ flex: 1 }} />
          <Link href="/admin"><button className="sidebar-btn"><span className="sidebar-icon">📦</span><span className="sidebar-label">WMS Bodega</span></button></Link>
        </nav>

        <main className="admin-main">
          {/* Mobile tabs */}
          <div className="admin-mobile-tabs">
            {tabs.map(([key, label]) => (
              <button key={key} className={`tab ${tab === key ? "active-cyan" : ""}`} onClick={() => setTab(key)}>{label}</button>
            ))}
          </div>
          <div className="admin-content">
            {empresa && tab === "dash" && <Dashboard empresa={empresa} periodo={periodo} onChangePeriodo={setPeriodo} />}
            {empresa && tab === "compras" && <TabRcvCompras empresa={empresa} periodo={periodo} />}
            {empresa && tab === "ventas" && <TabRcvVentas empresa={empresa} periodo={periodo} />}
            {empresa && tab === "banco" && <TabBanco empresa={empresa} periodo={periodo} />}
            {empresa && tab === "conciliacion" && <ConciliacionSplitView empresa={empresa} periodo={periodo} />}
            {tab === "cuentas" && <PlanCuentasTree />}
            {tab === "reglas" && <RuleBuilder />}
            {empresa && tab === "resultados" && <EstadoResultados empresa={empresa} periodo={periodo} />}
            {empresa && tab === "flujo" && <FlujoCaja empresa={empresa} periodo={periodo} />}
            {empresa && tab === "proyectado" && <FlujoProyectado empresa={empresa} periodo={periodo} />}
            {empresa && tab === "presupuesto" && <TabPresupuesto empresa={empresa} periodo={periodo} />}
            {!empresa && tab !== "cuentas" && tab !== "reglas" && (
              <div className="card" style={{ padding: 32, textAlign: "center" }}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>⚠️</div>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>No se encontró empresa</div>
                <div style={{ fontSize: 12, color: "var(--txt3)" }}>Ejecuta la migración SQL v7 para crear la tabla empresas con BANVA</div>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
