"use client";
import React, { useState } from "react";
import { getStore, getSkusVenta, getLastSyncTime, fmtMoney } from "@/lib/store";

function DiccionarioConfig() {
  const s = getStore();
  const skusVenta = getSkusVenta();
  const allProducts = Object.values(s.products);
  const [search, setSearch] = useState("");
  const [viewTab, setViewTab] = useState<"columnas"|"productos"|"composicion">("columnas");

  const searchUpper = search.toUpperCase().trim();
  const filteredProducts = searchUpper
    ? allProducts.filter(p =>
        p.sku.toUpperCase().includes(searchUpper) ||
        p.name.toUpperCase().includes(searchUpper) ||
        (p.skuVenta||"").toUpperCase().includes(searchUpper) ||
        (p.mlCode||"").toUpperCase().includes(searchUpper) ||
        (p.prov||"").toUpperCase().includes(searchUpper)
      )
    : allProducts;

  const filteredComposicion = searchUpper
    ? skusVenta.filter(sv =>
        sv.skuVenta.toUpperCase().includes(searchUpper) ||
        sv.codigoMl.toUpperCase().includes(searchUpper) ||
        sv.componentes.some(c => c.skuOrigen.toUpperCase().includes(searchUpper))
      )
    : skusVenta;

  const columnDefs = [
    { col: "A", nombre: "SKU Venta", campo: "sku_venta", desc: "Codigo de venta en MercadoLibre (puede ser pack/combo)" },
    { col: "B", nombre: "Codigo ML", campo: "codigo_ml", desc: "ID de publicacion en MercadoLibre" },
    { col: "C", nombre: "Nombre Origen", campo: "nombre", desc: "Nombre del producto fisico" },
    { col: "D", nombre: "Proveedor", campo: "proveedor", desc: "Proveedor del producto" },
    { col: "E", nombre: "SKU Origen", campo: "sku (PK)", desc: "SKU fisico real del producto — clave primaria en tabla productos" },
    { col: "F", nombre: "Unidades", campo: "unidades", desc: "Cantidad de unidades fisicas por SKU venta (ej: pack x2 = 2)" },
    { col: "G", nombre: "Tamano", campo: "tamano", desc: "Variante de tamano del producto" },
    { col: "H", nombre: "Color", campo: "color", desc: "Variante de color del producto" },
    { col: "I", nombre: "Categoria", campo: "categoria", desc: "Categoria del producto (default: Otros)" },
    { col: "J", nombre: "Largo", campo: "—", desc: "Dimensiones — no se importa actualmente" },
    { col: "K", nombre: "Alto", campo: "—", desc: "Dimensiones — no se importa actualmente" },
    { col: "L", nombre: "Ancho", campo: "—", desc: "Dimensiones — no se importa actualmente" },
    { col: "M", nombre: "Peso (kg)", campo: "—", desc: "Peso — no se importa actualmente" },
    { col: "N", nombre: "Costo", campo: "costo", desc: "Costo unitario del producto (se divide por unidades si es pack)" },
  ];

  return (
    <div>
      {/* Header info */}
      <div className="card" style={{marginBottom:12}}>
        <div className="card-title">Diccionario de Productos (Google Sheet)</div>
        <div style={{fontSize:12,color:"var(--txt2)",marginBottom:12}}>
          El diccionario se sincroniza automaticamente cada 5 minutos desde un Google Sheet publicado como CSV.
          Alimenta dos tablas: <strong style={{color:"var(--cyan)"}}>productos</strong> (SKUs fisicos) y <strong style={{color:"var(--cyan)"}}>composicion_venta</strong> (mapeo SKU venta → SKU fisico).
        </div>
        <div style={{display:"flex",gap:16,flexWrap:"wrap"}}>
          <div style={{padding:"10px 16px",background:"var(--bg3)",borderRadius:8,textAlign:"center"}}>
            <div className="mono" style={{fontSize:20,fontWeight:700,color:"var(--cyan)"}}>{allProducts.length}</div>
            <div style={{fontSize:10,color:"var(--txt3)"}}>Productos (SKU Origen)</div>
          </div>
          <div style={{padding:"10px 16px",background:"var(--bg3)",borderRadius:8,textAlign:"center"}}>
            <div className="mono" style={{fontSize:20,fontWeight:700,color:"var(--green)"}}>{skusVenta.length}</div>
            <div style={{fontSize:10,color:"var(--txt3)"}}>SKUs Venta</div>
          </div>
          <div style={{padding:"10px 16px",background:"var(--bg3)",borderRadius:8,textAlign:"center"}}>
            <div className="mono" style={{fontSize:20,fontWeight:700,color:"var(--amber)"}}>{skusVenta.reduce((sum, sv) => sum + sv.componentes.length, 0)}</div>
            <div style={{fontSize:10,color:"var(--txt3)"}}>Composiciones</div>
          </div>
          <div style={{padding:"10px 16px",background:"var(--bg3)",borderRadius:8,textAlign:"center"}}>
            <div className="mono" style={{fontSize:20,fontWeight:700,color:"var(--txt2)"}}>{getLastSyncTime() || "Nunca"}</div>
            <div style={{fontSize:10,color:"var(--txt3)"}}>Ultima sync</div>
          </div>
        </div>
      </div>

      {/* Sub-tabs */}
      <div style={{display:"flex",gap:6,marginBottom:12}}>
        {([["columnas","Columnas del Sheet","📊"],["productos","Productos Importados","📦"],["composicion","Composicion Venta","🔗"]] as const).map(([key,label,icon])=>(
          <button key={key} onClick={()=>setViewTab(key)} style={{padding:"6px 14px",borderRadius:6,background:viewTab===key?"var(--cyan)":"var(--bg3)",color:viewTab===key?"#fff":"var(--txt2)",fontWeight:viewTab===key?700:500,fontSize:12,border:viewTab===key?"none":"1px solid var(--bg4)",cursor:"pointer"}}>{icon} {label}</button>
        ))}
      </div>

      {/* Columnas tab */}
      {viewTab==="columnas"&&(
        <div className="card">
          <div className="card-title">Mapeo de columnas del Google Sheet</div>
          <div style={{fontSize:11,color:"var(--txt3)",marginBottom:12}}>Cada fila del sheet representa una relacion SKU Venta → SKU Origen. Un mismo SKU Origen puede aparecer en multiples filas (packs, combos).</div>
          <table className="tbl" style={{width:"100%"}}>
            <thead>
              <tr>
                <th style={{width:40}}>Col</th>
                <th>Nombre en Sheet</th>
                <th>Campo en DB</th>
                <th>Descripcion</th>
              </tr>
            </thead>
            <tbody>
              {columnDefs.map(c => (
                <tr key={c.col}>
                  <td className="mono" style={{fontWeight:700,color:"var(--cyan)"}}>{c.col}</td>
                  <td style={{fontWeight:600}}>{c.nombre}</td>
                  <td className="mono" style={{fontSize:11,color:c.campo==="—"?"var(--txt3)":"var(--green)"}}>{c.campo}</td>
                  <td style={{fontSize:11,color:"var(--txt2)"}}>{c.desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{marginTop:16,padding:"10px 12px",background:"var(--bg3)",borderRadius:8,fontSize:11,color:"var(--txt2)"}}>
            <strong style={{color:"var(--amber)"}}>Logica de importacion:</strong>
            <ul style={{margin:"6px 0 0 16px",padding:0,lineHeight:1.8}}>
              <li>Se agrupan filas por <strong>SKU Origen</strong> (columna E) para crear productos unicos</li>
              <li>Si hay multiples filas, se prefiere la fila con <strong>unidades=1</strong> para nombre y costo</li>
              <li>El costo de packs se divide por unidades para obtener el costo unitario</li>
              <li>Todos los SKU Venta y Codigos ML se concatenan con comas en el producto</li>
              <li>La tabla <strong>composicion_venta</strong> se reconstruye completa en cada sync</li>
            </ul>
          </div>
        </div>
      )}

      {/* Productos tab */}
      {viewTab==="productos"&&(
        <div className="card">
          <div className="card-title">Productos importados del diccionario ({filteredProducts.length})</div>
          <input className="form-input" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Buscar por SKU, nombre, proveedor, codigo ML..." style={{marginBottom:12,fontSize:12}}/>
          <div style={{maxHeight:500,overflowY:"auto"}}>
            <table className="tbl" style={{width:"100%"}}>
              <thead>
                <tr>
                  <th>SKU Origen</th>
                  <th>Nombre</th>
                  <th>Proveedor</th>
                  <th>Categoria</th>
                  <th>SKUs Venta</th>
                  <th>Codigo ML</th>
                  <th>Tamano</th>
                  <th>Color</th>
                  <th>Costo</th>
                </tr>
              </thead>
              <tbody>
                {filteredProducts.slice(0, 200).map(p => (
                  <tr key={p.sku}>
                    <td className="mono" style={{fontWeight:700,fontSize:11}}>{p.sku}</td>
                    <td style={{fontSize:11,maxWidth:200,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.name}</td>
                    <td style={{fontSize:11}}>{p.prov||"—"}</td>
                    <td style={{fontSize:11}}>{p.cat||"—"}</td>
                    <td className="mono" style={{fontSize:10,color:"var(--cyan)",maxWidth:150,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.skuVenta||"—"}</td>
                    <td className="mono" style={{fontSize:10,color:"var(--txt3)",maxWidth:120,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.mlCode||"—"}</td>
                    <td style={{fontSize:11}}>{p.tamano||"—"}</td>
                    <td style={{fontSize:11}}>{p.color||"—"}</td>
                    <td className="mono" style={{fontSize:11,color:"var(--green)"}}>{p.cost ? fmtMoney(p.cost) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filteredProducts.length > 200 && <div style={{padding:8,textAlign:"center",fontSize:11,color:"var(--txt3)"}}>Mostrando 200 de {filteredProducts.length} — usa el buscador para filtrar</div>}
          </div>
        </div>
      )}

      {/* Composicion tab */}
      {viewTab==="composicion"&&(
        <div className="card">
          <div className="card-title">Composicion de venta ({filteredComposicion.length} SKUs venta)</div>
          <div style={{fontSize:11,color:"var(--txt3)",marginBottom:8}}>Mapeo SKU Venta → SKU Origen con unidades. Muestra como se descomponen los packs/combos en productos fisicos.</div>
          <input className="form-input" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Buscar por SKU venta, SKU origen, codigo ML..." style={{marginBottom:12,fontSize:12}}/>
          <div style={{maxHeight:500,overflowY:"auto"}}>
            <table className="tbl" style={{width:"100%"}}>
              <thead>
                <tr>
                  <th>SKU Venta</th>
                  <th>Codigo ML</th>
                  <th>Componentes (SKU Origen × Unidades)</th>
                </tr>
              </thead>
              <tbody>
                {filteredComposicion.slice(0, 200).map(sv => (
                  <tr key={sv.skuVenta}>
                    <td className="mono" style={{fontWeight:700,fontSize:11}}>{sv.skuVenta}</td>
                    <td className="mono" style={{fontSize:10,color:"var(--txt3)"}}>{sv.codigoMl||"—"}</td>
                    <td style={{fontSize:11}}>
                      {sv.componentes.map((c, i) => (
                        <span key={i}>
                          {i > 0 && <span style={{color:"var(--txt3)"}}> + </span>}
                          <span className="mono" style={{color:"var(--cyan)"}}>{c.skuOrigen}</span>
                          <span style={{color:"var(--amber)"}}> ×{c.unidades}</span>
                        </span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filteredComposicion.length > 200 && <div style={{padding:8,textAlign:"center",fontSize:11,color:"var(--txt3)"}}>Mostrando 200 de {filteredComposicion.length}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

export default DiccionarioConfig;
