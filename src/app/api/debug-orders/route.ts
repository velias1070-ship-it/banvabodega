import { NextRequest, NextResponse } from "next/server";
import { mlGet } from "@/lib/ml";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
export async function GET(req: NextRequest) {
  const open: any = await mlGet(`/post-purchase/v1/claims/search?status=opened&limit=200`);
  const closed: any = await mlGet(`/post-purchase/v1/claims/search?status=closed&limit=200`);
  return NextResponse.json({
    open_count: open?.data?.length || 0,
    closed_count: closed?.data?.length || 0,
    open_resource_ids: (open?.data || []).map((c: any) => String(c.resource_id)),
    closed_summary: (closed?.data || []).map((c: any) => ({ order_id: String(c.resource_id), resolution: c.resolution?.reason, closed: c.date_closed })),
  });
}
