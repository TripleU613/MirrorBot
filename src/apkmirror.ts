import { generateFingerprint, buildHeaders } from "./fingerprint";
import { getProxy, markProxyFailed, markProxyOk, fetchViaProxy } from "./proxy-pool";

const BASE = "https://www.apkmirror.com";
const MIN_GAP_MS = 1500;
const MAX_RETRIES = 4;

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

// --- CF challenge detection ---------------------------------------------

function isCfChallenge(html: string): boolean {
  return (
    html.includes("cf-challenge") ||
    html.includes("jschl-answer") ||
    html.includes("Just a moment") ||
    html.includes("cf_clearance") ||
    html.includes("Checking your browser")
  );
}

// --- core fetch ---------------------------------------------------------

async function directFetch(url: string): Promise<string> {
  const fp = generateFingerprint();
  const headers = buildHeaders(fp);
  const res = await fetch(url, { headers, cf: { cacheTtl: 0, cacheEverything: false } });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const html = await res.text();
  if (isCfChallenge(html)) throw new CfBlockedError(url);
  return html;
}

export async function anonFetch(kv: KVNamespace, url: string): Promise<string> {
  await waitForSlot(kv);

  let proxyAttempts = 0;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const fp = generateFingerprint();
    const headers = buildHeaders(fp, attempt > 0 ? BASE + "/" : undefined);
    const proxy = await getProxy(kv);

    if (!proxy) break; // no proxies available — skip to direct

    proxyAttempts++;

    try {
      const result = await fetchViaProxy(proxy, url, headers);

      if (result.status === 429) {
        await markProxyFailed(kv, proxy);
        await sleep(2000);
        continue;
      }

      if (result.status === 403 || !result.ok) {
        await markProxyFailed(kv, proxy);
        continue;
      }

      if (isCfChallenge(result.body)) {
        await markProxyFailed(kv, proxy);
        continue; // try another proxy, don't give up yet
      }

      await markProxyOk(kv, proxy);
      return result.body;
    } catch (e) {
      if (e instanceof CfBlockedError) { /* try another proxy */ }
      await markProxyFailed(kv, proxy);
    }
  }

  // All proxies failed or none available — fall back to direct CF egress.
  // CF Workers IPs are often trusted by CF-protected sites and this works
  // well when free proxy pool is exhausted.
  console.warn(`anonFetch: ${proxyAttempts} proxy attempts failed, falling back to direct fetch for ${url}`);
  return directFetch(url);
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

  if (!results.length) {
    // Distinguish: valid page with no results vs broken parsing
    const pageIsValid = html.includes("apkmirror") || html.includes("APKMirror");
    if (!pageIsValid) {
      console.warn("apkmirror: searchApps got unexpected HTML for query:", query);
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

  // Primary patterns
  const re1 = /id="download-link"[^>]*href="([^"]+)"/;
  const m1 = re1.exec(html);
  if (m1) return m1[1].startsWith("http") ? m1[1] : BASE + m1[1];

  const re2 = /class="[^"]*downloadButton[^"]*"[^>]*href="([^"]+)"/;
  const m2 = re2.exec(html);
  if (m2) return m2[1].startsWith("http") ? m2[1] : BASE + m2[1];

  // Fallback: any href with downloadVariant or /APK/ pattern
  const re3 = /href="([^"]*(?:downloadVariant|\/APK\/)[^"]*)"/i;
  const m3 = re3.exec(html);
  if (m3) return m3[1].startsWith("http") ? m3[1] : BASE + m3[1];

  console.warn("apkmirror: resolveDownload found no link at", downloadPageUrl);
  return null;
}
