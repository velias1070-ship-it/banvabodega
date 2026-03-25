"use client";
import { useState, useEffect, useMemo } from "react";
import {
  fetchRcvVentas, fetchRcvCompras,
  fetchPlanCuentas, fetchMovimientosBanco,
  fetchProveedorCuentas, fetchConciliaciones,
  upsertProveedorCuenta, categorizarMovimiento,
  fetchPlanCuentasHojas,
} from "@/lib/db";
import type { DBEmpresa, DBRcvCompra, DBRcvVenta, DBPlanCuentas, DBMovimientoBanco, DBProveedorCuenta, DBConciliacion } from "@/lib/db";
import { exportToExcel, fmtMoneyExcel } from "@/lib/exportExcel";

// ==================== HELPERS ====================
const fmtMoney = (n: number) => n.toLocaleString("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });

function periodoAnterior(p: string): string {
  const y = parseInt(p.slice(0, 4));
  const m = parseInt(p.slice(4, 6));
  if (m === 1) return `${y - 1}12`;
  return `${y}${String(m - 1).padStart(2, "0")}`;
}

function formatPeriodo(p: string): string {
  const y = parseInt(p.slice(0, 4));
  const m = parseInt(p.slice(4, 6));
  const d = new Date(y, m - 1, 1);
  const label = d.toLocaleDateString("es-CL", { month: "long", year: "numeric" });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

// Rango de fechas YYYY-MM-DD para un periodo YYYYMM
function periodoRange(p: string): { desde: string; hasta: string } {
  const y = parseInt(p.slice(0, 4));
  const m = parseInt(p.slice(4, 6));
  const lastDay = new Date(y, m, 0).getDate();
  return {
    desde: `${y}-${String(m).padStart(2, "0")}-01`,
    hasta: `${y}-${String(m).padStart(2, "0")}-${lastDay}`,
  };
}

// Tipo de documento legible
const TIPO_DOC: Record<number | string, string> = {
  33: "Factura", 34: "Fact. Exenta", 39: "Boleta", 41: "Boleta Ex.",
  46: "Fact. Compra", 52: "Guía Desp.", 56: "Nota Débito", 61: "Nota Crédito",
};

// Color por tipo de cuenta
const TIPO_STYLE: Record<string, { color: string; bg: string; label: string; signo: string }> = {
  ingreso:           { color: "var(--green)", bg: "var(--greenBg)", label: "INGRESOS",           signo: "+" },
  costo:             { color: "var(--red)",   bg: "var(--redBg)",   label: "COSTOS",              signo: "-" },
  gasto_operacional: { color: "var(--amber)", bg: "var(--amberBg)", label: "GASTOS OPERACIONALES", signo: "-" },
  gasto_no_op:       { color: "var(--blue)",  bg: "var(--blueBg)",  label: "GASTOS NO OPERACIONALES", signo: "-" },
};

// ==================== TIPOS INTERNOS ====================

// Línea del estado de resultados
interface LineaER {
  id: string;
  codigo: string;
  nombre: string;
  tipo: string;
  esHoja: boolean;
  nivel: number;            // 0=sección, 1=subcategoría, 2=cuenta hoja
  montoActual: number;
  montoAnterior: number;
  esSubtotal?: boolean;
  esSeparador?: boolean;
}

// ==================== COMPONENTE ====================

export default function EstadoResultados({ empresa, periodo }: { empresa: DBEmpresa; periodo: string }) {
  const [ventasAct, setVentasAct] = useState<DBRcvVenta[]>([]);
  const [comprasAct, setComprasAct] = useState<DBRcvCompra[]>([]);
  const [ventasAnt, setVentasAnt] = useState<DBRcvVenta[]>([]);
  const [comprasAnt, setComprasAnt] = useState<DBRcvCompra[]>([]);
  const [planCuentas, setPlanCuentas] = useState<DBPlanCuentas[]>([]);
  const [movBanco, setMovBanco] = useState<DBMovimientoBanco[]>([]);
  const [movBancoAnt, setMovBancoAnt] = useState<DBMovimientoBanco[]>([]);
  const [provCuentas, setProvCuentas] = useState<DBProveedorCuenta[]>([]);
  const [conciliaciones, setConciliaciones] = useState<DBConciliacion[]>([]);
  const [cuentasHoja, setCuentasHoja] = useState<DBPlanCuentas[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [assigningId, setAssigningId] = useState<string | null>(null);
  const [assignCuenta, setAssignCuenta] = useState("");

  const pAnt = periodoAnterior(periodo);
  const rangoAct = periodoRange(periodo);
  const rangoAnt = periodoRange(pAnt);

  useEffect(() => {
    if (!empresa.id) return;
    setLoading(true);
    setExpandedRow(null);
    Promise.all([
      fetchRcvVentas(empresa.id, periodo),
      fetchRcvCompras(empresa.id, periodo),
      fetchRcvVentas(empresa.id, pAnt),
      fetchRcvCompras(empresa.id, pAnt),
      fetchPlanCuentas(),
      fetchMovimientosBanco(empresa.id, { desde: rangoAct.desde, hasta: rangoAct.hasta }),
      fetchMovimientosBanco(empresa.id, { desde: rangoAnt.desde, hasta: rangoAnt.hasta }),
      fetchProveedorCuentas(),
      fetchConciliaciones(empresa.id),
      fetchPlanCuentasHojas(),
    ]).then(([va, ca, vant, cant, pc, mb, mbAnt, prc, conc, cHojas]) => {
      setVentasAct(va); setComprasAct(ca);
      setVentasAnt(vant); setComprasAnt(cant);
      setPlanCuentas(pc); setMovBanco(mb); setMovBancoAnt(mbAnt);
      setProvCuentas(prc); setConciliaciones(conc); setCuentasHoja(cHojas);
      setLoading(false);
    });
  }, [empresa.id, periodo]);

  // Construir las líneas del reporte
  const lineas = useMemo((): LineaER[] => {
    const result: LineaER[] = [];

    // Totales por tipo
    const totalIngresosAct = ventasAct.reduce((s, v) => s + (v.monto_total || 0), 0);
    const totalIngresosAnt = ventasAnt.reduce((s, v) => s + (v.monto_total || 0), 0);
    const totalCostosAct = comprasAct.reduce((s, c) => s + (c.monto_total || 0), 0);
    const totalCostosAnt = comprasAnt.reduce((s, c) => s + (c.monto_total || 0), 0);

    // Gastos operacionales clasificados (mov banco con categoria_cuenta_id de tipo gasto_operacional)
    const cuentasGastoOp = new Set(planCuentas.filter(c => c.tipo === "gasto_operacional" && c.es_hoja).map(c => c.id));
    const cuentasGastoNoOp = new Set(planCuentas.filter(c => c.tipo === "gasto_no_op" && c.es_hoja).map(c => c.id));

    const gastosOpAct = movBanco.filter(m => m.monto < 0 && m.categoria_cuenta_id && cuentasGastoOp.has(m.categoria_cuenta_id));
    const gastosOpAnt = movBancoAnt.filter(m => m.monto < 0 && m.categoria_cuenta_id && cuentasGastoOp.has(m.categoria_cuenta_id));
    const gastosNoOpAct = movBanco.filter(m => m.monto < 0 && m.categoria_cuenta_id && cuentasGastoNoOp.has(m.categoria_cuenta_id));
    const gastosNoOpAnt = movBancoAnt.filter(m => m.monto < 0 && m.categoria_cuenta_id && cuentasGastoNoOp.has(m.categoria_cuenta_id));

    const totalGastosOpAct = Math.abs(gastosOpAct.reduce((s, m) => s + m.monto, 0));
    const totalGastosOpAnt = Math.abs(gastosOpAnt.reduce((s, m) => s + m.monto, 0));
    const totalGastosNoOpAct = Math.abs(gastosNoOpAct.reduce((s, m) => s + m.monto, 0));
    const totalGastosNoOpAnt = Math.abs(gastosNoOpAnt.reduce((s, m) => s + m.monto, 0));

    // === INGRESOS ===
    result.push({ id: "sec_ing", codigo: "(+)", nombre: "INGRESOS", tipo: "ingreso", esHoja: false, nivel: 0, montoActual: totalIngresosAct, montoAnterior: totalIngresosAnt, esSeparador: true });

    // Cuentas hoja de tipo ingreso
    const cuentasIngreso = planCuentas.filter(c => c.tipo === "ingreso" && c.es_hoja && c.activa).sort((a, b) => a.codigo.localeCompare(b.codigo));
    for (const cuenta of cuentasIngreso) {
      // Por ahora, todo va a la primera cuenta de ingreso (Ventas ML)
      result.push({
        id: cuenta.id!, codigo: cuenta.codigo, nombre: cuenta.nombre, tipo: "ingreso",
        esHoja: true, nivel: 1,
        montoActual: cuenta === cuentasIngreso[0] ? totalIngresosAct : 0,
        montoAnterior: cuenta === cuentasIngreso[0] ? totalIngresosAnt : 0,
      });
    }
    if (cuentasIngreso.length === 0) {
      result.push({ id: "ing_total", codigo: "", nombre: "Ventas totales", tipo: "ingreso", esHoja: true, nivel: 1, montoActual: totalIngresosAct, montoAnterior: totalIngresosAnt });
    }

    // === COSTOS (agrupados por cuenta del proveedor) ===
    result.push({ id: "sec_cos", codigo: "(-)", nombre: "COSTOS", tipo: "costo", esHoja: false, nivel: 0, montoActual: totalCostosAct, montoAnterior: totalCostosAnt, esSeparador: true });

    // Mapa RUT proveedor → cuenta contable
    const provCuentaMap = new Map(provCuentas.filter(p => p.categoria_cuenta_id).map(p => [p.rut_proveedor, p.categoria_cuenta_id!]));

    // Agrupar compras por cuenta contable
    const costosPorCuenta = new Map<string, { act: number; ant: number }>();
    let sinCuentaCostosAct = 0, sinCuentaCostosAnt = 0;

    for (const c of comprasAct) {
      const cuentaId = provCuentaMap.get(c.rut_proveedor || "");
      if (cuentaId) {
        const prev = costosPorCuenta.get(cuentaId) || { act: 0, ant: 0 };
        prev.act += c.monto_total || 0;
        costosPorCuenta.set(cuentaId, prev);
      } else {
        sinCuentaCostosAct += c.monto_total || 0;
      }
    }
    for (const c of comprasAnt) {
      const cuentaId = provCuentaMap.get(c.rut_proveedor || "");
      if (cuentaId) {
        const prev = costosPorCuenta.get(cuentaId) || { act: 0, ant: 0 };
        prev.ant += c.monto_total || 0;
        costosPorCuenta.set(cuentaId, prev);
      } else {
        sinCuentaCostosAnt += c.monto_total || 0;
      }
    }

    // Mostrar cuentas de costo con montos
    const cuentasCosto = planCuentas.filter(c => c.tipo === "costo" && c.es_hoja && c.activa).sort((a, b) => a.codigo.localeCompare(b.codigo));
    for (const cuenta of cuentasCosto) {
      const montos = costosPorCuenta.get(cuenta.id!) || { act: 0, ant: 0 };
      result.push({
        id: cuenta.id!, codigo: cuenta.codigo, nombre: cuenta.nombre, tipo: "costo",
        esHoja: true, nivel: 1, montoActual: montos.act, montoAnterior: montos.ant,
      });
    }
    // Compras sin cuenta asignada
    if (sinCuentaCostosAct > 0 || sinCuentaCostosAnt > 0) {
      result.push({ id: "cos_sin_cat", codigo: "", nombre: "Sin categorizar", tipo: "costo", esHoja: true, nivel: 1, montoActual: sinCuentaCostosAct, montoAnterior: sinCuentaCostosAnt });
    }
    if (cuentasCosto.length === 0 && sinCuentaCostosAct === 0 && sinCuentaCostosAnt === 0) {
      result.push({ id: "cos_total", codigo: "", nombre: "Compras totales", tipo: "costo", esHoja: true, nivel: 1, montoActual: totalCostosAct, montoAnterior: totalCostosAnt });
    }

    // === MARGEN BRUTO ===
    const margenAct = totalIngresosAct - totalCostosAct;
    const margenAnt = totalIngresosAnt - totalCostosAnt;
    result.push({ id: "margen", codigo: "(=)", nombre: "MARGEN BRUTO", tipo: "ingreso", esHoja: false, nivel: 0, montoActual: margenAct, montoAnterior: margenAnt, esSubtotal: true });

    // === GASTOS OPERACIONALES ===
    result.push({ id: "sec_gop", codigo: "(-)", nombre: "GASTOS OPERACIONALES", tipo: "gasto_operacional", esHoja: false, nivel: 0, montoActual: totalGastosOpAct, montoAnterior: totalGastosOpAnt, esSeparador: true });

    const cuentasGOp = planCuentas.filter(c => c.tipo === "gasto_operacional" && c.es_hoja && c.activa).sort((a, b) => a.codigo.localeCompare(b.codigo));
    for (const cuenta of cuentasGOp) {
      const act = Math.abs(gastosOpAct.filter(m => m.categoria_cuenta_id === cuenta.id).reduce((s, m) => s + m.monto, 0));
      const ant = Math.abs(gastosOpAnt.filter(m => m.categoria_cuenta_id === cuenta.id).reduce((s, m) => s + m.monto, 0));
      result.push({
        id: cuenta.id!, codigo: cuenta.codigo, nombre: cuenta.nombre, tipo: "gasto_operacional",
        esHoja: true, nivel: 1, montoActual: act, montoAnterior: ant,
      });
    }

    // Gastos no clasificados
    const sinClasificarAct = Math.abs(movBanco.filter(m => m.monto < 0 && !m.categoria_cuenta_id).reduce((s, m) => s + m.monto, 0));
    const sinClasificarAnt = Math.abs(movBancoAnt.filter(m => m.monto < 0 && !m.categoria_cuenta_id).reduce((s, m) => s + m.monto, 0));
    if (sinClasificarAct > 0 || sinClasificarAnt > 0) {
      result.push({ id: "sin_cat", codigo: "", nombre: "Sin categorizar", tipo: "gasto_operacional", esHoja: true, nivel: 1, montoActual: sinClasificarAct, montoAnterior: sinClasificarAnt });
    }

    // === RESULTADO OPERACIONAL ===
    const resOpAct = margenAct - totalGastosOpAct;
    const resOpAnt = margenAnt - totalGastosOpAnt;
    result.push({ id: "res_op", codigo: "(=)", nombre: "RESULTADO OPERACIONAL", tipo: "ingreso", esHoja: false, nivel: 0, montoActual: resOpAct, montoAnterior: resOpAnt, esSubtotal: true });

    // === GASTOS NO OPERACIONALES ===
    if (totalGastosNoOpAct > 0 || totalGastosNoOpAnt > 0 || planCuentas.some(c => c.tipo === "gasto_no_op" && c.es_hoja && c.activa)) {
      result.push({ id: "sec_gnop", codigo: "(-)", nombre: "GASTOS NO OPERACIONALES", tipo: "gasto_no_op", esHoja: false, nivel: 0, montoActual: totalGastosNoOpAct, montoAnterior: totalGastosNoOpAnt, esSeparador: true });

      const cuentasGNoOp = planCuentas.filter(c => c.tipo === "gasto_no_op" && c.es_hoja && c.activa).sort((a, b) => a.codigo.localeCompare(b.codigo));
      for (const cuenta of cuentasGNoOp) {
        const act = Math.abs(gastosNoOpAct.filter(m => m.categoria_cuenta_id === cuenta.id).reduce((s, m) => s + m.monto, 0));
        const ant = Math.abs(gastosNoOpAnt.filter(m => m.categoria_cuenta_id === cuenta.id).reduce((s, m) => s + m.monto, 0));
        result.push({ id: cuenta.id!, codigo: cuenta.codigo, nombre: cuenta.nombre, tipo: "gasto_no_op", esHoja: true, nivel: 1, montoActual: act, montoAnterior: ant });
      }

      // === RESULTADO NETO ===
      const resNetoAct = resOpAct - totalGastosNoOpAct;
      const resNetoAnt = resOpAnt - totalGastosNoOpAnt;
      result.push({ id: "res_neto", codigo: "(=)", nombre: "RESULTADO NETO", tipo: "ingreso", esHoja: false, nivel: 0, montoActual: resNetoAct, montoAnterior: resNetoAnt, esSubtotal: true });
    }

    return result;
  }, [ventasAct, comprasAct, ventasAnt, comprasAnt, planCuentas, movBanco, movBancoAnt]);

  // Mapa de conciliaciones: compra_id → conciliación
  const concByCompraId = useMemo(() => {
    const map = new Map<string, DBConciliacion>();
    for (const c of conciliaciones) {
      if (c.rcv_compra_id && c.estado === "confirmado") map.set(c.rcv_compra_id, c);
    }
    return map;
  }, [conciliaciones]);

  // Documentos para drill-down
  const drillDocs = useMemo(() => {
    if (!expandedRow) return [];
    const cuenta = planCuentas.find(c => c.id === expandedRow);

    const mapCompra = (c: DBRcvCompra) => {
      const conc = concByCompraId.get(c.id!);
      return {
        tipo: "Compra", doc: TIPO_DOC[c.tipo_doc] || String(c.tipo_doc),
        nro: c.nro_doc || "—", rut: c.rut_proveedor || "—",
        razon: c.razon_social || "", fecha: c.fecha_docto || "—",
        monto: c.monto_total || 0, nota: c.notas || conc?.notas || "",
        conciliada: !!conc,
      };
    };

    if (!cuenta) {
      if (expandedRow === "ing_total") return ventasAct.map(v => ({ tipo: "Venta", doc: TIPO_DOC[v.tipo_doc] || String(v.tipo_doc), nro: v.folio || v.nro || "—", rut: v.rut_emisor || "—", razon: "", fecha: v.fecha_docto || "—", monto: v.monto_total || 0, nota: "", conciliada: false }));
      if (expandedRow === "cos_total" || expandedRow === "cos_sin_cat") {
        const sinCuentaRuts = new Set(provCuentas.filter(p => p.categoria_cuenta_id).map(p => p.rut_proveedor));
        const filteredCompras = expandedRow === "cos_sin_cat"
          ? comprasAct.filter(c => !sinCuentaRuts.has(c.rut_proveedor || ""))
          : comprasAct;
        return filteredCompras.map(mapCompra);
      }
      // Gastos operacionales sin categorizar
      if (expandedRow === "sin_cat") {
        const movsSinCat = movBanco.filter(m => m.monto < 0 && !m.categoria_cuenta_id);
        return movsSinCat.map(m => {
          const conc = conciliaciones.find(c => c.movimiento_banco_id === m.id && c.estado === "confirmado");
          if (conc?.rcv_compra_id) {
            const compra = comprasAct.find(c => c.id === conc.rcv_compra_id) || comprasAnt.find(c => c.id === conc.rcv_compra_id);
            if (compra) {
              return { tipo: "Compra", doc: TIPO_DOC[compra.tipo_doc] || String(compra.tipo_doc), nro: compra.nro_doc || "—", rut: compra.rut_proveedor || "", razon: compra.razon_social || "", fecha: compra.fecha_docto || "—", monto: Math.abs(m.monto), nota: conc.notas || compra.notas || "", conciliada: true };
            }
          }
          return { tipo: "Banco", doc: m.banco, nro: m.referencia || "—", rut: "", razon: m.descripcion || "", fecha: m.fecha, monto: Math.abs(m.monto), nota: conc?.notas || "", conciliada: !!conc };
        });
      }
      return [];
    }

    if (cuenta.tipo === "ingreso") {
      return ventasAct.map(v => ({ tipo: "Venta", doc: TIPO_DOC[v.tipo_doc] || String(v.tipo_doc), nro: v.folio || v.nro || "—", rut: v.rut_emisor || "—", razon: "", fecha: v.fecha_docto || "—", monto: v.monto_total || 0, nota: "", conciliada: false }));
    }
    if (cuenta.tipo === "costo") {
      const provRuts = provCuentas.filter(p => p.categoria_cuenta_id === cuenta.id).map(p => p.rut_proveedor);
      const rutsSet = new Set(provRuts);
      const filteredCompras = rutsSet.size > 0 ? comprasAct.filter(c => rutsSet.has(c.rut_proveedor || "")) : comprasAct;
      return filteredCompras.map(mapCompra);
    }
    // Gastos: movimientos banco — mostrar factura vinculada si existe
    const movs = movBanco.filter(m => m.monto < 0 && m.categoria_cuenta_id === cuenta.id);
    return movs.map(m => {
      const conc = conciliaciones.find(c => c.movimiento_banco_id === m.id && c.estado === "confirmado");
      // Si está conciliado con una factura de compra, mostrar datos de la factura
      if (conc?.rcv_compra_id) {
        const compra = comprasAct.find(c => c.id === conc.rcv_compra_id) || comprasAnt.find(c => c.id === conc.rcv_compra_id);
        if (compra) {
          return {
            tipo: "Compra", doc: TIPO_DOC[compra.tipo_doc] || String(compra.tipo_doc),
            nro: compra.nro_doc || "—", rut: compra.rut_proveedor || "",
            razon: compra.razon_social || "", fecha: compra.fecha_docto || "—",
            monto: Math.abs(m.monto), nota: conc.notas || compra.notas || "", conciliada: true,
          };
        }
      }
      return { tipo: "Banco", doc: m.banco, nro: m.referencia || "—", rut: "", razon: m.descripcion || "", fecha: m.fecha, monto: Math.abs(m.monto), nota: conc?.notas || "", conciliada: !!conc };
    });
  }, [expandedRow, ventasAct, comprasAct, movBanco, planCuentas, concByCompraId, provCuentas, conciliaciones]);

  // Exportar Excel
  const handleExport = () => {
    const filas = lineas.map(l => {
      const varAbs = l.montoActual - l.montoAnterior;
      const varPct = l.montoAnterior !== 0 ? ((varAbs / Math.abs(l.montoAnterior)) * 100).toFixed(1) + "%" : "—";
      return [
        l.esSubtotal || l.esSeparador ? l.nombre : `  ${l.codigo} ${l.nombre}`,
        fmtMoneyExcel(l.montoActual),
        fmtMoneyExcel(l.montoAnterior),
        fmtMoneyExcel(varAbs),
        varPct,
      ];
    });
    exportToExcel({
      titulo: "Estado de Resultados",
      empresa: empresa.razon_social || "BANVA SPA",
      periodo: formatPeriodo(periodo),
      hojas: [{ nombre: "Estado de Resultados", columnas: ["Cuenta", "Mes Actual", "Mes Anterior", "Var. $", "Var. %"], filas }],
      nombreArchivo: `estado_resultados_${periodo}.xlsx`,
    });
  };

  if (loading) return <div style={{ textAlign: "center", padding: 40, color: "var(--txt3)" }}>Cargando...</div>;

  if (ventasAct.length === 0 && comprasAct.length === 0 && movBanco.length === 0) {
    return (
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Estado de Resultados</h2>
        </div>
        <div className="card" style={{ padding: 32, textAlign: "center" }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>📈</div>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Sin datos para {formatPeriodo(periodo)}</div>
          <div style={{ fontSize: 12, color: "var(--txt3)" }}>Sincroniza el RCV del SII para ver el Estado de Resultados</div>
        </div>
      </div>
    );
  }

  // Margen bruto %
  const totalIngresos = lineas.find(l => l.id === "sec_ing")?.montoActual || 0;
  const margenBruto = lineas.find(l => l.id === "margen")?.montoActual || 0;
  const margenPct = totalIngresos !== 0 ? ((margenBruto / totalIngresos) * 100).toFixed(1) : "0";

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Estado de Resultados</h2>
          <div style={{ fontSize: 12, color: "var(--txt3)", marginTop: 2 }}>{formatPeriodo(periodo)} vs {formatPeriodo(pAnt)}</div>
        </div>
        <button onClick={handleExport} className="scan-btn blue" style={{ padding: "6px 16px", fontSize: 12 }}>
          Exportar Excel
        </button>
      </div>

      {/* KPIs resumen */}
      <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(4, 1fr)", marginBottom: 16 }}>
        <div className="kpi">
          <div style={{ fontSize: 11, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Ingresos</div>
          <div className="mono" style={{ fontSize: 20, fontWeight: 700, color: "var(--green)" }}>{fmtMoney(totalIngresos)}</div>
        </div>
        <div className="kpi">
          <div style={{ fontSize: 11, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Costos</div>
          <div className="mono" style={{ fontSize: 20, fontWeight: 700, color: "var(--red)" }}>{fmtMoney(lineas.find(l => l.id === "sec_cos")?.montoActual || 0)}</div>
        </div>
        <div className="kpi">
          <div style={{ fontSize: 11, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Margen Bruto</div>
          <div className="mono" style={{ fontSize: 20, fontWeight: 700, color: margenBruto >= 0 ? "var(--green)" : "var(--red)" }}>{fmtMoney(margenBruto)}</div>
          <div style={{ fontSize: 11, color: "var(--txt3)" }}>{margenPct}%</div>
        </div>
        <div className="kpi">
          <div style={{ fontSize: 11, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Resultado Op.</div>
          <div className="mono" style={{ fontSize: 20, fontWeight: 700, color: (lineas.find(l => l.id === "res_op")?.montoActual || 0) >= 0 ? "var(--green)" : "var(--red)" }}>
            {fmtMoney(lineas.find(l => l.id === "res_op")?.montoActual || 0)}
          </div>
        </div>
      </div>

      {/* Tabla del estado de resultados */}
      <div className="card" style={{ overflow: "hidden" }}>
        <table className="tbl" style={{ fontSize: 12 }}>
          <thead>
            <tr>
              <th style={{ width: "40%" }}>Cuenta</th>
              <th style={{ textAlign: "right" }}>{formatPeriodo(periodo)}</th>
              <th style={{ textAlign: "right" }}>{formatPeriodo(pAnt)}</th>
              <th style={{ textAlign: "right" }}>Var. $</th>
              <th style={{ textAlign: "right" }}>Var. %</th>
            </tr>
          </thead>
          <tbody>
            {lineas.map(l => {
              const varAbs = l.montoActual - l.montoAnterior;
              const varPct = l.montoAnterior !== 0 ? (varAbs / Math.abs(l.montoAnterior)) * 100 : 0;
              const tipoStyle = TIPO_STYLE[l.tipo] || TIPO_STYLE.ingreso;
              const isExpanded = expandedRow === l.id;
              const canExpand = l.esHoja && (l.montoActual !== 0 || l.montoAnterior !== 0);

              return (
                <tr key={l.id} onClick={() => canExpand && setExpandedRow(isExpanded ? null : l.id)}
                  style={{
                    cursor: canExpand ? "pointer" : "default",
                    background: l.esSubtotal ? "var(--bg3)" : l.esSeparador ? tipoStyle.bg : isExpanded ? "var(--cyanBg)" : "transparent",
                    fontWeight: l.esSubtotal || l.esSeparador ? 700 : 400,
                  }}>
                  <td style={{
                    paddingLeft: l.esSeparador || l.esSubtotal ? 12 : 32,
                    color: l.esSeparador ? tipoStyle.color : l.esSubtotal ? "var(--txt)" : "var(--txt2)",
                  }}>
                    {l.esSeparador || l.esSubtotal ? (
                      <span>{l.codigo} {l.nombre}</span>
                    ) : (
                      <span>
                        <span className="mono" style={{ color: "var(--cyan)", marginRight: 8, fontSize: 10 }}>{l.codigo}</span>
                        {l.nombre}
                        {canExpand && <span style={{ marginLeft: 6, fontSize: 10, color: "var(--txt3)" }}>{isExpanded ? "▼" : "▶"}</span>}
                      </span>
                    )}
                  </td>
                  <td className="mono" style={{ textAlign: "right", fontWeight: l.esSubtotal ? 700 : 600, color: l.esSubtotal ? (l.montoActual >= 0 ? "var(--green)" : "var(--red)") : "var(--txt)" }}>
                    {fmtMoney(l.montoActual)}
                  </td>
                  <td className="mono" style={{ textAlign: "right", color: "var(--txt3)" }}>{fmtMoney(l.montoAnterior)}</td>
                  <td className="mono" style={{ textAlign: "right", color: varAbs >= 0 ? "var(--green)" : "var(--red)" }}>
                    {l.montoActual === 0 && l.montoAnterior === 0 ? "—" : fmtMoney(varAbs)}
                  </td>
                  <td className="mono" style={{ textAlign: "right", color: varPct >= 0 ? "var(--green)" : "var(--red)", fontSize: 11 }}>
                    {l.montoAnterior === 0 ? "—" : `${varPct >= 0 ? "+" : ""}${varPct.toFixed(1)}%`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Drill-down */}
      {expandedRow && drillDocs.length > 0 && (
        <div className="card" style={{ marginTop: 8, padding: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <h4 style={{ fontSize: 13, fontWeight: 600, margin: 0 }}>Detalle: {planCuentas.find(c => c.id === expandedRow)?.nombre || (expandedRow === "cos_sin_cat" || expandedRow === "sin_cat" ? "Sin categorizar" : "Documentos")}</h4>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ fontSize: 11, color: "var(--txt3)" }}>{drillDocs.length} documentos</span>
              {(expandedRow === "cos_sin_cat" || expandedRow === "sin_cat") && (
                <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                  <select value={assignCuenta} onChange={e => setAssignCuenta(e.target.value)}
                    style={{ padding: "3px 6px", fontSize: 10, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", borderRadius: 4 }}>
                    <option value="">— Cuenta —</option>
                    {cuentasHoja.map(c => <option key={c.id} value={c.id!}>{c.codigo} — {c.nombre}</option>)}
                  </select>
                  <button disabled={!assignCuenta} onClick={async () => {
                    if (!assignCuenta) return;
                    // Asignar cuenta a todos los proveedores sin cuenta que aparecen aquí
                    const rutsVistos = new Set<string>();
                    for (const d of drillDocs) {
                      if (!d.rut || rutsVistos.has(d.rut)) continue;
                      rutsVistos.add(d.rut);
                      const pc = provCuentas.find(p => p.rut_proveedor === d.rut);
                      if (!pc?.categoria_cuenta_id) {
                        await upsertProveedorCuenta(d.rut, assignCuenta, d.razon);
                      }
                    }
                    // Asignar cuenta a movimientos conciliados sin cuenta
                    for (const d of drillDocs) {
                      if (!d.conciliada) continue;
                      const conc = conciliaciones.find(c => c.rcv_compra_id && c.estado === "confirmado" &&
                        comprasAct.find(comp => comp.id === c.rcv_compra_id && comp.nro_doc === d.nro));
                      if (conc?.movimiento_banco_id) {
                        await categorizarMovimiento(conc.movimiento_banco_id, assignCuenta);
                      }
                    }
                    // Recargar
                    setLoading(true);
                    const [va, ca, vant, cant, pc2, mb, mbAnt, prc, concs, cH] = await Promise.all([
                      fetchRcvVentas(empresa.id!, periodo), fetchRcvCompras(empresa.id!, periodo),
                      fetchRcvVentas(empresa.id!, pAnt), fetchRcvCompras(empresa.id!, pAnt),
                      fetchPlanCuentas(), fetchMovimientosBanco(empresa.id!, { desde: rangoAct.desde, hasta: rangoAct.hasta }),
                      fetchMovimientosBanco(empresa.id!, { desde: rangoAnt.desde, hasta: rangoAnt.hasta }),
                      fetchProveedorCuentas(), fetchConciliaciones(empresa.id!), fetchPlanCuentasHojas(),
                    ]);
                    setVentasAct(va); setComprasAct(ca); setVentasAnt(vant); setComprasAnt(cant);
                    setPlanCuentas(pc2); setMovBanco(mb); setMovBancoAnt(mbAnt);
                    setProvCuentas(prc); setConciliaciones(concs); setCuentasHoja(cH);
                    setLoading(false); setAssignCuenta("");
                  }}
                    style={{ padding: "3px 10px", borderRadius: 4, fontSize: 10, fontWeight: 600, background: assignCuenta ? "var(--greenBg)" : "var(--bg3)", color: assignCuenta ? "var(--green)" : "var(--txt3)", border: `1px solid ${assignCuenta ? "var(--greenBd)" : "var(--bg4)"}`, cursor: assignCuenta ? "pointer" : "not-allowed" }}>
                    Asignar todo
                  </button>
                </div>
              )}
            </div>
          </div>
          <div style={{ maxHeight: 400, overflowY: "auto" }}>
            <table className="tbl" style={{ fontSize: 11 }}>
              <thead>
                <tr><th>Doc</th><th>N°</th><th>Proveedor</th><th>Fecha</th><th style={{ textAlign: "right" }}>Monto</th><th>Nota</th><th>Pago</th><th>Cuenta</th></tr>
              </thead>
              <tbody>
                {drillDocs.map((d, i) => {
                  const isAssigning = assigningId === `${d.nro}_${i}`;
                  return (
                  <tr key={i}>
                    <td style={{ fontSize: 10, color: "var(--txt3)" }}>{d.doc}</td>
                    <td className="mono" style={{ fontWeight: 600 }}>{d.nro}</td>
                    <td style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.razon || d.rut || "—"}</td>
                    <td className="mono">{d.fecha}</td>
                    <td className="mono" style={{ textAlign: "right", fontWeight: 600 }}>{fmtMoney(d.monto)}</td>
                    <td style={{ fontSize: 10, color: "var(--txt2)", fontStyle: d.nota ? "italic" : "normal", maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.nota || "—"}</td>
                    <td>
                      {d.conciliada ? (
                        <span style={{ fontSize: 9, fontWeight: 600, padding: "1px 5px", borderRadius: 3, background: "var(--greenBg)", color: "var(--green)" }}>PAGADA</span>
                      ) : (
                        <span style={{ fontSize: 9, fontWeight: 600, padding: "1px 5px", borderRadius: 3, background: "var(--amberBg)", color: "var(--amber)" }}>PEND.</span>
                      )}
                    </td>
                    <td>
                      {isAssigning ? (
                        <select autoFocus value="" onChange={async (e) => {
                          if (!e.target.value) return;
                          const newCuentaId = e.target.value;
                          // Actualizar proveedor si tiene RUT y no es variable
                          if (d.rut) {
                            const pc = provCuentas.find(p => p.rut_proveedor === d.rut);
                            if (!pc?.cuenta_variable) {
                              await upsertProveedorCuenta(d.rut, newCuentaId, d.razon);
                              setProvCuentas(prev => {
                                const idx = prev.findIndex(p => p.rut_proveedor === d.rut);
                                const u = { rut_proveedor: d.rut, razon_social: d.razon, categoria_cuenta_id: newCuentaId, plazo_dias: pc?.plazo_dias ?? null };
                                if (idx >= 0) { const n = [...prev]; n[idx] = u; return n; }
                                return [...prev, u];
                              });
                            }
                          }
                          // Actualizar movimiento banco si conciliado
                          if (d.conciliada) {
                            const conc = conciliaciones.find(c => c.estado === "confirmado" && (
                              (c.rcv_compra_id && comprasAct.find(comp => comp.id === c.rcv_compra_id && comp.nro_doc === d.nro)) ||
                              (c.movimiento_banco_id && movBanco.find(m => m.id === c.movimiento_banco_id && m.referencia === d.nro))
                            ));
                            if (conc?.movimiento_banco_id) await categorizarMovimiento(conc.movimiento_banco_id, newCuentaId);
                          }
                          setAssigningId(null);
                        }}
                          onBlur={() => setTimeout(() => setAssigningId(null), 200)}
                          style={{ padding: "2px 4px", fontSize: 9, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", borderRadius: 3, maxWidth: 140 }}>
                          <option value="">Mover a...</option>
                          {cuentasHoja.map(c => <option key={c.id} value={c.id!}>{c.codigo} — {c.nombre}</option>)}
                        </select>
                      ) : (
                        <button onClick={() => setAssigningId(`${d.nro}_${i}`)}
                          style={{ padding: "1px 6px", borderRadius: 3, fontSize: 9, fontWeight: 600, background: "var(--bg3)", color: "var(--cyan)", border: "1px solid var(--bg4)", cursor: "pointer" }}>
                          Mover
                        </button>
                      )}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr style={{ fontWeight: 700, background: "var(--bg3)" }}>
                  <td colSpan={5}>TOTAL</td>
                  <td className="mono" style={{ textAlign: "right" }}>{fmtMoney(drillDocs.reduce((s, d) => s + d.monto, 0))}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
