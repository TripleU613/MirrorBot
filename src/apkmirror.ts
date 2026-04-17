import { generateFingerprint, buildHeaders } from "./fingerprint";
import { getProxy, markProxyFailed, markProxyOk, fetchViaProxy } from "./proxy-pool";

const BASE = "https://www.apkmirror.com";
const MIN_GAP_MS = 1500;
const MAX_RETRIES = 4; // try up to 4 different proxies

// --- rate-limit gate (KV-backed) ----------------------------------------

async function waitForSlot(kv: KVNamespace): Promise<void> {
  const raw = await kv.get("last_req_ts");
  if (raw) {
    const elapsed = Date.now() - parseInt(raw, 10);
    const jitter = Math.random() * 500; // 0–500ms jitter
    if (elapsed < MIN_GAP_MS + jitter) {
      await sleep(MIN_GAP_MS + jitter - elapsed);
    }
  }
  await kv.put("last_req_ts", String(Date.now()), { expirationTtl: 60 });
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// --- core fetch: new IP + fingerprint every call ------------------------

export async function anonFetch(kv: KVNamespace, url: string): Promise<string> {
  await waitForSlot(kv);

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const fp = generateFingerprint();
    const headers = buildHeaders(fp, attempt > 0 ? BASE + "/" : undefined);

    const proxy = await getProxy(kv);

    if (!proxy) {
      // No proxies available — fall back to direct fetch (still with rotated fingerprint)
      const res = await fetch(url, {
        headers,
        cf: { cacheTtl: 0, cacheEverything: false },
      });
      if (!res.ok) throw new Error(`Direct fetch HTTP ${res.status}`);
      return res.text();
    }

    try {
      const result = await fetchViaProxy(proxy, url, headers);

      if (result.status === 403 || result.status === 429) {
        // CF-blocked — this proxy is flagged, kill it
        await markProxyFailed(kv, proxy);
        continue;
      }

      if (!result.ok) {
        await markProxyFailed(kv, proxy);
        continue;
      }

      await markProxyOk(kv, proxy);
      return result.body;
    } catch {
      await markProxyFailed(kv, proxy);
      // try next proxy
    }
  }

  throw new Error("All proxy attempts failed for " + url);
}

// --- search -------------------------------------------------------------

export interface AppResult {
  name: string;
  developer: string;
  url: string;
}

export async function searchApps(kv: KVNamespace, query: string): Promise<AppResult[]> {
  const url = `${BASE}/?post_type=app_release&searchtype=app&s=${encodeURIComponent(query)}`;
  const html = await anonFetch(kv, url);

  const results: AppResult[] = [];
  const rowRe = /<div class="[^"]*appRow[^"]*"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/g;
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
      results.push({ name, developer: dev ?? "Unknown", url: BASE + href });
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

export async function getVariants(kv: KVNamespace, appUrl: string): Promise<Variant[]> {
  const html = await anonFetch(kv, appUrl);

  const variants: Variant[] = [];
  const rowRe = /<div class="table-row headerFont"[\s\S]*?(?=<div class="table-row headerFont"|<\/div>\s*<\/div>\s*<\/div>)/g;
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

export async function resolveDownload(kv: KVNamespace, downloadPageUrl: string): Promise<string | null> {
  const html = await anonFetch(kv, downloadPageUrl);

  const re = /id="download-link"[^>]*href="([^"]+)"/;
  const m = re.exec(html);
  if (m) return m[1].startsWith("http") ? m[1] : BASE + m[1];

  const re2 = /class="[^"]*downloadButton[^"]*"[^>]*href="([^"]+)"/;
  const m2 = re2.exec(html);
  if (m2) return m2[1].startsWith("http") ? m2[1] : BASE + m2[1];

  return null;
}
