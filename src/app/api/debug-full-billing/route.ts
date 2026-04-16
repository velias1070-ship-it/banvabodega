import { NextRequest, NextResponse } from "next/server";
import { mlGet } from "@/lib/ml";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("key") || "2026-04-01";
  const limit = req.nextUrl.searchParams.get("limit") || "5";
  const url = `/billing/integration/periods/key/${key}/group/ML/full/details?limit=${limit}`;
  try {
    const raw = await mlGet<any>(url);
    return NextResponse.json({ url, raw });
  } catch (e) {
    return NextResponse.json({ url, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
