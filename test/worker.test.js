import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorker, SeenUpdate } from "../worker.js";

// Все значения вымышлены. Настоящие Telegram и Workers AI не вызываются.
const token = "test-bot-token-never-use";
const secret = "test_webhook_secret_0123456789_abcdefgh";
const alice = 123456;
const bob = 234567;
const model = "@cf/google/gemma-4-26b-a4b-it";
const settings = {
  TELEGRAM_BOT_TOKEN: token,
  TELEGRAM_WEBHOOK_SECRET: secret,
  TELEGRAM_ALLOWED_USER_IDS: `${alice}, ${bob}`,
};

function update(userId = alice, text = "Хочу идею проекта на React", id = 100, chatType = "private") {
  const message = {
    from: { id: userId, is_bot: false },
    chat: { id: userId, type: chatType },
  };
  if (text !== null) message.text = text;
  return { update_id: id, message };
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

function makeStorage() {
  const values = new Map();
  return {
    values,
    alarmAt: null,
    kv: {
      get(key) { return values.get(key); },
      put(key, value) { values.set(key, value); },
    },
    async setAlarm(time) { this.alarmAt = time; },
    async deleteAll() { values.clear(); this.alarmAt = null; },
  };
}

// Здесь настоящая логика SeenUpdate, но хранилище полностью поддельное.
function fakeGuard() {
  const states = new Map();
  const objects = new Map();
  const claims = [];
  return {
    states,
    claims,
    idFromName(name) { return name; },
    get(name) {
      if (!objects.has(name)) {
        const storage = makeStorage();
        states.set(name, storage);
        objects.set(name, new SeenUpdate({ storage }));
      }
      return {
        async fetch(url, init) {
          claims.push(name);
          return objects.get(name).fetch(new Request(url, init));
        },
      };
    },
  };
}

function harness({ aiImpl, telegramImpl, guard = fakeGuard(), aiTimeoutMs = 22_000 } = {}) {
  const telegramCalls = [];
  const aiCalls = [];
  const tasks = [];
  const AI = {
    async run(name, input) {
      aiCalls.push({ name, input });
      if (aiImpl) return aiImpl(name, input);
      return { choices: [{ message: { content: "Давай разберёмся шаг за шагом." }, finish_reason: "stop" }] };
    },
  };
  const fetchImpl = async (url, options) => {
    telegramCalls.push({ url, options, body: JSON.parse(options.body) });
    if (telegramImpl) return telegramImpl(url, options);
    return Response.json({ ok: true });
  };
  const worker = createWorker({ fetchImpl, aiTimeoutMs });
  const env = { ...settings, AI, UPDATE_GUARD: guard };
  const ctx = { waitUntil(promise) { tasks.push(promise); } };
  return {
    worker, env, ctx, guard, tasks, aiCalls, telegramCalls,
    async done() { await Promise.all(tasks); },
    async send(item = update(), usedEnv = env, usedSecret = secret) {
      const response = await worker.fetch(webhook(item, usedSecret), usedEnv, ctx);
      await Promise.all(tasks);
      return response;
    },
  };
}

function assertNoBrokenSurrogates(text) {
  for (const character of text) {
    const code = character.codePointAt(0);
    assert.ok(!(code >= 0xd800 && code <= 0xdfff), "нельзя разделять эмодзи");
  }
}

test("публичная страница не раскрывает состояние секретов", async () => {
  const h = harness();
  for (const env of [h.env, {}]) {
    const response = await h.worker.fetch(new Request("https://worker.example/"), env, h.ctx);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.equal(text, "TeachingYou AI: Worker работает.");
    assert.ok(!text.includes(token));
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});

test("неизвестные адреса и методы возвращают 404", async () => {
  const h = harness();
  for (const req of [
    new Request("https://worker.example/telegram/webhook"),
    new Request("https://worker.example/", { method: "POST" }),
    new Request("https://worker.example/unknown"),
  ]) assert.equal((await h.worker.fetch(req, h.env, h.ctx)).status, 404);
});

test("неполная или неверная конфигурация закрывает webhook", async () => {
  const h = harness();
  for (const partial of [
    {},
    { ...h.env, TELEGRAM_BOT_TOKEN: "" },
    { ...h.env, TELEGRAM_WEBHOOK_SECRET: "too-short" },
    { ...h.env, TELEGRAM_ALLOWED_USER_IDS: "" },
    { ...h.env, TELEGRAM_ALLOWED_USER_IDS: `${alice},invalid` },
    { ...h.env, TELEGRAM_ALLOWED_USER_IDS: "9007199254740992" },
  ]) assert.equal((await h.worker.fetch(webhook(update()), partial, h.ctx)).status, 503);
  assert.equal(h.guard.claims.length, 0);
  assert.equal(h.aiCalls.length, 0);
  assert.equal(h.telegramCalls.length, 0);
});

test("неверный или отсутствующий секрет отклоняется до любого обращения к ИИ", async () => {
  const h = harness();
  for (const supplied of [null, "wrong", "x".repeat(secret.length), "z".repeat(257)]) {
    assert.equal((await h.worker.fetch(webhook(update(), supplied), h.env, h.ctx)).status, 403);
  }
  assert.equal(h.guard.claims.length, 0);
  assert.equal(h.aiCalls.length, 0);
  assert.equal(h.telegramCalls.length, 0);
});

test("запрещённые пользователи, группы, боты и чужой chat_id игнорируются", async () => {
  const h = harness();
  const variants = [
    update(345678),
    update(alice, "Привет", 101, "group"),
    { update_id: 102, message: { from: { id: alice, is_bot: true }, chat: { id: alice, type: "private" }, text: "Привет" } },
    { update_id: 103, message: { from: { id: alice, is_bot: false }, chat: { id: bob, type: "private" }, text: "Привет" } },
    { update_id: 104, edited_message: { text: "Изменение" } },
  ];
  for (const item of variants) assert.equal((await h.send(item)).status, 200);
  assert.equal(h.guard.claims.length, 0);
  assert.equal(h.aiCalls.length, 0);
  assert.equal(h.telegramCalls.length, 0);
});

test("разрешённому пользователю отвечает ИИ, а не эхо", async () => {
  const h = harness();
  const response = await h.send();
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "OK");
  assert.equal(h.aiCalls.length, 1);
  assert.equal(h.aiCalls[0].name, model);
  assert.deepEqual(h.aiCalls[0].input.messages.map((m) => m.role), ["system", "user"]);
  assert.equal(h.aiCalls[0].input.messages[1].content, "Хочу идею проекта на React");
  assert.equal(h.aiCalls[0].input.max_completion_tokens, 1024);
  assert.equal(h.aiCalls[0].input.chat_template_kwargs.enable_thinking, false);
  assert.equal(h.aiCalls[0].input.store, false);
  assert.equal(h.telegramCalls.length, 1);
  assert.equal(h.telegramCalls[0].url, `https://api.telegram.org/bot${token}/sendMessage`);
  assert.equal(h.telegramCalls[0].options.method, "POST");
  assert.equal(h.telegramCalls[0].options.redirect, "manual");
  assert.ok(h.telegramCalls[0].options.signal instanceof AbortSignal);
  assert.deepEqual(h.telegramCalls[0].body, { chat_id: alice, text: "Давай разберёмся шаг за шагом." });
});

test("webhook подтверждается до получения ответа нейросети", async () => {
  let resolveAi;
  const h = harness({ aiImpl: () => new Promise((resolve) => { resolveAi = resolve; }) });
  const response = await h.worker.fetch(webhook(update()), h.env, h.ctx);
  assert.equal(response.status, 200);
  assert.equal(h.telegramCalls.length, 0);
  assert.equal(h.tasks.length, 1);
  resolveAi({ choices: [{ message: { content: "Ответ готов" } }] });
  await h.done();
  assert.equal(h.telegramCalls[0].body.text, "Ответ готов");
});

test("два разрешённых пользователя получают ответы без общей истории", async () => {
  const h = harness();
  await h.send(update(alice, "Первый вопрос", 100));
  await h.send(update(bob, "Второй вопрос", 101));
  assert.deepEqual(h.telegramCalls.map((c) => c.body.chat_id), [alice, bob]);
  assert.deepEqual(h.aiCalls.map((c) => c.input.messages[1].content), ["Первый вопрос", "Второй вопрос"]);
  assert.ok(h.aiCalls.every((c) => c.input.messages.length === 2));
  assert.ok(!JSON.stringify(h.aiCalls[1].input).includes("Первый вопрос"));
});

test("/start и /help объясняют обработку и ограничения, не вызывая модель", async () => {
  const h = harness();
  await h.send(update(alice, "/start", 100));
  await h.send(update(alice, "/help", 101));
  assert.equal(h.aiCalls.length, 0);
  assert.match(h.telegramCalls[0].body.text, /Cloudflare Workers AI/);
  assert.match(h.telegramCalls[0].body.text, /не запоминаю/);
  assert.match(h.telegramCalls[0].body.text, /не присылай пароли/);
  assert.match(h.telegramCalls[1].body.text, /память, поиск и изображения/);
});

test("неизвестная команда, картинка и пустой текст не уходят в ИИ", async () => {
  const h = harness();
  const picture = update(alice, null, 101);
  picture.message.photo = [{ file_id: "fake" }];
  picture.message.caption = "описание";
  await h.send(update(alice, "/unknown", 100));
  await h.send(picture);
  await h.send(update(alice, "  ", 102));
  assert.equal(h.aiCalls.length, 0);
  assert.match(h.telegramCalls[0].body.text, /Не знаю такую команду/);
  assert.match(h.telegramCalls[1].body.text, /только с текстом/);
  assert.match(h.telegramCalls[2].body.text, /только с текстом/);
});

test("код или путь, начинающийся с косой черты, не считается командой", async () => {
  const h = harness();
  await h.send(update(alice, "/usr/bin/node — что это?", 103));
  assert.equal(h.aiCalls.length, 1);
  assert.equal(h.aiCalls[0].input.messages[1].content, "/usr/bin/node — что это?");
});

test("слишком длинный пользовательский текст отклоняется до вызова ИИ", async () => {
  const h = harness();
  await h.send(update(alice, "а".repeat(8001)));
  assert.equal(h.aiCalls.length, 0);
  assert.match(h.telegramCalls[0].body.text, /слишком длинное/);
});

test("формат response также поддерживается", async () => {
  const h = harness({ aiImpl: async () => ({ response: "Другой формат" }) });
  await h.send();
  assert.equal(h.telegramCalls[0].body.text, "Другой формат");
});

test("если модель сообщает об обрыве, пользователь получает предупреждение", async () => {
  const h = harness({ aiImpl: async () => ({ choices: [{ message: { content: "Неполный ответ" }, finish_reason: "length" }] }) });
  await h.send();
  assert.match(h.telegramCalls[0].body.text, /оборвался из-за ограничения длины/);
});

test("ошибка или лимит ИИ не раскрывают подробности, ключи и содержимое ошибки", async () => {
  for (const aiImpl of [
    async () => { throw new Error(`429 private ${token} ${secret}`); },
    async () => ({ choices: [{ message: { content: "" } }] }),
    async () => null,
  ]) {
    const h = harness({ aiImpl });
    const response = await h.send();
    assert.equal(response.status, 200);
    const text = h.telegramCalls[0].body.text;
    assert.match(text, /не удалось получить ответ/);
    assert.ok(!text.includes(token));
    assert.ok(!text.includes(secret));
    assert.ok(!text.includes("private"));
  }
});

test("отсутствие AI binding не превращается в раскрытие ошибки", async () => {
  const h = harness();
  const response = await h.send(update(), { ...h.env, AI: undefined });
  assert.equal(response.status, 200);
  assert.match(h.telegramCalls[0].body.text, /не удалось получить ответ/);
});

test("долгая модель получает тайм-аут и понятное сообщение", async () => {
  const h = harness({ aiTimeoutMs: 5, aiImpl: () => new Promise(() => {}) });
  const response = await h.send();
  assert.equal(response.status, 200);
  assert.match(h.telegramCalls[0].body.text, /не удалось получить ответ/);
  assert.equal(h.aiCalls.length, 1);
});

test("длинный ответ разбивается на части, не разрывая эмодзи", async () => {
  const output = "🙂".repeat(1800);
  const h = harness({ aiImpl: async () => ({ choices: [{ message: { content: output } }] }) });
  await h.send();
  const parts = h.telegramCalls.map((c) => c.body.text);
  assert.equal(parts.length, 2);
  assert.equal(parts.join(""), output);
  for (const part of parts) {
    assert.ok(part.length <= 3500);
    assertNoBrokenSurrogates(part);
  }
});

test("чрезмерно длинный ответ ограничен двумя сообщениями с пояснением", async () => {
  const h = harness({ aiImpl: async () => ({ response: "🙂".repeat(7000) }) });
  await h.send();
  assert.equal(h.telegramCalls.length, 2);
  assert.match(h.telegramCalls[1].body.text, /Ответ сокращён/);
  for (const call of h.telegramCalls) {
    assert.ok(call.body.text.length <= 3500);
    assertNoBrokenSurrogates(call.body.text);
  }
});

test("неправильный JSON и пустое тело отклоняются", async () => {
  const h = harness();
  assert.equal((await h.worker.fetch(webhook("{ broken"), h.env, h.ctx)).status, 400);
  assert.equal((await h.worker.fetch(webhook(""), h.env, h.ctx)).status, 400);
  assert.equal(h.guard.claims.length, 0);
  assert.equal(h.aiCalls.length, 0);
});

test("слишком большой запрос отклоняется по заголовку и реальному размеру", async () => {
  const h = harness();
  const announced = await h.worker.fetch(webhook("{}", secret, { "Content-Length": "131073" }), h.env, h.ctx);
  const actual = await h.worker.fetch(webhook("x".repeat(131073)), h.env, h.ctx);
  assert.equal(announced.status, 413);
  assert.equal(actual.status, 413);
  assert.equal(h.guard.claims.length, 0);
});

test("для разрешённого пользователя необходим корректный update_id", async () => {
  const h = harness();
  for (const id of [undefined, null, 0, -1, "100", 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const item = update();
    item.update_id = id;
    assert.equal((await h.send(item)).status, 400);
  }
  assert.equal(h.guard.claims.length, 0);
  assert.equal(h.aiCalls.length, 0);
});

test("ошибка хранилища до подтверждения webhook возвращает 503 без ИИ", async () => {
  for (const guard of [undefined, null, { idFromName() { throw new Error("private"); } }]) {
    const h = harness();
    const response = await h.send(update(), { ...h.env, UPDATE_GUARD: guard });
    assert.equal(response.status, 503);
    assert.ok(!(await response.text()).includes("private"));
    assert.equal(h.aiCalls.length, 0);
    assert.equal(h.telegramCalls.length, 0);
  }
});

test("повторная и параллельная доставка одного update_id вызывает ИИ один раз", async () => {
  const h = harness();
  const responses = await Promise.all(Array.from({ length: 8 }, () => h.worker.fetch(webhook(update()), h.env, h.ctx)));
  assert.ok(responses.every((r) => r.status === 200));
  await h.done();
  assert.equal(h.guard.claims.length, 8);
  assert.equal(h.aiCalls.length, 1);
  assert.equal(h.telegramCalls.length, 1);
});

test("разные update_id обрабатываются отдельно, даже с одинаковым текстом", async () => {
  const h = harness();
  await h.send(update(alice, "Привет", 100));
  await h.send(update(alice, "Привет", 101));
  assert.equal(h.aiCalls.length, 2);
  assert.equal(h.telegramCalls.length, 2);
});

test("SeenUpdate сохраняет только метку, планирует очистку и очищает данные", async () => {
  const storage = makeStorage();
  const obj = new SeenUpdate({ storage });
  const req = () => new Request("https://updates.internal/claim", { method: "POST" });
  assert.equal((await obj.fetch(req())).status, 201);
  assert.deepEqual([...storage.values], [["seen", true]]);
  const hours = (storage.alarmAt - Date.now()) / 3_600_000;
  assert.ok(hours > 47.9 && hours <= 48);
  assert.equal((await new SeenUpdate({ storage }).fetch(req())).status, 200);
  await obj.alarm();
  assert.equal(storage.values.size, 0);
  assert.equal((await obj.fetch(req())).status, 201);
});

test("ошибка Telegram после подтверждения не раскрывает токен и не запускает повтор автоматически", async () => {
  const h = harness({ telegramImpl: async (url) => { throw new Error(`private ${url}`); } });
  const first = await h.send();
  const duplicate = await h.send();
  assert.equal(first.status, 200);
  assert.equal(duplicate.status, 200);
  assert.ok(!(await first.text()).includes(token));
  assert.equal(h.aiCalls.length, 1);
  assert.equal(h.telegramCalls.length, 1);
});

test("Telegram ok:false останавливает дальнейшие части ответа", async () => {
  const h = harness({
    aiImpl: async () => ({ response: "x".repeat(8000) }),
    telegramImpl: async () => Response.json({ ok: false, description: `private ${token}` }),
  });
  await h.send();
  assert.equal(h.telegramCalls.length, 1);
});

test("без waitUntil webhook не подтверждается и ИИ не вызывается", async () => {
  const h = harness();
  const response = await h.worker.fetch(webhook(update()), h.env, undefined);
  assert.equal(response.status, 503);
  assert.equal(h.guard.claims.length, 0);
  assert.equal(h.aiCalls.length, 0);
});
