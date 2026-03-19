"use client";
import React, { useState, useEffect, useCallback, useRef } from "react";
import { getStore, saveStore, fmtDate, fmtTime, fmtMoney, skuTotal, skuPositions, skuStockDetalle, posContents, SIN_ETIQUETAR, findProduct, recordMovement, getVentasPorSkuOrigen, editarStockVariante, reasignarFormato, getRecepciones, getRecepcionLineas, getLineasDeRecepciones, getSkusVenta, reconciliarStock, aplicarReconciliacion, initStore, IN_REASONS, OUT_REASONS } from "@/lib/store";
import type { Product, Position, StockDiscrepancia, DBRecepcionLinea, Movement, InReason, OutReason } from "@/lib/store";
import { fetchMovimientosBySku, fetchAllPedidosFlex } from "@/lib/db";

function csvEscape(val: string): string {
  if (!val) return "";
  if (val.includes(",") || val.includes('"') || val.includes("\n")) {
    return '"' + val.replace(/"/g, '""') + '"';
  }
  return val;
}

function Inventario() {
  const [q, setQ] = useState("");
  const [expanded, setExpanded] = useState<string|null>(null);
  const [viewMode, setViewMode] = useState<"fisico"|"ml">("fisico");
  const [soloSinEtiquetar, setSoloSinEtiquetar] = useState(false);
  const [,setTick] = useState(0);
  const refresh = useCallback(() => setTick(t => t + 1), []);
  const s = getStore();
  const [skuMovs, setSkuMovs] = useState<Movement[]>([]);
  const [skuMovsLoading, setSkuMovsLoading] = useState(false);

  useEffect(() => {
    if (!expanded) { setSkuMovs([]); return; }
    let cancelled = false;
    setSkuMovsLoading(true);
    fetchMovimientosBySku(expanded).then(rows => {
      if (cancelled) return;
      setSkuMovs(rows.map(r => ({
        id: r.id || crypto.randomUUID(), sku: r.sku, pos: r.posicion_id, qty: r.cantidad,
        type: r.tipo === "entrada" ? "in" as const : "out" as const,
        reason: r.motivo as any, who: r.operario || "", note: r.nota || "",
        ts: r.created_at || "",
      })));
      setSkuMovsLoading(false);
    }).catch(() => { if (!cancelled) setSkuMovsLoading(false); });
    return () => { cancelled = true; };
  }, [expanded]);

  // Physical stock view (also search by sku_venta via composicion)
  // Include all products (even with 0 stock) + any SKUs in stock not in products
  const allProductSkus = new Set([...Object.keys(s.products), ...Object.keys(s.stock)]);
  const allSkus = Array.from(allProductSkus).filter(sku => {
    if (!q) return true;
    const ql = q.toLowerCase();
    const prod = s.products[sku];
    if (sku.toLowerCase().includes(ql)||prod?.name.toLowerCase().includes(ql)||prod?.cat?.toLowerCase().includes(ql)||prod?.prov?.toLowerCase().includes(ql)) return true;
    // Search by sku_venta (composicion)
    const ventas = getVentasPorSkuOrigen(sku);
    if (ventas.some(v => v.skuVenta.toLowerCase().includes(ql) || v.codigoMl.toLowerCase().includes(ql))) return true;
    // Search in stockDetalle sku_venta keys
    const detalle = skuStockDetalle(sku);
    if (detalle.some(d => d.skuVenta !== SIN_ETIQUETAR && d.skuVenta.toLowerCase().includes(ql))) return true;
    return false;
  }).sort((a,b)=>skuTotal(b)-skuTotal(a));

  // SKUs con stock sin etiquetar
  const skusSinEtiquetar = allSkus.filter(sku => {
    const detalle = skuStockDetalle(sku);
    return detalle.some(d => d.skuVenta === SIN_ETIQUETAR && d.qty > 0);
  });
  const filteredSkus = soloSinEtiquetar ? skusSinEtiquetar : allSkus;
  const grandTotal = filteredSkus.reduce((s,sku)=>s+skuTotal(sku),0);

  // KPIs de etiquetado global
  const etiqGlobal = (() => {
    let etiq = 0, sinEtiq = 0;
    for (const [, svMap] of Object.entries(s.stockDetalle)) {
      for (const [sv, posMap] of Object.entries(svMap)) {
        for (const qty of Object.values(posMap)) {
          if (qty <= 0) continue;
          if (sv === SIN_ETIQUETAR) sinEtiq += qty; else etiq += qty;
        }
      }
    }
    return { etiq, sinEtiq, total: etiq + sinEtiq, pct: etiq + sinEtiq > 0 ? Math.round((etiq / (etiq + sinEtiq)) * 100) : 0 };
  })();

  // ML publication view
  const allVentas = getSkusVenta();
  const ventasConStock = allVentas.map(v => {
    let minDisp = Infinity;
    const comps = v.componentes.map(c => {
      const stock = skuTotal(c.skuOrigen);
      const disp = Math.floor(stock / c.unidades);
      if (disp < minDisp) minDisp = disp;
      return { ...c, stock, disp, nombre: s.products[c.skuOrigen]?.name || c.skuOrigen };
    });
    return { ...v, disponible: minDisp === Infinity ? 0 : minDisp, comps };
  }).filter(v => {
    if (!q) return true;
    const ql = q.toLowerCase();
    return v.skuVenta.toLowerCase().includes(ql) ||
      v.codigoMl.toLowerCase().includes(ql) ||
      v.comps.some(c => c.nombre.toLowerCase().includes(ql) || c.skuOrigen.toLowerCase().includes(ql));
  }).sort((a,b) => b.disponible - a.disponible);
  const totalPublicaciones = ventasConStock.length;
  const conStock = ventasConStock.filter(v => v.disponible > 0).length;
  const sinStock = totalPublicaciones - conStock;

  const [exporting, setExporting] = useState(false);
  const [reclasificando, setReclasificando] = useState(false);
  const [reclasResult, setReclasResult] = useState<{reclasificados:number;detalles:Array<{sku:string;posicion:string;skuVenta:string;qty:number;metodo:string}>}|null>(null);

  // Reconciliación
  const [reconOpen, setReconOpen] = useState(false);
  const [reconLoading, setReconLoading] = useState(false);
  const [reconDiscrep, setReconDiscrep] = useState<StockDiscrepancia[]|null>(null);
  const [reconFixing, setReconFixing] = useState(false);
  const [reconResult, setReconResult] = useState<{fixed:number;errors:string[]}|null>(null);

  const doReconciliar = async () => {
    setReconLoading(true); setReconDiscrep(null); setReconResult(null);
    try {
      const d = await reconciliarStock();
      setReconDiscrep(d);
    } catch (e: unknown) {
      alert("Error al analizar: " + (e instanceof Error ? e.message : String(e)));
    } finally { setReconLoading(false); }
  };

  const doAplicarRecon = async () => {
    if (!reconDiscrep || reconDiscrep.length === 0) return;
    if (!window.confirm(`Se corregirán ${reconDiscrep.length} discrepancias de stock. Los valores se ajustarán para coincidir con el historial de movimientos.\n\nEsta acción NO crea movimientos correctivos (solo ajusta la tabla de stock).\n\n¿Continuar?`)) return;
    setReconFixing(true);
    try {
      const res = await aplicarReconciliacion(reconDiscrep);
      setReconResult(res);
      setReconDiscrep(null);
      await initStore();
      refresh();
    } catch (e: unknown) {
      alert("Error al aplicar: " + (e instanceof Error ? e.message : String(e)));
    } finally { setReconFixing(false); }
  };

  const doReclasificar = async () => {
    if (!window.confirm("Esto reclasificará el stock 'Sin etiquetar' usando los datos de recepción y composiciones de venta. ¿Continuar?")) return;
    setReclasificando(true);
    setReclasResult(null);
    try {
      const res = await fetch("/api/reclasificar-stock", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Error desconocido");
      setReclasResult({ reclasificados: data.reclasificados, detalles: data.detalles || [] });
      // Refresh store to reflect changes
      await initStore();
    } catch (e: unknown) {
      alert("Error al reclasificar: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setReclasificando(false);
    }
  };

  const doExportInventario = async () => {
    setExporting(true);
    try {
      const s = getStore();
      // Fetch active recepciones to calculate pending qty per SKU
      const recepciones = await getRecepciones();
      const activas = recepciones.filter(r => !["COMPLETADA","CERRADA","ANULADA"].includes(r.estado));
      const recIds = activas.map(r => r.id!).filter(Boolean);
      let allLineas: DBRecepcionLinea[] = [];
      if (recIds.length > 0) {
        allLineas = await getLineasDeRecepciones(recIds);
      }
      // Pending per SKU = sum of (qty_factura - qty_ubicada) for lines not fully ubicada
      const pendientePorSku: Record<string, number> = {};
      for (const l of allLineas) {
        if (l.estado === "UBICADA") continue;
        const pending = l.qty_factura - (l.qty_ubicada || 0);
        if (pending > 0) {
          pendientePorSku[l.sku] = (pendientePorSku[l.sku] || 0) + pending;
        }
      }

      const rows: string[] = [];
      rows.push(["sku_origen","nombre","sku_venta","etiquetado","unidades_pack","stock","posicion","pendiente_recepcion","stock_proyectado"].join(","));

      // Detailed rows from stockDetalle: one row per sku_origen + sku_venta + posicion
      const skusExported = new Set<string>();
      for (const [sku, svMap] of Object.entries(s.stockDetalle)) {
        const prod = s.products[sku];
        const name = prod?.name || "";
        const ventas = getVentasPorSkuOrigen(sku);
        skusExported.add(sku);

        for (const [skuVenta, posMap] of Object.entries(svMap)) {
          for (const [pos, qty] of Object.entries(posMap)) {
            if (qty <= 0) continue;
            const isSinEtiquetar = skuVenta === SIN_ETIQUETAR;
            const venta = ventas.find(v => v.skuVenta === skuVenta);
            rows.push([
              csvEscape(sku),
              csvEscape(name),
              csvEscape(isSinEtiquetar ? "" : skuVenta),
              isSinEtiquetar ? "Sin etiquetar" : "Etiquetado",
              venta ? String(venta.unidades) : "",
              String(qty),
              csvEscape(pos),
              "",
              "",
            ].join(","));
          }
        }
      }

      // SKUs in stock but not in stockDetalle (fallback)
      for (const [sku, posMap] of Object.entries(s.stock)) {
        if (s.stockDetalle[sku]) continue;
        const prod = s.products[sku];
        skusExported.add(sku);
        for (const [pos, qty] of Object.entries(posMap)) {
          if (qty <= 0) continue;
          rows.push([
            csvEscape(sku),
            csvEscape(prod?.name || ""),
            "",
            "Sin etiquetar",
            "",
            String(qty),
            csvEscape(pos),
            "",
            "",
          ].join(","));
        }
      }

      // SKUs with pending reception but no current stock
      for (const [sku, pendiente] of Object.entries(pendientePorSku)) {
        if (skusExported.has(sku)) {
          // Add pending as a summary row for this SKU
          const prod = s.products[sku];
          rows.push([
            csvEscape(sku),
            csvEscape(prod?.name || ""),
            "",
            "",
            "",
            "0",
            "",
            String(pendiente),
            String(pendiente),
          ].join(","));
        } else {
          // SKU only has pending, no stock at all
          const prod = s.products[sku];
          rows.push([
            csvEscape(sku),
            csvEscape(prod?.name || ""),
            "",
            "",
            "",
            "0",
            "",
            String(pendiente),
            String(pendiente),
          ].join(","));
        }
      }

      const csv = rows.join("\n");
      const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `banva_inventario_proyectado_${new Date().toISOString().slice(0,10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };

  const doExportFull = () => {
    const s = getStore();
    // Build map: skuVenta → total qty (summing across all positions)
    const skuVentaQty: Record<string, number> = {};
    const skuVentaNombre: Record<string, string> = {};
    // Track which sku_origen have multiple sku_venta
    const origenToVentas: Record<string, string[]> = {};

    // 1. Collect all composicion entries to know sku_origen → sku_venta[]
    for (const sku of Object.keys(s.products)) {
      const ventas = getVentasPorSkuOrigen(sku);
      if (ventas.length > 0) {
        origenToVentas[sku] = ventas.map(v => v.skuVenta);
      }
    }

    // 2. Sum labeled stock per sku_venta from stockDetalle
    for (const [skuOrigen, svMap] of Object.entries(s.stockDetalle)) {
      for (const [sv, posMap] of Object.entries(svMap)) {
        if (sv === SIN_ETIQUETAR) continue;
        const qty = Object.values(posMap).reduce((a, b) => a + b, 0);
        if (qty <= 0) continue;
        skuVentaQty[sv] = (skuVentaQty[sv] || 0) + qty;
        if (!skuVentaNombre[sv]) {
          const prod = s.products[skuOrigen];
          skuVentaNombre[sv] = prod?.name || skuOrigen;
        }
      }
    }

    // 3. For unlabeled stock, if sku_origen has exactly 1 sku_venta, attribute to it
    for (const [skuOrigen, svMap] of Object.entries(s.stockDetalle)) {
      const sinEtiq = svMap[SIN_ETIQUETAR];
      if (!sinEtiq) continue;
      const qty = Object.values(sinEtiq).reduce((a, b) => a + b, 0);
      if (qty <= 0) continue;
      const ventas = origenToVentas[skuOrigen];
      if (ventas && ventas.length === 1) {
        skuVentaQty[ventas[0]] = (skuVentaQty[ventas[0]] || 0) + qty;
      } else if (!ventas || ventas.length === 0) {
        // No composicion — use sku_origen as sku_venta
        skuVentaQty[skuOrigen] = (skuVentaQty[skuOrigen] || 0) + qty;
        if (!skuVentaNombre[skuOrigen]) {
          const prod = s.products[skuOrigen];
          skuVentaNombre[skuOrigen] = prod?.name || "";
        }
      }
      // If multiple ventas, skip unlabeled (can't determine which sku_venta)
    }

    // 4. Also include stock entries NOT in stockDetalle
    for (const [skuOrigen, posMap] of Object.entries(s.stock)) {
      if (s.stockDetalle[skuOrigen]) continue;
      const qty = Object.values(posMap).reduce((a, b) => a + b, 0);
      if (qty <= 0) continue;
      const ventas = origenToVentas[skuOrigen];
      if (ventas && ventas.length === 1) {
        skuVentaQty[ventas[0]] = (skuVentaQty[ventas[0]] || 0) + qty;
        if (!skuVentaNombre[ventas[0]]) {
          const prod = s.products[skuOrigen];
          skuVentaNombre[ventas[0]] = prod?.name || "";
        }
      } else {
        skuVentaQty[skuOrigen] = (skuVentaQty[skuOrigen] || 0) + qty;
        if (!skuVentaNombre[skuOrigen]) {
          const prod = s.products[skuOrigen];
          skuVentaNombre[skuOrigen] = prod?.name || "";
        }
      }
    }

    // 5. Build notes for sku_venta where sku_origen has multiple ventas
    const skuVentaNotas: Record<string, string> = {};
    for (const [skuOrigen, ventasList] of Object.entries(origenToVentas)) {
      if (ventasList.length <= 1) continue;
      const prod = s.products[skuOrigen];
      const prodName = prod?.name || skuOrigen;
      for (const sv of ventasList) {
        const ventas = getVentasPorSkuOrigen(skuOrigen);
        const venta = ventas.find(v => v.skuVenta === sv);
        const uds = venta?.unidades || 1;
        const otrosFormatos = ventasList.filter(v => v !== sv);
        skuVentaNotas[sv] = `SKU origen: ${skuOrigen} (${prodName}) - ${uds}u - Tambien: ${otrosFormatos.join(", ")}`;
      }
    }

    // 6. Generate CSV
    const rows: string[] = [];
    rows.push(["sku_venta","nombre","cantidad","nota"].join(","));
    const sorted = Object.entries(skuVentaQty).sort((a, b) => b[1] - a[1]);
    for (const [sv, qty] of sorted) {
      rows.push([
        csvEscape(sv),
        csvEscape(skuVentaNombre[sv] || ""),
        String(qty),
        csvEscape(skuVentaNotas[sv] || ""),
      ].join(","));
    }

    const csv = rows.join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `banva_stock_full_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const [exportingFlex, setExportingFlex] = useState(false);
  const doExportFlex = async () => {
    setExportingFlex(true);
    try {
      const s = getStore();
      // 1. Build stock per sku_venta (same logic as Exportar Full)
      const skuVentaQty: Record<string, number> = {};
      const skuVentaNombre: Record<string, string> = {};
      const origenToVentas: Record<string, string[]> = {};

      for (const sku of Object.keys(s.products)) {
        const ventas = getVentasPorSkuOrigen(sku);
        if (ventas.length > 0) origenToVentas[sku] = ventas.map(v => v.skuVenta);
      }

      for (const [skuOrigen, svMap] of Object.entries(s.stockDetalle)) {
        for (const [sv, posMap] of Object.entries(svMap)) {
          if (sv === SIN_ETIQUETAR) continue;
          const qty = Object.values(posMap).reduce((a, b) => a + b, 0);
          if (qty <= 0) continue;
          skuVentaQty[sv] = (skuVentaQty[sv] || 0) + qty;
          if (!skuVentaNombre[sv]) {
            const prod = s.products[skuOrigen];
            skuVentaNombre[sv] = prod?.name || skuOrigen;
          }
        }
      }

      for (const [skuOrigen, svMap] of Object.entries(s.stockDetalle)) {
        const sinEtiq = svMap[SIN_ETIQUETAR];
        if (!sinEtiq) continue;
        const qty = Object.values(sinEtiq).reduce((a, b) => a + b, 0);
        if (qty <= 0) continue;
        const ventas = origenToVentas[skuOrigen];
        if (ventas && ventas.length === 1) {
          skuVentaQty[ventas[0]] = (skuVentaQty[ventas[0]] || 0) + qty;
        } else if (!ventas || ventas.length === 0) {
          skuVentaQty[skuOrigen] = (skuVentaQty[skuOrigen] || 0) + qty;
          if (!skuVentaNombre[skuOrigen]) {
            const prod = s.products[skuOrigen];
            skuVentaNombre[skuOrigen] = prod?.name || "";
          }
        }
      }

      for (const [skuOrigen, posMap] of Object.entries(s.stock)) {
        if (s.stockDetalle[skuOrigen]) continue;
        const qty = Object.values(posMap).reduce((a, b) => a + b, 0);
        if (qty <= 0) continue;
        const ventas = origenToVentas[skuOrigen];
        if (ventas && ventas.length === 1) {
          skuVentaQty[ventas[0]] = (skuVentaQty[ventas[0]] || 0) + qty;
          if (!skuVentaNombre[ventas[0]]) {
            const prod = s.products[skuOrigen];
            skuVentaNombre[ventas[0]] = prod?.name || "";
          }
        } else {
          skuVentaQty[skuOrigen] = (skuVentaQty[skuOrigen] || 0) + qty;
          if (!skuVentaNombre[skuOrigen]) {
            const prod = s.products[skuOrigen];
            skuVentaNombre[skuOrigen] = prod?.name || "";
          }
        }
      }

      // 2. Fetch committed stock from pedidos_flex (PENDIENTE + EN_PICKING)
      const allPedidos = await fetchAllPedidosFlex(10000);
      const comprometidoPorSku: Record<string, number> = {};
      for (const p of allPedidos) {
        if (p.estado === "PENDIENTE" || p.estado === "EN_PICKING") {
          comprometidoPorSku[p.sku_venta] = (comprometidoPorSku[p.sku_venta] || 0) + p.cantidad;
        }
      }

      // 3. Generate CSV: sku_venta, nombre, stock_bodega, comprometido, disponible_flex
      const rows: string[] = [];
      rows.push(["sku_venta","nombre","stock_bodega","comprometido","disponible_flex"].join(","));
      const sorted = Object.entries(skuVentaQty).sort((a, b) => b[1] - a[1]);
      for (const [sv, stockBodega] of sorted) {
        const comp = comprometidoPorSku[sv] || 0;
        const disponible = Math.max(0, stockBodega - comp);
        rows.push([
          csvEscape(sv),
          csvEscape(skuVentaNombre[sv] || ""),
          String(stockBodega),
          String(comp),
          String(disponible),
        ].join(","));
      }

      // Include SKUs with committed stock but 0 in warehouse
      for (const [sv, comp] of Object.entries(comprometidoPorSku)) {
        if (skuVentaQty[sv]) continue; // already included
        rows.push([
          csvEscape(sv),
          csvEscape(skuVentaNombre[sv] || ""),
          "0",
          String(comp),
          "0",
        ].join(","));
      }

      const csv = rows.join("\n");
      const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `banva_stock_flex_${new Date().toISOString().slice(0,10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExportingFlex(false);
    }
  };

  return (
    <div>
      <div className="card">
        <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
          <div style={{display:"flex",gap:4}}>
            <button onClick={()=>setViewMode("fisico")} style={{padding:"6px 14px",borderRadius:6,fontSize:11,fontWeight:700,
              background:viewMode==="fisico"?"var(--cyanBg)":"var(--bg3)",color:viewMode==="fisico"?"var(--cyan)":"var(--txt3)",
              border:viewMode==="fisico"?"1px solid var(--cyan)":"1px solid var(--bg4)"}}>📦 Stock Fisico</button>
            <button onClick={()=>setViewMode("ml")} style={{padding:"6px 14px",borderRadius:6,fontSize:11,fontWeight:700,
              background:viewMode==="ml"?"var(--amberBg)":"var(--bg3)",color:viewMode==="ml"?"var(--amber)":"var(--txt3)",
              border:viewMode==="ml"?"1px solid var(--amber)":"1px solid var(--bg4)"}}>🛒 Publicaciones ML</button>
          </div>
          {viewMode === "fisico" && (
            <button onClick={()=>setSoloSinEtiquetar(!soloSinEtiquetar)} style={{padding:"6px 14px",borderRadius:6,fontSize:11,fontWeight:700,
              background:soloSinEtiquetar?"var(--amberBg)":"var(--bg3)",color:soloSinEtiquetar?"var(--amber)":"var(--txt3)",
              border:soloSinEtiquetar?"1px solid var(--amber)":"1px solid var(--bg4)"}}>
              Sin etiquetar ({skusSinEtiquetar.length})
            </button>
          )}
          <button onClick={doExportInventario} disabled={exporting} style={{padding:"6px 14px",borderRadius:6,fontSize:11,fontWeight:700,
            background:"var(--bg3)",color:"var(--green)",border:"1px solid var(--bg4)",cursor:exporting?"wait":"pointer",opacity:exporting?0.6:1}}>
            {exporting ? "Exportando..." : "Exportar Inventario"}
          </button>
          <button onClick={doExportFull} style={{padding:"6px 14px",borderRadius:6,fontSize:11,fontWeight:700,
            background:"var(--bg3)",color:"var(--cyan)",border:"1px solid var(--cyanBd)",cursor:"pointer"}}>
            Exportar Full
          </button>
          <button onClick={doExportFlex} disabled={exportingFlex} style={{padding:"6px 14px",borderRadius:6,fontSize:11,fontWeight:700,
            background:"var(--bg3)",color:"var(--blue)",border:"1px solid var(--bg4)",cursor:exportingFlex?"wait":"pointer",opacity:exportingFlex?0.6:1}}>
            {exportingFlex ? "Exportando..." : "Exportar Flex"}
          </button>
          <button onClick={doReclasificar} disabled={reclasificando} style={{padding:"6px 14px",borderRadius:6,fontSize:11,fontWeight:700,
            background:reclasificando?"var(--bg3)":"var(--amberBg)",color:reclasificando?"var(--txt3)":"var(--amber)",border:"1px solid var(--amberBd)",cursor:reclasificando?"wait":"pointer",opacity:reclasificando?0.6:1}}>
            {reclasificando ? "Reclasificando..." : "Reclasificar formatos"}
          </button>
          <input className="form-input mono" value={q} onChange={e=>setQ(e.target.value)} placeholder={viewMode==="fisico"?"Filtrar SKU, nombre, proveedor...":"Filtrar codigo ML, SKU venta, nombre..."} style={{fontSize:13,flex:1}}/>
          {viewMode === "fisico" && etiqGlobal.total > 0 && (
            <div style={{display:"flex",alignItems:"center",gap:6,padding:"4px 10px",borderRadius:6,background:"var(--bg3)",border:"1px solid var(--bg4)"}}>
              <div style={{width:40,height:40,borderRadius:"50%",background:`conic-gradient(var(--green) ${etiqGlobal.pct*3.6}deg, var(--amber) ${etiqGlobal.pct*3.6}deg)`,display:"flex",alignItems:"center",justifyContent:"center"}}>
                <div style={{width:28,height:28,borderRadius:"50%",background:"var(--bg3)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,fontWeight:800,color:"var(--txt)"}}>{etiqGlobal.pct}%</div>
              </div>
              <div style={{fontSize:10,lineHeight:1.4}}>
                <div style={{color:"var(--green)",fontWeight:700}}>{etiqGlobal.etiq.toLocaleString("es-CL")} etiq.</div>
                <div style={{color:"var(--amber)"}}>{etiqGlobal.sinEtiq.toLocaleString("es-CL")} sin etiq.</div>
              </div>
            </div>
          )}
          <div style={{textAlign:"right",whiteSpace:"nowrap"}}>
            {viewMode === "fisico" ? (
              <>
                <div style={{fontSize:10,color:"var(--txt3)"}}>{filteredSkus.length} SKUs{soloSinEtiquetar ? " sin etiquetar" : ""}</div>
                <div className="mono" style={{fontSize:14,fontWeight:700,color:"var(--blue)"}}>{grandTotal.toLocaleString("es-CL")} uds</div>
              </>
            ) : (
              <>
                <div style={{fontSize:10,color:"var(--txt3)"}}>{totalPublicaciones} publicaciones</div>
                <div style={{fontSize:11}}><span style={{color:"var(--green)",fontWeight:700}}>{conStock} con stock</span> · <span style={{color:"var(--red)"}}>{sinStock} sin stock</span></div>
              </>
            )}
          </div>
        </div>
      </div>

      {reclasResult && (
        <div className="card" style={{background:"var(--bg2)",border:"1px solid var(--amberBd)"}}>
          <div style={{fontSize:12,fontWeight:700,color:"var(--amber)",marginBottom:8}}>
            Reclasificación completada — {reclasResult.reclasificados} registros actualizados
          </div>
          {reclasResult.detalles.length > 0 ? (
            <table className="tbl"><thead><tr><th>SKU</th><th>Posicion</th><th>Formato asignado</th><th style={{textAlign:"right"}}>Qty</th><th>Metodo</th></tr></thead>
              <tbody>{reclasResult.detalles.map((d,i) => (
                <tr key={i}>
                  <td className="mono" style={{fontSize:11}}>{d.sku}</td>
                  <td className="mono" style={{fontSize:11}}>{d.posicion}</td>
                  <td className="mono" style={{fontSize:11,fontWeight:700,color:"var(--cyan)"}}>{d.skuVenta}</td>
                  <td className="mono" style={{textAlign:"right",fontWeight:700}}>{d.qty}</td>
                  <td style={{fontSize:10,color:"var(--txt3)"}}>{d.metodo === "movimiento" ? "Por movimiento" : "Por composicion"}</td>
                </tr>
              ))}</tbody>
            </table>
          ) : (
            <div style={{fontSize:11,color:"var(--txt3)"}}>No se encontraron registros para reclasificar (todo el stock ya tiene formato asignado o no hay datos de recepción)</div>
          )}
          <button onClick={() => setReclasResult(null)} style={{marginTop:8,padding:"4px 12px",borderRadius:4,fontSize:10,background:"var(--bg3)",color:"var(--txt3)",border:"1px solid var(--bg4)"}}>Cerrar</button>
        </div>
      )}

      {/* ===== RECONCILIACIÓN DE STOCK ===== */}
      <div className="card" style={{border: reconOpen ? "1px solid var(--cyanBd)" : "1px solid var(--bg4)"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",cursor:"pointer"}} onClick={()=>setReconOpen(!reconOpen)}>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <span style={{fontSize:16}}>🔍</span>
            <span style={{fontSize:13,fontWeight:700}}>Reconciliar Stock vs Movimientos</span>
            <span style={{fontSize:10,color:"var(--txt3)",background:"var(--bg3)",padding:"2px 8px",borderRadius:4}}>
              Detecta y corrige discrepancias
            </span>
          </div>
          <span style={{fontSize:12,color:"var(--txt3)"}}>{reconOpen ? "▲" : "▼"}</span>
        </div>

        {reconOpen && (
          <div style={{marginTop:12}}>
            <div style={{display:"flex",gap:8,marginBottom:12}}>
              <button onClick={doReconciliar} disabled={reconLoading} style={{padding:"8px 20px",borderRadius:8,background:reconLoading?"var(--bg3)":"var(--cyan)",color:reconLoading?"var(--txt3)":"#fff",fontSize:12,fontWeight:700,cursor:reconLoading?"wait":"pointer"}}>
                {reconLoading ? "Analizando..." : "Analizar discrepancias"}
              </button>
              {reconDiscrep && reconDiscrep.length > 0 && (
                <button onClick={doAplicarRecon} disabled={reconFixing} style={{padding:"8px 20px",borderRadius:8,background:reconFixing?"var(--bg3)":"var(--red)",color:reconFixing?"var(--txt3)":"#fff",fontSize:12,fontWeight:700,cursor:reconFixing?"wait":"pointer"}}>
                  {reconFixing ? "Corrigiendo..." : `Corregir ${reconDiscrep.length} discrepancias`}
                </button>
              )}
            </div>

            {reconDiscrep !== null && reconDiscrep.length === 0 && (
              <div style={{padding:16,textAlign:"center",color:"var(--green)",fontSize:13,fontWeight:600}}>
                Todo OK — El stock coincide con los movimientos registrados
              </div>
            )}

            {reconDiscrep && reconDiscrep.length > 0 && (
              <div>
                <div style={{fontSize:11,color:"var(--amber)",marginBottom:8,fontWeight:600}}>
                  {reconDiscrep.length} discrepancias encontradas — Stock total erróneo: {reconDiscrep.reduce((s,d)=>s+Math.abs(d.diferencia),0)} uds
                </div>
                <div style={{maxHeight:400,overflow:"auto"}}>
                  <table className="tbl"><thead><tr>
                    <th>SKU</th><th>Producto</th><th>Posición</th>
                    <th style={{textAlign:"right"}}>Stock actual</th>
                    <th style={{textAlign:"right"}}>Según movim.</th>
                    <th style={{textAlign:"right"}}>Diferencia</th>
                  </tr></thead>
                  <tbody>{reconDiscrep.map((d,i)=>(
                    <tr key={i}>
                      <td className="mono" style={{fontSize:11,fontWeight:700}}>{d.sku}</td>
                      <td style={{fontSize:11,color:"var(--txt2)",maxWidth:200,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{d.nombre}</td>
                      <td className="mono" style={{fontSize:11}}>{d.posicion}</td>
                      <td className="mono" style={{textAlign:"right",fontWeight:700,color:"var(--red)"}}>{d.stockActual}</td>
                      <td className="mono" style={{textAlign:"right",fontWeight:700,color:"var(--green)"}}>{d.stockEsperado}</td>
                      <td className="mono" style={{textAlign:"right",fontWeight:700,color:d.diferencia>0?"var(--green)":"var(--red)"}}>{d.diferencia>0?"+":""}{d.diferencia}</td>
                    </tr>
                  ))}</tbody></table>
                </div>
              </div>
            )}

            {reconResult && (
              <div style={{marginTop:12,padding:12,borderRadius:8,background:"var(--greenBg)",border:"1px solid var(--greenBd)"}}>
                <div style={{fontSize:13,fontWeight:700,color:"var(--green)"}}>
                  Reconciliación completada — {reconResult.fixed} correcciones aplicadas
                </div>
                {reconResult.errors.length > 0 && (
                  <div style={{marginTop:8}}>
                    <div style={{fontSize:11,color:"var(--red)",fontWeight:600}}>Errores ({reconResult.errors.length}):</div>
                    {reconResult.errors.map((e,i) => <div key={i} style={{fontSize:10,color:"var(--red)",fontFamily:"var(--font-mono)"}}>{e}</div>)}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {viewMode === "ml" ? (
        /* ===== ML PUBLICATIONS VIEW ===== */
        <>
          <div className="desktop-only">
            <div className="card" style={{padding:0,overflow:"hidden"}}>
              <table className="tbl">
                <thead><tr>
                  <th>Código ML</th><th>SKU Venta</th><th>Componentes</th><th style={{textAlign:"center"}}>Pack</th><th style={{textAlign:"right"}}>Disponible</th>
                </tr></thead>
                <tbody>
                  {ventasConStock.map(v=>{
                    const isOpen = expanded === v.skuVenta;
                    return([
                      <tr key={v.skuVenta} onClick={()=>setExpanded(isOpen?null:v.skuVenta)} style={{cursor:"pointer",background:isOpen?"var(--bg3)":"transparent"}}>
                        <td className="mono" style={{fontWeight:700,fontSize:12,color:"var(--amber)"}}>{v.codigoMl}</td>
                        <td className="mono" style={{fontSize:11}}>{v.skuVenta}</td>
                        <td style={{fontSize:11}}>
                          {v.comps.map((c,i)=>(
                            <span key={c.skuOrigen}>
                              {i>0 && <span style={{color:"var(--txt3)"}}> + </span>}
                              {c.unidades > 1 && <span style={{color:"var(--cyan)"}}>{c.unidades}×</span>}
                              <span>{c.nombre}</span>
                            </span>
                          ))}
                        </td>
                        <td style={{textAlign:"center"}}>{v.comps.length > 1 || v.comps[0]?.unidades > 1 ? <span className="tag" style={{background:"var(--amberBg)",color:"var(--amber)"}}>Pack</span> : <span className="tag">Unitario</span>}</td>
                        <td className="mono" style={{textAlign:"right",fontWeight:700,fontSize:16,color:v.disponible>0?"var(--green)":"var(--red)"}}>{v.disponible}</td>
                      </tr>,
                      isOpen && <tr key={v.skuVenta+"-detail"}><td colSpan={5} style={{background:"var(--bg3)",padding:12}}>
                        <div style={{fontSize:11,fontWeight:700,marginBottom:6}}>Desglose de componentes:</div>
                        <table className="tbl"><thead><tr><th>SKU Origen</th><th>Producto</th><th style={{textAlign:"center"}}>Uds/Pack</th><th style={{textAlign:"right"}}>Stock Total</th><th style={{textAlign:"right"}}>Packs posibles</th></tr></thead>
                          <tbody>{v.comps.map(c=>(
                            <tr key={c.skuOrigen}>
                              <td className="mono" style={{fontWeight:700,fontSize:12}}>{c.skuOrigen}</td>
                              <td style={{fontSize:11}}>{c.nombre}</td>
                              <td className="mono" style={{textAlign:"center"}}>{c.unidades}</td>
                              <td className="mono" style={{textAlign:"right",color:"var(--blue)"}}>{c.stock}</td>
                              <td className="mono" style={{textAlign:"right",fontWeight:700,color:c.disp===v.disponible&&v.disponible>0?"var(--green)":c.disp===v.disponible?"var(--red)":"var(--txt2)"}}>{c.disp} {c.disp===v.disponible&&<span style={{fontSize:9}}>← limita</span>}</td>
                            </tr>
                          ))}</tbody>
                        </table>
                      </td></tr>
                    ]);
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="mobile-only">
            {ventasConStock.map(v=>{
              const isOpen = expanded === v.skuVenta;
              return(
                <div key={v.skuVenta} className="card" style={{marginTop:6,cursor:"pointer"}} onClick={()=>setExpanded(isOpen?null:v.skuVenta)}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <div>
                      <div className="mono" style={{fontSize:13,fontWeight:700,color:"var(--amber)"}}>{v.codigoMl}</div>
                      <div className="mono" style={{fontSize:10,color:"var(--txt3)"}}>{v.skuVenta}</div>
                      <div style={{fontSize:11,color:"var(--txt2)",marginTop:2}}>
                        {v.comps.map((c,i)=>(
                          <span key={c.skuOrigen}>{i>0?" + ":""}{c.unidades>1?`${c.unidades}× `:""}{c.nombre}</span>
                        ))}
                      </div>
                    </div>
                    <div style={{textAlign:"right"}}>
                      <div className="mono" style={{fontSize:22,fontWeight:800,color:v.disponible>0?"var(--green)":"var(--red)"}}>{v.disponible}</div>
                      <div style={{fontSize:9,color:"var(--txt3)"}}>disponibles</div>
                    </div>
                  </div>
                  {isOpen && <div style={{marginTop:8,borderTop:"1px solid var(--bg4)",paddingTop:8}}>
                    {v.comps.map(c=>(
                      <div key={c.skuOrigen} className="mini-row" style={{alignItems:"center"}}>
                        <span className="mono" style={{fontWeight:700,fontSize:12,minWidth:80}}>{c.skuOrigen}</span>
                        <span style={{flex:1,fontSize:10,color:"var(--txt3)"}}>{c.nombre} ×{c.unidades}/pack</span>
                        <span className="mono" style={{fontWeight:700,fontSize:12,color:"var(--blue)"}}>{c.stock}</span>
                        <span style={{fontSize:9,color:"var(--txt3)",marginLeft:4}}>→ {c.disp} packs</span>
                      </div>
                    ))}
                  </div>}
                </div>
              );
            })}
          </div>
        </>
      ) : (
        /* ===== PHYSICAL STOCK VIEW (original) ===== */
        <>
          {/* Desktop: table view */}
          <div className="desktop-only">
            <div className="card" style={{padding:0,overflow:"hidden"}}>
              <table className="tbl">
                <thead><tr>
                  <th>SKU</th><th>Producto</th><th>Cat.</th><th>Proveedor</th><th>Etiquetado</th><th>Ubicaciones</th><th style={{textAlign:"right"}}>Total</th><th style={{textAlign:"right"}}>Valor</th>
                </tr></thead>
                <tbody>
                  {filteredSkus.map(sku=>{
                    const prod=s.products[sku];const total=skuTotal(sku);const positions=skuPositions(sku);
                    const isOpen=expanded===sku;
                    const det=skuStockDetalle(sku);
                    const etiqQty=det.filter(d=>d.skuVenta!==SIN_ETIQUETAR).reduce((s,d)=>s+d.qty,0);
                    const sinEtQty=det.filter(d=>d.skuVenta===SIN_ETIQUETAR).reduce((s,d)=>s+d.qty,0);
                    const etiqStatus=total===0?"—":sinEtQty===0?"full":etiqQty===0?"none":"partial";
                    const etiqFormatos=Array.from(new Set(det.filter(d=>d.skuVenta!==SIN_ETIQUETAR).map(d=>d.skuVenta)));
                    return([
                      <tr key={sku} onClick={()=>setExpanded(isOpen?null:sku)} style={{cursor:"pointer",background:isOpen?"var(--bg3)":"transparent"}}>
                        <td className="mono" style={{fontWeight:700,fontSize:12}}>{sku}</td>
                        <td style={{fontSize:12}}>{prod?.name||sku}</td>
                        <td><span className="tag">{prod?.cat}</span></td>
                        <td><span className="tag">{prod?.prov}</span></td>
                        <td>{etiqStatus==="full"?(
                          <span style={{display:"inline-flex",alignItems:"center",gap:4}}>
                            <span style={{padding:"2px 8px",borderRadius:4,fontSize:10,fontWeight:700,background:"var(--greenBg)",color:"var(--green)",border:"1px solid var(--greenBd)"}}>100%</span>
                            {etiqFormatos.length===1&&<span className="mono" style={{fontSize:9,color:"var(--cyan)"}}>{etiqFormatos[0]}</span>}
                            {etiqFormatos.length>1&&<span className="mono" style={{fontSize:9,color:"var(--cyan)"}}>{etiqFormatos.length} formatos</span>}
                          </span>
                        ):etiqStatus==="none"?(
                          <span style={{padding:"2px 8px",borderRadius:4,fontSize:10,fontWeight:700,background:"var(--amberBg)",color:"var(--amber)",border:"1px solid var(--amberBd)"}}>Sin etiquetar</span>
                        ):etiqStatus==="partial"?(
                          <span style={{display:"inline-flex",alignItems:"center",gap:4}}>
                            <span style={{padding:"2px 8px",borderRadius:4,fontSize:10,fontWeight:700,background:"var(--blueBg)",color:"var(--blue)",border:"1px solid var(--blueBd)"}}>{etiqQty}/{total}</span>
                            <span style={{fontSize:9,color:"var(--amber)"}}>{sinEtQty} sin etiq.</span>
                          </span>
                        ):(
                          <span style={{fontSize:10,color:"var(--txt3)"}}>—</span>
                        )}</td>
                        <td>{positions.map(p=><span key={p.pos} className="mono" style={{fontSize:10,marginRight:6,padding:"2px 6px",background:"var(--bg3)",borderRadius:4}}>{p.pos}: {p.qty}</span>)}</td>
                        <td className="mono" style={{textAlign:"right",fontWeight:700,color:"var(--blue)"}}>{total}</td>
                        <td className="mono" style={{textAlign:"right",fontSize:11}}>{prod?fmtMoney(prod.cost*total):"-"}</td>
                      </tr>,
                      isOpen && <tr key={sku+"-detail"}><td colSpan={8} style={{background:"var(--bg3)",padding:16}}>
                        {/* Detalle por formato de venta */}
                        {(()=>{const detalle=skuStockDetalle(sku);return detalle.length>0&&(
                          <div style={{marginBottom:16}}>
                            <div style={{fontSize:12,fontWeight:700,marginBottom:8}}>Detalle por formato de venta — {sku}</div>
                            <table className="tbl"><thead><tr><th>Formato</th><th>Posicion</th><th style={{textAlign:"right"}}>Cantidad</th><th style={{width:60}}></th></tr></thead>
                              <tbody>{detalle.map((d,i)=>(
                                <EditableStockRow key={`${d.skuVenta}-${d.pos}-${i}`} sku={sku} skuVenta={d.skuVenta} pos={d.pos} label={d.label} qty={d.qty} onDone={refresh} />
                              ))}</tbody>
                            </table>
                          </div>
                        );})()}
                        <ReasignarFormatoPanel sku={sku} onDone={refresh} />
                        <div style={{fontSize:12,fontWeight:700,marginBottom:8}}>Historial de movimientos — {sku} {skuMovsLoading ? <span style={{fontWeight:400,color:"var(--txt3)"}}>(cargando...)</span> : <span style={{fontWeight:400,color:"var(--txt3)",fontSize:10}}>({skuMovs.length} movimientos)</span>}</div>
                        <table className="tbl"><thead><tr><th>Fecha</th><th>Tipo</th><th>Motivo</th><th>Pos</th><th>Quien</th><th>Nota</th><th style={{textAlign:"right"}}>Qty</th></tr></thead>
                          <tbody>{skuMovs.map(m=>(
                            <tr key={m.id}>
                              <td style={{fontSize:11}}>{fmtDate(m.ts)} {fmtTime(m.ts)}</td>
                              <td><span className="mov-badge" style={{background:m.type==="in"?"var(--greenBg)":"var(--redBg)",color:m.type==="in"?"var(--green)":"var(--red)"}}>{m.type==="in"?"IN":"OUT"}</span></td>
                              <td style={{fontSize:10}}>{(IN_REASONS as any)[m.reason]||(OUT_REASONS as any)[m.reason]}</td>
                              <td className="mono">{m.pos}</td><td style={{fontSize:11}}>{m.who}</td><td style={{fontSize:10,color:"var(--cyan)"}}>{m.note}</td>
                              <td className="mono" style={{textAlign:"right",fontWeight:700,color:m.type==="in"?"var(--green)":"var(--red)"}}>{m.type==="in"?"+":"-"}{m.qty}</td>
                            </tr>
                          ))}</tbody>
                        </table>
                      </td></tr>
                    ]);
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Mobile: card view */}
          <div className="mobile-only">
            {filteredSkus.map(sku=>{
              const prod=s.products[sku];const positions=skuPositions(sku);const total=skuTotal(sku);const isOpen=expanded===sku;
              const det=skuStockDetalle(sku);
              const etiqQty=det.filter(d=>d.skuVenta!==SIN_ETIQUETAR).reduce((s,d)=>s+d.qty,0);
              const sinEtQty=det.filter(d=>d.skuVenta===SIN_ETIQUETAR).reduce((s,d)=>s+d.qty,0);
              const etiqFormatos=Array.from(new Set(det.filter(d=>d.skuVenta!==SIN_ETIQUETAR).map(d=>d.skuVenta)));
              return(
                <div key={sku} className="card" style={{marginTop:6,cursor:"pointer"}} onClick={()=>setExpanded(isOpen?null:sku)}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <div>
                      <div className="mono" style={{fontSize:14,fontWeight:700}}>{sku}</div>
                      <div style={{fontSize:12,color:"var(--txt2)"}}>{prod?.name||sku}</div>
                      <div style={{display:"flex",gap:4,marginTop:3,flexWrap:"wrap"}}>
                        {prod?.cat&&<span className="tag">{prod.cat}</span>}{prod?.prov&&<span className="tag">{prod.prov}</span>}
                        {total>0&&sinEtQty===0&&etiqQty>0?(
                          <span style={{padding:"1px 6px",borderRadius:4,fontSize:9,fontWeight:700,background:"var(--greenBg)",color:"var(--green)",border:"1px solid var(--greenBd)"}}>
                            {etiqFormatos.length===1?etiqFormatos[0]:`${etiqFormatos.length} formatos`}
                          </span>
                        ):total>0&&sinEtQty>0&&etiqQty>0?(
                          <span style={{padding:"1px 6px",borderRadius:4,fontSize:9,fontWeight:700,background:"var(--blueBg)",color:"var(--blue)",border:"1px solid var(--blueBd)"}}>{etiqQty}/{total} etiq.</span>
                        ):total>0&&sinEtQty>0?(
                          <span style={{padding:"1px 6px",borderRadius:4,fontSize:9,fontWeight:700,background:"var(--amberBg)",color:"var(--amber)",border:"1px solid var(--amberBd)"}}>Sin etiquetar</span>
                        ):null}
                      </div>
                    </div>
                    <div style={{textAlign:"right"}}>
                      <div className="mono" style={{fontSize:20,fontWeight:700,color:"var(--blue)"}}>{total}</div>
                      <div style={{fontSize:9,color:"var(--txt3)"}}>en {positions.length} pos.</div>
                    </div>
                  </div>
                  <div style={{marginTop:8}}>{positions.map(sp=>(
                    <div key={sp.pos} className="mini-row"><span className="mono" style={{fontWeight:700,color:"var(--green)",minWidth:50,fontSize:13}}>{sp.pos}</span><span style={{flex:1,fontSize:10,color:"var(--txt3)"}}>{sp.label}</span><span className="mono" style={{fontWeight:700,fontSize:13}}>{sp.qty}</span></div>
                  ))}</div>
                  {isOpen&&<div style={{marginTop:10,borderTop:"1px solid var(--bg4)",paddingTop:10}}>
                    {(()=>{const detalle=skuStockDetalle(sku);return detalle.length>0&&(
                      <div style={{marginBottom:10}}>
                        <div style={{fontSize:11,fontWeight:700,color:"var(--txt2)",marginBottom:6}}>Por formato de venta</div>
                        {detalle.map((d,i)=>(
                          <EditableStockRowMobile key={`${d.skuVenta}-${d.pos}-${i}`} sku={sku} skuVenta={d.skuVenta} pos={d.pos} label={d.label} qty={d.qty} onDone={refresh} />
                        ))}
                      </div>
                    );})()}
                    <ReasignarFormatoPanel sku={sku} onDone={refresh} />
                    <div style={{fontSize:11,fontWeight:700,color:"var(--txt2)",marginBottom:6}}>Historial ({skuMovsLoading?"...":skuMovs.length} movimientos)</div>
                    {skuMovs.map(m=>(
                      <div key={m.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"4px 0",fontSize:11}}>
                        <div><span style={{color:"var(--txt3)"}}>{fmtDate(m.ts)} {fmtTime(m.ts)}</span><span style={{marginLeft:6,color:"var(--txt3)"}}>Pos {m.pos}</span><span style={{marginLeft:6,fontSize:10,color:"var(--txt3)"}}>({(IN_REASONS as any)[m.reason]||(OUT_REASONS as any)[m.reason]})</span></div>
                        <span className="mono" style={{fontWeight:700,color:m.type==="in"?"var(--green)":"var(--red)"}}>{m.type==="in"?"+":"-"}{m.qty}</span>
                      </div>
                    ))}
                  </div>}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ==================== EDITAR STOCK POR VARIANTE (INLINE) ====================
function EditableStockRow({ sku, skuVenta, pos, label, qty, onDone }: { sku: string; skuVenta: string; pos: string; label: string; qty: number; onDone: () => void }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(qty);
  const [saving, setSaving] = useState(false);

  const doSave = async () => {
    if (val === qty) { setEditing(false); return; }
    setSaving(true);
    try {
      const realSkuVenta = skuVenta === SIN_ETIQUETAR ? null : skuVenta;
      await editarStockVariante(sku, pos, realSkuVenta, val);
      onDone();
      setEditing(false);
    } catch (e: unknown) {
      alert("Error: " + (e instanceof Error ? e.message : String(e)));
    } finally { setSaving(false); }
  };

  return (
    <tr>
      <td className="mono" style={{fontSize:11,fontWeight:700,color:skuVenta===SIN_ETIQUETAR?"var(--amber)":"var(--cyan)"}}>
        {skuVenta===SIN_ETIQUETAR?"Sin etiquetar":skuVenta}
      </td>
      <td className="mono" style={{fontSize:11}}>{pos} — {label}</td>
      <td className="mono" style={{textAlign:"right",fontWeight:700,color:"var(--blue)"}}>
        {editing ? (
          <input type="number" value={val} min={0} onFocus={e=>e.target.select()}
            onChange={e=>setVal(Math.max(0,parseInt(e.target.value)||0))}
            onKeyDown={e=>{if(e.key==="Enter")doSave();if(e.key==="Escape"){setEditing(false);setVal(qty);}}}
            style={{width:60,textAlign:"center",fontSize:12,fontWeight:700,padding:"2px 4px",borderRadius:4,background:"var(--bg2)",border:"1px solid var(--cyan)",color:"var(--txt)"}} autoFocus />
        ) : qty}
      </td>
      <td style={{textAlign:"center"}}>
        {editing ? (
          <span style={{display:"flex",gap:4,justifyContent:"center"}}>
            <button onClick={doSave} disabled={saving} style={{padding:"2px 8px",borderRadius:4,fontSize:10,fontWeight:700,background:"var(--green)",color:"#fff",border:"none",cursor:"pointer",opacity:saving?0.5:1}}>{saving?"...":"OK"}</button>
            <button onClick={()=>{setEditing(false);setVal(qty);}} style={{padding:"2px 8px",borderRadius:4,fontSize:10,fontWeight:700,background:"var(--bg3)",color:"var(--txt3)",border:"1px solid var(--bg4)",cursor:"pointer"}}>X</button>
          </span>
        ) : (
          <button onClick={()=>{setVal(qty);setEditing(true);}} style={{padding:"2px 8px",borderRadius:4,fontSize:10,fontWeight:700,background:"var(--bg3)",color:"var(--txt3)",border:"1px solid var(--bg4)",cursor:"pointer"}}>Editar</button>
        )}
      </td>
    </tr>
  );
}

function EditableStockRowMobile({ sku, skuVenta, pos, label, qty, onDone }: { sku: string; skuVenta: string; pos: string; label: string; qty: number; onDone: () => void }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(qty);
  const [saving, setSaving] = useState(false);

  const doSave = async () => {
    if (val === qty) { setEditing(false); return; }
    setSaving(true);
    try {
      const realSkuVenta = skuVenta === SIN_ETIQUETAR ? null : skuVenta;
      await editarStockVariante(sku, pos, realSkuVenta, val);
      onDone();
      setEditing(false);
    } catch (e: unknown) {
      alert("Error: " + (e instanceof Error ? e.message : String(e)));
    } finally { setSaving(false); }
  };

  return (
    <div className="mini-row" style={{alignItems:"center"}}>
      <span className="mono" style={{fontWeight:700,fontSize:11,color:skuVenta===SIN_ETIQUETAR?"var(--amber)":"var(--cyan)",minWidth:80}}>
        {skuVenta===SIN_ETIQUETAR?"Sin etiquetar":skuVenta}
      </span>
      <span className="mono" style={{flex:1,fontSize:10,color:"var(--txt3)"}}>{pos}</span>
      {editing ? (
        <span style={{display:"flex",gap:4,alignItems:"center"}}>
          <input type="number" value={val} min={0} inputMode="numeric" onFocus={e=>e.target.select()}
            onChange={e=>setVal(Math.max(0,parseInt(e.target.value)||0))}
            onKeyDown={e=>{if(e.key==="Enter")doSave();if(e.key==="Escape"){setEditing(false);setVal(qty);}}}
            style={{width:50,textAlign:"center",fontSize:12,fontWeight:700,padding:"2px 4px",borderRadius:4,background:"var(--bg2)",border:"1px solid var(--cyan)",color:"var(--txt)"}} autoFocus />
          <button onClick={doSave} disabled={saving} style={{padding:"2px 6px",borderRadius:4,fontSize:10,fontWeight:700,background:"var(--green)",color:"#fff",border:"none",cursor:"pointer",opacity:saving?0.5:1}}>{saving?"...":"OK"}</button>
          <button onClick={()=>{setEditing(false);setVal(qty);}} style={{padding:"2px 6px",borderRadius:4,fontSize:10,fontWeight:700,background:"var(--bg3)",color:"var(--txt3)",border:"1px solid var(--bg4)",cursor:"pointer"}}>X</button>
        </span>
      ) : (
        <span style={{display:"flex",gap:4,alignItems:"center"}}>
          <span className="mono" style={{fontWeight:700,fontSize:12,color:"var(--blue)"}}>{qty}</span>
          <button onClick={()=>{setVal(qty);setEditing(true);}} style={{padding:"2px 6px",borderRadius:4,fontSize:9,fontWeight:700,background:"var(--bg3)",color:"var(--txt3)",border:"1px solid var(--bg4)",cursor:"pointer"}}>Editar</button>
        </span>
      )}
    </div>
  );
}

// ==================== REASIGNAR FORMATO INLINE ====================
function ReasignarFormatoPanel({ sku, onDone }: { sku: string; onDone: () => void }) {
  const formatos = getVentasPorSkuOrigen(sku);
  const detalle = skuStockDetalle(sku);
  const sinEtiquetar = detalle.filter(d => d.skuVenta === SIN_ETIQUETAR && d.qty > 0);

  const [selFormato, setSelFormato] = useState<Record<string, string>>({});
  const [selQty, setSelQty] = useState<Record<string, number>>({});
  const [saving, setSaving] = useState(false);

  if (formatos.length === 0 || sinEtiquetar.length === 0) return null;

  const doReasignar = async (posId: string, maxQty: number) => {
    const formato = selFormato[posId];
    const qty = selQty[posId] || maxQty;
    if (!formato || qty <= 0) return;
    setSaving(true);
    try {
      await reasignarFormato(sku, posId, qty, formato);
      onDone();
    } catch (e: unknown) {
      alert("Error: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{marginBottom:16,padding:12,borderRadius:8,background:"var(--amberBg)",border:"1px solid var(--amberBd)"}}>
      <div style={{fontSize:12,fontWeight:700,color:"var(--amber)",marginBottom:8}}>
        Reasignar stock sin etiquetar → formato de venta
      </div>
      {sinEtiquetar.map(d => (
        <div key={d.pos} style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",marginBottom:8,padding:8,borderRadius:6,background:"var(--bg2)"}}>
          <div style={{minWidth:60}}>
            <div className="mono" style={{fontSize:11,fontWeight:700}}>{d.pos}</div>
            <div style={{fontSize:10,color:"var(--txt3)"}}>{d.label}</div>
            <div className="mono" style={{fontSize:12,fontWeight:700,color:"var(--amber)"}}>{d.qty} uds</div>
          </div>
          <select value={selFormato[d.pos] || ""} onChange={e => setSelFormato(p => ({...p, [d.pos]: e.target.value}))}
            style={{flex:1,padding:6,borderRadius:4,fontSize:11,background:"var(--bg3)",color:"var(--txt)",border:"1px solid var(--bg4)",minWidth:120}}>
            <option value="">— Seleccionar formato —</option>
            {formatos.map(f => (
              <option key={f.skuVenta} value={f.skuVenta}>{f.skuVenta} {f.unidades > 1 ? `(x${f.unidades})` : "(individual)"}</option>
            ))}
          </select>
          <div style={{display:"flex",alignItems:"center",gap:4}}>
            <button onClick={() => setSelQty(p => ({...p, [d.pos]: Math.max(1, (p[d.pos] ?? d.qty) - 1)}))}
              style={{width:24,height:24,borderRadius:4,background:"var(--bg3)",fontSize:14,fontWeight:700,border:"1px solid var(--bg4)",color:"var(--txt)"}}>−</button>
            <input type="number" value={selQty[d.pos] ?? d.qty}
              onFocus={e=>e.target.select()} onChange={e => setSelQty(p => ({...p, [d.pos]: Math.max(1, Math.min(d.qty, parseInt(e.target.value) || 0))}))}
              style={{width:50,textAlign:"center",fontSize:12,fontWeight:700,padding:4,borderRadius:4,background:"var(--bg3)",border:"1px solid var(--bg4)",color:"var(--txt)"}} />
            <button onClick={() => setSelQty(p => ({...p, [d.pos]: Math.min(d.qty, (p[d.pos] ?? d.qty) + 1)}))}
              style={{width:24,height:24,borderRadius:4,background:"var(--bg3)",fontSize:14,fontWeight:700,border:"1px solid var(--bg4)",color:"var(--txt)"}}>+</button>
          </div>
          <button onClick={() => doReasignar(d.pos, selQty[d.pos] ?? d.qty)} disabled={saving || !selFormato[d.pos]}
            style={{padding:"6px 12px",borderRadius:6,fontSize:11,fontWeight:700,
              background:selFormato[d.pos]?"var(--green)":"var(--bg3)",color:selFormato[d.pos]?"#fff":"var(--txt3)",
              border:"none",cursor:selFormato[d.pos]?"pointer":"not-allowed",opacity:saving?0.5:1}}>
            {saving ? "..." : "Asignar"}
          </button>
        </div>
      ))}
    </div>
  );
}


export default Inventario;
