import { NextRequest, NextResponse } from "next/server";
import { mlGet } from "@/lib/ml";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
export async function GET(req: NextRequest) {
  const ids = (req.nextUrl.searchParams.get("ids") || "").split(",").filter(Boolean);
  const results: any[] = [];
  for (let i = 0; i < ids.length; i += 5) {
    const batch = ids.slice(i, i + 5);
    await Promise.all(batch.map(async (id) => {
      try {
        const o: any = await mlGet(`/orders/${id}`);
        results.push({ id, status: o?.status, mediations: o?.mediations?.length || 0, tags: o?.tags || [] });
      } catch (e: any) { results.push({ id, error: e.message }); }
    }));
    if (i + 5 < ids.length) await new Promise(r => setTimeout(r, 200));
  }
  return NextResponse.json({ results });
}
