"use client";
import { useState, useEffect, useCallback } from "react";
import { initStore, getRecepciones, getLineasDeRecepciones, getStore } from "@/lib/store";
import type { DBRecepcion, DBRecepcionLinea } from "@/lib/store";
import Link from "next/link";

// ==================== PARSING INTELIGENTE ====================

// Normaliza variantes de categoría a un nombre canónico
const CATEGORIA_NORM: Record<string, string> = {
  "quilt": "Quilts", "quilts": "Quilts",
  "limpiapie": "Limpiapies", "limpiapies": "Limpiapies", "limpia pie": "Limpiapies",
  "sabana": "Jgo Sabanas", "sabanas": "Jgo Sabanas", "sábana": "Jgo Sabanas", "sábanas": "Jgo Sabanas",
  "jgo sabanas": "Jgo Sabanas", "jgo sabana": "Jgo Sabanas", "juego sabanas": "Jgo Sabanas",
  "toalla": "Toallas", "toallas": "Toallas",
  "almohada": "Almohadas", "almohadas": "Almohadas",
  "funda": "Fundas", "fundas": "Fundas",
  "plumon": "Plumones", "plumón": "Plumones", "plumones": "Plumones", "duvet": "Plumones",
  "cubrecama": "Cubrecamas", "cubrecamas": "Cubrecamas", "cubre cama": "Cubrecamas",
  "protector": "Protectores", "protectores": "Protectores",
  "bajada de cama": "Bajadas de Cama", "bajadas de cama": "Bajadas de Cama", "pie de cama": "Bajadas de Cama",
  "cortina": "Cortinas", "cortinas": "Cortinas",
  "cojin": "Cojines", "cojín": "Cojines", "cojines": "Cojines",
};

function normalizarCategoria(cat: string): string {
  const key = cat.trim().toLowerCase();
  return CATEGORIA_NORM[key] || cat.trim();
}

function parseCategoria(nombre: string, cat: string): string {
  const n = nombre.toLowerCase();
  // Usar categoria del diccionario si existe y no es genérica, normalizada
  if (cat && cat !== "Otros" && cat !== "") return normalizarCategoria(cat);
  // Fallback: parsear del nombre
  if (n.includes("quilt")) return "Quilts";
  if (n.includes("limpiapie") || n.includes("limpia pie")) return "Limpiapies";
  if (n.includes("jgo sabana") || n.includes("jgo. sabana") || n.includes("juego sabana") || n.includes("sabana")) return "Jgo Sabanas";
  if (n.includes("toalla")) return "Toallas";
  if (n.includes("almohada")) return "Almohadas";
  if (n.includes("funda")) return "Fundas";
  if (n.includes("plumón") || n.includes("plumon") || n.includes("duvet")) return "Plumones";
  if (n.includes("cubrecama") || n.includes("cubre cama")) return "Cubrecamas";
  if (n.includes("protector")) return "Protectores";
  if (n.includes("bajada") || n.includes("pie de cama")) return "Bajadas de Cama";
  if (n.includes("cortina")) return "Cortinas";
  if (n.includes("cojin") || n.includes("cojín")) return "Cojines";
  return "Otros";
}

function parseTamano(nombre: string, sku: string): { label: string; order: number } {
  const n = (nombre + " " + sku).toLowerCase();
  // 1 plaza / 1.5 plaza
  if (/\b1[\.\,]?5\s*p/i.test(n) || /\b1½/i.test(n)) return { label: "1.5 Plazas", order: 1 };
  if (/\b1\s*p(?:laza)?(?:\b|$)/i.test(n) && !/\b1[\.\,]5/i.test(n)) return { label: "1 Plaza", order: 0 };
  // 2 plazas
  if (/\b2[\.\,]?0?\s*p(?:laza)?(?:\b|$)/i.test(n) && !/\b2[\.\,]5/i.test(n) && !/\b25p/i.test(n)) return { label: "2 Plazas", order: 2 };
  // 2.5 plazas / King
  if (/\b2[\.\,]5\s*p/i.test(n) || /\b25p/i.test(n) || /\bking\b/i.test(n)) return { label: "King (2.5P)", order: 3 };
  // Super King / 3 plazas
  if (/\bsuper\s*king/i.test(n) || /\b3\s*p/i.test(n)) return { label: "Super King", order: 4 };
  return { label: "", order: 5 };
}

function parseHilos(nombre: string): string {
  const m = nombre.match(/(\d+)\s*(?:h(?:ilos)?|tc)\b/i);
  if (m) return m[1] + "H";
  return "";
}

interface SkuConsolidado {
  sku: string;
  nombre: string;
  totalFactura: number;
  facturas: { folio: string; qty: number }[];
  categoria: string;
  tamano: { label: string; order: number };
  hilos: string;
}

export default function FacturasOperador() {
  const [mounted, setMounted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [recs, setRecs] = useState<DBRecepcion[]>([]);
  const [lineas, setLineas] = useState<DBRecepcionLinea[]>([]);
  const [busqueda, setBusqueda] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  useEffect(() => {
    initStore().then(() => { setMounted(true); setLoading(false); });
  }, []);

  const fecha = new Date().toISOString().slice(0, 10);

  const loadAll = useCallback(async () => {
    const allRecs = await getRecepciones();
    const recsHoy = allRecs.filter(r => r.created_at?.slice(0, 10) === fecha && r.estado !== "ANULADA");
    setRecs(recsHoy);
    const ids = recsHoy.map(r => r.id!).filter(Boolean);
    if (ids.length > 0) {
      setLineas(await getLineasDeRecepciones(ids));
    } else {
      setLineas([]);
    }
  }, [fecha]);

  useEffect(() => { if (mounted) { setLoading(true); loadAll().finally(() => setLoading(false)); } }, [mounted, loadAll]);

  if (!mounted || loading) return (
    <div style={{display:"flex",alignItems:"center",justifyContent:"center",minHeight:"100dvh",background:"var(--bg)"}}>
      <div style={{textAlign:"center"}}><div style={{fontSize:24,fontWeight:700,marginBottom:8}}>BANVA Bodega</div><div style={{color:"var(--txt3)"}}>Cargando facturas...</div></div>
    </div>
  );

  const products = getStore().products;

  // Build consolidated SKU list across all providers
  const allSkus: Record<string, SkuConsolidado> = {};
  for (const l of lineas) {
    const rec = recs.find(r => r.id === l.recepcion_id);
    if (!allSkus[l.sku]) {
      const prod = products[l.sku];
      const cat = parseCategoria(l.nombre, prod?.cat || "");
      allSkus[l.sku] = {
        sku: l.sku, nombre: l.nombre, totalFactura: 0, facturas: [],
        categoria: cat, tamano: parseTamano(l.nombre, l.sku), hilos: parseHilos(l.nombre),
      };
    }
    allSkus[l.sku].totalFactura += l.qty_factura;
    allSkus[l.sku].facturas.push({ folio: rec?.folio || "?", qty: l.qty_factura });
  }

  // Filter by search
  const q = busqueda.trim().toLowerCase();
  const skuList = Object.values(allSkus).filter(s =>
    !q || s.sku.toLowerCase().includes(q) || s.nombre.toLowerCase().includes(q) || s.categoria.toLowerCase().includes(q)
  );

  // Group by categoria, then sort by tamano/hilos within each
  const porCategoria: Record<string, SkuConsolidado[]> = {};
  for (const s of skuList) {
    if (!porCategoria[s.categoria]) porCategoria[s.categoria] = [];
    porCategoria[s.categoria].push(s);
  }
  // Sort SKUs within each category by tamano order, then hilos, then name
  for (const cat of Object.keys(porCategoria)) {
    porCategoria[cat].sort((a, b) => {
      if (a.tamano.order !== b.tamano.order) return a.tamano.order - b.tamano.order;
      if (a.hilos !== b.hilos) return a.hilos.localeCompare(b.hilos);
      return a.nombre.localeCompare(b.nombre);
    });
  }
  // Sort categories alphabetically, "Otros" at end
  const categorias = Object.keys(porCategoria).sort((a, b) => {
    if (a === "Otros") return 1;
    if (b === "Otros") return -1;
    return a.localeCompare(b);
  });

  const totalUnidades = skuList.reduce((s, x) => s + x.totalFactura, 0);

  return (
    <div className="app">
      <div className="topbar">
        <Link href="/operador"><button className="back-btn">&#8592;</button></Link>
        <h1>Facturas del Dia</h1>
        <button onClick={() => { setLoading(true); loadAll().finally(() => setLoading(false)); }}
          style={{padding:"4px 10px",borderRadius:6,background:"var(--bg3)",color:"var(--cyan)",fontSize:11,fontWeight:600,border:"1px solid var(--bg4)"}}>
          Actualizar
        </button>
      </div>

      <div style={{padding:12}}>
        {/* Summary */}
        <div style={{padding:"12px 14px",borderRadius:10,background:"var(--bg2)",border:"1px solid var(--bg3)",marginBottom:12,
          display:"flex",justifyContent:"space-around",textAlign:"center"}}>
          <div>
            <div style={{fontSize:20,fontWeight:800,color:"var(--cyan)"}}>{recs.length}</div>
            <div style={{fontSize:10,color:"var(--txt3)"}}>Facturas</div>
          </div>
          <div>
            <div style={{fontSize:20,fontWeight:800,color:"var(--txt)"}}>{Object.keys(allSkus).length}</div>
            <div style={{fontSize:10,color:"var(--txt3)"}}>SKUs</div>
          </div>
          <div>
            <div style={{fontSize:20,fontWeight:800,color:"var(--amber)"}}>{totalUnidades.toLocaleString()}</div>
            <div style={{fontSize:10,color:"var(--txt3)"}}>Unidades</div>
          </div>
        </div>

        {/* Search */}
        <div style={{position:"relative",marginBottom:12}}>
          <input type="text" value={busqueda} onChange={e => setBusqueda(e.target.value)}
            placeholder="Buscar por SKU, nombre o categoria..."
            style={{width:"100%",padding:"10px 14px 10px 36px",borderRadius:8,background:"var(--bg2)",border:"1px solid var(--bg3)",color:"var(--txt)",fontSize:13,outline:"none"}} />
          <span style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",fontSize:16,color:"var(--txt3)",pointerEvents:"none"}}>&#128269;</span>
          {busqueda && (
            <button onClick={() => setBusqueda("")}
              style={{position:"absolute",right:8,top:"50%",transform:"translateY(-50%)",background:"var(--bg3)",border:"1px solid var(--bg4)",borderRadius:4,color:"var(--txt3)",fontSize:11,padding:"2px 8px",cursor:"pointer"}}>X</button>
          )}
        </div>
        {q && <div style={{fontSize:11,color:"var(--txt3)",marginBottom:8,textAlign:"center"}}>{skuList.length} resultado{skuList.length !== 1 ? "s" : ""}</div>}

        {lineas.length === 0 && (
          <div style={{textAlign:"center",padding:32,color:"var(--txt3)"}}>
            <div style={{fontSize:32,marginBottom:8}}>📄</div>
            <div style={{fontSize:13}}>Sin facturas para hoy</div>
          </div>
        )}

        {/* Per-category sections */}
        {categorias.map(cat => {
          const items = porCategoria[cat];
          const catTotal = items.reduce((s, x) => s + x.totalFactura, 0);
          const isCollapsed = collapsed[cat] === true;

          // Sub-group by tamano within category
          const subgrupos: { label: string; items: SkuConsolidado[] }[] = [];
          let currentTamano = "";
          for (const item of items) {
            const tamLabel = item.tamano.label || "";
            const hiloLabel = item.hilos ? ` ${item.hilos}` : "";
            const groupLabel = tamLabel + hiloLabel || "";
            if (groupLabel !== currentTamano || subgrupos.length === 0) {
              subgrupos.push({ label: groupLabel, items: [] });
              currentTamano = groupLabel;
            }
            subgrupos[subgrupos.length - 1].items.push(item);
          }

          return (
            <div key={cat} style={{marginBottom:12}}>
              {/* Category header */}
              <div onClick={() => setCollapsed(c => ({...c, [cat]: !c[cat]}))}
                style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 12px",
                  borderRadius:isCollapsed?"8px":"8px 8px 0 0",background:"var(--bg2)",border:"1px solid var(--bg3)",cursor:"pointer"}}>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <span style={{fontSize:14,fontWeight:800}}>{cat}</span>
                  <span style={{fontSize:11,color:"var(--txt3)"}}>{items.length} SKU{items.length > 1 ? "s" : ""}</span>
                </div>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <span className="mono" style={{fontSize:14,fontWeight:700,color:"var(--cyan)"}}>{catTotal}</span>
                  <span style={{fontSize:12,color:"var(--txt3)",transition:"transform 0.2s",transform:isCollapsed?"rotate(-90deg)":"rotate(0)"}}>&#9660;</span>
                </div>
              </div>

              {/* Category content */}
              {!isCollapsed && (
                <div style={{background:"var(--bg2)",border:"1px solid var(--bg3)",borderTop:"none",borderRadius:"0 0 8px 8px",padding:"6px 10px"}}>
                  {subgrupos.map((sg, gi) => (
                    <div key={gi}>
                      {/* Sub-group label (tamano/hilos) */}
                      {sg.label && (
                        <div style={{fontSize:10,fontWeight:700,color:"var(--txt3)",padding:"6px 4px 2px",
                          borderTop:gi>0?"1px solid var(--bg3)":"none",marginTop:gi>0?4:0,
                          textTransform:"uppercase",letterSpacing:"0.05em"}}>
                          {sg.label}
                        </div>
                      )}
                      {sg.items.map(s => {
                        const enMultiples = s.facturas.length > 1;
                        return (
                          <div key={s.sku} style={{padding:"8px 10px",marginBottom:4,borderRadius:8,
                            background:enMultiples?"var(--amberBg)":"var(--bg3)",
                            border:`1px solid ${enMultiples?"var(--amberBd)":"var(--bg4)"}`}}>
                            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                              <div style={{flex:1,minWidth:0}}>
                                <span className="mono" style={{fontWeight:700,fontSize:12}}>{s.sku}</span>
                                <div style={{fontSize:11,color:"var(--txt3)",marginTop:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{s.nombre}</div>
                              </div>
                              <div className="mono" style={{fontSize:20,fontWeight:800,color:enMultiples?"var(--amber)":"var(--txt)",marginLeft:8}}>{s.totalFactura}</div>
                            </div>
                            {enMultiples && (
                              <div style={{marginTop:4,fontSize:10,color:"var(--txt3)"}}>
                                {s.facturas.map((f, i) => (
                                  <span key={i}>
                                    {i > 0 && " + "}
                                    <span style={{color:"var(--cyan)",fontWeight:600}}>{f.folio}</span>: {f.qty}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
