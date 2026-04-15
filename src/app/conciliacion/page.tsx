"use client";
import { useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import {
  fetchEmpresaDefault,
  fetchRcvCompras, fetchRcvVentas,
  upsertRcvCompras, upsertRcvVentas,
  fetchMovimientosBanco, insertMovimientosBanco, deleteMovimientosBancoByIds,
  fetchConciliaciones,
  fetchAllConciliacionItems,
  fetchAlertas, fetchSyncLog, insertSyncLog,
  fetchProveedorCuentas,
  upsertProveedorCuenta,
  fetchPlanCuentasHojas,
  updateRcvCompra,
} from "@/lib/db";
import type {
  DBEmpresa, DBRcvCompra, DBRcvVenta, DBMovimientoBanco,
  DBConciliacion, DBConciliacionItem, DBAlerta, DBSyncLog, DBProveedorCuenta,
} from "@/lib/db";
import CsvUploader from "@/components/CsvUploader";
import type { CsvRow } from "@/components/CsvUploader";
import dynamic from "next/dynamic";

// Componentes pesados: carga dinámica para no inflar el bundle inicial
const DashboardConciliacion = dynamic(() => import("@/components/DashboardConciliacion"), { ssr: false });
const PlanCuentasTree = dynamic(() => import("@/components/PlanCuentasTree"), { ssr: false });
const RuleBuilder = dynamic(() => import("@/components/RuleBuilder"), { ssr: false });
const ConciliacionSplitView = dynamic(() => import("@/components/ConciliacionSplitView"), { ssr: false });
const ConciliacionTabla = dynamic(() => import("@/components/ConciliacionTabla"), { ssr: false });
const EstadoResultados = dynamic(() => import("@/components/EstadoResultados"), { ssr: false });
const FlujoCaja = dynamic(() => import("@/components/FlujoCaja"), { ssr: false });
const FlujoProyectado = dynamic(() => import("@/components/FlujoProyectado"), { ssr: false });
const TabPresupuesto = dynamic(() => import("@/components/TabPresupuesto"), { ssr: false });
const MpLiquidacionUpload = dynamic(() => import("@/components/MpLiquidacionUpload"), { ssr: false });
const TabProveedores = dynamic(() => import("@/components/TabProveedores"), { ssr: false });

// Filtrar movimientos internos MP (no conciliables)
function isMovReal(m: DBMovimientoBanco): boolean {
  const desc = (m.descripcion || "").toUpperCase();
  if (desc.startsWith("VENTA ML") || desc.startsWith("BONIFICACION") || desc.startsWith("DEVOLUCION") || desc.startsWith("PAGO MP #")) return false;
  return true;
}

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
  71: "BHE",
};

const TIPO_DOC_ABREV: Record<number | string, string> = {
  33: "FAC", 34: "EXE", 39: "BOL", 41: "BEX", 46: "FCC",
  52: "GDE", 56: "NDB", 61: "NOT", 71: "BHE",
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
  tipo: "COMPRA" | "VENTA" | "BHE";
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
  const [progreso, setProgreso] = useState("");
  const [error, setError] = useState("");
  const [resultado, setResultado] = useState<{ registros: number } | null>(null);

  const label = tipo === "COMPRA" ? "Compras" : tipo === "BHE" ? "Boletas de Honorarios" : "Ventas";

  const handleImport = async () => {
    if (!rut || !clave || !periodo) {
      setError("Completa todos los campos");
      return;
    }
    setLoading(true);
    setError("");
    setResultado(null);

    try {
      // Expandir año a meses si es YYYY
      const periodos: string[] = [];
      if (periodo.length === 4) {
        for (let m = 1; m <= 12; m++) periodos.push(`${periodo}${String(m).padStart(2, "0")}`);
      } else {
        periodos.push(periodo);
      }

      const endpoint = tipo === "BHE" ? "/api/sii/bhe" : "/api/sii/rcv";
      let allData: Record<string, unknown>[] = [];
      const errores: string[] = [];

      for (let i = 0; i < periodos.length; i++) {
        const p = periodos[i];
        if (periodos.length > 1) setProgreso(`${p.slice(4)}/${p.slice(0,4)} (${i+1}/${periodos.length})`);
        const resp = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(tipo === "BHE" ? { periodo: p, rut, clave } : { rut, clave, periodo: p, tipo }),
        });
        const json = await resp.json();
        if (!resp.ok) { errores.push(`${p}: ${json.error || resp.status}`); continue; }
        if (json.data && json.data.length > 0) allData.push(...json.data);
      }

      if (errores.length > 0 && allData.length === 0) {
        setError(errores[0]);
        setLoading(false);
        return;
      }

      const json = { data: allData };

      if (json.data.length === 0) {
        setResultado({ registros: 0 });
        setLoading(false);
        return;
      }

      // Guardar en Supabase
      if (tipo === "COMPRA" || tipo === "BHE") {
        const items = allData.map((d) => ({
          ...d,
          empresa_id: empresa.id,
        })) as DBRcvCompra[];
        await upsertRcvCompras(items);
      } else {
        const items = allData.map((d) => ({
          ...d,
          empresa_id: empresa.id,
        })) as DBRcvVenta[];
        await upsertRcvVentas(items);
      }

      // Registrar sync
      if (empresa.id) {
        await insertSyncLog({
          empresa_id: empresa.id,
          periodo,
          tipo: tipo === "COMPRA" || tipo === "BHE" ? "compras" : "ventas",
          registros: allData.length,
        });
      }

      // Guardar credenciales en sesión si se pidió
      if (guardarCreds) {
        sii.save(rut, clave);
      } else {
        sii.clear();
      }

      setResultado({ registros: allData.length });
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
              {loading ? (progreso ? `Importando ${progreso}` : "Consultando SII...") : `Importar ${label}`}
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

// ==================== RCV COMPRAS ====================
function TabRcvCompras({ empresa, periodo }: { empresa: DBEmpresa; periodo: string }) {
  const [data, setData] = useState<DBRcvCompra[]>([]);
  const [comprasGlobal, setComprasGlobal] = useState<DBRcvCompra[]>([]);
  const [conciliaciones, setConciliaciones] = useState<DBConciliacion[]>([]);
  const [conciliacionItems, setConciliacionItems] = useState<DBConciliacionItem[]>([]);
  const [provCuentas, setProvCuentas] = useState<DBProveedorCuenta[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  const [tipoFilter, setTipoFilter] = useState<string>("todos");
  const [concFilter, setConcFilter] = useState<"todos" | "por_pagar" | "vencidas" | "pagadas" | "por_clasificar">("todos");
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [showBheModal, setShowBheModal] = useState(false);
  const [clasificarItem, setClasificarItem] = useState<DBRcvCompra | null>(null);
  const [clasificarCuenta, setClasificarCuenta] = useState("");
  const [clasificarBusca, setClasificarBusca] = useState("");
  const [pagoItem, setPagoItem] = useState<DBRcvCompra | null>(null);
  const [movsBanco, setMovsBanco] = useState<DBMovimientoBanco[]>([]);
  const [pagoLoading, setPagoLoading] = useState(false);
  const [pagoSaving, setPagoSaving] = useState(false);
  const [pagoSearch, setPagoSearch] = useState("");
  const [pagoSelected, setPagoSelected] = useState<{ mov: DBMovimientoBanco; monto_aplicado: number }[]>([]);
  const [pagoNCs, setPagoNCs] = useState<Set<string>>(new Set());
  const [provFilterSet, setProvFilterSet] = useState<Set<string> | null>(null); // null = todos
  const [provFilterMode, setProvFilterMode] = useState<"incluir" | "excluir">("incluir");
  const [showProvFilter, setShowProvFilter] = useState(false);
  const [showProveedores, setShowProveedores] = useState(false);
  const [editingNota, setEditingNota] = useState<string | null>(null);
  const [notaText, setNotaText] = useState("");
  const [detalleConc, setDetalleConc] = useState<string | null>(null);
  const [detalleMov, setDetalleMov] = useState<DBMovimientoBanco | null>(null);
  const [detalleLoading, setDetalleLoading] = useState(false);
  const [editingProv, setEditingProv] = useState<string | null>(null);
  const [editPlazo, setEditPlazo] = useState("");
  const [editCuenta, setEditCuenta] = useState("");
  const [editVariable, setEditVariable] = useState(false);
  const [cuentasHoja, setCuentasHoja] = useState<{ id: string; codigo: string; nombre: string }[]>([]);

  const isAnual = periodo.length === 4;

  const load = useCallback(async () => {
    if (!empresa.id) return;
    setLoading(true);
    const [conc, items, pc, ctas, allCompras] = await Promise.all([
      fetchConciliaciones(empresa.id),
      fetchAllConciliacionItems(),
      fetchProveedorCuentas(),
      fetchPlanCuentasHojas(),
      fetchRcvCompras(empresa.id),
    ]);
    setConciliaciones(conc);
    setConciliacionItems(items);
    setProvCuentas(pc);
    setCuentasHoja(ctas.map(c => ({ id: c.id!, codigo: c.codigo, nombre: c.nombre })));
    setComprasGlobal(allCompras);
    if (isAnual) {
      setData(allCompras.filter(c => (c.periodo || "").startsWith(periodo)));
    } else {
      setData(allCompras.filter(c => c.periodo === periodo));
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

  // Proveedores únicos con totales (debe estar antes del early return)
  const proveedoresUnicos = useMemo(() => {
    const map = new Map<string, { rut: string; razon_social: string; facturas: number; total: number }>();
    for (const c of data) {
      const rut = c.rut_proveedor || "";
      if (!rut) continue;
      const existing = map.get(rut);
      if (existing) {
        existing.facturas++;
        existing.total += c.monto_total || 0;
      } else {
        map.set(rut, { rut, razon_social: c.razon_social || "", facturas: 1, total: c.monto_total || 0 });
      }
    }
    return Array.from(map.values()).sort((a, b) => b.total - a.total);
  }, [data]);

  // Mapa de monto aplicado por compra (sumando todas las conciliaciones por MONTO, no ocurrencias)
  const montoAplicadoPorCompra = useMemo(() => {
    const map = new Map<string, number>();
    const concById = new Map(conciliaciones.map(c => [c.id, c]));
    // Match simple: rcv_compra_id directo → suma monto_aplicado de la conciliacion
    for (const c of conciliaciones) {
      if (c.estado === "confirmado" && c.rcv_compra_id) {
        map.set(c.rcv_compra_id, (map.get(c.rcv_compra_id) || 0) + (c.monto_aplicado || 0));
      }
    }
    // Multi-doc / anulaciones: items en conciliacion_items
    for (const item of conciliacionItems) {
      if (item.documento_tipo !== "rcv_compra") continue;
      const conc = concById.get(item.conciliacion_id);
      if (!conc || conc.estado !== "confirmado") continue;
      // Evitar doble conteo: si la conciliacion tiene rcv_compra_id igual al item, ya se sumó arriba
      if (conc.rcv_compra_id === item.documento_id) continue;
      map.set(item.documento_id, (map.get(item.documento_id) || 0) + (item.monto_aplicado || 0));
    }
    return map;
  }, [conciliaciones, conciliacionItems]);
  // Factura "pagada" cuando el monto acumulado cubre el total (tolerancia 1 peso)
  const concCompraIds = useMemo(() => {
    const s = new Set<string>();
    for (const c of comprasGlobal) {
      const aplicado = montoAplicadoPorCompra.get(c.id!) || 0;
      if (aplicado + 1 >= (c.monto_total || 0) && aplicado > 0) s.add(c.id!);
    }
    return s;
  }, [montoAplicadoPorCompra, comprasGlobal]);

  // Mapa de anulaciones: compraId -> { concId, ncIds[] }
  // Una anulación es una conciliación con tipo_partida='anulacion' y sus items
  const anulacionByCompra = useMemo(() => {
    const map = new Map<string, { concId: string; ncIds: string[] }>();
    const anulConcs = conciliaciones.filter(c => c.estado === "confirmado" && c.tipo_partida === "anulacion");
    for (const conc of anulConcs) {
      const items = conciliacionItems.filter(i => i.conciliacion_id === conc.id && i.documento_tipo === "rcv_compra");
      if (items.length < 2) continue;
      // La factura "anulada" es la de tipo_doc != 61; las demás son NCs
      const itemDocs = items.map(i => data.find(c => c.id === i.documento_id)).filter(Boolean) as DBRcvCompra[];
      const factura = itemDocs.find(d => d.tipo_doc !== 61);
      const ncs = itemDocs.filter(d => d.tipo_doc === 61);
      if (factura) {
        map.set(factura.id!, { concId: conc.id!, ncIds: ncs.map(n => n.id!) });
        // Marcar NCs como "consumidas" por esta anulación
        for (const nc of ncs) map.set(nc.id!, { concId: conc.id!, ncIds: [factura.id!] });
      }
    }
    return map;
  }, [conciliaciones, conciliacionItems, data]);

  // Mapa de NCs vinculadas a cada factura (via factura_ref_id) y viceversa
  // Usa comprasGlobal (todas las compras de la empresa) para resolver referencias
  // cross-período: una NC en abril puede apuntar a una factura en enero
  const ncsPorFactura = useMemo(() => {
    const map = new Map<string, DBRcvCompra[]>();
    for (const c of comprasGlobal) {
      if (c.tipo_doc === 61 && c.factura_ref_id) {
        const arr = map.get(c.factura_ref_id) || [];
        arr.push(c);
        map.set(c.factura_ref_id, arr);
      }
    }
    return map;
  }, [comprasGlobal]);

  const facturaPorNc = useMemo(() => {
    const map = new Map<string, DBRcvCompra>();
    const byId = new Map(comprasGlobal.map(d => [d.id!, d]));
    for (const c of comprasGlobal) {
      if (c.tipo_doc === 61 && c.factura_ref_id) {
        const fac = byId.get(c.factura_ref_id);
        if (fac) map.set(c.id!, fac);
      }
    }
    return map;
  }, [comprasGlobal]);

  // Set de IDs de documentos "consumidos" por cualquier conciliación confirmada (pagadas o anuladas)
  const usedDocIds = useMemo(() => {
    const s = new Set<string>();
    const concIdsConfirmadas = new Set(conciliaciones.filter(c => c.estado === "confirmado").map(c => c.id));
    for (const item of conciliacionItems) {
      if (item.documento_tipo === "rcv_compra" && concIdsConfirmadas.has(item.conciliacion_id)) s.add(item.documento_id);
    }
    for (const c of conciliaciones) {
      if (c.estado === "confirmado" && c.rcv_compra_id) s.add(c.rcv_compra_id);
    }
    return s;
  }, [conciliaciones, conciliacionItems]);

  if (loading) return <div style={{ textAlign: "center", padding: 40, color: "var(--txt3)" }}>Cargando...</div>;

  // Tipos disponibles para el filtro
  const tiposDisponibles = Array.from(new Set(data.map(c => String(c.tipo_doc))));

  // Handler para guardar proveedor
  const handleSaveProv = async (rut: string) => {
    const plazo = editPlazo ? parseInt(editPlazo) : null;
    const prov = proveedoresUnicos.find(p => p.rut === rut);
    await upsertProveedorCuenta(rut, editCuenta || "", prov?.razon_social, plazo, editVariable);
    setProvCuentas(prev => {
      const idx = prev.findIndex(p => p.rut_proveedor === rut);
      const updated: DBProveedorCuenta = { rut_proveedor: rut, razon_social: prov?.razon_social || null, categoria_cuenta_id: editCuenta || null, plazo_dias: plazo, cuenta_variable: editVariable };
      if (idx >= 0) { const next = [...prev]; next[idx] = updated; return next; }
      return [...prev, updated];
    });
    setEditingProv(null);
  };

  // Mapa RUT → plazo_dias
  const plazoByRut = new Map(provCuentas.filter(p => p.plazo_dias).map(p => [p.rut_proveedor, p.plazo_dias!]));

  // Calcular vencimiento
  const getVencimiento = (c: DBRcvCompra): { fecha: string; diasRestantes: number } | null => {
    const plazo = plazoByRut.get(c.rut_proveedor || "");
    if (!plazo || !c.fecha_docto) return null;
    const fechaDoc = new Date(c.fecha_docto + "T12:00:00");
    const venc = new Date(fechaDoc.getTime() + plazo * 86400000);
    const dias = Math.ceil((venc.getTime() - Date.now()) / 86400000);
    return { fecha: venc.toISOString().slice(0, 10), diasRestantes: dias };
  };

  // Counts cruzados dentro del mismo AÑO (no todo el histórico).
  // Cross-período pero scoped al año seleccionado: una factura de febrero vencida
  // se ve desde cualquier mes de 2026, pero no aparecen facturas de 2025.
  const anioActual = periodo.slice(0, 4);
  const comprasAnio = comprasGlobal.filter(c => (c.periodo || "").startsWith(anioActual));
  const totalPagadas = comprasAnio.filter(c => concCompraIds.has(c.id!)).length;
  const porPagarList = comprasAnio.filter(c => !concCompraIds.has(c.id!) && c.tipo_doc !== 61);
  const vencidasList = porPagarList.filter(c => {
    const venc = getVencimiento(c);
    return venc && venc.diasRestantes < 0;
  });

  // Filtrar por texto, tipo, proveedor y estado conciliación
  // "todos" usa data (período actual). Los filtros de estado usan comprasAnio (todo el año).
  let filtered: DBRcvCompra[] = concFilter === "todos" ? data : comprasAnio;
  if (tipoFilter !== "todos") filtered = filtered.filter(c => String(c.tipo_doc) === tipoFilter);
  if (provFilterSet) filtered = filtered.filter(c => {
    const match = provFilterSet.has(c.rut_proveedor || "");
    return provFilterMode === "incluir" ? match : !match;
  });
  if (concFilter === "por_pagar") filtered = filtered.filter(c => !concCompraIds.has(c.id!) && c.tipo_doc !== 61);
  else if (concFilter === "vencidas") filtered = filtered.filter(c => {
    const venc = getVencimiento(c);
    return !concCompraIds.has(c.id!) && c.tipo_doc !== 61 && venc && venc.diasRestantes < 0;
  });
  else if (concFilter === "pagadas") filtered = filtered.filter(c => concCompraIds.has(c.id!));
  else if (concFilter === "por_clasificar") filtered = filtered.filter(c => !getClasificacion(c));
  if (filter) {
    const q = filter.toLowerCase();
    const qNum = q.replace(/[.,]/g, "");
    const isNum = qNum !== "" && !isNaN(Number(qNum));
    filtered = filtered.filter(c => {
      if ((c.razon_social || "").toLowerCase().includes(q)) return true;
      if ((c.rut_proveedor || "").includes(filter)) return true;
      if ((c.nro_doc || "").includes(filter)) return true;
      if ((c.notas || "").toLowerCase().includes(q)) return true;
      if (isNum && (c.monto_total || 0).toString().includes(qNum)) return true;
      return false;
    });
  }

  // Ordenar: por pagar y vencidas → vencimiento más urgente primero
  if (concFilter === "por_pagar" || concFilter === "vencidas") {
    filtered = [...filtered].sort((a, b) => {
      const va = getVencimiento(a);
      const vb = getVencimiento(b);
      if (!va && !vb) return 0;
      if (!va) return 1;
      if (!vb) return -1;
      return va.diasRestantes - vb.diasRestantes;
    });
  }

  const totalNeto = filtered.reduce((s, c) => s + (c.monto_neto || 0), 0);
  const totalExento = filtered.reduce((s, c) => s + (c.monto_exento || 0), 0);
  const totalIva = filtered.reduce((s, c) => s + (c.monto_iva || 0), 0);
  const total = filtered.reduce((s, c) => s + (c.monto_total || 0), 0);

  // Clasificacion por proveedor (cuenta asignada o "Sin clasificar")
  const getClasificacion = (c: DBRcvCompra) => {
    const pc = provCuentas.find(x => x.rut_proveedor === (c.rut_proveedor || ""));
    if (!pc?.categoria_cuenta_id) return null;
    const cuenta = cuentasHoja.find(x => x.id === pc.categoria_cuenta_id);
    return cuenta ? `${empresa.razon_social || "Empresa"} / ${cuenta.nombre}` : null;
  };

  const sinClasificar = data.filter(c => !getClasificacion(c));
  const pctConciliado = data.length > 0 ? Math.round((totalPagadas / data.length) * 100) : 0;

  return (
    <div>
      {/* Header — Chipax style */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Registro de Compras</h2>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <div style={{ fontSize: 12, color: "var(--txt3)", padding: "6px 16px", border: "1px solid var(--bg4)", borderRadius: 20 }}>
            {pctConciliado}% conciliado este mes
          </div>
          <span style={{ fontSize: 14, fontWeight: 700 }}>{empresa.razon_social}</span>
          <button onClick={handleSyncSii} disabled={syncing}
            style={{ width: 36, height: 36, borderRadius: "50%", background: "var(--cyan)", color: "#fff", border: "none", cursor: syncing ? "not-allowed" : "pointer", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center", opacity: syncing ? 0.6 : 1 }}
            title="Importar desde SII">{syncing ? "..." : "\u21BB"}</button>
          <button onClick={() => setShowBheModal(true)}
            style={{ width: 36, height: 36, borderRadius: "50%", background: "var(--bg3)", border: "1px solid var(--bg4)", cursor: "pointer", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center" }}
            title="Importar BHE">+</button>
          {empresa.id && (
            <button onClick={() => window.open(`/api/sii/export?empresa_id=${empresa.id}&anio=${isAnual ? periodo : periodo.slice(0, 4)}&tipo=compras`, "_blank")}
              style={{ width: 36, height: 36, borderRadius: "50%", background: "var(--bg3)", border: "1px solid var(--bg4)", cursor: "pointer", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center" }}
              title="Exportar CSV">{"\u2193"}</button>
          )}
        </div>
      </div>

      {/* Modal Importar BHE */}
      {showBheModal && <SiiImportModal tipo="BHE" empresa={empresa} periodoActual={periodo} onClose={() => setShowBheModal(false)} onImported={() => { setShowBheModal(false); load(); }} />}

      {/* Modal Clasificar Compra — Chipax style */}
      {clasificarItem && (() => {
        const cuentasFiltradas = cuentasHoja.filter(c =>
          !clasificarBusca || c.nombre.toLowerCase().includes(clasificarBusca.toLowerCase()) || c.codigo.toLowerCase().includes(clasificarBusca.toLowerCase())
        );
        const handleGuardar = async () => {
          if (!clasificarCuenta || !clasificarItem.rut_proveedor) return;
          await upsertProveedorCuenta(clasificarItem.rut_proveedor, clasificarCuenta, clasificarItem.razon_social || undefined);
          setProvCuentas(await fetchProveedorCuentas());
          setClasificarItem(null);
        };
        return (
          <div style={{ position: "fixed", inset: 0, zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.4)" }}
            onClick={() => setClasificarItem(null)}>
            <div onClick={e => e.stopPropagation()} style={{ background: "var(--bg2)", borderRadius: 12, width: "100%", maxWidth: 700, maxHeight: "90vh", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 20px 60px rgba(0,0,0,0.15)" }}>
              {/* Header */}
              <div style={{ padding: "20px 28px", background: "var(--cyan)", color: "#fff", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 18, fontWeight: 700 }}>Clasificar Compras</span>
                <button onClick={() => setClasificarItem(null)} style={{ background: "none", border: "none", color: "#fff", fontSize: 22, cursor: "pointer", lineHeight: 1 }}>&times;</button>
              </div>
              {/* Body */}
              <div style={{ padding: "24px 28px", flex: 1, overflow: "auto" }}>
                {/* Warning */}
                <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", border: "1px solid var(--bg4)", borderRadius: 8, marginBottom: 24 }}>
                  <span style={{ fontSize: 20, color: "var(--amber)" }}>&#9888;</span>
                  <span style={{ fontSize: 13 }}>
                    Atenci&oacute;n: Se actualizar&aacute; la clasificaci&oacute;n de <strong>1 Compra</strong> &mdash; {clasificarItem.razon_social} ({fmtRut(clasificarItem.rut_proveedor)})
                  </span>
                </div>
                {/* Fields */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1.5fr", gap: 16, alignItems: "start" }}>
                  {/* Periodo */}
                  <div>
                    <label style={{ fontSize: 12, fontWeight: 600, color: "var(--txt3)", display: "block", marginBottom: 6 }}>Periodo Clasificaci&oacute;n</label>
                    <input readOnly value={clasificarItem.fecha_docto?.slice(0, 7) || periodo}
                      style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid var(--bg4)", background: "var(--bg3)", color: "var(--txt)", fontSize: 13 }} />
                  </div>
                  {/* Linea de Negocio */}
                  <div>
                    <label style={{ fontSize: 12, fontWeight: 600, color: "var(--txt3)", display: "block", marginBottom: 6 }}>L&iacute;nea de Negocio *</label>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "10px 12px", borderRadius: 8, border: "1px solid var(--bg4)", background: "var(--bg2)", fontSize: 13 }}>
                      <span style={{ flex: 1 }}>{empresa.razon_social || "Empresa"}</span>
                    </div>
                  </div>
                  {/* Cuenta */}
                  <div>
                    <label style={{ fontSize: 12, fontWeight: 600, color: "var(--txt3)", display: "block", marginBottom: 6 }}>Cuenta *</label>
                    <input placeholder="Buscar Cuenta..." value={clasificarBusca} onChange={e => { setClasificarBusca(e.target.value); setClasificarCuenta(""); }}
                      style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid var(--bg4)", background: "var(--bg2)", color: "var(--txt)", fontSize: 13 }} />
                    {clasificarBusca && !clasificarCuenta && (
                      <div style={{ border: "1px solid var(--bg4)", borderRadius: 8, marginTop: 4, maxHeight: 180, overflowY: "auto", background: "var(--bg2)", boxShadow: "0 4px 12px rgba(0,0,0,0.08)" }}>
                        {cuentasFiltradas.length === 0 ? (
                          <div style={{ padding: "10px 12px", fontSize: 12, color: "var(--txt3)" }}>Sin resultados</div>
                        ) : cuentasFiltradas.slice(0, 15).map(c => (
                          <div key={c.id} onClick={() => { setClasificarCuenta(c.id); setClasificarBusca(`${c.codigo} \u2014 ${c.nombre}`); }}
                            style={{ padding: "8px 12px", fontSize: 12, cursor: "pointer", borderBottom: "1px solid var(--bg4)" }}
                            onMouseOver={e => (e.currentTarget.style.background = "var(--bg3)")}
                            onMouseOut={e => (e.currentTarget.style.background = "transparent")}>
                            <span style={{ fontWeight: 600, color: "var(--cyan)" }}>{c.codigo}</span>
                            <span style={{ marginLeft: 8, color: "var(--txt2)" }}>{c.nombre}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
              {/* Footer */}
              <div style={{ padding: "16px 28px", borderTop: "1px solid var(--bg4)", display: "flex", justifyContent: "flex-end", gap: 10 }}>
                <button onClick={() => setClasificarItem(null)}
                  style={{ padding: "10px 24px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", background: "var(--bg2)", color: "var(--txt2)", border: "1px solid var(--bg4)" }}>
                  Cancelar
                </button>
                <button onClick={handleGuardar} disabled={!clasificarCuenta}
                  style={{ padding: "10px 24px", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: clasificarCuenta ? "pointer" : "not-allowed", background: clasificarCuenta ? "var(--cyan)" : "var(--bg4)", color: clasificarCuenta ? "#fff" : "var(--txt3)", border: "none" }}>
                  Guardar
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {syncMsg && (
        <div style={{ padding: "8px 14px", borderRadius: 8, marginBottom: 14, fontSize: 12, fontWeight: 600,
          whiteSpace: "pre-wrap", maxHeight: 300, overflow: "auto",
          background: syncMsg.startsWith("Error") ? "var(--redBg)" : "var(--greenBg)",
          color: syncMsg.startsWith("Error") ? "var(--red)" : "var(--green)",
          border: `1px solid ${syncMsg.startsWith("Error") ? "var(--redBd)" : "var(--greenBd)"}` }}>
          {syncMsg}
        </div>
      )}

      {/* Filter tabs */}
      <div style={{ display: "flex", gap: 0, borderBottom: "2px solid var(--bg4)", marginBottom: 16, alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", gap: 0 }}>
          {([
            { key: "todos" as typeof concFilter, label: "Registro", count: data.length, color: "var(--cyan)" },
            { key: "por_pagar" as typeof concFilter, label: "Por pagar", count: porPagarList.length, color: "var(--amber)" },
            { key: "vencidas" as typeof concFilter, label: "Vencidas", count: vencidasList.length, color: "var(--red)" },
            { key: "pagadas" as typeof concFilter, label: "Pagadas", count: totalPagadas, color: "var(--green)" },
          ]).map(t => (
            <button key={t.key} onClick={() => setConcFilter(t.key)}
              style={{
                padding: "10px 16px", fontSize: 13, fontWeight: concFilter === t.key ? 600 : 400, cursor: "pointer", background: "none", border: "none",
                borderBottom: concFilter === t.key ? `2px solid ${t.color}` : "2px solid transparent",
                color: concFilter === t.key ? "var(--txt)" : "var(--txt3)", marginBottom: -2, whiteSpace: "nowrap",
              }}>
              {t.label}
              {t.count > 0 && (
                <span style={{
                  marginLeft: 6, fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 10,
                  background: concFilter === t.key ? t.color : `color-mix(in srgb, ${t.color} 15%, transparent)`,
                  color: concFilter === t.key ? "#fff" : t.color,
                }}>{t.count}</span>
              )}
            </button>
          ))}
          {sinClasificar.length > 0 && (
            <button onClick={() => setConcFilter(concFilter === "por_clasificar" ? "todos" : "por_clasificar")}
              style={{ padding: "10px 16px", fontSize: 13, fontWeight: concFilter === "por_clasificar" ? 600 : 400, cursor: "pointer", background: "none", border: "none",
                borderBottom: concFilter === "por_clasificar" ? "2px solid var(--red)" : "2px solid transparent",
                color: concFilter === "por_clasificar" ? "var(--txt)" : "var(--txt3)", marginBottom: -2, whiteSpace: "nowrap" }}>
              Por clasificar
              <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 10,
                background: concFilter === "por_clasificar" ? "var(--red)" : "var(--redBg)",
                color: concFilter === "por_clasificar" ? "#fff" : "var(--red)" }}>{sinClasificar.length}</span>
            </button>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", paddingBottom: 6 }}>
          <button onClick={async () => {
            if (!confirm("Esto buscará facturas duplicadas (mismo folio + RUT + tipo) y eliminará las que NO tengan conciliaciones. ¿Continuar?")) return;
            const dry = await fetch("/api/admin/dedup-rcv-compras", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dryRun: true }) });
            const dryData = await dry.json();
            if (dryData.error) { alert(`Error: ${dryData.error}`); return; }
            if (!dryData.a_eliminar || dryData.a_eliminar === 0) { alert("Sin duplicados"); return; }
            if (!confirm(`Se encontraron ${dryData.grupos_con_duplicados} grupos de duplicados. Se eliminarán ${dryData.a_eliminar} registros (preservando los conciliados). ¿Confirmar?`)) return;
            const res = await fetch("/api/admin/dedup-rcv-compras", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dryRun: false }) });
            const d = await res.json();
            if (d.error) alert(`Error: ${d.error}`);
            else { alert(`${d.eliminados} duplicados eliminados`); load(); }
          }}
            style={{ fontSize: 11, padding: "6px 10px", borderRadius: 6, background: "var(--redBg)", color: "var(--red)", border: "1px solid var(--redBd)", cursor: "pointer", fontWeight: 600 }}
            title="Eliminar facturas duplicadas (preserva las conciliadas)">
            Limpiar duplicados
          </button>
          <select value={tipoFilter} onChange={e => setTipoFilter(e.target.value)}
            style={{ fontSize: 11, padding: "6px 10px", borderRadius: 6, background: tipoFilter === "todos" ? "var(--bg3)" : "var(--cyanBg)", color: tipoFilter === "todos" ? "var(--txt3)" : "var(--cyan)", border: `1px solid ${tipoFilter === "todos" ? "var(--bg4)" : "var(--cyanBd)"}`, cursor: "pointer", fontWeight: 600 }}>
            <option value="todos">Todos los tipos</option>
            <option value="33">FAC-EL Factura</option>
            <option value="34">FAC-EX Factura Exenta</option>
            <option value="46">FC Factura Compra</option>
            <option value="52">GUIA Guía Despacho</option>
            <option value="56">ND Nota Débito</option>
            <option value="61">NC Nota Crédito</option>
            <option value="71">BHE</option>
          </select>
          <button onClick={() => setShowProveedores(true)}
            style={{ fontSize: 11, padding: "6px 12px", borderRadius: 6, background: provFilterSet ? (provFilterMode === "excluir" ? "var(--redBg)" : "var(--cyanBg)") : "var(--bg3)", color: provFilterSet ? (provFilterMode === "excluir" ? "var(--red)" : "var(--cyan)") : "var(--txt3)", border: `1px solid ${provFilterSet ? (provFilterMode === "excluir" ? "var(--redBd)" : "var(--cyanBd)") : "var(--bg4)"}`, cursor: "pointer", fontWeight: 600, whiteSpace: "nowrap" }}>
            {provFilterSet ? `${provFilterMode === "excluir" ? "Excluye" : "Solo"} ${provFilterSet.size} prov.` : "Filtrar proveedores"}
          </button>
          {provFilterSet && (
            <button onClick={() => { setProvFilterSet(null); setProvFilterMode("incluir"); }}
              style={{ fontSize: 11, padding: "6px 8px", borderRadius: 6, background: "var(--bg3)", color: "var(--txt3)", border: "1px solid var(--bg4)", cursor: "pointer" }}
              title="Limpiar filtro">×</button>
          )}
          <input className="form-input" placeholder="Buscar..." value={filter} onChange={e => setFilter(e.target.value)}
            style={{ fontSize: 12, width: 160, padding: "6px 12px" }} />
        </div>
      </div>

      {data.length === 0 ? (
        <div className="card" style={{ padding: 40, textAlign: "center" }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>📄</div>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Sin compras para este periodo</div>
          <div style={{ fontSize: 12, color: "var(--txt3)", marginBottom: 16 }}>Importa los datos directamente desde el SII</div>
          <button onClick={handleSyncSii} disabled={syncing}
            style={{ padding: "10px 24px", borderRadius: 10, background: "var(--cyan)", color: "#fff", fontWeight: 700, fontSize: 13, border: "none", cursor: syncing ? "not-allowed" : "pointer", opacity: syncing ? 0.6 : 1 }}>
            {syncing ? "Importando..." : "Importar desde SII"}
          </button>
        </div>
      ) : (
        <div className="card" style={{ overflow: "hidden", padding: 0 }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "2px solid var(--bg4)" }}>
                  <th style={{ padding: "12px 14px", textAlign: "left", fontWeight: 600, fontSize: 12, color: "var(--cyan)" }}>Folio</th>
                  <th style={{ padding: "12px 14px", textAlign: "left", fontWeight: 600, fontSize: 12, color: "var(--txt3)" }}>Clasificaci&oacute;n</th>
                  <th style={{ padding: "12px 14px", textAlign: "left", fontWeight: 600, fontSize: 12, color: "var(--cyan)" }}>Raz&oacute;n Social</th>
                  <th style={{ padding: "12px 14px", textAlign: "left", fontWeight: 600, fontSize: 12, color: "var(--txt3)" }}>Fecha Emisi&oacute;n</th>
                  <th style={{ padding: "12px 14px", textAlign: "left", fontWeight: 600, fontSize: 12, color: "var(--cyan)" }}>Pago Est.</th>
                  <th style={{ padding: "12px 14px", textAlign: "left", fontWeight: 600, fontSize: 12, color: "var(--txt3)" }}>Per&iacute;odo SII</th>
                  <th style={{ padding: "12px 14px", textAlign: "right", fontWeight: 600, fontSize: 12, color: "var(--cyan)" }}>Monto Total</th>
                  <th style={{ padding: "12px 14px", textAlign: "right", fontWeight: 600, fontSize: 12, color: "var(--txt3)" }}></th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr><td colSpan={8} style={{ textAlign: "center", padding: 32, color: "var(--txt3)" }}>Sin resultados</td></tr>
                ) : filtered.map((c, i) => {
                  const venc = getVencimiento(c);
                  const isConciliada = concCompraIds.has(c.id!);
                  const clasificacion = getClasificacion(c);
                  const tipoAbrev = TIPO_DOC_ABREV[c.tipo_doc] || TIPO_DOC_NAMES[c.tipo_doc]?.slice(0, 3).toUpperCase() || "DOC";
                  const periodoDoc = c.fecha_docto ? c.fecha_docto.slice(0, 7) : "";

                  return (
                    <tr key={c.id || i} style={{ borderBottom: "1px solid var(--bg4)" }}>
                      {/* Folio badge */}
                      <td style={{ padding: "14px 14px", whiteSpace: "nowrap" }}>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                          <span className="mono" style={{ fontSize: 11, fontWeight: 700, padding: "4px 10px", borderRadius: 6, background: "var(--cyan)", color: "#fff" }}>
                            {tipoAbrev}-EL
                          </span>
                          <span className="mono" style={{ fontWeight: 700, fontSize: 13 }}>{c.nro_doc || "\u2014"}</span>
                        </span>
                      </td>
                      {/* Clasificacion */}
                      <td style={{ padding: "14px 14px" }}>
                        {clasificacion ? (
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                            <span style={{ fontSize: 11, fontWeight: 600, padding: "3px 8px", borderRadius: 6, background: "var(--cyanBg)", color: "var(--cyan)" }}>{periodoDoc}</span>
                            <span style={{ fontSize: 10, color: "var(--txt2)" }}>{clasificacion}</span>
                          </span>
                        ) : (
                          <span onClick={() => { setClasificarItem(c); setClasificarCuenta(""); setClasificarBusca(""); }}
                            style={{ fontSize: 11, fontWeight: 600, padding: "3px 8px", borderRadius: 6, background: "var(--redBg)", color: "var(--red)", cursor: "pointer" }}>
                            Sin clasificar
                          </span>
                        )}
                      </td>
                      {/* Razon Social + RUT + Comentario */}
                      <td style={{ padding: "14px 14px", maxWidth: 260, position: "relative" }}>
                        <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontWeight: 500, color: "var(--cyan)", fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.razon_social || "\u2014"}</div>
                            <div className="mono" style={{ fontSize: 10, color: "var(--txt3)", marginTop: 2 }}>{fmtRut(c.rut_proveedor)}</div>
                            {(() => {
                              if (c.tipo_doc === 61) {
                                const fac = facturaPorNc.get(c.id!);
                                if (fac) return (
                                  <div style={{ fontSize: 9, color: "var(--amber)", marginTop: 3, fontWeight: 600 }}>
                                    &larr; FAC {fac.nro_doc} &middot; {fmtMoney(fac.monto_total || 0)}
                                  </div>
                                );
                                if (c.factura_ref_folio) return (
                                  <div style={{ fontSize: 9, color: "var(--txt3)", marginTop: 3 }}>
                                    &larr; ref FAC {c.factura_ref_folio} (no encontrada)
                                  </div>
                                );
                              } else {
                                const ncs = ncsPorFactura.get(c.id!) || [];
                                if (ncs.length > 0) {
                                  const totalNC = ncs.reduce((s, n) => s + (n.monto_total || 0), 0);
                                  return (
                                    <div style={{ fontSize: 9, color: "var(--amber)", marginTop: 3, fontWeight: 600 }}>
                                      &larr; {ncs.length} NC asociada{ncs.length > 1 ? "s" : ""} &middot; -{fmtMoney(totalNC)}
                                    </div>
                                  );
                                }
                              }
                              return null;
                            })()}
                          </div>
                          <span onClick={() => { setEditingNota(c.id!); setNotaText(c.notas || ""); }}
                            title={c.notas || "Agregar comentario"}
                            style={{ width: 24, height: 24, borderRadius: 5, background: c.notas ? "var(--cyanBg)" : "var(--bg3)", border: `1px solid ${c.notas ? "var(--cyanBd)" : "var(--bg4)"}`, display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer", fontSize: 11, color: c.notas ? "var(--cyan)" : "var(--txt3)", flexShrink: 0 }}>
                            &#9776;
                          </span>
                        </div>
                        {c.notas && <div style={{ fontSize: 10, color: "var(--cyan)", marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.notas}</div>}
                        {editingNota === c.id && (
                          <div style={{ position: "absolute", left: 12, top: "100%", marginTop: 4, zIndex: 50, background: "var(--bg2)", border: "1px solid var(--bg4)", borderRadius: 8, padding: 12, boxShadow: "0 8px 24px rgba(0,0,0,0.4)", width: 260 }}
                            onClick={e => e.stopPropagation()}>
                            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--txt3)", marginBottom: 6 }}>Comentario</div>
                            <textarea value={notaText} onChange={e => setNotaText(e.target.value)} autoFocus placeholder="Agregar un comentario..."
                              style={{ width: "100%", padding: "8px 10px", fontSize: 12, borderRadius: 6, border: "1px solid var(--bg4)", background: "var(--bg3)", color: "var(--txt)", resize: "vertical", minHeight: 60 }} />
                            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", marginTop: 8 }}>
                              <button onClick={() => setEditingNota(null)}
                                style={{ padding: "4px 12px", borderRadius: 6, fontSize: 11, background: "var(--bg3)", color: "var(--txt3)", border: "1px solid var(--bg4)", cursor: "pointer" }}>Cancelar</button>
                              <button onClick={() => { updateRcvCompra(c.id!, { notas: notaText.trim() || null }); setData(prev => prev.map(x => x.id === c.id ? { ...x, notas: notaText.trim() || null } : x)); setEditingNota(null); }}
                                style={{ padding: "4px 12px", borderRadius: 6, fontSize: 11, fontWeight: 600, background: "var(--cyan)", color: "#fff", border: "none", cursor: "pointer" }}>Guardar</button>
                            </div>
                          </div>
                        )}
                      </td>
                      {/* Fecha Emision */}
                      <td className="mono" style={{ padding: "14px 14px", fontSize: 12 }}>{fmtDate(c.fecha_docto)}</td>
                      {/* Pago Estimado */}
                      <td style={{ padding: "14px 14px" }}>
                        {venc ? (
                          <div>
                            <div className="mono" style={{ fontSize: 12 }}>{fmtDate(venc.fecha)}</div>
                            {!isConciliada && (
                              <div style={{ fontSize: 10, marginTop: 2, color: venc.diasRestantes < 0 ? "var(--red)" : "var(--green)", fontWeight: 600 }}>
                                {venc.diasRestantes < 0 ? `Vencida ${Math.abs(venc.diasRestantes)}d` : venc.diasRestantes === 0 ? "Hoy" : `En ${venc.diasRestantes} d\u00edas`}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span style={{ fontSize: 11, color: "var(--txt3)" }}>\u2014</span>
                        )}
                      </td>
                      {/* Periodo SII */}
                      <td className="mono" style={{ padding: "14px 14px", fontSize: 12 }}>{periodoDoc}</td>
                      {/* Monto Total */}
                      <td style={{ padding: "14px 14px", textAlign: "right" }}>
                        <div className="mono" style={{ fontSize: 14, fontWeight: 700 }}>{fmtMoney(c.monto_total || 0)}</div>
                        <div style={{ fontSize: 10, color: "var(--txt3)", marginTop: 1 }}>Incluye IVA</div>
                      </td>
                      {/* Estado / Accion */}
                      <td style={{ padding: "14px 14px", textAlign: "right", whiteSpace: "nowrap", position: "relative" }}>
                        {(() => {
                        const montoAplicado = montoAplicadoPorCompra.get(c.id!) || 0;
                        const saldoRestante = (c.monto_total || 0) - montoAplicado;
                        const isParcial = montoAplicado > 0 && !isConciliada;
                        return (
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                          <span style={{ fontSize: 10, color: isParcial ? "var(--amber)" : "var(--txt3)" }}>
                            {isConciliada ? fmtMoney(c.monto_total || 0) : isParcial ? `${fmtMoney(saldoRestante)} por pagar` : `${fmtMoney(c.monto_total || 0)} por pagar`}
                          </span>
                          {isParcial && (
                            <span style={{ fontSize: 9, fontWeight: 600, color: "var(--amber)" }}>
                              Parcial {fmtMoney(montoAplicado)}/{fmtMoney(c.monto_total || 0)}
                            </span>
                          )}
                          {(() => {
                            const anul = anulacionByCompra.get(c.id!);
                            // NCs aplicadas (tipo_doc=61): siempre mostrar "NC aplicada" si la NC fue consumida
                            if (anul && c.tipo_doc === 61) {
                              return (
                                <span title="NC aplicada"
                                  style={{ fontSize: 11, fontWeight: 600, padding: "4px 12px", borderRadius: 6, background: "var(--amberBg)", color: "var(--amber)", cursor: "default" }}>
                                  NC aplicada
                                </span>
                              );
                            }
                            // Facturas: "Anulada" SOLO si está totalmente cubierta y NO hay pago bancario
                            // Si tiene pago bancario + NC = "Pagado" (mixto)
                            if (anul && isConciliada) {
                              const tieneBanco = conciliaciones.some(x =>
                                x.estado === "confirmado" &&
                                x.rcv_compra_id === c.id &&
                                x.movimiento_banco_id
                              );
                              if (!tieneBanco) {
                                return (
                                  <span title="Anulada (cubierta por NC sin pago bancario)"
                                    style={{ fontSize: 11, fontWeight: 600, padding: "4px 12px", borderRadius: 6, background: "var(--amberBg)", color: "var(--amber)", cursor: "default" }}>
                                    Anulada
                                  </span>
                                );
                              }
                            }
                            if (isConciliada) {
                              return (
                                <span onClick={async () => {
                                  if (detalleConc === c.id) { setDetalleConc(null); return; }
                                  setDetalleConc(c.id!); setDetalleMov(null); setDetalleLoading(true);
                                  const conc = conciliaciones.find(x => x.estado === "confirmado" && x.rcv_compra_id === c.id);
                                  if (conc?.movimiento_banco_id) {
                                    const movs = await fetchMovimientosBanco(empresa.id!, { desde: undefined, hasta: undefined });
                                    setDetalleMov(movs.find(m => m.id === conc.movimiento_banco_id) || null);
                                  }
                                  setDetalleLoading(false);
                                }}
                                  style={{ fontSize: 11, fontWeight: 600, padding: "4px 12px", borderRadius: 6, background: "var(--greenBg)", color: "var(--green)", cursor: "pointer" }}
                                  title="Ver detalle">
                                  Pagado
                                </span>
                              );
                            }
                            return (
                              <span onClick={async () => {
                                setPagoItem(c); setPagoLoading(true); setPagoSearch(""); setPagoSelected([]); setPagoNCs(new Set());
                                const movs = await fetchMovimientosBanco(empresa.id!, { desde: undefined, hasta: undefined });
                                setMovsBanco(movs.filter(m => m.monto < 0 && isMovReal(m) && m.estado_conciliacion !== "conciliado" && m.estado_conciliacion !== "ignorado"));
                                setPagoLoading(false);
                              }}
                                style={{ fontSize: 11, fontWeight: 600, padding: "5px 12px", borderRadius: 6, background: isParcial ? "var(--amber)" : "var(--cyan)", color: "#fff", cursor: "pointer" }}>
                                {isParcial ? "Pagar saldo" : "Asignar Pago"}
                              </span>
                            );
                          })()}
                        </div>
                        );
                        })()}
                        {/* Popover detalle conciliacion */}
                        {detalleConc === c.id && (
                          <div style={{ position: "absolute", right: 0, top: "100%", marginTop: 4, zIndex: 50, background: "var(--bg2)", border: "1px solid var(--bg4)", borderRadius: 10, padding: 16, boxShadow: "0 8px 24px rgba(0,0,0,0.12)", width: 380 }}>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                              <span style={{ fontSize: 13, fontWeight: 600 }}>Ver detalle</span>
                              <button onClick={() => setDetalleConc(null)} style={{ background: "none", border: "none", fontSize: 16, cursor: "pointer", color: "var(--txt3)" }}>&times;</button>
                            </div>
                            {detalleLoading ? (
                              <div style={{ padding: 16, textAlign: "center", color: "var(--txt3)", fontSize: 12 }}>Cargando...</div>
                            ) : (
                              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                                <thead>
                                  <tr style={{ borderBottom: "1px solid var(--bg4)" }}>
                                    <th style={{ textAlign: "left", padding: "6px 8px", color: "var(--txt3)", fontWeight: 600 }}>Tipo</th>
                                    <th style={{ textAlign: "left", padding: "6px 8px", color: "var(--txt3)", fontWeight: 600 }}>Fecha</th>
                                    <th style={{ textAlign: "left", padding: "6px 8px", color: "var(--txt3)", fontWeight: 600 }}>Descripci&oacute;n</th>
                                    <th style={{ textAlign: "right", padding: "6px 8px", color: "var(--txt3)", fontWeight: 600 }}>Monto</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  <tr style={{ borderBottom: "1px solid var(--bg4)" }}>
                                    <td style={{ padding: "8px" }}><span className="mono" style={{ fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: "var(--cyan)", color: "#fff" }}>{TIPO_DOC_ABREV[c.tipo_doc] || TIPO_DOC_NAMES[c.tipo_doc]?.slice(0, 3).toUpperCase() || "DOC"}-EL</span> <span className="mono" style={{ fontWeight: 600 }}>{c.nro_doc}</span></td>
                                    <td className="mono" style={{ padding: "8px", fontSize: 11 }}>{fmtDate(c.fecha_docto)}</td>
                                    <td style={{ padding: "8px", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.razon_social}</td>
                                    <td className="mono" style={{ padding: "8px", textAlign: "right", fontWeight: 700 }}>{fmtMoney(c.monto_total || 0)}</td>
                                  </tr>
                                  {detalleMov && (() => {
                                    const fechaFac = c.fecha_docto || "";
                                    const fechaMov = detalleMov.fecha || "";
                                    const mismaFecha = fechaFac === fechaMov;
                                    const montoFac = c.monto_total || 0;
                                    const montoMov = Math.abs(detalleMov.monto);
                                    const mismoMonto = montoFac === montoMov;
                                    return (
                                      <tr style={{ borderBottom: "1px solid var(--bg4)" }}>
                                        <td style={{ padding: "8px" }}><span style={{ fontSize: 10, fontWeight: 600, padding: "2px 6px", borderRadius: 4, background: "var(--cyanBg)", color: "var(--cyan)" }}>Mov. bancario &bull; CC</span></td>
                                        <td className="mono" style={{ padding: "8px", fontSize: 11, color: mismaFecha ? "var(--green)" : "var(--amber)" }}>{fmtDate(fechaMov)}{!mismaFecha && <span style={{ fontSize: 9, display: "block", color: "var(--amber)" }}>{Math.abs(Math.round((new Date(fechaFac + "T12:00:00").getTime() - new Date(fechaMov + "T12:00:00").getTime()) / 86400000))}d dif</span>}</td>
                                        <td style={{ padding: "8px", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--cyan)" }}>{detalleMov.descripcion}</td>
                                        <td className="mono" style={{ padding: "8px", textAlign: "right", fontWeight: 700, color: mismoMonto ? "var(--green)" : "var(--red)" }}>{fmtMoney(montoMov)}{!mismoMonto && <span style={{ fontSize: 9, display: "block", color: "var(--amber)" }}>dif {fmtMoney(Math.abs(montoFac - montoMov))}</span>}</td>
                                      </tr>
                                    );
                                  })()}
                                </tbody>
                                <tfoot>
                                  <tr>
                                    <td colSpan={3} style={{ padding: "8px", fontSize: 12, fontWeight: 600 }}>Saldo por pagar</td>
                                    <td className="mono" style={{ padding: "8px", textAlign: "right", fontWeight: 700 }}>$0</td>
                                  </tr>
                                </tfoot>
                              </table>
                            )}
                            <div style={{ marginTop: 12, display: "flex", justifyContent: "flex-end" }}>
                              <button onClick={async () => {
                                if (!confirm("Deshacer esta conciliacion? La factura volvera a estado pendiente.")) return;
                                const conc = conciliaciones.find(x => x.estado === "confirmado" && x.rcv_compra_id === c.id);
                                if (conc?.id) {
                                  const { updateConciliacion, syncEstadoConciliacion } = await import("@/lib/db");
                                  await updateConciliacion(conc.id, { estado: "rechazado" });
                                  if (conc.movimiento_banco_id && detalleMov) {
                                    await syncEstadoConciliacion(conc.movimiento_banco_id, detalleMov.monto);
                                  }
                                  setDetalleConc(null);
                                  await load();
                                }
                              }}
                                style={{ padding: "6px 14px", borderRadius: 6, fontSize: 11, fontWeight: 600, background: "var(--redBg)", color: "var(--red)", border: "1px solid var(--redBd)", cursor: "pointer" }}>
                                Deshacer conciliaci&oacute;n
                              </button>
                            </div>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              {filtered.length > 0 && (
                <tfoot>
                  <tr style={{ borderTop: "2px solid var(--bg4)", fontWeight: 700 }}>
                    <td colSpan={6} style={{ padding: "12px 14px", fontSize: 13 }}>Total CLP</td>
                    <td className="mono" style={{ padding: "12px 14px", textAlign: "right", fontSize: 14 }}>
                      {fmtMoney(total)}
                    </td>
                    <td></td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      )}

      {/* Modal Asignar Pago -- multi-movimiento */}
      {pagoItem && (() => {
        const montoYaAplicado = montoAplicadoPorCompra.get(pagoItem.id!) || 0;
        const totalFacBruto = (pagoItem.monto_total || 0) - montoYaAplicado;
        const ncsDisponibles = data.filter(c =>
          c.tipo_doc === 61 &&
          c.rut_proveedor === pagoItem.rut_proveedor &&
          !usedDocIds.has(c.id!)
        );
        const ncsSelected = ncsDisponibles.filter(n => pagoNCs.has(n.id!));
        const totalNC = ncsSelected.reduce((s, n) => s + (n.monto_total || 0), 0);
        const totalFac = totalFacBruto - totalNC;
        const totalSeleccionado = pagoSelected.reduce((s, x) => s + x.monto_aplicado, 0);
        const saldoRestante = totalFac - totalSeleccionado;
        const totalCubierto = totalNC + totalSeleccionado;
        const selectedIds = new Set(pagoSelected.map(x => x.mov.id));
        const facFecha = pagoItem.fecha_docto ? new Date(pagoItem.fecha_docto + "T12:00:00").getTime() : 0;

        const handleToggleNC = (id: string) => {
          setPagoNCs(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
          });
        };

        const handleToggleMov = (m: DBMovimientoBanco) => {
          if (selectedIds.has(m.id)) {
            setPagoSelected(prev => prev.filter(x => x.mov.id !== m.id));
          } else {
            const disponible = Math.abs(m.monto) - (m.monto_conciliado || 0);
            const netTarget = totalFac - totalSeleccionado;
            const aplicar = netTarget > 0 ? Math.min(disponible, netTarget) : disponible;
            setPagoSelected(prev => [...prev, { mov: m, monto_aplicado: aplicar }]);
          }
        };

        const handleEditMonto = (movId: string, val: number) => {
          setPagoSelected(prev => prev.map(x => x.mov.id === movId ? { ...x, monto_aplicado: val } : x));
        };

        const handleGuardarPago = async () => {
          if (pagoSelected.length === 0 && ncsSelected.length === 0) return;
          setPagoSaving(true);
          try {
            const { upsertConciliacion, syncEstadoConciliacion, insertConciliacionItems } = await import("@/lib/db");
            const { getSupabase } = await import("@/lib/supabase");
            if (ncsSelected.length > 0) {
              const sb = getSupabase();
              if (!sb) throw new Error("Sin conexión a Supabase");
              const folios = ncsSelected.map(n => n.nro_doc).join(", ");
              const { data: newConc, error: concErr } = await sb.from("conciliaciones").insert({
                empresa_id: empresa.id!,
                movimiento_banco_id: null,
                rcv_compra_id: null,
                rcv_venta_id: null,
                confianza: 1,
                estado: "confirmado",
                tipo_partida: "anulacion",
                metodo: "manual",
                notas: `NC aplicada: ${folios}`,
                created_by: "admin",
                monto_aplicado: totalNC,
              }).select("id").single();
              if (concErr || !newConc) throw new Error(concErr?.message || "Error creando conciliación");
              const ncConcId = newConc.id;
              await insertConciliacionItems([
                { conciliacion_id: ncConcId, documento_tipo: "rcv_compra", documento_id: pagoItem.id!, monto_aplicado: totalNC },
                ...ncsSelected.map(n => ({ conciliacion_id: ncConcId, documento_tipo: "rcv_compra" as const, documento_id: n.id!, monto_aplicado: n.monto_total || 0 })),
              ]);
            }
            for (const sel of pagoSelected) {
              await upsertConciliacion({ empresa_id: empresa.id!, movimiento_banco_id: sel.mov.id!, rcv_compra_id: pagoItem.id!, rcv_venta_id: null, confianza: 1, estado: "confirmado", tipo_partida: pagoSelected.length === 1 && ncsSelected.length === 0 ? "match" : "multi_pago", metodo: "manual", notas: null, created_by: "admin", monto_aplicado: sel.monto_aplicado });
              await syncEstadoConciliacion(sel.mov.id!, sel.mov.monto);
            }
            await load();
            setPagoItem(null);
          } catch (err) { console.error(err); }
          setPagoSaving(false);
        };

        return (
        <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={() => !pagoSaving && setPagoItem(null)}>
          <div onClick={e => e.stopPropagation()} style={{ background: "var(--bg2)", borderRadius: 12, width: "100%", maxWidth: 750, maxHeight: "90vh", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 20px 60px rgba(0,0,0,0.15)" }}>
            <div style={{ padding: "20px 28px", background: "var(--cyan)", color: "#fff", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 18, fontWeight: 700 }}>Asignar Pago</span>
              <button onClick={() => setPagoItem(null)} disabled={pagoSaving} style={{ background: "none", border: "none", color: "#fff", fontSize: 22, cursor: "pointer", lineHeight: 1 }}>&times;</button>
            </div>
            {/* Info factura + barra progreso */}
            <div style={{ padding: "16px 28px", borderBottom: "1px solid var(--bg4)" }}>
              <div style={{ fontSize: 13, marginBottom: 4 }}>
                <strong>{TIPO_DOC_NAMES[pagoItem.tipo_doc] || pagoItem.tipo_doc}</strong> N&deg; {pagoItem.nro_doc} &mdash; {pagoItem.razon_social} &mdash; {fmtDate(pagoItem.fecha_docto)}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 8 }}>
                <div className="mono" style={{ fontSize: 18, fontWeight: 800, color: "var(--red)" }}>{fmtMoney(totalFacBruto)}</div>
                {totalNC > 0 && (
                  <>
                    <span className="mono" style={{ fontSize: 14, color: "var(--amber)", fontWeight: 700 }}>- {fmtMoney(totalNC)} NC</span>
                    <span className="mono" style={{ fontSize: 14, color: "var(--txt3)" }}>=</span>
                    <span className="mono" style={{ fontSize: 16, fontWeight: 800, color: "var(--cyan)" }}>{fmtMoney(totalFac)}</span>
                  </>
                )}
                <div style={{ flex: 1, height: 6, background: "var(--bg4)", borderRadius: 3, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${Math.min(100, totalFacBruto > 0 ? (totalCubierto / totalFacBruto) * 100 : 0)}%`, background: saldoRestante <= 0 ? "var(--green)" : "var(--amber)", borderRadius: 3, transition: "width 0.2s" }} />
                </div>
                <div className="mono" style={{ fontSize: 12, fontWeight: 700, color: saldoRestante <= 0 ? "var(--green)" : "var(--amber)", whiteSpace: "nowrap" }}>
                  {saldoRestante <= 0 ? "Cubierto" : `Faltan ${fmtMoney(saldoRestante)}`}
                </div>
              </div>
            </div>
            {/* Notas de Crédito del proveedor */}
            {ncsDisponibles.length > 0 && (() => {
              const ncsOrdenadas = [...ncsDisponibles].sort((a, b) => {
                const aLink = a.factura_ref_id === pagoItem.id ? 0 : 1;
                const bLink = b.factura_ref_id === pagoItem.id ? 0 : 1;
                return aLink - bLink;
              });
              return (
              <div style={{ padding: "8px 28px", borderBottom: "1px solid var(--bg4)", background: ncsSelected.length > 0 ? "var(--amberBg)" : "var(--bg3)" }}>
                <div style={{ fontSize: 10, fontWeight: 600, color: "var(--amber)", marginBottom: 4 }}>Notas de Cr&eacute;dito disponibles ({ncsDisponibles.length})</div>
                {ncsOrdenadas.map(nc => {
                  const sel = pagoNCs.has(nc.id!);
                  const asociada = nc.factura_ref_id === pagoItem.id;
                  return (
                    <label key={nc.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", cursor: "pointer", borderBottom: "1px solid var(--bg4)" }}>
                      <input type="checkbox" checked={sel} onChange={() => handleToggleNC(nc.id!)} style={{ accentColor: "var(--amber)" }} />
                      <span style={{ flex: 1, fontSize: 11 }}>
                        <span className="mono" style={{ fontWeight: 700, fontSize: 10, padding: "1px 5px", borderRadius: 3, background: asociada ? "var(--amber)" : "var(--amberBg)", color: asociada ? "#fff" : "var(--amber)", marginRight: 4 }}>NC</span>
                        N&deg; {nc.nro_doc} &mdash; {fmtDate(nc.fecha_docto)}
                        {asociada && <span style={{ fontSize: 9, marginLeft: 6, padding: "1px 6px", borderRadius: 3, background: "var(--amber)", color: "#fff", fontWeight: 700 }}>&larr; ASOCIADA A ESTA FACTURA</span>}
                      </span>
                      <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: "var(--amber)" }}>-{fmtMoney(nc.monto_total || 0)}</span>
                    </label>
                  );
                })}
              </div>
              );
            })()}
            {/* Movimientos seleccionados */}
            {pagoSelected.length > 0 && (
              <div style={{ padding: "8px 28px", borderBottom: "1px solid var(--bg4)", background: "var(--bg3)" }}>
                <div style={{ fontSize: 10, fontWeight: 600, color: "var(--txt3)", marginBottom: 4 }}>Movimientos seleccionados ({pagoSelected.length})</div>
                {pagoSelected.map(sel => (
                  <div key={sel.mov.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", borderBottom: "1px solid var(--bg4)" }}>
                    <div style={{ flex: 1, fontSize: 11 }}>
                      {sel.mov.descripcion || "--"} <span style={{ color: "var(--txt3)" }}>{sel.mov.fecha}</span>
                    </div>
                    <span style={{ fontSize: 10, color: "var(--txt3)" }}>$</span>
                    <input type="text" value={sel.monto_aplicado.toLocaleString("es-CL")}
                      onChange={e => handleEditMonto(sel.mov.id!, parseInt(e.target.value.replace(/\D/g, "")) || 0)}
                      className="mono" style={{ width: 90, padding: "3px 6px", fontSize: 12, fontWeight: 700, textAlign: "right", background: "var(--bg2)", color: "var(--txt)", border: "1px solid var(--bg4)", borderRadius: 4 }} />
                    <button onClick={() => setPagoSelected(prev => prev.filter(x => x.mov.id !== sel.mov.id))}
                      style={{ background: "none", border: "none", color: "var(--red)", fontSize: 14, cursor: "pointer" }}>x</button>
                  </div>
                ))}
              </div>
            )}
            <div style={{ padding: "12px 28px", borderBottom: "1px solid var(--bg4)" }}>
              <input placeholder="Buscar movimiento bancario..." value={pagoSearch} onChange={e => setPagoSearch(e.target.value)}
                style={{ width: "100%", padding: "8px 12px", borderRadius: 8, border: "1px solid var(--bg4)", background: "var(--bg2)", color: "var(--txt)", fontSize: 12 }} />
            </div>
            <div style={{ flex: 1, overflow: "auto", maxHeight: 350 }}>
              {pagoLoading ? (
                <div style={{ padding: 40, textAlign: "center", color: "var(--txt3)" }}>Cargando movimientos...</div>
              ) : (() => {
                const q = pagoSearch.toLowerCase();
                const target = saldoRestante > 0 ? saldoRestante : totalFac;
                const filtrados = movsBanco.filter(m => !selectedIds.has(m.id) && (!pagoSearch || (m.descripcion || "").toLowerCase().includes(q) || (m.banco || "").toLowerCase().includes(q) || String(Math.abs(m.monto)).includes(q)));
                const provName = (pagoItem.razon_social || "").toLowerCase();
                const provWords = provName.split(/\s+/).filter(w => w.length > 3);
                const scoreMov = (m: DBMovimientoBanco) => {
                  const montoPct = target > 0 ? Math.abs(Math.abs(m.monto) - target) / target : 1;
                  const montoScore = montoPct < 0.01 ? 0 : montoPct < 0.05 ? 0.1 + montoPct : 0.3 + montoPct;
                  const desc = (m.descripcion || "").toLowerCase();
                  const isMP = m.banco === "MercadoPago" || desc.startsWith("retiro mp");
                  const provMatch = isMP ? 0 : (provWords.some(w => desc.includes(w)) ? 0 : 1);
                  let fechaScore = 1;
                  if (facFecha && m.fecha) {
                    const dias = (new Date(m.fecha + "T12:00:00").getTime() - facFecha) / 86400000;
                    fechaScore = dias < 0 ? 3 : Math.min(dias / 60, 3);
                  }
                  return isMP
                    ? montoScore * 0.75 + Math.min(fechaScore, 3) * 0.25
                    : montoScore * 0.70 + Math.min(fechaScore, 3) * 0.20 + provMatch * 0.10;
                };
                const sorted = filtrados.sort((a, b) => scoreMov(a) - scoreMov(b));
                if (sorted.length === 0) return <div style={{ padding: 40, textAlign: "center", color: "var(--txt3)" }}>No hay movimientos bancarios pendientes</div>;
                return sorted.slice(0, 50).map(m => {
                  const montoAbs = Math.abs(m.monto);
                  const coincide = montoAbs === target;
                  const montoDiff = Math.abs(montoAbs - target);
                  const diasDiff = facFecha && m.fecha ? Math.round((new Date(m.fecha + "T12:00:00").getTime() - facFecha) / 86400000) : null;
                  return (
                    <div key={m.id} onClick={() => handleToggleMov(m)}
                      style={{ padding: "14px 28px", borderBottom: "1px solid var(--bg4)", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", background: coincide ? "var(--greenBg)" : "transparent" }}
                      onMouseOver={e => { if (!coincide) e.currentTarget.style.background = "var(--bg3)"; }}
                      onMouseOut={e => { if (!coincide) e.currentTarget.style.background = "transparent"; }}>
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 500 }}>{m.descripcion || "Sin descripcion"}</div>
                        <div style={{ fontSize: 11, color: "var(--txt3)", marginTop: 2 }}>
                          {fmtDate(m.fecha)} &middot; {m.banco || "Banco"}
                          {diasDiff !== null && <span className="mono" style={{ marginLeft: 8, fontSize: 10, color: diasDiff < 0 ? "var(--red)" : diasDiff <= 45 ? "var(--green)" : "var(--amber)" }}>{diasDiff}d {diasDiff < 0 ? "antes" : "despues"}</span>}
                        </div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div className="mono" style={{ fontSize: 14, fontWeight: 700, color: "var(--red)" }}>{fmtMoney(montoAbs)}</div>
                        {coincide ? <div style={{ fontSize: 10, color: "var(--green)", fontWeight: 600 }}>Coincide exacto</div>
                          : montoDiff > 0 && <div className="mono" style={{ fontSize: 10, color: "var(--amber)" }}>diff {fmtMoney(montoDiff)}</div>}
                      </div>
                    </div>
                  );
                });
              })()}
            </div>
            <div style={{ padding: "12px 28px", borderTop: "1px solid var(--bg4)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div className="mono" style={{ fontSize: 12, color: "var(--txt3)" }}>
                {(pagoSelected.length > 0 || ncsSelected.length > 0) && (
                  <>
                    {ncsSelected.length > 0 && <span style={{ color: "var(--amber)" }}>{ncsSelected.length} NC = -{fmtMoney(totalNC)}</span>}
                    {ncsSelected.length > 0 && pagoSelected.length > 0 && " + "}
                    {pagoSelected.length > 0 && <span>{pagoSelected.length} mov. = {fmtMoney(totalSeleccionado)}</span>}
                  </>
                )}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => setPagoItem(null)} disabled={pagoSaving}
                  style={{ padding: "10px 24px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", background: "var(--bg2)", color: "var(--txt2)", border: "1px solid var(--bg4)" }}>Cerrar</button>
                <button onClick={handleGuardarPago} disabled={(pagoSelected.length === 0 && ncsSelected.length === 0) || pagoSaving}
                  className="scan-btn green" style={{ padding: "10px 24px", fontSize: 13, opacity: (pagoSelected.length === 0 && ncsSelected.length === 0) ? 0.5 : 1 }}>
                  {pagoSaving ? "Guardando..." : "Guardar"}
                </button>
              </div>
            </div>
          </div>
        </div>
        );
      })()}

      {/* Modal filtro proveedores */}
      {showProveedores && (() => {
        const selected = provFilterSet || new Set<string>();
        return (
          <div style={{ position: "fixed", inset: 0, zIndex: 9998, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center" }}
            onClick={() => setShowProveedores(false)}>
            <div className="card" style={{ padding: 0, maxWidth: 560, width: "92%", maxHeight: "85vh", display: "flex", flexDirection: "column", overflow: "hidden" }} onClick={e => e.stopPropagation()}>
              <div style={{ padding: "16px 24px", borderBottom: "1px solid var(--bg4)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <h3 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>Filtrar proveedores</h3>
                <button onClick={() => setShowProveedores(false)} style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", color: "var(--txt3)" }}>&times;</button>
              </div>
              <div style={{ padding: "12px 24px", borderBottom: "1px solid var(--bg4)", display: "flex", gap: 8 }}>
                <button onClick={() => setProvFilterMode("incluir")}
                  style={{ flex: 1, padding: "8px 12px", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", background: provFilterMode === "incluir" ? "var(--cyanBg)" : "var(--bg3)", color: provFilterMode === "incluir" ? "var(--cyan)" : "var(--txt3)", border: `1px solid ${provFilterMode === "incluir" ? "var(--cyanBd)" : "var(--bg4)"}` }}>
                  Mostrar solo estos
                </button>
                <button onClick={() => setProvFilterMode("excluir")}
                  style={{ flex: 1, padding: "8px 12px", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", background: provFilterMode === "excluir" ? "var(--redBg)" : "var(--bg3)", color: provFilterMode === "excluir" ? "var(--red)" : "var(--txt3)", border: `1px solid ${provFilterMode === "excluir" ? "var(--redBd)" : "var(--bg4)"}` }}>
                  Excluir estos
                </button>
              </div>
              <div style={{ padding: "8px 24px", borderBottom: "1px solid var(--bg4)", display: "flex", gap: 8, alignItems: "center" }}>
                <button onClick={() => setProvFilterSet(new Set(proveedoresUnicos.map(p => p.rut)))}
                  style={{ fontSize: 10, padding: "4px 10px", borderRadius: 4, background: "var(--bg3)", color: "var(--txt2)", border: "1px solid var(--bg4)", cursor: "pointer" }}>Seleccionar todos</button>
                <button onClick={() => setProvFilterSet(new Set())}
                  style={{ fontSize: 10, padding: "4px 10px", borderRadius: 4, background: "var(--bg3)", color: "var(--txt2)", border: "1px solid var(--bg4)", cursor: "pointer" }}>Limpiar</button>
                <span style={{ fontSize: 11, color: "var(--txt3)", marginLeft: "auto" }}>{selected.size} de {proveedoresUnicos.length}</span>
              </div>
              <div style={{ flex: 1, overflowY: "auto", padding: "8px 0" }}>
                {proveedoresUnicos.map(p => (
                  <label key={p.rut} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 24px", cursor: "pointer", borderBottom: "1px solid var(--bg4)" }}>
                    <input type="checkbox" checked={selected.has(p.rut)} onChange={e => {
                      const next = new Set(selected);
                      if (e.target.checked) next.add(p.rut); else next.delete(p.rut);
                      setProvFilterSet(next);
                    }} style={{ accentColor: "var(--cyan)" }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.razon_social || p.rut}</div>
                      <div className="mono" style={{ fontSize: 10, color: "var(--txt3)" }}>{p.rut} · {p.facturas} {p.facturas === 1 ? "factura" : "facturas"}</div>
                    </div>
                    <div className="mono" style={{ fontSize: 11, color: "var(--txt3)" }}>{fmtMoney(p.total)}</div>
                  </label>
                ))}
              </div>
              <div style={{ padding: "12px 24px", borderTop: "1px solid var(--bg4)", display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button onClick={() => { setProvFilterSet(null); setProvFilterMode("incluir"); setShowProveedores(false); }}
                  style={{ padding: "8px 16px", borderRadius: 8, background: "var(--bg3)", color: "var(--txt)", fontSize: 12, border: "1px solid var(--bg4)", cursor: "pointer" }}>
                  Limpiar filtro
                </button>
                <button onClick={() => setShowProveedores(false)}
                  className="scan-btn green" style={{ padding: "8px 20px", fontSize: 12 }}>
                  Aplicar
                </button>
              </div>
            </div>
          </div>
        );
      })()}
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
  const [ocultarInternos, setOcultarInternos] = useState(true);
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
    if (ocultarInternos && !isMovReal(m)) return false;
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
            <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: "var(--txt3)", cursor: "pointer", whiteSpace: "nowrap" }}>
              <input type="checkbox" checked={ocultarInternos} onChange={e => setOcultarInternos(e.target.checked)} style={{ accentColor: "var(--cyan)" }} />
              Ocultar internos MP
            </label>
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
type TabKey = "dash" | "compras" | "ventas" | "banco" | "conciliacion" | "cuentas" | "reglas" | "resultados" | "flujo" | "proyectado" | "presupuesto" | "gastos" | "honorarios" | "remuneraciones" | "impuestos" | "proveedores";

// ==================== BOLETAS DE HONORARIOS ====================
function TabHonorarios({ empresa, periodo }: { empresa: DBEmpresa; periodo: string }) {
  const siiCreds = useSiiCreds();
  const [data, setData] = useState<DBRcvCompra[]>([]);
  const [conciliaciones, setConciliaciones] = useState<DBConciliacion[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [concFilter, setConcFilter] = useState<"todos" | "pendiente" | "conciliada">("todos");
  const [searchBhe, setSearchBhe] = useState("");
  const [pagoItem, setPagoItem] = useState<DBRcvCompra | null>(null);
  const [movsBanco, setMovsBanco] = useState<DBMovimientoBanco[]>([]);
  const [pagoLoading, setPagoLoading] = useState(false);
  const [pagoSaving, setPagoSaving] = useState(false);
  const [pagoSearch, setPagoSearch] = useState("");
  const [detalleConc, setDetalleConc] = useState<string | null>(null);
  const [detalleMovs, setDetalleMovs] = useState<{ conc: DBConciliacion; mov: DBMovimientoBanco | null }[]>([]);
  const [detalleLoading, setDetalleLoading] = useState(false);
  const [detallePos, setDetallePos] = useState({ top: 0, left: 0 });

  const openDetalle = async (compraId: string, e: React.MouseEvent) => {
    if (detalleConc === compraId) { setDetalleConc(null); return; }
    const rect = (e.target as HTMLElement).getBoundingClientRect();
    setDetallePos({ top: rect.bottom + 4, left: Math.min(rect.left, window.innerWidth - 360) });
    setDetalleConc(compraId); setDetalleMovs([]); setDetalleLoading(true);
    const concs = conciliaciones.filter(x => x.estado === "confirmado" && x.rcv_compra_id === compraId);
    const movIds = concs.map(c => c.movimiento_banco_id).filter(Boolean) as string[];
    let movMap = new Map<string, DBMovimientoBanco>();
    if (movIds.length > 0) {
      const movs = await fetchMovimientosBanco(empresa.id!);
      for (const m of movs) { if (movIds.includes(m.id!)) movMap.set(m.id!, m); }
    }
    setDetalleMovs(concs.map(c => ({ conc: c, mov: c.movimiento_banco_id ? movMap.get(c.movimiento_banco_id) || null : null })));
    setDetalleLoading(false);
  };

  const load = useCallback(async () => {
    if (!empresa.id) return;
    setLoading(true);
    const [d, conc] = await Promise.all([fetchRcvCompras(empresa.id, periodo), fetchConciliaciones(empresa.id)]);
    setData(d.filter(c => c.tipo_doc === 71));
    setConciliaciones(conc);
    setLoading(false);
  }, [empresa.id, periodo]);

  useEffect(() => { load(); }, [load]);

  // Generar lista de periodos mensuales: si es anual "2026" → ["202601"..."202612"], si es mensual devuelve tal cual
  const periodosMensuales = useMemo(() => {
    if (periodo.length === 6) return [periodo];
    const y = parseInt(periodo);
    const now = new Date();
    const maxMonth = y === now.getFullYear() ? now.getMonth() + 1 : 12;
    return Array.from({ length: maxMonth }, (_, i) => `${y}${String(i + 1).padStart(2, "0")}`);
  }, [periodo]);

  const handleSync = async () => {
    setSyncing(true);
    setSyncMsg(null);
    try {
      let totalReg = 0;
      const errores: string[] = [];
      for (let i = 0; i < periodosMensuales.length; i++) {
        const p = periodosMensuales[i];
        if (periodosMensuales.length > 1) setSyncMsg(`Importando ${p.slice(4)}/${p.slice(0, 4)}... (${i + 1}/${periodosMensuales.length})`);
        try {
          const res = await fetch("/api/sii/bhe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ periodo: p, rut: siiCreds.creds.rut || undefined, clave: siiCreds.creds.clave || undefined }),
          });
          const d = await res.json();
          if (d.error) { errores.push(`${p}: ${d.error.slice(0, 60)}`); }
          else totalReg += d.registros || 0;
        } catch { errores.push(`${p}: timeout`); }
      }
      const msg = `${totalReg} boletas importadas`;
      setSyncMsg(errores.length > 0 ? `${msg} (${errores.length} meses con error)` : msg);
      if (totalReg > 0) load();
    } catch (e) {
      setSyncMsg(`Error: ${e instanceof Error ? e.message : "sin detalles"}`);
    } finally {
      setSyncing(false);
    }
  };

  // Monto conciliado acumulado por compra
  const concPorCompra = new Map<string, number>();
  for (const c of conciliaciones) {
    if (c.estado === "confirmado" && c.rcv_compra_id) {
      concPorCompra.set(c.rcv_compra_id, (concPorCompra.get(c.rcv_compra_id) || 0) + (c.monto_aplicado || 0));
    }
  }
  const isConciliada = (c: DBRcvCompra) => {
    const yaConc = concPorCompra.get(c.id!) || 0;
    return yaConc >= (c.monto_total || 0);
  };
  const isParcial = (c: DBRcvCompra) => {
    const yaConc = concPorCompra.get(c.id!) || 0;
    return yaConc > 0 && yaConc < (c.monto_total || 0);
  };
  const concCompraIds = new Set(concPorCompra.keys());
  const totalConciliadas = data.filter(c => isConciliada(c)).length;
  const totalPendientes = data.filter(c => !isConciliada(c)).length;

  const filteredByConc = concFilter === "pendiente" ? data.filter(c => !isConciliada(c))
    : concFilter === "conciliada" ? data.filter(c => isConciliada(c))
    : data;
  const filtered = searchBhe
    ? filteredByConc.filter(c => {
        const q = searchBhe.toLowerCase();
        return (c.razon_social || "").toLowerCase().includes(q) || (c.rut_proveedor || "").toLowerCase().includes(q) || String(c.nro_doc || "").includes(q);
      })
    : filteredByConc;

  const total = filtered.reduce((s, c) => s + (c.monto_neto || 0), 0);
  const totalRet = filtered.reduce((s, c) => s + (c.monto_iva || 0), 0);
  const totalLiq = filtered.reduce((s, c) => s + (c.monto_total || 0), 0);

  if (loading) return <div style={{ textAlign: "center", padding: 40, color: "var(--txt3)" }}>Cargando...</div>;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Boletas de Honorarios</h2>
          <div style={{ fontSize: 12, color: "var(--txt3)", marginTop: 2 }}>{formatPeriodo(periodo)} · {data.length} boletas</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={handleSync} disabled={syncing}
            style={{ padding: "8px 16px", borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: syncing ? "wait" : "pointer", background: syncing ? "var(--bg4)" : "var(--cyan)", color: syncing ? "var(--txt3)" : "#fff", border: "none" }}>
            {syncing ? "Importando..." : "Importar BTE emitidas"}
          </button>
          <button onClick={async () => {
            setSyncing(true); setSyncMsg(null);
            try {
              let totalReg = 0;
              const errores: string[] = [];
              for (let i = 0; i < periodosMensuales.length; i++) {
                const p = periodosMensuales[i];
                if (periodosMensuales.length > 1) setSyncMsg(`Importando ${p.slice(4)}/${p.slice(0, 4)}... (${i + 1}/${periodosMensuales.length})`);
                try {
                  const res = await fetch(`/api/sii/bhe-rec`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ periodo: p }) });
                  const d = await res.json();
                  if (d.error) { errores.push(`${p}: ${d.error.slice(0, 60)}`); }
                  else totalReg += d.registros || 0;
                } catch { errores.push(`${p}: timeout`); }
              }
              const msg = `${totalReg} BHE recibidas importadas`;
              setSyncMsg(errores.length > 0 ? `${msg} (${errores.length} meses con error)` : msg);
              if (totalReg > 0) load();
            } catch (e) { setSyncMsg(`Error: ${e instanceof Error ? e.message : "sin detalles"}`); }
            finally { setSyncing(false); }
          }} disabled={syncing}
            style={{ padding: "8px 16px", borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: syncing ? "wait" : "pointer", background: syncing ? "var(--bg4)" : "var(--amberBg)", color: syncing ? "var(--txt3)" : "var(--amber)", border: "1px solid var(--amberBd)" }}>
            {syncing ? "..." : "Importar BHE recibidas"}
          </button>
        </div>
      </div>

      {syncMsg && (
        <div style={{ padding: "8px 12px", borderRadius: 8, marginBottom: 12, fontSize: 12, fontWeight: 600,
          background: syncMsg.startsWith("Error") ? "var(--redBg)" : "var(--greenBg)",
          color: syncMsg.startsWith("Error") ? "var(--red)" : "var(--green)",
          border: `1px solid ${syncMsg.startsWith("Error") ? "var(--redBd)" : "var(--greenBd)"}` }}>
          {syncMsg}
        </div>
      )}

      {/* Filtro conciliación */}
      <div style={{ display: "flex", gap: 2, background: "var(--bg3)", borderRadius: 8, padding: 2, marginBottom: 12, width: "fit-content" }}>
        {([
          { key: "todos" as const, label: `Todas (${data.length})` },
          { key: "pendiente" as const, label: `Por conciliar (${totalPendientes})` },
          { key: "conciliada" as const, label: `Conciliadas (${totalConciliadas})` },
        ]).map(f => (
          <button key={f.key} onClick={() => setConcFilter(f.key)}
            style={{
              padding: "5px 12px", borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: "pointer", border: "none",
              background: concFilter === f.key ? (f.key === "pendiente" ? "var(--amberBg)" : f.key === "conciliada" ? "var(--greenBg)" : "var(--cyanBg)") : "transparent",
              color: concFilter === f.key ? (f.key === "pendiente" ? "var(--amber)" : f.key === "conciliada" ? "var(--green)" : "var(--cyan)") : "var(--txt3)",
            }}>
            {f.label}
          </button>
        ))}
      </div>

      {/* Barra de búsqueda */}
      <div style={{ position: "relative", marginBottom: 12 }}>
        <input
          placeholder="Buscar por nombre, RUT o N° boleta..."
          value={searchBhe}
          onChange={e => setSearchBhe(e.target.value)}
          style={{ width: "100%", padding: "9px 12px 9px 32px", borderRadius: 8, border: "1px solid var(--bg4)", background: "var(--bg3)", color: "var(--txt)", fontSize: 12, outline: "none", boxSizing: "border-box" }}
        />
        <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", fontSize: 14, color: "var(--txt3)", pointerEvents: "none" }}>🔍</span>
        {searchBhe && (
          <button onClick={() => setSearchBhe("")} style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "var(--txt3)", fontSize: 16, cursor: "pointer", lineHeight: 1 }}>&times;</button>
        )}
      </div>

      {/* KPIs */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginBottom: 16 }}>
        <div style={{ padding: 12, background: "var(--bg3)", borderRadius: 8, textAlign: "center" }}>
          <div style={{ fontSize: 10, color: "var(--txt3)" }}>Bruto</div>
          <div className="mono" style={{ fontSize: 16, fontWeight: 700 }}>{fmtMoney(total)}</div>
        </div>
        <div style={{ padding: 12, background: "var(--amberBg)", borderRadius: 8, textAlign: "center" }}>
          <div style={{ fontSize: 10, color: "var(--amber)" }}>Retención</div>
          <div className="mono" style={{ fontSize: 16, fontWeight: 700, color: "var(--amber)" }}>{fmtMoney(totalRet)}</div>
        </div>
        <div style={{ padding: 12, background: "var(--greenBg)", borderRadius: 8, textAlign: "center" }}>
          <div style={{ fontSize: 10, color: "var(--green)" }}>Líquido pagado</div>
          <div className="mono" style={{ fontSize: 16, fontWeight: 700, color: "var(--green)" }}>{fmtMoney(totalLiq)}</div>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: "center" }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>📋</div>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
            {concFilter === "pendiente" ? "Todas las boletas están conciliadas" : concFilter === "conciliada" ? "Sin boletas conciliadas" : "Sin boletas para este período"}
          </div>
          {concFilter === "todos" && (
            <div style={{ fontSize: 12, color: "var(--txt3)", marginBottom: 12 }}>Importa las boletas desde el SII</div>
          )}
        </div>
      ) : (
        <div className="card" style={{ overflow: "hidden" }}>
          <table className="tbl" style={{ fontSize: 11 }}>
            <thead>
              <tr>
                <th>N°</th><th>Fecha</th><th>RUT Emisor</th><th>Nombre</th>
                <th style={{ textAlign: "right" }}>Bruto</th>
                <th style={{ textAlign: "right" }}>Retención</th>
                <th style={{ textAlign: "right" }}>Líquido</th>
                <th>Pago</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c, i) => (
                <tr key={c.id || i}>
                  <td className="mono" style={{ fontWeight: 600 }}>{c.nro_doc}</td>
                  <td className="mono">{fmtDate(c.fecha_docto)}</td>
                  <td className="mono" style={{ fontSize: 10 }}>{c.rut_proveedor}</td>
                  <td style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.razon_social || "—"}</td>
                  <td className="mono" style={{ textAlign: "right" }}>{fmtMoney(c.monto_neto || 0)}</td>
                  <td className="mono" style={{ textAlign: "right", color: "var(--amber)" }}>{fmtMoney(c.monto_iva || 0)}</td>
                  <td className="mono" style={{ textAlign: "right", fontWeight: 600, color: "var(--green)" }}>{fmtMoney(c.monto_total || 0)}</td>
                  <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                      <span style={{ fontSize: 10, color: "var(--txt3)" }}>
                        {isConciliada(c) ? fmtMoney(c.monto_total || 0) : isParcial(c) ? `${fmtMoney((c.monto_total || 0) - (concPorCompra.get(c.id!) || 0))} por pagar` : `${fmtMoney(c.monto_total || 0)} por pagar`}
                      </span>
                      {isConciliada(c) ? (
                        <span onClick={(e) => openDetalle(c.id!, e)}
                          style={{ fontSize: 11, fontWeight: 600, padding: "4px 12px", borderRadius: 6, background: "var(--greenBg)", color: "var(--green)", cursor: "pointer" }}>
                          Pagado
                        </span>
                      ) : (
                        <div>
                        {isParcial(c) && (
                          <div style={{ display: "inline-flex", alignItems: "center", gap: 4, marginBottom: 4 }}>
                            <span style={{ fontSize: 9, fontWeight: 600, color: "var(--amber)" }}>Parcial {fmtMoney(concPorCompra.get(c.id!) || 0)}/{fmtMoney(c.monto_total || 0)}</span>
                            <span onClick={(e) => openDetalle(c.id!, e)}
                              style={{ fontSize: 10, color: "var(--amber)", cursor: "pointer", textDecoration: "underline" }}>
                              ver
                            </span>
                          </div>
                        )}
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 0 }}>
                          <span onClick={async () => {
                            setPagoItem(c); setPagoLoading(true); setPagoSearch("");
                            const movs = await fetchMovimientosBanco(empresa.id!);
                            const concMovIds = new Set(conciliaciones.filter(x => x.estado === "confirmado" && x.movimiento_banco_id).map(x => x.movimiento_banco_id));
                            setMovsBanco(movs.filter(m => m.monto < 0 && isMovReal(m) && m.estado_conciliacion !== "conciliado" && m.estado_conciliacion !== "ignorado"));
                            setPagoLoading(false);
                          }}
                            style={{ fontSize: 11, fontWeight: 600, padding: "5px 12px", borderRadius: "6px 0 0 6px", background: "var(--cyan)", color: "#fff", cursor: "pointer" }}>
                            Asignar Pago
                          </span>
                          <span onClick={async () => {
                            setPagoItem(c); setPagoLoading(true); setPagoSearch("");
                            const movs = await fetchMovimientosBanco(empresa.id!);
                            const concMovIds = new Set(conciliaciones.filter(x => x.estado === "confirmado" && x.movimiento_banco_id).map(x => x.movimiento_banco_id));
                            setMovsBanco(movs.filter(m => m.monto < 0 && isMovReal(m) && m.estado_conciliacion !== "conciliado" && m.estado_conciliacion !== "ignorado"));
                            setPagoLoading(false);
                          }}
                            style={{ fontSize: 11, fontWeight: 600, padding: "5px 6px", borderRadius: "0 6px 6px 0", background: "var(--cyan)", color: "#fff", cursor: "pointer", borderLeft: "1px solid rgba(255,255,255,0.3)" }}>
                            &#9662;
                          </span>
                        </span>
                        </div>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ fontWeight: 700, background: "var(--bg3)" }}>
                <td colSpan={4}>TOTAL</td>
                <td className="mono" style={{ textAlign: "right" }}>{fmtMoney(total)}</td>
                <td className="mono" style={{ textAlign: "right", color: "var(--amber)" }}>{fmtMoney(totalRet)}</td>
                <td className="mono" style={{ textAlign: "right", color: "var(--green)" }}>{fmtMoney(totalLiq)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {/* Popover detalle conciliación (flotante) */}
      {detalleConc && (
        <>
          <div onClick={() => setDetalleConc(null)} style={{ position: "fixed", inset: 0, zIndex: 9990 }} />
          <div style={{ position: "fixed", zIndex: 9991, top: detallePos.top, left: detallePos.left, background: "var(--bg2)", border: "1px solid var(--bg4)", borderRadius: 10, padding: 16, boxShadow: "0 8px 24px rgba(0,0,0,0.4)", width: 380, maxHeight: "60vh", overflowY: "auto" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Detalle conciliación ({detalleMovs.length} pago{detalleMovs.length !== 1 ? "s" : ""})</span>
              <button onClick={() => setDetalleConc(null)} style={{ background: "none", border: "none", fontSize: 16, cursor: "pointer", color: "var(--txt3)" }}>&times;</button>
            </div>
            {detalleLoading ? (
              <div style={{ padding: 16, textAlign: "center", color: "var(--txt3)", fontSize: 12 }}>Cargando...</div>
            ) : detalleMovs.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {detalleMovs.map((dm, i) => (
                  <div key={dm.conc.id || i} style={{ padding: 10, background: "var(--bg3)", borderRadius: 6, fontSize: 11 }}>
                    {dm.mov ? (
                      <>
                        <div style={{ fontWeight: 600, color: "var(--cyan)" }}>{dm.mov.descripcion}</div>
                        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
                          <span className="mono" style={{ color: "var(--txt3)" }}>{fmtDate(dm.mov.fecha)} · {dm.mov.banco}</span>
                          <span className="mono" style={{ fontWeight: 700 }}>{fmtMoney(dm.conc.monto_aplicado || Math.abs(dm.mov.monto))}</span>
                        </div>
                      </>
                    ) : (
                      <div style={{ color: "var(--txt3)" }}>Movimiento no encontrado</div>
                    )}
                    <button onClick={async () => {
                      if (!confirm("¿Deshacer este pago?")) return;
                      const { updateConciliacion, syncEstadoConciliacion } = await import("@/lib/db");
                      await updateConciliacion(dm.conc.id!, { estado: "rechazado" });
                      if (dm.conc.movimiento_banco_id && dm.mov) await syncEstadoConciliacion(dm.conc.movimiento_banco_id, dm.mov.monto);
                      setDetalleConc(null);
                      await load();
                    }}
                      style={{ marginTop: 6, width: "100%", padding: "4px 10px", borderRadius: 4, fontSize: 10, fontWeight: 600, background: "var(--redBg)", color: "var(--red)", border: "1px solid var(--redBd)", cursor: "pointer" }}>
                      Deshacer
                    </button>
                  </div>
                ))}
                <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", fontSize: 11, fontWeight: 700, borderTop: "1px solid var(--bg4)", marginTop: 4 }}>
                  <span>Total conciliado</span>
                  <span className="mono">{fmtMoney(detalleMovs.reduce((s, dm) => s + (dm.conc.monto_aplicado || (dm.mov ? Math.abs(dm.mov.monto) : 0)), 0))}</span>
                </div>
              </div>
            ) : (
              <div style={{ padding: 12, fontSize: 12, color: "var(--txt3)" }}>Sin movimientos vinculados</div>
            )}
          </div>
        </>
      )}

      {/* Modal Asignar Pago */}
      {pagoItem && (
        <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={() => !pagoSaving && setPagoItem(null)}>
          <div onClick={e => e.stopPropagation()} style={{ background: "var(--bg2)", borderRadius: 12, width: "100%", maxWidth: 700, maxHeight: "90vh", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 20px 60px rgba(0,0,0,0.15)" }}>
            <div style={{ padding: "20px 28px", background: "var(--cyan)", color: "#fff", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 18, fontWeight: 700 }}>Asignar Pago</span>
              <button onClick={() => setPagoItem(null)} disabled={pagoSaving} style={{ background: "none", border: "none", color: "#fff", fontSize: 22, cursor: "pointer", lineHeight: 1 }}>&times;</button>
            </div>
            <div style={{ padding: "20px 28px", borderBottom: "1px solid var(--bg4)" }}>
              <div style={{ fontSize: 13, marginBottom: 4 }}>
                <strong>BHE</strong> N&deg; {pagoItem.nro_doc} &mdash; {pagoItem.razon_social} &mdash; {pagoItem.fecha_docto || ""}
              </div>
              <div style={{ fontSize: 14, fontWeight: 700, color: "var(--red)" }}>
                {fmtMoney(pagoItem.monto_total || 0)} (l&iacute;quido)
              </div>
            </div>
            <div style={{ padding: "12px 28px", borderBottom: "1px solid var(--bg4)" }}>
              <input placeholder="Buscar movimiento bancario..." value={pagoSearch} onChange={e => setPagoSearch(e.target.value)}
                style={{ width: "100%", padding: "8px 12px", borderRadius: 8, border: "1px solid var(--bg4)", background: "var(--bg2)", color: "var(--txt)", fontSize: 12 }} />
            </div>
            <div style={{ flex: 1, overflow: "auto", maxHeight: 400 }}>
              {pagoLoading ? (
                <div style={{ padding: 40, textAlign: "center", color: "var(--txt3)" }}>Cargando movimientos...</div>
              ) : (() => {
                const q = pagoSearch.toLowerCase();
                const targetH = pagoItem.monto_total || 0;
                const facFechaH = pagoItem.fecha_docto ? new Date(pagoItem.fecha_docto + "T12:00:00").getTime() : 0;
                const provNameH = (pagoItem.razon_social || "").toLowerCase();
                const provWordsH = provNameH.split(/\s+/).filter(w => w.length > 3);
                const filtrados = movsBanco.filter(m => !pagoSearch || (m.descripcion || "").toLowerCase().includes(q) || (m.banco || "").toLowerCase().includes(q) || String(Math.abs(m.monto)).includes(q));
                const scoreMovH = (m: DBMovimientoBanco) => {
                  const montoPct = targetH > 0 ? Math.abs(Math.abs(m.monto) - targetH) / targetH : 1;
                  const montoScore = montoPct < 0.01 ? 0 : montoPct < 0.05 ? 0.1 + montoPct : 0.3 + montoPct;
                  const desc = (m.descripcion || "").toLowerCase();
                  const isMP = m.banco === "MercadoPago" || desc.startsWith("retiro mp");
                  const provMatch = isMP ? 0 : (provWordsH.some(w => desc.includes(w)) ? 0 : 1);
                  let fechaScore = 1;
                  if (facFechaH && m.fecha) {
                    const dias = (new Date(m.fecha + "T12:00:00").getTime() - facFechaH) / 86400000;
                    fechaScore = dias < 0 ? 3 : Math.min(dias / 60, 3);
                  }
                  return isMP
                    ? montoScore * 0.75 + Math.min(fechaScore, 3) * 0.25
                    : montoScore * 0.70 + Math.min(fechaScore, 3) * 0.20 + provMatch * 0.10;
                };
                const sorted = filtrados.sort((a, b) => scoreMovH(a) - scoreMovH(b));
                if (sorted.length === 0) return <div style={{ padding: 40, textAlign: "center", color: "var(--txt3)" }}>No hay movimientos bancarios pendientes</div>;
                return sorted.slice(0, 50).map(m => {
                  const montoAbs = Math.abs(m.monto);
                  const coincide = montoAbs === (pagoItem.monto_total || 0);
                  const montoDiff = Math.abs(montoAbs - (pagoItem.monto_total || 0));
                  const diasDiff = facFechaH && m.fecha ? Math.round((new Date(m.fecha + "T12:00:00").getTime() - facFechaH) / 86400000) : null;
                  return (
                    <div key={m.id} onClick={async () => {
                      if (pagoSaving) return;
                      setPagoSaving(true);
                      try {
                        const { upsertConciliacion, syncEstadoConciliacion } = await import("@/lib/db");
                        await upsertConciliacion({ empresa_id: empresa.id!, movimiento_banco_id: m.id!, rcv_compra_id: pagoItem.id!, rcv_venta_id: null, confianza: 1, estado: "confirmado", tipo_partida: "match", metodo: "manual", notas: null, created_by: "admin", monto_aplicado: Math.abs(m.monto) });
                        await syncEstadoConciliacion(m.id!, m.monto);
                        await load();
                        setPagoItem(null);
                      } catch (err) { console.error(err); }
                      setPagoSaving(false);
                    }}
                      style={{ padding: "14px 28px", borderBottom: "1px solid var(--bg4)", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", background: coincide ? "var(--greenBg)" : "transparent" }}
                      onMouseOver={e => { if (!coincide) e.currentTarget.style.background = "var(--bg3)"; }}
                      onMouseOut={e => { if (!coincide) e.currentTarget.style.background = "transparent"; }}>
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 500 }}>{m.descripcion || "Sin descripcion"}</div>
                        <div style={{ fontSize: 11, color: "var(--txt3)", marginTop: 2 }}>
                          {fmtDate(m.fecha)} &middot; {m.banco || "Banco"}
                          {diasDiff !== null && <span className="mono" style={{ marginLeft: 8, fontSize: 10, color: diasDiff < 0 ? "var(--red)" : diasDiff <= 45 ? "var(--green)" : "var(--amber)" }}>{diasDiff}d {diasDiff < 0 ? "antes" : "despues"}</span>}
                        </div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div className="mono" style={{ fontSize: 14, fontWeight: 700, color: "var(--red)" }}>{fmtMoney(montoAbs)}</div>
                        {coincide ? <div style={{ fontSize: 10, color: "var(--green)", fontWeight: 600 }}>Coincide exacto</div>
                          : montoDiff > 0 && <div className="mono" style={{ fontSize: 10, color: "var(--amber)" }}>diff {fmtMoney(montoDiff)}</div>}
                      </div>
                    </div>
                  );
                });
              })()}
            </div>
            <div style={{ padding: "12px 28px", borderTop: "1px solid var(--bg4)", display: "flex", justifyContent: "flex-end" }}>
              <button onClick={() => setPagoItem(null)} disabled={pagoSaving}
                style={{ padding: "10px 24px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", background: "var(--bg2)", color: "var(--txt2)", border: "1px solid var(--bg4)" }}>Cerrar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ConciliacionPage() {
  const [tab, setTabRaw] = useState<TabKey>(() => {
    if (typeof window !== "undefined") {
      const h = window.location.hash.replace("#", "");
      if (h) return h as TabKey;
    }
    return "dash";
  });
  const setTab = (t: TabKey) => {
    setTabRaw(t);
    window.location.hash = t;
  };
  const [bancoFilter, setBancoFilter] = useState<string | undefined>(undefined);
  const [empresa, setEmpresa] = useState<DBEmpresa | null>(null);
  const [periodo, setPeriodo] = useState(currentPeriodo());
  const [loading, setLoading] = useState(true);
  const [mounted, setMounted] = useState(false);
  const auth = useAuth();

  const SIDEBAR_GROUPS = useMemo(() => [
    { section: "INGRESOS", icon: "🏷️", items: [["ventas", "RCV Ventas", "📄"]] as [TabKey, string, string][] },
    { section: "EGRESOS", icon: "💳", items: [["compras", "Registro de compras", "📄"], ["gastos", "Gastos", "🧾"], ["honorarios", "Boletas de honorarios", "📋"], ["remuneraciones", "Remuneraciones", "👥"], ["impuestos", "Impuestos", "🏛️"], ["proveedores", "Proveedores", "🤝"]] as [TabKey, string, string][] },
    { section: "BANCO", icon: "🏦", items: [["banco", "Banco y Conciliación", "🏦"]] as [TabKey, string, string][] },
    { section: "REPORTES", icon: "📈", items: [["resultados", "Estado Resultados", "📈"], ["flujo", "Flujo Caja", "💰"], ["proyectado", "Flujo Proyectado", "🔮"], ["presupuesto", "Presupuesto", "📊"]] as [TabKey, string, string][] },
    { section: "AJUSTES", icon: "⚙️", items: [["cuentas", "Plan Cuentas", "📋"], ["reglas", "Reglas", "⚙️"]] as [TabKey, string, string][] },
  ], []);
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({});
  const toggleSection = (section: string) => setOpenSections(prev => ({ ...prev, [section]: !prev[section] }));

  useEffect(() => {
    setMounted(true);
    fetchEmpresaDefault().then(e => {
      setEmpresa(e);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    for (const g of SIDEBAR_GROUPS) {
      if (g.items.some(([k]) => k === tab)) {
        setOpenSections(prev => prev[g.section] ? prev : { ...prev, [g.section]: true });
        break;
      }
    }
  }, [tab, SIDEBAR_GROUPS]);

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

  return (
    <div className="app-admin chipax-theme">
      {/* Topbar */}
      <div className="admin-topbar">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Link href="/admin"><button className="back-btn">&#8592;</button></Link>
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" }}>BANVA</div>
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
          {/* Home */}
          <Link href="/admin"><button className="sidebar-btn"><span className="sidebar-icon">🏠</span><span className="sidebar-label">Home</span></button></Link>
          {/* Dashboard */}
          <button className={`sidebar-btn ${tab === "dash" ? "active" : ""}`} onClick={() => setTab("dash")}>
            <span className="sidebar-icon">📊</span>
            <span className="sidebar-label">Dashboard</span>
          </button>
          {/* Collapsible groups */}
          {SIDEBAR_GROUPS.map((group) => {
            const isOpen = openSections[group.section];
            const hasActive = group.items.some(([k]) => k === tab);
            return (
              <div key={group.section} className="sidebar-group">
                <button className={`sidebar-section-btn${hasActive ? " has-active" : ""}`} onClick={() => toggleSection(group.section)}>
                  <span className="sidebar-section-icon">{group.icon}</span>
                  <span className="sidebar-section-label">{group.section}</span>
                  <span className={`sidebar-chevron${isOpen ? " open" : ""}`}>&#9206;</span>
                </button>
                {isOpen && group.items.map(([key, label, icon]) => (
                  <button key={key} className={`sidebar-btn sidebar-child ${tab === key ? "active" : ""}`} onClick={() => setTab(key)}>
                    <span className="sidebar-icon">{icon}</span>
                    <span className="sidebar-label">{label}</span>
                  </button>
                ))}
              </div>
            );
          })}
          <div style={{ flex: 1 }} />
          {/* Cuenta (bottom) */}
          <Link href="/admin"><button className="sidebar-btn"><span className="sidebar-icon">👤</span><span className="sidebar-label">Cuenta</span></button></Link>
        </nav>

        <main className="admin-main">
          {/* Mobile tabs */}
          <div className="admin-mobile-tabs">
            {([["dash","Dashboard"],["ventas","RCV Ventas"],["compras","Reg. Compras"],["gastos","Gastos"],["honorarios","Honorarios"],["remuneraciones","Remunerac."],["impuestos","Impuestos"],["proveedores","Proveedores"],["banco","Banco"],["conciliacion","Conciliación"],["resultados","Estado Res."],["flujo","Flujo Caja"],["proyectado","Flujo Proy."],["presupuesto","Presupuesto"],["cuentas","Plan Cuentas"],["reglas","Reglas"]] as [TabKey,string][]).map(([key, label]) => (
              <button key={key} className={`tab ${tab === key ? "active-cyan" : ""}`} onClick={() => setTab(key)}>{label}</button>
            ))}
          </div>
          <div className="admin-content">
            {empresa && tab === "dash" && <DashboardConciliacion empresa={empresa} periodo={periodo} onChangePeriodo={setPeriodo} onNavigate={(t: string) => {
              if (t.includes(":")) {
                const [tabName, filter] = t.split(":");
                setTab(tabName as TabKey);
                setBancoFilter(filter);
              } else {
                setTab(t as TabKey);
              }
            }} />}
            {empresa && tab === "compras" && <TabRcvCompras empresa={empresa} periodo={periodo} />}
            {empresa && tab === "ventas" && <TabRcvVentas empresa={empresa} periodo={periodo} />}
            {empresa && tab === "banco" && <ConciliacionTabla empresa={empresa} periodo={periodo} initialFilter={bancoFilter} />}
            {tab === "cuentas" && <PlanCuentasTree />}
            {tab === "reglas" && <RuleBuilder />}
            {empresa && tab === "resultados" && <EstadoResultados empresa={empresa} periodo={periodo} />}
            {empresa && tab === "flujo" && <FlujoCaja empresa={empresa} periodo={periodo} />}
            {empresa && tab === "proyectado" && <FlujoProyectado empresa={empresa} periodo={periodo} />}
            {empresa && tab === "presupuesto" && <TabPresupuesto empresa={empresa} periodo={periodo} />}
            {empresa && tab === "honorarios" && <TabHonorarios empresa={empresa} periodo={periodo} />}
            {empresa && tab === "proveedores" && <TabProveedores empresa={empresa} periodo={periodo} />}
            {["gastos","remuneraciones","impuestos"].includes(tab) && (
              <div className="card" style={{ padding: 32, textAlign: "center" }}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>🚧</div>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
                  {tab === "gastos" && "Gastos — Boletas, invoice y más"}
                  {tab === "remuneraciones" && "Remuneraciones — Sueldos y Previred"}
                  {tab === "impuestos" && "Impuestos — F29, F22 y más"}
                </div>
                <div style={{ fontSize: 12, color: "var(--txt3)" }}>Próximamente</div>
              </div>
            )}
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
