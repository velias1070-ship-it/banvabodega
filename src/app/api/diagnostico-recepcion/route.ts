import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

// GET /api/diagnostico-recepcion?folio=520702
// Diagnóstico detallado de una recepción: costos, cantidades, estados
export async function GET(req: NextRequest) {
  const folio = req.nextUrl.searchParams.get("folio");
  if (!folio) {
    return NextResponse.json({ error: "Parámetro ?folio= requerido" }, { status: 400 });
  }

  const sb = getServerSupabase();
  if (!sb) {
    return NextResponse.json({ error: "Sin conexión a Supabase" }, { status: 500 });
  }

  // 1. Buscar recepción por folio
  const { data: recs, error: recErr } = await sb
    .from("recepciones")
    .select("*")
    .eq("folio", folio);

  if (recErr) {
    return NextResponse.json({ error: "Error buscando recepción", detail: recErr.message }, { status: 500 });
  }
  if (!recs || recs.length === 0) {
    return NextResponse.json({ error: `No se encontró recepción con folio ${folio}` }, { status: 404 });
  }

  const rec = recs[0];

  // 2. Obtener líneas
  const { data: lineas, error: linErr } = await sb
    .from("recepcion_lineas")
    .select("*")
    .eq("recepcion_id", rec.id)
    .order("sku");

  if (linErr) {
    return NextResponse.json({ error: "Error buscando líneas", detail: linErr.message }, { status: 500 });
  }

  const lines = lineas || [];

  // 3. Cálculos detallados por línea
  const detalle = lines.map((l: Record<string, unknown>) => {
    const qtyFactura = (l.qty_factura as number) || 0;
    const qtyRecibida = (l.qty_recibida as number) || 0;
    const qtyEtiquetada = (l.qty_etiquetada as number) || 0;
    const qtyUbicada = (l.qty_ubicada as number) || 0;
    const costoUnit = (l.costo_unitario as number) || 0;
    const subtotalFactura = costoUnit * qtyFactura;
    const subtotalRecibido = costoUnit * qtyRecibida;

    return {
      id: l.id,
      sku: l.sku,
      nombre: l.nombre,
      estado: l.estado,
      qty_factura: qtyFactura,
      qty_recibida: qtyRecibida,
      qty_etiquetada: qtyEtiquetada,
      qty_ubicada: qtyUbicada,
      diff_qty: qtyRecibida - qtyFactura,
      costo_unitario: costoUnit,
      subtotal_factura: subtotalFactura,
      subtotal_recibido: subtotalRecibido,
      diff_costo: subtotalRecibido - subtotalFactura,
      requiere_etiqueta: l.requiere_etiqueta,
      sku_venta: l.sku_venta || null,
    };
  });

  // 4. Totales calculados desde las líneas
  const totalQtyFactura = detalle.reduce((s, l) => s + l.qty_factura, 0);
  const totalQtyRecibida = detalle.reduce((s, l) => s + l.qty_recibida, 0);
  const totalCostoCalculado = detalle.reduce((s, l) => s + l.subtotal_factura, 0);
  const totalCostoRecibido = detalle.reduce((s, l) => s + l.subtotal_recibido, 0);

  // 5. Costos guardados en la recepción (cabecera)
  const costoNetoGuardado = (rec.costo_neto as number) || 0;
  const ivaGuardado = (rec.iva as number) || 0;
  const costoBrutoGuardado = (rec.costo_bruto as number) || 0;

  // 6. Diferencias
  const diffNetoVsCalc = costoNetoGuardado - totalCostoCalculado;

  // 7. Líneas con costo_unitario = 0 (posible problema)
  const sinCosto = detalle.filter(l => l.costo_unitario === 0);

  // 8. Resumen por estado
  const porEstado: Record<string, { count: number; qty_factura: number; qty_recibida: number; subtotal: number }> = {};
  for (const l of detalle) {
    const e = l.estado as string;
    if (!porEstado[e]) porEstado[e] = { count: 0, qty_factura: 0, qty_recibida: 0, subtotal: 0 };
    porEstado[e].count++;
    porEstado[e].qty_factura += l.qty_factura;
    porEstado[e].qty_recibida += l.qty_recibida;
    porEstado[e].subtotal += l.subtotal_factura;
  }

  return NextResponse.json({
    recepcion: {
      id: rec.id,
      folio: rec.folio,
      proveedor: rec.proveedor,
      estado: rec.estado,
      created_at: rec.created_at,
      costos_cabecera: {
        costo_neto: costoNetoGuardado,
        iva: ivaGuardado,
        costo_bruto: costoBrutoGuardado,
      },
    },
    resumen: {
      total_lineas: detalle.length,
      total_qty_factura: totalQtyFactura,
      total_qty_recibida: totalQtyRecibida,
      diff_qty: totalQtyRecibida - totalQtyFactura,
      total_costo_calculado_desde_lineas: totalCostoCalculado,
      total_costo_recibido: totalCostoRecibido,
      costo_neto_cabecera: costoNetoGuardado,
      diferencia_neto_vs_calculado: diffNetoVsCalc,
      lineas_sin_costo: sinCosto.length,
    },
    por_estado: porEstado,
    lineas: detalle,
    alertas: [
      ...(sinCosto.length > 0
        ? [`⚠️ ${sinCosto.length} línea(s) con costo_unitario = 0: ${sinCosto.map(l => l.sku).join(", ")}`]
        : []),
      ...(Math.abs(diffNetoVsCalc) > 1
        ? [`⚠️ Diferencia entre costo_neto cabecera ($${costoNetoGuardado}) y suma líneas ($${totalCostoCalculado}): $${diffNetoVsCalc.toFixed(0)}`]
        : []),
      ...(totalQtyRecibida !== totalQtyFactura
        ? [`⚠️ Qty recibida (${totalQtyRecibida}) ≠ Qty factura (${totalQtyFactura}), diff: ${totalQtyRecibida - totalQtyFactura}`]
        : []),
    ],
  });
}
