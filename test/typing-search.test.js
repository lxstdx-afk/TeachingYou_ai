import { test } from "node:test";
import assert from "node:assert/strict";
import { startTyping } from "../src/telegram.js";
import { ALICE, BOB, makeHarness } from "./harness.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));
const statuses = (h) => h.calls.filter((c) => c.url.endsWith("/sendChatAction"));
async function consent(h, user = ALICE, first = 1) {
  await h.send(h.message(user, "/start", first));
  await h.send(h.message(user, "✅ Согласен(на), начать", first + 1));
}
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test("статус отправляется сразу, обновляется и останавливается до ответа", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    return Response.json({ ok: true, result: true });
  };
  const stop = startTyping(fetchImpl, "fake", ALICE);
  await flush();
  assert.deepEqual(calls.map((c) => c.body), [{ chat_id: ALICE, action: "typing" }]);
  t.mock.timers.tick(4_000); await flush();
  t.mock.timers.tick(4_000); await flush();
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.url.endsWith("/sendChatAction")));
  await stop();
  t.mock.timers.tick(20_000); await flush();
  assert.equal(calls.length, 3);
  await stop(); // Cleanup is idempotent.
});

test("длительное ожидание ограничивает число статусов для бесплатного тарифа", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let calls = 0;
  const stop = startTyping(async () => { calls++; return Response.json({ ok: true }); }, "fake", ALICE);
  await flush();
  for (let i = 0; i < 30; i++) { t.mock.timers.tick(4_000); await flush(); }
  assert.equal(calls, 20);
  await stop();
  t.mock.timers.tick(8_000); await flush();
  assert.equal(calls, 20);
});

test("зависшая отправка статуса прерывается и не задерживает ответ", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let signal, release, calls = 0;
  // This intentionally ignores abort: cleanup must remain bounded even then.
  const f = (_url, options) => {
    calls++; signal = options.signal;
    return new Promise((resolve) => { release = resolve; });
  };
  const stop = startTyping(f, "fake", ALICE);
  const stopping = stop();
  assert.equal(signal.aborted, true);
  t.mock.timers.tick(100); await stopping;
  t.mock.timers.tick(12_000); await flush();
  assert.equal(calls, 1);
  release(Response.json({ ok: true })); await flush();
});

test("таймаут статуса не создаёт параллельные запросы и позволяет обновление", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const signals = [];
  const f = (_url, options) => {
    signals.push(options.signal);
    return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  };
  const stop = startTyping(f, "fake", ALICE);
  t.mock.timers.tick(1_500); await flush();
  assert.equal(signals[0].aborted, true);
  t.mock.timers.tick(2_500); await flush();
  assert.equal(signals.length, 2);
  const done = stop(); await done;
  assert.equal(signals[1].aborted, true);
});

test("во время долгого ИИ-ответа статус виден, после ответа больше не обновляется", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const gate = deferred(), started = deferred();
  const h = makeHarness({ aiImpl: async () => {
    started.resolve(); await gate.promise;
    return { choices: [{ message: { content: "Короткий ответ." }, finish_reason: "stop" }] };
  } });
  await consent(h);
  assert.equal(statuses(h).length, 0); // Consent and fast commands do not fake activity.
  await h.send(h.message(ALICE, "Расскажи, пожалуйста", 3), { run: false });
  const running = h.user().alarm();
  await started.promise; await flush();
  assert.equal(statuses(h).length, 1);
  assert.deepEqual(statuses(h)[0].body, { chat_id: ALICE, action: "typing" });
  t.mock.timers.tick(4_000); await flush();
  assert.equal(statuses(h).length, 2);
  gate.resolve(); await running; await h.drain();
  assert.equal(h.telegram().at(-1).body.text, "Короткий ответ.");
  const replyIndex = h.calls.findLastIndex((c) => c.url.endsWith("/sendMessage"));
  assert.ok(h.calls.indexOf(statuses(h).at(-1)) < replyIndex);
  t.mock.timers.tick(12_000); await flush();
  assert.equal(statuses(h).length, 2);
});

test("статус остаётся включён во время ручного поиска, источники приходят одним ответом", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const gate = deferred(), started = deferred();
  const h = makeHarness({ networkImpl: async (url, _options, body) => {
    if (url === "https://api.tavily.com/search") {
      assert.equal(body.query, "текущая версия Node.js");
      started.resolve(); await gate.promise;
      return Response.json({ results: [{ title: "Официальный источник", url: "https://nodejs.org/en/about/releases/", content: "Сведения о версиях." }] });
    }
    return null;
  } });
  await consent(h);
  const messagesBefore = h.telegram().length;
  await h.send(h.message(ALICE, "/search текущая версия Node.js", 3), { run: false });
  const running = h.user().alarm();
  await started.promise; await flush();
  assert.equal(statuses(h).length, 1);
  assert.equal(h.telegram().length, messagesBefore); // No intermediate status message.
  t.mock.timers.tick(4_000); await flush();
  assert.equal(statuses(h).length, 2);
  gate.resolve(); await running; await h.drain();
  assert.equal(h.telegram().length, messagesBefore + 1);
  assert.match(h.telegram().at(-1).body.text, /Источники:/);
  assert.match(h.telegram().at(-1).body.text, /nodejs\.org/);
  t.mock.timers.tick(8_000); await flush();
  assert.equal(statuses(h).length, 2);
});

test("автоматический поиск тоже проходит с индикатором и даёт источники", async () => {
  const h = makeHarness({ aiImpl: async (_model, input) => {
    const last = input.messages.at(-1).content;
    if (typeof last === "string" && last.includes("Результаты поиска")) {
      return { choices: [{ message: { content: "По найденным источникам [1]." }, finish_reason: "stop" }] };
    }
    return { choices: [{ message: { content: null, tool_calls: [{ function: { name: "web_search", arguments: '{"query":"актуальная версия Node.js"}' } }] } }] };
  } });
  await consent(h);
  const before = h.telegram().length;
  await h.send(h.message(ALICE, "Нужна актуальная версия Node", 3));
  assert.equal(statuses(h).length, 1);
  assert.equal(statuses(h)[0].body.action, "typing");
  assert.ok(h.calls.some((c) => c.url === "https://api.tavily.com/search" && c.body.query === "актуальная версия Node.js"));
  assert.equal(h.telegram().length, before + 1);
  assert.match(h.telegram().at(-1).body.text, /Источники:/);
});

test("если Telegram отклонил статус, бот всё равно выдаёт ответ", async () => {
  const h = makeHarness({ networkImpl: async (url) => url.endsWith("/sendChatAction")
    ? Response.json({ ok: false, description: "Too Many Requests" }, { status: 429 }) : null });
  await consent(h);
  await h.send(h.message(ALICE, "Нужен ответ", 3));
  assert.equal(statuses(h).length, 1);
  assert.match(h.telegram().at(-1).body.text, /Давай разберём/);
});

test("статус останавливается и при неожиданной ошибке генерации", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = makeHarness(); await consent(h);
  await h.send(h.message(ALICE, "Вопрос", 3), { run: false });
  h.user().generate = async () => { throw new Error("test failure"); };
  await assert.rejects(h.user().alarm(), /test failure/);
  const count = statuses(h).length;
  assert.equal(count, 1);
  t.mock.timers.tick(12_000); await flush();
  assert.equal(statuses(h).length, count);
  assert.equal(h.user().rows("SELECT COUNT(*) AS n FROM jobs")[0].n, 1);
});

test("у разных пользователей статусы идут только в их личные чаты", async () => {
  const h = makeHarness(); await consent(h, ALICE, 1); await consent(h, BOB, 3);
  await h.send(h.message(ALICE, "Вопрос A", 5));
  await h.send(h.message(BOB, "Вопрос B", 6));
  assert.deepEqual(statuses(h).map((c) => c.body.chat_id), [ALICE, BOB]);
  assert.ok(statuses(h).every((c) => Object.keys(c.body).sort().join(",") === "action,chat_id"));
});
