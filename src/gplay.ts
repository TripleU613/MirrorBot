// Google Play APK client — pure Cloudflare Workers TypeScript.
//
// Auth: AuroraStore anonymous token (seeded once via /seed-token, lasts months).
//       Full auth response stored in KV: authToken, gsfId, dfeCookie, userAgent, mccMnc.
// Search: play.google.com HTML → package IDs, parallel og:title/icon/dev fetches.
// Download: Google Play /fdfe/purchase → /fdfe/delivery (protobuf) → direct CDN URLs.

export type ProgressFn = (text: string) => Promise<void>;

export class GPlayError extends Error {
  constructor(msg: string) { super(msg); this.name = "GPlayError"; }
}
export class TokenMissingError extends GPlayError {
  constructor() { super("No auth token — run the seed-token script first."); this.name = "TokenMissingError"; }
}
export class TokenExpiredError extends GPlayError {
  constructor() { super("Auth token expired — re-run the seed-token script."); this.name = "TokenExpiredError"; }
}

// ─── Constants ───────────────────────────────────────────────────────────────

const AUTH_KV_KEY = "gplay_auth_v3";
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.119 Safari/537.36";
// Encoded targets for delivery response (what fields to include)
const DFE_ENCODED_TARGETS = "CAESN/qigQYC2AMBFfUbyA7SM5Ij/CvfBoIDgxXrBPsDlQUdMfOLAfoFrwEHgAcBrQYhoA0cGt4MKK0Y2gI";
const DFE_PHENOTYPE = "H4sIAAAAAAAAAB3OO3KjMAAA0KRNuWXukBkBQkAJ2MhgAZb5u2GCwQZbCH_EJ77QHmgvtDtbv-Z9_H63zXXU0NVPB1odlyGy7751Q3CitlPDvFd8lxhz3tpNmz7P92CFw73zdHU2Ie0Ad2kmR8lxhiErTFLt3RPGfJQHSDy7Clw10bg8kqf2owLokN4SecJTLoSwBnzQSd652_MOf2d1vKBNVedzg4ciPoLz2mQ8efGAgYeLou-l-PXn_7Sna1MfhHuySxt-4esulEDp8Sbq54CPPKjpANW-lkU2IZ0F92LBI-ukCKSptqeq1eXU96LD9nZfhKHdtjSWwJqUm_2r6pMHOxk01saVanmNopjX3YxQafC4iC6T55aRbC8nTI98AF_kItIQAJb5EQxnKTO7TZDWnr01HVPxelb9A2OWX6poidMWl16K54kcu_jhXw-JSBQkVcD_fPsLSZu6joIBAAA";

// ─── Auth storage ─────────────────────────────────────────────────────────────

export interface StoredAuth {
  arm64?: AuthSession;
  armeabi?: AuthSession;
  seededAt: number;
}

export interface AuthSession {
  authToken: string;
  gsfId: string;
  dfeCookie?: string;
  userAgent: string;
  mccMnc: string;
  deviceCheckInToken?: string;
  deviceConfigToken?: string;
}

function defaultSession(authToken: string): AuthSession {
  return {
    authToken,
    gsfId: "3ac3339d4c0cd207",
    userAgent: "Android-Finsky/38.5.24-29 (api=3,versionCode=84052400,sdk=33,device=sunfish,hardware=sunfish,product=sunfish,platformVersionRelease=13,model=Pixel+4a,buildId=TQ3A.230901.001,isWideScreen=0,supportedAbis=arm64-v8a;armeabi-v7a;armeabi)",
    mccMnc: "310260",
  };
}

// Device profiles baked in (from gplay-apk-downloader/profiles/)
// We inline the Pixel 9a profile — it's the top-priority ARM64 profile.
const PROFILE_PV: Record<string, string> = {
  "UserReadableName": "Google Pixel 9a",
  "Build.HARDWARE": "tegu", "Build.BRAND": "google",
  "Build.VERSION.SDK_INT": "35", "Build.MODEL": "Pixel 9a",
  "Build.DEVICE": "tegu", "Build.PRODUCT": "tegu",
  "Build.MANUFACTURER": "Google", "Build.ID": "BD4A.250405.003",
  "Build.FINGERPRINT": "google/tegu/tegu:15/BD4A.250405.003/13238919:user/release-keys",
  "Build.TYPE": "user", "Build.TAGS": "release-keys",
  "Build.VERSION.RELEASE": "15", "Build.RADIO": "g5300t-241101-241226-B-12850354",
  "Build.BOOTLOADER": "tegu-16.0-13238451",
  "Build.SUPPORTED_ABIS": "arm64-v8a,armeabi-v7a,armeabi",
  "Platforms": "arm64-v8a", "Screen.Width": "1080", "Screen.Height": "2424",
  "Screen.Density": "420", "ScreenLayout": "2", "HasHardKeyboard": "false",
  "HasFiveWayNavigation": "false", "Keyboard": "1", "Navigation": "1", "TouchScreen": "3",
  "GSF.version": "251333035", "Vending.version": "84582130",
  "Vending.versionString": "45.8.21-31 [0] [PR] 747433787",
  "Client": "android-google", "Roaming": "mobile-notroaming", "TimeZone": "UTC-10",
  "CellOperator": "310", "SimOperator": "38",
  "GL.Version": "196610",
  "Locales": "en,en_US,en_GB,de,de_DE,fr,fr_FR,es,es_ES,it,it_IT,ja,ja_JP,ko,ko_KR,zh_CN,zh_TW,pt,pt_BR,ru,ru_RU,ar,ar_EG,nl,nl_NL,pl,pl_PL,sv,sv_SE,tr,tr_TR",
  "SharedLibraries": "android.test.base,android.test.mock,com.google.android.gms,android.ext.shared,org.apache.http.legacy",
  "Features": "android.hardware.sensor.proximity,android.hardware.sensor.accelerometer,android.hardware.faketouch,android.hardware.touchscreen,android.hardware.touchscreen.multitouch,android.hardware.wifi,android.hardware.bluetooth,android.hardware.camera,android.hardware.camera.autofocus,android.hardware.microphone,android.hardware.screen.portrait,android.hardware.location,android.hardware.location.gps,android.hardware.fingerprint,android.hardware.nfc,android.software.webview,com.google.android.feature.GOOGLE_EXPERIENCE,com.google.android.feature.PIXEL_EXPERIENCE",
  "GL.Extensions": "GL_OES_EGL_image,GL_OES_EGL_image_external,GL_OES_depth24,GL_OES_depth_texture,GL_OES_element_index_uint,GL_OES_texture_float,GL_KHR_texture_compression_astc_ldr,GL_EXT_texture_filter_anisotropic,GL_OES_rgb8_rgba8",
};

// ARMv7 profile (Samsung Galaxy J5 Prime — XK, top ARMv7 priority)
const PROFILE_XK: Record<string, string> = {
  "UserReadableName": "Samsung Galaxy J5 Prime",
  "Build.HARDWARE": "universal7570", "Build.BRAND": "samsung",
  "Build.VERSION.SDK_INT": "28", "Build.MODEL": "SM-G570F",
  "Build.DEVICE": "on5xelte", "Build.PRODUCT": "on5xeltexx",
  "Build.MANUFACTURER": "samsung", "Build.ID": "PPR1.180610.011",
  "Build.FINGERPRINT": "samsung/on5xeltexx/on5xelte:9/PPR1.180610.011/G570FXXU7CSC2:user/release-keys",
  "Build.TYPE": "user", "Build.TAGS": "release-keys",
  "Build.VERSION.RELEASE": "9", "Build.RADIO": "G570FXXU7CSC2",
  "Build.BOOTLOADER": "G570FXXU7CSC2",
  "Build.SUPPORTED_ABIS": "armeabi-v7a,armeabi",
  "Platforms": "armeabi-v7a", "Screen.Width": "720", "Screen.Height": "1280",
  "Screen.Density": "320", "ScreenLayout": "2", "HasHardKeyboard": "false",
  "HasFiveWayNavigation": "false", "Keyboard": "1", "Navigation": "1", "TouchScreen": "3",
  "GSF.version": "214913988", "Vending.version": "80941800",
  "Vending.versionString": "19.4.18-all [0] [PR] 302028539",
  "Client": "android-google", "Roaming": "mobile-notroaming", "TimeZone": "UTC-5",
  "CellOperator": "310", "SimOperator": "260",
  "GL.Version": "196610",
  "Locales": "en,en_US,en_GB,de,de_DE,fr,fr_FR,es,es_ES",
  "SharedLibraries": "android.test.base,com.google.android.gms,android.ext.shared,org.apache.http.legacy",
  "Features": "android.hardware.sensor.accelerometer,android.hardware.faketouch,android.hardware.touchscreen,android.hardware.touchscreen.multitouch,android.hardware.wifi,android.hardware.bluetooth,android.hardware.camera,android.hardware.microphone,android.hardware.location,android.software.webview",
  "GL.Extensions": "GL_OES_EGL_image,GL_OES_EGL_image_external,GL_OES_depth24,GL_OES_rgb8_rgba8",
};

export interface AcquiredAuth {
  authToken: string;
  gsfId: string;
  dfeCookie?: string;
  userAgent: string;
  mccMnc: string;
  deviceCheckInToken?: string;
  deviceConfigToken?: string;
}

export async function acquireToken(arch: "arm64" | "armeabi"): Promise<AcquiredAuth> {
  const profile = arch === "arm64" ? PROFILE_PV : PROFILE_XK;

  const res = await fetch("https://auroraoss.com/api/auth", {
    method: "POST",
    headers: {
      "User-Agent": "com.aurora.store-4.6.1-70",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(profile),
    cf: { cacheTtl: 0 },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new GPlayError(`AuroraStore HTTP ${res.status}: ${body.slice(0, 100)}`);
  }

  const data = await res.json() as {
    authToken?: string;
    aasToken?: string;
    gsfId?: string;
    dfeCookie?: string;
    deviceCheckInConsistencyToken?: string;
    deviceConfigToken?: string;
    deviceInfoProvider?: { userAgentString?: string; mccMnc?: string };
  };

  if (!data.authToken && !data.aasToken) throw new GPlayError("AuroraStore returned no token");

  const gsfId = data.gsfId ?? "";
  const userAgent = data.deviceInfoProvider?.userAgentString
    ?? `Android-Finsky/${profile["Vending.versionString"]} (api=3,versionCode=${profile["Vending.version"]},sdk=${profile["Build.VERSION.SDK_INT"]},device=${profile["Build.DEVICE"]},hardware=${profile["Build.HARDWARE"]},product=${profile["Build.PRODUCT"]},platformVersionRelease=${profile["Build.VERSION.RELEASE"]},model=${encodeURIComponent(profile["Build.MODEL"] ?? "")},buildId=${profile["Build.ID"]},isWideScreen=0,supportedAbis=${profile["Platforms"]})`;
  const mccMnc = data.deviceInfoProvider?.mccMnc ?? "310260";

  // If we have an aasToken, exchange it for the FDFE-compatible auth token
  let fdfeToken = data.authToken ?? "";
  if (data.aasToken) {
    try {
      const exchangeBody = new URLSearchParams({
        Token: data.aasToken,
        service: "androidmarket",
        source: "android",
        androidId: gsfId,
        app: "com.android.vending",
        device_country: "us",
        operatorCountry: "us",
        lang: "en",
        sdk_version: profile["Build.VERSION.SDK_INT"] ?? "33",
      });
      const exchRes = await fetch("https://android.clients.google.com/auth", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": userAgent,
        },
        body: exchangeBody.toString(),
        cf: { cacheTtl: 0 },
      });
      if (exchRes.ok) {
        const exchText = await exchRes.text();
        const authMatch = exchText.match(/^Auth=(.+)$/m);
        if (authMatch) fdfeToken = authMatch[1];
      }
    } catch { /* use authToken fallback */ }
  }

  const tok = fdfeToken || data.authToken;
  if (!tok) throw new GPlayError("Could not obtain FDFE auth token");

  return {
    authToken: tok,
    gsfId,
    dfeCookie: data.dfeCookie,
    userAgent,
    mccMnc,
    deviceCheckInToken: data.deviceCheckInConsistencyToken,
    deviceConfigToken: data.deviceConfigToken,
  };
}

export async function getSession(kv: KVNamespace, arch: "arm64" | "armeabi"): Promise<AuthSession | null> {
  try {
    const raw = await kv.get(AUTH_KV_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw) as StoredAuth;
    return (arch === "arm64" ? stored.arm64 : stored.armeabi) ?? null;
  } catch { return null; }
}

export async function seedToken(
  kv: KVNamespace,
  arm64: string, armeabi: string,
  arm64Session?: Partial<AuthSession>,
  armeabi_session?: Partial<AuthSession>
): Promise<void> {
  const stored: StoredAuth = {
    arm64: arm64 ? { ...defaultSession(arm64), ...arm64Session } : undefined,
    armeabi: armeabi ? { ...defaultSession(armeabi), ...armeabi_session } : undefined,
    seededAt: Date.now(),
  };
  await kv.put(AUTH_KV_KEY, JSON.stringify(stored), { expirationTtl: 60 * 24 * 3600 });
}

export async function getStoredToken(kv: KVNamespace, arch: "arm64" | "armeabi"): Promise<string | null> {
  const s = await getSession(kv, arch);
  return s?.authToken ?? null;
}

function buildHeaders(session: AuthSession): Record<string, string> {
  // ya29.xxx = OAuth2 Bearer token; anything else = old-style GoogleLogin auth token
  const authHeader = session.authToken.startsWith("ya29.")
    ? `Bearer ${session.authToken}`
    : `GoogleLogin auth=${session.authToken}`;
  const h: Record<string, string> = {
    "Authorization": authHeader,
    "User-Agent": session.userAgent,
    "X-DFE-Device-Id": session.gsfId,
    "X-DFE-Client-Id": "am-android-google",
    "X-DFE-Network-Type": "4",
    "X-DFE-Content-Filters": "",
    "X-DFE-Request-Params": "timeoutMs=4000",
    "X-DFE-Encoded-Targets": DFE_ENCODED_TARGETS,
    "X-DFE-Phenotype": DFE_PHENOTYPE,
    "X-DFE-Filter-Level": "3",
    "Accept-Language": "en-US",
    "X-DFE-UserLanguages": "en_US",
    "X-Limit-Ad-Tracking-Enabled": "false",
    "X-Ad-Id": "",
    "X-DFE-No-Prefetch": "true",
  };
  if (session.dfeCookie) h["X-DFE-Cookie"] = session.dfeCookie;
  if (session.mccMnc) h["X-DFE-MCCMNC"] = session.mccMnc;
  if (session.deviceCheckInToken) h["X-DFE-Device-Checkin-Consistency-Token"] = session.deviceCheckInToken;
  if (session.deviceConfigToken) h["X-DFE-Device-Config-Token"] = session.deviceConfigToken;
  return h;
}

// ─── Search ──────────────────────────────────────────────────────────────────

export interface AppResult {
  name: string;
  developer: string;
  packageName: string;
  icon?: string;
  version?: string;
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
    headers: { "User-Agent": BROWSER_UA, "Accept-Language": "en-US,en;q=0.9" },
    cf: { cacheTtl: 300 },
  });
  if (!res.ok) throw new GPlayError(`Play Store search HTTP ${res.status}`);
  const html = await res.text();

  const pkgRe = /\/store\/apps\/details\?id=([a-zA-Z][a-zA-Z0-9_.]{4,})/g;
  const seen = new Set<string>();
  const packages: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = pkgRe.exec(html)) !== null) {
    const pkg = m[1];
    if (!seen.has(pkg) && !pkg.includes("&") && pkg.split(".").length >= 2) {
      seen.add(pkg);
      packages.push(pkg);
      if (packages.length >= 8) break;
    }
  }

  if (!packages.length) {
    // Fallback: try package-name search
    if (/^[a-z][a-z0-9]*(\.[a-z0-9_]+){1,}$/.test(query.toLowerCase())) {
      const result = await fetchAppMeta(query);
      return result ? [result] : [];
    }
    return [];
  }

  await onProgress?.("loading app details…");
  const results = await Promise.all(packages.map(fetchAppMeta));
  return results.filter((r): r is AppResult => r !== null);
}

async function fetchAppMeta(packageName: string): Promise<AppResult | null> {
  try {
    const res = await fetch(
      `https://play.google.com/store/apps/details?id=${encodeURIComponent(packageName)}&hl=en&gl=US`,
      { headers: { "User-Agent": BROWSER_UA, "Accept-Language": "en-US,en;q=0.9" }, cf: { cacheTtl: 3600 } }
    );
    if (!res.ok) return null;
    const html = await res.text();

    const title = (
      /property="og:title"\s+content="([^"]+)"/.exec(html) ??
      /content="([^"]+)"\s+property="og:title"/.exec(html)
    )?.[1]?.replace(/ - Apps on Google Play$/, "").trim();

    const developer = /"author"[^}]*"name":\s*"([^"]+)"/.exec(html)?.[1]?.trim();
    const icon = (
      /property="og:image"\s+content="([^"]+)"/.exec(html) ??
      /content="([^"]+)"\s+property="og:image"/.exec(html)
    )?.[1]?.replace(/=s\d+/, "=s128");

    // Version from description or structured data
    const version = /"softwareVersion":\s*"([^"]+)"/.exec(html)?.[1] ??
      /Current Version[^0-9]*([0-9][0-9.a-zA-Z_\-]+)/.exec(html)?.[1];

    if (!title) return null;
    return { name: title, developer: developer ?? "Unknown", packageName, icon, version };
  } catch { return null; }
}

// ─── Protobuf ────────────────────────────────────────────────────────────────

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

type ProtoFields = Map<number, unknown[]>;

function decodeProto(buf: Uint8Array): ProtoFields {
  const fields = new Map<number, unknown[]>();
  let pos = 0;
  while (pos < buf.length) {
    let tag: bigint;
    [tag, pos] = readVarint(buf, pos);
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    const push = (v: unknown) => { fields.set(field, [...(fields.get(field) ?? []), v]); };
    if (wire === 0) { let v: bigint; [v, pos] = readVarint(buf, pos); push(v); }
    else if (wire === 2) { let l: bigint; [l, pos] = readVarint(buf, pos); const e = pos + Number(l); push(buf.slice(pos, e)); pos = e; }
    else if (wire === 5) { pos += 4; }
    else if (wire === 1) { pos += 8; }
    else break;
  }
  return fields;
}

const td = new TextDecoder();
const pStr = (f: ProtoFields, n: number) => { const v = f.get(n)?.[0]; return v instanceof Uint8Array ? td.decode(v) : ""; };
const pBytes = (f: ProtoFields, n: number) => { const v = f.get(n)?.[0]; return v instanceof Uint8Array ? v : null; };
const pAllBytes = (f: ProtoFields, n: number): Uint8Array[] => (f.get(n) ?? []).filter((v): v is Uint8Array => v instanceof Uint8Array);
const pInt = (f: ProtoFields, n: number) => { const v = f.get(n)?.[0]; return typeof v === "bigint" ? Number(v) : 0; };

// ─── Download ────────────────────────────────────────────────────────────────

export interface Variant {
  arch: string;
  packageName: string;
  label: string;
  downloadUrl: string;
  size?: number;
  sizeLabel?: string;
  version?: string;
  versionCode?: number;
  isSplit: boolean;
  splits?: SplitFile[];
}

export interface SplitFile { name: string; url: string; size?: number; }

export async function getVariants(
  kv: KVNamespace,
  packageName: string,
  onProgress?: ProgressFn
): Promise<Variant[]> {
  const [s64, s32] = await Promise.all([
    getSession(kv, "arm64"),
    getSession(kv, "armeabi"),
  ]);

  // Auto-acquire tokens if none stored
  if (!s64 && !s32) {
    await onProgress?.("acquiring auth token…");
    try {
      const [a64, a32] = await Promise.allSettled([
        acquireToken("arm64"),
        acquireToken("armeabi"),
      ]);
      const tok64 = a64.status === "fulfilled" ? a64.value : null;
      const tok32 = a32.status === "fulfilled" ? a32.value : null;
      if (tok64 || tok32) {
        await seedToken(kv, tok64?.authToken ?? "", tok32?.authToken ?? "",
          tok64 ? tok64 : undefined, tok32 ? tok32 : undefined);
        return getVariants(kv, packageName, onProgress); // retry with fresh tokens
      }
    } catch { /* fall through to error */ }
    throw new TokenMissingError();
  }

  await onProgress?.("fetching download info…");

  // Try FDFE delivery first (Google Play CDN), fall back to APKPure
  const tasks: Promise<Variant | null>[] = [];
  if (s64) tasks.push(fetchDelivery(packageName, s64, "arm64"));
  if (s32) tasks.push(fetchDelivery(packageName, s32, "armeabi"));

  const results = await Promise.allSettled(tasks);
  const fdfeVariants = results
    .filter((r): r is PromiseFulfilledResult<Variant | null> => r.status === "fulfilled")
    .map(r => r.value)
    .filter((v): v is Variant => v !== null);

  if (fdfeVariants.length > 0) return fdfeVariants;

  // FDFE delivery unavailable — fall back to APKPure
  await onProgress?.("trying alternative source…");
  const apkpureResults = await Promise.all([
    fetchApkPureUrl(packageName, "arm64"),
    fetchApkPureUrl(packageName, "armeabi"),
  ]);

  const apkpureVariants: Variant[] = [];
  const archs = ["arm64", "armeabi"] as const;
  apkpureResults.forEach((url, i) => {
    if (!url) return;
    const arch = archs[i];
    apkpureVariants.push({
      arch: arch === "arm64" ? "arm64-v8a" : "armeabi-v7a",
      packageName,
      label: arch === "arm64" ? "arm64 · modern phones" : "armv7 · older phones",
      downloadUrl: url,
      isSplit: false,
    });
  });

  return apkpureVariants;
}

// ─── APKPure download fallback ───────────────────────────────────────────────
// APKPure's d.apkpure.net API is not CF-protected and accessible from Workers.
// Returns a signed CDN URL (winudf.com) for the latest APK.

async function fetchApkPureUrl(packageName: string, arch: "arm64" | "armeabi"): Promise<string | null> {
  // APKPure redirects to a signed winudf.com CDN URL — follow the redirect and return the final URL
  const url = `https://d.apkpure.net/b/APK/${encodeURIComponent(packageName)}?version=latest`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": BROWSER_UA,
      "Referer": "https://apkpure.net/",
    },
    redirect: "follow",  // follow the 302 to get the signed CDN URL
    cf: { cacheTtl: 0 },
  });
  // After following redirect, res.url is the final signed CDN URL
  if (res.ok && res.url && res.url.includes("winudf.com")) {
    return res.url;
  }
  return null;
}

async function fetchDelivery(
  packageName: string,
  session: AuthSession,
  arch: "arm64" | "armeabi"
): Promise<Variant | null> {
  const headers = buildHeaders(session);

  // Step 1: Get version code from details API
  let versionCode = 0;
  try {
    const detRes = await fetch(
      `https://android.clients.google.com/fdfe/details?doc=${encodeURIComponent(packageName)}`,
      { method: "GET", headers, cf: { cacheTtl: 300 } }
    );
    if (detRes.ok) {
      const detBuf = new Uint8Array(await detRes.arrayBuffer());
      const detTop = decodeProto(detBuf);
      // payload field 2 → detailsResponse → docV2 → details → appDetails → versionCode
      const detPayload = pBytes(detTop, 2);
      if (detPayload) {
        const dp = decodeProto(detPayload);
        // detailsResponse at field 2, docV2 at field 4, details at field 13, appDetails at field 1, versionCode at field 3
        const drBytes = pBytes(dp, 2);
        if (drBytes) {
          const dr = decodeProto(drBytes);
          const docBytes = pBytes(dr, 4) ?? pBytes(dr, 2) ?? pBytes(dr, 1);
          if (docBytes) {
            const doc = decodeProto(docBytes);
            const detailBytes = pBytes(doc, 13) ?? pBytes(doc, 11);
            if (detailBytes) {
              const det = decodeProto(detailBytes);
              const appDetBytes = pBytes(det, 1);
              if (appDetBytes) {
                const appDet = decodeProto(appDetBytes);
                versionCode = pInt(appDet, 3);
              }
            }
          }
        }
      }
    }
  } catch { /* use vc=0 */ }

  // Step 2: Purchase — POST, extract download token from response
  const vcParam = versionCode > 0 ? versionCode : 0;
  let downloadToken = "";
  try {
    const pRes = await fetch("https://android.clients.google.com/fdfe/purchase", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
      body: `doc=${encodeURIComponent(packageName)}&ot=1&vc=${vcParam}`,
      cf: { cacheTtl: 0 },
    });
    const pBuf = new Uint8Array(await pRes.arrayBuffer());
    const top = decodeProto(pBuf);
    const payload = pBytes(top, 1);
    if (payload) {
      const buyResp = pBytes(decodeProto(payload), 4);
      if (buyResp) {
        const buy = decodeProto(buyResp);
          downloadToken = pStr(buy, 55) || pStr(buy, 56) || "";
      }
    }
  } catch { /* continue to delivery anyway */ }

  // Step 3: Delivery — GET, include download token if we have it
  const dtokParam = downloadToken ? `&dtok=${encodeURIComponent(downloadToken)}` : "";
  const deliveryUrl = `https://android.clients.google.com/fdfe/delivery?doc=${encodeURIComponent(packageName)}&ot=1&vc=${vcParam}&isInstall=1${dtokParam}`;
  const res = await fetch(deliveryUrl, {
    method: "GET",
    headers,
    cf: { cacheTtl: 0 },
  });

  if (res.status === 401) throw new TokenExpiredError();
  if (!res.ok) throw new GPlayError(`Delivery HTTP ${res.status}`);

  const buf = new Uint8Array(await res.arrayBuffer());
  return parseDelivery(buf, packageName, arch);
}

function parseDelivery(buf: Uint8Array, packageName: string, arch: "arm64" | "armeabi"): Variant | null {
  // ResponseWrapper.payload(2).deliveryResponse(21).appDeliveryData(1)
  const top = decodeProto(buf);
  const payload = pBytes(top, 2);
  if (!payload) return null;
  const p = decodeProto(payload);

  // Try deliveryResponse at field 21, or fallback field 1/2/4
  const deliveryBytes = pBytes(p, 21) ?? pBytes(p, 2) ?? pBytes(p, 1);
  if (!deliveryBytes) return null;
  const delivery = decodeProto(deliveryBytes);

  const appDataBytes = pBytes(delivery, 1) ?? pBytes(delivery, 2) ?? pBytes(delivery, 4);
  if (!appDataBytes) return null;
  const appData = decodeProto(appDataBytes);

  const downloadUrl = pStr(appData, 3);
  if (!downloadUrl) return null;

  const downloadSize = pInt(appData, 4) || pInt(appData, 9);
  const versionCode = pInt(appData, 7);

  // Splits: field 15 = split delivery data list
  const splits: SplitFile[] = pAllBytes(appData, 15).map(chunk => {
    const f = decodeProto(chunk);
    return { name: pStr(f, 1) || "split", url: pStr(f, 5) || pStr(f, 3), size: pInt(f, 4) };
  }).filter(s => s.url);

  const archLabel = arch === "arm64" ? "arm64-v8a" : "armeabi-v7a";
  const archDesc = arch === "arm64" ? "arm64 · modern phones" : "armv7 · older phones";

  const sizeLabel = downloadSize
    ? `${(downloadSize / 1024 / 1024).toFixed(1)} MB`
    : undefined;

  const versionLabel = versionCode ? ` · build ${versionCode}` : "";

  return {
    arch: archLabel,
    packageName,
    label: `${archDesc}${versionLabel}${sizeLabel ? "  ·  " + sizeLabel : ""}`,
    downloadUrl,
    size: downloadSize || undefined,
    sizeLabel,
    versionCode: versionCode || undefined,
    isSplit: splits.length > 0,
    splits: splits.length ? splits : undefined,
  };
}

// ─── App info (version check, no download) ───────────────────────────────────

export interface AppInfo {
  packageName: string;
  name: string;
  developer: string;
  icon?: string;
  version?: string;
  rating?: string;
  description?: string;
}

export async function getAppInfo(packageName: string): Promise<AppInfo | null> {
  const meta = await fetchAppMeta(packageName);
  if (!meta) return null;
  return {
    packageName,
    name: meta.name,
    developer: meta.developer,
    icon: meta.icon,
    version: meta.version,
  };
}

// ─── Debug delivery ─────────────────────────────────────────────────────────

export async function debugDelivery(kv: KVNamespace, packageName: string): Promise<unknown> {
  const session = await getSession(kv, "arm64");
  if (!session) return { error: "no token" };

  const headers = buildHeaders(session);
  const enc = new TextEncoder();
  const pkgBytes = enc.encode(packageName);

  // Get version code first
  let vc = 0;
  const detRes = await fetch(
    `https://android.clients.google.com/fdfe/details?doc=${encodeURIComponent(packageName)}`,
    { method: "GET", headers }
  );
  const detBuf = new Uint8Array(await detRes.arrayBuffer());
  const detHex = Array.from(detBuf.slice(0, 100)).map(b => b.toString(16).padStart(2,"0")).join(" ");

  // Try alternate auth format: GoogleLogin auth= instead of Bearer
  const headersGoogleLogin = {
    ...headers,
    "Authorization": `GoogleLogin auth=${session.authToken}`,
  };

  const pRes = await fetch("https://android.clients.google.com/fdfe/purchase", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
    body: `doc=${encodeURIComponent(packageName)}&ot=1&vc=${vc}`,
  });
  const purchaseBuf = new Uint8Array(await pRes.arrayBuffer());
  const purchaseUrlMatch = new TextDecoder().decode(purchaseBuf).match(/https?:\/\/[^\x00-\x1F\x7F]{20,}/g);
  const purchaseParsed = dumpProto(purchaseBuf);

  // Extract download token from purchase response
  // Path: ResponseWrapper.field1.field4.field1.field55 (or field56)
  let downloadToken = "";
  try {
    const top = decodeProto(purchaseBuf);
    const payload = pBytes(top, 1);
    if (payload) {
      const buyResp = pBytes(decodeProto(payload), 4);
      if (buyResp) {
        const buy = decodeProto(buyResp);
        downloadToken = pStr(buy, 55) || pStr(buy, 56) || "";
      }
    }
  } catch { /* ignore */ }

  const dtokParam = downloadToken ? `&dtok=${encodeURIComponent(downloadToken)}` : "";
  const deliveryBase = `https://android.clients.google.com/fdfe/delivery?doc=${encodeURIComponent(packageName)}&ot=1&vc=${vc}&isInstall=1${dtokParam}`;

  // Test Bearer auth
  const dRes = await fetch(deliveryBase, { method: "GET", headers });
  const buf = new Uint8Array(await dRes.arrayBuffer());

  // Test GoogleLogin auth format
  const dResGL = await fetch(deliveryBase, { method: "GET", headers: { ...headers, "Authorization": `GoogleLogin auth=${session.authToken}` } });
  const bufGL = new Uint8Array(await dResGL.arrayBuffer());
  const urlMatchGL = new TextDecoder().decode(bufGL).match(/https?:\/\/[^\x00-\x1F\x7F]{10,}/g);

  const hex = Array.from(buf.slice(0, 300)).map(b => b.toString(16).padStart(2, "0")).join(" ");
  // Try to find any string that looks like a URL
  const bufStr = new TextDecoder().decode(buf);
  const urlMatch = bufStr.match(/https?:\/\/[^\x00-\x1F\x7F]{10,}/g);

  function dumpProto(b: Uint8Array, depth = 0): Record<string, unknown> {
    if (depth > 4) return {};
    const f = decodeProto(b);
    const out: Record<string, unknown> = {};
    for (const [k, vals] of f) {
      out[String(k)] = vals.map(v => {
        if (typeof v === "bigint") return Number(v);
        if (v instanceof Uint8Array) {
          const s = new TextDecoder().decode(v);
          const printable = s.replace(/[^\x20-\x7E]/g, "?");
          if (v.length < 500 && depth < 3) {
            try { return { _nested: dumpProto(v, depth + 1), _str: printable.slice(0, 80), _len: v.length }; } catch { /**/ }
          }
          return `<bytes len=${v.length} str="${printable.slice(0, 80)}">`;
        }
        return v;
      });
    }
    return out;
  }

  const topFields = dumpProto(buf);

  return {
    details_status: detRes.status,
    purchase_status: pRes.status,
    download_token: downloadToken ? downloadToken.slice(0, 20) + "..." : null,
    bearer_status: dRes.status, bearer_len: buf.length, bearer_urls: urlMatch,
    googlelogin_status: dResGL.status, googlelogin_len: bufGL.length, googlelogin_urls: urlMatchGL,
    delivery_parsed: topFields,
  };
}

// ─── resolveDownload — URL already known from variant ────────────────────────

export async function resolveDownload(_kv: KVNamespace, url: string): Promise<string | null> {
  return url || null;
}
