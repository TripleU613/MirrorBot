// Generates a randomized but internally consistent browser fingerprint per request.

interface BrowserProfile {
  ua: string;
  secChUa: string;
  secChUaPlatform: string;
  secChUaMobile: string;
  acceptLanguage: string;
  acceptEncoding: string;
  accept: string;
  platform: string; // navigator.platform equivalent
}

const CHROME_VERSIONS = [
  { major: "124", full: "124.0.6367.119" },
  { major: "123", full: "123.0.6312.122" },
  { major: "122", full: "122.0.6261.129" },
  { major: "121", full: "121.0.6167.185" },
  { major: "120", full: "120.0.6099.216" },
];

const WINDOWS_VERSIONS = [
  "Windows NT 10.0; Win64; x64",
  "Windows NT 10.0; WOW64",
  "Windows NT 11.0; Win64; x64",
];

const MACOS_VERSIONS = [
  "Macintosh; Intel Mac OS X 10_15_7",
  "Macintosh; Intel Mac OS X 13_6_4",
  "Macintosh; Intel Mac OS X 14_2_1",
];

const LINUX_VERSIONS = [
  "X11; Linux x86_64",
  "X11; Ubuntu; Linux x86_64",
];

const LANGUAGES = [
  "en-US,en;q=0.9",
  "en-GB,en;q=0.9",
  "en-US,en;q=0.9,es;q=0.8",
  "en-US,en;q=0.8,de;q=0.6",
  "en-CA,en;q=0.9,fr;q=0.7",
  "en-AU,en;q=0.9",
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function generateFingerprint(): BrowserProfile {
  const chrome = pick(CHROME_VERSIONS);

  // 60% Windows, 25% Mac, 15% Linux
  const r = Math.random();
  let osStr: string;
  let platform: string;
  if (r < 0.60) {
    osStr = pick(WINDOWS_VERSIONS);
    platform = "Win32";
  } else if (r < 0.85) {
    osStr = pick(MACOS_VERSIONS);
    platform = "MacIntel";
  } else {
    osStr = pick(LINUX_VERSIONS);
    platform = "Linux x86_64";
  }

  const ua = `Mozilla/5.0 (${osStr}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome.full} Safari/537.36`;

  const secChUa = `"Chromium";v="${chrome.major}", "Google Chrome";v="${chrome.major}", "Not-A.Brand";v="99"`;

  return {
    ua,
    secChUa,
    secChUaPlatform: `"${platform === "Win32" ? "Windows" : platform === "MacIntel" ? "macOS" : "Linux"}"`,
    secChUaMobile: "?0",
    acceptLanguage: pick(LANGUAGES),
    acceptEncoding: "gzip, deflate, br",
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    platform,
  };
}

export function buildHeaders(fp: BrowserProfile, referer?: string): Record<string, string> {
  const h: Record<string, string> = {
    "User-Agent": fp.ua,
    "Accept": fp.accept,
    "Accept-Language": fp.acceptLanguage,
    "Accept-Encoding": fp.acceptEncoding,
    "Sec-CH-UA": fp.secChUa,
    "Sec-CH-UA-Mobile": fp.secChUaMobile,
    "Sec-CH-UA-Platform": fp.secChUaPlatform,
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": referer ? "same-origin" : "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
    "Cache-Control": "max-age=0",
  };
  if (referer) h["Referer"] = referer;
  return h;
}
