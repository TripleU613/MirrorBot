import { sendMessage, setWebhook, TelegramUpdate } from "./telegram";
import { searchApps, getVariants, resolveDownload } from "./apkmirror";

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  CF_CLEARANCE?: string;   // optional: seed a cf_clearance cookie for hard-gated pages
  RATE_KV: KVNamespace;
}

// --- session state (in-memory per isolate, backed by KV for persistence) --

type Session = { step: "idle" | "awaiting_variant"; results?: import("./apkmirror").AppResult[] };
const sessions = new Map<number, Session>();

// --- router --------------------------------------------------------------

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // Webhook registration helper: GET /setup
    if (req.method === "GET" && url.pathname === "/setup") {
      const workerUrl = `${url.origin}/webhook`;
      const result = await setWebhook(env.TELEGRAM_BOT_TOKEN, workerUrl);
      return Response.json(result);
    }

    // Telegram webhook: POST /webhook
    if (req.method === "POST" && url.pathname === "/webhook") {
      const update: TelegramUpdate = await req.json();
      await handleUpdate(update, env);
      return new Response("ok");
    }

    return new Response("MirrorBot running.", { status: 200 });
  },
};

// --- update handler ------------------------------------------------------

async function handleUpdate(update: TelegramUpdate, env: Env): Promise<void> {
  const msg = update.message;
  if (!msg?.text) return;

  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const session: Session = sessions.get(chatId) ?? { step: "idle" };

  try {
    if (text.startsWith("/start") || text.startsWith("/help")) {
      await sendMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        `<b>MirrorBot</b> — APKMirror search\n\n` +
          `/search &lt;app name&gt; — find an app\n` +
          `/dl &lt;apkmirror URL&gt; — resolve direct download link\n` +
          `/cancel — reset`
      );
      sessions.set(chatId, { step: "idle" });
      return;
    }

    if (text.startsWith("/cancel")) {
      sessions.set(chatId, { step: "idle" });
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Cancelled.");
      return;
    }

    if (text.startsWith("/search ") || text.startsWith("/s ")) {
      const query = text.replace(/^\/(search|s)\s+/, "").trim();
      if (!query) {
        await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Usage: /search &lt;app name&gt;");
        return;
      }

      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `Searching for <i>${escHtml(query)}</i>…`);

      const results = await searchApps(env.RATE_KV, query, env.CF_CLEARANCE);

      if (!results.length) {
        await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "No results found.");
        return;
      }

      sessions.set(chatId, { step: "awaiting_variant", results });

      const lines = results.map(
        (r, i) => `${i + 1}. <b>${escHtml(r.name)}</b> — ${escHtml(r.developer)}`
      );
      await sendMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        lines.join("\n") + "\n\nReply with a number to see variants."
      );
      return;
    }

    // User picked a number from search results
    if (session.step === "awaiting_variant" && /^\d+$/.test(text)) {
      const idx = parseInt(text, 10) - 1;
      const results = session.results ?? [];
      if (idx < 0 || idx >= results.length) {
        await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Invalid number.");
        return;
      }

      const app = results[idx];
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `Fetching variants for <b>${escHtml(app.name)}</b>…`);

      const variants = await getVariants(env.RATE_KV, app.url, env.CF_CLEARANCE);
      sessions.set(chatId, { step: "idle" });

      if (!variants.length) {
        await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "No variants found. Try /dl with a direct URL.");
        return;
      }

      const lines = variants.map(
        (v, i) =>
          `${i + 1}. v${escHtml(v.version)} | ${escHtml(v.arch)} | Android ${escHtml(v.minAndroid)} | ${escHtml(v.dpi)}\n` +
          `   <a href="${escHtml(v.downloadPageUrl)}">download page</a>`
      );
      await sendMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        `<b>${escHtml(app.name)}</b> variants:\n\n` + lines.join("\n\n")
      );
      return;
    }

    if (text.startsWith("/dl ")) {
      const dlUrl = text.replace(/^\/dl\s+/, "").trim();
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Resolving download link…");
      const link = await resolveDownload(env.RATE_KV, dlUrl, env.CF_CLEARANCE);
      if (link) {
        await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `<a href="${escHtml(link)}">Direct download link</a>`);
      } else {
        await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Could not resolve download link. The page may require a cf_clearance cookie.");
      }
      return;
    }

    // Unknown input
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Type /help for commands.");
  } catch (err) {
    console.error(err);
    await sendMessage(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      `Error: ${err instanceof Error ? escHtml(err.message) : "unknown"}`
    );
  }
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
