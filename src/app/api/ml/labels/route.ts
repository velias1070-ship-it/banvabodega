import { NextRequest, NextResponse } from "next/server";
import { getShippingLabelsPdf } from "@/lib/ml";

/**
 * Download shipping labels PDF for given shipping IDs.
 * Used by admin to print labels for a picking session.
 */
export async function POST(req: NextRequest) {
  try {
    const { shipping_ids } = await req.json();

    if (!shipping_ids || !Array.isArray(shipping_ids) || shipping_ids.length === 0) {
      return NextResponse.json({ error: "shipping_ids required" }, { status: 400 });
    }

    const pdf = await getShippingLabelsPdf(shipping_ids);
    if (!pdf) {
      return NextResponse.json({ error: "failed to download labels" }, { status: 500 });
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
