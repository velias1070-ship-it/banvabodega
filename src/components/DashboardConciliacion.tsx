"use client";
import { useState, useEffect, useMemo } from "react";
import {
  fetchRcvCompras, fetchRcvVentas,
  fetchMovimientosBanco,
  fetchConciliaciones, fetchConciliacionItems,
  fetchProveedorCuentas,
} from "@/lib/db";
import type {
  DBEmpresa, DBRcvCompra, DBRcvVenta, DBMovimientoBanco,
  DBConciliacion, DBConciliacionItem, DBProveedorCuenta,
} from "@/lib/db";

const fmtMoney = (n: number) => n.toLocaleString("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });

function formatPeriodoShort(p: string): string {
  if (p.length === 4) return `Año ${p}`;
  const y = parseInt(p.slice(0, 4));
  const m = parseInt(p.slice(4, 6));
  const d = new Date(y, m - 1, 1);
  return d.toLocaleDateString("es-CL", { month: "short", year: "numeric" }).replace(/^./, c => c.toUpperCase());
}

function formatPeriodoLong(p: string): string {
  if (p.length === 4) return `Año ${p}`;
  const y = parseInt(p.slice(0, 4));
  const m = parseInt(p.slice(4, 6));
  const d = new Date(y, m - 1, 1);
  return d.toLocaleDateString("es-CL", { month: "long", year: "numeric" }).replace(/^./, c => c.toUpperCase());
}

function periodoRange(p: string): { desde: string; hasta: string } {
  const isAnual = p.length === 4;
  const y = parseInt(p.slice(0, 4));
  const m = isAnual ? 1 : parseInt(p.slice(4, 6));
  return {
    desde: isAnual ? `${y}-01-01` : `${y}-${String(m).padStart(2, "0")}-01`,
    hasta: isAnual ? `${y}-12-31` : `${y}-${String(m).padStart(2, "0")}-${new Date(y, isAnual ? 12 : m, 0).getDate()}`,
  };
}

// Filtrar movimientos reales (excluir internos MP)
function isMovReal(m: DBMovimientoBanco): boolean {
  const desc = (m.descripcion || "").toUpperCase();
  if (desc.startsWith("VENTA ML") || desc.startsWith("BONIFICACION") || desc.startsWith("DEVOLUCION") || desc.startsWith("PAGO MP #")) return false;
  if ((desc.startsWith("COMPRA ML") || desc.startsWith("COMPRA MP"))) {
    try {
      const meta = typeof m.metadata === "string" ? JSON.parse(m.metadata) : m.metadata;
      const parsed = typeof meta === "string" ? JSON.parse(meta) : meta;
      if (parsed?.medio_pago && parsed.medio_pago !== "account_money") return false;
    } catch { /* keep */ }
  }
  return true;
}

// Períodos: últimos 6 meses
function getRecentPeriods(): string[] {
  const periods: string[] = [];
  const now = new Date();
  for (let i = 0; i < 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    periods.push(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return periods;
}

export default function DashboardConciliacion({ empresa, periodo, onChangePeriodo, onNavigate }: { empresa: DBEmpresa; periodo: string; onChangePeriodo: (p: string) => void; onNavigate?: (tab: string) => void }) {
  const [compras, setCompras] = useState<DBRcvCompra[]>([]);
  const [ventas, setVentas] = useState<DBRcvVenta[]>([]);
  const [movBanco, setMovBanco] = useState<DBMovimientoBanco[]>([]);
  const [conciliaciones, setConciliaciones] = useState<DBConciliacion[]>([]);
  const [provCuentas, setProvCuentas] = useState<DBProveedorCuenta[]>([]);
  const [loading, setLoading] = useState(true);

  const periods = useMemo(() => getRecentPeriods(), []);
  const rango = periodoRange(periodo);

  useEffect(() => {
    if (!empresa.id) return;
    setLoading(true);
    Promise.all([
      fetchRcvCompras(empresa.id, periodo),
      fetchRcvVentas(empresa.id, periodo),
      fetchMovimientosBanco(empresa.id, { desde: rango.desde, hasta: rango.hasta }),
      fetchConciliaciones(empresa.id),
      fetchProveedorCuentas(),
    ]).then(([c, v, m, conc, pc]) => {
      setCompras(c); setVentas(v); setMovBanco(m); setConciliaciones(conc); setProvCuentas(pc);
      setLoading(false);
    });
  }, [empresa.id, periodo]);

  // === Cálculos ===
  const movReales = movBanco.filter(isMovReal);
  const movBancoIds = new Set(movReales.map(m => m.id).filter(Boolean));
  const concDelPeriodo = conciliaciones.filter(c => c.movimiento_banco_id && movBancoIds.has(c.movimiento_banco_id) && c.estado === "confirmado");
  const concMovIds = new Set(concDelPeriodo.map(c => c.movimiento_banco_id));
  const concCompraIds = new Set(conciliaciones.filter(c => c.estado === "confirmado" && c.rcv_compra_id).map(c => c.rcv_compra_id));
  const concVentaIds = new Set(conciliaciones.filter(c => c.estado === "confirmado" && c.rcv_venta_id).map(c => c.rcv_venta_id));

  // Movimientos
  const movPendientes = movReales.filter(m => !concMovIds.has(m.id!) && m.estado_conciliacion !== "ignorado");
  const abonosPend = movPendientes.filter(m => m.monto > 0);
  const cargosPend = movPendientes.filter(m => m.monto < 0);
  const movConciliados = movReales.filter(m => concMovIds.has(m.id!) || m.estado_conciliacion === "conciliado");
  const totalMov = movReales.filter(m => m.estado_conciliacion !== "ignorado").length;
  const pctMov = totalMov > 0 ? Math.round((movConciliados.length / totalMov) * 100) : 0;

  // Cuentas por cobrar (facturas venta sin conciliar)
  const ventasPendientes = ventas.filter(v => !concVentaIds.has(v.id!));
  const ventasCobradas = ventas.filter(v => concVentaIds.has(v.id!));
  const totalPorCobrar = ventasPendientes.reduce((s, v) => s + (v.monto_total || 0), 0);

  // Cuentas por pagar (facturas compra sin conciliar)
  const comprasPendientes = compras.filter(c => !concCompraIds.has(c.id!) && c.tipo_doc !== 71);
  const honorariosPend = compras.filter(c => !concCompraIds.has(c.id!) && c.tipo_doc === 71);
  const comprasPagadas = compras.filter(c => concCompraIds.has(c.id!));
  const totalPorPagar = comprasPendientes.reduce((s, c) => s + (c.monto_total || 0), 0) + honorariosPend.reduce((s, c) => s + (c.monto_total || 0), 0);

  // Resultado operacional
  const totalIngresos = ventas.reduce((s, v) => s + (v.monto_neto || 0), 0);
  const totalCostos = compras.reduce((s, c) => s + (c.monto_total || 0), 0);
  const gastosOp = Math.abs(movReales.filter(m => m.monto < 0 && m.categoria_cuenta_id).reduce((s, m) => s + m.monto, 0));
  const resultado = totalIngresos - totalCostos - gastosOp;

  // Tareas totales
  const totalTareas = totalMov + ventas.length + compras.length;
  const tareasHechas = movConciliados.length + ventasCobradas.length + comprasPagadas.length;
  const pctTareas = totalTareas > 0 ? Math.round((tareasHechas / totalTareas) * 100) : 0;

  if (loading) return <div style={{ textAlign: "center", padding: 40, color: "var(--txt3)" }}>Cargando...</div>;

  return (
    <div>
      {/* Saludo */}
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>Conciliador BANVA</h2>
        <div style={{ fontSize: 13, color: "var(--txt3)", marginTop: 4 }}>Avance mensual de conciliación y tareas financieras.</div>
      </div>

      {/* Selector de meses */}
      <div style={{ display: "flex", gap: 8, marginBottom: 20, overflowX: "auto", paddingBottom: 4 }}>
        {periods.map(p => {
          const isSelected = p === periodo;
          return (
            <button key={p} onClick={() => onChangePeriodo(p)}
              style={{
                padding: "10px 16px", borderRadius: 10, cursor: "pointer", minWidth: 100, textAlign: "center",
                background: isSelected ? "var(--bg2)" : "var(--bg3)",
                border: isSelected ? "2px solid var(--cyan)" : "1px solid var(--bg4)",
                color: isSelected ? "var(--txt)" : "var(--txt3)",
              }}>
              <div style={{ fontSize: 13, fontWeight: isSelected ? 700 : 500 }}>{formatPeriodoShort(p)}</div>
              <div style={{ height: 4, borderRadius: 2, marginTop: 6, background: "var(--bg4)" }}>
                <div style={{ height: "100%", borderRadius: 2, width: isSelected ? `${pctTareas}%` : "0%", background: "var(--cyan)", transition: "width 0.3s" }} />
              </div>
            </button>
          );
        })}
      </div>

      {/* Tareas progreso */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
          <span style={{ fontSize: 16, fontWeight: 700 }}>Tareas</span>
          <span style={{ fontSize: 12, color: "var(--green)", fontWeight: 600 }}>{tareasHechas} / {totalTareas} ({pctTareas}%)</span>
        </div>
        <div style={{ fontSize: 12, color: "var(--txt3)", marginBottom: 8 }}>
          Concilia, clasifica, cobra y paga todos los documentos del mes para tener claro cómo está tu negocio.
        </div>
        <div style={{ height: 8, borderRadius: 4, background: "var(--bg4)" }}>
          <div style={{ height: "100%", borderRadius: 4, width: `${pctTareas}%`, background: pctTareas === 100 ? "var(--green)" : "var(--cyan)", transition: "width 0.5s" }} />
        </div>
      </div>

      {/* Movimientos bancarios */}
      <div className="card" style={{ padding: 16, marginBottom: 12 }}>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 10 }}>Movimientos bancarios</div>

        {abonosPend.length > 0 && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid var(--bg4)" }}>
            <span style={{ fontSize: 13 }}><strong>{abonosPend.length}</strong> abonos por conciliar, que suman <strong className="mono">{fmtMoney(abonosPend.reduce((s, m) => s + m.monto, 0))}</strong></span>
            <button onClick={() => onNavigate?.("banco")} style={{ fontSize: 12, color: "var(--cyan)", background: "none", border: "none", cursor: "pointer", fontWeight: 600 }}>Revisar</button>
          </div>
        )}

        {cargosPend.length > 0 && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid var(--bg4)" }}>
            <span style={{ fontSize: 13 }}><strong>{cargosPend.length}</strong> cargos por conciliar, que suman <strong className="mono">{fmtMoney(Math.abs(cargosPend.reduce((s, m) => s + m.monto, 0)))}</strong></span>
            <button onClick={() => onNavigate?.("banco")} style={{ fontSize: 12, color: "var(--cyan)", background: "none", border: "none", cursor: "pointer", fontWeight: 600 }}>Revisar</button>
          </div>
        )}

        {abonosPend.length === 0 && cargosPend.length === 0 && (
          <div style={{ padding: "8px 0", borderBottom: "1px solid var(--bg4)", fontSize: 13, color: "var(--green)", fontWeight: 600 }}>
            Todos los movimientos están conciliados
          </div>
        )}

        <div style={{ padding: "8px 0", fontSize: 12, color: "var(--txt3)", display: "flex", gap: 16 }}>
          <span style={{ color: "var(--green)" }}>{movConciliados.length} movimientos conciliados</span>
        </div>
      </div>

      {/* Cuentas por cobrar */}
      <div className="card" style={{ padding: 16, marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <span style={{ fontSize: 15, fontWeight: 700 }}>Cuentas por cobrar de {formatPeriodoShort(periodo)}</span>
          <span className="mono" style={{ fontSize: 18, fontWeight: 700, color: "var(--green)" }}>{fmtMoney(totalPorCobrar)}</span>
        </div>

        {ventasPendientes.length > 0 && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid var(--bg4)" }}>
            <span style={{ fontSize: 13 }}><strong>{ventasPendientes.length}</strong> facturas de venta por cobrar</span>
            <button onClick={() => onNavigate?.("ventas")} style={{ fontSize: 12, color: "var(--cyan)", background: "none", border: "none", cursor: "pointer", fontWeight: 600 }}>Revisar</button>
          </div>
        )}

        <div style={{ padding: "8px 0", fontSize: 12, color: "var(--txt3)" }}>
          <span style={{ color: "var(--green)" }}>{ventasCobradas.length} facturas cobradas</span>
        </div>
      </div>

      {/* Cuentas por pagar */}
      <div className="card" style={{ padding: 16, marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <span style={{ fontSize: 15, fontWeight: 700 }}>Cuentas por pagar de {formatPeriodoShort(periodo)}</span>
          <span className="mono" style={{ fontSize: 18, fontWeight: 700, color: "var(--red)" }}>{fmtMoney(totalPorPagar)}</span>
        </div>

        {comprasPendientes.length > 0 && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid var(--bg4)" }}>
            <span style={{ fontSize: 13 }}><strong>{comprasPendientes.length}</strong> facturas de compra por pagar</span>
            <button onClick={() => onNavigate?.("compras")} style={{ fontSize: 12, color: "var(--cyan)", background: "none", border: "none", cursor: "pointer", fontWeight: 600 }}>Revisar</button>
          </div>
        )}

        {honorariosPend.length > 0 && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid var(--bg4)" }}>
            <span style={{ fontSize: 13 }}><strong>{honorariosPend.length}</strong> honorarios por pagar</span>
            <button onClick={() => onNavigate?.("compras")} style={{ fontSize: 12, color: "var(--cyan)", background: "none", border: "none", cursor: "pointer", fontWeight: 600 }}>Revisar</button>
          </div>
        )}

        <div style={{ padding: "8px 0", fontSize: 12, color: "var(--txt3)" }}>
          <span style={{ color: "var(--green)" }}>{comprasPagadas.length} documentos pagados</span>
        </div>
      </div>

      {/* Resultado operacional */}
      <div className="card" style={{ padding: 16 }}>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 10 }}>Resultado Operacional</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
          <div>
            <div style={{ fontSize: 10, color: "var(--txt3)", textTransform: "uppercase" }}>Ingresos</div>
            <div className="mono" style={{ fontSize: 18, fontWeight: 700, color: "var(--green)" }}>{fmtMoney(totalIngresos)}</div>
          </div>
          <div>
            <div style={{ fontSize: 10, color: "var(--txt3)", textTransform: "uppercase" }}>Costos</div>
            <div className="mono" style={{ fontSize: 18, fontWeight: 700, color: "var(--red)" }}>{fmtMoney(totalCostos)}</div>
          </div>
          <div>
            <div style={{ fontSize: 10, color: "var(--txt3)", textTransform: "uppercase" }}>Gastos Op.</div>
            <div className="mono" style={{ fontSize: 18, fontWeight: 700, color: "var(--amber)" }}>{fmtMoney(gastosOp)}</div>
          </div>
          <div>
            <div style={{ fontSize: 10, color: "var(--txt3)", textTransform: "uppercase" }}>Resultado</div>
            <div className="mono" style={{ fontSize: 18, fontWeight: 800, color: resultado >= 0 ? "var(--green)" : "var(--red)" }}>{fmtMoney(resultado)}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
