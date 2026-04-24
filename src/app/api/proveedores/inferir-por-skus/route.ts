import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

/**
 * POST /api/proveedores/inferir-por-skus
 *
 * Dado una lista de SKUs, infiere el proveedor más probable cruzando:
 *   1. productos.proveedor_id (1:1 proveedor principal)
 *   2. proveedor_catalogo.proveedor_id (N:N precios pactados)
 *
 * Body: { skus: string[] }
 * Response: {
 *   proveedor_id: string | null,
 *   nombre_canonico: string | null,
 *   confidence: number,         // 0..1 (fracción de SKUs que apuntan al ganador)
 *   evidencia: string,          // "7 de 7 SKUs (100%)"
 *   candidatos: Array<{ proveedor_id, nombre, score }> // top 3
 * }
 *
 * Reglas:
 *   - Si la confidence >= 0.5 y el ganador tiene al menos 2 SKUs O 100% matching,
 *     se considera una inferencia válida.
 *   - Excluye proveedores placeholder ("Otro", "Desconocido") del ranking.
 *   - Si no hay matches o todos son placeholders, devuelve proveedor_id=null.
 */

interface InferirBody {
  skus: string[];
}

const PLACEHOLDERS = new Set(["OTRO", "DESCONOCIDO", "SIN PROVEEDOR"]);

export async function POST(req: NextRequest) {
  const sbOrNull = getServerSupabase();
  if (!sbOrNull) return NextResponse.json({ error: "no_db" }, { status: 500 });
  const sb = sbOrNull;

  let body: InferirBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const skus = (body.skus || []).map(s => (s || "").toUpperCase().trim()).filter(Boolean);
  if (skus.length === 0) {
    return NextResponse.json({ error: "skus_required" }, { status: 400 });
  }

  // 1. Productos → proveedor_id principal
  const { data: prodData } = await sb.from("productos")
    .select("sku, proveedor_id")
    .in("sku", skus);
  const prodProveedor = new Map<string, string>();
  for (const p of (prodData || []) as Array<{ sku: string; proveedor_id: string | null }>) {
    if (p.proveedor_id) prodProveedor.set((p.sku || "").toUpperCase(), p.proveedor_id);
  }

  // 2. Catálogo → posibles proveedores N:N (solo si el SKU tiene precio > 0)
  const { data: catData } = await sb.from("proveedor_catalogo")
    .select("sku_origen, proveedor_id, precio_neto")
    .in("sku_origen", skus);
  const catProveedores = new Map<string, Set<string>>(); // sku → set of proveedor_id
  for (const c of (catData || []) as Array<{ sku_origen: string; proveedor_id: string | null; precio_neto: number | null }>) {
    if (!c.proveedor_id || (c.precio_neto || 0) <= 0) continue;
    const sku = (c.sku_origen || "").toUpperCase();
    const set = catProveedores.get(sku) || new Set();
    set.add(c.proveedor_id);
    catProveedores.set(sku, set);
  }

  // 3. Scorear proveedores: cada SKU da 1 punto al proveedor principal +
  //    fracciones a cada proveedor alternativo del catálogo
  const scores = new Map<string, number>();
  for (const sku of skus) {
    const principal = prodProveedor.get(sku);
    if (principal) {
      scores.set(principal, (scores.get(principal) || 0) + 1);
    } else {
      // Si no tiene productos.proveedor_id, dividir punto entre los del catálogo
      const alts = catProveedores.get(sku);
      if (alts && alts.size > 0) {
        const frac = 1 / alts.size;
        for (const provId of Array.from(alts)) {
          scores.set(provId, (scores.get(provId) || 0) + frac);
        }
      }
    }
  }

  if (scores.size === 0) {
    return NextResponse.json({
      proveedor_id: null, nombre_canonico: null,
      confidence: 0, evidencia: "Ningún SKU tiene proveedor asociado en el catálogo ni en productos",
      candidatos: [],
    });
  }

  // 4. Traer nombres y filtrar placeholders
  const { data: provData } = await sb.from("proveedores")
    .select("id, nombre_canonico, nombre")
    .in("id", Array.from(scores.keys()));
  const provInfo = new Map<string, { nombre: string; esPlaceholder: boolean }>();
  for (const p of (provData || []) as Array<{ id: string; nombre_canonico: string | null; nombre: string }>) {
    const nombre = p.nombre_canonico || p.nombre || "";
    provInfo.set(p.id, {
      nombre,
      esPlaceholder: PLACEHOLDERS.has(nombre.toUpperCase().trim()),
    });
  }

  // 5. Rankear (excluyendo placeholders)
  const ranked = Array.from(scores.entries())
    .filter(([id]) => !provInfo.get(id)?.esPlaceholder)
    .map(([id, score]) => ({
      proveedor_id: id,
      nombre: provInfo.get(id)?.nombre || "",
      score,
    }))
    .sort((a, b) => b.score - a.score);

  if (ranked.length === 0) {
    return NextResponse.json({
      proveedor_id: null, nombre_canonico: null,
      confidence: 0, evidencia: "Solo placeholders (Otro/Desconocido) matchearon",
      candidatos: [],
    });
  }

  const ganador = ranked[0];
  const confidence = Math.round((ganador.score / skus.length) * 100) / 100;
  const evidencia = `${Math.round(ganador.score)} de ${skus.length} SKUs (${Math.round(confidence * 100)}%) apuntan a ${ganador.nombre}`;

  // Regla: confiar si al menos 50% de SKUs matchean Y hay >=2 SKUs o es 100%
  const confiable = (confidence >= 0.5 && ganador.score >= 2) || confidence === 1;

  return NextResponse.json({
    proveedor_id: confiable ? ganador.proveedor_id : null,
    nombre_canonico: confiable ? ganador.nombre : null,
    confidence,
    evidencia,
    candidatos: ranked.slice(0, 3).map(r => ({
      proveedor_id: r.proveedor_id,
      nombre: r.nombre,
      score: Math.round(r.score * 100) / 100,
    })),
  });
}
