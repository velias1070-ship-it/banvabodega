"use client";
import { useState, useEffect, useCallback } from "react";
import { initStore, getRecepciones, getLineasDeRecepciones } from "@/lib/store";
import type { DBRecepcion, DBRecepcionLinea } from "@/lib/store";
import Link from "next/link";

export default function FacturasOperador() {
  const [mounted, setMounted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [recs, setRecs] = useState<DBRecepcion[]>([]);
  const [lineas, setLineas] = useState<DBRecepcionLinea[]>([]);

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

  // Group by proveedor
  const porProveedor: Record<string, { recs: DBRecepcion[]; lineas: DBRecepcionLinea[] }> = {};
  for (const r of recs) {
    const prov = r.proveedor || "Sin proveedor";
    if (!porProveedor[prov]) porProveedor[prov] = { recs: [], lineas: [] };
    porProveedor[prov].recs.push(r);
  }
  for (const l of lineas) {
    const rec = recs.find(r => r.id === l.recepcion_id);
    const prov = rec?.proveedor || "Sin proveedor";
    if (porProveedor[prov]) porProveedor[prov].lineas.push(l);
  }
  const proveedores = Object.keys(porProveedor).sort();

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
            <div style={{fontSize:20,fontWeight:800,color:"var(--txt)"}}>{proveedores.length}</div>
            <div style={{fontSize:10,color:"var(--txt3)"}}>Proveedores</div>
          </div>
          <div>
            <div style={{fontSize:20,fontWeight:800,color:"var(--amber)"}}>{lineas.length}</div>
            <div style={{fontSize:10,color:"var(--txt3)"}}>Lineas</div>
          </div>
        </div>

        {lineas.length === 0 && (
          <div style={{textAlign:"center",padding:32,color:"var(--txt3)"}}>
            <div style={{fontSize:32,marginBottom:8}}>📄</div>
            <div style={{fontSize:13}}>Sin facturas para hoy</div>
          </div>
        )}

        {/* Per-proveedor */}
        {proveedores.map(prov => {
          const grupo = porProveedor[prov];

          // Consolidate SKUs
          const skuMap: Record<string, {
            nombre: string; totalFactura: number;
            facturas: { folio: string; qty: number }[];
          }> = {};
          for (const l of grupo.lineas) {
            const rec = grupo.recs.find(r => r.id === l.recepcion_id);
            if (!skuMap[l.sku]) skuMap[l.sku] = { nombre: l.nombre, totalFactura: 0, facturas: [] };
            skuMap[l.sku].totalFactura += l.qty_factura;
            skuMap[l.sku].facturas.push({ folio: rec?.folio || "?", qty: l.qty_factura });
          }
          const skus = Object.keys(skuMap).sort();

          return (
            <div key={prov} style={{marginBottom:12,borderRadius:10,background:"var(--bg2)",border:"1px solid var(--bg3)",overflow:"hidden"}}>
              {/* Header */}
              <div style={{padding:"10px 14px",borderBottom:"1px solid var(--bg3)",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div>
                  <div style={{fontSize:14,fontWeight:700}}>{prov}</div>
                  <div style={{fontSize:11,color:"var(--txt3)"}}>
                    {grupo.recs.length} factura{grupo.recs.length > 1 ? "s" : ""}: {grupo.recs.map(r => r.folio).join(", ")}
                  </div>
                </div>
                <div style={{fontSize:12,fontWeight:700,color:"var(--cyan)"}}>{skus.length} SKUs</div>
              </div>

              {/* SKU list */}
              <div style={{padding:"8px 14px"}}>
                {skus.map(sku => {
                  const s = skuMap[sku];
                  const enMultiples = s.facturas.length > 1;

                  return (
                    <div key={sku} style={{padding:"8px 10px",marginBottom:4,borderRadius:8,
                      background:enMultiples?"var(--amberBg)":"var(--bg3)",
                      border:`1px solid ${enMultiples?"var(--amberBd)":"var(--bg4)"}`}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                        <div style={{flex:1}}>
                          <span className="mono" style={{fontWeight:700,fontSize:13}}>{sku}</span>
                          <div style={{fontSize:11,color:"var(--txt3)",marginTop:1}}>{s.nombre}</div>
                        </div>
                        <div className="mono" style={{fontSize:20,fontWeight:800,color:enMultiples?"var(--amber)":"var(--txt)"}}>{s.totalFactura}</div>
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
            </div>
          );
        })}
      </div>
    </div>
  );
}
