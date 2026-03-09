"use client";
import { useState, useEffect, useMemo, useCallback } from "react";
import { fetchMovimientosBanco, fetchCuentasBancarias } from "@/lib/db";
import type { DBEmpresa, DBMovimientoBanco, DBCuentaBancaria } from "@/lib/db";
import { exportToExcel, fmtMoneyExcel } from "@/lib/exportExcel";
import dynamic from "next/dynamic";
import type { ChartSeries } from "@/components/SvgLineChart";

const SvgLineChart = dynamic(() => import("@/components/SvgLineChart"), { ssr: false });

// ==================== HELPERS ====================
const fmtMoney = (n: number) => n.toLocaleString("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
const fmtDate = (d: string) => {
  const parts = d.split("-");
  return parts.length === 3 ? `${parts[2]}/${parts[1]}` : d;
};

function formatPeriodo(p: string): string {
  const y = parseInt(p.slice(0, 4));
  const m = parseInt(p.slice(4, 6));
  const d = new Date(y, m - 1, 1);
  const label = d.toLocaleDateString("es-CL", { month: "long", year: "numeric" });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function periodoRange(p: string): { desde: string; hasta: string } {
  const y = parseInt(p.slice(0, 4));
  const m = parseInt(p.slice(4, 6));
  const lastDay = new Date(y, m, 0).getDate();
  return {
    desde: `${y}-${String(m).padStart(2, "0")}-01`,
    hasta: `${y}-${String(m).padStart(2, "0")}-${lastDay}`,
  };
}

// ==================== COMPONENTE ====================

export default function FlujoCaja({ empresa, periodo }: { empresa: DBEmpresa; periodo: string }) {
  const [movimientos, setMovimientos] = useState<DBMovimientoBanco[]>([]);
  const [cuentas, setCuentas] = useState<DBCuentaBancaria[]>([]);
  const [loading, setLoading] = useState(true);

  const rango = periodoRange(periodo);

  const load = useCallback(async () => {
    if (!empresa.id) return;
    setLoading(true);
    const [m, c] = await Promise.all([
      fetchMovimientosBanco(empresa.id, { desde: rango.desde, hasta: rango.hasta }),
      fetchCuentasBancarias(empresa.id),
    ]);
    // Ordenar por fecha ascendente para cálculo de saldo
    m.sort((a, b) => (a.fecha || "").localeCompare(b.fecha || ""));
    setMovimientos(m);
    setCuentas(c);
    setLoading(false);
  }, [empresa.id, periodo]);

  useEffect(() => { load(); }, [load]);

  // Cálculos
  const { ingresos, egresos, saldoInicial, saldoFinal, saldoDiario, movConSaldo } = useMemo(() => {
    const ing = movimientos.filter(m => m.monto > 0).reduce((s, m) => s + m.monto, 0);
    const egr = movimientos.filter(m => m.monto < 0).reduce((s, m) => s + m.monto, 0);

    // Saldo inicial: primer saldo conocido del mes, o saldo_actual - movimientos del mes como estimación
    const saldoActualBanco = cuentas.filter(c => c.activa).reduce((s, c) => s + (c.saldo_actual || 0), 0);
    const primerConSaldo = movimientos.find(m => m.saldo !== null && m.saldo !== undefined);
    // Si tenemos primer movimiento con saldo, calcular saldo inicial restando ese movimiento
    let si = 0;
    if (primerConSaldo && primerConSaldo.saldo !== null) {
      si = primerConSaldo.saldo - primerConSaldo.monto;
    } else {
      // Estimación: saldo actual de cuentas bancarias menos todos los movimientos del periodo
      si = saldoActualBanco - ing - egr;
    }

    const sf = si + ing + egr;

    // Saldo diario acumulado para el gráfico
    const dailyMap = new Map<string, number>();
    for (const m of movimientos) {
      const fecha = m.fecha || "";
      dailyMap.set(fecha, (dailyMap.get(fecha) || 0) + m.monto);
    }
    const fechas = Array.from(dailyMap.keys()).sort();
    const daily: { x: string; y: number }[] = [];
    let saldoAcum = si;
    for (const f of fechas) {
      saldoAcum += dailyMap.get(f) || 0;
      daily.push({ x: f, y: saldoAcum });
    }

    // Movimientos con saldo acumulado para la tabla
    const movSaldo: (DBMovimientoBanco & { saldoAcum: number })[] = [];
    let acum = si;
    for (const m of movimientos) {
      acum += m.monto;
      movSaldo.push({ ...m, saldoAcum: acum });
    }

    return { ingresos: ing, egresos: egr, saldoInicial: si, saldoFinal: sf, saldoDiario: daily, movConSaldo: movSaldo };
  }, [movimientos, cuentas]);

  // Serie para el gráfico
  const chartSeries: ChartSeries[] = useMemo(() => {
    if (saldoDiario.length === 0) return [];
    return [{
      label: "Saldo",
      color: "var(--cyan)",
      data: saldoDiario,
      fillColor: "var(--cyan)",
    }];
  }, [saldoDiario]);

  // Exportar Excel
  const handleExport = () => {
    const filas: (string | number | null)[][] = [
      ["Saldo Inicial", fmtMoneyExcel(saldoInicial), "", "", ""],
      [],
      ...movConSaldo.map(m => [
        m.fecha || "—",
        m.descripcion || "—",
        m.monto > 0 ? fmtMoneyExcel(m.monto) : "",
        m.monto < 0 ? fmtMoneyExcel(m.monto) : "",
        fmtMoneyExcel(m.saldoAcum),
      ]),
      [],
      ["TOTALES", "", fmtMoneyExcel(ingresos), fmtMoneyExcel(egresos), fmtMoneyExcel(saldoFinal)],
    ];
    exportToExcel({
      titulo: "Flujo de Caja",
      empresa: empresa.razon_social || "BANVA SPA",
      periodo: formatPeriodo(periodo),
      hojas: [{ nombre: "Flujo de Caja", columnas: ["Fecha", "Descripción", "Ingreso", "Egreso", "Saldo"], filas, anchos: [12, 40, 18, 18, 18] }],
      nombreArchivo: `flujo_caja_${periodo}.xlsx`,
    });
  };

  if (loading) return <div style={{ textAlign: "center", padding: 40, color: "var(--txt3)" }}>Cargando...</div>;

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Flujo de Caja</h2>
          <div style={{ fontSize: 12, color: "var(--txt3)", marginTop: 2 }}>{formatPeriodo(periodo)}</div>
        </div>
        <button onClick={handleExport} className="scan-btn blue" style={{ padding: "6px 16px", fontSize: 12 }}>
          Exportar Excel
        </button>
      </div>

      {/* KPIs */}
      <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(4, 1fr)", marginBottom: 16 }}>
        <div className="kpi">
          <div style={{ fontSize: 11, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Saldo Inicial</div>
          <div className="mono" style={{ fontSize: 20, fontWeight: 700, color: "var(--cyan)" }}>{fmtMoney(saldoInicial)}</div>
        </div>
        <div className="kpi">
          <div style={{ fontSize: 11, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Ingresos</div>
          <div className="mono" style={{ fontSize: 20, fontWeight: 700, color: "var(--green)" }}>{fmtMoney(ingresos)}</div>
          <div style={{ fontSize: 11, color: "var(--txt3)" }}>{movimientos.filter(m => m.monto > 0).length} abonos</div>
        </div>
        <div className="kpi">
          <div style={{ fontSize: 11, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Egresos</div>
          <div className="mono" style={{ fontSize: 20, fontWeight: 700, color: "var(--red)" }}>{fmtMoney(egresos)}</div>
          <div style={{ fontSize: 11, color: "var(--txt3)" }}>{movimientos.filter(m => m.monto < 0).length} cargos</div>
        </div>
        <div className="kpi" style={{ borderLeft: "3px solid var(--cyan)" }}>
          <div style={{ fontSize: 11, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Saldo Final</div>
          <div className="mono" style={{ fontSize: 20, fontWeight: 700, color: saldoFinal >= 0 ? "var(--green)" : "var(--red)" }}>{fmtMoney(saldoFinal)}</div>
        </div>
      </div>

      {/* Gráfico */}
      {chartSeries.length > 0 && chartSeries[0].data.length > 0 && (
        <div className="card" style={{ padding: 16, marginBottom: 16 }}>
          <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 12 }}>Saldo diario</h3>
          <SvgLineChart series={chartSeries} height={260} />
        </div>
      )}

      {/* Tabla de movimientos */}
      {movimientos.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: "center" }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>💰</div>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Sin movimientos bancarios</div>
          <div style={{ fontSize: 12, color: "var(--txt3)" }}>Sube un CSV del banco en la pestaña Banco para ver el flujo de caja</div>
        </div>
      ) : (
        <div className="card" style={{ overflow: "hidden" }}>
          <div style={{ overflowX: "auto", maxHeight: 500 }}>
            <table className="tbl" style={{ fontSize: 11 }}>
              <thead>
                <tr>
                  <th>Fecha</th><th>Descripción</th><th>Banco</th>
                  <th style={{ textAlign: "right" }}>Ingreso</th>
                  <th style={{ textAlign: "right" }}>Egreso</th>
                  <th style={{ textAlign: "right" }}>Saldo</th>
                </tr>
              </thead>
              <tbody>
                {movConSaldo.map((m, i) => (
                  <tr key={m.id || i}>
                    <td className="mono">{fmtDate(m.fecha)}</td>
                    <td style={{ maxWidth: 250, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.descripcion || "—"}</td>
                    <td style={{ fontSize: 10, textTransform: "uppercase", color: "var(--txt3)" }}>{m.banco}</td>
                    <td className="mono" style={{ textAlign: "right", color: "var(--green)", fontWeight: 600 }}>
                      {m.monto > 0 ? fmtMoney(m.monto) : ""}
                    </td>
                    <td className="mono" style={{ textAlign: "right", color: "var(--red)", fontWeight: 600 }}>
                      {m.monto < 0 ? fmtMoney(m.monto) : ""}
                    </td>
                    <td className="mono" style={{ textAlign: "right", fontWeight: 600, color: m.saldoAcum >= 0 ? "var(--txt)" : "var(--red)" }}>
                      {fmtMoney(m.saldoAcum)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ fontWeight: 700, background: "var(--bg3)" }}>
                  <td colSpan={3} style={{ fontSize: 12 }}>TOTALES ({movimientos.length} movimientos)</td>
                  <td className="mono" style={{ textAlign: "right", color: "var(--green)" }}>{fmtMoney(ingresos)}</td>
                  <td className="mono" style={{ textAlign: "right", color: "var(--red)" }}>{fmtMoney(egresos)}</td>
                  <td className="mono" style={{ textAlign: "right", color: saldoFinal >= 0 ? "var(--green)" : "var(--red)" }}>{fmtMoney(saldoFinal)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
