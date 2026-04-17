import {
  sendMessage, sendMessageGetId, editMessage,
  answerCallback, setWebhook,
  TelegramUpdate, InlineKeyboard,
} from "./telegram";
import {
  searchApps, getVariants, resolveDownload, seedToken, getStoredToken,
  GPlayError, AppResult, Variant, ProgressFn,
} from "./gplay";
import { refreshVerifiedPool } from "./proxy-pool";

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  RATE_KV: KVNamespace;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

// --- Session ------------------------------------------------------------

type Session =
  | { step: "idle" }
  | { step: "results"; results: AppResult[]; query: string; messageId: number }
  | { step: "variants"; variants: Variant[]; appName: string; developer: string; packageName: string; messageId: number; results?: AppResult[]; query?: string };

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

// --- Progress helper ----------------------------------------------------

function makeProgress(token: string, chatId: number, messageId: number, prefix: string): ProgressFn {
  return async (status: string) => {
    try { await editMessage(token, chatId, messageId, `${prefix} <i>${esc(status)}</i>`); }
    catch { /* ignore */ }
  };
}

// --- Keyboards ----------------------------------------------------------

function resultsKeyboard(results: AppResult[]): InlineKeyboard {
  return [
    ...results.map((r, i) => ([{ text: `${r.name}  —  ${r.developer}`, callback_data: `r:${i}` }])),
    [{ text: "✕  Cancel", callback_data: "x" }],
  ];
}

function variantsKeyboard(variants: Variant[]): InlineKeyboard {
  return [
    ...variants.map((v, i) => ([{ text: v.label, callback_data: `v:${i}` }])),
    [{ text: "← Back to results", callback_data: "back" }],
    [{ text: "✕  Cancel", callback_data: "x" }],
  ];
}

function downloadKeyboard(v: Variant): InlineKeyboard {
  const rows: InlineKeyboard = [
    [{ text: `⬇️  Download APK`, url: v.downloadUrl }],
  ];
  if (v.isSplit && v.splits?.length) {
    // Show individual splits if it's a bundle
    v.splits.slice(0, 3).forEach(s =>
      rows.push([{ text: `⬇️  ${s.name}`, url: s.url }])
    );
  }
  rows.push([{ text: "← Back to variants", callback_data: "back2" }]);
  rows.push([{ text: "✕  Done", callback_data: "x" }]);
  return rows;
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
  `Type any app name to search Google Play.\n\n` +
  `<i>Examples: whatsapp, youtube, chrome, spotify</i>`;

const resultsText = (q: string) =>
  `🔍 <b>Results for "${esc(q)}"</b>\n\nTap an app to see download options.`;

const variantsText = (name: string, dev: string) =>
  `📦 <b>${esc(name)}</b>\nby ${esc(dev)}\n\nChoose your architecture:`;

function downloadText(v: Variant, appName: string): string {
  const size = v.size ? ` · ${(v.size / 1024 / 1024).toFixed(1)} MB` : "";
  return (
    `⬇️  <b>${esc(appName)}</b>\n\n` +
    `Version: <code>${esc(v.version ?? "latest")}</code>\n` +
    `Architecture: <code>${esc(v.arch)}</code>${size}\n` +
    (v.isSplit ? `\n⚠️ Split APK — tap each part to download.\n` : "") +
    `\nTap below to download.`
  );
}

// --- Error classifier ---------------------------------------------------

function friendlyError(e: unknown): string {
  if (e instanceof GPlayError) return `⚠️ ${esc(e.message)}`;
  const msg = e instanceof Error ? e.message : String(e);
  if (/timeout|timed out/i.test(msg)) return "⏱ Took too long. Try again.";
  if (/token expired/i.test(msg)) return "🔄 Refreshing auth token. Try again.";
  if (/401|403/.test(msg)) return "🔄 Auth issue. Try again in a moment.";
  return "⚠️ Something went wrong. Try again.";
}

// --- Worker entry -------------------------------------------------------

export default {
  async scheduled(_event: unknown, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      refreshVerifiedPool(env.RATE_KV, 8)
        .catch(e => console.error("cron error:", e))
    );
  },

  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/setup") {
      try {
        const result = await setWebhook(env.TELEGRAM_BOT_TOKEN, `${url.origin}/webhook`);
        return Response.json(result);
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 500 });
      }
    }

    if (req.method === "GET" && url.pathname === "/warmup") {
      ctx.waitUntil(refreshVerifiedPool(env.RATE_KV, 8).catch(() => {}));
      return new Response("ok");
    }

    // POST /seed-token {"arm64":"TOKEN","armeabi":"TOKEN"}
    // Call this once with tokens from your local gplay server to enable downloads.
    if (req.method === "POST" && url.pathname === "/seed-token") {
      try {
        const { arm64, armeabi } = await req.json() as { arm64?: string; armeabi?: string };
        if (!arm64 && !armeabi) return Response.json({ error: "provide arm64 and/or armeabi token" }, { status: 400 });
        await seedToken(env.RATE_KV, arm64 ?? "", armeabi ?? "");
        return Response.json({ ok: true, message: "Tokens stored. Downloads enabled." });
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 500 });
      }
    }

    // GET /token-status — check if tokens are seeded
    if (req.method === "GET" && url.pathname === "/token-status") {
      const arm64 = await getStoredToken(env.RATE_KV, "arm64");
      const armeabi = await getStoredToken(env.RATE_KV, "armeabi");
      return Response.json({ arm64: !!arm64, armeabi: !!armeabi });
    }

    if (req.method === "POST" && url.pathname === "/webhook") {
      let update: TelegramUpdate;
      try { update = await req.json() as TelegramUpdate; }
      catch (e) { console.error("malformed JSON:", e); return new Response("ok"); }

      ctx.waitUntil(dispatch(update, env).catch(e => console.error("dispatch error:", e)));
      return new Response("ok");
    }

    return new Response("MirrorBot (Google Play edition) running.");
  },
};

// --- Dispatcher ---------------------------------------------------------

async function dispatch(update: TelegramUpdate, env: Env): Promise<void> {
  if (update.callback_query) { await handleCallback(update.callback_query, env); return; }
  if (update.message?.text && update.message.chat?.id) await handleMessage(update.message, env);
}

// --- Message handler ----------------------------------------------------

async function handleMessage(msg: NonNullable<TelegramUpdate["message"]>, env: Env): Promise<void> {
  const chatId = msg.chat.id;
  const text = msg.text?.trim() ?? "";

  if (text === "/start" || text === "/help" || text.startsWith("/help@")) {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, WELCOME);
    await saveSession(env.RATE_KV, chatId, { step: "idle" });
    return;
  }

  if (text.startsWith("/")) return;

  const query = text.trim();
  if (!query) return;

  const messageId = await sendMessageGetId(env.TELEGRAM_BOT_TOKEN, chatId,
    `🔍 Searching Google Play for <b>${esc(query)}</b>…`);
  const onProgress = makeProgress(env.TELEGRAM_BOT_TOKEN, chatId, messageId,
    `🔍 Searching for <b>${esc(query)}</b>…`);

  try {
    const results = await searchApps(env.RATE_KV, query, onProgress);

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

async function handleCallback(cb: NonNullable<TelegramUpdate["callback_query"]>, env: Env): Promise<void> {
  const chatId = cb.from.id;
  const messageId = cb.message?.message_id;
  const data = cb.data ?? "";

  await answerCallback(env.TELEGRAM_BOT_TOKEN, cb.id);
  if (!messageId) return;

  const session = await getSession(env.RATE_KV, chatId);

  if (data === "x") {
    await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId,
      "👍 Done. Type another app name whenever you're ready.");
    await saveSession(env.RATE_KV, chatId, { step: "idle" });
    return;
  }

  if (data.startsWith("retry:")) {
    const query = decodeURIComponent(data.slice(6));
    await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId,
      `🔍 Searching Google Play for <b>${esc(query)}</b>…`);
    const onProgress = makeProgress(env.TELEGRAM_BOT_TOKEN, chatId, messageId, `🔍 Searching for <b>${esc(query)}</b>…`);
    try {
      const results = await searchApps(env.RATE_KV, query, onProgress);
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

  if (data === "back") {
    const s = session as unknown as { results?: AppResult[]; query?: string };
    if (s.results && s.query) {
      await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId, resultsText(s.query), resultsKeyboard(s.results));
      await saveSession(env.RATE_KV, chatId, { step: "results", results: s.results, query: s.query, messageId });
    }
    return;
  }

  if (data === "back2") {
    if (session.step !== "variants") return;
    await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId,
      variantsText(session.appName, session.developer), variantsKeyboard(session.variants));
    return;
  }

  if (data.startsWith("r:")) {
    if (session.step !== "results") return;
    const idx = parseInt(data.slice(2), 10);
    const app = session.results[idx];
    if (!app) return;

    await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId,
      `🔄 Loading <b>${esc(app.name)}</b>…`);
    const onProgress = makeProgress(env.TELEGRAM_BOT_TOKEN, chatId, messageId, `🔄 Loading <b>${esc(app.name)}</b>…`);

    try {
      const variants = await getVariants(env.RATE_KV, app.packageName, onProgress);

      if (!variants.length) {
        await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId,
          `😕 No download available for <b>${esc(app.name)}</b>. App may be paid or region-locked.`,
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
        packageName: app.packageName,
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

  if (data.startsWith("v:")) {
    if (session.step !== "variants") return;
    const idx = parseInt(data.slice(2), 10);
    const variant = session.variants[idx];
    if (!variant) return;

    await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId,
      downloadText(variant, session.appName), downloadKeyboard(variant));
    return;
  }
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
