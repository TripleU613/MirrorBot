import puppeteer from "@cloudflare/puppeteer";

export interface Env {
  BROWSER: Fetcher;
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.119 Safari/537.36";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method !== "POST") {
      return new Response("POST {url} only", { status: 405 });
    }

    let url: string;
    try {
      ({ url } = await req.json() as { url: string });
      if (!url) throw new Error("missing url");
    } catch {
      return new Response("body must be JSON {url}", { status: 400 });
    }

    const browser = await puppeteer.launch(env.BROWSER);

    try {
      const page = await browser.newPage();

      await page.setUserAgent(UA);
      await page.setViewport({ width: 1920, height: 1080 });
      await page.setExtraHTTPHeaders({
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
      });

      // Disable unnecessary resource types to speed up loading
      await page.setRequestInterception(true);
      page.on("request", (r) => {
        if (["image", "media", "font", "stylesheet"].includes(r.resourceType())) {
          r.abort();
        } else {
          r.continue();
        }
      });

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

      // If CF managed challenge is showing, wait for it to resolve
      const isCfChallenge = await page.evaluate(() =>
        document.title.includes("Just a moment") ||
        document.body.innerText.includes("Checking your browser")
      );

      if (isCfChallenge) {
        // Wait for challenge to complete (CF managed challenge takes ~2-5s)
        await page.waitForFunction(
          () => !document.title.includes("Just a moment"),
          { timeout: 20000, polling: 500 }
        );
        // Brief settle
        await new Promise(r => setTimeout(r, 1000));
      }

      const html = await page.content();
      const finalUrl = page.url();

      return Response.json({ html, url: finalUrl });
    } finally {
      await browser.close();
    }
  },
};
