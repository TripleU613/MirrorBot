import {
  sendMessage, sendMessageGetId, editMessage,
  answerCallback, setWebhook,
  TelegramUpdate, InlineKeyboard,
} from "./telegram";
import {
  searchApps, getVariants, resolveDownload,
  CfBlockedError, AppResult, Variant, ProgressFn, BypassConfig,
} from "./apkmirror";
import { refreshVerifiedPool } from "./proxy-pool";

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  RATE_KV: KVNamespace;
  SOLVER: { fetch: (req: Request) => Promise<Response> }; // service binding → mirrorbot-solver
  SCRAPER_API_KEY?: string;  // optional fallback: scraperapi.com
  FS_URL?: string;           // optional fallback: FlareSolverr via tunnel
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

// --- Session ------------------------------------------------------------

type Session =
  | { step: "idle" }
  | { step: "results"; results: AppResult[]; query: string; messageId: number }
  | { step: "variants"; variants: Variant[]; appName: string; developer: string; appUrl: string; messageId: number; results?: AppResult[]; query?: string };

async function getSession(kv: KVNamespace, chatId: number): Promise<Session> {
  try {
    const raw = await kv.get(`sess:${chatId}`);
    if (raw) return JSON.parse(raw) as Session;
  } catch { /* ignore */ }
  return { step: "idle" };
}

async function saveSession(kv: KVNamespace, chatId: number, s: Session): Promise<void> {
  try {
    await kv.put(`sess:${chatId}`, JSON.stringify(s), { expirationTtl: 600 });
  } catch (e) {
    console.warn("saveSession failed:", e);
  }
}

// --- Bypass config from env --------------------------------------------

function bypassCfg(env: Env): BypassConfig {
  return { solver: env.SOLVER, scraperApiKey: env.SCRAPER_API_KEY, fsUrl: env.FS_URL };
}

// --- Progress helper ----------------------------------------------------

function makeProgress(
  token: string, chatId: number, messageId: number, prefix: string
): ProgressFn {
  return async (status: string) => {
    try {
      await editMessage(token, chatId, messageId, `${prefix} <i>${esc(status)}</i>`);
    } catch { /* don't break the flow if progress edit fails */ }
  };
}

// --- Keyboards ----------------------------------------------------------

function resultsKeyboard(results: AppResult[], withRetry?: string): InlineKeyboard {
  return [
    ...results.map((r, i) => ([{ text: `${r.name}  —  ${r.developer}`, callback_data: `r:${i}` }])),
    [{ text: "✕  Cancel", callback_data: "x" }],
  ];
}

function variantsKeyboard(variants: Variant[]): InlineKeyboard {
  return [
    ...variants.map((v, i) => ([{
      text: `v${v.version}  ·  ${v.arch || "universal"}  ·  Android ${v.minAndroid}${v.dpi ? "  ·  " + v.dpi : ""}`,
      callback_data: `v:${i}`,
    }])),
    [{ text: "← Back to results", callback_data: "back" }],
    [{ text: "✕  Cancel", callback_data: "x" }],
  ];
}

function downloadKeyboard(link: string, appName: string): InlineKeyboard {
  return [
    [{ text: `⬇️  Download ${appName}`, url: link }],
    [{ text: "← Back to variants", callback_data: "back2" }],
    [{ text: "✕  Done", callback_data: "x" }],
  ];
}

function errorKeyboard(backCb: string, retryCb?: string): InlineKeyboard {
  const rows: InlineKeyboard = [];
  if (retryCb) rows.push([{ text: "🔄  Try again", callback_data: retryCb }]);
  rows.push([{ text: "← Back", callback_data: backCb }]);
  return rows;
}

// --- Message templates --------------------------------------------------

const WELCOME =
  `👋 <b>MirrorBot</b>\n\n` +
  `Just type any app name to search APKMirror.\n\n` +
  `<i>Examples: whatsapp, youtube, chrome, spotify</i>`;

function resultsText(query: string): string {
  return `🔍 <b>Results for "${esc(query)}"</b>\n\nTap an app to see download variants.`;
}

function variantsText(appName: string, developer: string): string {
  return `📦 <b>${esc(appName)}</b>\nby ${esc(developer)}\n\nTap a variant to get the download link.`;
}

function downloadText(v: Variant, appName: string): string {
  return (
    `⬇️  <b>${esc(appName)}</b>\n\n` +
    `Version: <code>${esc(v.version)}</code>\n` +
    `Architecture: <code>${esc(v.arch || "universal")}</code>\n` +
    `Min Android: <code>${esc(v.minAndroid)}</code>\n` +
    (v.dpi ? `DPI: <code>${esc(v.dpi)}</code>\n` : "") +
    `\nTap below to download.`
  );
}

// --- Friendly error classifier ------------------------------------------

function friendlyError(e: unknown): string {
  if (e instanceof CfBlockedError) return "🚫 APKMirror is rate-limiting us right now. Wait a moment and try again.";
  const msg = e instanceof Error ? e.message : String(e);
  if (/timeout|timed out/i.test(msg)) return "⏱ Took too long to connect. Try again.";
  if (/HTTP 429/.test(msg)) return "⏱ Too many requests. Wait 30 seconds and try again.";
  if (/HTTP 403/.test(msg)) return "🚫 Request was blocked. Try again in a moment.";
  if (/HTTP 5\d\d/.test(msg)) return "⚠️ APKMirror is having issues. Try again shortly.";
  if (/CONNECT rejected|proxy/i.test(msg)) return "🔄 Routing issue. Try again.";
  if (/HTTP \d+/.test(msg)) return "⚠️ Unexpected response from APKMirror. Try again.";
  return "⚠️ Something went wrong. Try again.";
}

// --- Worker entry -------------------------------------------------------


export default {
  // Cron: runs every 10 minutes to find and verify working proxies
  async scheduled(_event: unknown, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      refreshVerifiedPool(env.RATE_KV, 50)
        .then(n => console.log(`cron: verified pool refreshed — ${n} working proxies`))
        .catch(e => console.error("cron: refresh failed:", e))
    );
  },

  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/warmup") {
      ctx.waitUntil(refreshVerifiedPool(env.RATE_KV, 80).then(n => console.log(`warmup: ${n} proxies`)));
      return new Response("Proxy pool refresh started in background.");
    }

    if (req.method === "GET" && url.pathname === "/setup") {
      try {
        const result = await setWebhook(env.TELEGRAM_BOT_TOKEN, `${url.origin}/webhook`);
        return Response.json(result);
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 500 });
      }
    }

    if (req.method === "POST" && url.pathname === "/webhook") {
      let update: TelegramUpdate;
      try { update = await req.json() as TelegramUpdate; }
      catch (e) { console.error("malformed webhook JSON:", e); return new Response("ok"); }

      // Return 200 to Telegram immediately — process in background.
      // This prevents Telegram from timing out and retrying the webhook.
      ctx.waitUntil(
        dispatch(update, env).catch(e => console.error("dispatch error:", e))
      );

      return new Response("ok");
    }

    // Debug: GET /test?url=... — check what status APKMirror returns from this Worker
    if (req.method === "GET" && url.pathname === "/test") {
      const target = url.searchParams.get("url") ?? "https://www.apkmirror.com/?post_type=app_release&searchtype=apk&s=chrome";
      try {
        const r = await fetch(target, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.119 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,*/*;q=0.9",
            "Accept-Language": "en-US,en;q=0.9",
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "none",
            "Sec-Fetch-User": "?1",
          },
          cf: { cacheTtl: 0 },
        });
        const body = await r.text();
        const isChallenge = body.includes("Just a moment") || body.includes("cf-challenge");
        return Response.json({ status: r.status, challenge: isChallenge, bodyLen: body.length, preview: body.slice(0, 200) });
      } catch (e) {
        return Response.json({ error: String(e) });
      }
    }

    return new Response("MirrorBot running.");
  },
};

// --- Dispatcher ---------------------------------------------------------

async function dispatch(update: TelegramUpdate, env: Env): Promise<void> {
  if (update.callback_query) {
    await handleCallback(update.callback_query, env);
    return;
  }
  if (update.message?.text && update.message.chat?.id) {
    await handleMessage(update.message, env);
  }
}

// --- Message handler ----------------------------------------------------

async function handleMessage(
  msg: NonNullable<TelegramUpdate["message"]>,
  env: Env
): Promise<void> {
  const chatId = msg.chat.id;
  const text = msg.text?.trim() ?? "";

  if (text === "/start" || text === "/help" || text === "/help@JtechMirrorBot") {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, WELCOME);
    await saveSession(env.RATE_KV, chatId, { step: "idle" });
    return;
  }

  if (text.startsWith("/dl ")) {
    const dlUrl = text.slice(4).trim();
    const mid = await sendMessageGetId(env.TELEGRAM_BOT_TOKEN, chatId, `🔗 Resolving download link…`);
    const onProgress = makeProgress(env.TELEGRAM_BOT_TOKEN, chatId, mid, "🔗 Resolving…");
    try {
      const link = await resolveDownload(env.RATE_KV, dlUrl, bypassCfg(env), onProgress);
      if (link) {
        await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, mid, "✅ Here's your link:", [[{ text: "⬇️  Download APK", url: link }]]);
      } else {
        await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, mid, "😕 Couldn't find a download link at that URL.");
      }
    } catch (e) {
      await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, mid, friendlyError(e));
    }
    return;
  }

  if (text.startsWith("/")) return;

  // Plain text → search
  const query = text.trim();
  if (!query) return;

  const messageId = await sendMessageGetId(
    env.TELEGRAM_BOT_TOKEN, chatId,
    `🔍 Searching APKMirror for <b>${esc(query)}</b>…`
  );
  const onProgress = makeProgress(env.TELEGRAM_BOT_TOKEN, chatId, messageId, `🔍 Searching for <b>${esc(query)}</b>…`);

  try {
    const results = await searchApps(env.RATE_KV, query, bypassCfg(env), onProgress);

    if (!results.length) {
      await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId,
        `😕 No results for "<b>${esc(query)}</b>". Try a different name.`);
      return;
    }

    await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId, resultsText(query), resultsKeyboard(results));
    await saveSession(env.RATE_KV, chatId, { step: "results", results, query, messageId });
  } catch (e) {
    const errText = friendlyError(e);
    try {
      await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId, errText,
        [[{ text: "🔄  Try again", callback_data: `retry:${encodeURIComponent(query)}` }]]);
    } catch {
      try { await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, errText); } catch { /* ignore */ }
    }
  }
}

// --- Callback handler ---------------------------------------------------

async function handleCallback(
  cb: NonNullable<TelegramUpdate["callback_query"]>,
  env: Env
): Promise<void> {
  const chatId = cb.from.id;
  const messageId = cb.message?.message_id;
  const data = cb.data ?? "";

  await answerCallback(env.TELEGRAM_BOT_TOKEN, cb.id);
  if (!messageId) return;

  const session = await getSession(env.RATE_KV, chatId);

  // Cancel / done
  if (data === "x") {
    await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId,
      "👍 Done. Type another app name whenever you're ready.");
    await saveSession(env.RATE_KV, chatId, { step: "idle" });
    return;
  }

  // Retry search
  if (data.startsWith("retry:")) {
    const query = decodeURIComponent(data.slice(6));
    await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId,
      `🔍 Searching APKMirror for <b>${esc(query)}</b>…`);
    const onProgress = makeProgress(env.TELEGRAM_BOT_TOKEN, chatId, messageId, `🔍 Searching for <b>${esc(query)}</b>…`);
    try {
      const results = await searchApps(env.RATE_KV, query, bypassCfg(env), onProgress);
      if (!results.length) {
        await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId,
          `😕 Still no results for "<b>${esc(query)}</b>". Try a different name.`);
        return;
      }
      await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId, resultsText(query), resultsKeyboard(results));
      await saveSession(env.RATE_KV, chatId, { step: "results", results, query, messageId });
    } catch (e) {
      await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId, friendlyError(e),
        [[{ text: "🔄  Try again", callback_data: data }]]);
    }
    return;
  }

  // Back to results
  if (data === "back") {
    const s = session as unknown as { results?: AppResult[]; query?: string };
    if (s.results && s.query) {
      await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId, resultsText(s.query), resultsKeyboard(s.results));
      await saveSession(env.RATE_KV, chatId, { step: "results", results: s.results, query: s.query, messageId });
    }
    return;
  }

  // Back to variants
  if (data === "back2") {
    if (session.step !== "variants") return;
    await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId,
      variantsText(session.appName, session.developer),
      variantsKeyboard(session.variants));
    return;
  }

  // Pick result → load variants
  if (data.startsWith("r:")) {
    if (session.step !== "results") return;
    const idx = parseInt(data.slice(2), 10);
    const app = session.results[idx];
    if (!app) return;

    await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId,
      `🔄 Loading variants for <b>${esc(app.name)}</b>…`);
    const onProgress = makeProgress(env.TELEGRAM_BOT_TOKEN, chatId, messageId,
      `🔄 Loading variants for <b>${esc(app.name)}</b>…`);

    try {
      const variants = await getVariants(env.RATE_KV, app.url, bypassCfg(env), onProgress);

      if (!variants.length) {
        await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId,
          `😕 No variants found for <b>${esc(app.name)}</b>.`,
          errorKeyboard("back", `r:${idx}`));
        return;
      }

      await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId,
        variantsText(app.name, app.developer), variantsKeyboard(variants));

      await saveSession(env.RATE_KV, chatId, {
        step: "variants",
        variants,
        appName: app.name,
        developer: app.developer,
        appUrl: app.url,
        messageId,
        results: session.results,
        query: session.query,
      });
    } catch (e) {
      await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId,
        friendlyError(e), errorKeyboard("back", `r:${idx}`));
    }
    return;
  }

  // Pick variant → resolve download
  if (data.startsWith("v:")) {
    if (session.step !== "variants") return;
    const idx = parseInt(data.slice(2), 10);
    const variant = session.variants[idx];
    if (!variant) return;

    await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId,
      `🔄 Resolving download for <b>${esc(session.appName)}</b> v${esc(variant.version)}…`);
    const onProgress = makeProgress(env.TELEGRAM_BOT_TOKEN, chatId, messageId,
      `🔄 Resolving download for <b>${esc(session.appName)}</b> v${esc(variant.version)}…`);

    try {
      const link = await resolveDownload(env.RATE_KV, variant.downloadPageUrl, bypassCfg(env), onProgress);

      if (!link) {
        await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId,
          `😕 Couldn't resolve the download link. Try the <a href="${esc(variant.downloadPageUrl)}">download page</a> directly.`,
          errorKeyboard("back2", `v:${idx}`));
        return;
      }

      await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId,
        downloadText(variant, session.appName),
        downloadKeyboard(link, session.appName));
    } catch (e) {
      await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId,
        friendlyError(e), errorKeyboard("back2", `v:${idx}`));
    }
    return;
  }
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
