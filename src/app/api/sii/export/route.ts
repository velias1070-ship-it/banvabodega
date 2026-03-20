import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

const TIPO_DOC_NOMBRE: Record<number, string> = {
  33: "Factura Electronica",
  34: "Factura Exenta",
  46: "Factura Compra",
  52: "Guia Despacho",
  56: "Nota Debito",
  61: "Nota Credito",
};

/**
 * GET /api/sii/export?empresa_id=X&anio=2025&tipo=compras
 * Exporta facturas de compra o venta como CSV.
 */
export async function GET(req: NextRequest) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const { searchParams } = new URL(req.url);
  const empresaId = searchParams.get("empresa_id");
  const anio = searchParams.get("anio");
  const tipo = searchParams.get("tipo") || "compras";

  if (!empresaId || !anio) {
    return NextResponse.json({ error: "Faltan empresa_id y anio" }, { status: 400 });
  }

  try {
    // Generar periodos del año
    const periodos = [];
    for (let m = 1; m <= 12; m++) {
      periodos.push(`${anio}${String(m).padStart(2, "0")}`);
    }

    if (tipo === "compras") {
      const { data, error } = await sb.from("rcv_compras")
        .select("*")
        .eq("empresa_id", empresaId)
        .gte("periodo", `${anio}01`)
        .lte("periodo", `${anio}12`)
        .order("fecha_docto", { ascending: true })
        .limit(10000);

      if (error) return NextResponse.json({ error: error.message }, { status: 500 });

      const rows = (data || []) as Array<{
        periodo: string; tipo_doc: number; nro_doc: string | null;
        rut_proveedor: string | null; razon_social: string | null;
        fecha_docto: string | null; monto_exento: number; monto_neto: number;
        monto_iva: number; monto_total: number; fecha_recepcion: string | null;
        evento_receptor: string | null; estado_pago?: string | null;
      }>;

      const bom = "\uFEFF";
      const headers = ["Periodo", "Tipo Doc", "Tipo", "Nro Doc", "RUT Proveedor", "Razon Social", "Fecha Documento", "Monto Exento", "Monto Neto", "Monto IVA", "Monto Total", "Fecha Recepcion", "Evento Receptor", "Estado Pago"];
      const csvRows = rows.map(r => [
        r.periodo,
        String(r.tipo_doc),
        TIPO_DOC_NOMBRE[r.tipo_doc] || String(r.tipo_doc),
        r.nro_doc || "",
        r.rut_proveedor || "",
        (r.razon_social || "").replace(/;/g, ","),
        r.fecha_docto || "",
        String(r.monto_exento || 0),
        String(r.monto_neto || 0),
        String(r.monto_iva || 0),
        String(r.monto_total || 0),
        r.fecha_recepcion || "",
        r.evento_receptor || "",
        r.estado_pago || "",
      ].join(";"));

      const csv = bom + [headers.join(";"), ...csvRows].join("\n");

      return new NextResponse(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="compras_sii_${anio}.csv"`,
        },
      });
    }

    // Ventas
    const { data, error } = await sb.from("rcv_ventas")
      .select("*")
      .eq("empresa_id", empresaId)
      .gte("periodo", `${anio}01`)
      .lte("periodo", `${anio}12`)
      .order("fecha_docto", { ascending: true })
      .limit(10000);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const rows = (data || []) as Array<{
      periodo: string; tipo_doc: string; nro: string | null;
      rut_emisor: string | null; folio: string | null;
      fecha_docto: string | null; monto_exento: number; monto_neto: number;
      monto_iva: number; monto_total: number; fecha_recepcion: string | null;
      estado_pago?: string | null;
    }>;

    const bom = "\uFEFF";
    const headers = ["Periodo", "Tipo Doc", "Nro", "RUT", "Folio", "Fecha Documento", "Monto Exento", "Monto Neto", "Monto IVA", "Monto Total", "Fecha Recepcion", "Estado Pago"];
    const csvRows = rows.map(r => [
      r.periodo,
      r.tipo_doc || "",
      r.nro || "",
      r.rut_emisor || "",
      r.folio || "",
      r.fecha_docto || "",
      String(r.monto_exento || 0),
      String(r.monto_neto || 0),
      String(r.monto_iva || 0),
      String(r.monto_total || 0),
      r.fecha_recepcion || "",
      r.estado_pago || "",
    ].join(";"));

    const csv = bom + [headers.join(";"), ...csvRows].join("\n");

    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="ventas_sii_${anio}.csv"`,
      },
    });
  } catch (err) {
    console.error("[SII Export] Error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
