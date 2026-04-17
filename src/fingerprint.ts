interface BrowserProfile {
  ua: string;
  secChUa: string;
  secChUaPlatform: string;
  secChUaMobile: string;
  acceptLanguage: string;
  acceptEncoding: string;
  accept: string;
  dnt?: string;
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

// Real Chrome varies the order of brands in Sec-CH-UA
function buildSecChUa(major: string): string {
  const brands = [
    `"Chromium";v="${major}"`,
    `"Google Chrome";v="${major}"`,
    `"Not-A.Brand";v="99"`,
  ];
  // Shuffle brands — real Chrome does this
  for (let i = brands.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [brands[i], brands[j]] = [brands[j], brands[i]];
  }
  return brands.join(", ");
}

export function generateFingerprint(): BrowserProfile {
  const chrome = pick(CHROME_VERSIONS);

  const r = Math.random();
  let osStr: string;
  let osPlatform: string;
  if (r < 0.60) {
    osStr = pick(WINDOWS_VERSIONS);
    osPlatform = "Windows";
  } else if (r < 0.85) {
    osStr = pick(MACOS_VERSIONS);
    osPlatform = "macOS";
  } else {
    osStr = pick(LINUX_VERSIONS);
    osPlatform = "Linux";
  }

  const ua = `Mozilla/5.0 (${osStr}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome.full} Safari/537.36`;

  return {
    ua,
    secChUa: buildSecChUa(chrome.major),
    secChUaPlatform: `"${osPlatform}"`,
    secChUaMobile: "?0",
    acceptLanguage: pick(LANGUAGES),
    acceptEncoding: "gzip, deflate, br",
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    dnt: Math.random() < 0.30 ? "1" : undefined,
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
  if (fp.dnt) h["DNT"] = fp.dnt;
  return h;
}
