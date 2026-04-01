import { NextRequest, NextResponse } from "next/server";

const ML_API = "https://api.mercadolibre.com";

async function mlPublicGet<T = unknown>(path: string): Promise<T | null> {
  const resp = await fetch(`${ML_API}${path}`);
  if (!resp.ok) return null;
  return resp.json() as Promise<T>;
}

/**
 * Fetch required/optional attributes for a ML category.
 * GET ?category_id=MLC1234
 */
export async function GET(req: NextRequest) {
  try {
    const categoryId = new URL(req.url).searchParams.get("category_id");
    if (!categoryId) {
      return NextResponse.json({ error: "category_id required" }, { status: 400 });
    }

    const [attributes, category] = await Promise.all([
      mlPublicGet<unknown[]>(`/categories/${categoryId}/attributes`),
      mlPublicGet<{ listing_allowed: boolean; settings?: { listing_types?: unknown[] } }>(`/categories/${categoryId}`),
    ]);

    if (!attributes) {
      return NextResponse.json({ error: "Could not fetch attributes" }, { status: 502 });
    }

    return NextResponse.json({
      attributes,
      category_id: categoryId,
      listing_allowed: category?.listing_allowed ?? true,
      listing_types: category?.settings?.listing_types || [],
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
