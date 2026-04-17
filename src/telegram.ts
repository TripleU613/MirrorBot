export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  from?: { id: number; username?: string };
  text?: string;
}

export async function sendMessage(
  token: string,
  chatId: number,
  text: string,
  parseMode: "HTML" | "Markdown" = "HTML"
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: parseMode,
        disable_web_page_preview: true,
      }),
    });

    if (res.ok) return;

    const body = await res.json().catch(() => ({})) as Record<string, unknown>;

    if (res.status === 429) {
      // Telegram rate limit — honour retry_after
      const retryAfter = (body?.parameters as Record<string, unknown>)?.retry_after;
      const waitMs = typeof retryAfter === "number" ? retryAfter * 1000 : 5000;
      await sleep(waitMs);
      continue;
    }

    // 400 usually means bad parse_mode or too-long message — retry with plain text
    if (res.status === 400 && parseMode !== "Markdown") {
      await sendMessage(token, chatId, text.replace(/<[^>]+>/g, ""), "Markdown");
      return;
    }

    throw new Error(`Telegram sendMessage failed: ${res.status} — ${JSON.stringify(body)}`);
  }
}

export async function setWebhook(token: string, url: string): Promise<unknown> {
  const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, drop_pending_updates: true }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`setWebhook failed: ${JSON.stringify(body)}`);
  return body;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
