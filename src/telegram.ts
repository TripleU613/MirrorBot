// Telegram Bot API helpers

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: CallbackQuery;
  inline_query?: InlineQuery;
}

export interface InlineQuery {
  id: string;
  from: { id: number };
  query: string;
  offset: string;
}

export interface InlineQueryResult {
  type: "article" | "photo";
  id: string;
  title: string;
  description?: string;
  thumb_url?: string;
  input_message_content?: { message_text: string; parse_mode?: "HTML" | "Markdown" };
  reply_markup?: { inline_keyboard: InlineKeyboard };
}

export interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  from?: { id: number; username?: string };
  text?: string;
}

export interface CallbackQuery {
  id: string;
  from: { id: number };
  message?: TelegramMessage;
  data?: string;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export type InlineKeyboard = InlineKeyboardButton[][];

// --- API call helper ----------------------------------------------------

async function tgCall(token: string, method: string, body: unknown): Promise<unknown> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (res.ok) return res.json();

    const resp = await res.json().catch(() => ({})) as Record<string, unknown>;

    if (res.status === 429) {
      const retryAfter = (resp?.parameters as Record<string, unknown>)?.retry_after;
      await sleep(typeof retryAfter === "number" ? retryAfter * 1000 : 5000);
      continue;
    }

    // 400 on editMessageText often means "message not modified" — not a real error
    if (res.status === 400) {
      const desc = String((resp as Record<string, unknown>).description ?? "");
      if (desc.includes("message is not modified")) return resp;
    }

    throw new Error(`Telegram ${method} failed: ${res.status} — ${JSON.stringify(resp)}`);
  }
  throw new Error(`Telegram ${method}: too many retries`);
}

// --- Public API ---------------------------------------------------------

export async function sendMessage(
  token: string,
  chatId: number,
  text: string,
  keyboard?: InlineKeyboard
): Promise<TelegramMessage> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
  return tgCall(token, "sendMessage", body) as Promise<TelegramMessage>;
}

export async function editMessage(
  token: string,
  chatId: number,
  messageId: number,
  text: string,
  keyboard?: InlineKeyboard
): Promise<void> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
  else body.reply_markup = { inline_keyboard: [] };
  await tgCall(token, "editMessageText", body);
}

export async function answerCallback(
  token: string,
  callbackQueryId: string,
  text?: string
): Promise<void> {
  await tgCall(token, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text: text ?? "",
    show_alert: false,
  });
}

export async function sendTyping(token: string, chatId: number): Promise<void> {
  await tgCall(token, "sendChatAction", { chat_id: chatId, action: "typing" });
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

// --- sendMessage result type --------------------------------------------

interface SendResult { result: { message_id: number } }

export async function sendMessageGetId(
  token: string,
  chatId: number,
  text: string,
  keyboard?: InlineKeyboard
): Promise<number> {
  const r = await tgCall(token, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  }) as SendResult;
  return r.result.message_id;
}

export async function answerInlineQuery(
  token: string,
  queryId: string,
  results: InlineQueryResult[],
  cacheTime = 60
): Promise<void> {
  await tgCall(token, "answerInlineQuery", {
    inline_query_id: queryId,
    results,
    cache_time: cacheTime,
    is_personal: false,
  }).catch(() => {});
}

export async function setWebhookWithInline(token: string, url: string): Promise<unknown> {
  const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, drop_pending_updates: true, allowed_updates: ["message", "callback_query", "inline_query"] }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`setWebhook failed: ${JSON.stringify(body)}`);
  return body;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
