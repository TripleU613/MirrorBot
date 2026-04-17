import { connect } from "cloudflare:sockets";

export interface Proxy {
  host: string;
  port: number;
  failures: number;
  lastSeen: number;
}

const POOL_KEY = "proxy_pool_v2";
const MAX_FAILURES = 3;
const POOL_MIN = 10;
const CONNECT_TIMEOUT_MS = 8000;

const PROXY_SOURCES = [
  "https://api.proxyscrape.com/v3/free-proxy-list/get?request=displayproxies&protocol=http&timeout=5000&country=all&ssl=all&anonymity=elite,anonymous",
  "https://api.proxyscrape.com/v3/free-proxy-list/get?request=displayproxies&protocol=http&timeout=3000&country=US,GB,DE,NL,FR&anonymity=elite",
  "https://proxylist.geonode.com/api/proxy-list?limit=100&page=1&sort_by=lastChecked&sort_type=desc&protocols=http",
];

function timeout<T>(ms: number, label: string): Promise<T> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms)
  );
}

// --- Pool KV helpers ----------------------------------------------------

async function loadPool(kv: KVNamespace): Promise<Proxy[]> {
  try {
    const raw = await kv.get(POOL_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as Proxy[];
  } catch {
    return [];
  }
}

async function savePool(kv: KVNamespace, pool: Proxy[]): Promise<void> {
  try {
    await kv.put(POOL_KEY, JSON.stringify(pool), { expirationTtl: 3600 });
  } catch (e) {
    console.warn("proxy-pool: failed to save pool to KV:", e);
  }
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// --- Fetch fresh proxies ------------------------------------------------

async function fetchProxies(): Promise<Proxy[]> {
  const proxies: Proxy[] = [];
  let anySourceSucceeded = false;

  for (const src of PROXY_SOURCES) {
    try {
      const res = await Promise.race([
        fetch(src, { cf: { cacheTtl: 0 } }),
        timeout<Response>(10000, src),
      ]);
      const text = await (res as Response).text();

      // proxyscrape format: ip:port per line
      for (const line of text.split(/\r?\n/)) {
        const m = line.trim().match(/^(\d+\.\d+\.\d+\.\d+):(\d+)$/);
        if (m) {
          proxies.push({ host: m[1], port: parseInt(m[2], 10), failures: 0, lastSeen: Date.now() });
          anySourceSucceeded = true;
        }
      }

      // geonode format: JSON { data: [{ ip, port }] }
      try {
        const json = JSON.parse(text);
        if (Array.isArray(json?.data)) {
          for (const entry of json.data) {
            if (entry.ip && entry.port) {
              proxies.push({ host: entry.ip, port: parseInt(entry.port, 10), failures: 0, lastSeen: Date.now() });
              anySourceSucceeded = true;
            }
          }
        }
      } catch { /* not JSON, that's fine */ }
    } catch (e) {
      console.warn(`proxy-pool: source failed (${src}):`, e);
    }
  }

  if (!anySourceSucceeded) {
    console.warn("proxy-pool: ALL proxy sources failed — pool will be empty");
  }

  // Deduplicate
  const seen = new Set<string>();
  const deduped = proxies.filter(p => {
    const k = `${p.host}:${p.port}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return shuffle(deduped);
}

// --- Pick proxy ---------------------------------------------------------

export async function getProxy(kv: KVNamespace): Promise<Proxy | null> {
  let pool = await loadPool(kv);
  pool = pool.filter(p => p.failures < MAX_FAILURES);

  if (pool.length < POOL_MIN) {
    const fresh = await fetchProxies();
    const map = new Map(pool.map(p => [`${p.host}:${p.port}`, p]));
    for (const fp of fresh) {
      const key = `${fp.host}:${fp.port}`;
      if (!map.has(key)) map.set(key, fp);
    }
    pool = shuffle(Array.from(map.values()));
    await savePool(kv, pool);
  }

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

// --- Fetch via HTTP CONNECT proxy (TCP + optional TLS) ------------------

export async function fetchViaProxy(
  proxy: Proxy,
  url: string,
  headers: Record<string, string>
): Promise<{ ok: boolean; status: number; body: string }> {
  const parsed = new URL(url);
  const host = parsed.hostname;
  const port = parsed.port ? parseInt(parsed.port) : (parsed.protocol === "https:" ? 443 : 80);
  const isHttps = parsed.protocol === "https:";

  let socket = await Promise.race([
    connect({ hostname: proxy.host, port: proxy.port }, { secureTransport: "off" }),
    timeout<never>(CONNECT_TIMEOUT_MS, `connect ${proxy.host}:${proxy.port}`),
  ]);

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  try {
    if (isHttps) {
      // Send HTTP CONNECT to establish tunnel
      const writer = socket.writable.getWriter();
      const reader = socket.readable.getReader();

      try {
        const connectReq = `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\nProxy-Connection: keep-alive\r\n\r\n`;
        await Promise.race([
          writer.write(enc.encode(connectReq)),
          timeout<never>(CONNECT_TIMEOUT_MS, "CONNECT write"),
        ]);

        // Read proxy response
        let connectResp = "";
        while (!connectResp.includes("\r\n\r\n")) {
          const { value, done } = await Promise.race([
            reader.read(),
            timeout<never>(CONNECT_TIMEOUT_MS, "CONNECT read"),
          ]);
          if (done) break;
          connectResp += dec.decode(value);
        }

        if (!connectResp.match(/^HTTP\/1\.[01] 2\d\d/)) {
          throw new Error(`CONNECT rejected: ${connectResp.split("\r\n")[0]}`);
        }
      } finally {
        writer.releaseLock();
        reader.releaseLock();
      }

      // Upgrade to TLS
      socket = socket.startTls({ expectedServerHostname: host });
    }

    // Send HTTP request
    const writer2 = socket.writable.getWriter();
    const reader2 = socket.readable.getReader();

    try {
      const path = parsed.pathname + (parsed.search || "");
      const headerLines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\r\n");
      const httpReq =
        `GET ${isHttps ? path : url} HTTP/1.1\r\n` +
        `Host: ${host}\r\n` +
        `Connection: close\r\n` +
        `${headerLines}\r\n\r\n`;

      await Promise.race([
        writer2.write(enc.encode(httpReq)),
        timeout<never>(CONNECT_TIMEOUT_MS, "HTTP write"),
      ]);

      // Read response
      let rawResp = "";
      while (!rawResp.includes("\r\n\r\n")) {
        const { value, done } = await Promise.race([
          reader2.read(),
          timeout<never>(CONNECT_TIMEOUT_MS, "HTTP headers read"),
        ]);
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

      // Read body
      while (true) {
        const { value, done } = await Promise.race([
          reader2.read(),
          timeout<never>(15000, "HTTP body read"),
        ]);
        if (done) break;
        body += dec.decode(value);
        if (contentLength !== undefined && enc.encode(body).byteLength >= contentLength) break;
      }

      return { ok: status >= 200 && status < 400, status, body };
    } finally {
      writer2.releaseLock();
      reader2.releaseLock();
    }
  } finally {
    try { await socket.close(); } catch { /* ignore */ }
  }
}
