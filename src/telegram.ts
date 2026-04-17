// Telegram Bot API helpers — full feature set

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: CallbackQuery;
  inline_query?: InlineQuery;
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

export interface InlineQuery {
  id: string;
  from: { id: number };
  query: string;
  offset: string;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
  switch_inline_query?: string;
  switch_inline_query_current_chat?: string;
  style?: 0 | 1;  // 0=default, 1=destructive (red)
}

export type InlineKeyboard = InlineKeyboardButton[][];

export interface InlineQueryResult {
  type: "article" | "photo";
  id: string;
  title: string;
  description?: string;
  thumbnail_url?: string;
  thumbnail_width?: number;
  thumbnail_height?: number;
  input_message_content?: {
    message_text: string;
    parse_mode?: "HTML" | "MarkdownV2";
    disable_web_page_preview?: boolean;
  };
  reply_markup?: { inline_keyboard: InlineKeyboard };
}

// ─── Core API call ────────────────────────────────────────────────────────────

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
      const after = (resp?.parameters as Record<string, unknown>)?.retry_after;
      await sleep(typeof after === "number" ? after * 1000 : 5000);
      continue;
    }

    if (res.status === 400) {
      const desc = String((resp as Record<string, unknown>).description ?? "");
      if (desc.includes("message is not modified")) return resp;
      if (desc.includes("query is too old")) return resp; // inline query expired
    }

    throw new Error(`Telegram ${method} ${res.status}: ${JSON.stringify(resp)}`);
  }
  throw new Error(`Telegram ${method}: too many retries`);
}

// ─── Messaging ───────────────────────────────────────────────────────────────

export async function sendMessage(
  token: string, chatId: number, text: string,
  keyboard?: InlineKeyboard, opts?: { protect?: boolean }
): Promise<TelegramMessage> {
  const body: Record<string, unknown> = {
    chat_id: chatId, text, parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  };
  if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
  if (opts?.protect) body.protect_content = true;
  return tgCall(token, "sendMessage", body) as Promise<TelegramMessage>;
}

interface SendResult { result: { message_id: number } }

export async function sendMessageGetId(
  token: string, chatId: number, text: string, keyboard?: InlineKeyboard
): Promise<number> {
  const r = await tgCall(token, "sendMessage", {
    chat_id: chatId, text, parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  }) as SendResult;
  return r.result.message_id;
}

export async function editMessage(
  token: string, chatId: number, messageId: number,
  text: string, keyboard?: InlineKeyboard
): Promise<void> {
  await tgCall(token, "editMessageText", {
    chat_id: chatId, message_id: messageId, text, parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: keyboard ?? [] },
  });
}

// ─── Callbacks ───────────────────────────────────────────────────────────────

export async function answerCallback(
  token: string, id: string, text?: string, showAlert = false
): Promise<void> {
  await tgCall(token, "answerCallbackQuery", {
    callback_query_id: id,
    text: text ?? "",
    show_alert: showAlert,
    cache_time: 0,
  });
}

// ─── Typing ──────────────────────────────────────────────────────────────────

export async function sendTyping(token: string, chatId: number): Promise<void> {
  await tgCall(token, "sendChatAction", { chat_id: chatId, action: "typing" });
}

// ─── Inline queries ──────────────────────────────────────────────────────────

export async function answerInlineQuery(
  token: string, queryId: string, results: InlineQueryResult[],
  opts?: { cacheTime?: number; nextOffset?: string; switchPmText?: string; switchPmParam?: string }
): Promise<void> {
  await tgCall(token, "answerInlineQuery", {
    inline_query_id: queryId,
    results,
    cache_time: opts?.cacheTime ?? 300,
    is_personal: true,
    next_offset: opts?.nextOffset ?? "",
    ...(opts?.switchPmText ? { button: { text: opts.switchPmText, start_parameter: opts.switchPmParam ?? "inline" } } : {}),
  }).catch(() => {});
}

// ─── Bot setup ───────────────────────────────────────────────────────────────

export async function setupBot(token: string, webhookUrl: string): Promise<unknown> {
  const BASE = `https://api.telegram.org/bot${token}`;

  const [webhook] = await Promise.all([
    // Webhook with all needed update types
    fetch(`${BASE}/setWebhook`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: webhookUrl,
        drop_pending_updates: true,
        allowed_updates: ["message", "callback_query", "inline_query"],
      }),
    }).then(r => r.json()),

    // Commands for private chats — full set
    fetch(`${BASE}/setMyCommands`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commands: [
          { command: "start",  description: "Welcome & how to use" },
          { command: "info",   description: "Get app info: /info com.package.name" },
          { command: "help",   description: "Help & FAQ" },
        ],
        scope: { type: "all_private_chats" },
      }),
    }),

    // Commands for groups — minimal
    fetch(`${BASE}/setMyCommands`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commands: [
          { command: "start", description: "Search APKs" },
          { command: "help",  description: "Help" },
        ],
        scope: { type: "all_group_chats" },
      }),
    }),

    // Menu button — show commands
    fetch(`${BASE}/setChatMenuButton`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ menu_button: { type: "commands" } }),
    }),

    // Bot name + description
    fetch(`${BASE}/setMyName`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "APK Mirror Bot" }),
    }),

    fetch(`${BASE}/setMyDescription`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description:
          "Download APKs from Google Play.\n\n" +
          "• Type any app name or package ID to search\n" +
          "• Works inline — type @JtechMirrorBot in any chat\n" +
          "• Use /info com.package.name for quick app details",
      }),
    }),

    fetch(`${BASE}/setMyShortDescription`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ short_description: "Search Google Play & get direct APK links. Works inline." }),
    }),
  ]);

  return webhook;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
