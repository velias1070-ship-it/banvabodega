"use client";
import Link from "next/link";

export default function Home() {
  return (
    <div className="app">
      <div className="role-select">
        <div style={{ textAlign: "center", marginBottom: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", color: "var(--cyan)", textTransform: "uppercase" as const, marginBottom: 6 }}>BANVA BODEGA</div>
          <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: "-0.03em" }}>Sistema de Inventario</div>
          <div style={{ fontSize: 13, color: "var(--txt2)", marginTop: 6 }}>Selecciona tu rol para comenzar</div>
        </div>
        <Link href="/operador" style={{ width: "100%" }}>
          <button className="role-btn">
            <span style={{ fontSize: 36 }}>📱</span>
            <div>
              <div style={{ fontWeight: 700 }}>Operador</div>
              <small style={{ color: "var(--txt3)", fontWeight: 400, fontSize: 12 }}>Escaneo, búsqueda, registro rápido</small>
            </div>
          </button>
        </Link>
        <Link href="/admin" style={{ width: "100%" }}>
          <button className="role-btn">
            <span style={{ fontSize: 36 }}>⚙️</span>
            <div>
              <div style={{ fontWeight: 700 }}>Administrador</div>
              <small style={{ color: "var(--txt3)", fontWeight: 400, fontSize: 12 }}>Dashboard, gestión de SKUs, reportes</small>
            </div>
          </button>
        </Link>
      </div>
    </div>
  );
}
