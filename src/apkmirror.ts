// APKMirror scraper — runs inside Cloudflare Workers.
// CF Workers egress from geographically distributed PoPs, giving natural
// IP variation. We additionally enforce a per-origin cooldown via KV so
// we never burst-request (avoids CF 1015 / 1020 bans).

const BASE = "https://www.apkmirror.com";
const MIN_GAP_MS = 2000; // minimum ms between requests to apkmirror

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// --- rate-limit gate ---------------------------------------------------

async function waitForSlot(kv: KVNamespace): Promise<void> {
  const key = "last_req_ts";
  const raw = await kv.get(key);
  if (raw) {
    const elapsed = Date.now() - parseInt(raw, 10);
    if (elapsed < MIN_GAP_MS) {
      await sleep(MIN_GAP_MS - elapsed);
    }
  }
  await kv.put(key, String(Date.now()), { expirationTtl: 60 });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- fetch helper -------------------------------------------------------

async function apkFetch(
  kv: KVNamespace,
  url: string,
  cfClearance?: string
): Promise<string> {
  await waitForSlot(kv);

  const headers: Record<string, string> = {
    "User-Agent": UA,
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
    Referer: BASE + "/",
    "Cache-Control": "no-cache",
  };

  if (cfClearance) {
    headers["Cookie"] = `cf_clearance=${cfClearance}`;
  }

  const res = await fetch(url, {
    headers,
    // Ask CF to route from a random PoP (IP diversity)
    cf: { cacheTtl: 0, cacheEverything: false },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  return res.text();
}

// --- search -------------------------------------------------------------

export interface AppResult {
  name: string;
  developer: string;
  url: string;
}

export async function searchApps(
  kv: KVNamespace,
  query: string,
  cfClearance?: string
): Promise<AppResult[]> {
  const url = `${BASE}/?post_type=app_release&searchtype=app&s=${encodeURIComponent(query)}`;
  const html = await apkFetch(kv, url, cfClearance);

  const results: AppResult[] = [];
  // Each result lives in a .appRow widget
  const rowRe =
    /<div class="[^"]*appRow[^"]*"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/g;
  const nameRe = /class="fontBlack"[^>]*>([^<]+)<\/a>/;
  const devRe = /class="byDeveloper"[^>]*>by\s+<a[^>]+>([^<]+)<\/a>/;
  const hrefRe = /class="fontBlack"\s+href="([^"]+)"/;

  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(html)) !== null && results.length < 8) {
    const chunk = m[0];
    const name = nameRe.exec(chunk)?.[1]?.trim();
    const dev = devRe.exec(chunk)?.[1]?.trim();
    const href = hrefRe.exec(chunk)?.[1];
    if (name && href) {
      results.push({
        name,
        developer: dev ?? "Unknown",
        url: BASE + href,
      });
    }
  }
  return results;
}

// --- variants -----------------------------------------------------------

export interface Variant {
  version: string;
  arch: string;
  minAndroid: string;
  dpi: string;
  downloadPageUrl: string;
}

export async function getVariants(
  kv: KVNamespace,
  appUrl: string,
  cfClearance?: string
): Promise<Variant[]> {
  const html = await apkFetch(kv, appUrl, cfClearance);

  const variants: Variant[] = [];
  // variant rows: <div class="table-row headerFont">
  const rowRe =
    /<div class="table-row headerFont"[\s\S]*?(?=<div class="table-row headerFont"|<\/div>\s*<\/div>\s*<\/div>)/g;
  const cellRe = /<span[^>]*>([^<]*)<\/span>/g;
  const hrefRe = /href="(\/apk\/[^"]+\/download\/)"/;

  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(html)) !== null && variants.length < 10) {
    const chunk = m[0];
    const cells: string[] = [];
    let c: RegExpExecArray | null;
    while ((c = cellRe.exec(chunk)) !== null) cells.push(c[1].trim());
    const href = hrefRe.exec(chunk)?.[1];
    if (cells.length >= 4 && href) {
      variants.push({
        version: cells[0] ?? "",
        arch: cells[1] ?? "",
        minAndroid: cells[2] ?? "",
        dpi: cells[3] ?? "",
        downloadPageUrl: BASE + href,
      });
    }
  }
  return variants;
}

// --- resolve download URL -----------------------------------------------

export async function resolveDownload(
  kv: KVNamespace,
  downloadPageUrl: string,
  cfClearance?: string
): Promise<string | null> {
  const html = await apkFetch(kv, downloadPageUrl, cfClearance);
  // The real download link is in a <a> with id="download-link" or class="downloadButton"
  const re = /id="download-link"[^>]*href="([^"]+)"/;
  const m = re.exec(html);
  if (m) return m[1].startsWith("http") ? m[1] : BASE + m[1];

  const re2 = /class="[^"]*downloadButton[^"]*"[^>]*href="([^"]+)"/;
  const m2 = re2.exec(html);
  if (m2) return m2[1].startsWith("http") ? m2[1] : BASE + m2[1];

  return null;
}
