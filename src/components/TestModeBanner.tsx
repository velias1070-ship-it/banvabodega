"use client";

import { isTestMode } from "@/lib/supabase";

export default function TestModeBanner() {
  if (!isTestMode()) return null;

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 99999,
        background: "linear-gradient(90deg, #f59e0b, #d97706)",
        color: "#000",
        textAlign: "center",
        padding: "6px 12px",
        fontSize: "13px",
        fontWeight: 700,
        fontFamily: "Outfit, sans-serif",
        letterSpacing: "0.5px",
        textTransform: "uppercase",
      }}
    >
      MODO TEST — Los datos no afectan produccion
    </div>
  );
}
