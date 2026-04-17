// Google Play APK client — pure Cloudflare Workers TypeScript.
// No Python, no Java, no external server.
//
// Flow:
//   1. Search: parse Google Play HTML search page (no auth needed)
//   2. Auth:   anonymous token from AuroraStore dispenser (JSON, cached in KV)
//   3. Download: Google Play delivery API (protobuf) → direct Google CDN URLs

export type ProgressFn = (text: string) => Promise<void>;

export class GPlayError extends Error {
  constructor(msg: string) { super(msg); this.name = "GPlayError"; }
}

// ─── Device profile (Pixel 4a, matches Aurora dispenser profiles) ────────────

const DEVICE = {
  userAgent: "Android-Finsky/38.5.24-29 (api=3,versionCode=84052400,sdk=33,device=sunfish,hardware=sunfish,product=sunfish,platformVersionRelease=13,model=Pixel+4a,buildId=TQ3A.230901.001,isWideScreen=0,supportedAbis=arm64-v8a;armeabi-v7a;armeabi)",
  androidId: "3ac3339d4c0cd207",
  mccmnc: "310260",
  locale: "en_US",
  timezone: "America/New_York",
  touchScreen: "3",
  keyboard: "1",
  navigation: "1",
  screenLayout: "2",
  hasHardKeyboard: "false",
  hasFiveWayNavigation: "false",
  screenDensity: "420",
  glVersion: "196610",
  glExtensions: "GL_OES_compressed_ETC1_RGB8_texture,GL_OES_depth24,GL_OES_depth_texture",
};

// ─── AuroraStore anonymous auth ──────────────────────────────────────────────

interface AuthCache {
  token: string;
  tokenArm64: string;
  expiry: number;
}

async function getAuthToken(kv: KVNamespace, arch: "arm64" | "armeabi"): Promise<string> {
  const cacheKey = `gplay_auth_v1`;
  const raw = await kv.get(cacheKey).catch(() => null);
  const cache = raw ? JSON.parse(raw) as AuthCache : null;

  if (cache && Date.now() < cache.expiry) {
    return arch === "arm64" ? cache.tokenArm64 : cache.token;
  }

  // Fetch fresh tokens for both architectures
  const [token, tokenArm64] = await Promise.all([
    fetchToken("armeabi-v7a"),
    fetchToken("arm64-v8a"),
  ]);

  const newCache: AuthCache = {
    token,
    tokenArm64,
    expiry: Date.now() + 50 * 60 * 1000, // 50 min (tokens last ~1hr)
  };
  await kv.put(cacheKey, JSON.stringify(newCache), { expirationTtl: 3600 }).catch(() => {});
  return arch === "arm64" ? tokenArm64 : token;
}

async function fetchToken(arch: string): Promise<string> {
  const body = new URLSearchParams({
    androidId: DEVICE.androidId,
    sdk: "33",
    device: "sunfish",
    hardware: "sunfish",
    product: "sunfish",
    platformVersionRelease: "13",
    model: "Pixel+4a",
    buildId: "TQ3A.230901.001",
    isWideScreen: "0",
    supportedAbis: arch === "arm64-v8a" ? "arm64-v8a,armeabi-v7a,armeabi" : "armeabi-v7a,armeabi",
  });

  const res = await fetch("https://auroraoss.com/api/auth", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "AuroraStore/4.3.5",
    },
    body: body.toString(),
  });

  if (!res.ok) throw new GPlayError(`AuroraStore auth failed: HTTP ${res.status}`);
  const data = await res.json() as { auth?: string; token?: string };
  const tok = data.auth ?? data.token;
  if (!tok) throw new GPlayError("AuroraStore returned no token");
  return tok;
}

// ─── Search via Google Play HTML ─────────────────────────────────────────────

export interface AppResult {
  name: string;
  developer: string;
  packageName: string;
  rating?: string;
}

export async function searchApps(
  kv: KVNamespace,
  query: string,
  onProgress?: ProgressFn
): Promise<AppResult[]> {
  await onProgress?.("searching Google Play…");

  const url = `https://play.google.com/store/search?q=${encodeURIComponent(query)}&c=apps&hl=en&gl=US`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
    },
    cf: { cacheTtl: 300 },
  });

  if (!res.ok) throw new GPlayError(`Play Store search HTTP ${res.status}`);
  const html = await res.text();

  const results: AppResult[] = [];
  const seen = new Set<string>();

  // Extract package names + app names from the search result HTML
  // Play Store embeds structured data with data-docid attributes
  const pkgRe = /\["([a-z][a-z0-9]*(?:\.[a-z0-9_]+)+)"/g;
  const nameRe = /,"([^"]{2,50})",[^,]*,"[^"]*","([^"]+)"\]/g;

  // Primary: extract from AF_initDataCallback structured data
  const dataMatch = html.match(/AF_initDataCallback\(\{key: 'ds:4'[\s\S]*?\}\);/);
  const dataBlock = dataMatch ? dataMatch[0] : html;

  let m: RegExpExecArray | null;
  while ((m = pkgRe.exec(dataBlock)) !== null && results.length < 8) {
    const pkg = m[1];
    if (seen.has(pkg) || pkg.length < 5) continue;
    seen.add(pkg);

    // Try to find app name near the package reference
    const around = dataBlock.slice(Math.max(0, m.index - 200), m.index + 200);
    const nameMatch = /"([A-Z][^"]{1,40})"/.exec(around);
    const name = nameMatch?.[1] ?? pkg.split(".").pop() ?? pkg;

    // Developer: look for "by X" pattern nearby
    const devMatch = /"([A-Z][a-zA-Z0-9 ]{2,30})"/.exec(
      dataBlock.slice(m.index + pkg.length, m.index + pkg.length + 400)
    );

    results.push({
      name: name.trim(),
      developer: devMatch?.[1]?.trim() ?? "Unknown",
      packageName: pkg,
    });
  }

  // Fallback: look for data-docid attributes in the HTML directly
  if (!results.length) {
    const docidRe = /data-docid="([a-z][a-z0-9]*(?:\.[a-z0-9_]+)+)"/g;
    while ((m = docidRe.exec(html)) !== null && results.length < 8) {
      const pkg = m[1];
      if (seen.has(pkg)) continue;
      seen.add(pkg);
      const around = html.slice(m.index, m.index + 300);
      const titleMatch = /aria-label="([^"]+)"/.exec(around) ??
        /<span[^>]*>([^<]{2,40})<\/span>/.exec(around);
      results.push({
        name: titleMatch?.[1]?.trim() ?? pkg,
        developer: "Unknown",
        packageName: pkg,
      });
    }
  }

  return results;
}

// ─── Minimal protobuf decoder ────────────────────────────────────────────────
// Only decodes what we need from the Google Play delivery API response.

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

    if (wireType === 0) {
      let v: bigint;
      [v, pos] = readVarint(buf, pos);
      push(v);
    } else if (wireType === 2) {
      let len: bigint;
      [len, pos] = readVarint(buf, pos);
      const end = pos + Number(len);
      push(buf.slice(pos, end));
      pos = end;
    } else if (wireType === 5) {
      pos += 4;
    } else if (wireType === 1) {
      pos += 8;
    } else {
      break; // unknown wire type — stop
    }
  }
  return fields;
}

function getString(fields: Map<number, unknown[]>, field: number): string {
  const arr = fields.get(field);
  if (!arr?.length) return "";
  const v = arr[0];
  if (v instanceof Uint8Array) return new TextDecoder().decode(v);
  return "";
}

function getBytes(fields: Map<number, unknown[]>, field: number): Uint8Array | null {
  const arr = fields.get(field);
  if (!arr?.length) return null;
  const v = arr[0];
  return v instanceof Uint8Array ? v : null;
}

function getAllBytes(fields: Map<number, unknown[]>, field: number): Uint8Array[] {
  return (fields.get(field) ?? []).filter((v): v is Uint8Array => v instanceof Uint8Array);
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

export interface SplitFile {
  name: string;
  url: string;
  size?: number;
}

export async function getVariants(
  kv: KVNamespace,
  packageName: string,
  onProgress?: ProgressFn
): Promise<Variant[]> {
  await onProgress?.("fetching download info…");

  const variants: Variant[] = [];

  for (const arch of ["arm64", "armeabi"] as const) {
    try {
      const v = await fetchDelivery(kv, packageName, arch, onProgress);
      if (v) variants.push(v);
    } catch (e) {
      console.warn(`gplay: delivery failed for ${arch}:`, e);
    }
  }

  return variants;
}

async function fetchDelivery(
  kv: KVNamespace,
  packageName: string,
  arch: "arm64" | "armeabi",
  onProgress?: ProgressFn
): Promise<Variant | null> {
  const token = await getAuthToken(kv, arch);

  // Build protobuf request for delivery API
  // Field 1 = docId (string), field 2 = installSource (varint), field 3 = versionCode (varint, 0=latest)
  const enc = new TextEncoder();
  const docIdBytes = enc.encode(packageName);
  const reqBuf = buildDeliveryRequest(docIdBytes);

  const abiHeader = arch === "arm64"
    ? "arm64-v8a,armeabi-v7a,armeabi"
    : "armeabi-v7a,armeabi";

  const res = await fetch("https://android.clients.google.com/fdfe/delivery", {
    method: "POST",
    headers: {
      "Authorization": `GoogleLogin auth=${token}`,
      "User-Agent": DEVICE.userAgent,
      "X-DFE-Device-Id": DEVICE.androidId,
      "X-DFE-Client-Id": "am-android-google",
      "X-DFE-MCCMNC": DEVICE.mccmnc,
      "X-DFE-Network-Type": "4",
      "X-DFE-Content-Filters": "",
      "X-DFE-Request-Params": "timeoutMs=4000",
      "X-DFE-Encoded-Targets": "CAESN/8hAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      "Accept-Language": "en-US",
      "Content-Type": "application/x-protobuf",
      "X-DFE-Userlanguages": "en",
      "X-DFE-Filter-Level": "3",
      "X-DFE-No-Prefetch": "false",
      "X-Limit-Ad-Tracking": "1",
      "X-DFE-Phenotype": "H4sIAAAAAAAAAON...",
    },
    body: reqBuf,
    cf: { cacheTtl: 0 },
  });

  if (!res.ok) {
    if (res.status === 401) {
      // Token expired — clear cache and retry once
      await kv.delete("gplay_auth_v1").catch(() => {});
      throw new GPlayError("token expired");
    }
    throw new GPlayError(`Delivery API HTTP ${res.status}`);
  }

  const buf = new Uint8Array(await res.arrayBuffer());
  return parseDeliveryResponse(buf, packageName, arch);
}

function buildDeliveryRequest(docIdBytes: Uint8Array): Uint8Array {
  // Minimal protobuf: field 1 (string) = packageName, field 3 (varint) = 0 (latest)
  const parts: number[] = [];

  // Field 1, wire type 2 (length-delimited string)
  parts.push(0x0a); // (1 << 3) | 2
  parts.push(docIdBytes.length);
  parts.push(...docIdBytes);

  // Field 3, wire type 0 (varint) = 0 (latest version)
  parts.push(0x18, 0x00);

  // Field 5 (installSource), wire type 0 = 1
  parts.push(0x28, 0x01);

  return new Uint8Array(parts);
}

function parseDeliveryResponse(
  buf: Uint8Array,
  packageName: string,
  arch: "arm64" | "armeabi"
): Variant | null {
  // Top-level response: field 1 = status, field 2 = deliveryDataResponse
  const top = decodeProto(buf);

  const deliveryBytes = getBytes(top, 2) ?? getBytes(top, 1);
  if (!deliveryBytes) return null;

  const delivery = decodeProto(deliveryBytes);

  // deliveryDataResponse has androidAppDeliveryData at field 2 or 4
  const appDataBytes = getBytes(delivery, 2) ?? getBytes(delivery, 4);
  if (!appDataBytes) return null;

  const appData = decodeProto(appDataBytes);

  // downloadUrl is field 3 in AndroidAppDeliveryData
  const downloadUrl = getString(appData, 3);
  if (!downloadUrl) return null;

  // Version info in field 7 (AndroidAppDeliveryData.versionCode) or look in encryptedSecret
  const versionCode = appData.get(7)?.[0];

  // Split files: field 15 = splitDeliveryDataList
  const splitChunks = getAllBytes(appData, 15);
  const splits: SplitFile[] = splitChunks.map(chunk => {
    const splitFields = decodeProto(chunk);
    return {
      name: getString(splitFields, 1) || "split",
      url: getString(splitFields, 5) || getString(splitFields, 3),
    };
  }).filter(s => s.url);

  const archLabel = arch === "arm64" ? "arm64 (modern phones)" : "armv7 (older phones)";

  return {
    arch: arch === "arm64" ? "arm64-v8a" : "armeabi-v7a",
    packageName,
    label: `${archLabel}${versionCode ? ` · build ${versionCode}` : ""}`,
    downloadUrl,
    isSplit: splits.length > 0,
    splits: splits.length ? splits : undefined,
  };
}

// ─── resolveDownload — no-op for gplay (URL already known) ───────────────────

export async function resolveDownload(
  _kv: KVNamespace,
  downloadUrl: string
): Promise<string | null> {
  return downloadUrl || null;
}
