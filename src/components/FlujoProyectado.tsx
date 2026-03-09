"use client";
import { useState, useEffect, useMemo, useCallback } from "react";
import {
  fetchCuentasBancarias,
  fetchRcvVentasPendientes,
  fetchRcvComprasPendientes,
} from "@/lib/db";
import type { DBEmpresa, DBRcvCompra, DBRcvVenta, DBCuentaBancaria } from "@/lib/db";
import { exportToExcel, fmtMoneyExcel } from "@/lib/exportExcel";
import dynamic from "next/dynamic";
import type { ChartSeries } from "@/components/SvgLineChart";

const SvgLineChart = dynamic(() => import("@/components/SvgLineChart"), { ssr: false });

// ==================== HELPERS ====================
const fmtMoney = (n: number) => n.toLocaleString("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });

// RUT de Idetex (proveedor principal con 60 días crédito)
const RUT_IDETEX = "76676820";

// Agregar días a una fecha string YYYY-MM-DD
function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

// Formato fecha corto
function fmtDate(d: string): string {
  const parts = d.split("-");
  return parts.length === 3 ? `${parts[2]}/${parts[1]}/${parts[0]}` : d;
}

// ==================== TIPOS ====================

interface GastoRecurrente {
  nombre: string;
  montoMensual: number;
}

interface ProyeccionDia {
  fecha: string;
  cobrosOpt: number;   // acumulado cobros (100%)
  cobrosBase: number;   // acumulado cobros (80%)
  cobrosPes: number;    // acumulado cobros (50%)
  pagos: number;        // acumulado pagos
  gastosRec: number;    // acumulado gastos recurrentes
  saldoOpt: number;
  saldoBase: number;
  saldoPes: number;
}

// ==================== COMPONENTE ====================

export default function FlujoProyectado({ empresa }: { empresa: DBEmpresa; periodo: string }) {
  const [cuentas, setCuentas] = useState<DBCuentaBancaria[]>([]);
  const [ventasPend, setVentasPend] = useState<DBRcvVenta[]>([]);
  const [comprasPend, setComprasPend] = useState<DBRcvCompra[]>([]);
  const [loading, setLoading] = useState(true);

  // Gastos recurrentes editables
  const [gastosRec, setGastosRec] = useState<GastoRecurrente[]>([
    { nombre: "Arriendo bodega", montoMensual: 0 },
    { nombre: "Remuneraciones", montoMensual: 0 },
    { nombre: "Publicidad ML", montoMensual: 0 },
    { nombre: "Software / suscripciones", montoMensual: 0 },
  ]);

  const load = useCallback(async () => {
    if (!empresa.id) return;
    setLoading(true);
    const [c, v, co] = await Promise.all([
      fetchCuentasBancarias(empresa.id),
      fetchRcvVentasPendientes(empresa.id),
      fetchRcvComprasPendientes(empresa.id),
    ]);
    setCuentas(c); setVentasPend(v); setComprasPend(co);
    setLoading(false);
  }, [empresa.id]);

  useEffect(() => { load(); }, [load]);

  // Saldo actual
  const saldoActual = useMemo(() =>
    cuentas.filter(c => c.activa).reduce((s, c) => s + (c.saldo_actual || 0), 0),
    [cuentas]
  );

  // Calcular fechas de vencimiento estimadas
  const cobros = useMemo(() =>
    ventasPend.map(v => {
      const fechaBase = v.fecha_docto || new Date().toISOString().split("T")[0];
      const vencimiento = addDays(fechaBase, 30); // Ventas: 30 días
      return { doc: `Venta #${v.folio || v.nro || "—"}`, monto: Math.abs(v.monto_total || 0), vencimiento };
    }).sort((a, b) => a.vencimiento.localeCompare(b.vencimiento)),
    [ventasPend]
  );

  const pagos = useMemo(() =>
    comprasPend.map(c => {
      const fechaBase = c.fecha_docto || new Date().toISOString().split("T")[0];
      const rutClean = (c.rut_proveedor || "").replace(/\./g, "").replace(/-/g, "");
      const diasCredito = rutClean.startsWith(RUT_IDETEX) ? 60 : 30;
      const vencimiento = addDays(fechaBase, diasCredito);
      return {
        doc: `Compra #${c.nro_doc || "—"} — ${c.razon_social || c.rut_proveedor || ""}`,
        monto: Math.abs(c.monto_total || 0),
        vencimiento,
        proveedor: c.razon_social || c.rut_proveedor || "—",
        diasCredito,
      };
    }).sort((a, b) => a.vencimiento.localeCompare(b.vencimiento)),
    [comprasPend]
  );

  // Gasto recurrente mensual total
  const gastoMensualTotal = gastosRec.reduce((s, g) => s + g.montoMensual, 0);
  const gastoDiario = gastoMensualTotal / 30;

  // Proyección a 90 días
  const proyeccion = useMemo((): ProyeccionDia[] => {
    const hoy = new Date().toISOString().split("T")[0];
    const dias: ProyeccionDia[] = [];

    let acumCobros = 0, acumPagos = 0, acumGastos = 0;

    for (let i = 0; i <= 90; i++) {
      const fecha = addDays(hoy, i);

      // Cobros que vencen en esta fecha
      const cobrosDelDia = cobros.filter(c => c.vencimiento === fecha).reduce((s, c) => s + c.monto, 0);
      acumCobros += cobrosDelDia;

      // Pagos que vencen en esta fecha
      const pagosDelDia = pagos.filter(p => p.vencimiento === fecha).reduce((s, p) => s + p.monto, 0);
      acumPagos += pagosDelDia;

      // Gastos recurrentes prorrateados
      acumGastos += gastoDiario;

      dias.push({
        fecha,
        cobrosOpt: acumCobros,
        cobrosBase: acumCobros * 0.8,
        cobrosPes: acumCobros * 0.5,
        pagos: acumPagos,
        gastosRec: acumGastos,
        saldoOpt: saldoActual + acumCobros - acumPagos - acumGastos,
        saldoBase: saldoActual + acumCobros * 0.8 - acumPagos - acumGastos,
        saldoPes: saldoActual + acumCobros * 0.5 - acumPagos - acumGastos,
      });
    }
    return dias;
  }, [cobros, pagos, saldoActual, gastoDiario]);

  // Alertas de saldo negativo
  const alertas = useMemo(() => {
    const result: { escenario: string; fecha: string; color: string }[] = [];
    const pesNeg = proyeccion.find(d => d.saldoPes < 0);
    const baseNeg = proyeccion.find(d => d.saldoBase < 0);
    const optNeg = proyeccion.find(d => d.saldoOpt < 0);
    if (pesNeg) result.push({ escenario: "Pesimista (50%)", fecha: pesNeg.fecha, color: "var(--red)" });
    if (baseNeg) result.push({ escenario: "Base (80%)", fecha: baseNeg.fecha, color: "var(--amber)" });
    if (optNeg) result.push({ escenario: "Optimista (100%)", fecha: optNeg.fecha, color: "var(--red)" });
    return result;
  }, [proyeccion]);

  // Series para gráfico (tomar cada 3 días para no saturar)
  const chartSeries: ChartSeries[] = useMemo(() => {
    const filtered = proyeccion.filter((_, i) => i % 3 === 0 || i === proyeccion.length - 1);
    return [
      { label: "Optimista (100%)", color: "var(--green)", data: filtered.map(d => ({ x: d.fecha, y: d.saldoOpt })), dashed: true, fillColor: "var(--green)" },
      { label: "Base (80%)", color: "var(--cyan)", data: filtered.map(d => ({ x: d.fecha, y: d.saldoBase })) },
      { label: "Pesimista (50%)", color: "var(--red)", data: filtered.map(d => ({ x: d.fecha, y: d.saldoPes })), dashed: true, fillColor: "var(--red)" },
    ];
  }, [proyeccion]);

  // Tabla resumen a 30/60/90 días
  const resumen = useMemo(() => {
    const p30 = proyeccion[30] || proyeccion[proyeccion.length - 1];
    const p60 = proyeccion[60] || proyeccion[proyeccion.length - 1];
    const p90 = proyeccion[90] || proyeccion[proyeccion.length - 1];
    return [
      { label: "Saldo actual", d30: saldoActual, d60: saldoActual, d90: saldoActual },
      { label: "(+) Cobros esperados (base 80%)", d30: p30?.cobrosBase || 0, d60: p60?.cobrosBase || 0, d90: p90?.cobrosBase || 0 },
      { label: "(-) Pagos comprometidos", d30: p30?.pagos || 0, d60: p60?.pagos || 0, d90: p90?.pagos || 0 },
      { label: "(-) Gastos recurrentes", d30: p30?.gastosRec || 0, d60: p60?.gastosRec || 0, d90: p90?.gastosRec || 0 },
      { label: "(=) Saldo proyectado", d30: p30?.saldoBase || 0, d60: p60?.saldoBase || 0, d90: p90?.saldoBase || 0, bold: true },
    ];
  }, [proyeccion, saldoActual]);

  // Exportar Excel
  const handleExport = () => {
    const filas = resumen.map(r => [r.label, fmtMoneyExcel(r.d30), fmtMoneyExcel(r.d60), fmtMoneyExcel(r.d90)]);
    // Agregar detalle de cobros y pagos
    const filasDetalle = [
      ["--- COBROS PENDIENTES ---", "", "", ""],
      ...cobros.map(c => [c.doc, fmtMoneyExcel(c.monto), fmtDate(c.vencimiento), ""]),
      [],
      ["--- PAGOS PENDIENTES ---", "", "", ""],
      ...pagos.map(p => [p.doc, fmtMoneyExcel(p.monto), fmtDate(p.vencimiento), `${p.diasCredito}d crédito`]),
    ];
    exportToExcel({
      titulo: "Flujo Proyectado",
      empresa: empresa.razon_social || "BANVA SPA",
      periodo: `Próximos 90 días desde ${fmtDate(new Date().toISOString().split("T")[0])}`,
      hojas: [
        { nombre: "Resumen", columnas: ["Concepto", "30 días", "60 días", "90 días"], filas },
        { nombre: "Detalle", columnas: ["Documento", "Monto", "Vencimiento", "Crédito"], filas: filasDetalle as (string | number | null)[][] },
      ],
      nombreArchivo: `flujo_proyectado.xlsx`,
    });
  };

  // Actualizar gasto recurrente
  const updateGasto = (idx: number, monto: number) => {
    setGastosRec(prev => {
      const next = [...prev];
      next[idx] = { ...next[idx], montoMensual: monto };
      return next;
    });
  };

  if (loading) return <div style={{ textAlign: "center", padding: 40, color: "var(--txt3)" }}>Cargando...</div>;

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Flujo Proyectado</h2>
          <div style={{ fontSize: 12, color: "var(--txt3)", marginTop: 2 }}>Proyección a 30/60/90 días</div>
        </div>
        <button onClick={handleExport} className="scan-btn blue" style={{ padding: "6px 16px", fontSize: 12 }}>
          Exportar Excel
        </button>
      </div>

      {/* Alertas de saldo negativo */}
      {alertas.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          {alertas.map((a, i) => (
            <div key={i} style={{
              padding: "10px 16px", borderRadius: 10, marginBottom: 6,
              background: "var(--redBg)", border: "1px solid var(--redBd)",
              display: "flex", alignItems: "center", gap: 8,
            }}>
              <span style={{ fontSize: 16 }}>⚠️</span>
              <span style={{ fontSize: 12, color: "var(--red)", fontWeight: 600 }}>
                Escenario {a.escenario}: saldo negativo proyectado el {fmtDate(a.fecha)}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* KPIs */}
      <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(4, 1fr)", marginBottom: 16 }}>
        <div className="kpi" style={{ borderLeft: "3px solid var(--cyan)" }}>
          <div style={{ fontSize: 11, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Saldo Actual</div>
          <div className="mono" style={{ fontSize: 20, fontWeight: 700, color: saldoActual >= 0 ? "var(--cyan)" : "var(--red)" }}>{fmtMoney(saldoActual)}</div>
          <div style={{ fontSize: 11, color: "var(--txt3)" }}>{cuentas.filter(c => c.activa).length} cuenta{cuentas.filter(c => c.activa).length !== 1 ? "s" : ""}</div>
        </div>
        <div className="kpi">
          <div style={{ fontSize: 11, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Por Cobrar</div>
          <div className="mono" style={{ fontSize: 20, fontWeight: 700, color: "var(--green)" }}>{fmtMoney(cobros.reduce((s, c) => s + c.monto, 0))}</div>
          <div style={{ fontSize: 11, color: "var(--txt3)" }}>{cobros.length} factura{cobros.length !== 1 ? "s" : ""}</div>
        </div>
        <div className="kpi">
          <div style={{ fontSize: 11, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Por Pagar</div>
          <div className="mono" style={{ fontSize: 20, fontWeight: 700, color: "var(--red)" }}>{fmtMoney(pagos.reduce((s, p) => s + p.monto, 0))}</div>
          <div style={{ fontSize: 11, color: "var(--txt3)" }}>{pagos.length} factura{pagos.length !== 1 ? "s" : ""}</div>
        </div>
        <div className="kpi">
          <div style={{ fontSize: 11, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Gastos Rec. /mes</div>
          <div className="mono" style={{ fontSize: 20, fontWeight: 700, color: "var(--amber)" }}>{fmtMoney(gastoMensualTotal)}</div>
        </div>
      </div>

      {/* Gráfico */}
      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 12 }}>Proyección de saldo (90 días)</h3>
        <SvgLineChart series={chartSeries} height={300} />
      </div>

      {/* Tabla resumen */}
      <div className="card" style={{ overflow: "hidden", marginBottom: 16 }}>
        <table className="tbl" style={{ fontSize: 12 }}>
          <thead>
            <tr>
              <th style={{ width: "40%" }}>Concepto</th>
              <th style={{ textAlign: "right" }}>30 días</th>
              <th style={{ textAlign: "right" }}>60 días</th>
              <th style={{ textAlign: "right" }}>90 días</th>
            </tr>
          </thead>
          <tbody>
            {resumen.map((r, i) => (
              <tr key={i} style={{ fontWeight: r.bold ? 700 : 400, background: r.bold ? "var(--bg3)" : "transparent" }}>
                <td style={{ color: r.bold ? "var(--txt)" : "var(--txt2)" }}>{r.label}</td>
                <td className="mono" style={{ textAlign: "right", color: r.bold ? (r.d30 >= 0 ? "var(--green)" : "var(--red)") : "var(--txt)" }}>{fmtMoney(r.d30)}</td>
                <td className="mono" style={{ textAlign: "right", color: r.bold ? (r.d60 >= 0 ? "var(--green)" : "var(--red)") : "var(--txt)" }}>{fmtMoney(r.d60)}</td>
                <td className="mono" style={{ textAlign: "right", color: r.bold ? (r.d90 >= 0 ? "var(--green)" : "var(--red)") : "var(--txt)" }}>{fmtMoney(r.d90)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Gastos recurrentes editables */}
      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 12 }}>Gastos recurrentes mensuales</h3>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          {gastosRec.map((g, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: "var(--bg3)", borderRadius: 8 }}>
              <span style={{ fontSize: 12, flex: 1, color: "var(--txt2)" }}>{g.nombre}</span>
              <span style={{ fontSize: 11, color: "var(--txt3)" }}>$</span>
              <input type="number" className="form-input mono" value={g.montoMensual || ""}
                onChange={e => updateGasto(i, Number(e.target.value) || 0)}
                placeholder="0" style={{ width: 100, fontSize: 12, padding: "4px 8px", textAlign: "right" }} />
            </div>
          ))}
        </div>
        <div style={{ marginTop: 8, fontSize: 11, color: "var(--txt3)" }}>
          Total mensual: <span className="mono" style={{ fontWeight: 700, color: "var(--amber)" }}>{fmtMoney(gastoMensualTotal)}</span>
          {" · "}Diario: <span className="mono" style={{ fontWeight: 600 }}>{fmtMoney(Math.round(gastoDiario))}</span>
        </div>
      </div>

      {/* Detalle cobros pendientes */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div className="card" style={{ padding: 14 }}>
          <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 10, color: "var(--green)" }}>
            Cobros pendientes ({cobros.length})
          </h3>
          {cobros.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--txt3)", padding: 16, textAlign: "center" }}>Sin facturas pendientes de cobro</div>
          ) : (
            <div style={{ maxHeight: 250, overflowY: "auto" }}>
              {cobros.slice(0, 20).map((c, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--bg4)", fontSize: 11 }}>
                  <div style={{ color: "var(--txt2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 180 }}>{c.doc}</div>
                  <div style={{ display: "flex", gap: 12 }}>
                    <span className="mono" style={{ color: "var(--txt3)", fontSize: 10 }}>{fmtDate(c.vencimiento)}</span>
                    <span className="mono" style={{ fontWeight: 600, color: "var(--green)" }}>{fmtMoney(c.monto)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card" style={{ padding: 14 }}>
          <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 10, color: "var(--red)" }}>
            Pagos pendientes ({pagos.length})
          </h3>
          {pagos.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--txt3)", padding: 16, textAlign: "center" }}>Sin facturas pendientes de pago</div>
          ) : (
            <div style={{ maxHeight: 250, overflowY: "auto" }}>
              {pagos.slice(0, 20).map((p, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--bg4)", fontSize: 11 }}>
                  <div>
                    <div style={{ color: "var(--txt2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 180 }}>{p.proveedor}</div>
                    <div style={{ fontSize: 9, color: "var(--txt3)" }}>{p.diasCredito}d crédito</div>
                  </div>
                  <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                    <span className="mono" style={{ color: "var(--txt3)", fontSize: 10 }}>{fmtDate(p.vencimiento)}</span>
                    <span className="mono" style={{ fontWeight: 600, color: "var(--red)" }}>{fmtMoney(p.monto)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
