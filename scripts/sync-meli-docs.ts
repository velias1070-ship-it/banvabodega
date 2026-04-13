/**
 * sync-meli-docs — descarga páginas de la documentación de MercadoLibre
 * Developers usando Playwright Chromium headless y las guarda como Markdown
 * en `docs/meli/`.
 *
 * El WAF de MeLi bloquea fetches HTTP planos (WebFetch/curl devuelven 403).
 * Playwright carga JS completo y simula navegador real, lo bypassea.
 *
 * Uso: npm run sync-meli-docs
 */

import { chromium, type Browser, type Page } from "playwright";
import TurndownService from "turndown";
import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, "..");
const DOCS_DIR = join(REPO_ROOT, "docs", "meli");

// ═══════════════════════════════════════════════════════════════════════════
// URLs a sincronizar. Agregá o saca libremente — el slug se deriva del path.
// ═══════════════════════════════════════════════════════════════════════════
const URLS: string[] = [
  // Product Ads
  "https://developers.mercadolibre.cl/es_ar/pads-read",
  "https://developers.mercadolibre.cl/es_ar/product-ads",
  // Orders
  "https://developers.mercadolibre.cl/es_ar/orders-management",
  "https://developers.mercadolibre.cl/es_ar/orders-and-feedback",
  // Items
  "https://developers.mercadolibre.cl/es_ar/items-and-searches",
  "https://developers.mercadolibre.cl/es_ar/items",
  // Shipments
  "https://developers.mercadolibre.cl/es_ar/shipments-management",
  "https://developers.mercadolibre.cl/es_ar/product-ads-management",
];

// Selectores candidatos para el contenido principal, en orden de preferencia.
const CONTENT_SELECTORS = [
  "main article",
  "article",
  "main",
  ".dox-content",
  ".documentation-content",
  "#content",
];

// Elementos ruidosos que removemos antes del turndown.
const NOISE_SELECTORS = ["script", "style", "nav", "footer", "header", "aside", ".sidebar"];

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

interface SyncResult {
  status: "ok" | "error";
  slug: string;
  file?: string;
  title?: string;
  chars?: number;
  error?: string;
}

function urlToSlug(url: string): string {
  const u = new URL(url);
  const path = u.pathname.replace(/^\/|\/$/g, "").replace(/\//g, "__");
  return path || "index";
}

async function extractContent(
  page: Page,
  url: string
): Promise<{ title: string; html: string; usedSelector: string }> {
  const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  if (!resp) throw new Error("no response");
  const status = resp.status();
  if (status >= 400) throw new Error(`HTTP ${status}`);

  // Give the SPA a moment to hydrate and populate main content
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {
    /* ok, seguimos igual */
  });

  for (const sel of CONTENT_SELECTORS) {
    const el = await page.$(sel);
    if (!el) continue;
    const html = await el.innerHTML();
    if (html && html.trim().length > 200) {
      const title = await page.title();
      return { title, html, usedSelector: sel };
    }
  }

  // Fallback: whole body (con ruido pero algo es algo)
  const bodyHtml = await page.$eval("body", (el) => el.innerHTML);
  const title = await page.title();
  return { title, html: bodyHtml, usedSelector: "body (fallback)" };
}

async function syncUrl(
  browser: Browser,
  url: string,
  turndown: TurndownService
): Promise<SyncResult> {
  const slug = urlToSlug(url);
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1280, height: 800 },
    locale: "es-CL",
  });
  const page = await context.newPage();

  try {
    const { title, html, usedSelector } = await extractContent(page, url);
    const markdown = turndown.turndown(html);
    const filePath = join(DOCS_DIR, `${slug}.md`);
    const frontmatter =
      `---\n` +
      `source_url: ${url}\n` +
      `title: ${JSON.stringify(title)}\n` +
      `selector: ${JSON.stringify(usedSelector)}\n` +
      `synced_at: ${new Date().toISOString()}\n` +
      `---\n\n`;

    await writeFile(filePath, frontmatter + markdown, "utf8");
    console.log(`  ✓ ${slug} (${markdown.length} chars, selector: ${usedSelector})`);
    return { status: "ok", slug, file: filePath, title, chars: markdown.length };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ✗ ${slug}: ${msg}`);
    return { status: "error", slug, error: msg };
  } finally {
    await context.close();
  }
}

async function main() {
  await mkdir(DOCS_DIR, { recursive: true });

  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "_",
  });
  turndown.remove(NOISE_SELECTORS as TurndownService.Filter);

  console.log(`Launching Chromium headless...`);
  const browser = await chromium.launch({ headless: true });

  const results: SyncResult[] = [];
  for (const url of URLS) {
    console.log(`→ ${url}`);
    results.push(await syncUrl(browser, url, turndown));
  }

  await browser.close();

  const ok = results.filter((r) => r.status === "ok").length;
  const errors = results.filter((r) => r.status === "error").length;
  const summary = {
    synced_at: new Date().toISOString(),
    total: URLS.length,
    ok,
    errors,
    results: Object.fromEntries(results.map((r) => [r.slug, r])),
  };
  await writeFile(
    join(DOCS_DIR, "_last_sync.json"),
    JSON.stringify(summary, null, 2),
    "utf8"
  );

  console.log(`\nDone: ${ok}/${URLS.length} OK, ${errors} errors.`);
  console.log(`Summary: docs/meli/_last_sync.json`);
  if (errors > 0 && ok === 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
