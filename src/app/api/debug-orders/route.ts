import { NextRequest, NextResponse } from "next/server";
import { mlGet } from "@/lib/ml";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
export async function GET(req: NextRequest) {
  const ids = (req.nextUrl.searchParams.get("ids") || "").split(",").filter(Boolean);
  const results: any[] = [];
  for (let i = 0; i < ids.length; i += 3) {
    const batch = ids.slice(i, i + 3);
    await Promise.all(batch.map(async (id) => {
      try {
        const claims: any = await mlGet(`/post-purchase/v1/claims/search?resource_id=${id}&limit=10`);
        const arr = claims?.data || [];
        results.push({
          id,
          claims: arr.map((c: any) => ({
            claim_id: c.id,
            status: c.status,
            stage: c.stage,
            resolution_reason: c.resolution?.reason,
            type: c.type,
            date_closed: c.date_closed,
          })),
        });
      } catch (e: any) { results.push({ id, error: e.message }); }
    }));
    if (i + 3 < ids.length) await new Promise(r => setTimeout(r, 300));
  }
  return NextResponse.json({ results });
}
