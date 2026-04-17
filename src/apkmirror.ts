import { generateFingerprint, buildHeaders } from "./fingerprint";
import { getProxy, markProxyFailed, markProxyOk, fetchViaProxy } from "./proxy-pool";

const BASE = "https://www.apkmirror.com";
const MIN_GAP_MS = 1500;
const MAX_RETRIES = 4;

export type ProgressFn = (text: string) => Promise<void>;

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
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  if (isCfChallenge(html)) throw new CfBlockedError(url);
  return html;
}

export async function anonFetch(
  kv: KVNamespace,
  url: string,
  onProgress?: ProgressFn
): Promise<string> {
  await waitForSlot(kv);

  let proxyAttempts = 0;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const fp = generateFingerprint();
    const headers = buildHeaders(fp, attempt > 0 ? BASE + "/" : undefined);
    const proxy = await getProxy(kv);

    if (!proxy) break; // no proxies — skip to direct

    proxyAttempts++;

    try {
      const result = await fetchViaProxy(proxy, url, headers);

      if (result.status === 429) {
        await markProxyFailed(kv, proxy);
        if (proxyAttempts === 1) await onProgress?.("routing around a block…");
        await sleep(2000);
        continue;
      }

      if (result.status === 403 || !result.ok) {
        await markProxyFailed(kv, proxy);
        if (proxyAttempts === 1) await onProgress?.("routing around a block…");
        continue;
      }

      if (isCfChallenge(result.body)) {
        await markProxyFailed(kv, proxy);
        if (proxyAttempts === 2) await onProgress?.("trying a different path…");
        continue;
      }

      await markProxyOk(kv, proxy);
      return result.body;
    } catch {
      await markProxyFailed(kv, proxy);
      if (proxyAttempts === 1) await onProgress?.("routing around a block…");
    }
  }

  // Fall back to direct CF egress
  if (proxyAttempts > 0) {
    await onProgress?.("connecting directly…");
    console.warn(`anonFetch: ${proxyAttempts} proxy attempts failed, falling back to direct`);
  }
  return directFetch(url);
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
  onProgress?: ProgressFn
): Promise<AppResult[]> {
  const url = `${BASE}/?post_type=app_release&searchtype=app&s=${encodeURIComponent(query)}`;
  const html = await anonFetch(kv, url, onProgress);

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
  onProgress?: ProgressFn
): Promise<Variant[]> {
  const html = await anonFetch(kv, appUrl, onProgress);

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
  onProgress?: ProgressFn
): Promise<string | null> {
  const html = await anonFetch(kv, downloadPageUrl, onProgress);

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
