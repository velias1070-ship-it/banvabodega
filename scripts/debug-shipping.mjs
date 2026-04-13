import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter(l => l && !l.startsWith("#") && l.includes("="))
    .map(l => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const SKU = process.argv[2] || "TXPMMF15PBOYG";

const { data: maps, error: mErr } = await sb
  .from("ml_items_map")
  .select("sku, item_id, user_product_id, variation_id")
  .eq("sku", SKU);

if (mErr) { console.error("ml_items_map error:", mErr); process.exit(1); }
console.log(`\n=== ml_items_map para ${SKU} ===`);
console.log(JSON.stringify(maps, null, 2));

if (!maps || maps.length === 0) {
  console.log("No hay mapeo. Salgo.");
  process.exit(0);
}

const { data: cfg } = await sb
  .from("ml_config")
  .select("seller_id, access_token, refresh_token, token_expires_at, client_id, client_secret")
  .eq("id", "main")
  .limit(1);

if (!cfg || cfg.length === 0) { console.error("Sin ml_config"); process.exit(1); }

let { access_token, refresh_token, token_expires_at, seller_id, client_id, client_secret } = cfg[0];

if (!token_expires_at || new Date(token_expires_at).getTime() < Date.now() + 60_000) {
  console.log("\n[token] refrescando...");
  const r = await fetch("https://api.mercadolibre.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id,
      client_secret,
      refresh_token,
    }),
  });
  const j = await r.json();
  if (!j.access_token) { console.error("refresh fail:", j); process.exit(1); }
  access_token = j.access_token;
  await sb.from("ml_config").update({
    access_token: j.access_token,
    refresh_token: j.refresh_token || refresh_token,
    token_expires_at: new Date(Date.now() + j.expires_in * 1000).toISOString(),
  }).eq("id", "main");
}

const authHeader = { Authorization: `Bearer ${access_token}` };

for (const m of maps) {
  console.log(`\n=========================================`);
  console.log(`item_id: ${m.item_id}`);
  console.log(`=========================================`);

  // 1) Info del item (precio, listing_type, free_shipping, category_id, dimensions, weight)
  const itemRes = await fetch(
    `https://api.mercadolibre.com/items/${m.item_id}?attributes=id,title,price,listing_type_id,category_id,shipping,status,seller_custom_field,attributes`,
    { headers: authHeader }
  );
  const item = await itemRes.json();
  console.log("\n--- /items/<id> (resumen) ---");
  console.log(JSON.stringify({
    id: item.id,
    title: item.title,
    price: item.price,
    listing_type_id: item.listing_type_id,
    category_id: item.category_id,
    status: item.status,
    shipping: item.shipping,
  }, null, 2));

  // 2) shipping_options/free (lo que usa el código actualmente)
  const freeRes = await fetch(
    `https://api.mercadolibre.com/users/${seller_id}/shipping_options/free?item_id=${m.item_id}`,
    { headers: authHeader }
  );
  const free = await freeRes.json();
  console.log("\n--- /users/{seller}/shipping_options/free ---");
  console.log(JSON.stringify(free, null, 2));

  // 3) shipping_options (alternativa: todas las opciones con cost y list_cost)
  const optRes = await fetch(
    `https://api.mercadolibre.com/items/${m.item_id}/shipping_options`,
    { headers: authHeader }
  );
  const opt = await optRes.json();
  console.log("\n--- /items/{id}/shipping_options ---");
  console.log(JSON.stringify(opt, null, 2));
}
