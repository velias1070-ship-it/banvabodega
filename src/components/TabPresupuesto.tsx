"use client";
import { useState, useEffect, useMemo, useCallback } from "react";
import { fetchPlanCuentasHojas, fetchPresupuesto, upsertPresupuesto, fetchRcvCompras, fetchRcvVentas } from "@/lib/db";
import type { DBEmpresa, DBPlanCuentas, DBPresupuesto } from "@/lib/db";
import { exportToExcel, fmtMoneyExcel } from "@/lib/exportExcel";

// ==================== HELPERS ====================
const fmtMoney = (n: number) => n.toLocaleString("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
const MESES = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
const MESES_FULL = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];

// Agrupación por tipo
const TIPO_LABELS: Record<string, string> = {
  ingreso: "INGRESOS",
  costo: "COSTOS",
  gasto_operacional: "GASTOS OPERACIONALES",
  gasto_no_op: "GASTOS NO OPERACIONALES",
};
const TIPO_ORDER = ["ingreso", "costo", "gasto_operacional", "gasto_no_op"];

// ==================== COMPONENTE ====================

export default function TabPresupuesto({ empresa, periodo }: { empresa: DBEmpresa; periodo: string }) {
  const [cuentas, setCuentas] = useState<DBPlanCuentas[]>([]);
  const [presupuesto, setPresupuesto] = useState<DBPresupuesto[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [anio, setAnio] = useState(() => parseInt(periodo.slice(0, 4)) || 2026);
  // Mapa editable: "cuentaId-mes" -> monto
  const [edits, setEdits] = useState<Map<string, number>>(new Map());
  // Montos reales del RCV por cuenta+mes
  const [reales, setReales] = useState<Map<string, number>>(new Map());

  const load = useCallback(async () => {
    if (!empresa.id) return;
    setLoading(true);
    const [hojas, pres] = await Promise.all([
      fetchPlanCuentasHojas(),
      fetchPresupuesto(empresa.id, anio),
    ]);
    setCuentas(hojas);
    setPresupuesto(pres);

    // Inicializar edits desde presupuesto guardado
    const map = new Map<string, number>();
    for (const p of pres) {
      map.set(`${p.categoria_cuenta_id}-${p.mes}`, p.monto_presupuestado);
    }
    setEdits(map);

    // Cargar datos reales: RCV compras y ventas para cada mes del año
    const realMap = new Map<string, number>();
    const periodos = Array.from({ length: 12 }, (_, i) => `${anio}${String(i + 1).padStart(2, "0")}`);
    // Cargar todos los periodos en paralelo
    const [ventas, compras] = await Promise.all([
      Promise.all(periodos.map(p => fetchRcvVentas(empresa.id!, p))),
      Promise.all(periodos.map(p => fetchRcvCompras(empresa.id!, p))),
    ]);

    // Agregar ventas por mes (para cuentas tipo ingreso)
    for (let mi = 0; mi < 12; mi++) {
      const totalVentas = ventas[mi].reduce((s, v) => s + (v.monto_total || 0), 0);
      // Asignar a cuentas de ingreso
      for (const c of hojas.filter(h => h.tipo === "ingreso")) {
        const key = `${c.id}-${mi + 1}`;
        realMap.set(key, (realMap.get(key) || 0) + totalVentas / Math.max(hojas.filter(h => h.tipo === "ingreso").length, 1));
      }
      // Agregar compras por mes (para cuentas tipo costo)
      const totalCompras = compras[mi].reduce((s, c) => s + Math.abs(c.monto_total || 0), 0);
      for (const c of hojas.filter(h => h.tipo === "costo")) {
        const key = `${c.id}-${mi + 1}`;
        realMap.set(key, (realMap.get(key) || 0) + totalCompras / Math.max(hojas.filter(h => h.tipo === "costo").length, 1));
      }
    }
    setReales(realMap);
    setLoading(false);
  }, [empresa.id, anio]);

  useEffect(() => { load(); }, [load]);

  // Agrupar cuentas por tipo
  const grouped = useMemo(() => {
    const groups: { tipo: string; label: string; cuentas: DBPlanCuentas[] }[] = [];
    for (const tipo of TIPO_ORDER) {
      const ctas = cuentas.filter(c => c.tipo === tipo);
      if (ctas.length > 0) {
        groups.push({ tipo, label: TIPO_LABELS[tipo] || tipo, cuentas: ctas });
      }
    }
    return groups;
  }, [cuentas]);

  // Mes actual para saber hasta dónde mostrar "Real"
  const mesActual = useMemo(() => {
    const now = new Date();
    return now.getFullYear() === anio ? now.getMonth() + 1 : (now.getFullYear() > anio ? 12 : 0);
  }, [anio]);

  // Handlers
  const handleEdit = (cuentaId: string, mes: number, value: string) => {
    const num = parseInt(value.replace(/\D/g, "")) || 0;
    setEdits(prev => {
      const next = new Map(prev);
      next.set(`${cuentaId}-${mes}`, num);
      return next;
    });
  };

  const getVal = (cuentaId: string, mes: number): number => {
    return edits.get(`${cuentaId}-${mes}`) || 0;
  };

  const getReal = (cuentaId: string, mes: number): number => {
    return reales.get(`${cuentaId}-${mes}`) || 0;
  };

  const totalAnual = (cuentaId: string): number => {
    let sum = 0;
    for (let m = 1; m <= 12; m++) sum += getVal(cuentaId, m);
    return sum;
  };

  const totalMes = (mes: number, tipo?: string): number => {
    const ctas = tipo ? cuentas.filter(c => c.tipo === tipo) : cuentas;
    return ctas.reduce((s, c) => s + getVal(c.id!, mes), 0);
  };

  const totalRealMes = (mes: number, tipo?: string): number => {
    const ctas = tipo ? cuentas.filter(c => c.tipo === tipo) : cuentas;
    return ctas.reduce((s, c) => s + getReal(c.id!, mes), 0);
  };

  // Guardar
  const handleSave = async () => {
    if (!empresa.id) return;
    setSaving(true);
    const items: DBPresupuesto[] = [];
    Array.from(edits.entries()).forEach(([key, monto]) => {
      const [cuentaId, mesStr] = key.split("-");
      if (monto > 0) {
        items.push({
          empresa_id: empresa.id!,
          anio,
          mes: parseInt(mesStr),
          categoria_cuenta_id: cuentaId,
          monto_presupuestado: monto,
        });
      }
    });
    await upsertPresupuesto(items);
    setSaving(false);
  };

  // Exportar Excel
  const handleExport = () => {
    const filas: (string | number | null)[][] = [];
    for (const group of grouped) {
      filas.push([group.label, ...Array(12).fill(""), ""]);
      for (const c of group.cuentas) {
        filas.push([
          `  ${c.codigo} ${c.nombre}`,
          ...Array.from({ length: 12 }, (_, i) => fmtMoneyExcel(getVal(c.id!, i + 1))),
          fmtMoneyExcel(totalAnual(c.id!)),
        ]);
      }
      // Subtotal del grupo
      filas.push([
        `  TOTAL ${group.label}`,
        ...Array.from({ length: 12 }, (_, i) => fmtMoneyExcel(totalMes(i + 1, group.tipo))),
        fmtMoneyExcel(group.cuentas.reduce((s, c) => s + totalAnual(c.id!), 0)),
      ]);
      filas.push([]); // línea vacía
    }

    exportToExcel({
      titulo: "Presupuesto",
      empresa: empresa.razon_social || "BANVA SPA",
      periodo: `Año ${anio}`,
      hojas: [{
        nombre: "Presupuesto",
        columnas: ["Cuenta", ...MESES, "Total Anual"],
        filas,
        anchos: [30, ...Array(12).fill(14), 16],
      }],
      nombreArchivo: `presupuesto_${anio}.xlsx`,
    });
  };

  if (loading) return <div style={{ textAlign: "center", padding: 40, color: "var(--txt3)" }}>Cargando...</div>;

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Presupuesto</h2>
          <select
            value={anio}
            onChange={e => setAnio(parseInt(e.target.value))}
            style={{
              background: "var(--bg3)", border: "1px solid var(--bg4)", borderRadius: 8,
              color: "var(--txt)", padding: "4px 10px", fontSize: 13, cursor: "pointer",
            }}
          >
            {[2024, 2025, 2026, 2027].map(y => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={handleSave} className="scan-btn green" style={{ padding: "6px 16px", fontSize: 12 }} disabled={saving}>
            {saving ? "Guardando..." : "Guardar"}
          </button>
          <button onClick={handleExport} className="scan-btn blue" style={{ padding: "6px 16px", fontSize: 12 }}>
            Exportar Excel
          </button>
        </div>
      </div>

      {cuentas.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: "center" }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>📊</div>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Sin cuentas configuradas</div>
          <div style={{ fontSize: 12, color: "var(--txt3)" }}>Configura el Plan de Cuentas primero para crear presupuestos</div>
        </div>
      ) : (
        <div className="card" style={{ overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table className="tbl" style={{ fontSize: 11, minWidth: 1200 }}>
              <thead>
                <tr>
                  <th style={{ position: "sticky", left: 0, background: "var(--bg2)", zIndex: 2, minWidth: 180 }}>Cuenta</th>
                  {MESES.map((m, i) => (
                    <th key={m} style={{ textAlign: "center", minWidth: 100 }}>
                      <div>{m}</div>
                      {i + 1 <= mesActual && (
                        <div style={{ fontSize: 9, color: "var(--txt3)", fontWeight: 400 }}>Real</div>
                      )}
                    </th>
                  ))}
                  <th style={{ textAlign: "right", minWidth: 100 }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {grouped.map(group => (
                  <GroupRows
                    key={group.tipo}
                    group={group}
                    mesActual={mesActual}
                    getVal={getVal}
                    getReal={getReal}
                    totalAnual={totalAnual}
                    totalMes={totalMes}
                    totalRealMes={totalRealMes}
                    onEdit={handleEdit}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ==================== Sub-componente para filas de grupo ====================

function GroupRows({
  group,
  mesActual,
  getVal,
  getReal,
  totalAnual,
  totalMes,
  totalRealMes,
  onEdit,
}: {
  group: { tipo: string; label: string; cuentas: DBPlanCuentas[] };
  mesActual: number;
  getVal: (cId: string, m: number) => number;
  getReal: (cId: string, m: number) => number;
  totalAnual: (cId: string) => number;
  totalMes: (m: number, tipo?: string) => number;
  totalRealMes: (m: number, tipo?: string) => number;
  onEdit: (cId: string, m: number, v: string) => void;
}) {
  return (
    <>
      {/* Header de grupo */}
      <tr style={{ background: "var(--bg3)" }}>
        <td colSpan={14} style={{
          fontWeight: 700, fontSize: 12, padding: "8px 12px",
          position: "sticky", left: 0, background: "var(--bg3)", zIndex: 1,
          textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--txt2)",
        }}>
          {group.label}
        </td>
      </tr>

      {/* Filas de cuentas */}
      {group.cuentas.map(cuenta => (
        <tr key={cuenta.id}>
          <td style={{
            position: "sticky", left: 0, background: "var(--bg2)", zIndex: 1,
            fontSize: 11, padding: "4px 12px",
          }}>
            <span style={{ color: "var(--txt3)", marginRight: 6 }}>{cuenta.codigo}</span>
            {cuenta.nombre}
          </td>
          {Array.from({ length: 12 }, (_, i) => {
            const mes = i + 1;
            const presVal = getVal(cuenta.id!, mes);
            const realVal = getReal(cuenta.id!, mes);
            const hasReal = mes <= mesActual && realVal > 0;
            const overBudget = hasReal && presVal > 0 && realVal > presVal;
            return (
              <td key={mes} style={{ padding: "2px 4px", textAlign: "center" }}>
                <input
                  type="text"
                  value={presVal > 0 ? presVal.toLocaleString("es-CL") : ""}
                  placeholder="—"
                  onChange={e => onEdit(cuenta.id!, mes, e.target.value)}
                  style={{
                    width: "100%", background: "var(--bg3)", border: "1px solid var(--bg4)",
                    borderRadius: 4, color: "var(--txt)", textAlign: "right", padding: "3px 6px",
                    fontSize: 11, fontFamily: "JetBrains Mono, monospace",
                  }}
                />
                {hasReal && (
                  <div className="mono" style={{
                    fontSize: 9, marginTop: 1,
                    color: overBudget ? "var(--red)" : "var(--green)",
                    fontWeight: 600,
                  }}>
                    {fmtMoney(realVal)}
                  </div>
                )}
              </td>
            );
          })}
          <td className="mono" style={{ textAlign: "right", fontWeight: 600, fontSize: 11, padding: "4px 8px" }}>
            {fmtMoney(totalAnual(cuenta.id!))}
          </td>
        </tr>
      ))}

      {/* Subtotal del grupo */}
      <tr style={{ background: "var(--bg3)", fontWeight: 700 }}>
        <td style={{
          position: "sticky", left: 0, background: "var(--bg3)", zIndex: 1,
          fontSize: 11, padding: "6px 12px",
        }}>
          TOTAL {group.label}
        </td>
        {Array.from({ length: 12 }, (_, i) => {
          const mes = i + 1;
          const tot = totalMes(mes, group.tipo);
          const realTot = totalRealMes(mes, group.tipo);
          const hasReal = mes <= mesActual && realTot > 0;
          return (
            <td key={mes} className="mono" style={{ textAlign: "right", fontSize: 11, padding: "6px 4px" }}>
              <div>{fmtMoney(tot)}</div>
              {hasReal && (
                <div style={{
                  fontSize: 9, color: realTot > tot && tot > 0 ? "var(--red)" : "var(--green)",
                  fontWeight: 600,
                }}>
                  {fmtMoney(realTot)}
                </div>
              )}
            </td>
          );
        })}
        <td className="mono" style={{ textAlign: "right", fontSize: 11, fontWeight: 700, padding: "6px 8px" }}>
          {fmtMoney(group.cuentas.reduce((s, c) => s + totalAnual(c.id!), 0))}
        </td>
      </tr>
    </>
  );
}
