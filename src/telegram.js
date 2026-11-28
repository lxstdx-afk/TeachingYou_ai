import { formatReply } from "./format.js";
import { isSafeBook } from "./books.js";
import { buildReminderMessage } from "./reminders.js";
import { abortAfter, readBytes, readJson } from "./net.js";

// A short Telegram command list; the existing power-user commands continue to
// work even when they are not registered in this visible list.
export const BOT_COMMANDS = [
  { command: "menu", description: "Разделы и кнопки" },
  { command: "new", description: "Создать новый чат" },
  { command: "chats", description: "Выбрать чат" },
  { command: "remind", description: "Подготовить напоминание Telegram" },
  { command: "help", description: "Как пользоваться ботом" },
];

const TELEGRAM_TIMEOUT_MS = 8_000;
const TYPING_REFRESH_MS = 4_000;
const TYPING_TIMEOUT_MS = 1_500;
// Preserve the Workers Free subrequest budget during unusually long tasks.
const MAX_TYPING_PULSES = 20;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

async function telegramPost(fetchImpl, token, method, body, signal = undefined) {
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST", redirect: "manual",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: signal ?? abortAfter(TELEGRAM_TIMEOUT_MS),
    });
    const data = await readJson(response, 64 * 1024).catch(() => null);
    return { ok: response.ok && data?.ok === true, status: response.status, data };
  } catch { return { ok: false, uncertain: true }; }
}

export async function answerCallback(fetchImpl, token, queryId) {
  if (typeof queryId !== "string" || queryId.length > 256) return;
  await telegramPost(fetchImpl, token, "answerCallbackQuery", { callback_query_id: queryId });
}

// Configure only an authenticated private chat, never the webhook or token.
// Telegram prefers a chat+language list to the chat fallback. Refresh Russian
// and the language Telegram reported for this user as well as the fallback.
// If the user's language changes later, another /start updates that scope.
export async function configureMenu(fetchImpl, token, chatId, languageCode = "") {
  const scope = { type: "chat", chat_id: chatId };
  const language = typeof languageCode === "string" ? languageCode.match(/^([a-z]{2})(?:-[a-z0-9]{2,8})*$/i)?.[1]?.toLowerCase() : "";
  const languages = new Set(["ru", ...(language ? [language] : [])]);
  const requests = [
    telegramPost(fetchImpl, token, "setMyCommands", { scope, commands: BOT_COMMANDS }),
    ...[...languages].map((code) => telegramPost(fetchImpl, token, "setMyCommands", { scope, language_code: code, commands: BOT_COMMANDS })),
    telegramPost(fetchImpl, token, "setChatMenuButton", { chat_id: chatId, menu_button: { type: "commands" } }),
  ];
  const results = await Promise.all(requests);
  return results.every((r) => r.ok);
}

export async function sendBook(fetchImpl, token, chatId, book) {
  if (!isSafeBook(book)) return { ok: false };
  const header = [
    `📚 ${String(book.title).slice(0, 180)}`,
    book.author ? `Автор / атрибуция: ${String(book.author).slice(0, 120)}` : "",
  ].filter(Boolean);
  const extra = [book.year && String(book.year).slice(0, 10), book.language && `Язык по каталогу: ${String(book.language).slice(0, 60)}`,
    book.volume && `Том: ${String(book.volume).slice(0, 40)}`, book.pages && `${book.pages} стр.`,
    book.scanCount && `${book.scanCount} сканов в записи`, `${(book.size / 1_000_000).toFixed(1)} МБ`].filter(Boolean).join(" · ");
  const legal = [
    `Источник: ${book.sourceUrl}`,
    `Условия: ${book.license.label}${book.license.url ? ` — ${book.license.url}` : ""}`,
  ];
  // If the source URL is unusually long, omit optional edition details rather
  // than refusing an otherwise valid document or truncating attribution.
  let details = [...header, extra, ...legal].filter(Boolean).join("\n");
  if (details.length > 1024) details = [...header, ...legal].join("\n");
  if (details.length > 1024) return { ok: false };
  // Telegram fetches the catalogue's public PDF URL itself. Never retry an
  // ambiguous sendDocument failure: the file may already have arrived.
  return telegramPost(fetchImpl, token, "sendDocument", {
    chat_id: chatId, document: book.url, caption: details, reply_markup: { remove_keyboard: true },
  }, abortAfter(35_000));
}

// Telegram's status expires after about five seconds. It is a chat action, not
// a message, and is refreshed only while the current answer is being prepared.
export function startTyping(fetchImpl, token, chatId, requestedAction = "typing") {
  const action = requestedAction === "upload_document" ? "upload_document" : "typing";
  let active = true, interval, pending = null, controller = null, deadline = null, attempts = 0;
  const pulse = () => {
    if (!active || pending || attempts >= MAX_TYPING_PULSES) return; // Never overlap or queue status requests.
    if (++attempts >= MAX_TYPING_PULSES) clearInterval(interval);
    const request = new AbortController();
    controller = request;
    const timeout = setTimeout(() => request.abort(), TYPING_TIMEOUT_MS);
    deadline = timeout;
    const current = telegramPost(fetchImpl, token, "sendChatAction", { chat_id: chatId, action }, request.signal)
      .finally(() => {
        clearTimeout(timeout);
        if (deadline === timeout) deadline = null;
        if (controller === request) controller = null;
        if (pending === current) pending = null;
      });
    pending = current;
  };
  interval = setInterval(pulse, TYPING_REFRESH_MS);
  pulse();
  return async () => {
    if (!active) return;
    active = false;
    clearInterval(interval);
    clearTimeout(deadline);
    deadline = null;
    controller?.abort();
    // Do not let a stuck status request delay an answer indefinitely. Native
    // fetch normally settles as soon as its signal is aborted.
    if (pending) {
      let guard;
      await Promise.race([pending, new Promise((resolve) => { guard = setTimeout(resolve, 100); })]);
      clearTimeout(guard);
    }
  };
}

// A date entity opens Telegram's own reminder UI; it does NOT schedule a bot
// message. Never retry an ambiguous send: it may already have reached Telegram.
export async function sendNativeReminder(fetchImpl, token, chatId, reminder, replyMarkup = undefined) {
  let message;
  try { message = buildReminderMessage(reminder?.text, reminder?.at); }
  catch { return false; }
  const body = { chat_id: chatId, ...message };
  if (replyMarkup) body.reply_markup = replyMarkup;
  const result = await telegramPost(fetchImpl, token, "sendMessage", body);
  if (result.ok) return true;
  if (result.status === 400 && /entit|parse|date/i.test(String(result.data?.description || ""))) {
    const entity = message.entities[0];
    const utc = message.text.slice(entity.offset, entity.offset + entity.length);
    const fallback = `🔔 ${reminder.text.trim()}\n\n⏰ ${utc}\n\nTelegram не принял интерактивную дату: напоминание не создано. Открой «Избранное», напиши текст и выбери напоминание через меню кнопки отправки. Время выше указано в UTC: пересчитай его на свой часовой пояс.`;
    return (await telegramPost(fetchImpl, token, "sendMessage", { chat_id: chatId, text: fallback, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) })).ok;
  }
  return false;
}

export async function sendReply(fetchImpl, token, chatId, markdown, replyMarkup = undefined) {
  const parts = formatReply(markdown);
  if (!parts.length) return false;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const body = { chat_id: chatId, text: part.text };
    if (part.entities.length) body.entities = part.entities;
    if (replyMarkup && i === parts.length - 1) body.reply_markup = replyMarkup;
    let result = await telegramPost(fetchImpl, token, "sendMessage", body);
    // A definite Telegram 400 rejecting entities means the first attempt did not
    // send. Never retry an ambiguous network failure or other 400 responses.
    if (!result.ok && result.status === 400 && body.entities && /entit|parse/i.test(String(result.data?.description || ""))) {
      const { entities: _ignored, ...plain } = body;
      result = await telegramPost(fetchImpl, token, "sendMessage", plain);
    }
    if (!result.ok) return false;
  }
  return true;
}

export function extractPhoto(message) {
  if (Array.isArray(message?.photo) && message.photo.length) {
    const sizes = message.photo.filter((p) => typeof p?.file_id === "string" && p.file_id.length <= 512 &&
      (!Number.isFinite(p.file_size) || p.file_size <= MAX_IMAGE_BYTES));
    if (!sizes.length) return { error: "large" };
    const best = sizes.sort((a, b) => ((b.width || 0) * (b.height || 0)) - ((a.width || 0) * (a.height || 0)))[0];
    return { fileId: best.file_id };
  }
  const doc = message?.document;
  if (doc && /^image\/(?:jpeg|png|webp)$/i.test(doc.mime_type || "")) {
    if (Number.isFinite(doc.file_size) && doc.file_size > MAX_IMAGE_BYTES) return { error: "large" };
    if (typeof doc.file_id === "string" && doc.file_id.length <= 512) return { fileId: doc.file_id };
  }
  return null;
}

function mimeFromMagic(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && [0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a].every((n, i) => bytes[i] === n)) return "image/png";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  return null;
}

function toBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

export async function downloadPhoto(fetchImpl, token, fileId) {
  try {
    const file = await telegramPost(fetchImpl, token, "getFile", { file_id: fileId });
    if (!file.ok) return null;
    const data = file.data.result;
    if (Number.isFinite(data?.file_size) && data.file_size > MAX_IMAGE_BYTES) return null;
    const path = data?.file_path;
    // The token must never be sent to an arbitrary host or redirected.
    if (typeof path !== "string" || path.length > 500 || !/^[A-Za-z0-9_./-]+$/.test(path) || path.startsWith("/") || path.split("/").some((p) => !p || p === "." || p === "..")) return null;
    const response = await fetchImpl(`https://api.telegram.org/file/bot${token}/${path}`, { redirect: "manual", signal: abortAfter(TELEGRAM_TIMEOUT_MS) });
    if (!response.ok) { try { await response.body?.cancel(); } catch {} return null; }
    const bytes = await readBytes(response, MAX_IMAGE_BYTES);
    const mime = mimeFromMagic(bytes);
    if (!mime) return null;
    return `data:${mime};base64,${toBase64(bytes)}`;
  } catch { return null; }
}
