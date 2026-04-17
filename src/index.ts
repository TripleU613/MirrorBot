import {
  sendMessage, sendMessageGetId, editMessage, answerCallback,
  sendTyping, setWebhookWithInline, TelegramUpdate, InlineKeyboard,
  answerInlineQuery, InlineQueryResult,
} from "./telegram";
import {
  searchApps, getVariants, getAppInfo, resolveDownload,
  seedToken, getStoredToken, getSession,
  GPlayError, TokenMissingError, TokenExpiredError,
  AppResult, Variant, ProgressFn,
} from "./gplay";
import { refreshVerifiedPool } from "./proxy-pool";

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  RATE_KV: KVNamespace;
}

interface ExecutionContext { waitUntil(p: Promise<unknown>): void; }

// ─── Session ─────────────────────────────────────────────────────────────────

type Session =
  | { step: "idle" }
  | { step: "results"; results: AppResult[]; query: string; messageId: number }
  | { step: "variants"; variants: Variant[]; appName: string; developer: string; icon?: string; packageName: string; messageId: number; results?: AppResult[]; query?: string };

async function getSession(kv: KVNamespace, chatId: number): Promise<Session> {
  try { const r = await kv.get(`sess:${chatId}`); if (r) return JSON.parse(r) as Session; } catch {}
  return { step: "idle" };
}
async function saveSession(kv: KVNamespace, chatId: number, s: Session): Promise<void> {
  try { await kv.put(`sess:${chatId}`, JSON.stringify(s), { expirationTtl: 600 }); } catch {}
}

// ─── Progress helper ─────────────────────────────────────────────────────────

function mkProgress(token: string, chatId: number, msgId: number, prefix: string): ProgressFn {
  return async (status: string) => {
    try { await editMessage(token, chatId, msgId, `${prefix} <i>${esc(status)}</i>`); } catch {}
  };
}

// ─── Keyboards ───────────────────────────────────────────────────────────────

const resultsKb = (results: AppResult[]): InlineKeyboard => [
  ...results.map((r, i) => ([{ text: `${r.name}  —  ${r.developer}`, callback_data: `r:${i}` }])),
  [{ text: "✕  Cancel", callback_data: "x" }],
];

const variantsKb = (variants: Variant[]): InlineKeyboard => [
  ...variants.map((v, i) => ([{ text: v.label, callback_data: `v:${i}` }])),
  [{ text: "← Back", callback_data: "back" }],
  [{ text: "✕  Cancel", callback_data: "x" }],
];

const downloadKb = (v: Variant): InlineKeyboard => {
  const rows: InlineKeyboard = [[{ text: `⬇️  Download  ${v.sizeLabel ?? ""}`.trim(), url: v.downloadUrl }]];
  if (v.isSplit && v.splits?.length) {
    // Show each split as a separate button
    v.splits.slice(0, 5).forEach(s => rows.push([{ text: `⬇️  ${s.name}${s.size ? "  ·  " + (s.size / 1024 / 1024).toFixed(1) + " MB" : ""}`, url: s.url }]));
  }
  rows.push([{ text: "← Back to variants", callback_data: "back2" }]);
  rows.push([{ text: "✕  Done", callback_data: "x" }]);
  return rows;
};

const errKb = (back: string, retry?: string): InlineKeyboard => [
  ...(retry ? [[{ text: "🔄  Try again", callback_data: retry }]] : []),
  [{ text: "← Back", callback_data: back }],
];

// ─── Message templates ───────────────────────────────────────────────────────

const WELCOME =
  `👋 <b>MirrorBot</b> — Google Play APK downloader\n\n` +
  `Just type any app name to search.\n` +
  `Or type a package name like <code>com.whatsapp</code>\n\n` +
  `<i>Examples: whatsapp, youtube, chrome, spotify</i>`;

const resultsText = (q: string) =>
  `🔍 <b>Results for "${esc(q)}"</b>\n\nTap an app to see download options.`;

const variantsText = (name: string, dev: string) =>
  `📦 <b>${esc(name)}</b>\nby ${esc(dev)}\n\nChoose your architecture:`;

function downloadText(v: Variant, appName: string): string {
  return (
    `⬇️  <b>${esc(appName)}</b>\n\n` +
    `Architecture: <code>${esc(v.arch)}</code>\n` +
    (v.versionCode ? `Build: <code>${v.versionCode}</code>\n` : "") +
    (v.sizeLabel ? `Size: <code>${v.sizeLabel}</code>\n` : "") +
    (v.isSplit ? `\n⚠️ This is a split APK. Install all parts with SAI or similar.\n` : "") +
    `\nTap to download.`
  );
}

// ─── Error classifier ────────────────────────────────────────────────────────

function friendlyError(e: unknown): string {
  if (e instanceof TokenMissingError) return "🔑 No auth token set up yet. Ask the bot admin to run the seed script.";
  if (e instanceof TokenExpiredError) return "🔑 Auth token expired. Ask the bot admin to re-run the seed script.";
  if (e instanceof GPlayError) return `⚠️ ${esc(e.message)}`;
  const msg = e instanceof Error ? e.message : String(e);
  if (/timeout|timed out/i.test(msg)) return "⏱ Request timed out. Try again.";
  if (/404|not found/i.test(msg)) return "😕 App not found or not available in your region.";
  if (/401|403/.test(msg)) return "🔑 Auth issue. Token may have expired.";
  return "⚠️ Something went wrong. Try again.";
}

// ─── Worker ──────────────────────────────────────────────────────────────────

export default {
  async scheduled(_: unknown, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(refreshVerifiedPool(env.RATE_KV, 8).catch(() => {}));
  },

  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    // ── Webhook setup
    if (req.method === "GET" && url.pathname === "/setup") {
      try {
        // Register webhook + enable inline mode
        const [wh] = await Promise.all([
          setWebhookWithInline(env.TELEGRAM_BOT_TOKEN, `${url.origin}/webhook`),
          fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setMyCommands`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ commands: [
              { command: "start", description: "Welcome / help" },
              { command: "info", description: "Get app info by package name" },
            ]}),
          }),
        ]);
        return Response.json(wh);
      } catch (e) { return Response.json({ error: String(e) }, { status: 500 }); }
    }

    // ── Seed token (POST /seed-token {"arm64":"TOK","armeabi":"TOK"})
    if (req.method === "POST" && url.pathname === "/seed-token") {
      try {
        const body = await req.json() as {
          arm64?: string; armeabi?: string;
          arm64_gsf?: string; arm64_dfe?: string; arm64_ua?: string; arm64_mcc?: string;
          armeabi_gsf?: string; armeabi_dfe?: string; armeabi_ua?: string; armeabi_mcc?: string;
        };
        if (!body.arm64 && !body.armeabi)
          return Response.json({ error: "provide arm64 and/or armeabi token" }, { status: 400 });

        await seedToken(
          env.RATE_KV,
          body.arm64 ?? "", body.armeabi ?? "",
          body.arm64 ? { gsfId: body.arm64_gsf, dfeCookie: body.arm64_dfe, userAgent: body.arm64_ua, mccMnc: body.arm64_mcc } : undefined,
          body.armeabi ? { gsfId: body.armeabi_gsf, dfeCookie: body.armeabi_dfe, userAgent: body.armeabi_ua, mccMnc: body.armeabi_mcc } : undefined,
        );
        return Response.json({ ok: true, message: "Tokens stored. Downloads enabled for ~60 days." });
      } catch (e) { return Response.json({ error: String(e) }, { status: 500 }); }
    }

    // ── Token status
    if (req.method === "GET" && url.pathname === "/token-status") {
      const [arm64, armeabi] = await Promise.all([
        getStoredToken(env.RATE_KV, "arm64"),
        getStoredToken(env.RATE_KV, "armeabi"),
      ]);
      return Response.json({ arm64: !!arm64, armeabi: !!armeabi });
    }

    // ── Telegram webhook
    if (req.method === "POST" && url.pathname === "/webhook") {
      let update: TelegramUpdate;
      try { update = await req.json() as TelegramUpdate; }
      catch { return new Response("ok"); }
      ctx.waitUntil(dispatch(update, env).catch(e => console.error("dispatch:", e)));
      return new Response("ok");
    }

    return new Response("MirrorBot running.");
  },
};

// ─── Dispatcher ──────────────────────────────────────────────────────────────

async function dispatch(update: TelegramUpdate, env: Env): Promise<void> {
  if (update.inline_query) { await handleInline(update.inline_query, env); return; }
  if (update.callback_query) { await handleCallback(update.callback_query, env); return; }
  if (update.message?.text && update.message.chat?.id) await handleMessage(update.message, env);
}

// ─── Message handler ─────────────────────────────────────────────────────────

async function handleMessage(msg: NonNullable<TelegramUpdate["message"]>, env: Env): Promise<void> {
  const chatId = msg.chat.id;
  const text = msg.text?.trim() ?? "";

  if (text === "/start" || text === "/help" || text.startsWith("/help@")) {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, WELCOME);
    await saveSession(env.RATE_KV, chatId, { step: "idle" });
    return;
  }

  // /info com.package.name — quick app info
  if (text.startsWith("/info")) {
    const pkg = text.replace(/^\/info\s*(@\w+)?\s*/, "").trim();
    if (!pkg) { await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Usage: /info com.package.name"); return; }
    await sendTyping(env.TELEGRAM_BOT_TOKEN, chatId);
    const info = await getAppInfo(pkg).catch(() => null);
    if (!info) { await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `😕 App <code>${esc(pkg)}</code> not found.`); return; }
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId,
      `📦 <b>${esc(info.name)}</b>\nby ${esc(info.developer)}\n` +
      (info.version ? `Version: <code>${esc(info.version)}</code>\n` : "") +
      `Package: <code>${esc(info.packageName)}</code>`,
      [[{ text: "⬇️  Get APK", callback_data: `pkg:${pkg}` }]]
    );
    return;
  }

  if (text.startsWith("/")) return;

  const query = text.trim();
  if (!query) return;

  const msgId = await sendMessageGetId(env.TELEGRAM_BOT_TOKEN, chatId,
    `🔍 Searching Google Play for <b>${esc(query)}</b>…`);
  const onProgress = mkProgress(env.TELEGRAM_BOT_TOKEN, chatId, msgId, `🔍 Searching for <b>${esc(query)}</b>…`);

  try {
    const results = await searchApps(env.RATE_KV, query, onProgress);
    if (!results.length) {
      await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, msgId,
        `😕 No results for "<b>${esc(query)}</b>". Try a different name or package name.`);
      return;
    }
    await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, msgId, resultsText(query), resultsKb(results));
    await saveSession(env.RATE_KV, chatId, { step: "results", results, query, messageId: msgId });
  } catch (e) {
    const errText = friendlyError(e);
    try { await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, msgId, errText,
      [[{ text: "🔄  Try again", callback_data: `retry:${encodeURIComponent(query)}` }]]); }
    catch { try { await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, errText); } catch {} }
  }
}

// ─── Inline handler ──────────────────────────────────────────────────────────

async function handleInline(
  query: NonNullable<TelegramUpdate["inline_query"]>,
  env: Env
): Promise<void> {
  const q = query.query.trim();
  if (!q) {
    await answerInlineQuery(env.TELEGRAM_BOT_TOKEN, query.id, []);
    return;
  }

  try {
    const results = await searchApps(env.RATE_KV, q);
    const articles: InlineQueryResult[] = results.map(r => ({
      type: "article" as const,
      id: r.packageName,
      title: r.name,
      description: `${r.developer} · ${r.packageName}`,
      thumb_url: r.icon,
      input_message_content: {
        message_text: `📦 <b>${esc(r.name)}</b>\nby ${esc(r.developer)}\n<code>${esc(r.packageName)}</code>`,
        parse_mode: "HTML" as const,
      },
      reply_markup: { inline_keyboard: [[
        { text: "⬇️  Get APK", callback_data: `pkg:${r.packageName}` },
      ]]},
    }));
    await answerInlineQuery(env.TELEGRAM_BOT_TOKEN, query.id, articles, 300);
  } catch {
    await answerInlineQuery(env.TELEGRAM_BOT_TOKEN, query.id, []);
  }
}

// ─── Callback handler ────────────────────────────────────────────────────────

async function handleCallback(cb: NonNullable<TelegramUpdate["callback_query"]>, env: Env): Promise<void> {
  const chatId = cb.from.id;
  const msgId = cb.message?.message_id;
  const data = cb.data ?? "";

  await answerCallback(env.TELEGRAM_BOT_TOKEN, cb.id);
  if (!msgId) return;

  const session = await getSession(env.RATE_KV, chatId);

  // Cancel/done
  if (data === "x") {
    await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, msgId, "👍 Done. Type an app name to search again.");
    await saveSession(env.RATE_KV, chatId, { step: "idle" });
    return;
  }

  // Retry search
  if (data.startsWith("retry:")) {
    const query = decodeURIComponent(data.slice(6));
    return runSearch(query, chatId, msgId, env, `retry:${encodeURIComponent(query)}`);
  }

  // Back to results
  if (data === "back") {
    const s = session as unknown as { results?: AppResult[]; query?: string };
    if (s.results?.length && s.query) {
      await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, msgId, resultsText(s.query), resultsKb(s.results));
      await saveSession(env.RATE_KV, chatId, { step: "results", results: s.results, query: s.query, messageId: msgId });
    }
    return;
  }

  // Back to variants
  if (data === "back2") {
    if (session.step !== "variants") return;
    await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, msgId,
      variantsText(session.appName, session.developer), variantsKb(session.variants));
    return;
  }

  // Pick a search result
  if (data.startsWith("r:")) {
    if (session.step !== "results") return;
    const app = session.results[parseInt(data.slice(2), 10)];
    if (!app) return;
    return loadVariants(app.packageName, app.name, app.developer, app.icon,
      chatId, msgId, env, session.results, session.query, `r:${data.slice(2)}`);
  }

  // Direct package lookup (from /info or inline)
  if (data.startsWith("pkg:")) {
    const pkg = data.slice(4);
    const info = await getAppInfo(pkg).catch(() => null);
    return loadVariants(pkg, info?.name ?? pkg, info?.developer ?? "Unknown", info?.icon,
      chatId, msgId, env, undefined, undefined, `pkg:${pkg}`);
  }

  // Pick a variant
  if (data.startsWith("v:")) {
    if (session.step !== "variants") return;
    const variant = session.variants[parseInt(data.slice(2), 10)];
    if (!variant) return;
    await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, msgId,
      downloadText(variant, session.appName), downloadKb(variant));
    return;
  }
}

// ─── Shared helpers ──────────────────────────────────────────────────────────

async function runSearch(
  query: string, chatId: number, msgId: number, env: Env, retryCb: string
): Promise<void> {
  await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, msgId,
    `🔍 Searching Google Play for <b>${esc(query)}</b>…`);
  const onProgress = mkProgress(env.TELEGRAM_BOT_TOKEN, chatId, msgId, `🔍 Searching for <b>${esc(query)}</b>…`);
  try {
    const results = await searchApps(env.RATE_KV, query, onProgress);
    if (!results.length) {
      await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, msgId,
        `😕 Still no results for "<b>${esc(query)}</b>".`);
      return;
    }
    await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, msgId, resultsText(query), resultsKb(results));
    await saveSession(env.RATE_KV, chatId, { step: "results", results, query, messageId: msgId });
  } catch (e) {
    await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, msgId, friendlyError(e),
      [[{ text: "🔄  Try again", callback_data: retryCb }]]).catch(() => {});
  }
}

async function loadVariants(
  packageName: string, appName: string, developer: string, icon: string | undefined,
  chatId: number, msgId: number, env: Env,
  results?: AppResult[], query?: string, retryCb?: string
): Promise<void> {
  await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, msgId,
    `🔄 Loading <b>${esc(appName)}</b>…`);
  const onProgress = mkProgress(env.TELEGRAM_BOT_TOKEN, chatId, msgId, `🔄 Loading <b>${esc(appName)}</b>…`);

  try {
    const variants = await getVariants(env.RATE_KV, packageName, onProgress);
    if (!variants.length) {
      await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, msgId,
        `😕 No download available for <b>${esc(appName)}</b>.\nApp may be paid, region-locked, or require sign-in.`,
        errKb("back", retryCb));
      return;
    }
    await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, msgId,
      variantsText(appName, developer), variantsKb(variants));
    await saveSession(env.RATE_KV, chatId, {
      step: "variants", variants, appName, developer, icon, packageName, messageId: msgId,
      results, query,
    });
  } catch (e) {
    await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, msgId,
      friendlyError(e), errKb("back", retryCb)).catch(() => {});
  }
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
