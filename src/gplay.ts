// Google Play APK downloader client — calls the gplay server (Render.com)
// No CF bypass needed: Google CDN URLs are open, no Cloudflare protection.

export type ProgressFn = (text: string) => Promise<void>;

export class GPlayError extends Error {
  constructor(msg: string) { super(msg); this.name = "GPlayError"; }
}

// --- Types from gplay server API -----------------------------------

export interface AppResult {
  name: string;
  developer: string;
  packageName: string;
  icon?: string;
}

export interface Variant {
  arch: string;           // "arm64-v8a" | "armeabi-v7a" | "universal"
  packageName: string;
  label: string;          // display label e.g. "v10.1.5 · arm64"
  downloadUrl: string;    // direct Google CDN URL
  size?: number;          // bytes
  version?: string;
  isSplit: boolean;       // true if app bundle (multiple APKs)
  splits?: SplitFile[];
}

export interface SplitFile {
  name: string;
  url: string;
  size?: number;
}

// --- Core fetch with wake-up handling ------------------------------

async function gplayFetch(
  baseUrl: string,
  path: string,
  onProgress?: ProgressFn
): Promise<unknown> {
  const url = `${baseUrl.replace(/\/$/, "")}${path}`;

  // Render free tier spins down — first request may take 30s
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 55000);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new GPlayError(`gplay server HTTP ${res.status}: ${text.slice(0, 100)}`);
    }
    return res.json();
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new GPlayError("gplay server timed out (may be waking up — try again)");
    }
    throw e;
  } finally {
    clearTimeout(tid);
  }
}

// --- Search --------------------------------------------------------

export async function searchApps(
  baseUrl: string,
  query: string,
  onProgress?: ProgressFn
): Promise<AppResult[]> {
  await onProgress?.("searching Google Play…");
  const data = await gplayFetch(baseUrl, `/api/search?q=${encodeURIComponent(query)}`, onProgress) as {
    results?: Array<{ title?: string; developer?: string; packageName?: string; icon?: string }>;
  };

  const raw = data?.results ?? (Array.isArray(data) ? data as unknown[] : []);
  return (raw as Array<{ title?: string; developer?: string; packageName?: string; icon?: string }>)
    .slice(0, 8)
    .map(r => ({
      name: r.title ?? r.packageName ?? "Unknown",
      developer: r.developer ?? "Unknown",
      packageName: r.packageName ?? "",
      icon: r.icon,
    }))
    .filter(r => r.packageName);
}

// --- Get variants (architectures) for an app ----------------------

export async function getVariants(
  baseUrl: string,
  packageName: string,
  onProgress?: ProgressFn
): Promise<Variant[]> {
  await onProgress?.("fetching app details…");

  // Get download info for both architectures
  const variants: Variant[] = [];

  for (const arch of ["arm64-v8a", "armeabi-v7a"] as const) {
    try {
      const data = await gplayFetch(
        baseUrl,
        `/api/download-info/${encodeURIComponent(packageName)}?arch=${arch}`,
        onProgress
      ) as {
        version?: string;
        versionCode?: number;
        downloads?: Array<{ name: string; url: string; size?: number }>;
        isSplitApk?: boolean;
      };

      if (!data?.downloads?.length) continue;

      const base = data.downloads.find(d => d.name === "base.apk") ?? data.downloads[0];
      const splits = data.downloads.filter(d => d.name !== "base.apk");
      const version = data.version ?? "";

      variants.push({
        arch,
        packageName,
        label: `v${version} · ${arch === "arm64-v8a" ? "arm64 (modern)" : "armv7 (older phones)"}`,
        downloadUrl: base.url,
        size: base.size,
        version,
        isSplit: (data.isSplitApk ?? splits.length > 0),
        splits: splits.length ? splits.map(s => ({ name: s.name, url: s.url, size: s.size })) : undefined,
      });
    } catch { /* arch not available */ }
  }

  return variants;
}

// --- Resolve: for gplay, the download URL is already in the variant
// This exists for API compatibility with the old apkmirror flow.
export async function resolveDownload(
  _baseUrl: string,
  downloadUrl: string,
  _onProgress?: ProgressFn
): Promise<string | null> {
  return downloadUrl || null;
}
