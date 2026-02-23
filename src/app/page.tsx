"use client";
import Link from "next/link";
export default function Home() {
  return (
    <div className="app">
      <div className="role-select">
        <div style={{textAlign:"center",marginBottom:8}}>
          <div style={{fontSize:11,fontWeight:700,letterSpacing:"0.12em",color:"var(--cyan)",textTransform:"uppercase",marginBottom:6}}>BANVA WMS</div>
          <div style={{fontSize:28,fontWeight:800,letterSpacing:"-0.03em"}}>Bodega</div>
          <div style={{fontSize:13,color:"var(--txt2)",marginTop:6}}>Sistema de gestión de inventario</div>
        </div>
        <Link href="/operador" style={{width:"100%"}}><button className="role-btn">
          <span style={{fontSize:36}}>📱</span>
          <div style={{textAlign:"left"}}><div style={{fontWeight:700}}>Operador</div><small style={{color:"var(--txt3)",fontWeight:400,fontSize:12}}>Guardar, sacar, ver stock en vivo</small></div>
        </button></Link>
        <Link href="/admin" style={{width:"100%"}}><button className="role-btn">
          <span style={{fontSize:36}}>⚙️</span>
          <div style={{textAlign:"left"}}><div style={{fontWeight:700}}>Administrador</div><small style={{color:"var(--txt3)",fontWeight:400,fontSize:12}}>Inventario, movimientos, productos, posiciones</small></div>
        </button></Link>
      </div>
    </div>
  );
}
