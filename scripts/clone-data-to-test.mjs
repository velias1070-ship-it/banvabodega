/**
 * Copia datos de Supabase PRODUCCION a Supabase TEST.
 * Descubre columnas de test y filtra las que no existen.
 *
 * Uso: node scripts/clone-data-to-test.mjs
 */

import { createClient } from "@supabase/supabase-js";

const PROD_URL = "https://qaircihuiafgnnrwcjls.supabase.co";
const PROD_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFhaXJjaWh1aWFmZ25ucndjamxzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIwNTM0MDIsImV4cCI6MjA4NzYyOTQwMn0.R3jT5azcoj1IPacCo0HJFVYlLrqbbM4PoihKQoz0FS8";

const TEST_URL = "https://gwkarhpgrkmwaznywetz.supabase.co";
const TEST_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd3a2FyaHBncmttd2F6bnl3ZXR6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI0OTMzNDcsImV4cCI6MjA4ODA2OTM0N30.-9ziB-pd11EvoPvNcsRpERZ4Npl6R3LE0zEtvjxNdUE";

const prod = createClient(PROD_URL, PROD_KEY);
const test = createClient(TEST_URL, TEST_KEY);

// Columnas generadas que no se pueden insertar
const SKIP_COLS = ["sku_venta_key"];

// Tablas en orden estricto (padres antes que hijos)
const TABLES = [
  "empresas",
  "operarios",
  "productos",
  "posiciones",
  "mapa_config",
  "stock",
  "recepciones",
  "recepcion_lineas",
  "composicion_venta",
  "picking_sessions",
  "conteos",
  "ml_config",
  "pedidos_flex",
  "ml_items_map",
  "stock_sync_queue",
  "plan_cuentas",
  "reglas_conciliacion",
  "cuentas_bancarias",
  "agent_config",
  "movimientos",
];

const CHUNK = 500;

async function fetchAll(client, table) {
  const rows = [];
  let from = 0;
  while (true) {
    const { data, error } = await client.from(table).select("*").range(from, from + 999);
    if (error) { console.error(`  Error leyendo ${table}: ${error.message}`); return []; }
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return rows;
}

async function getTestColumns(table) {
  const res = await fetch(`${TEST_URL}/rest/v1/${table}?select=*&limit=0`, {
    headers: {
      apikey: TEST_KEY,
      Authorization: `Bearer ${TEST_KEY}`,
      Accept: "application/vnd.pgrst.object+json",
      Prefer: "count=exact",
    },
  });
  // Parse columns from the response headers or content-type
  // Better approach: use the OpenAPI schema
  const schemaRes = await fetch(`${TEST_URL}/rest/v1/`, {
    headers: { apikey: TEST_KEY, Authorization: `Bearer ${TEST_KEY}` },
  });
  const schema = await schemaRes.json();
  if (schema.definitions && schema.definitions[table]) {
    return Object.keys(schema.definitions[table].properties || {});
  }
  return null;
}

function filterRows(rows, testCols) {
  return rows.map((row) => {
    const filtered = {};
    for (const [k, v] of Object.entries(row)) {
      if (SKIP_COLS.includes(k)) continue;
      if (testCols && !testCols.includes(k)) continue;
      filtered[k] = v;
    }
    return filtered;
  });
}

async function clearTable(client, table) {
  const strategies = [
    () => client.from(table).delete().neq("id", "__never__"),
    () => client.from(table).delete().neq("sku", "__never__"),
    () => client.from(table).delete().gte("created_at", "1970-01-01"),
  ];
  for (const strat of strategies) {
    const { error } = await strat();
    if (!error) return true;
  }
  return false;
}

async function main() {
  console.log("Descubriendo schema de test...");
  const schemaRes = await fetch(`${TEST_URL}/rest/v1/`, {
    headers: { apikey: TEST_KEY, Authorization: `Bearer ${TEST_KEY}` },
  });
  const schema = await schemaRes.json();
  const colsMap = {};
  if (schema.definitions) {
    for (const [table, def] of Object.entries(schema.definitions)) {
      colsMap[table] = Object.keys(def.properties || {});
    }
  }
  console.log(`  ${Object.keys(colsMap).length} tablas encontradas en test\n`);

  console.log("Clonando datos de PRODUCCION a TEST...\n");

  for (const table of TABLES) {
    const testCols = colsMap[table];
    if (!testCols) {
      console.log(`  ${table}: no existe en test (skip)`);
      continue;
    }

    process.stdout.write(`  ${table}: leyendo...`);
    const rows = await fetchAll(prod, table);

    if (rows.length === 0) {
      console.log(` 0 registros (skip)`);
      continue;
    }

    const filtered = filterRows(rows, testCols);

    process.stdout.write(` ${rows.length}. Limpiando...`);
    await clearTable(test, table);

    process.stdout.write(` Escribiendo...`);
    let written = 0;
    for (let i = 0; i < filtered.length; i += CHUNK) {
      const chunk = filtered.slice(i, i + CHUNK);
      const { error } = await test.from(table).insert(chunk);
      if (error) {
        console.error(`\n    Error ${table} chunk ${i}: ${error.message}`);
      } else {
        written += chunk.length;
      }
    }
    console.log(` ${written}/${rows.length} OK`);
  }

  console.log("\nListo. Tu modo test tiene los datos de produccion.");
}

main().catch(console.error);
