"use client";
import { useState, useEffect } from "react";
import { syncFromSheet, shouldSync, getLastSyncTime, getStore, getSkusVenta } from "@/lib/store";

interface SyncStatus {
  state: "idle" | "syncing" | "done" | "error";
  added: number;
  updated: number;
  total: number;
  skuVentaCount: number;
  lastSync: string | null;
}

export default function SheetSync({ onSynced }: { onSynced?: () => void }) {
  const [status, setStatus] = useState<SyncStatus>({ state: "idle", added: 0, updated: 0, total: 0, skuVentaCount: 0, lastSync: null });

  useEffect(() => {
    const skuVentaCount = getSkusVenta().length;
    setStatus(s => ({ ...s, lastSync: getLastSyncTime(), skuVentaCount }));
    if (shouldSync()) {
      doSync();
    }
  }, []);

  const doSync = async () => {
    setStatus(s => ({ ...s, state: "syncing" }));
    try {
      const result = await syncFromSheet();
      // Read counts AFTER sync completes (cache is now fresh)
      const skuVentaCount = getSkusVenta().length;
      setStatus({ state: "done", ...result, skuVentaCount, lastSync: getLastSyncTime() });
      if (onSynced) onSynced();
      setTimeout(() => setStatus(s => s.state === "done" ? { ...s, state: "idle" } : s), 4000);
    } catch {
      setStatus(s => ({ ...s, state: "error" }));
    }
  };

  return (
    <div style={{ padding: "8px 12px", background: "var(--bg2)", borderBottom: "1px solid var(--bg3)", display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: status.state === "syncing" ? "var(--amber)" : status.state === "error" ? "var(--red)" : "var(--green)", display: "inline-block", animation: status.state === "syncing" ? "pulse 1s infinite" : "none" }} />
        {status.state === "syncing" && <span style={{ color: "var(--amber)" }}>Sincronizando diccionario...</span>}
        {status.state === "done" && (
          <span style={{ color: "var(--green)" }}>
            Sincronizado — {status.total} SKU origen
            {status.added > 0 && <span> (+{status.added} nuevos)</span>}
            {status.updated > 0 && <span> ({status.updated} actualizados)</span>}
            {status.skuVentaCount > 0 && <span style={{ color: "var(--cyan)" }}> · {status.skuVentaCount} SKU venta</span>}
          </span>
        )}
        {status.state === "error" && <span style={{ color: "var(--red)" }}>Error de sincronización</span>}
        {status.state === "idle" && status.lastSync && (
          <span style={{ color: "var(--txt3)" }}>
            Diccionario: {status.lastSync}
            {status.skuVentaCount > 0 && <span> · {status.skuVentaCount} SKU venta</span>}
          </span>
        )}
        {status.state === "idle" && !status.lastSync && <span style={{ color: "var(--txt3)" }}>Diccionario: sin sincronizar</span>}
      </div>
      <button onClick={doSync} disabled={status.state === "syncing"}
        style={{ padding: "4px 12px", borderRadius: 6, background: "var(--bg3)", color: "var(--cyan)", fontSize: 10, fontWeight: 600, border: "1px solid var(--bg4)", whiteSpace: "nowrap" }}>
        {status.state === "syncing" ? "..." : "Sincronizar"}
      </button>
    </div>
  );
}
