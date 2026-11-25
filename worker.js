// Учебный этап 2: Telegram + текстовая модель Cloudflare Workers AI.
// Секреты и содержимое переписки не записываются в исходный код и логи.

const WEBHOOK_PATH = "/telegram/webhook";
const TELEGRAM_SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";
const MODEL = "@cf/google/gemma-4-26b-a4b-it";
const MAX_UPDATE_BYTES = 128 * 1024;
const MAX_INPUT_UNITS = 8000;
const MAX_TELEGRAM_UNITS = 3500;
const MAX_REPLY_PARTS = 2;
// После подтверждения webhook waitUntil работает до 30 с: оставляем время
// на два запроса к Telegram и небольшой запас.
const AI_TIMEOUT_MS = 22_000;
const TELEGRAM_TIMEOUT_MS = 3_000;
const UPDATE_TTL_MS = 48 * 60 * 60 * 1000;
const encoder = new TextEncoder();

const SYSTEM_PROMPT = [
  "Ты TeachingYou AI — дружелюбный наставник по программированию для новичков.",
  "Отвечай по-русски, понятным языком и небольшими шагами.",
  "Объясняй, зачем нужны действия, и при необходимости показывай примеры кода.",
  "Не выдумывай результаты запуска кода или проверки сайтов; отмечай неопределённость.",
  "В этой версии у тебя нет памяти предыдущих сообщений, доступа в интернет и возможности видеть изображения.",
  "Не утверждай обратное; если контекста недостаточно, попроси пользователя его прислать.",
].join(" ");

const AI_UNAVAILABLE = "Сейчас не удалось получить ответ от нейросети. Возможно, сервис временно недоступен или исчерпан бесплатный лимит. Попробуй позже.";

function reply(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

// Настройка Telegram допускает буквы, цифры, дефис и подчёркивание.
// Минимум 32 символа — дополнительное требование этого проекта.
function isValidWebhookSecret(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{32,256}$/.test(value);
}

function parseAllowedUserIds(value) {
  if (typeof value !== "string" || !value.trim()) return null;

  const ids = value.split(",").map((id) => id.trim());
  const valid = ids.every((id) => {
    if (!/^[1-9]\d{0,15}$/.test(id)) return false;
    return Number.isSafeInteger(Number(id));
  });

  // Ошибка в списке закрывает доступ, а не разрешает его всем.
  return valid ? new Set(ids) : null;
}

async function secretsMatch(actual, expected) {
  if (typeof actual !== "string" || actual.length > 256) return false;
  const actualBytes = encoder.encode(actual);
  const expectedBytes = encoder.encode(expected);
  if (actualBytes.byteLength !== expectedBytes.byteLength) return false;

  if (typeof crypto.subtle.timingSafeEqual === "function") {
    return crypto.subtle.timingSafeEqual(actualBytes, expectedBytes);
  }

  // Стандартный Web Crypto нужен для запуска локальных тестов в Node.js.
  const key = await crypto.subtle.importKey(
    "raw",
    expectedBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, expectedBytes);
  return crypto.subtle.verify("HMAC", key, signature, actualBytes);
}

class UpdateTooLarge extends Error {}

async function readUpdate(request) {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_UPDATE_BYTES) {
    throw new UpdateTooLarge();
  }
  if (!request.body) throw new Error("Empty request");

  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let text = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_UPDATE_BYTES) {
      try { await reader.cancel(); } catch { /* Тело уже закрыто. */ }
      throw new UpdateTooLarge();
    }
    text += decoder.decode(value, { stream: true });
  }

  text += decoder.decode();
  return JSON.parse(text);
}

// SQLite-backed Durable Object: одна маленькая отметка на один update_id.
// Переписка здесь не хранится. Будильник очищает отметку примерно через 48 часов.
export class SeenUpdate {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    if (request.method !== "POST") return reply("Method not allowed", 405);
    const kv = this.state.storage.kv;
    if (kv.get("seen") === true) return reply("duplicate");

    // Сначала планируем очистку. После асинхронной операции повторно проверяем
    // отметку: за время ожидания другой запрос мог принять то же обновление.
    await this.state.storage.setAlarm(Date.now() + UPDATE_TTL_MS);
    if (kv.get("seen") === true) return reply("duplicate");
    kv.put("seen", true);
    return reply("accepted", 201);
  }

  async alarm() {
    await this.state.storage.deleteAll();
  }
}

async function claimUpdate(namespace, updateId) {
  try {
    if (!namespace || typeof namespace.idFromName !== "function") return null;
    const id = namespace.idFromName(String(updateId));
    const response = await namespace.get(id).fetch("https://updates.internal/claim", { method: "POST" });
    if (response.status === 201) return true;
    if (response.status === 200) return false;
    return null;
  } catch {
    // Не выводим исключения платформы: в них могут оказаться приватные данные.
    return null;
  }
}

function commandReply(message) {
  if (typeof message.text !== "string" || !message.text.trim()) {
    return "Пока я умею работать только с текстом. Поддержку скриншотов добавим позже.";
  }

  const text = message.text.trim();
  const command = text.split(/\s+/, 1)[0].split("@", 1)[0].toLowerCase();
  if (command === "/start") {
    return "Привет! Я TeachingYou AI — наставник по программированию. Задай вопрос текстом. Для ответа твой текст передаётся в Cloudflare Workers AI — не присылай пароли и ключи. Пока я не запоминаю прошлые сообщения и не умею искать в интернете или смотреть картинки.";
  }
  if (command === "/help") {
    return "Напиши вопрос о программировании, коде или обучении. Текст передаётся в Cloudflare Workers AI, поэтому не присылай пароли и ключи. Пока каждое сообщение обрабатывается отдельно; память, поиск и изображения добавим позже.";
  }
  // Путь к файлу /usr/bin или регулярное выражение /.../ — это не команда.
  if (/^\/[a-z0-9_]{1,32}(?:@[a-z0-9_]{5,32})?(?:\s|$)/i.test(text)) {
    return "Не знаю такую команду. Напиши вопрос обычным текстом или отправь /help.";
  }
  if (text.length > MAX_INPUT_UNITS) {
    return "Сообщение слишком длинное. Пожалуйста, раздели его на части и отправь одну часть с вопросом.";
  }
  return null;
}

async function withTimeout(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("AI timeout")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function askAi(env, text, timeoutMs) {
  try {
    if (!env.AI || typeof env.AI.run !== "function") return AI_UNAVAILABLE;
    const result = await withTimeout(env.AI.run(MODEL, {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: text },
      ],
      max_completion_tokens: 1024,
      chat_template_kwargs: { enable_thinking: false },
      store: false,
    }), timeoutMs);

    // У актуальных моделей Workers AI ответ имеет формат Chat Completions.
    // Старый формат response поддерживаем как запасной формат результата.
    const answer = result?.choices?.[0]?.message?.content ?? result?.response;
    if (typeof answer !== "string" || !answer.trim()) return AI_UNAVAILABLE;
    if (result?.choices?.[0]?.finish_reason === "length") {
      return `${answer.trim()}\n\n… Ответ модели оборвался из-за ограничения длины. Попроси объяснить нужную часть отдельно.`;
    }
    return answer.trim();
  } catch {
    // Не логируем ошибки, содержащие ответ провайдера, сообщения или секреты.
    return AI_UNAVAILABLE;
  }
}

// Telegram ограничивает длину сообщения; не разрезаем суррогатные пары Unicode.
function splitReply(text) {
  const parts = [];
  const source = text.trim();
  let start = 0;
  while (start < source.length && parts.length < MAX_REPLY_PARTS) {
    let end = Math.min(start + MAX_TELEGRAM_UNITS, source.length);
    if (end < source.length) {
      const previous = source.charCodeAt(end - 1);
      const next = source.charCodeAt(end);
      if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
      const newline = source.lastIndexOf("\n", end - 1);
      if (newline >= start + Math.floor(MAX_TELEGRAM_UNITS / 2)) end = newline + 1;
    }
    const part = source.slice(start, end);
    if (part.trim()) parts.push(part);
    start = end;
  }
  if (start < source.length && parts.length) {
    const notice = "\n\n… Ответ сокращён.";
    let last = parts[parts.length - 1];
    if (last.length + notice.length > MAX_TELEGRAM_UNITS) {
      let end = MAX_TELEGRAM_UNITS - notice.length;
      if (end > 0 && last.charCodeAt(end - 1) >= 0xd800 && last.charCodeAt(end - 1) <= 0xdbff) end--;
      last = last.slice(0, end);
    }
    parts[parts.length - 1] = last + notice;
  }
  return parts;
}

async function sendTelegramMessage(fetchImpl, token, chatId, text) {
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      // Токен находится в адресе Telegram API: не следуем перенаправлениям.
      redirect: "manual",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    const data = await response.json();
    return data?.ok === true;
  } catch {
    // URL Telegram API содержит токен бота, поэтому исключение не выводим.
    return false;
  }
}

async function answerMessage(message, chatId, env, fetchImpl, aiTimeoutMs) {
  const answer = commandReply(message) ?? await askAi(env, message.text.trim(), aiTimeoutMs);
  for (const part of splitReply(answer)) {
    // Не повторяем отправку после неопределённой сетевой ошибки: Telegram мог
    // успеть принять сообщение, а повтор привёл бы к дублю.
    if (!(await sendTelegramMessage(fetchImpl, env.TELEGRAM_BOT_TOKEN, chatId, part))) break;
  }
}

async function handleWebhook(request, env, fetchImpl, ctx, aiTimeoutMs) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  const allowedIds = parseAllowedUserIds(env.TELEGRAM_ALLOWED_USER_IDS);

  if (typeof token !== "string" || !token || !isValidWebhookSecret(secret) || !allowedIds) {
    return reply("Telegram пока не настроен", 503);
  }

  const header = request.headers.get(TELEGRAM_SECRET_HEADER);
  if (!(await secretsMatch(header, secret))) return reply("Доступ запрещён", 403);

  let update;
  try {
    update = await readUpdate(request);
  } catch (error) {
    return error instanceof UpdateTooLarge
      ? reply("Слишком большой запрос", 413)
      : reply("Некорректный запрос", 400);
  }

  const message = update?.message;
  const userId = message?.from?.id;
  const chatId = message?.chat?.id;

  // Игнорируем группы, другие типы событий, ботов и незнакомых пользователей.
  if (
    !Number.isSafeInteger(userId) ||
    !Number.isSafeInteger(chatId) ||
    userId <= 0 ||
    chatId !== userId ||
    message?.from?.is_bot === true ||
    message?.chat?.type !== "private" ||
    !allowedIds.has(String(userId))
  ) {
    return reply("OK");
  }

  if (!Number.isSafeInteger(update?.update_id) || update.update_id <= 0) {
    return reply("Некорректный запрос", 400);
  }
  if (!ctx || typeof ctx.waitUntil !== "function") return reply("Временно недоступно", 503);

  const claimed = await claimUpdate(env.UPDATE_GUARD, update.update_id);
  if (claimed === null) return reply("Временно недоступно", 503);
  if (!claimed) return reply("OK");

  // Быстро подтверждаем webhook Telegram, а ответ готовим в течение waitUntil.
  // Непредвиденные исключения подавляем без записи персональных данных в лог.
  ctx.waitUntil(answerMessage(message, chatId, env, fetchImpl, aiTimeoutMs).catch(() => {}));
  return reply("OK");
}

// В тестах можно подставить фиктивный Telegram API и короткий тайм-аут.
export function createWorker({ fetchImpl = fetch, aiTimeoutMs = AI_TIMEOUT_MS } = {}) {
  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/") {
        return reply("TeachingYou AI: Worker работает.");
      }

      if (request.method === "POST" && url.pathname === WEBHOOK_PATH) {
        return handleWebhook(request, env, fetchImpl, ctx, aiTimeoutMs);
      }

      return reply("Пока не настроено", 404);
    },
  };
}

export default createWorker();
