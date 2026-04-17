import { sendMessage, setWebhook, TelegramUpdate } from "./telegram";
import { searchApps, getVariants, resolveDownload, CfBlockedError } from "./apkmirror";

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  RATE_KV: KVNamespace;
}

type Session = { step: "idle" | "awaiting_variant"; results?: import("./apkmirror").AppResult[] };

const WORKER_TIMEOUT_MS = 25000;

// --- KV-backed session helpers ------------------------------------------

async function getSession(kv: KVNamespace, chatId: number): Promise<Session> {
  try {
    const raw = await kv.get(`session:${chatId}`);
    if (raw) return JSON.parse(raw) as Session;
  } catch { /* ignore */ }
  return { step: "idle" };
}

async function saveSession(kv: KVNamespace, chatId: number, session: Session): Promise<void> {
  try {
    await kv.put(`session:${chatId}`, JSON.stringify(session), { expirationTtl: 600 });
  } catch (e) {
    console.warn("index: failed to save session:", e);
  }
}

// --- router --------------------------------------------------------------

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/setup") {
      const workerUrl = `${url.origin}/webhook`;
      try {
        const result = await setWebhook(env.TELEGRAM_BOT_TOKEN, workerUrl);
        return Response.json(result);
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 500 });
      }
    }

    if (req.method === "POST" && url.pathname === "/webhook") {
      let update: TelegramUpdate;
      try {
        update = await req.json() as TelegramUpdate;
      } catch (e) {
        console.error("index: malformed webhook JSON:", e);
        return new Response("ok"); // always 200 to Telegram
      }

      // Race against Worker CPU deadline
      await Promise.race([
        handleUpdate(update, env),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error("Worker timeout")), WORKER_TIMEOUT_MS)
        ),
      ]).catch(e => console.error("index: handleUpdate error:", e));

      return new Response("ok");
    }

    return new Response("MirrorBot running.", { status: 200 });
  },
};

// --- update handler ------------------------------------------------------

async function handleUpdate(update: TelegramUpdate, env: Env): Promise<void> {
  const msg = update.message;
  if (!msg?.text || !msg?.chat?.id) return;

  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const session = await getSession(env.RATE_KV, chatId);

  try {
    if (text.startsWith("/start") || text.startsWith("/help")) {
      await sendMessage(
        env.TELEGRAM_BOT_TOKEN, chatId,
        `<b>MirrorBot</b> — APKMirror search\n\n` +
        `/search &lt;app name&gt; — find an app\n` +
        `/dl &lt;apkmirror URL&gt; — resolve direct download link\n` +
        `/cancel — reset`
      );
      await saveSession(env.RATE_KV, chatId, { step: "idle" });
      return;
    }

    if (text.startsWith("/cancel")) {
      await saveSession(env.RATE_KV, chatId, { step: "idle" });
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Cancelled.");
      return;
    }

    if (text.startsWith("/search ") || text.startsWith("/s ")) {
      const query = text.replace(/^\/(search|s)\s+/, "").trim();
      if (!query) {
        await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Usage: /search &lt;app name&gt;");
        return;
      }

      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `Searching for <i>${esc(query)}</i>…`);

      const results = await searchApps(env.RATE_KV, query);

      if (!results.length) {
        await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "No results found. Try a different search term.");
        return;
      }

      await saveSession(env.RATE_KV, chatId, { step: "awaiting_variant", results });

      const lines = results.map((r, i) => `${i + 1}. <b>${esc(r.name)}</b> — ${esc(r.developer)}`);
      await sendMessage(
        env.TELEGRAM_BOT_TOKEN, chatId,
        lines.join("\n") + "\n\nReply with a number to see variants."
      );
      return;
    }

    // User picked a result number
    if (session.step === "awaiting_variant" && /^\d+$/.test(text)) {
      const idx = parseInt(text, 10) - 1;
      const results = session.results ?? [];
      if (idx < 0 || idx >= results.length) {
        await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `Pick a number between 1 and ${results.length}.`);
        return;
      }

      const app = results[idx];
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `Fetching variants for <b>${esc(app.name)}</b>…`);

      const variants = await getVariants(env.RATE_KV, app.url);
      await saveSession(env.RATE_KV, chatId, { step: "idle" });

      if (!variants.length) {
        await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "No variants found. Try /dl with a direct APKMirror URL.");
        return;
      }

      const lines = variants.map(
        (v, i) =>
          `${i + 1}. v${esc(v.version)} | ${esc(v.arch)} | Android ${esc(v.minAndroid)} | ${esc(v.dpi)}\n` +
          `   <a href="${esc(v.downloadPageUrl)}">download page</a>`
      );
      await sendMessage(
        env.TELEGRAM_BOT_TOKEN, chatId,
        `<b>${esc(app.name)}</b> variants:\n\n` + lines.join("\n\n")
      );
      return;
    }

    if (text.startsWith("/dl ")) {
      const dlUrl = text.replace(/^\/dl\s+/, "").trim();
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Resolving download link…");
      const link = await resolveDownload(env.RATE_KV, dlUrl);
      if (link) {
        await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `<a href="${esc(link)}">Direct download link</a>`);
      } else {
        await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Could not resolve the download link. Try the download page URL directly.");
      }
      return;
    }

    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Type /help for commands.");
  } catch (err) {
    const isBlocked = err instanceof CfBlockedError;
    const userMsg = isBlocked
      ? "APKMirror is blocking requests right now. Try again in a minute."
      : `Error: ${err instanceof Error ? esc(err.message) : "unknown error"}`;

    console.error("index: handler error:", err);
    try {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, userMsg);
    } catch (e2) {
      console.error("index: failed to send error message to user:", e2);
    }
  }
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
