import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

// GET /api/proveedor-catalogo/analisis?proveedor_id=<uuid>
//
// Analiza el catalogo de un proveedor agrupando por NOMBRE de producto
// (no por prefijo SKU). Cruza el catalogo con productos del sistema:
//   - SKUs del catalogo que NO existen en `productos` (variantes/lineas nuevas)
//   - Agrupados por "nombre_base" = palabras significativas del nombre
//     (ignorando colores, tallas y atributos de variante)
//
// Filosofía: el nombre del producto es lo que el humano usa para identificar
// categorías. El SKU es metadata técnica del proveedor. Agrupar por nombre
// captura categorías reales sin depender del esquema de SKU del proveedor.

export const dynamic = "force-dynamic";

interface FamiliaRow {
  /** Clave canónica de la familia: tokens significativos en lowercase. */
  familia_key: string;
  /** Nombre legible (cased original, primer producto representativo). */
  nombre_familia: string;
  /** Categoría inferida del producto representativo (puede ser null). */
  categoria: string | null;
  /** Prefijos SKU observados en la familia (info técnica). */
  prefijos_sku: string[];
  skus_nuevos: Array<{ sku: string; nombre: string | null; precio_neto: number; stock_disponible: number; inner_pack: number }>;
  skus_que_ya_tenemos: number;
  uds_180d_familia: number;
  top_3_vendidos: Array<{ sku: string; nombre: string | null; uds_180d: number }>;
  match: boolean;
}

// Stopwords de variante: colores, tallas, atributos que NO son parte de la
// categoría. Filtrados al computar nombre_base.
const STOPWORDS_VARIANTE = new Set([
  // Colores
  "rojo","red","azul","blue","negro","black","blanco","white","verde","green","gris","grey","gray",
  "rosa","pink","amarillo","yellow","violeta","purple","celeste","beige","cafe","brown","crema","cream",
  "naranja","orange","oro","gold","plata","silver","fucsia","turquesa","lila","mostaza","menta",
  "olivo","caqui","khaki","marfil","perla","pearl","coral","salmon","vino","wine","burdeos",
  "petroleo","azulino","ocre","carmin","damasco","peach","cobre","copper","bronce","nude","malva",
  "grafito","graphite","drago","cala","ben","aba","bera","roy","sopa","starry","stars","ball","unic",
  // Tallas/plazas
  "1p","2p","3p","4p","5p","6p","7p","8p","1.5p","2.5p","10p","15p","20p","25p","30p",
  "1pl","2pl","king","queen","twin","single","s26","s23","s24","s25",
  "10","15","20","25","30",
  // Genéricos de variante
  "unico","unica","liso","lisa","color","talla","estampado","estampada","est","reversible","matrimonial",
]);
const STOPWORDS_FUNCION = new Set(["de","la","el","los","las","y","o","con","sin","del","al","x"]);

function tokenizar(nombre: string): string[] {
  return nombre.toLowerCase().split(/\s+/).filter(t => t.length > 0);
}

/** Tokens significativos: ≥2 chars, sin stopwords de variante ni función. */
function tokensSignificativos(nombre: string): string[] {
  return tokenizar(nombre).filter(t =>
    t.length >= 2 && !STOPWORDS_VARIANTE.has(t) && !STOPWORDS_FUNCION.has(t)
  );
}

/** Nombre canónico para agrupación: primeras N palabras significativas
 *  (excluyendo colores/tallas/atributos). Si las primeras significativas son
 *  los mismos N tokens, dos productos van al mismo grupo. */
function nombreBase(nombre: string, maxTokens = 4): string {
  const sig = tokensSignificativos(nombre);
  return sig.slice(0, maxTokens).join(" ");
}

/** Versión legible del nombre_base: usa la cased original del primer nombre.
 *  Ejemplo: nombre_base="quilt mf roma" + nombre_original="Quilt MF Roma 20P"
 *  → "Quilt MF Roma". */
function nombreLegible(nombreOriginal: string, maxTokens = 4): string {
  const palabrasOriginales = nombreOriginal.split(/\s+/);
  const significativasOrig: string[] = [];
  for (const w of palabrasOriginales) {
    const wl = w.toLowerCase();
    if (wl.length >= 2 && !STOPWORDS_VARIANTE.has(wl) && !STOPWORDS_FUNCION.has(wl)) {
      significativasOrig.push(w);
      if (significativasOrig.length >= maxTokens) break;
    }
  }
  return significativasOrig.join(" ");
}

export async function GET(req: NextRequest) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const proveedorId = req.nextUrl.searchParams.get("proveedor_id");
  if (!proveedorId) return NextResponse.json({ error: "proveedor_id requerido" }, { status: 400 });

  // Cuántas palabras significativas usar para agrupar. 3 = más agresivo
  // (más fusiones), 4-5 = más conservador.
  const tokensAgrupacion = Math.max(2, Math.min(8, Number(req.nextUrl.searchParams.get("tokens") || "3")));
  const start = Date.now();

  // 1. Catálogo del proveedor
  let catQuery = sb.from("proveedor_catalogo")
    .select("sku_origen, nombre, precio_neto, stock_disponible, inner_pack");
  if (proveedorId === "null") {
    catQuery = catQuery.is("proveedor_id", null);
  } else {
    catQuery = catQuery.eq("proveedor_id", proveedorId);
  }
  const { data: catalogo, error: catErr } = await catQuery;
  if (catErr) return NextResponse.json({ error: catErr.message }, { status: 500 });
  if (!catalogo || catalogo.length === 0) {
    return NextResponse.json({ ok: true, total: 0, familias: [], tiempo_ms: Date.now() - start });
  }

  const skusCatalogo = catalogo.map(c => c.sku_origen);

  // 2. Productos del proveedor con nombre + categoría
  let prodQuery = sb.from("productos").select("sku, nombre, categoria");
  if (proveedorId !== "null") prodQuery = prodQuery.eq("proveedor_id", proveedorId);
  const { data: prodRows, error: prodErr } = await prodQuery;
  if (prodErr) return NextResponse.json({ error: prodErr.message }, { status: 500 });

  const productosPorSku = new Map<string, { sku: string; nombre: string | null; categoria: string | null }>();
  for (const p of (prodRows || []) as Array<{ sku: string; nombre: string | null; categoria: string | null }>) {
    productosPorSku.set(p.sku, p);
  }

  const skusEnProductos = new Set(productosPorSku.keys());

  // 3. Ventas 180d
  const desde180 = new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10);
  const ventasRaw: Array<{ sku_venta: string; cantidad: number }> = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await sb.from("ventas_ml_cache")
      .select("sku_venta, cantidad").eq("anulada", false).gte("fecha_date", desde180)
      .range(off, off + 999);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data || data.length === 0) break;
    ventasRaw.push(...(data as typeof ventasRaw));
    if (data.length < 1000) break;
  }
  const { data: comp, error: compErr } = await sb.from("composicion_venta")
    .select("sku_venta, sku_origen, tipo_relacion");
  if (compErr) return NextResponse.json({ error: compErr.message }, { status: 500 });
  const skuVentaToOrigen = new Map<string, string>();
  for (const c of (comp || []) as Array<{ sku_venta: string; sku_origen: string; tipo_relacion: string | null }>) {
    if (c.tipo_relacion === "alternativo") continue;
    if (!skuVentaToOrigen.has(c.sku_venta.toUpperCase())) {
      skuVentaToOrigen.set(c.sku_venta.toUpperCase(), c.sku_origen);
    }
  }
  const ventasMap = new Map<string, number>();
  for (const v of ventasRaw) {
    const so = skuVentaToOrigen.get(v.sku_venta.toUpperCase()) || v.sku_venta;
    ventasMap.set(so, (ventasMap.get(so) || 0) + v.cantidad);
  }

  // 4. Agrupar TODO (productos existentes + catálogo nuevo) por nombre_base.
  const familias = new Map<string, FamiliaRow>();

  // 4a. Productos existentes del proveedor (alimentan match + uds_180d).
  for (const p of (prodRows || []) as Array<{ sku: string; nombre: string | null; categoria: string | null }>) {
    if (!p.nombre) continue;
    const key = nombreBase(p.nombre, tokensAgrupacion);
    if (!key) continue;
    const uds = ventasMap.get(p.sku) || 0;
    let entry = familias.get(key);
    if (!entry) {
      entry = {
        familia_key: key,
        nombre_familia: nombreLegible(p.nombre, tokensAgrupacion),
        categoria: p.categoria,
        prefijos_sku: [],
        skus_nuevos: [],
        skus_que_ya_tenemos: 0,
        uds_180d_familia: 0,
        top_3_vendidos: [],
        match: true,
      };
      familias.set(key, entry);
    }
    entry.skus_que_ya_tenemos += 1;
    entry.uds_180d_familia += uds;
    if (uds > 0) {
      entry.top_3_vendidos.push({ sku: p.sku, nombre: p.nombre, uds_180d: uds });
    }
    // Acumular prefijo SKU (primeros 7 chars como referencia)
    const prefijo = p.sku.toUpperCase().substring(0, 7);
    if (!entry.prefijos_sku.includes(prefijo)) entry.prefijos_sku.push(prefijo);
    // Si el producto existente NO tiene categoría pero hay otro que sí, usarla
    if (!entry.categoria && p.categoria) entry.categoria = p.categoria;
  }

  // 4b. Catálogo: SKUs no existentes en productos van como nuevos.
  for (const c of catalogo as Array<{ sku_origen: string; nombre: string | null; precio_neto: number; stock_disponible: number | null; inner_pack: number | null }>) {
    if (skusEnProductos.has(c.sku_origen)) continue; // ya está en productos
    if (!c.nombre) {
      // Sin nombre, agrupamos en clave "(sin nombre)" para no mezclar con familias reales
      const key = "__sin_nombre__";
      let entry = familias.get(key);
      if (!entry) {
        entry = {
          familia_key: key,
          nombre_familia: "(SKUs sin nombre en catálogo)",
          categoria: null,
          prefijos_sku: [],
          skus_nuevos: [],
          skus_que_ya_tenemos: 0,
          uds_180d_familia: 0,
          top_3_vendidos: [],
          match: false,
        };
        familias.set(key, entry);
      }
      entry.skus_nuevos.push({
        sku: c.sku_origen,
        nombre: null,
        precio_neto: Number(c.precio_neto) || 0,
        stock_disponible: Number(c.stock_disponible) || 0,
        inner_pack: Number(c.inner_pack) || 1,
      });
      const prefijo = c.sku_origen.toUpperCase().substring(0, 7);
      if (!entry.prefijos_sku.includes(prefijo)) entry.prefijos_sku.push(prefijo);
      continue;
    }
    const key = nombreBase(c.nombre, tokensAgrupacion);
    if (!key) continue;
    let entry = familias.get(key);
    if (!entry) {
      // Familia nueva (no existe en productos del proveedor)
      entry = {
        familia_key: key,
        nombre_familia: nombreLegible(c.nombre, tokensAgrupacion),
        categoria: null,
        prefijos_sku: [],
        skus_nuevos: [],
        skus_que_ya_tenemos: 0,
        uds_180d_familia: 0,
        top_3_vendidos: [],
        match: false,
      };
      familias.set(key, entry);
    }
    entry.skus_nuevos.push({
      sku: c.sku_origen,
      nombre: c.nombre,
      precio_neto: Number(c.precio_neto) || 0,
      stock_disponible: Number(c.stock_disponible) || 0,
      inner_pack: Number(c.inner_pack) || 1,
    });
    const prefijo = c.sku_origen.toUpperCase().substring(0, 7);
    if (!entry.prefijos_sku.includes(prefijo)) entry.prefijos_sku.push(prefijo);
  }

  // 5. Procesar resultados: solo familias con SKUs nuevos en catálogo,
  //    ordenadas por match desc + uds_180d desc.
  const resultado = Array.from(familias.values())
    .filter(f => f.skus_nuevos.length > 0)
    .map(f => ({
      ...f,
      top_3_vendidos: f.top_3_vendidos.sort((a, b) => b.uds_180d - a.uds_180d).slice(0, 3),
      prefijos_sku: f.prefijos_sku.sort(),
    }))
    .sort((a, b) => {
      if (a.match !== b.match) return a.match ? -1 : 1;
      return b.uds_180d_familia - a.uds_180d_familia;
    });

  return NextResponse.json({
    ok: true,
    proveedor_id: proveedorId,
    tokens_agrupacion: tokensAgrupacion,
    total_familias: resultado.length,
    total_skus_nuevos: catalogo.length - skusEnProductos.size,
    skus_en_catalogo: catalogo.length,
    skus_ya_creados: skusEnProductos.size,
    familias: resultado,
    tiempo_ms: Date.now() - start,
  });
}
