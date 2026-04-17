import {
  sendMessage, sendMessageGetId, editMessage,
  answerCallback, sendTyping, setWebhook,
  TelegramUpdate, InlineKeyboard,
} from "./telegram";
import { searchApps, getVariants, resolveDownload, CfBlockedError, AppResult, Variant } from "./apkmirror";

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  RATE_KV: KVNamespace;
}

// --- Session ------------------------------------------------------------

type Session =
  | { step: "idle" }
  | { step: "results"; results: AppResult[]; query: string; messageId: number }
  | { step: "variants"; variants: Variant[]; appName: string; appUrl: string; messageId: number };

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

// --- Keyboards ----------------------------------------------------------

function resultsKeyboard(results: AppResult[]): InlineKeyboard {
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

// --- Worker entry -------------------------------------------------------

const TIMEOUT_MS = 25000;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

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

      await Promise.race([
        dispatch(update, env),
        new Promise<void>((_, rej) => setTimeout(() => rej(new Error("timeout")), TIMEOUT_MS)),
      ]).catch(e => console.error("dispatch error:", e));

      return new Response("ok");
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
    const midDl = await sendMessageGetId(env.TELEGRAM_BOT_TOKEN, chatId, `🔗 Resolving download link…`);
    try {
      const link = await resolveDownload(env.RATE_KV, dlUrl);
      if (link) {
        await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, midDl, "✅ Here's your link:", [[{ text: "⬇️  Download APK", url: link }]]);
      } else {
        await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, midDl, "😕 Couldn't resolve a download link from that URL.");
      }
    } catch (e) {
      await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, midDl, errorText(e));
    }
    return;
  }

  // Ignore other slash commands
  if (text.startsWith("/")) return;

  // Plain text → search
  const query = text.trim();
  if (!query) return;

  // Send immediate "searching" message — user sees instant feedback
  const messageId = await sendMessageGetId(
    env.TELEGRAM_BOT_TOKEN, chatId,
    `🔍 Searching APKMirror for <b>${esc(query)}</b>…`
  );

  try {
    const results = await searchApps(env.RATE_KV, query);

    if (!results.length) {
      await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId,
        `😕 No results for "<b>${esc(query)}</b>". Try a different name.`);
      return;
    }

    await editMessage(
      env.TELEGRAM_BOT_TOKEN, chatId, messageId,
      resultsText(query),
      resultsKeyboard(results)
    );

    await saveSession(env.RATE_KV, chatId, { step: "results", results, query, messageId });
  } catch (e) {
    try {
      await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId, errorText(e));
    } catch {
      await handleError(e, env.TELEGRAM_BOT_TOKEN, chatId);
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

  // Acknowledge immediately so Telegram stops the loading spinner
  await answerCallback(env.TELEGRAM_BOT_TOKEN, cb.id);

  if (!messageId) return;

  const session = await getSession(env.RATE_KV, chatId);

  // Cancel
  if (data === "x") {
    await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId, "👍 Done. Type another app name to search again.");
    await saveSession(env.RATE_KV, chatId, { step: "idle" });
    return;
  }

  // Back to results
  if (data === "back") {
    if (session.step !== "variants" && session.step !== "results") return;
    const s = session as Extract<Session, { step: "variants" }>;
    // Need the original results — re-search or keep them. We store them on the "variants" session via app URL.
    // Actually we need to go back to results — let's re-fetch from KV if we have them.
    // We'll store results on the variants session too (see below).
    const rs = session as unknown as { results?: AppResult[]; query?: string };
    if (rs.results && rs.query) {
      await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId, resultsText(rs.query), resultsKeyboard(rs.results));
      await saveSession(env.RATE_KV, chatId, { step: "results", results: rs.results, query: rs.query, messageId });
    }
    return;
  }

  // Back to variants
  if (data === "back2") {
    const s = session as unknown as { variants?: Variant[]; appName?: string; appUrl?: string; results?: AppResult[]; query?: string };
    if (s.variants && s.appName) {
      const dev = (s as unknown as { developer?: string }).developer ?? "";
      await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId, variantsText(s.appName, dev), variantsKeyboard(s.variants));
    }
    return;
  }

  // Pick result
  if (data.startsWith("r:")) {
    if (session.step !== "results") return;
    const idx = parseInt(data.slice(2), 10);
    const app = session.results[idx];
    if (!app) return;

    await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId,
      `🔄 Loading variants for <b>${esc(app.name)}</b>…`);

    try {
      const variants = await getVariants(env.RATE_KV, app.url);

      if (!variants.length) {
        await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId,
          `😕 No variants found for <b>${esc(app.name)}</b>.`,
          [[{ text: "← Back", callback_data: "back" }]]);
        return;
      }

      await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId,
        variantsText(app.name, app.developer),
        variantsKeyboard(variants));

      // Save variants session — include results + query for "back" navigation
      await saveSession(env.RATE_KV, chatId, {
        step: "variants",
        variants,
        appName: app.name,
        appUrl: app.url,
        messageId,
        // Carry forward for back-navigation
        ...(session.step === "results" ? { results: session.results, query: session.query, developer: app.developer } : {}),
      } as Session & { results?: AppResult[]; query?: string; developer?: string });
    } catch (e) {
      await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId,
        errorText(e), [[{ text: "← Back", callback_data: "back" }]]);
    }
    return;
  }

  // Pick variant
  if (data.startsWith("v:")) {
    if (session.step !== "variants") return;
    const idx = parseInt(data.slice(2), 10);
    const variant = session.variants[idx];
    if (!variant) return;

    await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId,
      `🔄 Resolving download for <b>${esc(session.appName)}</b> v${esc(variant.version)}…`);

    try {
      const link = await resolveDownload(env.RATE_KV, variant.downloadPageUrl);

      if (!link) {
        await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId,
          `😕 Couldn't resolve the download link. Try the <a href="${esc(variant.downloadPageUrl)}">download page</a> directly.`,
          [[{ text: "← Back to variants", callback_data: "back2" }]]);
        return;
      }

      await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId,
        downloadText(variant, session.appName),
        downloadKeyboard(link, session.appName));
    } catch (e) {
      await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId,
        errorText(e), [[{ text: "← Back to variants", callback_data: "back2" }]]);
    }
    return;
  }
}

// --- Helpers ------------------------------------------------------------

function errorText(e: unknown): string {
  if (e instanceof CfBlockedError) return "🚫 APKMirror is blocking requests right now. Try again in a minute.";
  return `⚠️ ${esc(e instanceof Error ? e.message : String(e))}`;
}

async function handleError(e: unknown, token: string, chatId: number): Promise<void> {
  console.error("handleError:", e);
  try {
    await sendMessage(token, chatId, errorText(e));
  } catch { /* ignore */ }
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
