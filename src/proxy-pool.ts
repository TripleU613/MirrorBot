import { connect } from "cloudflare:sockets";

export interface Proxy {
  host: string;
  port: number;
  failures: number;
  lastVerified: number; // timestamp of last successful APKMirror test
}

const POOL_KEY = "proxy_pool_v3";
const VERIFIED_KEY = "proxy_verified_v3";
const MAX_FAILURES = 2;
const CONNECT_TIMEOUT_MS = 6000;
const TEST_URL = "https://www.apkmirror.com/";

// --- KV helpers ---------------------------------------------------------

async function loadPool(kv: KVNamespace, key: string): Promise<Proxy[]> {
  try {
    const raw = await kv.get(key);
    if (!raw) return [];
    return JSON.parse(raw) as Proxy[];
  } catch { return []; }
}

async function savePool(kv: KVNamespace, key: string, pool: Proxy[], ttl = 3600): Promise<void> {
  try {
    await kv.put(key, JSON.stringify(pool), { expirationTtl: ttl });
  } catch (e) {
    console.warn("proxy-pool: KV save failed:", e);
  }
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function timeout<T>(ms: number, label: string): Promise<T> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout:${label}`)), ms));
}

// --- Fetch proxy list ---------------------------------------------------

const PROXY_SOURCES = [
  "https://api.proxyscrape.com/v3/free-proxy-list/get?request=displayproxies&protocol=http&timeout=3000&country=all&ssl=all&anonymity=elite,anonymous",
  "https://api.proxyscrape.com/v3/free-proxy-list/get?request=displayproxies&protocol=http&timeout=3000&anonymity=elite",
  "https://proxylist.geonode.com/api/proxy-list?limit=200&page=1&sort_by=lastChecked&sort_type=desc&protocols=http",
];

async function fetchCandidates(): Promise<Proxy[]> {
  const seen = new Set<string>();
  const proxies: Proxy[] = [];

  for (const src of PROXY_SOURCES) {
    try {
      const res = await Promise.race([
        fetch(src, { cf: { cacheTtl: 0 } }),
        timeout<Response>(12000, src),
      ]);
      const text = await (res as Response).text();

      // proxyscrape: ip:port per line
      for (const line of text.split(/\r?\n/)) {
        const m = line.trim().match(/^(\d+\.\d+\.\d+\.\d+):(\d+)$/);
        if (m) {
          const k = `${m[1]}:${m[2]}`;
          if (!seen.has(k)) { seen.add(k); proxies.push({ host: m[1], port: parseInt(m[2], 10), failures: 0, lastVerified: 0 }); }
        }
      }

      // geonode: JSON { data: [{ip, port}] }
      try {
        const json = JSON.parse(text);
        if (Array.isArray(json?.data)) {
          for (const e of json.data) {
            const k = `${e.ip}:${e.port}`;
            if (e.ip && e.port && !seen.has(k)) {
              seen.add(k);
              proxies.push({ host: e.ip, port: parseInt(e.port, 10), failures: 0, lastVerified: 0 });
            }
          }
        }
      } catch { /* not JSON */ }
    } catch (e) {
      console.warn(`proxy-pool: source failed (${src}):`, e);
    }
  }

  return shuffle(proxies);
}

// --- Verify a single proxy against APKMirror ----------------------------
// Returns true only if the proxy returns real APKMirror HTML (not a CF challenge).

export async function verifyProxy(proxy: Proxy): Promise<boolean> {
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  let socket;
  try {
    socket = await Promise.race([
      connect({ hostname: proxy.host, port: proxy.port }, { secureTransport: "off" }),
      timeout<never>(CONNECT_TIMEOUT_MS, "connect"),
    ]);

    const writer = socket.writable.getWriter();
    const reader = socket.readable.getReader();

    // CONNECT tunnel to apkmirror:443
    const connectReq = `CONNECT www.apkmirror.com:443 HTTP/1.1\r\nHost: www.apkmirror.com:443\r\nProxy-Connection: keep-alive\r\n\r\n`;
    await Promise.race([writer.write(enc.encode(connectReq)), timeout<never>(CONNECT_TIMEOUT_MS, "write-connect")]);

    let resp = "";
    while (!resp.includes("\r\n\r\n")) {
      const { value, done } = await Promise.race([reader.read(), timeout<never>(CONNECT_TIMEOUT_MS, "read-connect")]);
      if (done) break;
      resp += dec.decode(value);
    }
    if (!resp.match(/HTTP\/1\.[01] 2\d\d/)) { writer.releaseLock(); reader.releaseLock(); return false; }
    writer.releaseLock();
    reader.releaseLock();

    // TLS upgrade
    const tlsSocket = socket.startTls({ expectedServerHostname: "www.apkmirror.com" });

    const w2 = tlsSocket.writable.getWriter();
    const r2 = tlsSocket.readable.getReader();

    const httpReq =
      `GET / HTTP/1.1\r\n` +
      `Host: www.apkmirror.com\r\n` +
      `User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.119 Safari/537.36\r\n` +
      `Accept: text/html,*/*;q=0.8\r\n` +
      `Accept-Language: en-US,en;q=0.9\r\n` +
      `Accept-Encoding: identity\r\n` +
      `Connection: close\r\n\r\n`;
    await Promise.race([w2.write(enc.encode(httpReq)), timeout<never>(CONNECT_TIMEOUT_MS, "write-http")]);

    let rawResp = "";
    while (!rawResp.includes("\r\n\r\n")) {
      const { value, done } = await Promise.race([r2.read(), timeout<never>(8000, "read-http-headers")]);
      if (done) break;
      rawResp += dec.decode(value);
    }

    const statusMatch = rawResp.match(/HTTP\/\d\.?\d?\s+(\d+)/);
    const status = statusMatch ? parseInt(statusMatch[1]) : 0;

    // Read enough body to check for CF challenge
    let body = rawResp.split("\r\n\r\n").slice(1).join("\r\n\r\n");
    for (let i = 0; i < 5 && body.length < 2000; i++) {
      const { value, done } = await Promise.race([r2.read(), timeout<never>(4000, "read-body")]);
      if (done) break;
      body += dec.decode(value);
    }

    w2.releaseLock();
    r2.releaseLock();

    // Good proxy: returns 200, no CF challenge page
    const hasChallenge = body.includes("Just a moment") || body.includes("cf-challenge") || body.includes("cf_clearance");
    return status === 200 && !hasChallenge;
  } catch {
    return false;
  } finally {
    try { if (socket) await (socket as { close?: () => Promise<void> }).close?.(); } catch { /* ignore */ }
  }
}

// --- Background cron: find + verify working proxies --------------------
// Call this from the cron handler. Tests up to maxTest candidates, saves
// any that pass the APKMirror verification into the VERIFIED_KEY pool.

export async function refreshVerifiedPool(kv: KVNamespace, maxTest = 40): Promise<number> {
  const candidates = await fetchCandidates();
  const existing = await loadPool(kv, VERIFIED_KEY);
  const existingKeys = new Set(existing.map(p => `${p.host}:${p.port}`));

  const verified: Proxy[] = existing.filter(p =>
    p.failures < MAX_FAILURES && Date.now() - p.lastVerified < 30 * 60 * 1000
  );

  // Test new candidates concurrently (batches of 8)
  // Test exactly maxTest proxies concurrently — keeps the run within CF's time budget.
  const toTest = candidates.filter(p => !existingKeys.has(`${p.host}:${p.port}`)).slice(0, maxTest);
  const results = await Promise.allSettled(toTest.map(async (p) => {
    const ok = await verifyProxy(p);
    return { p, ok };
  }));
  for (const r of results) {
    if (r.status === "fulfilled" && r.value.ok) {
      verified.push({ ...r.value.p, lastVerified: Date.now() });
      console.log(`proxy-pool: verified working proxy ${r.value.p.host}:${r.value.p.port}`);
    }
  }

  await savePool(kv, VERIFIED_KEY, shuffle(verified), 1800);
  console.log(`proxy-pool: ${verified.length} verified proxies saved`);
  return verified.length;
}

// --- Get a verified proxy for use --------------------------------------

export async function getProxy(kv: KVNamespace): Promise<Proxy | null> {
  // Prefer verified pool
  const verified = await loadPool(kv, VERIFIED_KEY);
  const good = verified.filter(p => p.failures < MAX_FAILURES);
  if (good.length > 0) return good[Math.floor(Math.random() * good.length)];
  return null;
}

export async function markProxyFailed(kv: KVNamespace, proxy: Proxy): Promise<void> {
  for (const key of [VERIFIED_KEY, POOL_KEY]) {
    const pool = await loadPool(kv, key);
    const p = pool.find(x => x.host === proxy.host && x.port === proxy.port);
    if (p) { p.failures++; await savePool(kv, key, pool); }
  }
}

export async function markProxyOk(kv: KVNamespace, proxy: Proxy): Promise<void> {
  const pool = await loadPool(kv, VERIFIED_KEY);
  const p = pool.find(x => x.host === proxy.host && x.port === proxy.port);
  if (p) { p.failures = 0; p.lastVerified = Date.now(); await savePool(kv, VERIFIED_KEY, pool, 1800); }
}

// --- fetchViaProxy (unchanged) -----------------------------------------

export async function fetchViaProxy(
  proxy: Proxy,
  url: string,
  headers: Record<string, string>
): Promise<{ ok: boolean; status: number; body: string }> {
  const parsed = new URL(url);
  const host = parsed.hostname;
  const port = parsed.port ? parseInt(parsed.port) : (parsed.protocol === "https:" ? 443 : 80);
  const isHttps = parsed.protocol === "https:";
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  let socket = await Promise.race([
    connect({ hostname: proxy.host, port: proxy.port }, { secureTransport: "off" }),
    timeout<never>(CONNECT_TIMEOUT_MS, `connect ${proxy.host}:${proxy.port}`),
  ]);

  try {
    if (isHttps) {
      const writer = socket.writable.getWriter();
      const reader = socket.readable.getReader();
      try {
        await Promise.race([
          writer.write(enc.encode(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\nProxy-Connection: keep-alive\r\n\r\n`)),
          timeout<never>(CONNECT_TIMEOUT_MS, "CONNECT write"),
        ]);
        let connectResp = "";
        while (!connectResp.includes("\r\n\r\n")) {
          const { value, done } = await Promise.race([reader.read(), timeout<never>(CONNECT_TIMEOUT_MS, "CONNECT read")]);
          if (done) break;
          connectResp += dec.decode(value);
        }
        if (!connectResp.match(/HTTP\/1\.[01] 2\d\d/)) throw new Error(`CONNECT rejected: ${connectResp.split("\r\n")[0]}`);
      } finally {
        writer.releaseLock();
        reader.releaseLock();
      }
      socket = socket.startTls({ expectedServerHostname: host });
    }

    const w2 = socket.writable.getWriter();
    const r2 = socket.readable.getReader();
    try {
      const path = parsed.pathname + (parsed.search || "");
      const headerLines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\r\n");
      await Promise.race([
        w2.write(enc.encode(`GET ${isHttps ? path : url} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n${headerLines}\r\n\r\n`)),
        timeout<never>(CONNECT_TIMEOUT_MS, "HTTP write"),
      ]);

      let rawResp = "";
      while (!rawResp.includes("\r\n\r\n")) {
        const { value, done } = await Promise.race([r2.read(), timeout<never>(CONNECT_TIMEOUT_MS, "HTTP headers read")]);
        if (done) break;
        rawResp += dec.decode(value);
      }
      const headerEnd = rawResp.indexOf("\r\n\r\n");
      const rawHead = rawResp.slice(0, headerEnd);
      let body = rawResp.slice(headerEnd + 4);
      const statusMatch = rawHead.match(/HTTP\/\d\.?\d?\s+(\d+)/);
      const status = statusMatch ? parseInt(statusMatch[1]) : 0;
      const clMatch = rawHead.match(/content-length:\s*(\d+)/i);
      const contentLength = clMatch ? parseInt(clMatch[1]) : undefined;

      while (true) {
        const { value, done } = await Promise.race([r2.read(), timeout<never>(15000, "HTTP body read")]);
        if (done) break;
        body += dec.decode(value);
        if (contentLength !== undefined && enc.encode(body).byteLength >= contentLength) break;
      }
      return { ok: status >= 200 && status < 400, status, body };
    } finally {
      w2.releaseLock();
      r2.releaseLock();
    }
  } finally {
    try { await socket.close(); } catch { /* ignore */ }
  }
}
