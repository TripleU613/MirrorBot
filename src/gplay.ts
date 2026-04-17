// Google Play APK client — pure Cloudflare Workers TypeScript.
//
// How it works:
//   Search: parse play.google.com HTML → package IDs, then fetch
//           app detail pages in parallel for names (og:title). No auth.
//   Auth:   Aurora anonymous token stored in KV (seeded once via /seed-token).
//           Token lasts weeks–months. FDFE endpoints are accessible from CF Workers.
//   Download: Google Play delivery API (protobuf) → direct Google CDN URLs.

export type ProgressFn = (text: string) => Promise<void>;

export class GPlayError extends Error {
  constructor(msg: string) { super(msg); this.name = "GPlayError"; }
}

const AUTH_KV_KEY = "gplay_token_v2";
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.119 Safari/537.36";
const FINSKY_UA = "Android-Finsky/38.5.24-29 (api=3,versionCode=84052400,sdk=33,device=sunfish,hardware=sunfish,product=sunfish,platformVersionRelease=13,model=Pixel+4a,buildId=TQ3A.230901.001,isWideScreen=0,supportedAbis=arm64-v8a;armeabi-v7a;armeabi)";
const ANDROID_ID = "3ac3339d4c0cd207";

// ─── Token management ────────────────────────────────────────────────────────

interface StoredToken {
  arm64: string;
  armeabi: string;
  seededAt: number;
}

export async function getStoredToken(kv: KVNamespace, arch: "arm64" | "armeabi"): Promise<string | null> {
  try {
    const raw = await kv.get(AUTH_KV_KEY);
    if (!raw) return null;
    const t = JSON.parse(raw) as StoredToken;
    return arch === "arm64" ? t.arm64 : t.armeabi;
  } catch { return null; }
}

export async function seedToken(kv: KVNamespace, arm64: string, armeabi: string): Promise<void> {
  const t: StoredToken = { arm64, armeabi, seededAt: Date.now() };
  await kv.put(AUTH_KV_KEY, JSON.stringify(t), { expirationTtl: 60 * 24 * 3600 }); // 60 days
}

// ─── Search ──────────────────────────────────────────────────────────────────

export interface AppResult {
  name: string;
  developer: string;
  packageName: string;
  icon?: string;
}

export async function searchApps(
  kv: KVNamespace,
  query: string,
  onProgress?: ProgressFn
): Promise<AppResult[]> {
  await onProgress?.("searching Google Play…");

  // Step 1: get package IDs from search page
  const searchUrl = `https://play.google.com/store/search?q=${encodeURIComponent(query)}&c=apps&hl=en&gl=US`;
  const res = await fetch(searchUrl, {
    headers: { "User-Agent": BROWSER_UA, "Accept-Language": "en-US,en;q=0.9" },
    cf: { cacheTtl: 300 },
  });
  if (!res.ok) throw new GPlayError(`Play Store search HTTP ${res.status}`);
  const html = await res.text();

  // Extract unique package IDs from /store/apps/details?id=PKG links
  const pkgRe = /\/store\/apps\/details\?id=([a-zA-Z][a-zA-Z0-9_.]{4,})/g;
  const seen = new Set<string>();
  const packages: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = pkgRe.exec(html)) !== null) {
    const pkg = m[1];
    if (!seen.has(pkg) && !pkg.includes('&') && pkg.includes('.')) {
      seen.add(pkg);
      packages.push(pkg);
      if (packages.length >= 8) break;
    }
  }

  if (!packages.length) return [];

  // Step 2: fetch app names + developers in parallel via og:title
  await onProgress?.("fetching app details…");
  const results = await Promise.all(packages.map(pkg => fetchAppMeta(pkg)));
  return results.filter((r): r is AppResult => r !== null);
}

async function fetchAppMeta(packageName: string): Promise<AppResult | null> {
  try {
    const res = await fetch(
      `https://play.google.com/store/apps/details?id=${packageName}&hl=en`,
      {
        headers: { "User-Agent": BROWSER_UA, "Accept-Language": "en-US,en;q=0.9" },
        cf: { cacheTtl: 3600 },
      }
    );
    if (!res.ok) return null;
    const html = await res.text();

    const titleM = /property="og:title"\s+content="([^"]+)"/.exec(html) ??
      /content="([^"]+)"\s+property="og:title"/.exec(html);
    const authorM = /"author"[^}]*"name":\s*"([^"]+)"/.exec(html);
    const iconM = /property="og:image"\s+content="([^"]+)"/.exec(html) ??
      /content="([^"]+)"\s+property="og:image"/.exec(html);

    const rawTitle = titleM?.[1] ?? packageName;
    const name = rawTitle.replace(/ - Apps on Google Play$/, "").trim();
    const developer = authorM?.[1]?.trim() ?? "Unknown";
    const icon = iconM?.[1];

    return { name, developer, packageName, icon };
  } catch {
    return null;
  }
}

// ─── Minimal protobuf decoder ────────────────────────────────────────────────

function readVarint(buf: Uint8Array, pos: number): [bigint, number] {
  let result = 0n, shift = 0n;
  while (pos < buf.length) {
    const b = BigInt(buf[pos++]);
    result |= (b & 0x7fn) << shift;
    shift += 7n;
    if (!(b & 0x80n)) break;
  }
  return [result, pos];
}

function decodeProto(buf: Uint8Array): Map<number, unknown[]> {
  const fields = new Map<number, unknown[]>();
  let pos = 0;
  while (pos < buf.length) {
    let tag: bigint;
    [tag, pos] = readVarint(buf, pos);
    const fieldNum = Number(tag >> 3n);
    const wireType = Number(tag & 7n);
    const push = (v: unknown) => {
      if (!fields.has(fieldNum)) fields.set(fieldNum, []);
      fields.get(fieldNum)!.push(v);
    };
    if (wireType === 0) { let v: bigint; [v, pos] = readVarint(buf, pos); push(v); }
    else if (wireType === 2) { let len: bigint; [len, pos] = readVarint(buf, pos); const end = pos + Number(len); push(buf.slice(pos, end)); pos = end; }
    else if (wireType === 5) { pos += 4; }
    else if (wireType === 1) { pos += 8; }
    else break;
  }
  return fields;
}

const dec = new TextDecoder();
function str(fields: Map<number, unknown[]>, f: number): string {
  const v = fields.get(f)?.[0]; return v instanceof Uint8Array ? dec.decode(v) : "";
}
function bytes(fields: Map<number, unknown[]>, f: number): Uint8Array | null {
  const v = fields.get(f)?.[0]; return v instanceof Uint8Array ? v : null;
}
function allBytes(fields: Map<number, unknown[]>, f: number): Uint8Array[] {
  return (fields.get(f) ?? []).filter((v): v is Uint8Array => v instanceof Uint8Array);
}

// ─── Download variants ───────────────────────────────────────────────────────

export interface Variant {
  arch: string;
  packageName: string;
  label: string;
  downloadUrl: string;
  size?: number;
  version?: string;
  isSplit: boolean;
  splits?: SplitFile[];
}

export interface SplitFile { name: string; url: string; size?: number; }

export async function getVariants(
  kv: KVNamespace,
  packageName: string,
  onProgress?: ProgressFn
): Promise<Variant[]> {
  const token64 = await getStoredToken(kv, "arm64");
  const token32 = await getStoredToken(kv, "armeabi");

  if (!token64 && !token32) {
    throw new GPlayError("No auth token. Run /seed-token to set one up.");
  }

  await onProgress?.("fetching download info…");

  const tasks: Promise<Variant | null>[] = [];
  if (token64) tasks.push(fetchDelivery(packageName, token64, "arm64"));
  if (token32) tasks.push(fetchDelivery(packageName, token32, "armeabi"));

  const results = await Promise.allSettled(tasks);
  return results
    .filter((r): r is PromiseFulfilledResult<Variant | null> => r.status === "fulfilled")
    .map(r => r.value)
    .filter((v): v is Variant => v !== null);
}

async function fetchDelivery(
  packageName: string,
  token: string,
  arch: "arm64" | "armeabi"
): Promise<Variant | null> {
  const enc = new TextEncoder();
  const docIdBytes = enc.encode(packageName);

  // Build minimal delivery protobuf request
  const req: number[] = [
    0x0a, docIdBytes.length, ...docIdBytes,  // field 1: docId
    0x18, 0x00,                               // field 3: versionCode=0 (latest)
    0x28, 0x01,                               // field 5: installSource=1
  ];

  const res = await fetch("https://android.clients.google.com/fdfe/delivery", {
    method: "POST",
    headers: {
      "Authorization": `GoogleLogin auth=${token}`,
      "User-Agent": FINSKY_UA,
      "X-DFE-Device-Id": ANDROID_ID,
      "X-DFE-Client-Id": "am-android-google",
      "X-DFE-MCCMNC": "310260",
      "X-DFE-Network-Type": "4",
      "X-DFE-Content-Filters": "",
      "X-DFE-Request-Params": "timeoutMs=4000",
      "Accept-Language": "en-US",
      "Content-Type": "application/x-protobuf",
    },
    body: new Uint8Array(req),
    cf: { cacheTtl: 0 },
  });

  if (res.status === 401) throw new GPlayError("Token expired — re-run /seed-token");
  if (!res.ok) throw new GPlayError(`Delivery API HTTP ${res.status}`);

  const buf = new Uint8Array(await res.arrayBuffer());
  return parseDeliveryResponse(buf, packageName, arch);
}

function parseDeliveryResponse(
  buf: Uint8Array, packageName: string, arch: "arm64" | "armeabi"
): Variant | null {
  const top = decodeProto(buf);
  const deliveryBytes = bytes(top, 2) ?? bytes(top, 1);
  if (!deliveryBytes) return null;
  const delivery = decodeProto(deliveryBytes);
  const appDataBytes = bytes(delivery, 2) ?? bytes(delivery, 4);
  if (!appDataBytes) return null;
  const appData = decodeProto(appDataBytes);
  const downloadUrl = str(appData, 3);
  if (!downloadUrl) return null;

  const splitChunks = allBytes(appData, 15);
  const splits: SplitFile[] = splitChunks.map(chunk => {
    const f = decodeProto(chunk);
    return { name: str(f, 1) || "split", url: str(f, 5) || str(f, 3) };
  }).filter(s => s.url);

  const archLabel = arch === "arm64" ? "arm64 · modern phones" : "armv7 · older phones";

  return {
    arch: arch === "arm64" ? "arm64-v8a" : "armeabi-v7a",
    packageName,
    label: archLabel,
    downloadUrl,
    isSplit: splits.length > 0,
    splits: splits.length ? splits : undefined,
  };
}

// ─── resolveDownload — URL already in variant ────────────────────────────────

export async function resolveDownload(
  _kv: KVNamespace, downloadUrl: string
): Promise<string | null> {
  return downloadUrl || null;
}
