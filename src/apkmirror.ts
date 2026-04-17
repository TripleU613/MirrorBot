import { generateFingerprint, buildHeaders } from "./fingerprint";
import { getProxy, markProxyFailed, markProxyOk, fetchViaProxy } from "./proxy-pool";

const BASE = "https://www.apkmirror.com";
const MIN_GAP_MS = 1500;

export type ProgressFn = (text: string) => Promise<void>;

export interface BypassConfig {
  solver?: { fetch: (req: Request) => Promise<Response> }; // mirrorbot-solver service binding
  scraperApiKey?: string;  // scraperapi.com API key (fallback)
  fsUrl?: string;          // FlareSolverr via tunnel (fallback)
}

export class CfBlockedError extends Error {
  constructor(url: string) { super(`CF challenge on ${url}`); this.name = "CfBlockedError"; }
}

// --- rate-limit gate ----------------------------------------------------

async function waitForSlot(kv: KVNamespace): Promise<void> {
  try {
    const raw = await kv.get("last_req_ts");
    if (raw) {
      const elapsed = Date.now() - parseInt(raw, 10);
      const jitter = Math.random() * 500;
      if (elapsed < MIN_GAP_MS + jitter) await sleep(MIN_GAP_MS + jitter - elapsed);
    }
    await kv.put("last_req_ts", String(Date.now()), { expirationTtl: 60 });
  } catch (e) {
    console.warn("apkmirror: KV rate-limit gate failed:", e);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function isCfChallenge(html: string): boolean {
  return (
    html.includes("cf-challenge") ||
    html.includes("jschl-answer") ||
    html.includes("Just a moment") ||
    html.includes("cf_clearance") ||
    html.includes("Checking your browser")
  );
}

// --- Bypass methods -----------------------------------------------------

// FlareSolverr: real Chrome browser, solves any CF challenge
async function fetchViaFlareSolverr(fsUrl: string, url: string): Promise<string> {
  const res = await fetch(`${fsUrl}/v1`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cmd: "request.get", url, maxTimeout: 60000 }),
  });
  if (!res.ok) throw new Error(`FlareSolverr HTTP ${res.status}`);
  const data = await res.json() as { solution?: { response?: string; status?: number } };
  const html = data.solution?.response ?? "";
  if (!html) throw new Error("FlareSolverr returned empty response");
  if (isCfChallenge(html)) throw new CfBlockedError(url);
  return html;
}

// ScraperAPI: managed scraping service, handles CF bypass
async function fetchViaScraperApi(apiKey: string, url: string): Promise<string> {
  const apiUrl = `https://api.scraperapi.com/?api_key=${apiKey}&url=${encodeURIComponent(url)}&render=false`;
  const fp = generateFingerprint();
  const res = await fetch(apiUrl, {
    headers: { "User-Agent": fp.ua },
    cf: { cacheTtl: 0 },
  });
  if (!res.ok) throw new Error(`ScraperAPI HTTP ${res.status}`);
  const html = await res.text();
  if (isCfChallenge(html)) throw new CfBlockedError(url);
  return html;
}

// Direct fetch with browser fingerprint (fallback)
async function directFetch(url: string): Promise<string> {
  const fp = generateFingerprint();
  const headers = buildHeaders(fp);
  const res = await fetch(url, { headers, cf: { cacheTtl: 0, cacheEverything: false } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  if (isCfChallenge(html)) throw new CfBlockedError(url);
  return html;
}

// --- Core fetch: bypass-first strategy ----------------------------------
//
// Priority:
//   1. FlareSolverr (if FS_URL set) — real Chrome, 100% reliable
//   2. ScraperAPI  (if SCRAPER_API_KEY set) — managed bypass, very reliable
//   3. Proxy pool  (free HTTP proxies) — unreliable but free
//   4. Direct      (CF Workers fetch) — often blocked, last resort

export async function anonFetch(
  kv: KVNamespace,
  url: string,
  bypass: BypassConfig = {},
  onProgress?: ProgressFn
): Promise<string> {
  await waitForSlot(kv);

  // 1. Solver Worker (Cloudflare Browser Rendering — headless Chrome, always on)
  if (bypass.solver) {
    try {
      const res = await bypass.solver.fetch(
        new Request("https://solver/fetch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
        })
      );
      if (res.ok) {
        const { html } = await res.json() as { html: string };
        if (html && !isCfChallenge(html)) return html;
      }
    } catch (e) {
      console.warn("anonFetch: solver Worker failed:", e);
      await onProgress?.("retrying via backup route…");
    }
  }

  // 2. FlareSolverr
  if (bypass.fsUrl) {
    try {
      const html = await fetchViaFlareSolverr(bypass.fsUrl, url);
      return html;
    } catch (e) {
      console.warn("anonFetch: FlareSolverr failed:", e);
      await onProgress?.("retrying via backup route…");
    }
  }

  // 2. ScraperAPI
  if (bypass.scraperApiKey) {
    try {
      const html = await fetchViaScraperApi(bypass.scraperApiKey, url);
      return html;
    } catch (e) {
      console.warn("anonFetch: ScraperAPI failed:", e);
      await onProgress?.("routing around a block…");
    }
  }

  // 3. Direct fetch (fast, sometimes works CF→CF)
  try {
    return await directFetch(url);
  } catch (e) {
    const blocked = e instanceof CfBlockedError ||
      (e instanceof Error && /HTTP 403|HTTP 429/.test(e.message));
    if (!blocked) throw e;
    console.warn(`anonFetch: direct blocked, trying proxies`);
    await onProgress?.("routing around a block…");
  }

  // 4. Proxy fallback (max 2 attempts)
  for (let attempt = 0; attempt < 2; attempt++) {
    const fp = generateFingerprint();
    const headers = buildHeaders(fp, BASE + "/");
    const proxy = await getProxy(kv);
    if (!proxy) break;

    try {
      const result = await fetchViaProxy(proxy, url, headers);
      if (result.status === 403 || result.status === 429 || !result.ok) {
        await markProxyFailed(kv, proxy);
        if (attempt === 0) await onProgress?.("trying another route…");
        continue;
      }
      if (isCfChallenge(result.body)) {
        await markProxyFailed(kv, proxy);
        continue;
      }
      await markProxyOk(kv, proxy);
      return result.body;
    } catch {
      await markProxyFailed(kv, proxy);
    }
  }

  throw new CfBlockedError(url);
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
  bypass: BypassConfig = {},
  onProgress?: ProgressFn
): Promise<AppResult[]> {
  const url = `${BASE}/?post_type=app_release&searchtype=apk&bundles[]=apk_files&bundles[]=apkm_bundles&s=${encodeURIComponent(query)}`;
  const html = await anonFetch(kv, url, bypass, onProgress);

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

  if (!results.length && !html.includes("apkmirror") && !html.includes("APKMirror")) {
    console.warn("apkmirror: searchApps got unexpected HTML for query:", query);
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
  bypass: BypassConfig = {},
  onProgress?: ProgressFn
): Promise<Variant[]> {
  const html = await anonFetch(kv, appUrl, bypass, onProgress);

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

export async function resolveDownload(
  kv: KVNamespace,
  downloadPageUrl: string,
  bypass: BypassConfig = {},
  onProgress?: ProgressFn
): Promise<string | null> {
  const html = await anonFetch(kv, downloadPageUrl, bypass, onProgress);

  const re1 = /id="download-link"[^>]*href="([^"]+)"/;
  const m1 = re1.exec(html);
  if (m1) return m1[1].startsWith("http") ? m1[1] : BASE + m1[1];

  const re2 = /class="[^"]*downloadButton[^"]*"[^>]*href="([^"]+)"/;
  const m2 = re2.exec(html);
  if (m2) return m2[1].startsWith("http") ? m2[1] : BASE + m2[1];

  const re3 = /href="([^"]*(?:downloadVariant|\/APK\/)[^"]*)"/i;
  const m3 = re3.exec(html);
  if (m3) return m3[1].startsWith("http") ? m3[1] : BASE + m3[1];

  console.warn("apkmirror: resolveDownload found no link at", downloadPageUrl);
  return null;
}
