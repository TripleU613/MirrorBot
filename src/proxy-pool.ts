// Manages a rotating pool of HTTP proxies stored in KV.
// Sources: proxyscrape free list. Proxies are health-checked lazily
// (mark bad on connect failure, remove after 3 failures).

import { connect } from "cloudflare:sockets";

export interface Proxy {
  host: string;
  port: number;
  failures: number;
  lastSeen: number;
}

const POOL_KEY = "proxy_pool_v2";
const REFRESH_INTERVAL_MS = 15 * 60 * 1000; // 15 min
const MAX_FAILURES = 3;
const POOL_MIN = 10; // refresh when below this

const PROXY_SOURCES = [
  "https://api.proxyscrape.com/v3/free-proxy-list/get?request=displayproxies&protocol=http&timeout=5000&country=all&ssl=all&anonymity=elite,anonymous",
  "https://api.proxyscrape.com/v3/free-proxy-list/get?request=displayproxies&protocol=http&timeout=3000&country=US,GB,DE,NL,FR&anonymity=elite",
];

// --- Load / save pool from KV -------------------------------------------

async function loadPool(kv: KVNamespace): Promise<Proxy[]> {
  const raw = await kv.get(POOL_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw) as Proxy[]; } catch { return []; }
}

async function savePool(kv: KVNamespace, pool: Proxy[]): Promise<void> {
  await kv.put(POOL_KEY, JSON.stringify(pool), { expirationTtl: 3600 });
}

// --- Fetch fresh proxies from sources -----------------------------------

async function fetchProxies(): Promise<Proxy[]> {
  const proxies: Proxy[] = [];
  for (const src of PROXY_SOURCES) {
    try {
      const res = await fetch(src, { cf: { cacheTtl: 0 } });
      const text = await res.text();
      for (const line of text.split(/\r?\n/)) {
        const m = line.trim().match(/^(\d+\.\d+\.\d+\.\d+):(\d+)$/);
        if (m) {
          proxies.push({ host: m[1], port: parseInt(m[2], 10), failures: 0, lastSeen: Date.now() });
        }
      }
    } catch { /* source unavailable */ }
  }
  // Deduplicate
  const seen = new Set<string>();
  return proxies.filter(p => {
    const k = `${p.host}:${p.port}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// --- Pick a random healthy proxy ----------------------------------------

export async function getProxy(kv: KVNamespace): Promise<Proxy | null> {
  let pool = await loadPool(kv);

  // Prune dead proxies
  pool = pool.filter(p => p.failures < MAX_FAILURES);

  // Refresh if stale or too small
  if (pool.length < POOL_MIN) {
    const fresh = await fetchProxies();
    // Merge: keep failure counts for known proxies
    const map = new Map(pool.map(p => [`${p.host}:${p.port}`, p]));
    for (const fp of fresh) {
      const key = `${fp.host}:${fp.port}`;
      if (!map.has(key)) map.set(key, fp);
    }
    pool = Array.from(map.values());
    await savePool(kv, pool);
  }

  if (!pool.length) return null;
  // Pick random healthy proxy
  const healthy = pool.filter(p => p.failures < MAX_FAILURES);
  if (!healthy.length) return null;
  return healthy[Math.floor(Math.random() * healthy.length)];
}

export async function markProxyFailed(kv: KVNamespace, proxy: Proxy): Promise<void> {
  const pool = await loadPool(kv);
  const p = pool.find(x => x.host === proxy.host && x.port === proxy.port);
  if (p) { p.failures++; await savePool(kv, pool); }
}

export async function markProxyOk(kv: KVNamespace, proxy: Proxy): Promise<void> {
  const pool = await loadPool(kv);
  const p = pool.find(x => x.host === proxy.host && x.port === proxy.port);
  if (p) { p.failures = 0; p.lastSeen = Date.now(); await savePool(kv, pool); }
}

// --- Fetch via HTTP CONNECT proxy (TCP + TLS) ---------------------------

export async function fetchViaProxy(
  proxy: Proxy,
  url: string,
  headers: Record<string, string>
): Promise<{ ok: boolean; status: number; body: string }> {
  const parsed = new URL(url);
  const host = parsed.hostname;
  const port = parsed.port ? parseInt(parsed.port) : (parsed.protocol === "https:" ? 443 : 80);
  const isHttps = parsed.protocol === "https:";

  // Open TCP connection to proxy
  let socket = connect({ hostname: proxy.host, port: proxy.port }, { secureTransport: "off" });

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();

  // Helper: read until we see \r\n\r\n (end of HTTP headers)
  async function readHeaders(): Promise<string> {
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
      if (buf.includes("\r\n\r\n")) break;
    }
    return buf;
  }

  // Helper: read body of known length or until close
  async function readBody(contentLength?: number): Promise<string> {
    let buf = "";
    let received = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = dec.decode(value);
      buf += chunk;
      received += value?.byteLength ?? 0;
      if (contentLength !== undefined && received >= contentLength) break;
    }
    return buf;
  }

  if (isHttps) {
    // Send CONNECT to proxy
    const connectReq = `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\nProxy-Connection: keep-alive\r\n\r\n`;
    await writer.write(enc.encode(connectReq));

    // Read proxy CONNECT response
    const connectResp = await readHeaders();
    if (!connectResp.startsWith("HTTP/1.1 200") && !connectResp.startsWith("HTTP/1.0 200")) {
      throw new Error(`CONNECT failed: ${connectResp.split("\r\n")[0]}`);
    }

    // Release writer/reader before TLS upgrade
    writer.releaseLock();
    reader.releaseLock();

    // Upgrade to TLS
    socket = socket.startTls({ expectedServerHostname: host });
  }

  // Now send the actual HTTP request over the (possibly TLS) connection
  const w2 = socket.writable.getWriter();
  const r2 = socket.readable.getReader();
  const dec2 = new TextDecoder();

  const path = parsed.pathname + (parsed.search || "");
  const headerLines = Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\r\n");

  const httpReq =
    `GET ${isHttps ? path : url} HTTP/1.1\r\n` +
    `Host: ${host}\r\n` +
    `Connection: close\r\n` +
    `${headerLines}\r\n\r\n`;

  await w2.write(enc.encode(httpReq));

  // Read response headers
  let rawResp = "";
  while (true) {
    const { value, done } = await r2.read();
    if (done) break;
    rawResp += dec2.decode(value);
    if (rawResp.includes("\r\n\r\n")) break;
  }

  const [rawHead, ...bodyParts] = rawResp.split("\r\n\r\n");
  const statusMatch = rawHead.match(/HTTP\/\d\.?\d?\s+(\d+)/);
  const status = statusMatch ? parseInt(statusMatch[1]) : 0;
  const clMatch = rawHead.match(/content-length:\s*(\d+)/i);
  const contentLength = clMatch ? parseInt(clMatch[1]) : undefined;

  let body = bodyParts.join("\r\n\r\n");

  // Read remaining body
  while (true) {
    const { value, done } = await r2.read();
    if (done) break;
    body += dec2.decode(value);
    if (contentLength !== undefined && new TextEncoder().encode(body).byteLength >= contentLength) break;
  }

  w2.releaseLock();
  r2.releaseLock();

  return { ok: status >= 200 && status < 300, status, body };
}
