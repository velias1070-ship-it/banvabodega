import { NextRequest, NextResponse } from "next/server";

// Read env vars at runtime, NOT at module load
function getConfig() {
  const raw = process.env.GOOGLE_PRIVATE_KEY || "";
  return {
    sheetId: process.env.GOOGLE_SHEET_ID || "",
    saEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "",
    privateKey: raw.replace(/\\n/g, "\n"),
    sheetName: process.env.GOOGLE_SHEET_NAME || "Diccionario",
    costColumn: process.env.GOOGLE_COST_COLUMN || "N",
  };
}

function toBase64Url(str: string): string {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function getAccessToken(saEmail: string, privateKey: string): Promise<string> {
  const header = toBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const claim = toBase64Url(JSON.stringify({
    iss: saEmail,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));

  const keyData = privateKey
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");

  const binaryKey = Uint8Array.from(atob(keyData), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8", binaryKey, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
  );

  const encoder = new TextEncoder();
  const signInput = encoder.encode(`${header}.${claim}`);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, signInput);
  const sigBytes = new Uint8Array(signature);
  let sigStr = "";
  for (let i = 0; i < sigBytes.length; i++) sigStr += String.fromCharCode(sigBytes[i]);
  const sig = toBase64Url(sigStr);

  const jwt = `${header}.${claim}.${sig}`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    throw new Error(`Token error: ${JSON.stringify(tokenData)}`);
  }
  return tokenData.access_token;
}

// GET: diagnostic endpoint — visit /api/sheet/update-cost in browser to check config
export async function GET() {
  const cfg = getConfig();
  const diag: Record<string, unknown> = {
    sheet_id: cfg.sheetId ? `${cfg.sheetId.slice(0, 10)}...` : "NOT SET",
    sa_email: cfg.saEmail || "NOT SET",
    private_key: cfg.privateKey.includes("BEGIN PRIVATE KEY") ? `OK (${cfg.privateKey.length} chars)` : `NOT SET or malformed (got ${cfg.privateKey.length} chars, starts with: ${cfg.privateKey.slice(0, 30)}...)`,
    sheet_name: cfg.sheetName,
    cost_column: cfg.costColumn,
  };

  if (!cfg.sheetId || !cfg.saEmail || !cfg.privateKey.includes("BEGIN PRIVATE KEY")) {
    return NextResponse.json({ ...diag, status: "MISCONFIGURED" });
  }

  try {
    const token = await getAccessToken(cfg.saEmail, cfg.privateKey);
    diag.token = "OK";

    const sheetRef = cfg.sheetName.includes(" ") ? `'${cfg.sheetName}'` : cfg.sheetName;
    const readUrl = `https://sheets.googleapis.com/v4/spreadsheets/${cfg.sheetId}/values/${encodeURIComponent(`${sheetRef}!A1:N3`)}`;
    const readRes = await fetch(readUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const readData = await readRes.json();

    if (readData.error) {
      diag.sheet_read = "FAILED";
      diag.sheet_error = readData.error;
    } else {
      diag.sheet_read = "OK";
      diag.headers = readData.values?.[0] || [];
      diag.sample_rows = readData.values?.slice(1, 3) || [];
    }

    return NextResponse.json({ ...diag, status: "OK" });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ ...diag, status: "ERROR", error: message });
  }
}

// POST: update cost in sheet
// Body: { sku, nuevoCosto, filas?: { skuVenta: string, unidades: number }[] }
// filas contains all composicion_venta rows for this SKU origen so we can update each row:
//   row with unidades=1 → cost = nuevoCosto
//   row with unidades=2 → cost = nuevoCosto * 2
export async function POST(req: NextRequest) {
  const cfg = getConfig();
  try {
    const { sku, nuevoCosto, filas } = await req.json();
    if (!sku || nuevoCosto === undefined) {
      return NextResponse.json({ error: "sku and nuevoCosto required" }, { status: 400 });
    }

    if (!cfg.sheetId || !cfg.saEmail || !cfg.privateKey.includes("BEGIN PRIVATE KEY")) {
      return NextResponse.json({
        error: "Google Sheets not configured",
        debug: {
          sheet_id_set: !!cfg.sheetId,
          sa_email_set: !!cfg.saEmail,
          key_loaded: cfg.privateKey.includes("BEGIN PRIVATE KEY"),
          key_length: cfg.privateKey.length,
          key_preview: cfg.privateKey.slice(0, 40),
        },
        updated_db_only: true,
      }, { status: 200 });
    }

    const token = await getAccessToken(cfg.saEmail, cfg.privateKey);
    const sheetRef = cfg.sheetName.includes(" ") ? `'${cfg.sheetName}'` : cfg.sheetName;

    // Read columns A (SKU Venta), E (SKU Origen), and F (Unidades) to find all rows for this SKU
    const readUrl = `https://sheets.googleapis.com/v4/spreadsheets/${cfg.sheetId}/values/${encodeURIComponent(`${sheetRef}!A:F`)}`;
    const readRes = await fetch(readUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const readData = await readRes.json();

    if (readData.error) {
      return NextResponse.json({ error: "Sheet read failed", detail: readData.error, updated_db_only: true }, { status: 200 });
    }

    const values: string[][] = readData.values || [];

    // Find ALL rows matching this SKU origen (column E, index 4)
    const matchingRows: { rowIndex: number; skuVenta: string; unidades: number }[] = [];
    for (let i = 0; i < values.length; i++) {
      const row = values[i];
      if ((row[4] || "").toUpperCase() === sku.toUpperCase()) {
        const unidades = parseInt(row[5] || "1") || 1;
        matchingRows.push({ rowIndex: i, skuVenta: (row[0] || "").toUpperCase(), unidades });
      }
    }

    if (matchingRows.length === 0) {
      return NextResponse.json({
        error: `SKU ${sku} not found in sheet column E`,
        total_rows: values.length,
        sample_skus: values.slice(1, 6).map(r => r[4]),
        updated_db_only: true,
      }, { status: 200 });
    }

    // Update each matching row: cost = nuevoCosto * unidades
    const updates: { row: number; cell: string; cost: number; unidades: number; ok: boolean }[] = [];
    for (const match of matchingRows) {
      const costForRow = nuevoCosto * match.unidades;
      const cellRange = `${sheetRef}!${cfg.costColumn}${match.rowIndex + 1}`;
      const updateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${cfg.sheetId}/values/${encodeURIComponent(cellRange)}?valueInputOption=RAW`;
      const updateRes = await fetch(updateUrl, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ range: cellRange, values: [[costForRow]] }),
      });
      updates.push({
        row: match.rowIndex + 1,
        cell: cellRange,
        cost: costForRow,
        unidades: match.unidades,
        ok: updateRes.ok,
      });
    }

    return NextResponse.json({ ok: true, sku, nuevoCostoUnitario: nuevoCosto, rows_updated: updates });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message, updated_db_only: true }, { status: 500 });
  }
}
