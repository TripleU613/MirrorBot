import {
  sendMessage, sendMessageGetId, editMessage, answerCallback,
  sendTyping, setupBot, TelegramUpdate, InlineKeyboard,
  answerInlineQuery, InlineQueryResult,
} from "./telegram";
import {
  searchApps, getVariants, getAppInfo, resolveDownload,
  seedToken, getStoredToken, acquireToken,
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
  [{ text: "✕  Cancel", callback_data: "x", style: 1 as const }],
];

const variantsKb = (variants: Variant[]): InlineKeyboard => [
  ...variants.map((v, i) => ([{ text: v.label, callback_data: `v:${i}` }])),
  [{ text: "← Back to results", callback_data: "back" }],
  [{ text: "✕  Cancel", callback_data: "x", style: 1 as const }],
];

const downloadKb = (v: Variant): InlineKeyboard => {
  const rows: InlineKeyboard = [
    [{ text: `⬇️  Download${v.sizeLabel ? "  ·  " + v.sizeLabel : ""}`, url: v.downloadUrl }],
  ];
  if (v.isSplit && v.splits?.length) {
    v.splits.slice(0, 5).forEach(s =>
      rows.push([{ text: `⬇️  ${s.name}${s.size ? "  ·  " + (s.size / 1024 / 1024).toFixed(1) + " MB" : ""}`, url: s.url }])
    );
    // Share to another chat
    rows.push([{ text: "↗  Share this APK", switch_inline_query: v.packageName }]);
  }
  rows.push([{ text: "← Back to variants", callback_data: "back2" }]);
  rows.push([{ text: "✕  Done", callback_data: "x", style: 1 as const }]);
  return rows;
};

const errKb = (back: string, retry?: string): InlineKeyboard => [
  ...(retry ? [[{ text: "🔄  Try again", callback_data: retry }]] : []),
  [{ text: "← Back", callback_data: back }],
];

// ─── Message templates ───────────────────────────────────────────────────────

const WELCOME =
  `👋 <b>APK Mirror Bot</b>\n\n` +
  `Download APKs directly from Google Play.\n\n` +
  `<blockquote expandable>` +
  `<b>How to use:</b>\n` +
  `• Type any app name — <i>whatsapp, chrome, spotify</i>\n` +
  `• Or a package ID — <code>com.whatsapp</code>\n` +
  `• Use /info to look up any app by package name\n` +
  `• Works inline — type <code>@JtechMirrorBot</code> in any chat` +
  `</blockquote>`;

const resultsText = (q: string) =>
  `🔍 <b>Results for "${esc(q)}"</b>\n\nTap an app to see download options.`;

const variantsText = (name: string, dev: string) =>
  `📦 <b>${esc(name)}</b>\n<i>by ${esc(dev)}</i>\n\nChoose your architecture:`;

function downloadText(v: Variant, appName: string): string {
  const details = [
    v.arch && `Architecture  <code>${esc(v.arch)}</code>`,
    v.versionCode && `Build code  <code>${v.versionCode}</code>`,
    v.sizeLabel && `File size  <code>${v.sizeLabel}</code>`,
    v.isSplit && `Type  <code>Split APK</code>`,
  ].filter(Boolean).join("\n");

  return (
    `⬇️  <b>${esc(appName)}</b>\n\n` +
    `<blockquote>${details}</blockquote>\n` +
    (v.isSplit ? `\n<i>Split APK — use SAI or similar to install all parts.</i>\n` : "") +
    `\nTap below to download.`
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
    ctx.waitUntil(Promise.all([
      refreshVerifiedPool(env.RATE_KV, 8).catch(() => {}),
      // Auto-refresh tokens if expired or missing
      (async () => {
        
        const [t64, t32] = await Promise.all([
          getStoredToken(env.RATE_KV, "arm64"),
          getStoredToken(env.RATE_KV, "armeabi"),
        ]);
        if (!t64 || !t32) {
          const [a64, a32] = await Promise.allSettled([
            t64 ? null : acquireToken("arm64"),
            t32 ? null : acquireToken("armeabi"),
          ]);
          const tok64 = a64.status === "fulfilled" && a64.value ? a64.value : null;
          const tok32 = a32.status === "fulfilled" && a32.value ? a32.value : null;
          if (tok64 || tok32) {
            await seedToken(env.RATE_KV,
              tok64?.authToken ?? t64 ?? "",
              tok32?.authToken ?? t32 ?? "",
              tok64 ?? undefined, tok32 ?? undefined);
            console.log("cron: refreshed gplay tokens");
          }
        }
      })().catch(e => console.warn("cron: token refresh failed:", e)),
    ]));
  },

  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    // ── Full bot setup (webhook + commands + menu + profile)
    if (req.method === "GET" && url.pathname === "/setup") {
      try {
        const result = await setupBot(env.TELEGRAM_BOT_TOKEN, `${url.origin}/webhook`);
        return Response.json(result);
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

    // ── Test AuroraStore auth from this Worker
    if (req.method === "GET" && url.pathname === "/test-auth") {
      try {
        
        const result = await acquireToken("arm64");
        return Response.json({ ok: true, gsfId: result.gsfId, hasToken: !!result.authToken });
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 500 });
      }
    }

    // ── Auto-acquire and store tokens
    if (req.method === "POST" && url.pathname === "/auto-auth") {
      try {
        
        const [s64, s32] = await Promise.all([
          acquireToken("arm64").catch(e => ({ error: String(e) })),
          acquireToken("armeabi").catch(e => ({ error: String(e) })),
        ]);
        const arm64 = "authToken" in s64 ? s64 : null;
        const armeabi = "authToken" in s32 ? s32 : null;
        if (!arm64 && !armeabi) {
          return Response.json({ error: "Both acquisitions failed", arm64: s64, armeabi: s32 }, { status: 500 });
        }
        if (arm64 || armeabi) {
          await seedToken(env.RATE_KV,
            arm64 ? arm64.authToken : "",
            armeabi ? armeabi.authToken : "",
            arm64 ? { gsfId: arm64.gsfId, dfeCookie: arm64.dfeCookie, userAgent: arm64.userAgent, mccMnc: arm64.mccMnc } : undefined,
            armeabi ? { gsfId: armeabi.gsfId, dfeCookie: armeabi.dfeCookie, userAgent: armeabi.userAgent, mccMnc: armeabi.mccMnc } : undefined,
          );
        }
        return Response.json({ ok: true, arm64: !!arm64, armeabi: !!armeabi });
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
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, WELCOME,
      [[{ text: "🔍  Search an app", switch_inline_query_current_chat: "" }]]);
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

  // Empty query — show hint
  if (!q) {
    await answerInlineQuery(env.TELEGRAM_BOT_TOKEN, query.id, [], {
      cacheTime: 0,
      switchPmText: "Type an app name to search…",
      switchPmParam: "inline",
    });
    return;
  }

  const offset = parseInt(query.offset || "0", 10);
  const PAGE = 5;

  try {
    const allResults = await searchApps(env.RATE_KV, q);
    const page = allResults.slice(offset, offset + PAGE);

    const articles: InlineQueryResult[] = page.map(r => ({
      type: "article" as const,
      id: `${r.packageName}_${offset}`,
      title: r.name,
      description: `${r.developer}\n${r.packageName}${r.version ? "  ·  v" + r.version : ""}`,
      thumbnail_url: r.icon,
      thumbnail_width: 128,
      thumbnail_height: 128,
      input_message_content: {
        message_text:
          `📦 <b>${esc(r.name)}</b>\n` +
          `<i>by ${esc(r.developer)}</i>\n` +
          `<code>${esc(r.packageName)}</code>`,
        parse_mode: "HTML" as const,
        disable_web_page_preview: true,
      },
      reply_markup: {
        inline_keyboard: [
          [{ text: "⬇️  Get APK", callback_data: `pkg:${r.packageName}` }],
        ],
      },
    }));

    const nextOffset = offset + PAGE < allResults.length ? String(offset + PAGE) : "";

    await answerInlineQuery(env.TELEGRAM_BOT_TOKEN, query.id, articles, {
      cacheTime: 300,
      nextOffset,
      switchPmText: "Open full search",
      switchPmParam: encodeURIComponent(q).slice(0, 64),
    });
  } catch {
    await answerInlineQuery(env.TELEGRAM_BOT_TOKEN, query.id, [], { cacheTime: 0 });
  }
}

// ─── Callback handler ────────────────────────────────────────────────────────

async function handleCallback(cb: NonNullable<TelegramUpdate["callback_query"]>, env: Env): Promise<void> {
  const chatId = cb.from.id;
  const msgId = cb.message?.message_id;
  const data = cb.data ?? "";

  // Acknowledge immediately with context-aware toast
  const toastText =
    data === "x" ? "Cancelled" :
    data === "back" || data === "back2" ? "Going back…" :
    data.startsWith("r:") ? "Loading app…" :
    data.startsWith("v:") ? "Getting download link…" :
    data.startsWith("retry:") ? "Retrying…" :
    data.startsWith("pkg:") ? "Looking up app…" :
    "";
  await answerCallback(env.TELEGRAM_BOT_TOKEN, cb.id, toastText || undefined);
  if (!msgId) return;

  const session = await getSession(env.RATE_KV, chatId);

  // Cancel/done
  if (data === "x") {
    await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, msgId,
      "👍 Done. Type an app name whenever you're ready.");
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
