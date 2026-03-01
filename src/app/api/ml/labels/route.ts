import { NextRequest, NextResponse } from "next/server";
import { getShippingLabelsPdf, getShippingLabelsZpl, getShipmentStatus } from "@/lib/ml";

/**
 * Download shipping labels for given shipping IDs.
 * Supports PDF (default) and ZPL (for Zebra thermal printers).
 * Verifies shipment is ready_to_ship/ready_to_print with logistic_type: self_service.
 *
 * POST body: { shipping_ids: number[], format?: "pdf" | "zpl", skip_validation?: boolean }
 */
export async function POST(req: NextRequest) {
  try {
    const { shipping_ids, format = "pdf", skip_validation = false } = await req.json();

    if (!shipping_ids || !Array.isArray(shipping_ids) || shipping_ids.length === 0) {
      return NextResponse.json({ error: "shipping_ids required" }, { status: 400 });
    }

    // Optionally validate shipment statuses
    if (!skip_validation) {
      const notReady: number[] = [];
      for (const id of shipping_ids.slice(0, 10)) { // check first 10
        const status = await getShipmentStatus(id);
        if (status && !status.ready) {
          notReady.push(id);
        }
      }
      if (notReady.length > 0) {
        return NextResponse.json({
          error: "some_shipments_not_ready",
          not_ready: notReady,
          message: `Envíos no listos para imprimir: ${notReady.join(", ")}. Deben estar en ready_to_ship con logistic_type: self_service.`,
        }, { status: 400 });
      }
    }

    if (format === "zpl") {
      const zpl = await getShippingLabelsZpl(shipping_ids);
      if (!zpl) {
        return NextResponse.json({ error: "failed to download ZPL labels" }, { status: 500 });
      }
      return new NextResponse(zpl, {
        headers: {
          "Content-Type": "application/x-zpl",
          "Content-Disposition": `attachment; filename="etiquetas-envio.zpl"`,
        },
      });
    }

    // Default: PDF
    const pdf = await getShippingLabelsPdf(shipping_ids);
    if (!pdf) {
      return NextResponse.json({ error: "failed to download PDF labels" }, { status: 500 });
    }

    return new NextResponse(pdf, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="etiquetas-envio.pdf"`,
      },
    });
  } catch (err) {
    console.error("[ML Labels] Error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
