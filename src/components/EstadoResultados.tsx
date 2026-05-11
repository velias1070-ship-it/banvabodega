"use client";
import { useState, useEffect, useMemo, Fragment } from "react";
import {
  fetchRcvVentas, fetchRcvCompras,
  fetchPlanCuentas, fetchMovimientosBanco,
  fetchProveedorCuentas, fetchConciliaciones,
  categorizarMovimiento,
  fetchPlanCuentasHojas,
  setPeriodoDevengoMovimiento, setPeriodoDevengoCompra,
  setCategoriaCuentaCompra, setIncluirEerrCompra,
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

// Suma N meses al periodo (negativo retrocede)
function periodoOffset(p: string, n: number): string {
  const y = parseInt(p.slice(0, 4));
  const m = parseInt(p.slice(4, 6));
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}${String(nm).padStart(2, "0")}`;
}

// Rango ampliado: trae N meses antes y después para captar overrides y reglas de devengo
function periodoRangeExt(p: string, marginMonths: number): { desde: string; hasta: string } {
  const before = periodoOffset(p, -marginMonths);
  const after = periodoOffset(p, marginMonths);
  const a = periodoRange(before);
  const b = periodoRange(after);
  return { desde: a.desde, hasta: b.hasta };
}

// Convierte fecha YYYY-MM-DD a periodo YYYYMM
function fechaAPeriodo(fecha: string | null | undefined): string {
  if (!fecha) return "";
  return fecha.replace(/-/g, "").slice(0, 6);
}

// Periodo efectivo de un movimiento de banco (override > regla cuenta > mes de la fecha)
function periodoEfectivoMov(m: DBMovimientoBanco, planCuentasMap: Map<string, DBPlanCuentas>): string {
  if (m.periodo_devengo) return m.periodo_devengo;
  const ym = fechaAPeriodo(m.fecha);
  if (!ym) return "";
  const cuenta = m.categoria_cuenta_id ? planCuentasMap.get(m.categoria_cuenta_id) : undefined;
  if (cuenta?.regla_devengo === "mes_anterior") return periodoAnterior(ym);
  return ym;
}

// Cuenta efectiva de una compra: override por factura > default del proveedor (si no es variable)
function cuentaIdDeCompra(c: DBRcvCompra, provCuentaInfo: Map<string, DBProveedorCuenta>): string | undefined {
  if (c.categoria_cuenta_id) return c.categoria_cuenta_id;
  const pc = c.rut_proveedor ? provCuentaInfo.get(c.rut_proveedor) : undefined;
  if (!pc || pc.cuenta_variable) return undefined;
  return pc.categoria_cuenta_id || undefined;
}

// True si el doc se excluye del cómputo del EERR. Prioridad:
//   1. Override por documento (rcv_compras.incluir_eerr): true=incluir, false=excluir
//   2. Default del proveedor (proveedor_cuenta.excluir_eerr)
// Caso típico: ML por periodo 27→26 está excluido por proveedor; una factura
// específica de compra real a ML se "rescata" con incluir_eerr=true.
function compraExcluidaDeEERR(c: DBRcvCompra, provCuentaInfo: Map<string, DBProveedorCuenta>): boolean {
  // BHE/facturas con estado='ANULADA' (Reclamadas en el SII, ver Railway sync) no son gasto real.
  // Antes inflaban el EERR; ahora se excluyen siempre, sin importar incluir_eerr/excluir_eerr.
  if (c.estado === "ANULADA") return true;
  if (c.incluir_eerr === true) return false;
  if (c.incluir_eerr === false) return true;
  const pc = c.rut_proveedor ? provCuentaInfo.get(c.rut_proveedor) : undefined;
  return !!pc?.excluir_eerr;
}

// Periodo efectivo de una compra RCV (override > regla cuenta efectiva > periodo SII)
function periodoEfectivoCompra(c: DBRcvCompra, provCuentaInfo: Map<string, DBProveedorCuenta>, planCuentasMap: Map<string, DBPlanCuentas>): string {
  if (c.periodo_devengo) return c.periodo_devengo;
  const baseYM = c.periodo || fechaAPeriodo(c.fecha_docto);
  if (!baseYM) return "";
  const cuentaId = cuentaIdDeCompra(c, provCuentaInfo);
  const cuenta = cuentaId ? planCuentasMap.get(cuentaId) : undefined;
  if (cuenta?.regla_devengo === "mes_anterior") return periodoAnterior(baseYM);
  return baseYM;
}

// Tipo de documento legible
const TIPO_DOC: Record<number | string, string> = {
  33: "Factura", 34: "Fact. Exenta", 39: "Boleta", 41: "Boleta Ex.",
  46: "Fact. Compra", 52: "Guía Desp.", 56: "Nota Débito", 61: "Nota Crédito",
};

// Signo de la compra para EERR: NC (61) reduce el gasto/costo (devolución del proveedor),
// el resto suma. Las guías de despacho (52) tampoco son gasto financiero, pero
// se ignoran a nivel filtro porque no tienen monto en el RCV.
function signoCompra(tipoDoc: number | string): 1 | -1 {
  const td = typeof tipoDoc === "string" ? parseInt(tipoDoc) : tipoDoc;
  return td === 61 ? -1 : 1;
}
function montoCompra(c: DBRcvCompra): number {
  // Number() porque Supabase devuelve numeric como string; 0 + "X" concatena en otros call sites.
  return Number(c.monto_total || 0) * signoCompra(c.tipo_doc);
}

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

// Documento del drill-down
interface DrillDoc {
  id: string | null;
  tabla: "rcv_compras" | "movimientos_banco" | null;
  periodoDevengo: string | null;
  tipo: string;
  doc: string;
  nro: string;
  rut: string;
  razon: string;
  fecha: string;
  monto: number;
  nota: string;
  conciliada: boolean;
  fechaPago: string | null;   // fecha del mov banco conciliado (cuando se pagó)
  bancoPago: string | null;   // banco/cuenta donde salió el pago
  ncAplicada: boolean;        // tipo_doc=61 con factura_ref_id: ya cumplió su función, no necesita pago
  ncRefFolio: string | null;  // folio de la factura que la NC modifica (para mostrar "NC aplicada a XXX")
}

// ==================== COMPONENTE ====================

export default function EstadoResultados({ empresa, periodo: periodoRaw }: { empresa: DBEmpresa; periodo: string }) {
  // El EERR solo soporta periodos mensuales (YYYYMM). Si llega anual (YYYY)
  // u otro formato, normalizamos al primer mes para no romper periodoAnterior/periodoOffset.
  const periodo = periodoRaw.length === 6 && /^\d{6}$/.test(periodoRaw)
    ? periodoRaw
    : periodoRaw.length === 4 && /^\d{4}$/.test(periodoRaw)
      ? `${periodoRaw}01`
      : periodoRaw;
  const [ventasAct, setVentasAct] = useState<DBRcvVenta[]>([]);
  const [comprasExt, setComprasExt] = useState<DBRcvCompra[]>([]);
  const [ventasAnt, setVentasAnt] = useState<DBRcvVenta[]>([]);
  const [planCuentas, setPlanCuentas] = useState<DBPlanCuentas[]>([]);
  const [movBancoExt, setMovBancoExt] = useState<DBMovimientoBanco[]>([]);
  const [provCuentas, setProvCuentas] = useState<DBProveedorCuenta[]>([]);
  const [conciliaciones, setConciliaciones] = useState<DBConciliacion[]>([]);
  const [cuentasHoja, setCuentasHoja] = useState<DBPlanCuentas[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [assigningId, setAssigningId] = useState<string | null>(null);
  const [assignCuenta, setAssignCuenta] = useState("");
  const [movePeriodoId, setMovePeriodoId] = useState<string | null>(null);
  const [dragItem, setDragItem] = useState<{ id: string | null; tabla: "rcv_compras" | "movimientos_banco" | null; rut: string; razon: string; nro: string; conciliada: boolean } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [vistaDetallada, setVistaDetallada] = useState(false);
  const [verExcluidos, setVerExcluidos] = useState(false);

  const pAnt = periodoAnterior(periodo);
  const rangoExt = periodoRangeExt(periodo, 2);

  const reload = async () => {
    const empresaId = empresa.id;
    if (!empresaId) return;
    setLoading(true);
    const [va, vant, pc, mbExt, prc, conc, cHojas] = await Promise.all([
      fetchRcvVentas(empresaId, periodo),
      fetchRcvVentas(empresaId, pAnt),
      fetchPlanCuentas(),
      fetchMovimientosBanco(empresaId, { desde: rangoExt.desde, hasta: rangoExt.hasta }),
      fetchProveedorCuentas(),
      fetchConciliaciones(empresaId),
      fetchPlanCuentasHojas(),
    ]);
    // Compras: traer ventana extendida (cubre overrides y regla mes_anterior)
    const comprasPorPeriodo = await Promise.all(
      [-2, -1, 0, 1, 2].map(off => fetchRcvCompras(empresaId, periodoOffset(periodo, off)))
    );
    setVentasAct(va); setVentasAnt(vant);
    setPlanCuentas(pc); setMovBancoExt(mbExt);
    setProvCuentas(prc); setConciliaciones(conc); setCuentasHoja(cHojas);
    setComprasExt(comprasPorPeriodo.flat());
    setLoading(false);
  };

  useEffect(() => {
    setExpandedRow(null);
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [empresa.id, periodo]);

  // ---- Updates optimistas: mutamos el state local inmediato y persistimos en background.
  // Evita el flash "Cargando..." al cambiar periodo o cuenta de un documento.
  const handleChangePeriodo = async (d: DrillDoc, val: string | null) => {
    if (!d.id || !d.tabla) return;
    if (d.tabla === "rcv_compras") {
      setComprasExt(prev => prev.map(c => c.id === d.id ? { ...c, periodo_devengo: val } : c));
    } else {
      setMovBancoExt(prev => prev.map(m => m.id === d.id ? { ...m, periodo_devengo: val } : m));
    }
    try {
      if (d.tabla === "movimientos_banco") await setPeriodoDevengoMovimiento(d.id, val);
      else await setPeriodoDevengoCompra(d.id, val);
    } catch (e) {
      console.error("[handleChangePeriodo]", e);
      void reload();
    }
  };

  // Toggle incluir_eerr de un doc del RCV. Optimistic update.
  const handleToggleIncluirEerr = async (compraId: string, incluir: boolean | null) => {
    if (!compraId) return;
    setComprasExt(prev => prev.map(c => c.id === compraId ? { ...c, incluir_eerr: incluir } : c));
    try {
      await setIncluirEerrCompra(compraId, incluir);
    } catch (e) {
      console.error("[handleToggleIncluirEerr]", e);
      void reload();
    }
  };

  const handleChangeCuenta = async (d: DrillDoc, cuentaId: string) => {
    if (!d.id || !d.tabla || !cuentaId) return;
    if (d.tabla === "rcv_compras") {
      setComprasExt(prev => prev.map(c => c.id === d.id ? { ...c, categoria_cuenta_id: cuentaId } : c));
    } else {
      setMovBancoExt(prev => prev.map(m => m.id === d.id ? { ...m, categoria_cuenta_id: cuentaId } : m));
    }
    try {
      if (d.tabla === "rcv_compras") await setCategoriaCuentaCompra(d.id, cuentaId);
      else await categorizarMovimiento(d.id, cuentaId);
    } catch (e) {
      console.error("[handleChangeCuenta]", e);
      void reload();
    }
  };

  // Mapas auxiliares para resolver periodo efectivo y cuenta efectiva
  const planCuentasMap = useMemo(() => new Map(planCuentas.map(c => [c.id!, c])), [planCuentas]);
  const provCuentaInfo = useMemo(
    () => new Map(provCuentas.map(p => [p.rut_proveedor, p])),
    [provCuentas]
  );

  // Filtrado por periodo efectivo
  const movBanco = useMemo(
    () => movBancoExt.filter(m => periodoEfectivoMov(m, planCuentasMap) === periodo),
    [movBancoExt, planCuentasMap, periodo]
  );
  const movBancoAnt = useMemo(
    () => movBancoExt.filter(m => periodoEfectivoMov(m, planCuentasMap) === pAnt),
    [movBancoExt, planCuentasMap, pAnt]
  );
  // Compras del período que SI computan en el EERR (excluye proveedores marcados como excluir_eerr).
  const comprasAct = useMemo(
    () => comprasExt.filter(c => periodoEfectivoCompra(c, provCuentaInfo, planCuentasMap) === periodo && !compraExcluidaDeEERR(c, provCuentaInfo)),
    [comprasExt, provCuentaInfo, planCuentasMap, periodo]
  );
  const comprasAnt = useMemo(
    () => comprasExt.filter(c => periodoEfectivoCompra(c, provCuentaInfo, planCuentasMap) === pAnt && !compraExcluidaDeEERR(c, provCuentaInfo)),
    [comprasExt, provCuentaInfo, planCuentasMap, pAnt]
  );
  // Compras excluidas (solo del periodo actual) para mostrar en sección de auditoría.
  const comprasExcluidas = useMemo(
    () => comprasExt.filter(c => periodoEfectivoCompra(c, provCuentaInfo, planCuentasMap) === periodo && compraExcluidaDeEERR(c, provCuentaInfo)),
    [comprasExt, provCuentaInfo, planCuentasMap, periodo]
  );

  // Construir las líneas del reporte
  const lineas = useMemo((): LineaER[] => {
    const result: LineaER[] = [];

    // Totales por tipo. Number() porque numeric viene como string en JSON de Supabase.
    const totalIngresosAct = ventasAct.reduce((s, v) => s + Number(v.monto_total || 0), 0);
    const totalIngresosAnt = ventasAnt.reduce((s, v) => s + Number(v.monto_total || 0), 0);

    // === Mapas auxiliares ===
    const cuentaTipoOf = (cuentaId: string | null | undefined): string | null => {
      if (!cuentaId) return null;
      return planCuentasMap.get(cuentaId)?.tipo || null;
    };

    // Conciliaciones: compra → mov banco. Permite evitar doble conteo.
    const movByCompraId = new Map<string, string>(); // rcv_compra_id → movimiento_banco_id
    const compraByMovId = new Map<string, string>(); // movimiento_banco_id → rcv_compra_id
    for (const c of conciliaciones) {
      if (c.estado === "confirmado" && c.rcv_compra_id && c.movimiento_banco_id) {
        movByCompraId.set(c.rcv_compra_id, c.movimiento_banco_id);
        compraByMovId.set(c.movimiento_banco_id, c.rcv_compra_id);
      }
    }

    // === Acumuladores por cuenta hoja (act/ant) ===
    const montoPorCuenta = new Map<string, { act: number; ant: number }>();
    const addMonto = (cuentaId: string, key: "act" | "ant", monto: number) => {
      const prev = montoPorCuenta.get(cuentaId) || { act: 0, ant: 0 };
      prev[key] += monto;
      montoPorCuenta.set(cuentaId, prev);
    };

    // Compras "sin categorizar" (sin cuenta del proveedor) → asumidas como costo de mercadería
    let sinCatCostosAct = 0, sinCatCostosAnt = 0;

    // ---- Compras RCV: override por factura > default del proveedor (si no es variable) ----
    // NC (61) entran con signo negativo (reducen el gasto). Resto suma.
    const procesarCompras = (compras: DBRcvCompra[], key: "act" | "ant") => {
      for (const c of compras) {
        const cuentaId = cuentaIdDeCompra(c, provCuentaInfo);
        const m = montoCompra(c);
        if (cuentaId && planCuentasMap.get(cuentaId)) {
          addMonto(cuentaId, key, m);
        } else {
          if (key === "act") sinCatCostosAct += m;
          else sinCatCostosAnt += m;
        }
      }
    };
    procesarCompras(comprasAct, "act");
    procesarCompras(comprasAnt, "ant");

    // ---- Movimientos banco: solo los NO conciliados con factura ya contada ----
    // (si un mov está conciliado a una compra que ya sumó por su cuenta de proveedor, no sumar de nuevo)
    const procesarMovs = (movs: DBMovimientoBanco[], key: "act" | "ant") => {
      for (const m of movs) {
        const monto = Number(m.monto || 0);
        if (monto >= 0) continue;
        const compraId = m.id ? compraByMovId.get(m.id) : undefined;
        if (compraId) continue; // ya contada vía la compra
        if (m.categoria_cuenta_id) {
          addMonto(m.categoria_cuenta_id, key, Math.abs(monto));
        }
        // sin categoría se trata aparte (línea sin_cat)
      }
    };
    procesarMovs(movBanco, "act");
    procesarMovs(movBancoAnt, "ant");

    const sinCatGastosAct = movBanco.reduce(
      (s, m) => s + (Number(m.monto || 0) < 0 && !m.categoria_cuenta_id && (!m.id || !compraByMovId.has(m.id)) ? Math.abs(Number(m.monto || 0)) : 0),
      0,
    );
    const sinCatGastosAnt = movBancoAnt.reduce(
      (s, m) => s + (Number(m.monto || 0) < 0 && !m.categoria_cuenta_id && (!m.id || !compraByMovId.has(m.id)) ? Math.abs(Number(m.monto || 0)) : 0),
      0,
    );

    const cuentasHojaActivas = planCuentas.filter(c => c.es_hoja && c.activa)
      .sort((a, b) => a.codigo.localeCompare(b.codigo));
    const cuentasIngreso  = cuentasHojaActivas.filter(c => c.tipo === "ingreso");
    const cuentasCosto    = cuentasHojaActivas.filter(c => c.tipo === "costo");
    const cuentasGOp      = cuentasHojaActivas.filter(c => c.tipo === "gasto_operacional");
    const cuentasGNoOp    = cuentasHojaActivas.filter(c => c.tipo === "gasto_no_op");

    const sumaSeccion = (cuentas: DBPlanCuentas[], key: "act" | "ant") =>
      cuentas.reduce((s, c) => s + (montoPorCuenta.get(c.id!)?.[key] || 0), 0);

    // Sin clasificar unificado: compras RCV sin cuenta de proveedor + movs banco sin categoria.
    // Se reportan en una unica seccion "POR CLASIFICAR" para que el lector vea cuanta plata
    // real esta sin asignar. Se restan del resultado operacional (es plata que salio).
    const sinCatTotalAct = sinCatCostosAct + sinCatGastosAct;
    const sinCatTotalAnt = sinCatCostosAnt + sinCatGastosAnt;

    const totalCostosAct = sumaSeccion(cuentasCosto, "act");
    const totalCostosAnt = sumaSeccion(cuentasCosto, "ant");
    const totalGastosOpAct = sumaSeccion(cuentasGOp, "act");
    const totalGastosOpAnt = sumaSeccion(cuentasGOp, "ant");
    const totalGastosNoOpAct = sumaSeccion(cuentasGNoOp, "act");
    const totalGastosNoOpAnt = sumaSeccion(cuentasGNoOp, "ant");

    // === INGRESOS ===
    result.push({ id: "sec_ing", codigo: "(+)", nombre: "INGRESOS", tipo: "ingreso", esHoja: false, nivel: 0, montoActual: totalIngresosAct, montoAnterior: totalIngresosAnt, esSeparador: true });

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

    // === COSTOS ===
    result.push({ id: "sec_cos", codigo: "(-)", nombre: "COSTOS", tipo: "costo", esHoja: false, nivel: 0, montoActual: totalCostosAct, montoAnterior: totalCostosAnt, esSeparador: true });

    for (const cuenta of cuentasCosto) {
      const m = montoPorCuenta.get(cuenta.id!) || { act: 0, ant: 0 };
      result.push({
        id: cuenta.id!, codigo: cuenta.codigo, nombre: cuenta.nombre, tipo: "costo",
        esHoja: true, nivel: 1, montoActual: m.act, montoAnterior: m.ant,
      });
    }
    if (cuentasCosto.length === 0) {
      result.push({ id: "cos_total", codigo: "", nombre: "Compras totales", tipo: "costo", esHoja: true, nivel: 1, montoActual: 0, montoAnterior: 0 });
    }

    // === MARGEN BRUTO ===
    const margenAct = totalIngresosAct - totalCostosAct;
    const margenAnt = totalIngresosAnt - totalCostosAnt;
    result.push({ id: "margen", codigo: "(=)", nombre: "MARGEN BRUTO", tipo: "ingreso", esHoja: false, nivel: 0, montoActual: margenAct, montoAnterior: margenAnt, esSubtotal: true });

    // === GASTOS OPERACIONALES ===
    result.push({ id: "sec_gop", codigo: "(-)", nombre: "GASTOS OPERACIONALES", tipo: "gasto_operacional", esHoja: false, nivel: 0, montoActual: totalGastosOpAct, montoAnterior: totalGastosOpAnt, esSeparador: true });

    for (const cuenta of cuentasGOp) {
      const m = montoPorCuenta.get(cuenta.id!) || { act: 0, ant: 0 };
      result.push({
        id: cuenta.id!, codigo: cuenta.codigo, nombre: cuenta.nombre, tipo: "gasto_operacional",
        esHoja: true, nivel: 1, montoActual: m.act, montoAnterior: m.ant,
      });
    }
    // === POR CLASIFICAR === (seccion propia, unificada: compras sin cuenta + movs banco sin categoria)
    if (sinCatTotalAct > 0 || sinCatTotalAnt > 0) {
      result.push({ id: "sec_sin_cat", codigo: "(-)", nombre: "POR CLASIFICAR", tipo: "gasto_operacional", esHoja: false, nivel: 0, montoActual: sinCatTotalAct, montoAnterior: sinCatTotalAnt, esSeparador: true });
      result.push({ id: "sin_cat_unif", codigo: "", nombre: "Sin categorizar", tipo: "gasto_operacional", esHoja: true, nivel: 1, montoActual: sinCatTotalAct, montoAnterior: sinCatTotalAnt });
    }

    // === RESULTADO OPERACIONAL === (incluye sin clasificar como gasto real)
    const resOpAct = margenAct - totalGastosOpAct - sinCatTotalAct;
    const resOpAnt = margenAnt - totalGastosOpAnt - sinCatTotalAnt;
    result.push({ id: "res_op", codigo: "(=)", nombre: "RESULTADO OPERACIONAL", tipo: "ingreso", esHoja: false, nivel: 0, montoActual: resOpAct, montoAnterior: resOpAnt, esSubtotal: true });

    // === GASTOS NO OPERACIONALES ===
    if (totalGastosNoOpAct > 0 || totalGastosNoOpAnt > 0 || cuentasGNoOp.length > 0) {
      result.push({ id: "sec_gnop", codigo: "(-)", nombre: "GASTOS NO OPERACIONALES", tipo: "gasto_no_op", esHoja: false, nivel: 0, montoActual: totalGastosNoOpAct, montoAnterior: totalGastosNoOpAnt, esSeparador: true });

      for (const cuenta of cuentasGNoOp) {
        const m = montoPorCuenta.get(cuenta.id!) || { act: 0, ant: 0 };
        result.push({ id: cuenta.id!, codigo: cuenta.codigo, nombre: cuenta.nombre, tipo: "gasto_no_op", esHoja: true, nivel: 1, montoActual: m.act, montoAnterior: m.ant });
      }

      const resNetoAct = resOpAct - totalGastosNoOpAct;
      const resNetoAnt = resOpAnt - totalGastosNoOpAnt;
      result.push({ id: "res_neto", codigo: "(=)", nombre: "RESULTADO NETO", tipo: "ingreso", esHoja: false, nivel: 0, montoActual: resNetoAct, montoAnterior: resNetoAnt, esSubtotal: true });
    }

    // Suprimir warning de unused (cuentaTipoOf reservado para refactor futuro de drill-down)
    void cuentaTipoOf;
    return result;
  }, [ventasAct, comprasAct, ventasAnt, comprasAnt, planCuentas, planCuentasMap, provCuentaInfo, movBanco, movBancoAnt, conciliaciones]);

  // Mapa de conciliaciones: compra_id → conciliación
  const concByCompraId = useMemo(() => {
    const map = new Map<string, DBConciliacion>();
    for (const c of conciliaciones) {
      if (c.rcv_compra_id && c.estado === "confirmado") map.set(c.rcv_compra_id, c);
    }
    return map;
  }, [conciliaciones]);

  // Documentos para drill-down
  const drillDocs = useMemo((): DrillDoc[] => {
    if (!expandedRow) return [];

    // Mapas conciliación
    const compraByMovId = new Map<string, string>();
    for (const c of conciliaciones) {
      if (c.estado === "confirmado" && c.rcv_compra_id && c.movimiento_banco_id) {
        compraByMovId.set(c.movimiento_banco_id, c.rcv_compra_id);
      }
    }
    // mov banco indexado por id para resolver fecha/banco del pago
    const movById = new Map<string, DBMovimientoBanco>();
    for (const m of movBancoExt) if (m.id) movById.set(m.id, m);

    const mapCompra = (c: DBRcvCompra): DrillDoc => {
      const conc = concByCompraId.get(c.id!);
      const movPago = conc?.movimiento_banco_id ? movById.get(conc.movimiento_banco_id) : undefined;
      // NC con factura_ref_id ya cumplió su función reduciendo la factura referida; no necesita pago.
      const ncAplicada = c.tipo_doc === 61 && !!c.factura_ref_id;
      return {
        id: c.id || null, tabla: "rcv_compras",
        periodoDevengo: c.periodo_devengo || null,
        tipo: "Compra", doc: TIPO_DOC[c.tipo_doc] || String(c.tipo_doc),
        nro: c.nro_doc || "—", rut: c.rut_proveedor || "—",
        razon: c.razon_social || "", fecha: c.fecha_docto || "—",
        monto: montoCompra(c), nota: c.notas || conc?.notas || "",
        conciliada: !!conc,
        fechaPago: movPago?.fecha || null,
        bancoPago: movPago?.banco || null,
        ncAplicada,
        ncRefFolio: ncAplicada ? (c.factura_ref_folio || null) : null,
      };
    };

    const mapMov = (m: DBMovimientoBanco): DrillDoc => {
      const conc = conciliaciones.find(c => c.movimiento_banco_id === m.id && c.estado === "confirmado");
      const meta = (conc?.metadata || {}) as Record<string, unknown>;
      const provManual = typeof meta.proveedor === "string" ? meta.proveedor.trim() : "";
      const descManual = typeof meta.descripcion === "string" ? meta.descripcion.trim() : "";
      const docManual = typeof meta.num_documento === "string" ? meta.num_documento.trim() : "";
      const tipoManual = typeof meta.tipo === "string" ? meta.tipo.trim() : "";
      const notaPartes = [conc?.notas, descManual, docManual ? `Doc: ${docManual}` : "", tipoManual ? `(${tipoManual})` : ""]
        .filter((s): s is string => !!s && s.length > 0);
      return {
        id: m.id || null, tabla: "movimientos_banco",
        periodoDevengo: m.periodo_devengo || null,
        tipo: "Banco", doc: m.banco, nro: m.referencia || "—", rut: "",
        razon: provManual || m.descripcion || "", fecha: m.fecha, monto: Math.abs(m.monto),
        nota: notaPartes.join(" — "), conciliada: !!conc,
        fechaPago: m.fecha,
        bancoPago: m.banco,
        ncAplicada: false,
        ncRefFolio: null,
      };
    };

    // Casos especiales (sin cuenta hoja):
    if (expandedRow === "ing_total") {
      return ventasAct.map(v => ({
        id: v.id || null, tabla: null, periodoDevengo: null,
        tipo: "Venta", doc: TIPO_DOC[v.tipo_doc] || String(v.tipo_doc),
        nro: v.folio || v.nro || "—", rut: v.rut_emisor || "—",
        razon: "", fecha: v.fecha_docto || "—", monto: Number(v.monto_total || 0), nota: "", conciliada: false,
        fechaPago: null, bancoPago: null, ncAplicada: false, ncRefFolio: null,
      }));
    }
    if (expandedRow === "sin_cat_unif") {
      // Unificado: compras RCV sin cuenta del proveedor + movs banco sin categoria.
      // Mismo bucket porque conceptualmente son lo mismo (faltan asignar cuenta), aunque
      // el origen sea distinto (SII vs banco directo).
      const sinCuenta = comprasAct.filter(c => !cuentaIdDeCompra(c, provCuentaInfo));
      const movsSinCat = movBanco.filter(m => m.monto < 0 && !m.categoria_cuenta_id && (!m.id || !compraByMovId.has(m.id)));
      return [...sinCuenta.map(mapCompra), ...movsSinCat.map(mapMov)];
    }

    const cuenta = planCuentas.find(c => c.id === expandedRow);
    if (!cuenta) return [];

    if (cuenta.tipo === "ingreso") {
      return ventasAct.map(v => ({
        id: v.id || null, tabla: null, periodoDevengo: null,
        tipo: "Venta", doc: TIPO_DOC[v.tipo_doc] || String(v.tipo_doc),
        nro: v.folio || v.nro || "—", rut: v.rut_emisor || "—",
        razon: "", fecha: v.fecha_docto || "—", monto: Number(v.monto_total || 0), nota: "", conciliada: false,
        fechaPago: null, bancoPago: null, ncAplicada: false, ncRefFolio: null,
      }));
    }

    // Gastos/costos: unión de compras (vía cuenta efectiva) + movs banco categorizados sin compra ya contada
    const docs: DrillDoc[] = [];
    for (const c of comprasAct) {
      if (cuentaIdDeCompra(c, provCuentaInfo) === cuenta.id) docs.push(mapCompra(c));
    }
    for (const m of movBanco) {
      if (m.monto >= 0) continue;
      if (m.categoria_cuenta_id !== cuenta.id) continue;
      if (m.id && compraByMovId.has(m.id)) continue; // ya contada vía la compra
      docs.push(mapMov(m));
    }
    return docs;
  }, [expandedRow, ventasAct, comprasAct, movBanco, movBancoExt, planCuentas, concByCompraId, provCuentaInfo, conciliaciones]);

  // Para la vista detallada: pre-calcular docs para todas las cuentas hoja a la vez.
  const docsPorCuentaTodas = useMemo((): Map<string, DrillDoc[]> => {
    const out = new Map<string, DrillDoc[]>();
    if (!vistaDetallada) return out;

    const compraByMovId = new Map<string, string>();
    for (const c of conciliaciones) {
      if (c.estado === "confirmado" && c.rcv_compra_id && c.movimiento_banco_id) {
        compraByMovId.set(c.movimiento_banco_id, c.rcv_compra_id);
      }
    }
    const movById = new Map<string, DBMovimientoBanco>();
    for (const m of movBancoExt) if (m.id) movById.set(m.id, m);

    const mapCompra = (c: DBRcvCompra): DrillDoc => {
      const conc = concByCompraId.get(c.id!);
      const movPago = conc?.movimiento_banco_id ? movById.get(conc.movimiento_banco_id) : undefined;
      // NC con factura_ref_id ya cumplió su función reduciendo la factura referida; no necesita pago.
      const ncAplicada = c.tipo_doc === 61 && !!c.factura_ref_id;
      return {
        id: c.id || null, tabla: "rcv_compras",
        periodoDevengo: c.periodo_devengo || null,
        tipo: "Compra", doc: TIPO_DOC[c.tipo_doc] || String(c.tipo_doc),
        nro: c.nro_doc || "—", rut: c.rut_proveedor || "—",
        razon: c.razon_social || "", fecha: c.fecha_docto || "—",
        monto: montoCompra(c), nota: c.notas || conc?.notas || "",
        conciliada: !!conc,
        fechaPago: movPago?.fecha || null,
        bancoPago: movPago?.banco || null,
        ncAplicada,
        ncRefFolio: ncAplicada ? (c.factura_ref_folio || null) : null,
      };
    };

    const mapMov = (m: DBMovimientoBanco): DrillDoc => {
      const conc = conciliaciones.find(c => c.movimiento_banco_id === m.id && c.estado === "confirmado");
      const meta = (conc?.metadata || {}) as Record<string, unknown>;
      const provManual = typeof meta.proveedor === "string" ? meta.proveedor.trim() : "";
      const descManual = typeof meta.descripcion === "string" ? meta.descripcion.trim() : "";
      const docManual = typeof meta.num_documento === "string" ? meta.num_documento.trim() : "";
      const tipoManual = typeof meta.tipo === "string" ? meta.tipo.trim() : "";
      const notaPartes = [conc?.notas, descManual, docManual ? `Doc: ${docManual}` : "", tipoManual ? `(${tipoManual})` : ""]
        .filter((s): s is string => !!s && s.length > 0);
      return {
        id: m.id || null, tabla: "movimientos_banco",
        periodoDevengo: m.periodo_devengo || null,
        tipo: "Banco", doc: m.banco, nro: m.referencia || "—", rut: "",
        razon: provManual || m.descripcion || "", fecha: m.fecha, monto: Math.abs(m.monto),
        nota: notaPartes.join(" — "), conciliada: !!conc,
        fechaPago: m.fecha,
        bancoPago: m.banco,
        ncAplicada: false,
        ncRefFolio: null,
      };
    };

    const cuentasHojaActivas = planCuentas.filter(c => c.es_hoja && c.activa);
    const cuentasIngreso = cuentasHojaActivas.filter(c => c.tipo === "ingreso");

    const ventasAsDocs: DrillDoc[] = ventasAct.map(v => ({
      id: v.id || null, tabla: null, periodoDevengo: null,
      tipo: "Venta", doc: TIPO_DOC[v.tipo_doc] || String(v.tipo_doc),
      nro: v.folio || v.nro || "—", rut: v.rut_emisor || "—",
      razon: "", fecha: v.fecha_docto || "—", monto: Number(v.monto_total || 0), nota: "", conciliada: false,
      fechaPago: null, bancoPago: null, ncAplicada: false, ncRefFolio: null,
    }));
    if (cuentasIngreso.length > 0) {
      out.set(cuentasIngreso[0].id!, ventasAsDocs);
    } else if (ventasAsDocs.length > 0) {
      out.set("ing_total", ventasAsDocs);
    }

    // Sin clasificar unificado (compras RCV sin cuenta + movs banco sin categoria)
    const sinCuentaCompras = comprasAct.filter(c => !cuentaIdDeCompra(c, provCuentaInfo));
    const movsSinCat = movBanco.filter(m => m.monto < 0 && !m.categoria_cuenta_id && (!m.id || !compraByMovId.has(m.id)));
    if (sinCuentaCompras.length > 0 || movsSinCat.length > 0) {
      out.set("sin_cat_unif", [...sinCuentaCompras.map(mapCompra), ...movsSinCat.map(mapMov)]);
    }

    for (const cuenta of cuentasHojaActivas) {
      if (cuenta.tipo === "ingreso") continue;
      const docs: DrillDoc[] = [];
      for (const c of comprasAct) {
        if (cuentaIdDeCompra(c, provCuentaInfo) === cuenta.id) docs.push(mapCompra(c));
      }
      for (const m of movBanco) {
        if (m.monto >= 0) continue;
        if (m.categoria_cuenta_id !== cuenta.id) continue;
        if (m.id && compraByMovId.has(m.id)) continue;
        docs.push(mapMov(m));
      }
      if (docs.length > 0) out.set(cuenta.id!, docs);
    }

    return out;
  }, [vistaDetallada, ventasAct, comprasAct, movBanco, movBancoExt, planCuentas, concByCompraId, provCuentaInfo, conciliaciones]);

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

  // Helper: renderiza la tabla de docs de un grupo (compartido entre drilldown click-to-expand y vista detallada).
  const renderDocsTable = (docs: DrillDoc[], keyPrefix: string) => (
    <table className="tbl" style={{ fontSize: 11, width: "100%" }}>
      <thead>
        <tr><th>Doc</th><th>N°</th><th>Proveedor</th><th>Fecha</th><th style={{ textAlign: "right" }}>Monto</th><th>Nota</th><th>Pago</th><th>Periodo</th><th>Cuenta</th></tr>
      </thead>
      <tbody>
        {docs.map((d, i) => {
          const rowKey = `${keyPrefix}_${d.nro}_${i}`;
          const isAssigning = assigningId === rowKey;
          return (
            <tr key={rowKey} draggable
              onDragStart={() => setDragItem({ id: d.id, tabla: d.tabla, rut: d.rut, razon: d.razon, nro: d.nro, conciliada: d.conciliada })}
              onDragEnd={() => { setDragItem(null); setDropTarget(null); }}
              style={{ cursor: "grab" }}>
              <td style={{ fontSize: 10, color: "var(--txt3)" }}>{d.doc}</td>
              <td className="mono" style={{ fontWeight: 600 }}>{d.nro}</td>
              <td style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.razon || d.rut || "—"}</td>
              <td className="mono">{d.fecha}</td>
              <td className="mono" style={{ textAlign: "right", fontWeight: 600 }}>{fmtMoney(d.monto)}</td>
              <td style={{ fontSize: 10, color: "var(--txt2)", fontStyle: d.nota ? "italic" : "normal", maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.nota || "—"}</td>
              <td>
                {d.conciliada ? (
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
                    {d.fechaPago && (<span className="mono" style={{ fontSize: 9, color: "var(--txt3)" }}>{d.fechaPago}</span>)}
                    <span title={d.bancoPago || ""} style={{ fontSize: 9, fontWeight: 600, padding: "1px 5px", borderRadius: 3, background: "var(--greenBg)", color: "var(--green)" }}>PAGADA</span>
                    {d.bancoPago && (<span style={{ fontSize: 9, color: "var(--txt3)", maxWidth: 100, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.bancoPago}</span>)}
                  </div>
                ) : d.ncAplicada ? (
                  <span title={d.ncRefFolio ? `NC aplicada a factura ${d.ncRefFolio}` : "NC aplicada a factura"}
                    style={{ fontSize: 9, fontWeight: 600, padding: "1px 5px", borderRadius: 3, background: "var(--cyanBg)", color: "var(--cyan)" }}>
                    NC APL.
                  </span>
                ) : (
                  <span style={{ fontSize: 9, fontWeight: 600, padding: "1px 5px", borderRadius: 3, background: "var(--amberBg)", color: "var(--amber)" }}>PEND.</span>
                )}
              </td>
              <td>
                {d.tabla && d.id ? (
                  movePeriodoId === `${d.tabla}_${d.id}` ? (
                    <select autoFocus defaultValue={d.periodoDevengo || ""} onChange={(e) => {
                      const val = e.target.value || null;
                      setMovePeriodoId(null);
                      void handleChangePeriodo(d, val);
                    }} onBlur={() => setTimeout(() => setMovePeriodoId(null), 200)}
                      style={{ padding: "2px 4px", fontSize: 9, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", borderRadius: 3 }}>
                      <option value="">— auto —</option>
                      {[-3,-2,-1,0,1,2].map(off => {
                        const p = periodoOffset(periodo, off);
                        return <option key={p} value={p}>{formatPeriodo(p)}</option>;
                      })}
                    </select>
                  ) : (
                    <button onClick={() => setMovePeriodoId(`${d.tabla}_${d.id}`)}
                      style={{ padding: "1px 6px", borderRadius: 3, fontSize: 9, fontWeight: 600, background: d.periodoDevengo ? "var(--cyanBg)" : "var(--bg3)", color: d.periodoDevengo ? "var(--cyan)" : "var(--txt3)", border: `1px solid ${d.periodoDevengo ? "var(--cyanBd)" : "var(--bg4)"}`, cursor: "pointer" }}
                      title={d.periodoDevengo ? `Override: ${d.periodoDevengo}` : "Mes derivado de la fecha/regla"}>
                      {d.periodoDevengo ? formatPeriodo(d.periodoDevengo).slice(0,3) : "auto"}
                    </button>
                  )
                ) : (
                  <span style={{ fontSize: 9, color: "var(--txt3)" }}>—</span>
                )}
              </td>
              <td>
                {isAssigning ? (
                  <select autoFocus value="" onChange={(e) => {
                    if (!e.target.value) return;
                    const newCuentaId = e.target.value;
                    setAssigningId(null);
                    void handleChangeCuenta(d, newCuentaId);
                  }} onBlur={() => setTimeout(() => setAssigningId(null), 200)}
                    style={{ padding: "2px 4px", fontSize: 9, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", borderRadius: 3, maxWidth: 140 }}>
                    <option value="">Mover a...</option>
                    {cuentasHoja.map(c => <option key={c.id} value={c.id!}>{c.codigo} — {c.nombre}</option>)}
                  </select>
                ) : (
                  <button onClick={() => setAssigningId(rowKey)}
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
          <td colSpan={4}>TOTAL</td>
          <td className="mono" style={{ textAlign: "right" }}>{fmtMoney(docs.reduce((s, d) => s + d.monto, 0))}</td>
          <td colSpan={4}></td>
        </tr>
      </tfoot>
    </table>
  );

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
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => { setVistaDetallada(v => !v); setExpandedRow(null); }}
            className="scan-btn"
            style={{ padding: "6px 16px", fontSize: 12, background: vistaDetallada ? "var(--cyanBg)" : "var(--bg3)", color: vistaDetallada ? "var(--cyan)" : "var(--txt2)", border: `1px solid ${vistaDetallada ? "var(--cyanBd)" : "var(--bg4)"}` }}
            title="Expande todas las cuentas con sus documentos para auditoría">
            {vistaDetallada ? "✓ Vista detallada" : "Vista detallada"}
          </button>
          <button onClick={handleExport} className="scan-btn blue" style={{ padding: "6px 16px", fontSize: 12 }}>
            Exportar Excel
          </button>
        </div>
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
              const docsInline = vistaDetallada && l.esHoja ? docsPorCuentaTodas.get(l.id) : undefined;

              const isDropTarget = dropTarget === l.id && dragItem;
              return (
                <Fragment key={l.id}>
                <tr
                  onClick={() => !vistaDetallada && canExpand && setExpandedRow(isExpanded ? null : l.id)}
                  onDragOver={l.esHoja && !l.esSubtotal ? (e) => { e.preventDefault(); setDropTarget(l.id); } : undefined}
                  onDragLeave={l.esHoja ? () => setDropTarget(null) : undefined}
                  onDrop={l.esHoja && !l.esSubtotal ? (e) => {
                    e.preventDefault();
                    setDropTarget(null);
                    if (!dragItem || !l.id || !dragItem.id || !dragItem.tabla) return;
                    const dragDoc: DrillDoc = {
                      id: dragItem.id, tabla: dragItem.tabla,
                      periodoDevengo: null, tipo: "", doc: "", nro: dragItem.nro,
                      rut: dragItem.rut, razon: dragItem.razon, fecha: "",
                      monto: 0, nota: "", conciliada: dragItem.conciliada,
                      fechaPago: null, bancoPago: null, ncAplicada: false, ncRefFolio: null,
                    };
                    setDragItem(null);
                    void handleChangeCuenta(dragDoc, l.id);
                  } : undefined}
                  style={{
                    cursor: !vistaDetallada && canExpand ? "pointer" : "default",
                    background: isDropTarget ? "var(--cyanBg)" : l.esSubtotal ? "var(--bg3)" : l.esSeparador ? tipoStyle.bg : isExpanded ? "var(--cyanBg)" : "transparent",
                    fontWeight: l.esSubtotal || l.esSeparador ? 700 : 400,
                    outline: isDropTarget ? "2px dashed var(--cyan)" : "none",
                    transition: "background 0.15s, outline 0.15s",
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
                        {canExpand && !vistaDetallada && <span style={{ marginLeft: 6, fontSize: 10, color: "var(--txt3)" }}>{isExpanded ? "▼" : "▶"}</span>}
                        {docsInline && <span style={{ marginLeft: 6, fontSize: 10, color: "var(--txt3)" }}>({docsInline.length})</span>}
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
                {docsInline && docsInline.length > 0 && (
                  <tr>
                    <td colSpan={5} style={{ padding: 0, background: "var(--bg)", borderLeft: `3px solid ${tipoStyle.color}` }}>
                      <div style={{ padding: "8px 16px 12px 32px" }}>
                        {renderDocsTable(docsInline, l.id)}
                      </div>
                    </td>
                  </tr>
                )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Drill-down */}
      {expandedRow && drillDocs.length > 0 && (
        <div className="card" style={{ marginTop: 8, padding: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <h4 style={{ fontSize: 13, fontWeight: 600, margin: 0 }}>Detalle: {planCuentas.find(c => c.id === expandedRow)?.nombre || (expandedRow === "sin_cat_unif" ? "Sin categorizar" : "Documentos")}</h4>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ fontSize: 11, color: "var(--txt3)" }}>{drillDocs.length} documentos</span>
              {expandedRow === "sin_cat_unif" && (
                <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                  <select value={assignCuenta} onChange={e => setAssignCuenta(e.target.value)}
                    style={{ padding: "3px 6px", fontSize: 10, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", borderRadius: 4 }}>
                    <option value="">— Cuenta —</option>
                    {cuentasHoja.map(c => <option key={c.id} value={c.id!}>{c.codigo} — {c.nombre}</option>)}
                  </select>
                  <button disabled={!assignCuenta} onClick={() => {
                    if (!assignCuenta) return;
                    const cuentaId = assignCuenta;
                    const docsToAssign = [...drillDocs];
                    setAssignCuenta("");
                    for (const d of docsToAssign) {
                      void handleChangeCuenta(d, cuentaId);
                    }
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
                <tr><th>Doc</th><th>N°</th><th>Proveedor</th><th>Fecha</th><th style={{ textAlign: "right" }}>Monto</th><th>Nota</th><th>Pago</th><th>Periodo</th><th>Cuenta</th></tr>
              </thead>
              <tbody>
                {drillDocs.map((d, i) => {
                  const isAssigning = assigningId === `${d.nro}_${i}`;
                  return (
                  <tr key={i} draggable
                    onDragStart={() => setDragItem({ id: d.id, tabla: d.tabla, rut: d.rut, razon: d.razon, nro: d.nro, conciliada: d.conciliada })}
                    onDragEnd={() => { setDragItem(null); setDropTarget(null); }}
                    style={{ cursor: "grab" }}>
                    <td style={{ fontSize: 10, color: "var(--txt3)" }}>{d.doc}</td>
                    <td className="mono" style={{ fontWeight: 600 }}>{d.nro}</td>
                    <td style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.razon || d.rut || "—"}</td>
                    <td className="mono">{d.fecha}</td>
                    <td className="mono" style={{ textAlign: "right", fontWeight: 600 }}>{fmtMoney(d.monto)}</td>
                    <td style={{ fontSize: 10, color: "var(--txt2)", fontStyle: d.nota ? "italic" : "normal", maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.nota || "—"}</td>
                    <td>
                      {d.conciliada ? (
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
                          {d.fechaPago && (
                            <span className="mono" style={{ fontSize: 9, color: "var(--txt3)" }}>{d.fechaPago}</span>
                          )}
                          <span title={d.bancoPago || ""}
                            style={{ fontSize: 9, fontWeight: 600, padding: "1px 5px", borderRadius: 3, background: "var(--greenBg)", color: "var(--green)" }}>
                            PAGADA
                          </span>
                          {d.bancoPago && (
                            <span style={{ fontSize: 9, color: "var(--txt3)", maxWidth: 100, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.bancoPago}</span>
                          )}
                        </div>
                      ) : (
                        <span style={{ fontSize: 9, fontWeight: 600, padding: "1px 5px", borderRadius: 3, background: "var(--amberBg)", color: "var(--amber)" }}>PEND.</span>
                      )}
                    </td>
                    <td>
                      {d.tabla && d.id ? (
                        movePeriodoId === `${d.tabla}_${d.id}` ? (
                          <select autoFocus defaultValue={d.periodoDevengo || ""} onChange={(e) => {
                            const val = e.target.value || null;
                            setMovePeriodoId(null);
                            void handleChangePeriodo(d, val);
                          }} onBlur={() => setTimeout(() => setMovePeriodoId(null), 200)}
                            style={{ padding: "2px 4px", fontSize: 9, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", borderRadius: 3 }}>
                            <option value="">— auto —</option>
                            {[-3,-2,-1,0,1,2].map(off => {
                              const p = periodoOffset(periodo, off);
                              return <option key={p} value={p}>{formatPeriodo(p)}</option>;
                            })}
                          </select>
                        ) : (
                          <button onClick={() => setMovePeriodoId(`${d.tabla}_${d.id}`)}
                            style={{ padding: "1px 6px", borderRadius: 3, fontSize: 9, fontWeight: 600, background: d.periodoDevengo ? "var(--cyanBg)" : "var(--bg3)", color: d.periodoDevengo ? "var(--cyan)" : "var(--txt3)", border: `1px solid ${d.periodoDevengo ? "var(--cyanBd)" : "var(--bg4)"}`, cursor: "pointer" }}
                            title={d.periodoDevengo ? `Override: ${d.periodoDevengo}` : "Mes derivado de la fecha/regla"}>
                            {d.periodoDevengo ? formatPeriodo(d.periodoDevengo).slice(0,3) : "auto"}
                          </button>
                        )
                      ) : (
                        <span style={{ fontSize: 9, color: "var(--txt3)" }}>—</span>
                      )}
                    </td>
                    <td>
                      {isAssigning ? (
                        <select autoFocus value="" onChange={(e) => {
                          if (!e.target.value) return;
                          const newCuentaId = e.target.value;
                          setAssigningId(null);
                          void handleChangeCuenta(d, newCuentaId);
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
                  <td colSpan={4}>TOTAL</td>
                  <td className="mono" style={{ textAlign: "right" }}>{fmtMoney(drillDocs.reduce((s, d) => s + d.monto, 0))}</td>
                  <td colSpan={4}></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* Sección de auditoría: docs SII excluidos del cómputo del EERR (típicamente ML por período 27→26). */}
      {comprasExcluidas.length > 0 && (
        <div className="card" style={{ marginTop: 12, padding: 12 }}>
          <button onClick={() => setVerExcluidos(v => !v)}
            style={{ width: "100%", textAlign: "left", background: "transparent", border: "none", cursor: "pointer", padding: 0, color: "var(--txt2)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <span style={{ fontSize: 11, color: "var(--txt3)" }}>{verExcluidos ? "▼" : "▶"}</span>{" "}
                <span style={{ fontSize: 13, fontWeight: 600 }}>Excluidos del EERR</span>
                <span style={{ fontSize: 11, color: "var(--txt3)", marginLeft: 8 }}>
                  ({comprasExcluidas.length} docs · {fmtMoney(comprasExcluidas.reduce((s, c) => s + montoCompra(c), 0))})
                </span>
              </div>
              <span style={{ fontSize: 10, color: "var(--txt3)", fontStyle: "italic" }}>
                Margen ML se gestiona desde ventas_ml_cache (período 27→26 ≠ calendario)
              </span>
            </div>
          </button>
          {verExcluidos && (
            <div style={{ marginTop: 10, maxHeight: 400, overflowY: "auto" }}>
              <table className="tbl" style={{ fontSize: 11 }}>
                <thead>
                  <tr><th>Doc</th><th>N°</th><th>Proveedor</th><th>Fecha</th><th style={{ textAlign: "right" }}>Monto</th><th>Ref</th><th></th></tr>
                </thead>
                <tbody>
                  {comprasExcluidas
                    .slice()
                    .sort((a, b) => (b.fecha_docto || "").localeCompare(a.fecha_docto || ""))
                    .map(c => (
                      <tr key={c.id}>
                        <td style={{ fontSize: 10, color: "var(--txt3)" }}>{TIPO_DOC[c.tipo_doc] || c.tipo_doc}</td>
                        <td className="mono" style={{ fontWeight: 600 }}>{c.nro_doc || "—"}</td>
                        <td style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.razon_social || c.rut_proveedor || "—"}</td>
                        <td className="mono">{c.fecha_docto || "—"}</td>
                        <td className="mono" style={{ textAlign: "right", fontWeight: 600, color: montoCompra(c) < 0 ? "var(--green)" : "var(--txt)" }}>
                          {fmtMoney(montoCompra(c))}
                        </td>
                        <td className="mono" style={{ fontSize: 10, color: "var(--txt3)" }}>
                          {c.factura_ref_folio ? `→ ${c.factura_ref_folio}` : "—"}
                        </td>
                        <td>
                          <button onClick={() => c.id && void handleToggleIncluirEerr(c.id, true)}
                            title="Incluir este documento en el EERR (compra real, no comisión)"
                            style={{ padding: "2px 8px", borderRadius: 3, fontSize: 10, fontWeight: 600, background: "var(--cyanBg)", color: "var(--cyan)", border: "1px solid var(--cyanBd)", cursor: "pointer", whiteSpace: "nowrap" }}>
                            + Incluir
                          </button>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
