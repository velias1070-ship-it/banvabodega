import type { DBRcvCompra, DBRecepcion, DBRecepcionLinea, DBDiscrepanciaCosto, DBProduct } from "./db";

export interface NCEsperadaItem {
  sku: string;
  qty: number;
  costoFactura: number;
  precioRef: number;
  fuente: "catalogo" | "wac";
  deltaUd: number;
  subtotal: number;
}

export interface NCEsperada {
  neto: number;
  iva: number;
  total: number;
  items: NCEsperadaItem[];
  fuenteMix: "catálogo" | "WAC (sin catálogo)" | "mixto" | "—";
}

const VACIA: NCEsperada = { neto: 0, iva: 0, total: 0, items: [], fuenteMix: "—" };

export function normProv(s: string): string {
  return (s || "").toUpperCase().trim()
    .replace(/\s+(S\.?A\.?|SPA|LTDA\.?|LIMITADA|SRL|EIRL)\.?$/i, "")
    .replace(/[.,]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

interface CalcArgs {
  proveedorRazonSocial: string;
  discrepancias: DBDiscrepanciaCosto[];
  lineasPorLineaId: Map<string, DBRecepcionLinea>;
  catalogo: Map<string, number>;
  productos: Map<string, DBProduct>;
}

export function calcularNCEsperadaParaDiscs(args: CalcArgs): NCEsperada {
  const { proveedorRazonSocial, discrepancias, lineasPorLineaId, catalogo, productos } = args;
  if (!discrepancias || discrepancias.length === 0) return VACIA;

  const provNorm = normProv(proveedorRazonSocial);

  const items: NCEsperadaItem[] = discrepancias
    .map((d): NCEsperadaItem | null => {
      const linea = d.linea_id ? lineasPorLineaId.get(d.linea_id) : undefined;
      const qty = linea?.qty_recibida || 0;
      const skuUp = (d.sku || "").toUpperCase().trim();
      const precioCat = catalogo.get(`${provNorm}|${skuUp}`) || 0;
      const prod = productos.get(skuUp);
      const wac = (prod?.costo_promedio as number) || 0;
      const precioRef = precioCat > 0 ? precioCat : wac;
      if (precioRef <= 0) return null;
      const fuente: "catalogo" | "wac" = precioCat > 0 ? "catalogo" : "wac";
      const deltaUd = (Number(d.costo_factura) || 0) - precioRef;
      if (deltaUd <= 0 || qty <= 0) return null;
      return { sku: d.sku, qty, costoFactura: Number(d.costo_factura) || 0, precioRef, fuente, deltaUd, subtotal: deltaUd * qty };
    })
    .filter((x): x is NCEsperadaItem => x !== null);

  if (items.length === 0) return VACIA;

  const fuenteMix: NCEsperada["fuenteMix"] = items.every(x => x.fuente === "catalogo")
    ? "catálogo"
    : items.every(x => x.fuente === "wac") ? "WAC (sin catálogo)" : "mixto";

  const neto = Math.round(items.reduce((s, x) => s + x.subtotal, 0));
  const iva = Math.round(neto * 0.19);
  return { neto, iva, total: neto + iva, items, fuenteMix };
}

interface PorFacturaArgs {
  facturas: DBRcvCompra[];
  recepciones: DBRecepcion[];
  discrepancias: DBDiscrepanciaCosto[];
  lineasPorLineaId: Map<string, DBRecepcionLinea>;
  catalogo: Map<string, number>;
  productos: Map<string, DBProduct>;
}

export function calcularNCEsperadaPorFactura(args: PorFacturaArgs): Map<string, NCEsperada> {
  const { facturas, recepciones, discrepancias, lineasPorLineaId, catalogo, productos } = args;
  const out = new Map<string, NCEsperada>();
  if (facturas.length === 0) return out;

  const recByFolio = new Map<string, DBRecepcion[]>();
  for (const r of recepciones) {
    if (!r.folio) continue;
    const key = `${r.folio}|${normProv(r.proveedor || "")}`;
    const arr = recByFolio.get(key) || [];
    arr.push(r);
    recByFolio.set(key, arr);
  }

  const discsByRec = new Map<string, DBDiscrepanciaCosto[]>();
  for (const d of discrepancias) {
    if (d.estado !== "PENDIENTE") continue;
    const arr = discsByRec.get(d.recepcion_id) || [];
    arr.push(d);
    discsByRec.set(d.recepcion_id, arr);
  }

  for (const f of facturas) {
    if (!f.id) continue;
    const tipoDoc = Number(f.tipo_doc);
    if (tipoDoc !== 33 && tipoDoc !== 34 && tipoDoc !== 46) continue;
    const key = `${f.nro_doc}|${normProv(f.razon_social || "")}`;
    const recs = recByFolio.get(key) || [];
    if (recs.length === 0) continue;
    const discsFactura: DBDiscrepanciaCosto[] = [];
    for (const r of recs) {
      const ds = r.id ? (discsByRec.get(r.id) || []) : [];
      discsFactura.push(...ds);
    }
    if (discsFactura.length === 0) continue;
    const nc = calcularNCEsperadaParaDiscs({
      proveedorRazonSocial: f.razon_social || "",
      discrepancias: discsFactura,
      lineasPorLineaId,
      catalogo,
      productos,
    });
    if (nc.total > 0) out.set(f.id, nc);
  }

  return out;
}

export function montoNCsRecibidasPorFactura(facturas: DBRcvCompra[], ncs: DBRcvCompra[]): Map<string, number> {
  const out = new Map<string, number>();
  if (ncs.length === 0) return out;

  const byFolioProv = new Map<string, string>();
  for (const f of facturas) {
    if (!f.id || !f.nro_doc) continue;
    byFolioProv.set(`${f.nro_doc}|${normProv(f.razon_social || "")}`, f.id);
  }

  for (const nc of ncs) {
    if (Number(nc.tipo_doc) !== 61) continue;
    let facId: string | undefined;
    if (nc.factura_ref_id) facId = nc.factura_ref_id;
    else if (nc.factura_ref_folio) facId = byFolioProv.get(`${nc.factura_ref_folio}|${normProv(nc.razon_social || "")}`);
    if (!facId) continue;
    out.set(facId, (out.get(facId) || 0) + (Number(nc.monto_total) || 0));
  }
  return out;
}
