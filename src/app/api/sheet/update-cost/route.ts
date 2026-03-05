import { NextRequest, NextResponse } from "next/server";

// Google Sheets API write-back for approved cost changes
// Requires env vars: GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY
// The sheet must be shared with the service account email

const SHEET_ID = process.env.GOOGLE_SHEET_ID || "";
const SA_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "";
const PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
const SHEET_NAME = process.env.GOOGLE_SHEET_NAME || "Diccionario";
const COST_COLUMN = process.env.GOOGLE_COST_COLUMN || "N"; // Column N = cost

async function getAccessToken(): Promise<string> {
  // Create JWT for Google service account
  const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const claim = btoa(JSON.stringify({
    iss: SA_EMAIL,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));

  // Sign with private key using Web Crypto API
  const encoder = new TextEncoder();
  const keyData = PRIVATE_KEY
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");

  const binaryKey = Uint8Array.from(atob(keyData), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8", binaryKey, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
  );

  const signInput = encoder.encode(`${header}.${claim}`);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, signInput);
  const sigBytes = new Uint8Array(signature);
  let sigStr = "";
  for (let i = 0; i < sigBytes.length; i++) sigStr += String.fromCharCode(sigBytes[i]);
  const sig = btoa(sigStr).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const jwt = `${header}.${claim}.${sig}`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const tokenData = await tokenRes.json();
  return tokenData.access_token;
}

export async function POST(req: NextRequest) {
  try {
    const { sku, nuevoCosto } = await req.json();
    if (!sku || nuevoCosto === undefined) {
      return NextResponse.json({ error: "sku and nuevoCosto required" }, { status: 400 });
    }

    if (!SHEET_ID || !SA_EMAIL || !PRIVATE_KEY) {
      return NextResponse.json({
        error: "Google Sheets not configured",
        detail: "Set GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY env vars",
        updated_db_only: true,
      }, { status: 200 }); // 200 because DB was already updated
    }

    const token = await getAccessToken();

    // First, find the row with this SKU (column E = SKU Origen, index 4)
    const readUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${SHEET_NAME}!E:E`;
    const readRes = await fetch(readUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const readData = await readRes.json();
    const values: string[][] = readData.values || [];

    const rowIndex = values.findIndex((row: string[]) => (row[0] || "").toUpperCase() === sku.toUpperCase());
    if (rowIndex === -1) {
      return NextResponse.json({ error: `SKU ${sku} not found in sheet`, updated_db_only: true }, { status: 200 });
    }

    // Update the cost cell (column N = row number)
    const cellRange = `${SHEET_NAME}!${COST_COLUMN}${rowIndex + 1}`;
    const updateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${cellRange}?valueInputOption=RAW`;
    const updateRes = await fetch(updateUrl, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ range: cellRange, values: [[nuevoCosto]] }),
    });

    if (!updateRes.ok) {
      const err = await updateRes.text();
      return NextResponse.json({ error: "Sheet update failed", detail: err, updated_db_only: true }, { status: 200 });
    }

    return NextResponse.json({ ok: true, row: rowIndex + 1, cell: cellRange });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
