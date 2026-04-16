import { NextRequest, NextResponse } from "next/server";
import { mlGet } from "@/lib/ml";
export const dynamic = "force-dynamic";
export const maxDuration = 180;
export async function GET(req: NextRequest) {
  const ids = (req.nextUrl.searchParams.get("ids") || "").split(",").filter(Boolean);
  const results: any[] = [];
  for (let i = 0; i < ids.length; i += 3) {
    const batch = ids.slice(i, i + 3);
    await Promise.all(batch.map(async (orderId) => {
      try {
        const order: any = await mlGet(`/orders/${orderId}`);
        const medIds: number[] = (order?.mediations || []).map((m: any) => m.id);
        const claimsDetail: any[] = [];
        for (const mid of medIds) {
          try {
            const c: any = await mlGet(`/post-purchase/v1/claims/${mid}`);
            if (c) claimsDetail.push({ claim_id: c.id, status: c.status, stage: c.stage, type: c.type, resolution_reason: c.resolution?.reason, resolution_benefited: c.resolution?.benefited });
          } catch {}
        }
        results.push({ order_id: orderId, order_status: order?.status, mediation_ids: medIds, claims: claimsDetail });
      } catch (e: any) { results.push({ order_id: orderId, error: e.message }); }
    }));
  }
  return NextResponse.json({ results });
}
