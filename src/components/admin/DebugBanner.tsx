"use client";

// Sprint 8 Fase 2 (2026-05-05) — Banner de aviso para vistas internas
// que dejaron de ser canónicas pero se mantienen vivas como referencia
// post-mortem. Dismissable con localStorage por SKU de banner.

import { useEffect, useState } from "react";

type DebugBannerProps = {
  /** Identificador único del banner para persistir el dismiss en localStorage. */
  id: string;
  /** Mensaje a mostrar. */
  message: string;
};

const LS_PREFIX = "banva_debug_banner_dismissed_";

export default function DebugBanner({ id, message }: DebugBannerProps) {
  const [dismissed, setDismissed] = useState<boolean | null>(null);

  useEffect(() => {
    try {
      const v = window.localStorage.getItem(`${LS_PREFIX}${id}`);
      setDismissed(v === "1");
    } catch {
      setDismissed(false);
    }
  }, [id]);

  if (dismissed === null || dismissed) return null;

  function dismiss() {
    try {
      window.localStorage.setItem(`${LS_PREFIX}${id}`, "1");
    } catch {
      /* localStorage no disponible */
    }
    setDismissed(true);
  }

  return (
    <div
      role="status"
      style={{
        position: "sticky",
        top: 0,
        zIndex: 50,
        background: "rgba(245, 158, 11, 0.18)",
        border: "1px solid rgba(245, 158, 11, 0.45)",
        color: "#fde68a",
        padding: "10px 14px",
        borderRadius: 10,
        marginBottom: 12,
        display: "flex",
        gap: 12,
        alignItems: "center",
        fontSize: 13,
        lineHeight: 1.4,
      }}
    >
      <span style={{ flex: 1 }}>{message}</span>
      <button
        onClick={dismiss}
        style={{
          background: "transparent",
          border: "1px solid rgba(245, 158, 11, 0.45)",
          color: "#fde68a",
          padding: "4px 10px",
          borderRadius: 6,
          fontSize: 12,
          cursor: "pointer",
        }}
        title="Cerrar (no volver a mostrar)"
      >
        cerrar
      </button>
    </div>
  );
}
