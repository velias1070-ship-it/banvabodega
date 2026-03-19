"use client";
import React, { useState, useEffect, useCallback, useRef } from "react";
import { getStore, saveStore, skuTotal, fmtDate, fmtTime, fmtMoney, findProduct, getProveedores, getRecepciones, getRecepcionLineas, crearRecepcion, actualizarRecepcion, actualizarLineaRecepcion, getOperarios, anularRecepcion, pausarRecepcion, reactivarRecepcion, cerrarRecepcion, parseRecepcionMeta, encodeRecepcionMeta, eliminarLineaRecepcion, agregarLineaRecepcion, getVentasPorSkuOrigen, getLineasDeRecepciones, desbloquearLinea, isLineaBloqueada, detectarDiscrepancias, getDiscrepancias, aprobarNuevoCosto, rechazarNuevoCosto, tieneDiscrepanciasPendientes, recalcularDiscrepancias, auditarRecepcion, repararRecepcion, ajustarLineaAdmin, detectarDiscrepanciasQty, getDiscrepanciasQty, recalcularDiscrepanciasQty, resolverDiscrepanciaQty, tieneDiscrepanciasQtyPendientes, getResolucionesQty, activePositions, sustituirProducto, getRecepcionAjustes, registrarAjuste, backfillFacturaOriginal } from "@/lib/store";
import type { AuditResult, DBDiscrepanciaQty } from "@/lib/store";
import type { Product, DBRecepcion, DBRecepcionLinea, DBOperario, RecepcionMeta } from "@/lib/store";
import type { DBDiscrepanciaCosto, DBRecepcionAjuste, FacturaOriginal } from "@/lib/db";
import { updateRecepcionFacturaOriginal } from "@/lib/db";

// ==================== ADMIN RECEPCIONES ====================
const ESTADO_COLORS_A: Record<string, string> = {
  CREADA: "var(--amber)", EN_PROCESO: "var(--blue)", COMPLETADA: "var(--green)",
  CERRADA: "var(--txt3)", ANULADA: "var(--red)", PAUSADA: "#8b5cf6",
};
const ESTADO_LABELS_A: Record<string, string> = {
  CREADA: "Nueva", EN_PROCESO: "En proceso", COMPLETADA: "Completada",
  CERRADA: "Cerrada", ANULADA: "Anulada", PAUSADA: "Pausada",
};

type RecFilter = "activas"|"pausadas"|"completadas"|"anuladas"|"todas";
type RecView = "dia"|"facturas";

const LINEA_ESTADO_COLORS: Record<string, string> = {
  PENDIENTE: "var(--red)", CONTADA: "var(--amber)", EN_ETIQUETADO: "var(--blue)",
  ETIQUETADA: "var(--green)", UBICADA: "var(--green)",
};

function AdminRecepciones({ refresh }: { refresh: () => void }) {
  const [view, setView] = useState<RecView>("dia");
  const [recs, setRecs] = useState<DBRecepcion[]>([]);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [filter, setFilter] = useState<RecFilter>("activas");
  const [selRec, setSelRec] = useState<DBRecepcion|null>(null);
  const [lineas, setLineas] = useState<DBRecepcionLinea[]>([]);
  const [operarios, setOperarios] = useState<DBOperario[]>([]);
  const [discrepancias, setDiscrepancias] = useState<DBDiscrepanciaCosto[]>([]);
  const [discrepanciasQty, setDiscrepanciasQty] = useState<DBDiscrepanciaQty[]>([]);

  // Factura original & ajustes
  const [facturaOrig, setFacturaOrig] = useState<FacturaOriginal|null>(null);
  const [ajustes, setAjustes] = useState<DBRecepcionAjuste[]>([]);
  const [showAjustes, setShowAjustes] = useState(false);

  // Day view state
  const [dayLineas, setDayLineas] = useState<DBRecepcionLinea[]>([]);
  const [dayFilter, setDayFilter] = useState<"todas"|"pendientes"|"diferencia">("todas");

  // Edit state
  const [editing, setEditing] = useState(false);
  const [editFolio, setEditFolio] = useState("");
  const [editProv, setEditProv] = useState("");
  const [editNotas, setEditNotas] = useState("");
  const [editAsignados, setEditAsignados] = useState<string[]>([]);
  const [editCostoNeto, setEditCostoNeto] = useState(0);
  const [editIva, setEditIva] = useState(0);
  const [editCostoBruto, setEditCostoBruto] = useState(0);

  // Inline line editing
  const [editLineaId, setEditLineaId] = useState<string|null>(null);
  const [editLineaData, setEditLineaData] = useState<{qty_factura:number;qty_recibida:number;qty_etiquetada:number;qty_ubicada:number;costo_unitario:number;nombre:string;sku:string;estado:string}>({qty_factura:0,qty_recibida:0,qty_etiquetada:0,qty_ubicada:0,costo_unitario:0,nombre:"",sku:"",estado:"PENDIENTE"});

  // Audit & repair
  const [auditResults, setAuditResults] = useState<AuditResult[]|null>(null);
  const [auditing, setAuditing] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [repairPos, setRepairPos] = useState("SIN_ASIGNAR");

  // Anular dialog
  const [showAnular, setShowAnular] = useState(false);
  const [anularMotivo, setAnularMotivo] = useState("");

  // Error report modal
  const [errorLinea, setErrorLinea] = useState<DBRecepcionLinea|null>(null);
  const [errorMode, setErrorMode] = useState<"menu"|"conteo"|"sku"|"sustitucion">("menu");
  const [errorQty, setErrorQty] = useState(0);
  const [errorSkuSearch, setErrorSkuSearch] = useState("");
  const [errorSkuResults, setErrorSkuResults] = useState<Product[]>([]);
  const [errorSaving, setErrorSaving] = useState(false);
  const [sustQty, setSustQty] = useState(0);
  const [sustCostoMode, setSustCostoMode] = useState<"factura"|"diccionario">("factura");
  const [sustSelected, setSustSelected] = useState<Product|null>(null);

  // Create form
  const [newFolio, setNewFolio] = useState("");
  const [newProv, setNewProv] = useState("");
  const [newLineas, setNewLineas] = useState<{sku:string;nombre:string;codigoML:string;cantidad:number;costo:number;requiereEtiqueta:boolean}[]>([]);
  const [newSku, setNewSku] = useState("");
  const [newQty, setNewQty] = useState(1);
  const [newCostoNeto, setNewCostoNeto] = useState(0);
  const [newIva, setNewIva] = useState(0);
  const [newCostoBruto, setNewCostoBruto] = useState(0);

  // Edit factura original
  const [editingFactura, setEditingFactura] = useState(false);
  const [editFacturaLineas, setEditFacturaLineas] = useState<{sku:string;nombre:string;cantidad:number;costo_unitario:number}[]>([]);

  // Add line to existing
  const [addSku, setAddSku] = useState("");
  const [addQty, setAddQty] = useState(1);

  const loadRecs = async () => {
    setLoading(true);
    const [allRecs, ops] = await Promise.all([getRecepciones(), getOperarios()]);
    setRecs(allRecs);
    setOperarios(ops);
    // Load day view lines from active receptions
    const activeIds = allRecs.filter(r => ["CREADA","EN_PROCESO"].includes(r.estado)).map(r => r.id!).filter(Boolean);
    if (activeIds.length > 0) {
      setDayLineas(await getLineasDeRecepciones(activeIds));
    } else {
      setDayLineas([]);
    }
    setLoading(false);
  };
  useEffect(() => { loadRecs(); }, []);

  const counts: Record<RecFilter, number> = {
    activas: recs.filter(r=>["CREADA","EN_PROCESO"].includes(r.estado)).length,
    pausadas: recs.filter(r=>r.estado==="PAUSADA").length,
    completadas: recs.filter(r=>["COMPLETADA","CERRADA"].includes(r.estado)).length,
    anuladas: recs.filter(r=>r.estado==="ANULADA").length,
    todas: recs.length,
  };

  const filteredRecs = recs.filter(r => {
    if (filter==="activas") return ["CREADA","EN_PROCESO"].includes(r.estado);
    if (filter==="pausadas") return r.estado==="PAUSADA";
    if (filter==="completadas") return ["COMPLETADA","CERRADA"].includes(r.estado);
    if (filter==="anuladas") return r.estado==="ANULADA";
    return true;
  });

  const openRec = async (rec: DBRecepcion) => {
    setSelRec(rec);
    const recLineas = await getRecepcionLineas(rec.id!);
    setLineas(recLineas);
    const [discs, discsQty, recAjustes] = await Promise.all([
      detectarDiscrepancias(rec.id!, recLineas),
      detectarDiscrepanciasQty(rec.id!, recLineas),
      getRecepcionAjustes(rec.id!),
    ]);
    setDiscrepancias(discs);
    setDiscrepanciasQty(discsQty);
    setAjustes(recAjustes);
    // Backfill factura_original si no existe
    if (rec.factura_original) {
      setFacturaOrig(rec.factura_original);
    } else if (recLineas.length > 0) {
      const snapshot = await backfillFacturaOriginal(rec.id!, recLineas, rec);
      setFacturaOrig(snapshot);
    } else {
      setFacturaOrig(null);
    }
    const meta = parseRecepcionMeta(rec.notas || "");
    setEditFolio(rec.folio); setEditProv(rec.proveedor);
    setEditNotas(meta.notas); setEditAsignados(meta.asignados);
    setEditCostoNeto(rec.costo_neto || 0); setEditIva(rec.iva || 0); setEditCostoBruto(rec.costo_bruto || 0);
    setEditing(false); setShowAnular(false); setAuditResults(null); setEditLineaId(null); setShowAjustes(false);
  };

  const refreshDetail = async () => {
    if (!selRec) return;
    const updatedRecs = await getRecepciones();
    setRecs(updatedRecs);
    const updated = updatedRecs.find(r => r.id === selRec.id);
    if (updated) { setSelRec(updated); const m = parseRecepcionMeta(updated.notas||""); setEditNotas(m.notas); setEditAsignados(m.asignados); }
    setLineas(await getRecepcionLineas(selRec.id!));
    const [dc, dq, aj] = await Promise.all([
      getDiscrepancias(selRec.id!),
      getDiscrepanciasQty(selRec.id!),
      getRecepcionAjustes(selRec.id!),
    ]);
    setDiscrepancias(dc);
    setDiscrepanciasQty(dq);
    setAjustes(aj);
  };

  // ---- Status actions ----
  const doAnular = async () => {
    if (!selRec) return; setLoading(true);
    await anularRecepcion(selRec.id!, anularMotivo);
    setShowAnular(false); setAnularMotivo("");
    await loadRecs(); setSelRec(null); setLoading(false);
  };
  const doPausar = async () => { if (!selRec) return; setLoading(true); await pausarRecepcion(selRec.id!); await loadRecs(); setSelRec(null); setLoading(false); };
  const doReactivar = async () => { if (!selRec) return; setLoading(true); await reactivarRecepcion(selRec.id!); await loadRecs(); setSelRec(null); setLoading(false); };
  const doCerrar = async () => {
    if (!selRec) return; setLoading(true);
    const result = await cerrarRecepcion(selRec.id!);
    if (!result.ok) {
      const msgs: string[] = [];
      if (result.pendientes) msgs.push(`${result.pendientes} discrepancia(s) de costo`);
      if (result.pendientesQty) msgs.push(`${result.pendientesQty} discrepancia(s) de cantidad`);
      alert(`No se puede cerrar: hay ${msgs.join(" y ")} sin resolver. Resuelve todas antes de cerrar.`);
      setLoading(false); return;
    }
    await loadRecs(); setSelRec(null); setLoading(false);
  };

  // ---- Edit save ----
  const doSaveEdit = async () => {
    if (!selRec) return; setLoading(true);
    const meta: RecepcionMeta = { notas: editNotas, asignados: editAsignados };
    await actualizarRecepcion(selRec.id!, { folio: editFolio, proveedor: editProv, notas: encodeRecepcionMeta(meta), costo_neto: editCostoNeto, iva: editIva, costo_bruto: editCostoBruto });
    setEditing(false); await refreshDetail(); setLoading(false);
  };

  // ---- Discrepancy actions ----
  const doAprobar = async (disc: DBDiscrepanciaCosto) => {
    if (!confirm(`Aprobar nuevo costo para ${disc.sku}?\nDiccionario: ${fmtMoney(disc.costo_diccionario)} → Factura: ${fmtMoney(disc.costo_factura)}\nEl diccionario se actualizará con el nuevo costo.`)) return;
    setLoading(true);
    try {
      const result = await aprobarNuevoCosto(disc.id!, disc.sku, disc.costo_factura);
      const sr = result.sheetResult;
      if (sr?.ok) {
        alert(`Costo aprobado y actualizado.\nDB: OK\nGoogle Sheet: fila ${sr.row}, celda ${sr.cell}`);
      } else {
        alert(`Costo aprobado en DB.\nGoogle Sheet: ${sr?.error || JSON.stringify(sr)}\n\nRevisa /api/sheet/update-cost en el navegador para diagnosticar.`);
      }
      await refreshDetail();
    } catch (e: unknown) {
      console.error("Error aprobando costo:", e);
      alert(`Error al aprobar: ${e instanceof Error ? e.message : e}`);
    } finally {
      setLoading(false);
    }
  };
  const doRechazar = async (disc: DBDiscrepanciaCosto) => {
    const nota = prompt("Motivo del rechazo (error proveedor, etc):", "Error de proveedor - reclamar");
    if (nota === null) return;
    setLoading(true);
    try {
      await rechazarNuevoCosto(disc.id!, nota);
      await refreshDetail();
    } catch (e: unknown) {
      console.error("Error rechazando costo:", e);
      alert(`Error al rechazar: ${e instanceof Error ? e.message : e}`);
    } finally {
      setLoading(false);
    }
  };

  // ---- Line actions ----
  const doResetLinea = async (lineaId: string) => {
    if (!confirm("Resetear esta línea a PENDIENTE? Se perderán conteos y ubicaciones.")) return;
    await actualizarLineaRecepcion(lineaId, { estado: "PENDIENTE", qty_recibida: 0, qty_etiquetada: 0, qty_ubicada: 0, operario_conteo: "", operario_etiquetado: "", operario_ubicacion: "" });
    setLineas(await getRecepcionLineas(selRec!.id!));
  };
  const doDeleteLinea = async (lineaId: string) => {
    if (!confirm("Eliminar esta línea de la recepción?")) return;
    const deletedLinea = lineas.find(l => l.id === lineaId);
    await eliminarLineaRecepcion(lineaId);
    if (deletedLinea && selRec) {
      await registrarAjuste({
        recepcion_id: selRec.id!, tipo: "linea_eliminada",
        sku_original: deletedLinea.sku, campo: "eliminada",
        valor_anterior: `${deletedLinea.qty_factura} uds @ ${deletedLinea.costo_unitario || 0}`,
        motivo: "Línea eliminada por admin", admin: "admin",
      });
    }
    setLineas(await getRecepcionLineas(selRec!.id!));
    setAjustes(await getRecepcionAjustes(selRec!.id!));
  };
  const doUpdateLineQty = async (lineaId: string, val: string) => {
    const n = parseInt(val); if (isNaN(n) || n < 0) return;
    await actualizarLineaRecepcion(lineaId, { qty_factura: n });
    setLineas(await getRecepcionLineas(selRec!.id!));
  };
  const startEditLinea = (l: DBRecepcionLinea) => {
    setEditLineaId(l.id!);
    setEditLineaData({ qty_factura: l.qty_factura, qty_recibida: l.qty_recibida||0, qty_etiquetada: l.qty_etiquetada||0, qty_ubicada: l.qty_ubicada||0, costo_unitario: l.costo_unitario||0, nombre: l.nombre, sku: l.sku, estado: l.estado });
  };
  const saveEditLinea = async () => {
    if (!editLineaId || !selRec) return;
    setLoading(true);
    try {
      const originalLinea = lineas.find(l => l.id === editLineaId);
      const oldQtyUbicada = originalLinea?.qty_ubicada || 0;
      const newQtyUbicada = editLineaData.qty_ubicada;
      if (oldQtyUbicada !== newQtyUbicada) {
        await ajustarLineaAdmin(editLineaId, selRec.id!, editLineaData.sku, oldQtyUbicada, newQtyUbicada);
      }
      await actualizarLineaRecepcion(editLineaId, {
        qty_factura: editLineaData.qty_factura,
        qty_recibida: editLineaData.qty_recibida,
        qty_etiquetada: editLineaData.qty_etiquetada,
        qty_ubicada: editLineaData.qty_ubicada,
        costo_unitario: editLineaData.costo_unitario,
        nombre: editLineaData.nombre,
        sku: editLineaData.sku,
        estado: editLineaData.estado as DBRecepcionLinea["estado"],
      });
      // Log ajustes for changed fields
      if (originalLinea) {
        const oldQtyR = originalLinea.qty_recibida || 0;
        const newQtyR = editLineaData.qty_recibida;
        if (oldQtyR !== newQtyR) {
          await registrarAjuste({ recepcion_id: selRec.id!, tipo: "cantidad", sku_original: originalLinea.sku, campo: "qty_recibida", valor_anterior: String(oldQtyR), valor_nuevo: String(newQtyR), motivo: "Ajuste manual por admin", admin: "admin" });
        }
        const oldQtyF = originalLinea.qty_factura;
        if (oldQtyF !== editLineaData.qty_factura) {
          await registrarAjuste({ recepcion_id: selRec.id!, tipo: "cantidad", sku_original: originalLinea.sku, campo: "qty_factura", valor_anterior: String(oldQtyF), valor_nuevo: String(editLineaData.qty_factura), motivo: "Ajuste qty factura por admin", admin: "admin" });
        }
        const oldCosto = originalLinea.costo_unitario || 0;
        if (oldCosto !== editLineaData.costo_unitario) {
          await registrarAjuste({ recepcion_id: selRec.id!, tipo: "costo", sku_original: originalLinea.sku, campo: "costo_unitario", valor_anterior: String(oldCosto), valor_nuevo: String(editLineaData.costo_unitario), motivo: "Ajuste costo por admin", admin: "admin" });
        }
      }
    } catch (e: unknown) {
      alert(`Error al guardar: ${e instanceof Error ? e.message : e}`);
    }
    setEditLineaId(null);
    setLineas(await getRecepcionLineas(selRec!.id!));
    setAjustes(await getRecepcionAjustes(selRec!.id!));
    setLoading(false);
  };
  const doAddLinea = async () => {
    if (!addSku || !selRec) return;
    const prod = getStore().products[addSku.toUpperCase()];
    const skuUp = addSku.toUpperCase();
    const costo = prod?.cost || 0;
    await agregarLineaRecepcion(selRec.id!, {
      sku: skuUp, nombre: prod?.name || addSku, codigoML: prod?.mlCode || "",
      cantidad: addQty, costo, requiereEtiqueta: prod?.requiresLabel !== false,
    });
    await registrarAjuste({
      recepcion_id: selRec.id!, tipo: "linea_agregada",
      sku_nuevo: skuUp, campo: "nueva_linea",
      valor_nuevo: `${addQty} uds @ ${costo}`,
      motivo: "Línea agregada por admin", admin: "admin",
    });
    setAddSku(""); setAddQty(1);
    setLineas(await getRecepcionLineas(selRec.id!));
    setAjustes(await getRecepcionAjustes(selRec.id!));
  };

  // Toggle operator assignment
  const toggleOp = (nombre: string) => {
    setEditAsignados(prev => prev.includes(nombre) ? prev.filter(n=>n!==nombre) : [...prev, nombre]);
  };

  // ---- Error report modal helpers ----
  const openErrorReport = (l: DBRecepcionLinea) => {
    setErrorLinea(l);
    setErrorMode("menu");
    setErrorQty(l.qty_factura);
    setErrorSkuSearch("");
    setErrorSkuResults([]);
  };
  const closeErrorReport = () => { if (!errorSaving) setErrorLinea(null); };
  const doErrorAjusteConteo = async () => {
    if (!errorLinea || errorQty < 0 || !selRec) return;
    setErrorSaving(true);
    try {
      await actualizarLineaRecepcion(errorLinea.id!, {
        qty_factura: errorQty,
        notas: `${errorLinea.notas ? errorLinea.notas + " | " : ""}Ajuste conteo: ${errorLinea.qty_factura} → ${errorQty}`,
      });
      await registrarAjuste({
        recepcion_id: selRec.id!, tipo: "cantidad",
        sku_original: errorLinea.sku, campo: "qty_factura",
        valor_anterior: String(errorLinea.qty_factura), valor_nuevo: String(errorQty),
        motivo: `Ajuste conteo: ${errorLinea.qty_factura} → ${errorQty}`, admin: "admin",
      });
      const updatedLineas = await getRecepcionLineas(selRec.id!);
      setLineas(updatedLineas);
      const dq = await recalcularDiscrepanciasQty(selRec.id!, updatedLineas);
      setDiscrepanciasQty(dq);
      setAjustes(await getRecepcionAjustes(selRec.id!));
      setErrorLinea(null);
    } catch (e: unknown) {
      console.error("Error ajuste conteo:", e);
      alert(`Error al ajustar conteo: ${e instanceof Error ? e.message : e}`);
    } finally {
      setErrorSaving(false);
    }
  };
  const doErrorCambioSku = async (newProduct: Product) => {
    if (!errorLinea || !selRec) return;
    setErrorSaving(true);
    try {
      const oldSku = errorLinea.sku;
      await actualizarLineaRecepcion(errorLinea.id!, {
        sku: newProduct.sku,
        nombre: newProduct.name,
        codigo_ml: newProduct.mlCode || "",
        requiere_etiqueta: newProduct.requiresLabel ?? errorLinea.requiere_etiqueta,
        notas: `${errorLinea.notas ? errorLinea.notas + " | " : ""}Cambio SKU: ${oldSku} → ${newProduct.sku}`,
      });
      await registrarAjuste({
        recepcion_id: selRec.id!, tipo: "sustitucion",
        sku_original: oldSku, sku_nuevo: newProduct.sku,
        campo: "sku",
        valor_anterior: `${oldSku} × ${errorLinea.qty_factura} @ ${fmtMoney(errorLinea.costo_unitario||0)}`,
        valor_nuevo: `${newProduct.sku} × ${errorLinea.qty_factura} @ ${fmtMoney(errorLinea.costo_unitario||0)}`,
        motivo: "Corrección de SKU erróneo", admin: "admin",
      });
      const updatedLineas = await getRecepcionLineas(selRec.id!);
      setLineas(updatedLineas);
      const [dc, dq] = await Promise.all([
        recalcularDiscrepancias(selRec.id!, updatedLineas),
        recalcularDiscrepanciasQty(selRec.id!, updatedLineas),
      ]);
      setDiscrepancias(dc);
      setDiscrepanciasQty(dq);
      setAjustes(await getRecepcionAjustes(selRec.id!));
      setErrorLinea(null);
    } catch (e: unknown) {
      console.error("Error cambio SKU:", e);
      alert(`Error al cambiar SKU: ${e instanceof Error ? e.message : e}`);
    } finally {
      setErrorSaving(false);
    }
  };
  const doSustitucion = async () => {
    if (!errorLinea || !selRec || !sustSelected || sustQty <= 0) return;
    setErrorSaving(true);
    try {
      const costoSust = sustCostoMode === "factura" ? (errorLinea.costo_unitario || 0) : (sustSelected.cost || 0);
      const result = await sustituirProducto(
        selRec.id!,
        errorLinea.id!,
        {
          sku: sustSelected.sku,
          nombre: sustSelected.name,
          codigoML: sustSelected.mlCode || "",
          requiereEtiqueta: sustSelected.requiresLabel !== false,
          costoDiccionario: sustSelected.cost || 0,
        },
        sustQty,
        sustCostoMode === "factura",
      );
      await registrarAjuste({
        recepcion_id: selRec.id!, tipo: "sustitucion",
        sku_original: errorLinea.sku, sku_nuevo: sustSelected.sku,
        campo: "sku",
        valor_anterior: `${errorLinea.sku} × ${errorLinea.qty_factura} @ ${fmtMoney(errorLinea.costo_unitario||0)}`,
        valor_nuevo: `${sustSelected.sku} × ${sustQty} @ ${fmtMoney(costoSust)}`,
        motivo: "Proveedor envió producto distinto", admin: "admin",
      });
      setLineas(await getRecepcionLineas(selRec.id!));
      setDiscrepancias(result.discrepanciasCosto);
      setDiscrepanciasQty(result.discrepancias);
      setAjustes(await getRecepcionAjustes(selRec.id!));
      setErrorLinea(null);
      setSustSelected(null);
    } catch (e: unknown) {
      console.error("Error en sustitución:", e);
      alert(`Error al sustituir: ${e instanceof Error ? e.message : e}`);
    } finally {
      setErrorSaving(false);
    }
  };
  const handleErrorSkuSearch = (q: string) => {
    setErrorSkuSearch(q);
    setErrorSkuResults(q.trim().length >= 2 ? findProduct(q).slice(0, 15) : []);
  };

  const addLinea = () => {
    if (!newSku) return;
    const prod = getStore().products[newSku.toUpperCase()];
    setNewLineas(l => [...l, {
      sku: newSku.toUpperCase(), nombre: prod?.name || newSku, codigoML: prod?.mlCode || "",
      cantidad: newQty, costo: prod?.cost || 0, requiereEtiqueta: prod?.requiresLabel !== false,
    }]);
    setNewSku(""); setNewQty(1);
  };
  const doCreate = async () => {
    if (!newFolio || !newProv || newLineas.length === 0) return;
    setLoading(true);
    await crearRecepcion(newFolio, newProv, "", newLineas, { costo_neto: newCostoNeto || 0, iva: newIva || 0, costo_bruto: newCostoBruto || 0 });
    setNewFolio(""); setNewProv(""); setNewLineas([]); setNewCostoNeto(0); setNewIva(0); setNewCostoBruto(0); setShowCreate(false);
    await loadRecs(); setLoading(false);
  };

  // ==================== DETAIL VIEW ====================
  if (selRec) {
    const total = lineas.length;
    const ubicadas = lineas.filter(l => l.estado === "UBICADA").length;
    const progress = total > 0 ? Math.round((ubicadas / total) * 100) : 0;
    const meta = parseRecepcionMeta(selRec.notas || "");
    const isEditable = !["ANULADA","CERRADA"].includes(selRec.estado);
    const addSuggestions = addSku.length >= 2 ? findProduct(addSku).slice(0, 5) : [];

    return (
      <div>
        <button onClick={() => { setSelRec(null); loadRecs(); }} style={{marginBottom:12,padding:"6px 14px",borderRadius:6,background:"var(--bg3)",color:"var(--txt2)",fontSize:12,fontWeight:600,border:"1px solid var(--bg4)"}}>
          ← Volver a lista
        </button>

        {/* Header card */}
        <div className="card">
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
            <div>
              <div className="card-title">{selRec.proveedor} — Folio {selRec.folio}</div>
              <div style={{fontSize:11,color:"var(--txt3)"}}>{fmtDate(selRec.created_at||"")} · {fmtTime(selRec.created_at||"")} · Creado por: {selRec.created_by}</div>
              {meta.asignados.length > 0 && (
                <div style={{fontSize:11,color:"var(--cyan)",marginTop:4}}>Asignado a: <strong>{meta.asignados.join(", ")}</strong></div>
              )}
              {meta.motivo_anulacion && selRec.estado === "ANULADA" && (
                <div style={{fontSize:11,color:"var(--red)",marginTop:4}}>Motivo anulación: {meta.motivo_anulacion}</div>
              )}
            </div>
            <span style={{padding:"4px 12px",borderRadius:6,background:ESTADO_COLORS_A[selRec.estado],color:"#fff",fontSize:11,fontWeight:700,whiteSpace:"nowrap"}}>
              {ESTADO_LABELS_A[selRec.estado]||selRec.estado}
            </span>
          </div>
          {selRec.estado !== "ANULADA" && (
            <>
              <div style={{marginTop:10,background:"var(--bg3)",borderRadius:6,height:8,overflow:"hidden"}}>
                <div style={{width:`${progress}%`,height:"100%",background:progress===100?"var(--green)":"var(--blue)",borderRadius:6}}/>
              </div>
              <div style={{fontSize:11,color:"var(--txt3)",marginTop:4}}>{ubicadas}/{total} líneas completadas</div>
            </>
          )}
          {/* Factura Original / Ajustada / Diferencia */}
          {(() => {
            // Factura ajustada: calculada dinámicamente de líneas actuales
            const netoAjustado = lineas.reduce((s, l) => s + (l.costo_unitario || 0) * (l.qty_recibida > 0 ? l.qty_recibida : l.qty_factura), 0);
            const ivaAjustado = Math.round(netoAjustado * 0.19);
            const brutoAjustado = netoAjustado + ivaAjustado;
            const hayRecibido = lineas.some(l => l.qty_recibida > 0);

            // Diferencia
            const netoOrig = facturaOrig?.neto || 0;
            const brutoOrig = facturaOrig?.bruto || 0;
            const diffNeto = hayRecibido ? netoAjustado - netoOrig : 0;
            const diffBruto = hayRecibido ? brutoAjustado - brutoOrig : 0;

            const costBlockStyle = {padding:"10px 12px",borderRadius:8,border:"1px solid var(--bg4)",marginTop:10};
            const rowStyle = {display:"flex",justifyContent:"space-between",marginBottom:2,fontSize:12};
            const totalRowStyle = {...rowStyle,borderTop:"1px solid var(--bg4)",paddingTop:4,marginTop:4,marginBottom:0};

            return (facturaOrig || netoAjustado > 0) ? (
              <div style={{marginTop:10}}>
                {/* Bloque 1: Factura Original (editable) */}
                {facturaOrig && !editingFactura && (
                  <div style={{...costBlockStyle,background:"var(--bg3)"}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                      <span style={{fontSize:11,fontWeight:700,color:"var(--txt2)"}}>Factura Original (N° {selRec.folio} — {selRec.proveedor})</span>
                      {isEditable && <button onClick={() => { setEditFacturaLineas(facturaOrig.lineas.map(l => ({...l}))); setEditingFactura(true); }} style={{padding:"3px 8px",borderRadius:4,background:"var(--bg4)",color:"var(--cyan)",fontSize:10,fontWeight:700,border:"1px solid var(--bg4)",cursor:"pointer"}}>Editar</button>}
                    </div>
                    <div style={{marginBottom:8}}>
                      {facturaOrig.lineas.map((fl, i) => (
                        <div key={i} style={{display:"flex",justifyContent:"space-between",fontSize:11,padding:"2px 0",color:"var(--txt2)"}}>
                          <span className="mono" style={{flex:1}}>{fl.sku}</span>
                          <span className="mono" style={{width:60,textAlign:"right"}}>×{fl.cantidad}</span>
                          <span className="mono" style={{width:80,textAlign:"right"}}>@{fmtMoney(fl.costo_unitario)}</span>
                          <span className="mono" style={{width:100,textAlign:"right",fontWeight:700}}>{fmtMoney(fl.cantidad * fl.costo_unitario)}</span>
                        </div>
                      ))}
                    </div>
                    {(() => {
                      const netoCalc = facturaOrig.lineas.reduce((s, l) => s + l.cantidad * l.costo_unitario, 0);
                      const brutoCalc = Math.round(netoCalc * 1.19);
                      const ivaCalc = brutoCalc - netoCalc;
                      const diffNeto = netoCalc - facturaOrig.neto;
                      return (<>
                        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,fontSize:12,padding:"6px 0",borderTop:"1px solid var(--bg4)"}}>
                          <div><span style={{color:"var(--txt3)",fontSize:10}}>Neto (app):</span> <strong>{fmtMoney(facturaOrig.neto)}</strong></div>
                          <div><span style={{color:"var(--txt3)",fontSize:10}}>IVA (app):</span> <strong>{fmtMoney(facturaOrig.iva)}</strong></div>
                          <div><span style={{color:"var(--txt3)",fontSize:10}}>Bruto (app):</span> <strong style={{color:"var(--cyan)"}}>{fmtMoney(facturaOrig.bruto)}</strong></div>
                        </div>
                        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,fontSize:12,padding:"4px 0 0",borderTop:"1px dashed var(--bg4)"}}>
                          <div><span style={{color:"var(--txt3)",fontSize:10}}>Neto (calc):</span> <strong style={{color: diffNeto !== 0 ? "var(--amber)" : "var(--txt)"}}>{fmtMoney(netoCalc)}</strong></div>
                          <div><span style={{color:"var(--txt3)",fontSize:10}}>IVA (calc):</span> <strong style={{color: diffNeto !== 0 ? "var(--amber)" : "var(--txt)"}}>{fmtMoney(ivaCalc)}</strong></div>
                          <div><span style={{color:"var(--txt3)",fontSize:10}}>Bruto (calc):</span> <strong style={{color: diffNeto !== 0 ? "var(--amber)" : "var(--cyan)"}}>{fmtMoney(brutoCalc)}</strong></div>
                        </div>
                        {diffNeto !== 0 && (
                          <div style={{fontSize:10,color:"var(--amber)",marginTop:4,textAlign:"right"}}>
                            Diferencia neto: {diffNeto > 0 ? "+" : ""}{fmtMoney(diffNeto)}
                          </div>
                        )}
                      </>);
                    })()}
                  </div>
                )}
                {/* Bloque 1b: Factura Original — modo edición */}
                {facturaOrig && editingFactura && (
                  <div style={{...costBlockStyle,background:"var(--bg3)",border:"1px solid var(--cyan)"}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                      <span style={{fontSize:11,fontWeight:700,color:"var(--cyan)"}}>Editando Factura Original</span>
                      <div style={{display:"flex",gap:4}}>
                        <button onClick={() => setEditingFactura(false)} style={{padding:"3px 8px",borderRadius:4,background:"var(--bg4)",color:"var(--txt3)",fontSize:10,fontWeight:700,border:"none",cursor:"pointer"}}>Cancelar</button>
                        <button onClick={async () => {
                          const neto = editFacturaLineas.reduce((s, l) => s + l.cantidad * l.costo_unitario, 0);
                          const iva = Math.round(neto * 0.19);
                          const bruto = neto + iva;
                          const newFactura: FacturaOriginal = { lineas: editFacturaLineas, neto, iva, bruto };
                          setLoading(true);
                          await updateRecepcionFacturaOriginal(selRec.id!, newFactura);
                          // Sync qty_factura y costo_unitario en recepcion_lineas; crear línea si es nueva
                          for (const fl of editFacturaLineas) {
                            const match = lineas.find(l => l.sku === fl.sku);
                            if (match) {
                              await actualizarLineaRecepcion(match.id!, { qty_factura: fl.cantidad, costo_unitario: fl.costo_unitario });
                            } else {
                              await agregarLineaRecepcion(selRec.id!, { sku: fl.sku, nombre: fl.nombre, codigoML: "", cantidad: fl.cantidad, costo: fl.costo_unitario, requiereEtiqueta: false });
                            }
                          }
                          // Sync costos en encabezado
                          await actualizarRecepcion(selRec.id!, { costo_neto: neto, iva, costo_bruto: bruto });
                          setEditingFactura(false);
                          await refreshDetail();
                          setLoading(false);
                        }} style={{padding:"3px 8px",borderRadius:4,background:"var(--cyan)",color:"#000",fontSize:10,fontWeight:700,border:"none",cursor:"pointer"}}>Guardar</button>
                      </div>
                    </div>
                    <div style={{marginBottom:8}}>
                      {editFacturaLineas.map((fl, i) => (
                        <div key={i} style={{display:"flex",alignItems:"center",gap:4,fontSize:11,padding:"3px 0",color:"var(--txt2)"}}>
                          <span className="mono" style={{flex:1}}>{fl.sku}</span>
                          <span style={{fontSize:9,color:"var(--txt3)"}}>×</span>
                          <input type="number" value={fl.cantidad} onChange={e => { const v = [...editFacturaLineas]; v[i] = {...v[i], cantidad: Number(e.target.value)||0}; setEditFacturaLineas(v); }}
                            style={{width:50,padding:"2px 4px",borderRadius:4,background:"var(--bg2)",color:"var(--txt)",border:"1px solid var(--bg4)",fontSize:11,textAlign:"right",fontFamily:"var(--font-mono)"}} />
                          <span style={{fontSize:9,color:"var(--txt3)"}}>@$</span>
                          <input type="number" value={fl.costo_unitario} onChange={e => { const v = [...editFacturaLineas]; v[i] = {...v[i], costo_unitario: Number(e.target.value)||0}; setEditFacturaLineas(v); }}
                            style={{width:70,padding:"2px 4px",borderRadius:4,background:"var(--bg2)",color:"var(--txt)",border:"1px solid var(--bg4)",fontSize:11,textAlign:"right",fontFamily:"var(--font-mono)"}} />
                          <span className="mono" style={{width:90,textAlign:"right",fontWeight:700}}>{fmtMoney(fl.cantidad * fl.costo_unitario)}</span>
                          <button onClick={() => { const v = editFacturaLineas.filter((_, j) => j !== i); setEditFacturaLineas(v); }}
                            style={{padding:"1px 5px",borderRadius:4,background:"var(--redBg)",color:"var(--red)",fontSize:10,fontWeight:700,border:"1px solid var(--redBd)",cursor:"pointer",lineHeight:1}}>×</button>
                        </div>
                      ))}
                      {/* Agregar línea */}
                      <div style={{display:"flex",alignItems:"center",gap:4,fontSize:11,padding:"5px 0",borderTop:"1px dashed var(--bg4)",marginTop:4}}>
                        <input placeholder="SKU"
                          id="factura-orig-new-sku"
                          style={{flex:1,padding:"2px 4px",borderRadius:4,background:"var(--bg2)",color:"var(--txt)",border:"1px solid var(--bg4)",fontSize:11,fontFamily:"var(--font-mono)"}} />
                        <span style={{fontSize:9,color:"var(--txt3)"}}>×</span>
                        <input placeholder="Qty" type="number" id="factura-orig-new-qty"
                          style={{width:50,padding:"2px 4px",borderRadius:4,background:"var(--bg2)",color:"var(--txt)",border:"1px solid var(--bg4)",fontSize:11,textAlign:"right",fontFamily:"var(--font-mono)"}} />
                        <span style={{fontSize:9,color:"var(--txt3)"}}>@$</span>
                        <input placeholder="Costo" type="number" id="factura-orig-new-costo"
                          style={{width:70,padding:"2px 4px",borderRadius:4,background:"var(--bg2)",color:"var(--txt)",border:"1px solid var(--bg4)",fontSize:11,textAlign:"right",fontFamily:"var(--font-mono)"}} />
                        <button onClick={() => {
                          const skuEl = document.getElementById("factura-orig-new-sku") as HTMLInputElement;
                          const qtyEl = document.getElementById("factura-orig-new-qty") as HTMLInputElement;
                          const costoEl = document.getElementById("factura-orig-new-costo") as HTMLInputElement;
                          const sku = skuEl?.value?.trim().toUpperCase(); const qty = Number(qtyEl?.value) || 0; const costo = Number(costoEl?.value) || 0;
                          if (!sku) return;
                          const prod = findProduct(sku).find(p => p.sku === sku);
                          setEditFacturaLineas([...editFacturaLineas, { sku, nombre: prod?.name || sku, cantidad: qty, costo_unitario: costo }]);
                          if (skuEl) skuEl.value = ""; if (qtyEl) qtyEl.value = ""; if (costoEl) costoEl.value = "";
                          skuEl?.focus();
                        }} style={{padding:"2px 8px",borderRadius:4,background:"var(--greenBg)",color:"var(--green)",fontSize:10,fontWeight:700,border:"1px solid var(--greenBd)",cursor:"pointer"}}>+</button>
                      </div>
                    </div>
                    {(() => {
                      const neto = editFacturaLineas.reduce((s, l) => s + l.cantidad * l.costo_unitario, 0);
                      const iva = Math.round(neto * 0.19);
                      const bruto = neto + iva;
                      return (
                        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,fontSize:12,padding:"6px 0",borderTop:"1px solid var(--cyan)"}}>
                          <div><span style={{color:"var(--txt3)",fontSize:10}}>Neto:</span> <strong>{fmtMoney(neto)}</strong></div>
                          <div><span style={{color:"var(--txt3)",fontSize:10}}>IVA:</span> <strong>{fmtMoney(iva)}</strong></div>
                          <div><span style={{color:"var(--txt3)",fontSize:10}}>Bruto:</span> <strong style={{color:"var(--cyan)"}}>{fmtMoney(bruto)}</strong></div>
                        </div>
                      );
                    })()}
                  </div>
                )}

                {/* Bloque 2: Factura Ajustada */}
                {hayRecibido && (
                  <div style={{...costBlockStyle,background:"var(--bg3)"}}>
                    <div style={{fontSize:11,fontWeight:700,color:diffNeto!==0?"var(--amber)":"var(--green)",marginBottom:8}}>Factura Ajustada (Real)</div>
                    <div style={{marginBottom:8}}>
                      {lineas.map(l => {
                        const isOriginal = facturaOrig?.lineas.some(fl => fl.sku === l.sku);
                        const noLlego = l.qty_recibida === 0 && l.qty_factura > 0;
                        const esNueva = !isOriginal && l.qty_factura === 0;
                        const subtotal = (l.costo_unitario || 0) * (l.qty_recibida > 0 ? l.qty_recibida : 0);
                        return (
                          <div key={l.id} style={{display:"flex",justifyContent:"space-between",fontSize:11,padding:"2px 0",
                            color: noLlego ? "var(--txt3)" : esNueva ? "var(--cyan)" : "var(--txt2)",
                            textDecoration: noLlego ? "line-through" : "none"}}>
                            <span className="mono" style={{flex:1}}>{l.sku}</span>
                            <span className="mono" style={{width:60,textAlign:"right"}}>×{l.qty_recibida}</span>
                            <span className="mono" style={{width:80,textAlign:"right"}}>@{fmtMoney(l.costo_unitario||0)}</span>
                            <span className="mono" style={{width:100,textAlign:"right",fontWeight:700}}>{fmtMoney(subtotal)}</span>
                            <span style={{width:80,textAlign:"right",fontSize:9,fontWeight:600,color:noLlego?"var(--red)":esNueva?"var(--cyan)":"transparent"}}>
                              {noLlego ? "(no llegó)" : esNueva ? "(nuevo)" : ""}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,fontSize:12,padding:"6px 0",borderTop:"1px solid var(--bg4)"}}>
                      <div><span style={{color:"var(--txt3)",fontSize:10}}>Neto:</span> <strong>{fmtMoney(netoAjustado)}</strong></div>
                      <div><span style={{color:"var(--txt3)",fontSize:10}}>IVA:</span> <strong>{fmtMoney(ivaAjustado)}</strong></div>
                      <div><span style={{color:"var(--txt3)",fontSize:10}}>Bruto:</span> <strong style={{color:diffNeto!==0?"var(--amber)":"var(--cyan)"}}>{fmtMoney(brutoAjustado)}</strong></div>
                    </div>
                  </div>
                )}

                {/* Bloque 3: Diferencia */}
                {hayRecibido && facturaOrig && (
                  <div style={{...costBlockStyle,
                    background: diffNeto === 0 ? "var(--greenBg)" : diffNeto > 0 ? "var(--amberBg)" : "var(--redBg)",
                    border: `1px solid ${diffNeto === 0 ? "var(--greenBd,var(--green))" : diffNeto > 0 ? "var(--amberBd)" : "var(--redBd,var(--red))"}`}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                      <div style={{fontSize:12}}>
                        <span style={{fontWeight:700,color:diffNeto===0?"var(--green)":diffNeto>0?"var(--amber)":"var(--red)"}}>
                          Diferencia: {diffNeto>=0?"+":""}{ fmtMoney(diffNeto)} neto | {diffBruto>=0?"+":""}{fmtMoney(diffBruto)} bruto
                        </span>
                      </div>
                    </div>
                    <div style={{fontSize:11,marginTop:4,fontWeight:600,color:diffNeto===0?"var(--green)":diffNeto>0?"var(--amber)":"var(--red)"}}>
                      {diffNeto === 0
                        ? "Factura cuadra perfectamente"
                        : diffNeto > 0
                        ? `Recibiste de más: ${fmtMoney(Math.abs(diffNeto))} neto (te deben)`
                        : `No llegó todo: te deben nota de crédito por ${fmtMoney(Math.abs(diffNeto))} neto`}
                    </div>
                  </div>
                )}

                {/* Historial de ajustes */}
                {ajustes.length > 0 && (
                  <div style={{...costBlockStyle,background:"var(--bg3)"}}>
                    <button onClick={()=>setShowAjustes(!showAjustes)} style={{width:"100%",display:"flex",justifyContent:"space-between",alignItems:"center",background:"none",border:"none",cursor:"pointer",padding:0}}>
                      <span style={{fontSize:11,fontWeight:700,color:"var(--txt2)"}}>Historial de ajustes ({ajustes.length})</span>
                      <span style={{fontSize:12,color:"var(--txt3)"}}>{showAjustes ? "▲" : "▼"}</span>
                    </button>
                    {showAjustes && (
                      <div style={{marginTop:8}}>
                        {ajustes.map(a => (
                          <div key={a.id} style={{padding:"6px 0",borderBottom:"1px solid var(--bg4)",fontSize:11}}>
                            <div style={{display:"flex",justifyContent:"space-between",marginBottom:2}}>
                              <span style={{fontWeight:700,color:
                                a.tipo==="sustitucion"?"var(--cyan)":
                                a.tipo==="linea_agregada"?"var(--green)":
                                a.tipo==="linea_eliminada"?"var(--red)":
                                a.tipo==="costo"?"var(--amber)":"var(--txt2)"}}>
                                {a.tipo==="sustitucion"?"Sustitución":a.tipo==="cantidad"?"Cantidad":a.tipo==="linea_agregada"?"Línea agregada":a.tipo==="linea_eliminada"?"Línea eliminada":a.tipo==="costo"?"Costo":a.tipo}
                              </span>
                              <span style={{color:"var(--txt3)",fontSize:10}}>{a.created_at ? `${fmtDate(a.created_at)} ${fmtTime(a.created_at)}` : ""} — {a.admin||""}</span>
                            </div>
                            {a.tipo==="sustitucion" && <div style={{color:"var(--txt2)"}}><span className="mono">{a.sku_original}</span> → <span className="mono">{a.sku_nuevo}</span></div>}
                            {a.tipo==="cantidad" && <div style={{color:"var(--txt2)"}}><span className="mono">{a.sku_original}</span>: {a.valor_anterior} → {a.valor_nuevo}</div>}
                            {a.tipo==="linea_agregada" && <div style={{color:"var(--txt2)"}}><span className="mono">{a.sku_nuevo}</span>: {a.valor_nuevo}</div>}
                            {a.tipo==="linea_eliminada" && <div style={{color:"var(--txt2)"}}><span className="mono">{a.sku_original}</span>: {a.valor_anterior}</div>}
                            {a.tipo==="costo" && <div style={{color:"var(--txt2)"}}><span className="mono">{a.sku_original}</span>: {a.valor_anterior} → {a.valor_nuevo}</div>}
                            {a.motivo && <div style={{color:"var(--txt3)",fontSize:10,marginTop:2}}>{a.motivo}</div>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : null;
          })()}
        </div>

        {/* Action bar */}
        <div style={{display:"flex",gap:6,marginTop:12,flexWrap:"wrap"}}>
          {isEditable && <button onClick={()=>setEditing(!editing)} style={{padding:"8px 14px",borderRadius:6,background:editing?"var(--cyan)":"var(--bg3)",color:editing?"#000":"var(--cyan)",fontSize:11,fontWeight:700,border:"1px solid var(--bg4)"}}>
            {editing ? "Cancelar edición" : "Editar"}
          </button>}
          {["CREADA","EN_PROCESO"].includes(selRec.estado) && <button onClick={doPausar} style={{padding:"8px 14px",borderRadius:6,background:"var(--bg3)",color:"#8b5cf6",fontSize:11,fontWeight:700,border:"1px solid var(--bg4)"}}>Pausar</button>}
          {selRec.estado === "PAUSADA" && <button onClick={doReactivar} style={{padding:"8px 14px",borderRadius:6,background:"var(--bg3)",color:"var(--green)",fontSize:11,fontWeight:700,border:"1px solid var(--bg4)"}}>Reactivar</button>}
          {selRec.estado === "ANULADA" && <button onClick={doReactivar} style={{padding:"8px 14px",borderRadius:6,background:"var(--bg3)",color:"var(--green)",fontSize:11,fontWeight:700,border:"1px solid var(--bg4)"}}>Reabrir</button>}
          {selRec.estado === "COMPLETADA" && <button onClick={doCerrar} style={{padding:"8px 14px",borderRadius:6,background:"var(--bg3)",color:"var(--txt3)",fontSize:11,fontWeight:700,border:"1px solid var(--bg4)"}}>Cerrar</button>}
          {selRec.estado === "CERRADA" && <button onClick={doReactivar} style={{padding:"8px 14px",borderRadius:6,background:"var(--bg3)",color:"var(--green)",fontSize:11,fontWeight:700,border:"1px solid var(--bg4)"}}>Reabrir</button>}
          {selRec.estado !== "ANULADA" && <button onClick={()=>setShowAnular(!showAnular)} style={{padding:"8px 14px",borderRadius:6,background:showAnular?"var(--red)":"var(--bg3)",color:showAnular?"#fff":"var(--red)",fontSize:11,fontWeight:700,border:"1px solid var(--bg4)"}}>Anular</button>}
          <button onClick={refreshDetail} style={{padding:"8px 14px",borderRadius:6,background:"var(--bg3)",color:"var(--cyan)",fontSize:11,fontWeight:700,border:"1px solid var(--bg4)"}}>Actualizar</button>
          <button disabled={auditing} onClick={async()=>{
            setAuditing(true); setAuditResults(null);
            try { const r = await auditarRecepcion(selRec.id!); setAuditResults(r); }
            finally { setAuditing(false); }
          }} style={{padding:"8px 14px",borderRadius:6,background:"var(--amberBg)",color:"var(--amber)",fontSize:11,fontWeight:700,border:"1px solid var(--amberBd)"}}>
            {auditing ? "Auditando..." : "Auditar inventario"}
          </button>
        </div>

        {/* Audit results */}
        {auditResults !== null && (
          <div className="card" style={{marginTop:12,border:"2px solid var(--amber)"}}>
            <div style={{fontSize:13,fontWeight:700,color:"var(--amber)",marginBottom:8}}>
              Resultado de auditoria — {auditResults.length === 0 ? "Todo OK" : `${auditResults.length} problemas encontrados`}
            </div>
            {auditResults.length === 0 ? (
              <div style={{padding:12,textAlign:"center",color:"var(--green)",fontWeight:600}}>
                Todas las lineas UBICADAS tienen stock y movimientos correctos.
              </div>
            ) : (
              <>
                <div style={{overflowX:"auto"}}>
                  <table className="tbl">
                    <thead><tr><th>SKU</th><th>Producto</th><th style={{textAlign:"right"}}>Ubicado</th><th style={{textAlign:"right"}}>Movimientos</th><th style={{textAlign:"right"}}>Stock actual</th><th>Problema</th><th>Estado</th></tr></thead>
                    <tbody>{auditResults.map(r => (
                      <tr key={r.linea_id} style={{background: r.reparado ? "var(--greenBg)" : "var(--redBg)"}}>
                        <td className="mono" style={{fontSize:11,fontWeight:700}}>{r.sku}</td>
                        <td style={{fontSize:11}}>{r.nombre}</td>
                        <td className="mono" style={{textAlign:"right"}}>{r.qty_ubicada}</td>
                        <td className="mono" style={{textAlign:"right",color:r.movimientos_encontrados===0?"var(--red)":"var(--txt1)"}}>{r.movimientos_encontrados}</td>
                        <td className="mono" style={{textAlign:"right",color:r.stock_actual===0?"var(--red)":"var(--txt1)"}}>{r.stock_actual}</td>
                        <td style={{fontSize:10,color:"var(--red)",fontWeight:600}}>{r.problema}</td>
                        <td>{r.reparado ? <span style={{fontSize:10,fontWeight:700,color:"var(--green)"}}>REPARADO: {r.detalle}</span> : <span style={{fontSize:10,color:"var(--txt3)"}}>{r.estado}</span>}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
                {!auditResults.some(r => r.reparado) && (
                  <div style={{marginTop:12,padding:12,borderRadius:8,background:"var(--bg3)",display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                    <span style={{fontSize:11,fontWeight:600}}>Reparar: registrar stock faltante en</span>
                    <select className="form-select" value={repairPos} onChange={e=>setRepairPos(e.target.value)} style={{fontSize:11,padding:"4px 8px"}}>
                      {activePositions().map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                    </select>
                    <button disabled={repairing} onClick={async()=>{
                      if (!confirm(`Esto registrara el stock faltante en posicion "${repairPos}" y creara los movimientos. Continuar?`)) return;
                      setRepairing(true);
                      try {
                        const r = await repararRecepcion(selRec.id!, repairPos);
                        setAuditResults(r);
                        await refreshDetail();
                      } finally { setRepairing(false); }
                    }} style={{padding:"8px 16px",borderRadius:6,background:"var(--green)",color:"#fff",fontSize:11,fontWeight:700,border:"none",cursor:"pointer"}}>
                      {repairing ? "Reparando..." : "Reparar ahora"}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Anular dialog */}
        {showAnular && (
          <div className="card" style={{marginTop:12,border:"2px solid var(--red)"}}>
            <div style={{fontSize:13,fontWeight:700,color:"var(--red)",marginBottom:8}}>Anular recepción</div>
            <div style={{fontSize:12,color:"var(--txt3)",marginBottom:8}}>Esta acción marcará la recepción como anulada. Los operadores ya no la verán.</div>
            <input className="form-input" value={anularMotivo} onChange={e=>setAnularMotivo(e.target.value)} placeholder="Motivo de anulación (opcional)" style={{marginBottom:8}}/>
            <div style={{display:"flex",gap:8}}>
              <button onClick={doAnular} disabled={loading} style={{padding:"8px 16px",borderRadius:6,background:"var(--red)",color:"#fff",fontSize:12,fontWeight:700}}>
                {loading ? "Anulando..." : "Confirmar anulación"}
              </button>
              <button onClick={()=>{setShowAnular(false);setAnularMotivo("");}} style={{padding:"8px 16px",borderRadius:6,background:"var(--bg3)",color:"var(--txt2)",fontSize:12,fontWeight:600,border:"1px solid var(--bg4)"}}>Cancelar</button>
            </div>
          </div>
        )}

        {/* Edit panel */}
        {editing && (
          <div className="card" style={{marginTop:12,border:"2px solid var(--cyan)"}}>
            <div style={{fontSize:13,fontWeight:700,color:"var(--cyan)",marginBottom:10}}>Editar recepción</div>
            <div className="admin-grid-2" style={{marginBottom:10}}>
              <div>
                <label style={{fontSize:11,color:"var(--txt3)",fontWeight:600}}>Folio</label>
                <input className="form-input" value={editFolio} onChange={e=>setEditFolio(e.target.value)} style={{marginTop:4}}/>
              </div>
              <div>
                <label style={{fontSize:11,color:"var(--txt3)",fontWeight:600}}>Proveedor</label>
                <select className="form-select" value={editProv} onChange={e=>setEditProv(e.target.value)} style={{marginTop:4}}>
                  <option value="">Seleccionar...</option>
                  {getProveedores().map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
            </div>
            <div style={{marginBottom:10}}>
              <label style={{fontSize:11,color:"var(--txt3)",fontWeight:600}}>Notas</label>
              <textarea className="form-input" value={editNotas} onChange={e=>setEditNotas(e.target.value)} rows={2} style={{marginTop:4,resize:"vertical"}}/>
            </div>
            <div style={{marginBottom:12}}>
              <label style={{fontSize:11,color:"var(--txt3)",fontWeight:600,display:"block",marginBottom:6}}>Asignar operarios (vacío = visible para todos)</label>
              <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                {operarios.map(op => (
                  <button key={op.id} onClick={()=>toggleOp(op.nombre)}
                    style={{padding:"6px 12px",borderRadius:6,fontSize:11,fontWeight:600,cursor:"pointer",
                      background:editAsignados.includes(op.nombre)?"var(--cyan)":"var(--bg3)",
                      color:editAsignados.includes(op.nombre)?"#000":"var(--txt2)",
                      border:`1px solid ${editAsignados.includes(op.nombre)?"var(--cyan)":"var(--bg4)"}`}}>
                    {editAsignados.includes(op.nombre)?"✓ ":""}{op.nombre}
                  </button>
                ))}
                {operarios.length === 0 && <span style={{fontSize:11,color:"var(--txt3)"}}>No hay operarios registrados en el sistema</span>}
              </div>
            </div>
            <div style={{marginBottom:12}}>
              <label style={{fontSize:11,color:"var(--txt3)",fontWeight:600,display:"block",marginBottom:6}}>Costos de factura</label>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
                <div>
                  <label style={{fontSize:10,color:"var(--txt3)"}}>Neto</label>
                  <input type="number" className="form-input" value={editCostoNeto||""} onChange={e=>{const v=parseFloat(e.target.value)||0;setEditCostoNeto(v);setEditIva(Math.round(v*0.19));setEditCostoBruto(Math.round(v*1.19));}}
                    placeholder="$0" style={{marginTop:2,fontSize:12}}/>
                </div>
                <div>
                  <label style={{fontSize:10,color:"var(--txt3)"}}>IVA (19%)</label>
                  <input type="number" className="form-input" value={editIva||""} onChange={e=>setEditIva(parseFloat(e.target.value)||0)}
                    placeholder="$0" style={{marginTop:2,fontSize:12}}/>
                </div>
                <div>
                  <label style={{fontSize:10,color:"var(--txt3)"}}>Bruto</label>
                  <input type="number" className="form-input" value={editCostoBruto||""} onChange={e=>{const v=parseFloat(e.target.value)||0;setEditCostoBruto(v);setEditCostoNeto(Math.round(v/1.19));setEditIva(Math.round(v-v/1.19));}}
                    placeholder="$0" style={{marginTop:2,fontSize:12}}/>
                </div>
              </div>
            </div>
            <button onClick={doSaveEdit} disabled={loading} style={{padding:"10px 20px",borderRadius:6,background:"var(--green)",color:"#fff",fontSize:12,fontWeight:700}}>
              {loading ? "Guardando..." : "Guardar cambios"}
            </button>
          </div>
        )}

        {/* Discrepancy panel */}
        {discrepancias.length > 0 && (
          <div className="card" style={{marginTop:12,border: tieneDiscrepanciasPendientes(discrepancias) ? "2px solid var(--amber)" : "1px solid var(--bg4)"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
              <div style={{fontSize:13,fontWeight:700,color: tieneDiscrepanciasPendientes(discrepancias) ? "var(--amber)" : "var(--green)"}}>
                Discrepancias de costo ({discrepancias.filter(d=>d.estado==="PENDIENTE").length} pendientes)
              </div>
              <div style={{display:"flex",gap:6,alignItems:"center"}}>
                {tieneDiscrepanciasPendientes(discrepancias) && (
                  <span style={{fontSize:10,padding:"3px 8px",borderRadius:4,background:"var(--amberBg)",color:"var(--amber)",fontWeight:700,border:"1px solid var(--amberBd)"}}>
                    Resolver antes de cerrar
                  </span>
                )}
                <button onClick={async()=>{if(!selRec)return;const d=await recalcularDiscrepancias(selRec.id!,lineas);setDiscrepancias(d);}} style={{fontSize:10,padding:"3px 8px",borderRadius:4,background:"var(--bg3)",color:"var(--cyan)",fontWeight:700,border:"1px solid var(--bg4)",cursor:"pointer"}} title="Recalcular discrepancias (borra pendientes y re-detecta)">
                  Recalcular
                </button>
              </div>
            </div>
            <div style={{overflowX:"auto"}}>
              <table className="tbl">
                <thead><tr>
                  <th>SKU</th>
                  <th style={{textAlign:"right"}}>Diccionario</th>
                  <th style={{textAlign:"right"}}>Factura</th>
                  <th style={{textAlign:"right"}}>Diferencia</th>
                  <th>Estado</th>
                  <th>Acciones</th>
                </tr></thead>
                <tbody>{discrepancias.map(d => (
                  <tr key={d.id} style={{background: d.estado==="PENDIENTE" ? "var(--amberBg)" : d.estado==="APROBADO" ? "var(--greenBg)" : "var(--redBg)"}}>
                    <td className="mono" style={{fontSize:11,fontWeight:700}}>{d.sku}</td>
                    <td className="mono" style={{textAlign:"right",fontSize:12}}>{d.costo_diccionario > 0 ? fmtMoney(d.costo_diccionario) : <span style={{color:"var(--txt3)",fontSize:10}}>Sin costo</span>}</td>
                    <td className="mono" style={{textAlign:"right",fontSize:12,fontWeight:700}}>{fmtMoney(d.costo_factura)}</td>
                    <td className="mono" style={{textAlign:"right",fontSize:12,fontWeight:700,color:d.diferencia>0?"var(--red)":"var(--green)"}}>
                      {d.diferencia > 0 ? "+" : ""}{fmtMoney(d.diferencia)} ({d.porcentaje > 0 ? "+" : ""}{d.porcentaje}%)
                    </td>
                    <td>
                      <span style={{fontSize:10,fontWeight:700,padding:"2px 6px",borderRadius:4,
                        background: d.estado==="PENDIENTE" ? "var(--amberBg)" : d.estado==="APROBADO" ? "var(--greenBg)" : "var(--redBg)",
                        color: d.estado==="PENDIENTE" ? "var(--amber)" : d.estado==="APROBADO" ? "var(--green)" : "var(--red)",
                        border: `1px solid ${d.estado==="PENDIENTE" ? "var(--amberBd)" : d.estado==="APROBADO" ? "var(--greenBd,var(--green))" : "var(--redBd,var(--red))"}`}}>
                        {d.estado}
                      </span>
                      {d.notas && <div style={{fontSize:9,color:"var(--txt3)",marginTop:2}}>{d.notas}</div>}
                    </td>
                    <td style={{whiteSpace:"nowrap"}}>
                      {d.estado === "PENDIENTE" ? (
                        <div style={{display:"flex",gap:4}}>
                          <button onClick={()=>doAprobar(d)} disabled={loading}
                            style={{padding:"4px 8px",borderRadius:4,background:"var(--green)",color:"#fff",fontSize:10,fontWeight:700,cursor:"pointer",border:"none"}}
                            title="Aprobar: actualizar diccionario con nuevo costo">
                            Aprobar
                          </button>
                          <button onClick={()=>doRechazar(d)} disabled={loading}
                            style={{padding:"4px 8px",borderRadius:4,background:"var(--red)",color:"#fff",fontSize:10,fontWeight:700,cursor:"pointer",border:"none"}}
                            title="Rechazar: error del proveedor, reclamar">
                            Rechazar
                          </button>
                        </div>
                      ) : (
                        <span style={{fontSize:10,color:"var(--txt3)"}}>{d.resuelto_at ? fmtDate(d.resuelto_at) : ""}</span>
                      )}
                    </td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </div>
        )}

        {/* Quantity discrepancy panel */}
        {discrepanciasQty.length > 0 && (
          <div className="card" style={{marginTop:12,border: tieneDiscrepanciasQtyPendientes(discrepanciasQty) ? "2px solid var(--amber)" : "1px solid var(--bg4)"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
              <div style={{fontSize:13,fontWeight:700,color: tieneDiscrepanciasQtyPendientes(discrepanciasQty) ? "var(--amber)" : "var(--green)"}}>
                Discrepancias de cantidad ({discrepanciasQty.filter(d=>d.estado==="PENDIENTE").length} pendientes)
              </div>
              <div style={{display:"flex",gap:6,alignItems:"center"}}>
                {tieneDiscrepanciasQtyPendientes(discrepanciasQty) && (
                  <span style={{fontSize:10,padding:"3px 8px",borderRadius:4,background:"var(--amberBg)",color:"var(--amber)",fontWeight:700,border:"1px solid var(--amberBd)"}}>
                    Resolver antes de cerrar
                  </span>
                )}
                <button onClick={async()=>{if(!selRec)return;const d=await recalcularDiscrepanciasQty(selRec.id!,lineas);setDiscrepanciasQty(d);}} style={{fontSize:10,padding:"3px 8px",borderRadius:4,background:"var(--bg3)",color:"var(--cyan)",fontWeight:700,border:"1px solid var(--bg4)",cursor:"pointer"}} title="Recalcular discrepancias de cantidad">
                  Recalcular
                </button>
              </div>
            </div>
            <div style={{overflowX:"auto"}}>
              <table className="tbl">
                <thead><tr>
                  <th>SKU</th>
                  <th>Tipo</th>
                  <th style={{textAlign:"right"}}>Factura</th>
                  <th style={{textAlign:"right"}}>Recibido</th>
                  <th style={{textAlign:"right"}}>Diferencia</th>
                  <th>Estado</th>
                  <th>Resolución</th>
                </tr></thead>
                <tbody>{discrepanciasQty.map(d => {
                  const tipoLabel: Record<string,string> = { FALTANTE: "Faltante", SOBRANTE: "Sobrante", SKU_ERRONEO: "SKU erróneo", NO_EN_FACTURA: "No en factura" };
                  const tipoColor: Record<string,string> = { FALTANTE: "var(--red)", SOBRANTE: "var(--amber)", SKU_ERRONEO: "var(--red)", NO_EN_FACTURA: "var(--cyan)" };
                  const estadoLabel: Record<string,string> = { PENDIENTE: "Pendiente", ACEPTADO: "Aceptado", RECLAMADO: "Reclamado", NOTA_CREDITO: "Nota crédito", DEVOLUCION: "Devolución", SUSTITUCION: "Sustitución" };
                  const estadoColor: Record<string,string> = { PENDIENTE: "var(--amber)", ACEPTADO: "var(--green)", RECLAMADO: "var(--blue,var(--cyan))", NOTA_CREDITO: "var(--cyan)", DEVOLUCION: "var(--red)", SUSTITUCION: "var(--cyan)" };
                  return (
                  <tr key={d.id} style={{background: d.estado==="PENDIENTE" ? "var(--amberBg)" : "transparent"}}>
                    <td className="mono" style={{fontSize:11,fontWeight:700}}>{d.sku}</td>
                    <td>
                      <span style={{fontSize:10,fontWeight:700,padding:"2px 6px",borderRadius:4,color:tipoColor[d.tipo]||"var(--txt2)"}}>
                        {tipoLabel[d.tipo]||d.tipo}
                      </span>
                    </td>
                    <td className="mono" style={{textAlign:"right",fontSize:12}}>{d.qty_factura}</td>
                    <td className="mono" style={{textAlign:"right",fontSize:12,fontWeight:700}}>{d.qty_recibida}</td>
                    <td className="mono" style={{textAlign:"right",fontSize:12,fontWeight:700,color:d.diferencia>0?"var(--amber)":"var(--red)"}}>
                      {d.diferencia > 0 ? "+" : ""}{d.diferencia}
                    </td>
                    <td>
                      <span style={{fontSize:10,fontWeight:700,padding:"2px 6px",borderRadius:4,color:estadoColor[d.estado]||"var(--txt2)"}}>
                        {estadoLabel[d.estado]||d.estado}
                      </span>
                      {d.notas && <div style={{fontSize:9,color:"var(--txt3)",marginTop:2}}>{d.notas}</div>}
                    </td>
                    <td style={{whiteSpace:"nowrap"}}>
                      {d.estado === "PENDIENTE" ? (
                        <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                          {getResolucionesQty(d.tipo).map(r => (
                            <button key={r.valor} onClick={async()=>{
                              const nota = prompt(`${r.label} — Notas (opcional):`, "");
                              if (nota === null) return;
                              setLoading(true);
                              try {
                                await resolverDiscrepanciaQty(d.id!, r.valor, nota);
                                await refreshDetail();
                              } catch (e: unknown) {
                                console.error("Error resolviendo discrepancia qty:", e);
                                alert(`Error al resolver: ${e instanceof Error ? e.message : e}`);
                              } finally {
                                setLoading(false);
                              }
                            }} disabled={loading}
                              style={{padding:"4px 8px",borderRadius:4,background:r.valor==="ACEPTADO"?"var(--green)":r.valor==="DEVOLUCION"?"var(--red)":"var(--cyan)",color:"#fff",fontSize:10,fontWeight:700,cursor:"pointer",border:"none"}}>
                              {r.label}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <span style={{fontSize:10,color:"var(--txt3)"}}>{d.resuelto_at ? fmtDate(d.resuelto_at) : ""}{d.resuelto_por ? ` · ${d.resuelto_por}` : ""}</span>
                      )}
                    </td>
                  </tr>
                  );
                })}</tbody>
              </table>
            </div>
          </div>
        )}

        {/* Error report modal */}
        {errorLinea && (
          <div style={{position:"fixed",inset:0,zIndex:300,background:"rgba(0,0,0,0.6)",display:"flex",alignItems:"center",justifyContent:"center",padding:20}}
            onClick={closeErrorReport}>
            <div style={{width:"100%",maxWidth:420,background:"var(--bg2)",borderRadius:14,border:"1px solid var(--bg4)",overflow:"hidden"}}
              onClick={e=>e.stopPropagation()}>

              {/* Menu */}
              {errorMode === "menu" && (
                <div style={{padding:24}}>
                  <div style={{fontSize:16,fontWeight:800,marginBottom:4,textAlign:"center"}}>Reportar Error</div>
                  <div style={{fontSize:12,color:"var(--txt3)",textAlign:"center",marginBottom:16}}>
                    <span className="mono" style={{fontWeight:700}}>{errorLinea.sku}</span> — {errorLinea.nombre}
                  </div>
                  <button onClick={()=>{setErrorMode("conteo");setErrorQty(errorLinea.qty_factura);}}
                    style={{width:"100%",padding:"16px 14px",borderRadius:10,background:"var(--bg3)",border:"1px solid var(--bg4)",marginBottom:8,textAlign:"left",cursor:"pointer"}}>
                    <div style={{fontSize:14,fontWeight:700,color:"var(--amber)"}}>Diferencia en conteo</div>
                    <div style={{fontSize:11,color:"var(--txt3)",marginTop:2}}>La cantidad real no coincide con la factura</div>
                  </button>
                  <button onClick={()=>{setErrorMode("sku");setErrorSkuSearch("");setErrorSkuResults([]);}}
                    style={{width:"100%",padding:"16px 14px",borderRadius:10,background:"var(--bg3)",border:"1px solid var(--bg4)",marginBottom:8,textAlign:"left",cursor:"pointer"}}>
                    <div style={{fontSize:14,fontWeight:700,color:"var(--red)"}}>SKU incorrecto</div>
                    <div style={{fontSize:11,color:"var(--txt3)",marginTop:2}}>El producto fisico no corresponde al SKU de la factura</div>
                  </button>
                  <button onClick={()=>{setErrorMode("sustitucion");setErrorSkuSearch("");setErrorSkuResults([]);setSustSelected(null);setSustQty(errorLinea?.qty_factura||0);setSustCostoMode("factura");}}
                    style={{width:"100%",padding:"16px 14px",borderRadius:10,background:"var(--bg3)",border:"1px solid var(--cyan)",marginBottom:8,textAlign:"left",cursor:"pointer"}}>
                    <div style={{fontSize:14,fontWeight:700,color:"var(--cyan)"}}>Sustitución de producto</div>
                    <div style={{fontSize:11,color:"var(--txt3)",marginTop:2}}>El proveedor envió un producto distinto al facturado. Se registran ambos SKUs y se ajustan costos.</div>
                  </button>
                  <button onClick={closeErrorReport}
                    style={{width:"100%",padding:12,borderRadius:8,background:"var(--bg3)",color:"var(--txt3)",fontSize:13,fontWeight:600,border:"1px solid var(--bg4)"}}>
                    Cancelar
                  </button>
                </div>
              )}

              {/* Ajuste conteo */}
              {errorMode === "conteo" && (
                <div style={{padding:24}}>
                  <div style={{fontSize:14,fontWeight:800,marginBottom:4}}>Ajustar cantidad de factura</div>
                  <div style={{fontSize:12,color:"var(--txt3)",marginBottom:4}}>
                    <span className="mono" style={{fontWeight:700}}>{errorLinea.sku}</span> — {errorLinea.nombre}
                  </div>
                  <div style={{fontSize:12,color:"var(--txt3)",marginBottom:12}}>
                    Cantidad actual: <strong style={{color:"var(--amber)"}}>{errorLinea.qty_factura}</strong>
                  </div>
                  <div style={{fontSize:12,fontWeight:600,color:"var(--txt2)",marginBottom:8}}>Cantidad correcta:</div>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:12,marginBottom:16}}>
                    <button onClick={()=>setErrorQty(q=>Math.max(0,q-1))}
                      style={{width:48,height:48,borderRadius:10,background:"var(--bg3)",fontSize:22,fontWeight:700,border:"1px solid var(--bg4)"}}>−</button>
                    <input type="number" value={errorQty} onFocus={e=>e.target.select()} onChange={e=>setErrorQty(Math.max(0,parseInt(e.target.value)||0))}
                      style={{width:90,textAlign:"center",fontSize:32,fontWeight:700,padding:10,borderRadius:10,background:"var(--bg)",border:"2px solid var(--bg4)",color:"var(--txt1)"}} />
                    <button onClick={()=>setErrorQty(q=>q+1)}
                      style={{width:48,height:48,borderRadius:10,background:"var(--bg3)",fontSize:22,fontWeight:700,border:"1px solid var(--bg4)"}}>+</button>
                  </div>
                  {errorQty !== errorLinea.qty_factura && (
                    <div style={{textAlign:"center",marginBottom:12,padding:"8px 12px",borderRadius:8,
                      background:errorQty > errorLinea.qty_factura ? "var(--greenBg)" : "var(--redBg)",
                      color:errorQty > errorLinea.qty_factura ? "var(--green)" : "var(--red)",
                      fontSize:13,fontWeight:700}}>
                      {errorQty > errorLinea.qty_factura
                        ? `+${errorQty - errorLinea.qty_factura} unidades mas`
                        : `${errorLinea.qty_factura - errorQty} unidades menos`}
                    </div>
                  )}
                  <div style={{display:"flex",gap:8}}>
                    <button onClick={()=>setErrorMode("menu")}
                      style={{flex:1,padding:12,borderRadius:8,background:"var(--bg3)",color:"var(--txt3)",fontSize:13,fontWeight:600,border:"1px solid var(--bg4)"}}>
                      Atras
                    </button>
                    <button onClick={doErrorAjusteConteo} disabled={errorSaving || errorQty === errorLinea.qty_factura}
                      style={{flex:2,padding:12,borderRadius:8,
                        background:(errorSaving || errorQty === errorLinea.qty_factura) ? "var(--bg3)" : "var(--green)",
                        color:(errorSaving || errorQty === errorLinea.qty_factura) ? "var(--txt3)" : "#fff",
                        fontSize:13,fontWeight:700}}>
                      {errorSaving ? "Guardando..." : "Confirmar ajuste"}
                    </button>
                  </div>
                </div>
              )}

              {/* Cambio SKU */}
              {errorMode === "sku" && (
                <div style={{padding:24}}>
                  <div style={{fontSize:14,fontWeight:800,marginBottom:4}}>Cambiar SKU</div>
                  <div style={{fontSize:12,color:"var(--txt3)",marginBottom:12}}>
                    SKU actual: <strong className="mono" style={{color:"var(--red)"}}>{errorLinea.sku}</strong> — {errorLinea.nombre}
                  </div>
                  <input type="text" className="form-input" value={errorSkuSearch} onChange={e=>handleErrorSkuSearch(e.target.value)}
                    placeholder="Buscar por SKU, nombre o codigo ML..." autoFocus style={{marginBottom:8,fontSize:13}} />
                  <div style={{maxHeight:280,overflowY:"auto",marginBottom:12}}>
                    {errorSkuSearch.trim().length >= 2 && errorSkuResults.length === 0 && (
                      <div style={{textAlign:"center",padding:16,color:"var(--txt3)",fontSize:12}}>Sin resultados</div>
                    )}
                    {errorSkuResults.map(p => (
                      <div key={p.sku} onClick={()=>!errorSaving && doErrorCambioSku(p)}
                        style={{padding:"10px 12px",borderRadius:8,background:"var(--bg3)",border:"1px solid var(--bg4)",
                          marginBottom:4,cursor:"pointer",opacity:p.sku===errorLinea.sku?0.4:1}}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                          <span className="mono" style={{fontWeight:700,fontSize:13,color:"var(--cyan)"}}>{p.sku}</span>
                          {p.mlCode && <span className="mono" style={{fontSize:10,color:"var(--txt3)"}}>{p.mlCode}</span>}
                        </div>
                        <div style={{fontSize:11,color:"var(--txt2)",marginTop:2}}>{p.name}</div>
                      </div>
                    ))}
                  </div>
                  <button onClick={()=>setErrorMode("menu")}
                    style={{width:"100%",padding:12,borderRadius:8,background:"var(--bg3)",color:"var(--txt3)",fontSize:13,fontWeight:600,border:"1px solid var(--bg4)"}}>
                    Atras
                  </button>
                </div>
              )}

              {/* Sustitución de producto */}
              {errorMode === "sustitucion" && errorLinea && (
                <div style={{padding:24}}>
                  <div style={{fontSize:14,fontWeight:800,marginBottom:4}}>Sustitución de producto</div>
                  <div style={{fontSize:12,color:"var(--txt3)",marginBottom:4}}>
                    Factura: <strong className="mono" style={{color:"var(--red)"}}>{errorLinea.sku}</strong> — {errorLinea.nombre}
                  </div>
                  <div style={{fontSize:11,color:"var(--txt3)",marginBottom:12}}>
                    Qty factura: <strong>{errorLinea.qty_factura}</strong> · Costo unit: <strong>{fmtMoney(errorLinea.costo_unitario||0)}</strong>
                  </div>

                  {/* Step 1: Search substitute product */}
                  {!sustSelected ? (
                    <>
                      <div style={{fontSize:12,fontWeight:700,color:"var(--cyan)",marginBottom:6}}>Producto que llegó realmente:</div>
                      <input type="text" className="form-input" value={errorSkuSearch} onChange={e=>handleErrorSkuSearch(e.target.value)}
                        placeholder="Buscar por SKU, nombre o codigo ML..." autoFocus style={{marginBottom:8,fontSize:13}} />
                      <div style={{maxHeight:220,overflowY:"auto",marginBottom:12}}>
                        {errorSkuSearch.trim().length >= 2 && errorSkuResults.length === 0 && (
                          <div style={{textAlign:"center",padding:16,color:"var(--txt3)",fontSize:12}}>Sin resultados</div>
                        )}
                        {errorSkuResults.map(p => (
                          <div key={p.sku} onClick={()=>{setSustSelected(p);}}
                            style={{padding:"10px 12px",borderRadius:8,background:"var(--bg3)",border:"1px solid var(--bg4)",
                              marginBottom:4,cursor:"pointer",opacity:p.sku===errorLinea.sku?0.4:1}}>
                            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                              <span className="mono" style={{fontWeight:700,fontSize:13,color:"var(--cyan)"}}>{p.sku}</span>
                              <span className="mono" style={{fontSize:10,color:"var(--txt3)"}}>{fmtMoney(p.cost||0)}</span>
                            </div>
                            <div style={{fontSize:11,color:"var(--txt2)",marginTop:2}}>{p.name}</div>
                          </div>
                        ))}
                      </div>
                    </>
                  ) : (
                    <>
                      {/* Step 2: Confirm product, quantity, and cost */}
                      <div style={{padding:"10px 12px",borderRadius:8,background:"var(--cyanBg)",border:"1px solid var(--cyanBd)",marginBottom:12}}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                          <span className="mono" style={{fontWeight:700,fontSize:13,color:"var(--cyan)"}}>{sustSelected.sku}</span>
                          <button onClick={()=>setSustSelected(null)} style={{fontSize:10,color:"var(--txt3)",background:"none",border:"none",cursor:"pointer",textDecoration:"underline"}}>Cambiar</button>
                        </div>
                        <div style={{fontSize:11,color:"var(--txt2)",marginTop:2}}>{sustSelected.name}</div>
                        <div style={{fontSize:10,color:"var(--txt3)",marginTop:2}}>Costo diccionario: {fmtMoney(sustSelected.cost||0)}</div>
                      </div>

                      {/* Quantity */}
                      <div style={{fontSize:12,fontWeight:600,color:"var(--txt2)",marginBottom:6}}>Cantidad recibida:</div>
                      <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:12,marginBottom:12}}>
                        <button onClick={()=>setSustQty(q=>Math.max(1,q-1))}
                          style={{width:40,height:40,borderRadius:8,background:"var(--bg3)",fontSize:20,fontWeight:700,border:"1px solid var(--bg4)"}}>−</button>
                        <input type="number" value={sustQty} onFocus={e=>e.target.select()} onChange={e=>setSustQty(Math.max(1,parseInt(e.target.value)||1))}
                          style={{width:80,textAlign:"center",fontSize:28,fontWeight:700,padding:8,borderRadius:8,background:"var(--bg)",border:"2px solid var(--bg4)",color:"var(--txt1)"}} />
                        <button onClick={()=>setSustQty(q=>q+1)}
                          style={{width:40,height:40,borderRadius:8,background:"var(--bg3)",fontSize:20,fontWeight:700,border:"1px solid var(--bg4)"}}>+</button>
                      </div>

                      {/* Cost mode */}
                      <div style={{fontSize:12,fontWeight:600,color:"var(--txt2)",marginBottom:6}}>Costo unitario del sustituto:</div>
                      <div style={{display:"flex",gap:6,marginBottom:12}}>
                        <button onClick={()=>setSustCostoMode("factura")}
                          style={{flex:1,padding:"10px 8px",borderRadius:8,textAlign:"center",cursor:"pointer",
                            background:sustCostoMode==="factura"?"var(--cyanBg)":"var(--bg3)",
                            border:sustCostoMode==="factura"?"2px solid var(--cyan)":"1px solid var(--bg4)"}}>
                          <div style={{fontSize:12,fontWeight:700,color:sustCostoMode==="factura"?"var(--cyan)":"var(--txt2)"}}>Costo de factura</div>
                          <div className="mono" style={{fontSize:16,fontWeight:800,marginTop:2,color:sustCostoMode==="factura"?"var(--cyan)":"var(--txt3)"}}>{fmtMoney(errorLinea.costo_unitario||0)}</div>
                          <div style={{fontSize:9,color:"var(--txt3)",marginTop:2}}>Lo que se pagó por unidad</div>
                        </button>
                        <button onClick={()=>setSustCostoMode("diccionario")}
                          style={{flex:1,padding:"10px 8px",borderRadius:8,textAlign:"center",cursor:"pointer",
                            background:sustCostoMode==="diccionario"?"var(--amberBg)":"var(--bg3)",
                            border:sustCostoMode==="diccionario"?"2px solid var(--amber)":"1px solid var(--bg4)"}}>
                          <div style={{fontSize:12,fontWeight:700,color:sustCostoMode==="diccionario"?"var(--amber)":"var(--txt2)"}}>Costo diccionario</div>
                          <div className="mono" style={{fontSize:16,fontWeight:800,marginTop:2,color:sustCostoMode==="diccionario"?"var(--amber)":"var(--txt3)"}}>{fmtMoney(sustSelected.cost||0)}</div>
                          <div style={{fontSize:9,color:"var(--txt3)",marginTop:2}}>Costo registrado del producto</div>
                        </button>
                      </div>

                      {/* Summary */}
                      <div style={{padding:"10px 12px",borderRadius:8,background:"var(--bg)",border:"1px solid var(--bg4)",marginBottom:12,fontSize:11}}>
                        <div style={{fontWeight:700,marginBottom:4,color:"var(--txt2)"}}>Resumen de sustitución:</div>
                        <div style={{display:"flex",justifyContent:"space-between",marginBottom:2}}>
                          <span style={{color:"var(--red)"}}>Factura ({errorLinea.sku}):</span>
                          <span className="mono">{errorLinea.qty_factura} × {fmtMoney(errorLinea.costo_unitario||0)} = {fmtMoney((errorLinea.qty_factura)*(errorLinea.costo_unitario||0))}</span>
                        </div>
                        <div style={{display:"flex",justifyContent:"space-between",marginBottom:2}}>
                          <span style={{color:"var(--cyan)"}}>Recibido ({sustSelected.sku}):</span>
                          <span className="mono">{sustQty} × {fmtMoney(sustCostoMode==="factura"?(errorLinea.costo_unitario||0):(sustSelected.cost||0))} = {fmtMoney(sustQty*(sustCostoMode==="factura"?(errorLinea.costo_unitario||0):(sustSelected.cost||0)))}</span>
                        </div>
                        {sustCostoMode==="factura" && (sustSelected.cost||0) !== (errorLinea.costo_unitario||0) && (
                          <div style={{marginTop:4,padding:"4px 8px",borderRadius:4,background:"var(--amberBg)",color:"var(--amber)",fontSize:10,fontWeight:600}}>
                            Nota: el costo diccionario ({fmtMoney(sustSelected.cost||0)}) difiere del costo factura. Se generará discrepancia de costo.
                          </div>
                        )}
                      </div>

                      {/* Actions */}
                      <div style={{display:"flex",gap:8}}>
                        <button onClick={()=>{setSustSelected(null);setErrorSkuSearch("");setErrorSkuResults([]);}}
                          style={{flex:1,padding:12,borderRadius:8,background:"var(--bg3)",color:"var(--txt3)",fontSize:13,fontWeight:600,border:"1px solid var(--bg4)"}}>
                          Atras
                        </button>
                        <button onClick={doSustitucion} disabled={errorSaving || sustQty <= 0}
                          style={{flex:2,padding:12,borderRadius:8,
                            background:(errorSaving||sustQty<=0)?"var(--bg3)":"var(--cyan)",
                            color:(errorSaving||sustQty<=0)?"var(--txt3)":"#fff",
                            fontSize:13,fontWeight:700,border:"none",cursor:"pointer"}}>
                          {errorSaving ? "Procesando..." : "Confirmar sustitución"}
                        </button>
                      </div>
                    </>
                  )}

                  {/* Back to menu (when searching) */}
                  {!sustSelected && (
                    <button onClick={()=>setErrorMode("menu")}
                      style={{width:"100%",padding:12,borderRadius:8,background:"var(--bg3)",color:"var(--txt3)",fontSize:13,fontWeight:600,border:"1px solid var(--bg4)",marginTop:4}}>
                      Atras
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Lines table */}
        <div className="card" style={{marginTop:12}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
            <div style={{fontSize:13,fontWeight:700}}>Líneas ({lineas.length})</div>
          </div>
          <div style={{overflowX:"auto"}}>
            <table className="tbl">
              <thead><tr><th>SKU</th><th>Producto</th><th style={{textAlign:"right"}}>Factura</th><th style={{textAlign:"right"}}>Recibido</th><th style={{textAlign:"right"}}>Etiq.</th><th style={{textAlign:"right"}}>Ubic.</th><th style={{textAlign:"right"}}>C.Unit</th><th style={{textAlign:"right"}}>Subtotal</th><th>Estado</th>{isEditable&&<th>Acciones</th>}</tr></thead>
              <tbody>{lineas.map(l => {
                const lockInfo = isLineaBloqueada(l, "__admin__");
                const disc = discrepancias.find(d => d.linea_id === l.id && d.estado === "PENDIENTE");
                const discQty = discrepanciasQty.find(d => d.linea_id === l.id && d.estado === "PENDIENTE");
                const isEd = editLineaId === l.id;
                const inputStyle = {width:58,textAlign:"right" as const,padding:"3px 6px",borderRadius:4,border:"1px solid var(--cyan)",background:"var(--bg)",color:"var(--txt1)",fontSize:11,fontFamily:"inherit"};
                if (isEd) return (
                <tr key={l.id} style={{background:"var(--cyanBg, rgba(0,200,255,0.06))"}}>
                  <td className="mono" style={{fontSize:11,fontWeight:700}}>
                    <input style={{...inputStyle,width:90,textAlign:"left"}} value={editLineaData.sku} onChange={e=>setEditLineaData(d=>({...d,sku:e.target.value}))}/>
                  </td>
                  <td style={{fontSize:11}}>
                    <input style={{...inputStyle,width:"100%",textAlign:"left"}} value={editLineaData.nombre} onChange={e=>setEditLineaData(d=>({...d,nombre:e.target.value}))}/>
                  </td>
                  <td><input type="number" style={inputStyle} value={editLineaData.qty_factura} onFocus={e=>e.target.select()} onChange={e=>setEditLineaData(d=>({...d,qty_factura:parseInt(e.target.value)||0}))}/></td>
                  <td><input type="number" style={inputStyle} value={editLineaData.qty_recibida} onFocus={e=>e.target.select()} onChange={e=>setEditLineaData(d=>({...d,qty_recibida:parseInt(e.target.value)||0}))}/></td>
                  <td><input type="number" style={inputStyle} value={editLineaData.qty_etiquetada} onFocus={e=>e.target.select()} onChange={e=>setEditLineaData(d=>({...d,qty_etiquetada:parseInt(e.target.value)||0}))}/></td>
                  <td><input type="number" style={inputStyle} value={editLineaData.qty_ubicada} onFocus={e=>e.target.select()} onChange={e=>setEditLineaData(d=>({...d,qty_ubicada:parseInt(e.target.value)||0}))}/></td>
                  <td><input type="number" step="0.01" style={inputStyle} value={editLineaData.costo_unitario} onChange={e=>setEditLineaData(d=>({...d,costo_unitario:parseFloat(e.target.value)||0}))}/></td>
                  <td className="mono" style={{textAlign:"right",fontSize:11,fontWeight:700}}>{editLineaData.costo_unitario?fmtMoney(editLineaData.costo_unitario*editLineaData.qty_factura):"—"}</td>
                  <td>
                    <select style={{padding:"3px 4px",borderRadius:4,border:"1px solid var(--cyan)",background:"var(--bg)",color:"var(--txt1)",fontSize:10,fontWeight:700}} value={editLineaData.estado} onChange={e=>setEditLineaData(d=>({...d,estado:e.target.value}))}>
                      {["PENDIENTE","CONTADA","EN_ETIQUETADO","ETIQUETADA","UBICADA"].map(s=><option key={s} value={s}>{s}</option>)}
                    </select>
                  </td>
                  {isEditable&&<td style={{whiteSpace:"nowrap"}}>
                    <div style={{display:"flex",gap:4}}>
                      <button onClick={saveEditLinea} disabled={loading} style={{padding:"3px 8px",borderRadius:4,background:"var(--green)",color:"#fff",fontSize:10,fontWeight:700,border:"none",cursor:"pointer"}}>Guardar</button>
                      <button onClick={()=>setEditLineaId(null)} style={{padding:"3px 8px",borderRadius:4,background:"var(--bg3)",color:"var(--txt3)",fontSize:10,fontWeight:700,border:"1px solid var(--bg4)",cursor:"pointer"}}>Cancelar</button>
                    </div>
                  </td>}
                </tr>
                );
                return (
                <tr key={l.id} style={{background: (disc||discQty) ? "var(--amberBg)" : l.estado==="UBICADA"?"var(--greenBg)":"transparent"}}>
                  <td className="mono" style={{fontSize:11,fontWeight:700}}>{disc && <span title="Discrepancia de costo pendiente" style={{color:"var(--amber)",marginRight:4}}>$</span>}{discQty && <span title={`Discrepancia de cantidad: ${discQty.tipo}`} style={{color:"var(--red)",marginRight:4}}>#</span>}{l.sku}</td>
                  <td style={{fontSize:11}}>{l.nombre}<br/><span className="mono" style={{fontSize:9,color:"var(--txt3)"}}>{l.codigo_ml||""}</span>
                    {lockInfo.blocked && <span style={{fontSize:10,color:"var(--amber)",fontWeight:600,display:"block"}}>🔒 {lockInfo.by}</span>}
                    {/* SKU venta selector + etiquetado toggle */}
                    {(() => {
                      const ventas = getVentasPorSkuOrigen(l.sku);
                      const uniqueVentas = ventas.filter((v, i, a) => a.findIndex(x => x.skuVenta === v.skuVenta) === i);
                      const skuVentaInfo = l.sku_venta ? ventas.find(v => v.skuVenta === l.sku_venta) : null;
                      const esPack = skuVentaInfo ? skuVentaInfo.unidades > 1 : false;
                      return (
                        <div style={{marginTop:4,display:"flex",flexWrap:"wrap",gap:4,alignItems:"center"}}>
                          {/* SKU venta dropdown */}
                          {uniqueVentas.length > 0 && (
                            <select
                              value={l.sku_venta || ""}
                              onChange={async(e)=>{
                                const val = e.target.value;
                                const info = ventas.find(v => v.skuVenta === val);
                                await actualizarLineaRecepcion(l.id!, {
                                  sku_venta: val || undefined,
                                  requiere_etiqueta: !!val,
                                } as Partial<DBRecepcionLinea>);
                                setLineas(await getRecepcionLineas(selRec!.id!));
                              }}
                              style={{fontSize:10,padding:"2px 6px",borderRadius:4,border:"1px solid var(--bg4)",background:"var(--bg)",color:"var(--txt1)",fontWeight:600,maxWidth:160}}>
                              <option value="">Sin SKU venta (sin etiqueta)</option>
                              {uniqueVentas.map(v => (
                                <option key={v.skuVenta} value={v.skuVenta}>
                                  {v.skuVenta} [{v.codigoMl}]{v.unidades > 1 ? ` x${v.unidades}` : ""}
                                </option>
                              ))}
                            </select>
                          )}
                          {/* Etiquetado badge */}
                          {l.requiere_etiqueta ? (
                            l.sku_venta ? (
                              <span style={{fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:4,background:l.etiqueta_impresa?"var(--greenBg)":"var(--amberBg)",color:l.etiqueta_impresa?"var(--green)":"var(--amber)"}}>
                                {l.etiqueta_impresa ? "✅" : "⏳"} {l.sku_venta}
                              </span>
                            ) : (
                              <span style={{fontSize:10,fontWeight:600,padding:"2px 6px",borderRadius:4,background:"var(--amberBg)",color:"var(--amber)"}}>
                                Requiere etiqueta
                              </span>
                            )
                          ) : (
                            <span style={{fontSize:10,fontWeight:600,padding:"2px 6px",borderRadius:4,background:"var(--bg3)",color:"var(--txt3)"}}>
                              Sin etiqueta
                            </span>
                          )}
                          {esPack && <span style={{fontSize:9,fontWeight:700,padding:"2px 6px",borderRadius:4,background:"var(--cyanBg,var(--bg3))",color:"var(--cyan)"}}>📦 PACK x{skuVentaInfo!.unidades}</span>}
                          {uniqueVentas.length > 1 && <span style={{fontSize:9,fontWeight:600,padding:"2px 6px",borderRadius:4,background:"var(--amberBg)",color:"var(--amber)"}}>{uniqueVentas.length} publicaciones</span>}
                          {/* Toggle etiquetado when no ventas exist */}
                          {uniqueVentas.length === 0 && isEditable && (
                            <button onClick={async()=>{
                              await actualizarLineaRecepcion(l.id!, { requiere_etiqueta: !l.requiere_etiqueta } as Partial<DBRecepcionLinea>);
                              setLineas(await getRecepcionLineas(selRec!.id!));
                            }} style={{fontSize:9,padding:"2px 6px",borderRadius:4,background:"var(--bg3)",color:"var(--cyan)",border:"1px solid var(--bg4)",cursor:"pointer",fontWeight:600}}>
                              {l.requiere_etiqueta ? "Quitar etiquetado" : "Agregar etiquetado"}
                            </button>
                          )}
                        </div>
                      );
                    })()}
                  </td>
                  <td className="mono" style={{textAlign:"right"}}>{l.qty_factura}</td>
                  <td className="mono" style={{textAlign:"right",color:l.qty_recibida>0?(l.qty_recibida===l.qty_factura?"var(--green)":"var(--amber)"):"var(--txt3)"}}>{l.qty_recibida||"—"}</td>
                  <td className="mono" style={{textAlign:"right"}}>{l.qty_etiquetada||"—"}</td>
                  <td className="mono" style={{textAlign:"right",color:(l.qty_ubicada||0)>0?"var(--green)":"var(--txt3)"}}>{l.qty_ubicada||"—"}</td>
                  <td className="mono" style={{textAlign:"right",fontSize:11,color:l.costo_unitario?"var(--txt2)":"var(--txt3)"}}>{l.costo_unitario?fmtMoney(l.costo_unitario):"—"}</td>
                  <td className="mono" style={{textAlign:"right",fontSize:11,fontWeight:700,color:l.costo_unitario?"var(--txt1)":"var(--txt3)"}}>{l.costo_unitario?fmtMoney(l.costo_unitario*l.qty_factura):"—"}</td>
                  <td><span style={{fontSize:10,fontWeight:700,padding:"2px 6px",borderRadius:4,
                    background:l.estado==="UBICADA"?"var(--greenBg)":l.estado==="PENDIENTE"?"var(--redBg)":"var(--amberBg)",
                    color:l.estado==="UBICADA"?"var(--green)":l.estado==="PENDIENTE"?"var(--red)":"var(--amber)"}}>{l.estado}</span></td>
                  {isEditable&&<td style={{whiteSpace:"nowrap"}}>
                    <div style={{display:"flex",gap:4}}>
                      {lockInfo.blocked && <button onClick={async()=>{await desbloquearLinea(l.id!);await refreshDetail();}} title="Desbloquear" style={{padding:"3px 6px",borderRadius:4,background:"var(--amberBg)",color:"var(--amber)",fontSize:10,fontWeight:700,border:"1px solid var(--amberBd)",cursor:"pointer"}}>🔓</button>}
                      {l.estado !== "PENDIENTE" && <button onClick={()=>doResetLinea(l.id!)} title="Resetear a pendiente" style={{padding:"3px 6px",borderRadius:4,background:"var(--amberBg)",color:"var(--amber)",fontSize:10,fontWeight:700,border:"1px solid var(--amberBd)",cursor:"pointer"}}>Reset</button>}
                      <button onClick={()=>openErrorReport(l)} title="Reportar error (conteo o SKU)" style={{padding:"3px 6px",borderRadius:4,background:"var(--redBg)",color:"var(--red)",fontSize:10,fontWeight:700,border:"1px solid var(--redBd)",cursor:"pointer"}}>Error</button>
                      <button onClick={()=>startEditLinea(l)} title="Editar linea" style={{padding:"3px 6px",borderRadius:4,background:"var(--bg3)",color:"var(--cyan)",fontSize:10,fontWeight:700,border:"1px solid var(--bg4)",cursor:"pointer"}}>Editar</button>
                      <button onClick={()=>doDeleteLinea(l.id!)} title="Eliminar linea" style={{padding:"3px 6px",borderRadius:4,background:"var(--redBg)",color:"var(--red)",fontSize:10,fontWeight:700,border:"1px solid var(--redBd)",cursor:"pointer"}}>✕</button>
                    </div>
                  </td>}
                </tr>
                );
              })}</tbody>
            </table>
          </div>
          {/* Add line to existing reception */}
          {isEditable && (
            <div style={{marginTop:12,padding:"10px 12px",borderRadius:8,background:"var(--bg3)"}}>
              <div style={{fontSize:11,fontWeight:600,color:"var(--txt3)",marginBottom:6}}>Agregar línea</div>
              <div style={{display:"flex",gap:6}}>
                <div style={{flex:1,position:"relative"}}>
                  <input className="form-input" value={addSku} onChange={e=>setAddSku(e.target.value)} placeholder="SKU o nombre" onKeyDown={e=>e.key==="Enter"&&doAddLinea()} style={{fontSize:12}}/>
                  {addSuggestions.length > 0 && (
                    <div style={{position:"absolute",top:"100%",left:0,right:0,background:"var(--bg2)",border:"1px solid var(--bg3)",borderRadius:6,zIndex:10,maxHeight:120,overflow:"auto"}}>
                      {addSuggestions.map(p => (
                        <div key={p.sku} onClick={()=>setAddSku(p.sku)} style={{padding:"5px 8px",fontSize:11,cursor:"pointer",borderBottom:"1px solid var(--bg3)"}}>
                          <strong>{p.sku}</strong> — {p.name}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <input type="number" className="form-input" value={addQty} onFocus={e=>e.target.select()} onChange={e=>setAddQty(parseInt(e.target.value)||1)} style={{width:60,textAlign:"center",fontSize:12}}/>
                <button onClick={doAddLinea} style={{padding:"6px 12px",borderRadius:6,background:"var(--green)",color:"#fff",fontSize:12,fontWeight:700}}>+</button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ==================== CREATE FORM ====================
  if (showCreate) {
    const suggestions = newSku.length >= 2 ? findProduct(newSku).slice(0, 5) : [];
    return (
      <div>
        <button onClick={() => setShowCreate(false)} style={{marginBottom:12,padding:"6px 14px",borderRadius:6,background:"var(--bg3)",color:"var(--txt2)",fontSize:12,fontWeight:600,border:"1px solid var(--bg4)"}}>← Cancelar</button>
        <div className="card">
          <div className="card-title">Nueva recepción manual</div>
          <div className="admin-grid-2">
            <div>
              <label style={{fontSize:11,color:"var(--txt3)",fontWeight:600}}>Folio factura</label>
              <input className="form-input" value={newFolio} onChange={e=>setNewFolio(e.target.value)} placeholder="Ej: 12345" style={{marginTop:4}}/>
            </div>
            <div>
              <label style={{fontSize:11,color:"var(--txt3)",fontWeight:600}}>Proveedor</label>
              <select className="form-select" value={newProv} onChange={e=>setNewProv(e.target.value)} style={{marginTop:4}}>
                <option value="">Seleccionar...</option>
                {getProveedores().map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
          </div>
          <div style={{marginTop:16}}>
            <label style={{fontSize:11,color:"var(--txt3)",fontWeight:600,display:"block",marginBottom:6}}>Costos de factura</label>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
              <div>
                <label style={{fontSize:10,color:"var(--txt3)"}}>Neto</label>
                <input type="number" className="form-input" value={newCostoNeto||""} onChange={e=>{const v=parseFloat(e.target.value)||0;setNewCostoNeto(v);setNewIva(Math.round(v*0.19));setNewCostoBruto(Math.round(v*1.19));}}
                  placeholder="$0" style={{marginTop:2,fontSize:12}}/>
              </div>
              <div>
                <label style={{fontSize:10,color:"var(--txt3)"}}>IVA (19%)</label>
                <input type="number" className="form-input" value={newIva||""} onChange={e=>setNewIva(parseFloat(e.target.value)||0)}
                  placeholder="$0" style={{marginTop:2,fontSize:12}}/>
              </div>
              <div>
                <label style={{fontSize:10,color:"var(--txt3)"}}>Bruto</label>
                <input type="number" className="form-input" value={newCostoBruto||""} onChange={e=>{const v=parseFloat(e.target.value)||0;setNewCostoBruto(v);setNewCostoNeto(Math.round(v/1.19));setNewIva(Math.round(v-v/1.19));}}
                  placeholder="$0" style={{marginTop:2,fontSize:12}}/>
              </div>
            </div>
          </div>
          <div style={{marginTop:16}}>
            <label style={{fontSize:11,color:"var(--txt3)",fontWeight:600}}>Agregar producto</label>
            <div style={{display:"flex",gap:6,marginTop:4}}>
              <div style={{flex:1,position:"relative"}}>
                <input className="form-input" value={newSku} onChange={e=>setNewSku(e.target.value)} placeholder="SKU o nombre" onKeyDown={e=>e.key==="Enter"&&addLinea()}/>
                {suggestions.length > 0 && (
                  <div style={{position:"absolute",top:"100%",left:0,right:0,background:"var(--bg2)",border:"1px solid var(--bg3)",borderRadius:6,zIndex:10,maxHeight:150,overflow:"auto"}}>
                    {suggestions.map(p => (
                      <div key={p.sku} onClick={()=>{setNewSku(p.sku);}} style={{padding:"6px 10px",fontSize:11,cursor:"pointer",borderBottom:"1px solid var(--bg3)"}}>
                        <strong>{p.sku}</strong> — {p.name}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <input type="number" className="form-input" value={newQty} onFocus={e=>e.target.select()} onChange={e=>setNewQty(parseInt(e.target.value)||1)} style={{width:70,textAlign:"center"}}/>
              <button onClick={addLinea} style={{padding:"8px 14px",borderRadius:6,background:"var(--green)",color:"#fff",fontSize:12,fontWeight:700}}>+</button>
            </div>
          </div>
          {newLineas.length > 0 && (
            <div style={{marginTop:12}}>
              {newLineas.map((l, i) => (
                <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 0",borderBottom:"1px solid var(--bg3)",fontSize:12}}>
                  <span><strong>{l.sku}</strong> — {l.nombre}</span>
                  <div style={{display:"flex",gap:8,alignItems:"center"}}>
                    <span className="mono" style={{fontWeight:700}}>{l.cantidad}</span>
                    <button onClick={()=>setNewLineas(nl=>nl.filter((_,j)=>j!==i))} style={{color:"var(--red)",background:"none",border:"none",cursor:"pointer",fontSize:14}}>✕</button>
                  </div>
                </div>
              ))}
              <button onClick={doCreate} disabled={!newFolio||!newProv||loading}
                style={{width:"100%",marginTop:12,padding:12,borderRadius:8,background:"var(--green)",color:"#fff",fontSize:13,fontWeight:700}}>
                {loading ? "Creando..." : `Crear recepción (${newLineas.length} líneas)`}
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ==================== LIST VIEW ====================
  // Day view data
  const dayTotal = dayLineas.length;
  const dayUbicadas = dayLineas.filter(l => l.estado === "UBICADA").length;
  const dayProgress = dayTotal > 0 ? Math.round((dayUbicadas / dayTotal) * 100) : 0;

  const dayLineasFiltradas = dayFilter === "pendientes"
    ? dayLineas.filter(l => l.estado !== "UBICADA")
    : dayFilter === "diferencia"
    ? dayLineas.filter(l => l.qty_recibida > 0 && l.qty_recibida !== l.qty_factura)
    : dayLineas;

  const doDesbloquear = async (lineaId: string) => {
    await desbloquearLinea(lineaId);
    await loadRecs();
  };

  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
        <div className="card-title" style={{margin:0}}>Recepciones</div>
        <div style={{display:"flex",gap:8}}>
          <button onClick={loadRecs} disabled={loading} style={{padding:"6px 14px",borderRadius:6,background:"var(--bg3)",color:"var(--cyan)",fontSize:11,fontWeight:600,border:"1px solid var(--bg4)"}}>
            {loading?"...":"Actualizar"}
          </button>
          <button onClick={()=>setShowCreate(true)} style={{padding:"8px 16px",borderRadius:6,background:"var(--green)",color:"#fff",fontSize:12,fontWeight:700}}>
            + Nueva recepcion
          </button>
        </div>
      </div>

      {/* View toggle */}
      <div style={{display:"flex",gap:0,marginBottom:12}}>
        <button onClick={()=>setView("dia")}
          style={{padding:"8px 16px",borderRadius:"6px 0 0 6px",fontSize:12,fontWeight:700,cursor:"pointer",
            background:view==="dia"?"var(--cyan)":"var(--bg3)",color:view==="dia"?"#000":"var(--txt2)",
            border:`1px solid ${view==="dia"?"var(--cyan)":"var(--bg4)"}`}}>
          📅 Dia
        </button>
        <button onClick={()=>setView("facturas")}
          style={{padding:"8px 16px",borderRadius:"0 6px 6px 0",fontSize:12,fontWeight:700,cursor:"pointer",
            background:view==="facturas"?"var(--cyan)":"var(--bg3)",color:view==="facturas"?"#000":"var(--txt2)",
            border:`1px solid ${view==="facturas"?"var(--cyan)":"var(--bg4)"}`,borderLeft:"none"}}>
          📄 Facturas
        </button>
      </div>

      {/* ==================== DAY VIEW ==================== */}
      {view === "dia" && (
        <div>
          {/* Global progress bar */}
          <div className="card" style={{marginBottom:12}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
              <span style={{fontSize:14,fontWeight:700}}>Progreso global</span>
              <span style={{fontSize:13,fontWeight:700,color:dayProgress===100?"var(--green)":"var(--blue)"}}>{dayProgress}%</span>
            </div>
            <div style={{background:"var(--bg3)",borderRadius:6,height:12,overflow:"hidden"}}>
              <div style={{width:`${dayProgress}%`,height:"100%",background:dayProgress===100?"var(--green)":"var(--blue)",borderRadius:6,transition:"width 0.3s"}}/>
            </div>
            <div style={{fontSize:12,color:"var(--txt3)",marginTop:6}}>{dayUbicadas}/{dayTotal} lineas completadas</div>
          </div>

          {/* Day filter */}
          <div style={{display:"flex",gap:4,marginBottom:12,flexWrap:"wrap"}}>
            {([["todas","Todas"],["pendientes","Pendientes"],["diferencia","Con diferencia"]] as [string,string][]).map(([key,label]) => (
              <button key={key} onClick={()=>setDayFilter(key as typeof dayFilter)}
                style={{padding:"6px 12px",borderRadius:6,fontSize:11,fontWeight:600,cursor:"pointer",
                  background:dayFilter===key?"var(--cyan)":"var(--bg3)",color:dayFilter===key?"#000":"var(--txt2)",
                  border:`1px solid ${dayFilter===key?"var(--cyan)":"var(--bg4)"}`}}>
                {label} ({key==="todas"?dayTotal:key==="pendientes"?dayLineas.filter(l=>l.estado!=="UBICADA").length:dayLineas.filter(l=>l.qty_recibida>0&&l.qty_recibida!==l.qty_factura).length})
              </button>
            ))}
          </div>

          {dayLineasFiltradas.length === 0 && !loading && (
            <div className="card" style={{textAlign:"center",padding:32}}>
              <div style={{fontSize:13,color:"var(--txt3)"}}>Sin lineas en esta vista.</div>
            </div>
          )}

          {dayLineasFiltradas.length > 0 && (
            <div style={{overflowX:"auto"}}>
              <table className="tbl">
                <thead><tr>
                  <th>SKU</th><th>Producto</th>
                  <th style={{textAlign:"right"}}>Factura</th><th style={{textAlign:"right"}}>Recibido</th>
                  <th style={{textAlign:"right"}}>Etiq.</th><th style={{textAlign:"right"}}>Ubic.</th>
                  <th>Estado</th><th>Operario</th><th>Factura</th><th></th>
                </tr></thead>
                <tbody>{dayLineasFiltradas.map(l => {
                  const lock = isLineaBloqueada(l, "__admin__");
                  const operarioActual = l.bloqueado_por || l.operario_ubicacion || l.operario_etiquetado || l.operario_conteo || "";
                  return (
                    <tr key={l.id} style={{background:l.estado==="UBICADA"?"var(--greenBg)":"transparent"}}>
                      <td className="mono" style={{fontSize:11,fontWeight:700}}>{l.sku}</td>
                      <td style={{fontSize:11}}>{l.nombre}</td>
                      <td className="mono" style={{textAlign:"right"}}>{l.qty_factura}</td>
                      <td className="mono" style={{textAlign:"right",color:l.qty_recibida>0?(l.qty_recibida===l.qty_factura?"var(--green)":"var(--amber)"):"var(--txt3)"}}>{l.qty_recibida||"—"}</td>
                      <td className="mono" style={{textAlign:"right"}}>{l.qty_etiquetada||"—"}</td>
                      <td className="mono" style={{textAlign:"right",color:(l.qty_ubicada||0)>0?"var(--green)":"var(--txt3)"}}>{l.qty_ubicada||"—"}</td>
                      <td><span style={{fontSize:10,fontWeight:700,padding:"2px 6px",borderRadius:4,
                        background:l.estado==="UBICADA"?"var(--greenBg)":l.estado==="PENDIENTE"?"var(--redBg)":"var(--amberBg)",
                        color:LINEA_ESTADO_COLORS[l.estado]||"var(--txt3)"}}>{l.estado}</span></td>
                      <td style={{fontSize:11}}>
                        {lock.blocked ? (
                          <span style={{color:"var(--amber)",fontWeight:600}}>🔒 {lock.by}</span>
                        ) : operarioActual ? (
                          <span style={{color:"var(--cyan)"}}>{operarioActual}</span>
                        ) : (
                          <span style={{color:"var(--txt3)"}}>—</span>
                        )}
                      </td>
                      <td style={{fontSize:11}}>
                        {(() => {
                          const rec = recs.find(r => r.id === l.recepcion_id);
                          return rec ? (
                            <button onClick={() => openRec(rec)}
                              style={{padding:"2px 8px",borderRadius:4,background:"var(--bg3)",color:"var(--cyan)",fontSize:10,fontWeight:600,border:"1px solid var(--bg4)",cursor:"pointer",whiteSpace:"nowrap"}}>
                              📄 {rec.folio}
                            </button>
                          ) : <span style={{color:"var(--txt3)"}}>—</span>;
                        })()}
                      </td>
                      <td>
                        {lock.blocked && (
                          <button onClick={()=>doDesbloquear(l.id!)} title="Desbloquear"
                            style={{padding:"3px 6px",borderRadius:4,background:"var(--amberBg)",color:"var(--amber)",fontSize:10,fontWeight:700,border:"1px solid var(--amberBd)",cursor:"pointer"}}>
                            🔓
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}</tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ==================== FACTURAS VIEW (existing) ==================== */}
      {view === "facturas" && (<>
      {/* Filter tabs */}
      <div style={{display:"flex",gap:4,marginBottom:12,flexWrap:"wrap"}}>
        {(["activas","pausadas","completadas","anuladas","todas"] as RecFilter[]).map(f => (
          <button key={f} onClick={()=>setFilter(f)}
            style={{padding:"6px 12px",borderRadius:6,fontSize:11,fontWeight:600,cursor:"pointer",
              background:filter===f?"var(--cyan)":"var(--bg3)",color:filter===f?"#000":"var(--txt2)",
              border:`1px solid ${filter===f?"var(--cyan)":"var(--bg4)"}`}}>
            {f==="activas"?"Activas":f==="pausadas"?"Pausadas":f==="completadas"?"Completadas":f==="anuladas"?"Anuladas":"Todas"}
            {counts[f]>0&&<span style={{marginLeft:4,opacity:0.7}}>({counts[f]})</span>}
          </button>
        ))}
      </div>

      {filteredRecs.length === 0 && !loading && (
        <div className="card" style={{textAlign:"center",padding:32}}>
          <div style={{fontSize:13,color:"var(--txt3)"}}>Sin recepciones en esta categoria.</div>
        </div>
      )}

      <div className="desktop-only">
        <table className="tbl">
          <thead><tr><th>Folio</th><th>Proveedor</th><th>Fecha</th><th>Estado</th><th>Operarios</th><th></th></tr></thead>
          <tbody>{filteredRecs.map(rec => {
            const m = parseRecepcionMeta(rec.notas||"");
            return (
              <tr key={rec.id} onClick={()=>openRec(rec)} style={{cursor:"pointer",opacity:rec.estado==="ANULADA"?0.6:1}}>
                <td className="mono" style={{fontWeight:700}}>{rec.folio}</td>
                <td>{rec.proveedor}</td>
                <td style={{fontSize:11,color:"var(--txt3)"}}>{fmtDate(rec.created_at||"")} {fmtTime(rec.created_at||"")}</td>
                <td><span style={{padding:"2px 8px",borderRadius:4,background:ESTADO_COLORS_A[rec.estado],color:"#fff",fontSize:10,fontWeight:700}}>{ESTADO_LABELS_A[rec.estado]||rec.estado}</span></td>
                <td style={{fontSize:11,color:m.asignados.length>0?"var(--cyan)":"var(--txt3)"}}>{m.asignados.length>0?m.asignados.join(", "):"Todos"}</td>
                <td><button style={{fontSize:10,padding:"4px 8px",borderRadius:4,background:"var(--bg3)",color:"var(--cyan)",border:"1px solid var(--bg4)"}}>Ver</button></td>
              </tr>
            );
          })}</tbody>
        </table>
      </div>

      <div className="mobile-only">
        {filteredRecs.map(rec => {
          const m = parseRecepcionMeta(rec.notas||"");
          return (
            <div key={rec.id} onClick={()=>openRec(rec)} style={{padding:12,marginBottom:6,borderRadius:8,background:"var(--bg2)",border:"1px solid var(--bg3)",cursor:"pointer",opacity:rec.estado==="ANULADA"?0.6:1}}>
              <div style={{display:"flex",justifyContent:"space-between"}}>
                <div style={{fontWeight:700,fontSize:13}}>{rec.proveedor}</div>
                <span style={{padding:"2px 8px",borderRadius:4,background:ESTADO_COLORS_A[rec.estado],color:"#fff",fontSize:10,fontWeight:700}}>{ESTADO_LABELS_A[rec.estado]||rec.estado}</span>
              </div>
              <div style={{fontSize:11,color:"var(--txt3)"}}>Folio: {rec.folio} · {fmtDate(rec.created_at||"")}</div>
              {m.asignados.length > 0 && <div style={{fontSize:10,color:"var(--cyan)",marginTop:2}}>Asignado: {m.asignados.join(", ")}</div>}
            </div>
          );
        })}
      </div>
      </>)}
    </div>
  );
}


export default AdminRecepciones;
