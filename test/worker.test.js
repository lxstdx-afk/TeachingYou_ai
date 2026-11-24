import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorker } from "../worker.js";

// Все значения здесь вымышленные: настоящих токенов и пользовательских ID нет.
const token = "test-bot-token-never-use";
const secret = "test_webhook_secret_0123456789_abcdefgh";
const alice = 123456;
const bob = 234567;
const env = {
  TELEGRAM_BOT_TOKEN: token,
  TELEGRAM_WEBHOOK_SECRET: secret,
  TELEGRAM_ALLOWED_USER_IDS: `${alice}, ${bob}`,
};

function update(userId = alice, text = "Хочу идею проекта на React", chatType = "private") {
  const message = {
    from: { id: userId, is_bot: false },
    chat: { id: userId, type: chatType },
  };
  if (text !== null) message.text = text;
  return { update_id: 100, message };
}

function webhook(body, suppliedSecret = secret, extraHeaders = {}) {
  const headers = { "Content-Type": "application/json", ...extraHeaders };
  if (suppliedSecret !== null) headers["X-Telegram-Bot-Api-Secret-Token"] = suppliedSecret;
  return new Request("https://worker.example/telegram/webhook", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function fakeTelegram(result = { ok: true }) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { calls, worker: createWorker({ fetchImpl }) };
}

function root() {
  return new Request("https://worker.example/");
}

test("публичная страница сообщает только о работе Worker, но не о секретах", async () => {
  const { worker } = fakeTelegram();
  const response = await worker.fetch(root(), env);
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.equal(text, "TeachingYou AI: Worker работает.");
  assert.ok(!text.includes(token));
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("публичная страница не раскрывает и отсутствие токена", async () => {
  const { worker } = fakeTelegram();
  const response = await worker.fetch(root(), {});
  assert.equal(await response.text(), "TeachingYou AI: Worker работает.");
});

test("неизвестные адреса и методы возвращают 404", async () => {
  const { worker } = fakeTelegram();
  const url = "https://worker.example/telegram/webhook";
  assert.equal((await worker.fetch(new Request(url), env)).status, 404);
  assert.equal((await worker.fetch(new Request("https://worker.example/", { method: "POST" }), env)).status, 404);
  assert.equal((await worker.fetch(new Request("https://worker.example/unknown"), env)).status, 404);
});

test("без полного набора настроек webhook закрыт и не обращается в Telegram", async () => {
  for (const partial of [
    {},
    { ...env, TELEGRAM_BOT_TOKEN: "" },
    { ...env, TELEGRAM_WEBHOOK_SECRET: "too-short" },
    { ...env, TELEGRAM_ALLOWED_USER_IDS: "" },
    { ...env, TELEGRAM_ALLOWED_USER_IDS: `${alice},invalid` },
  ]) {
    const { worker, calls } = fakeTelegram();
    const response = await worker.fetch(webhook(update()), partial);
    assert.equal(response.status, 503);
    assert.equal(calls.length, 0);
  }
});

test("отсутствующий и неверный секретный заголовок отклоняются", async () => {
  for (const supplied of [null, "wrong", "x".repeat(secret.length)]) {
    const { worker, calls } = fakeTelegram();
    const response = await worker.fetch(webhook(update(), supplied), env);
    assert.equal(response.status, 403);
    assert.equal(calls.length, 0);
  }
});

test("разрешённому пользователю возвращается его текст", async () => {
  const { worker, calls } = fakeTelegram();
  const response = await worker.fetch(webhook(update()), env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "OK");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.telegram.org/bot${token}/sendMessage`);
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.redirect, "manual");
  assert.deepEqual(calls[0].body, {
    chat_id: alice,
    text: "Получено: Хочу идею проекта на React",
  });
});

test("второй разрешённый пользователь тоже получает ответ", async () => {
  const { worker, calls } = fakeTelegram();
  const response = await worker.fetch(webhook(update(bob, "Привет")), env);
  assert.equal(response.status, 200);
  assert.equal(calls[0].body.chat_id, bob);
  assert.equal(calls[0].body.text, "Получено: Привет");
});

test("неразрешённый пользователь не вызывает отправку сообщения", async () => {
  const { worker, calls } = fakeTelegram();
  const response = await worker.fetch(webhook(update(345678)), env);
  assert.equal(response.status, 200);
  assert.equal(calls.length, 0);
});

test("сообщения из групп, от ботов и с чужим chat_id игнорируются", async () => {
  const variants = [
    update(alice, "Привет", "group"),
    { update_id: 1, message: { from: { id: alice, is_bot: true }, chat: { id: alice, type: "private" }, text: "Привет" } },
    { update_id: 2, message: { from: { id: alice, is_bot: false }, chat: { id: bob, type: "private" }, text: "Привет" } },
    { update_id: 3, edited_message: { text: "Изменение" } },
  ];
  for (const item of variants) {
    const { worker, calls } = fakeTelegram();
    const response = await worker.fetch(webhook(item), env);
    assert.equal(response.status, 200);
    assert.equal(calls.length, 0);
  }
});

test("/start честно сообщает, что ИИ ещё не подключён", async () => {
  const { worker, calls } = fakeTelegram();
  await worker.fetch(webhook(update(alice, "/start")), env);
  assert.match(calls[0].body.text, /ИИ ещё не подключён/);
});

test("нетекстовое сообщение получает объяснение об ограничении", async () => {
  const { worker, calls } = fakeTelegram();
  await worker.fetch(webhook(update(alice, null)), env);
  assert.match(calls[0].body.text, /только с текстом/);
});

test("длинный ответ ограничивается без обрыва эмодзи", async () => {
  const { worker, calls } = fakeTelegram();
  await worker.fetch(webhook(update(alice, "🙂".repeat(3000))), env);
  const text = calls[0].body.text;
  assert.ok(text.length < 4096);
  assert.ok(text.endsWith("…"));
  assert.equal(text.includes("\ufffd"), false);
});

test("неправильный JSON и пустое тело отклоняются", async () => {
  const { worker, calls } = fakeTelegram();
  const badJson = await worker.fetch(webhook("{ broken"), env);
  assert.equal(badJson.status, 400);
  const empty = await worker.fetch(webhook(""), env);
  assert.equal(empty.status, 400);
  assert.equal(calls.length, 0);
});

test("слишком большой запрос отклоняется по заголовку и по фактическому размеру", async () => {
  const { worker, calls } = fakeTelegram();
  const announced = await worker.fetch(webhook("{}", secret, { "Content-Length": "131073" }), env);
  assert.equal(announced.status, 413);
  const actual = await worker.fetch(webhook("x".repeat(131073)), env);
  assert.equal(actual.status, 413);
  assert.equal(calls.length, 0);
});

test("ошибка Telegram не раскрывает токен или ответ API", async () => {
  const { worker } = fakeTelegram({ ok: false, description: `sensitive ${token}` });
  const response = await worker.fetch(webhook(update()), env);
  const body = await response.text();
  assert.equal(response.status, 502);
  assert.ok(!body.includes(token));
  assert.ok(!body.includes(secret));
  assert.ok(!body.includes("sensitive"));
});

test("сетевое исключение не раскрывает адрес с токеном", async () => {
  const worker = createWorker({ fetchImpl: async (url) => { throw new Error(url); } });
  const response = await worker.fetch(webhook(update()), env);
  const text = await response.text();
  assert.equal(response.status, 502);
  assert.ok(!text.includes(token));
  assert.ok(!text.includes(secret));
});
