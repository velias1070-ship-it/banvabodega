"use client";
import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  fetchEmpresaDefault,
  fetchRcvCompras, fetchRcvVentas,
  fetchMovimientosBanco, insertMovimientosBanco, deleteMovimientosBancoByIds,
  fetchConciliaciones,
  fetchAlertas, fetchSyncLog,
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

// Generar lista de periodos (últimos 12 meses como fallback)
function periodOptions(): { value: string; label: string }[] {
  const opts = [];
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const val = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
    const label = d.toLocaleDateString("es-CL", { month: "long", year: "numeric" });
    opts.push({ value: val, label: label.charAt(0).toUpperCase() + label.slice(1) });
  }
  return opts;
}

// Formatear periodo YYYYMM a "Enero 2026"
function formatPeriodo(p: string): string {
  const y = parseInt(p.slice(0, 4));
  const m = parseInt(p.slice(4, 6));
  const d = new Date(y, m - 1, 1);
  const label = d.toLocaleDateString("es-CL", { month: "long", year: "numeric" });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

// ==================== DASHBOARD ====================
function Dashboard({ empresa, periodo, onChangePeriodo }: { empresa: DBEmpresa; periodo: string; onChangePeriodo: (p: string) => void }) {
  const [compras, setCompras] = useState<DBRcvCompra[]>([]);
  const [ventas, setVentas] = useState<DBRcvVenta[]>([]);
  const [movBanco, setMovBanco] = useState<DBMovimientoBanco[]>([]);
  const [conciliaciones, setConciliaciones] = useState<DBConciliacion[]>([]);
  const [alertas, setAlertas] = useState<DBAlerta[]>([]);
  const [syncLogs, setSyncLogs] = useState<DBSyncLog[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!empresa.id) return;
    setLoading(true);
    Promise.all([
      fetchRcvCompras(empresa.id, periodo),
      fetchRcvVentas(empresa.id, periodo),
      fetchMovimientosBanco(empresa.id),
      fetchConciliaciones(empresa.id),
      fetchAlertas(empresa.id, "activa"),
      fetchSyncLog(empresa.id),
    ]).then(([c, v, m, conc, al, sl]) => {
      setCompras(c); setVentas(v); setMovBanco(m); setConciliaciones(conc); setAlertas(al); setSyncLogs(sl);
      setLoading(false);
    });
  }, [empresa.id, periodo]);

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

  // === Conciliación ===
  const concPendientes = conciliaciones.filter(c => c.estado === "pendiente").length;
  const concConfirmadas = conciliaciones.filter(c => c.estado === "confirmado").length;
  const movSinConciliar = movBanco.filter(m => !m.estado_conciliacion || m.estado_conciliacion === "pendiente").length;

  // === Último sync del periodo actual ===
  const syncDelPeriodo = syncLogs.filter(s => s.periodo === periodo);
  const ultimoSync = syncDelPeriodo.length > 0 ? syncDelPeriodo[0] : null;

  return (
    <div>
      {/* Header con título y último sync */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Dashboard</h2>
          <div style={{ fontSize: 12, color: "var(--txt3)", marginTop: 2 }}>{formatPeriodo(periodo)}</div>
        </div>
        {ultimoSync && (
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 10, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Último sync</div>
            <div className="mono" style={{ fontSize: 12, color: "var(--cyan)" }}>
              {ultimoSync.synced_at ? new Date(ultimoSync.synced_at).toLocaleString("es-CL", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"}
            </div>
          </div>
        )}
      </div>

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

      {/* KPIs fila 3: Banco + Conciliación */}
      <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(4, 1fr)", marginBottom: 12 }}>
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
        <div className="kpi">
          <div style={{ fontSize: 11, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Conciliadas</div>
          <div className="mono" style={{ fontSize: 18, fontWeight: 700, color: "var(--cyan)" }}>{concConfirmadas}</div>
          <div style={{ fontSize: 11, color: "var(--txt3)" }}>{concPendientes} pendientes</div>
        </div>
        <div className="kpi">
          <div style={{ fontSize: 11, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Mov. sin conciliar</div>
          <div className="mono" style={{ fontSize: 18, fontWeight: 700, color: movSinConciliar > 0 ? "var(--amber)" : "var(--green)" }}>{movSinConciliar}</div>
          <div style={{ fontSize: 11, color: "var(--txt3)" }}>de {movBanco.length} total</div>
        </div>
      </div>

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

  useEffect(() => {
    if (!empresa.id) return;
    setLoading(true);
    fetchRcvCompras(empresa.id, periodo).then(d => { setData(d); setLoading(false); });
  }, [empresa.id, periodo]);

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
        <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>RCV Compras</h2>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <span style={{ fontSize: 12, color: "var(--txt3)" }}>{filtered.length} de {data.length} docs</span>
          <span className="mono" style={{ fontSize: 14, fontWeight: 700, color: "var(--red)" }}>{fmtMoney(total)}</span>
        </div>
      </div>

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
          <div style={{ fontSize: 12, color: "var(--txt3)" }}>Ejecuta el sync SII para cargar datos</div>
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

  useEffect(() => {
    if (!empresa.id) return;
    setLoading(true);
    fetchRcvVentas(empresa.id, periodo).then(d => { setData(d); setLoading(false); });
  }, [empresa.id, periodo]);

  if (loading) return <div style={{ textAlign: "center", padding: 40, color: "var(--txt3)" }}>Cargando...</div>;

  // Tipos disponibles para el filtro
  const tiposDisponibles = Array.from(new Set(data.map(v => String(v.tipo_doc))));

  // Filtrar por texto y tipo
  let filtered = data;
  if (tipoFilter !== "todos") filtered = filtered.filter(v => String(v.tipo_doc) === tipoFilter);
  if (filter) filtered = filtered.filter(v =>
    (v.rut_emisor || "").includes(filter) ||
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
        <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>RCV Ventas</h2>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <span style={{ fontSize: 12, color: "var(--txt3)" }}>{filtered.length} de {data.length} docs</span>
          <span className="mono" style={{ fontSize: 14, fontWeight: 700, color: "var(--green)" }}>{fmtMoney(total)}</span>
        </div>
      </div>

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
        <input className="form-input" placeholder="Buscar por RUT, folio o N°..." value={filter} onChange={e => setFilter(e.target.value)}
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
          <div style={{ fontSize: 12, color: "var(--txt3)" }}>Ejecuta el sync SII para cargar datos</div>
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="tbl" style={{ fontSize: 11 }}>
            <thead>
              <tr>
                <th>Tipo</th><th>Folio</th><th>RUT Receptor</th><th>Fecha</th>
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
                  <td className="mono" style={{ fontSize: 10 }}>{fmtRut(v.rut_emisor)}</td>
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
function TabBanco({ empresa }: { empresa: DBEmpresa }) {
  const [data, setData] = useState<DBMovimientoBanco[]>([]);
  const [loading, setLoading] = useState(true);
  const [banco, setBanco] = useState("banco_chile");
  const [showUpload, setShowUpload] = useState<false | "csv" | "liquidacion">(false);
  const [filter, setFilter] = useState("");

  const load = useCallback(async () => {
    if (!empresa.id) return;
    setLoading(true);
    const d = await fetchMovimientosBanco(empresa.id);
    setData(d);
    setLoading(false);
  }, [empresa.id]);

  useEffect(() => { load(); }, [load]);

  const handleImport = async (rows: CsvRow[]) => {
    if (!empresa.id) return;
    const items: DBMovimientoBanco[] = rows.map(r => ({
      empresa_id: empresa.id!,
      banco,
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
    if (!confirm("¿Eliminar todos los movimientos bancarios? Esta acción no se puede deshacer.")) return;
    const ids = data.map(d => d.id).filter(Boolean) as string[];
    if (ids.length > 0) await deleteMovimientosBancoByIds(ids);
    load();
  };

  const filtered = filter
    ? data.filter(m => (m.descripcion || "").toLowerCase().includes(filter.toLowerCase()) || (m.referencia || "").includes(filter))
    : data;

  const ingresos = filtered.filter(m => m.monto > 0).reduce((s, m) => s + m.monto, 0);
  const egresos = filtered.filter(m => m.monto < 0).reduce((s, m) => s + m.monto, 0);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Movimientos Banco</h2>
        <div style={{ display: "flex", gap: 8 }}>
          {data.length > 0 && (
            <button onClick={handleDeleteAll} style={{ padding: "6px 12px", borderRadius: 8, background: "var(--bg3)", color: "var(--red)", fontSize: 11, fontWeight: 600, border: "1px solid var(--bg4)" }}>
              Limpiar todo
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
            </>
          )}
        </div>
      </div>

      {/* Upload CSV Banco */}
      {showUpload === "csv" && (
        <div className="card" style={{ padding: 16, marginBottom: 16 }}>
          <div style={{ marginBottom: 12 }}>
            <label className="form-label">Banco / Fuente</label>
            <select value={banco} onChange={e => setBanco(e.target.value)} className="form-input" style={{ fontSize: 13 }}>
              <option value="banco_chile">Banco de Chile</option>
              <option value="santander">Santander</option>
              <option value="bci">BCI</option>
              <option value="mercadopago">MercadoPago</option>
              <option value="otro">Otro</option>
            </select>
          </div>
          <CsvUploader banco={banco} onImport={handleImport} />
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
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Sin movimientos bancarios</div>
          <div style={{ fontSize: 12, color: "var(--txt3)" }}>Sube un CSV del banco para comenzar</div>
        </div>
      ) : (
        <>
          {/* Resumen */}
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

          <input className="form-input" placeholder="Buscar por descripción o referencia..." value={filter} onChange={e => setFilter(e.target.value)}
            style={{ marginBottom: 12, fontSize: 13 }} />

          <div style={{ overflowX: "auto" }}>
            <table className="tbl" style={{ fontSize: 11 }}>
              <thead>
                <tr>
                  <th>Fecha</th><th>Descripción</th><th>Banco</th>
                  <th style={{ textAlign: "right" }}>Monto</th><th style={{ textAlign: "right" }}>Saldo</th><th>Ref.</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((m, i) => (
                  <tr key={m.id || i}>
                    <td className="mono">{fmtDate(m.fecha)}</td>
                    <td style={{ maxWidth: 250, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.descripcion || "—"}</td>
                    <td style={{ fontSize: 10, textTransform: "uppercase" }}>{m.banco}</td>
                    <td className="mono" style={{ textAlign: "right", fontWeight: 700, color: m.monto >= 0 ? "var(--green)" : "var(--red)" }}>{fmtMoney(m.monto)}</td>
                    <td className="mono" style={{ textAlign: "right", color: "var(--txt3)" }}>{m.saldo !== null ? fmtMoney(m.saldo) : "—"}</td>
                    <td className="mono" style={{ fontSize: 10, color: "var(--txt3)" }}>{m.referencia || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
            {empresa && tab === "banco" && <TabBanco empresa={empresa} />}
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
