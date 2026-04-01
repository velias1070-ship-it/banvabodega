import { NextRequest, NextResponse } from "next/server";

const ML_API = "https://api.mercadolibre.com";

/** Public ML API fetch (no auth token needed for category endpoints) */
async function mlPublicGet<T = unknown>(path: string): Promise<T | null> {
  const resp = await fetch(`${ML_API}${path}`);
  if (!resp.ok) return null;
  return resp.json() as Promise<T>;
}

/**
 * Search/browse MercadoLibre categories for Chile (MLC).
 * GET ?q=zapatilla        → domain_discovery search
 * GET ?parent_id=MLC1234  → category children
 * GET ?id=MLC1234         → category detail
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const q = searchParams.get("q");
    const parentId = searchParams.get("parent_id");
    const id = searchParams.get("id");

    if (q) {
      const results = await mlPublicGet<unknown[]>(`/sites/MLC/domain_discovery/search?q=${encodeURIComponent(q)}`);
      if (!results) {
        // Fallback to category predictor
        const predict = await mlPublicGet<unknown>(`/sites/MLC/category_predictor/predict?title=${encodeURIComponent(q)}`);
        return NextResponse.json({ results: predict ? [predict] : [], source: "predictor" });
      }
      return NextResponse.json({ results, source: "domain_discovery" });
    }

    if (parentId) {
      const cat = await mlPublicGet<{ children_categories?: unknown[] }>(`/categories/${parentId}`);
      if (!cat) return NextResponse.json({ error: "Category not found" }, { status: 404 });
      return NextResponse.json(cat);
    }

    if (id) {
      const cat = await mlPublicGet<unknown>(`/categories/${id}`);
      if (!cat) return NextResponse.json({ error: "Category not found" }, { status: 404 });
      return NextResponse.json(cat);
    }

    // Default: top-level categories for MLC
    const top = await mlPublicGet<unknown[]>("/sites/MLC/categories");
    return NextResponse.json({ results: top || [] });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
