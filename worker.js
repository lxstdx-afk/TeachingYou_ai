// TeachingYou AI: private Telegram webhook, per-user durable chats and memory.
// No prompts, file URLs, API keys, or provider errors are written to logs.
import { extractPhoto, answerCallback, sendReply } from "./src/telegram.js";
import { UserConversations } from "./src/conversations.js";
import { SearchBudget } from "./src/search.js";
export { UserConversations, SearchBudget };

const WEBHOOK_PATH = "/telegram/webhook";
const TELEGRAM_SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";
const MAX_UPDATE_BYTES = 128 * 1024;
const UPDATE_TTL_MS = 48 * 60 * 60 * 1000;
const encoder = new TextEncoder();

function reply(body, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}
function validSecret(value) { return typeof value === "string" && /^[A-Za-z0-9_-]{32,256}$/.test(value); }
function parseAllowedUserIds(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const ids = value.split(",").map((id) => id.trim());
  if (!ids.every((id) => /^[1-9]\d{0,15}$/.test(id) && Number.isSafeInteger(Number(id)))) return null;
  return new Set(ids);
}
async function secretsMatch(actual, expected) {
  if (typeof actual !== "string" || actual.length > 256) return false;
  const a = encoder.encode(actual), b = encoder.encode(expected);
  if (a.byteLength !== b.byteLength) return false;
  if (typeof crypto.subtle.timingSafeEqual === "function") return crypto.subtle.timingSafeEqual(a, b);
  const key = await crypto.subtle.importKey("raw", b, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  const sig = await crypto.subtle.sign("HMAC", key, b);
  return crypto.subtle.verify("HMAC", key, sig, a);
}
class UpdateTooLarge extends Error {}
async function readUpdate(request) {
  const len = request.headers.get("Content-Length");
  if (len && /^\d+$/.test(len) && Number(len) > MAX_UPDATE_BYTES) throw new UpdateTooLarge();
  if (!request.body) throw new Error("empty");
  const reader = request.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0, text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_UPDATE_BYTES) { try { await reader.cancel(); } catch {} throw new UpdateTooLarge(); }
    text += decoder.decode(value, { stream: true });
  }
  return JSON.parse(text + decoder.decode());
}

// Kept to preserve the existing v1 migration and to clean up old v1 alarms.
// New updates are deduplicated atomically inside each user's conversation DO.
export class SeenUpdate {
  constructor(state) { this.state = state; }
  async fetch(request) {
    if (request.method !== "POST") return reply("Method not allowed", 405);
    const kv = this.state.storage.kv;
    if (kv.get("seen") === true) return reply("duplicate");
    await this.state.storage.setAlarm(Date.now() + UPDATE_TTL_MS);
    if (kv.get("seen") === true) return reply("duplicate");
    kv.put("seen", true);
    return reply("accepted", 201);
  }
  async alarm() { await this.state.storage.deleteAll(); }
}

function getEvent(update, allowed) {
  const callback = update?.callback_query;
  const message = callback ? callback.message : update?.message;
  const sender = callback ? callback.from : message?.from;
  const userId = sender?.id, chatId = message?.chat?.id;
  if (!Number.isSafeInteger(userId) || userId <= 0 || !Number.isSafeInteger(chatId) || chatId !== userId ||
      sender?.is_bot === true || message?.chat?.type !== "private" || !allowed.has(String(userId))) return null;
  if (callback) {
    if (typeof callback.id !== "string" || callback.id.length > 256 || typeof callback.data !== "string" || callback.data.length > 64) return null;
    return { updateId: update.update_id, chatId, kind: "callback", data: callback.data, callbackId: callback.id };
  }
  const text = typeof message?.text === "string" ? message.text : (typeof message?.caption === "string" ? message.caption : "");
  return { updateId: update.update_id, chatId, kind: "message", text: text.slice(0, 8001), photo: extractPhoto(message) };
}

async function handleWebhook(request, env, ctx, fetchImpl) {
  const token = env.TELEGRAM_BOT_TOKEN, secret = env.TELEGRAM_WEBHOOK_SECRET;
  const allowed = parseAllowedUserIds(env.TELEGRAM_ALLOWED_USER_IDS);
  if (typeof token !== "string" || !token || !validSecret(secret) || !allowed) return reply("Telegram пока не настроен", 503);
  if (!(await secretsMatch(request.headers.get(TELEGRAM_SECRET_HEADER), secret))) return reply("Доступ запрещён", 403);
  let update;
  try { update = await readUpdate(request); }
  catch (error) { return error instanceof UpdateTooLarge ? reply("Слишком большой запрос", 413) : reply("Некорректный запрос", 400); }
  const event = getEvent(update, allowed);
  if (!event) return reply("OK");
  if (!Number.isSafeInteger(update.update_id) || update.update_id <= 0) return reply("Некорректный запрос", 400);
  if (!env.USER_CHATS || !ctx || typeof ctx.waitUntil !== "function") return reply("Временно недоступно", 503);
  try {
    const stub = env.USER_CHATS.get(env.USER_CHATS.idFromName(String(event.chatId)));
    const res = await stub.fetch("https://user.internal/enqueue", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(event),
    });
    if (res.status === 429) {
      ctx.waitUntil(sendReply(fetchImpl, token, event.chatId, "Сейчас очередь сообщений заполнена. Подожди немного и отправь сообщение ещё раз.").catch(() => {}));
    } else if (![200, 201].includes(res.status)) return reply("Временно недоступно", 503);
    if (event.callbackId) ctx.waitUntil(answerCallback(fetchImpl, token, event.callbackId).catch(() => {}));
    return reply("OK");
  } catch { return reply("Временно недоступно", 503); }
}

export function createWorker({ fetchImpl = fetch } = {}) {
  return { async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") return reply("TeachingYou AI: Worker работает.");
    if (request.method === "POST" && url.pathname === WEBHOOK_PATH) return handleWebhook(request, env, ctx, fetchImpl);
    return reply("Пока не настроено", 404);
  } };
}
export default createWorker();
