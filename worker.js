// Учебный этап 1: безопасное подключение к Telegram без ИИ и базы данных.
// Значения секретов не записываются в код и не отправляются в ответах.

const WEBHOOK_PATH = "/telegram/webhook";
const TELEGRAM_SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";
const MAX_UPDATE_BYTES = 128 * 1024;
const MAX_ECHO_UNITS = 3500;
const encoder = new TextEncoder();

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

  // В Workers есть специальное сравнение, устойчивое к атакам по времени.
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

// Ограничиваем ответ, не разрывая пары Unicode, например в эмодзи.
function shortenText(text) {
  let result = "";
  for (const character of text) {
    if (result.length + character.length > MAX_ECHO_UNITS) break;
    result += character;
  }
  return result.length < text.length ? `${result}…` : result;
}

function makeReply(message) {
  if (typeof message.text !== "string" || !message.text.trim()) {
    return "Пока я умею работать только с текстом. Поддержку изображений добавим позже.";
  }

  const text = message.text.trim();
  const command = text.split(/\s+/, 1)[0].split("@", 1)[0].toLowerCase();
  if (command === "/start") {
    return "Привет! Я TeachingYou AI. Пока это проверка подключения: пришли текст, и я повторю его. ИИ ещё не подключён.";
  }
  if (command === "/help") {
    return "Сейчас я проверяю связь с Telegram. Напиши любое текстовое сообщение.";
  }
  return `Получено: ${shortenText(text)}`;
}

async function sendTelegramMessage(fetchImpl, token, chatId, text) {
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      // Токен находится в адресе Telegram API: не следуем перенаправлениям.
      redirect: "manual",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return false;
    const data = await response.json();
    return data?.ok === true;
  } catch {
    // Ошибку и URL не выводим: URL Telegram API содержит токен бота.
    return false;
  }
}

async function handleWebhook(request, env, fetchImpl) {
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

  const sent = await sendTelegramMessage(fetchImpl, token, chatId, makeReply(message));
  return sent ? reply("OK") : reply("Не удалось отправить ответ", 502);
}

// В тестах можно подставить проверочный fetch вместо настоящего запроса в Telegram.
export function createWorker({ fetchImpl = fetch } = {}) {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/") {
        // Публичная страница не сообщает посторонним, какие секреты настроены.
        return reply("TeachingYou AI: Worker работает.");
      }

      if (request.method === "POST" && url.pathname === WEBHOOK_PATH) {
        return handleWebhook(request, env, fetchImpl);
      }

      return reply("Пока не настроено", 404);
    },
  };
}

export default createWorker();
