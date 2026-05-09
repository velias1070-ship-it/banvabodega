import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

// GET /api/proveedor-catalogo/analisis?proveedor_id=<uuid>&prefix_len=9
//
// Analiza el catalogo de un proveedor cruzandolo con productos / ventas:
//   - SKUs del catalogo que NO existen en `productos`
//   - Agrupados por familia (prefijo SKU configurable, default 9 chars)
//   - Para cada familia, indica si vendes algo del prefijo (variantes match)
//     o es linea totalmente nueva.
//
// Caso de uso: descubrir variantes (talla/color) que el proveedor ofrece y
// no estas publicando, y lineas completamente nuevas que vale la pena evaluar.

export const dynamic = "force-dynamic";

interface FamiliaRow {
  familia: string;
  /** Nombre legible inferido: nombre del producto más vendido de la familia.
   *  Si la familia no tiene match, usa el nombre del primer SKU del catálogo. */
  nombre_familia: string;
  /** Categoría inferida del producto representativo (puede ser null). */
  categoria: string | null;
  skus_nuevos: Array<{ sku: string; nombre: string | null; precio_neto: number; stock_disponible: number; inner_pack: number }>;
  skus_que_ya_tenemos: number;
  uds_180d_familia: number;
  top_3_vendidos: Array<{ sku: string; nombre: string | null; uds_180d: number }>;
  match: boolean;
}

export async function GET(req: NextRequest) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const proveedorId = req.nextUrl.searchParams.get("proveedor_id");
  if (!proveedorId) return NextResponse.json({ error: "proveedor_id requerido" }, { status: 400 });

  // Default 7 chars: agrupa por categoría (ej TXSB144 = sábanas 144 hilos,
  // TXSB180 = sábanas 180 hilos, JSAFAB4 = quilts modelo 4xx). Antes era 9
  // pero sub-dividía por diseño/color y perdía la noción de categoría.
  const prefixLen = Math.max(4, Math.min(15, Number(req.nextUrl.searchParams.get("prefix_len") || "7")));
  const start = Date.now();

  // 1. Catalogo del proveedor (incluye los con proveedor_id null si proveedorId es 'null')
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

  // 2. Cuales ya existen en productos
  const { data: prodRows, error: prodErr } = await sb.from("productos")
    .select("sku").in("sku", skusCatalogo);
  if (prodErr) return NextResponse.json({ error: prodErr.message }, { status: 500 });
  const skusEnProductos = new Set((prodRows || []).map(p => p.sku));

  // 3. Productos del proveedor (todos, para detectar familias conocidas)
  let prodProvQuery = sb.from("productos").select("sku, nombre, categoria");
  if (proveedorId !== "null") prodProvQuery = prodProvQuery.eq("proveedor_id", proveedorId);
  const { data: prodProv, error: prodProvErr } = await prodProvQuery;
  if (prodProvErr) return NextResponse.json({ error: prodProvErr.message }, { status: 500 });

  // 4. Ventas 180d por sku_origen — para ranking de familia
  type VentaRow = { sku_origen: string; uds_180d: number };
  const ventasMap = new Map<string, number>();
  const desde180 = new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10);

  // Pull ventas via composicion_venta (paginado para evitar limite default)
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
  for (const v of ventasRaw) {
    const so = skuVentaToOrigen.get(v.sku_venta.toUpperCase()) || v.sku_venta;
    ventasMap.set(so, (ventasMap.get(so) || 0) + v.cantidad);
  }

  // 5. Agrupar
  const fam = (sku: string) => sku.toUpperCase().substring(0, prefixLen);
  type ProdRow = { sku: string; nombre: string | null; categoria: string | null };
  const familiasConocidas = new Map<string, {
    skus: ProdRow[];
    uds_180d: number;
    top_vendidos: Array<{ sku: string; nombre: string | null; uds: number }>;
  }>();
  for (const p of (prodProv || []) as ProdRow[]) {
    const f = fam(p.sku);
    const uds = ventasMap.get(p.sku) || 0;
    let entry = familiasConocidas.get(f);
    if (!entry) { entry = { skus: [], uds_180d: 0, top_vendidos: [] }; familiasConocidas.set(f, entry); }
    entry.skus.push(p);
    entry.uds_180d += uds;
    if (uds > 0) entry.top_vendidos.push({ sku: p.sku, nombre: p.nombre, uds });
  }

  // Helper: nombre legible de la categoría inferido del nombre de los productos.
  // Estrategia en cascada:
  //   1. Prefijo común de palabras (ej "Quilt Atenas Beige" + "Quilt Atenas Gris" → "Quilt Atenas").
  //   2. Si no hay prefijo (los nombres difieren desde la palabra 1), intersección de
  //      palabras que aparecen en ≥80% de los nombres en cualquier posición. Filtra
  //      tokens muy cortos (<3 chars) y atributos típicos de variante (colores, tallas).
  //      Ejemplo: ["Sábana 144 hilos Daniela 1.5P", "Sábana 144 hilos Rosa 2P", "Sábana 144 hilos Liso 1P"]
  //       → tokens comunes en ≥80%: {sábana, 144, hilos} → "Sábana 144 hilos"
  //   3. Si tampoco, devuelve el nombre del más vendido (truncado).
  const STOPWORDS_VARIANTE = new Set([
    "rojo","red","azul","blue","negro","black","blanco","white","verde","green","gris","grey","gray",
    "rosa","pink","amarillo","yellow","violeta","purple","celeste","beige","cafe","brown","crema","cream",
    "naranja","orange","oro","gold","plata","silver","fucsia","turquesa","lila","mostaza","mostaza",
    "1p","2p","3p","4p","5p","6p","7p","8p","1.5p","2.5p","10p","15p","20p","25p","30p",
    "10","15","20","25","30","unico","unica","liso","lisa","par","pares","unidad","unidades",
  ]);
  const tokenize = (s: string) => s.toLowerCase().split(/\s+/).filter(Boolean);
  const nombreFamilia = (nombres: Array<string | null>): string => {
    const validos = nombres.filter((n): n is string => !!n && n.trim().length > 0);
    if (validos.length === 0) return "(sin nombre)";
    if (validos.length === 1) return validos[0];
    // (1) Prefijo común de palabras enteras
    const palabras = validos.map(n => n.split(/\s+/));
    const minLen = Math.min(...palabras.map(p => p.length));
    const prefijoComun: string[] = [];
    for (let i = 0; i < minLen; i++) {
      const p0 = palabras[0][i].toLowerCase();
      if (palabras.every(p => p[i].toLowerCase() === p0)) {
        prefijoComun.push(palabras[0][i]);
      } else break;
    }
    if (prefijoComun.length >= 2) return prefijoComun.join(" ");
    // (2) Intersección de tokens (palabras comunes en ≥80% de nombres)
    const tokenCount = new Map<string, { count: number; firstSeen: number; original: string }>();
    validos.forEach((n, idx) => {
      const tokensArr = Array.from(new Set(tokenize(n)));
      for (const t of tokensArr) {
        if (t.length < 3) continue;
        if (STOPWORDS_VARIANTE.has(t)) continue;
        const existing = tokenCount.get(t);
        if (existing) existing.count++;
        else {
          const original = (n.split(/\s+/).find(w => w.toLowerCase() === t)) || t;
          tokenCount.set(t, { count: 1, firstSeen: idx, original });
        }
      }
    });
    const umbral = Math.ceil(validos.length * 0.8);
    const comunes = Array.from(tokenCount.entries())
      .filter(([, v]) => v.count >= umbral)
      .sort((a, b) => a[1].firstSeen - b[1].firstSeen);
    if (comunes.length >= 1) {
      // Reordenar según el orden en el primer nombre que tiene todos los tokens
      const tokensSet = new Set(comunes.map(([t]) => t));
      const primerNombreConTodos = validos.find(n => tokenize(n).filter(t => tokensSet.has(t)).length === comunes.length) || validos[0];
      const ordenado = primerNombreConTodos.split(/\s+/).filter(w => tokensSet.has(w.toLowerCase()));
      if (ordenado.length >= 1) return ordenado.join(" ");
    }
    // (3) Fallback: nombre del primero (más vendido viene primero en el array)
    return validos[0].length > 50 ? validos[0].substring(0, 50) + "…" : validos[0];
  };

  const familiasNuevas = new Map<string, FamiliaRow>();
  for (const c of catalogo as Array<{ sku_origen: string; nombre: string | null; precio_neto: number; stock_disponible: number | null; inner_pack: number | null }>) {
    if (skusEnProductos.has(c.sku_origen)) continue;
    const f = fam(c.sku_origen);
    let entry = familiasNuevas.get(f);
    if (!entry) {
      const conocida = familiasConocidas.get(f);
      const topOrdenados = (conocida?.top_vendidos || []).sort((a, b) => b.uds - a.uds);
      // Inferir nombre + categoría del producto más vendido (o cualquier producto si nadie vendió)
      const repre: ProdRow | undefined = topOrdenados[0]
        ? conocida?.skus.find(s => s.sku === topOrdenados[0].sku)
        : conocida?.skus[0];
      const nombreInf = conocida && conocida.skus.length > 0
        ? nombreFamilia(conocida.skus.map(s => s.nombre))
        : (c.nombre || "(catálogo sin nombre)");
      entry = {
        familia: f,
        nombre_familia: nombreInf,
        categoria: repre?.categoria ?? null,
        skus_nuevos: [],
        skus_que_ya_tenemos: conocida?.skus.length || 0,
        uds_180d_familia: conocida?.uds_180d || 0,
        top_3_vendidos: topOrdenados.slice(0, 3).map(t => ({ sku: t.sku, nombre: t.nombre, uds_180d: t.uds })),
        match: !!conocida,
      };
      familiasNuevas.set(f, entry);
    }
    entry.skus_nuevos.push({
      sku: c.sku_origen,
      nombre: c.nombre,
      precio_neto: Number(c.precio_neto) || 0,
      stock_disponible: Number(c.stock_disponible) || 0,
      inner_pack: Number(c.inner_pack) || 1,
    });
  }

  const familias = Array.from(familiasNuevas.values()).sort((a, b) => {
    if (a.match !== b.match) return a.match ? -1 : 1;
    return b.uds_180d_familia - a.uds_180d_familia;
  });

  return NextResponse.json({
    ok: true,
    proveedor_id: proveedorId,
    prefix_len: prefixLen,
    total_familias: familias.length,
    total_skus_nuevos: catalogo.length - skusEnProductos.size,
    skus_en_catalogo: catalogo.length,
    skus_ya_creados: skusEnProductos.size,
    familias,
    tiempo_ms: Date.now() - start,
  });
}
