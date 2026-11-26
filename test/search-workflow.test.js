import { test } from "node:test";
import assert from "node:assert/strict";
import { ALICE, makeHarness } from "./harness.js";

async function consent(h) {
  await h.send(h.message(ALICE, "/start", 1));
  await h.send(h.message(ALICE, "✅ Согласен(на), начать", 2));
}
function last(h) { return h.telegram().at(-1).body.text; }

test("автопоиск срабатывает для актуальных сведений, даже если модель забыла выбрать инструмент", async () => {
  const h = makeHarness(); await consent(h);
  await h.send(h.message(ALICE, "Какая текущая версия Node.js?", 3));
  const call = h.calls.find((c) => c.url === "https://api.tavily.com/search");
  assert.equal(call.body.query, "Какая текущая версия Node.js?");
  assert.equal(call.options.headers["X-Tavily-Access-Mode"], "keyless");
  assert.equal(call.options.headers.Authorization, undefined);
  assert.match(last(h), /Источники/);
  assert.match(last(h), /example.org\/info/);
  assert.equal(h.aiCalls.filter((c) => String(c.input.messages[0]?.content).includes("TeachingYou AI")).length, 2);
});

test("пожелание не искать отключает явный и автоматический поиск", async () => {
  const h = makeHarness(); await consent(h);
  await h.send(h.message(ALICE, "Какая текущая версия Node, не ищи в интернете", 3));
  assert.ok(!h.calls.some((c) => c.url.includes("tavily") || c.url.includes("exa.ai")));
  assert.match(last(h), /без поиска/);
  const input = h.aiCalls.at(-1).input;
  assert.equal(input.tools, undefined);
});

test("недоступный бесплатный поиск не выдаётся за проверенный ответ", async () => {
  const h = makeHarness({ networkImpl: async (url) => /tavily|exa\.ai/.test(url) ? new Response("недоступно", { status: 503 }) : null });
  await consent(h);
  await h.send(h.message(ALICE, "Какая актуальная версия Node?", 3));
  assert.ok(h.calls.some((c) => c.url.includes("tavily")));
  assert.ok(h.calls.some((c) => c.url.includes("mcp.exa.ai")));
  assert.match(last(h), /Поиск не удался; актуальность ответа не проверена/);
  assert.doesNotMatch(last(h), /Источники:/);
});

test("явный поиск при временной недоступности не передаёт запрос моделям как проверенный", async () => {
  const h = makeHarness({ networkImpl: async (url) => /tavily|exa\.ai/.test(url) ? new Response("недоступно", { status: 503 }) : null });
  await consent(h);
  await h.send(h.message(ALICE, "/search версия Node", 3));
  assert.equal(h.aiCalls.length, 0);
  assert.match(last(h), /не получилось найти информацию/i);
});

test("после успешного ручного поиска ссылки сохраняются в ответе при сбое всех моделей", async () => {
  const h = makeHarness({ aiImpl: async () => { throw new Error("модель недоступна"); } });
  await consent(h);
  await h.send(h.message(ALICE, "/search версия Node", 3));
  assert.equal(h.calls.filter((c) => c.url === "https://api.tavily.com/search").length, 1);
  assert.match(last(h), /не получилось подготовить ответ/i);
  assert.match(last(h), /проверь информацию самостоятельно/i);
  assert.match(last(h), /Источники:/);
  assert.match(last(h), /example\.org\/info/);
});

test("после успешного автоматического поиска ссылки сохраняются при сбое второй модели", async () => {
  const h = makeHarness({ aiImpl: async (_model, input) => {
    if (String(input.messages.at(-1).content).includes("Результаты поиска")) throw new Error("модель недоступна");
    return { choices: [{ message: { content: null, tool_calls: [{ function: { name: "web_search", arguments: '{"query":"новости Node.js"}' } }] } }] };
  } });
  await consent(h);
  await h.send(h.message(ALICE, "Найди новости Node", 3));
  assert.match(last(h), /не получилось подготовить ответ/i);
  assert.match(last(h), /example\.org\/info/);
  assert.match(last(h), /Источники:/);
});

test("когда не работают и поиск, и модель, ссылки не выдумываются", async () => {
  let first = true;
  const h = makeHarness({
    aiImpl: async () => {
      if (first) { first = false; return { choices: [{ message: { content: "Нужно проверить." } }] }; }
      throw new Error("модель недоступна");
    },
    networkImpl: async (url) => /tavily|exa\.ai/.test(url) ? new Response("недоступно", { status: 503 }) : null,
  });
  await consent(h);
  await h.send(h.message(ALICE, "Какая текущая версия Node?", 3));
  assert.match(last(h), /не получилось найти информацию/i);
  assert.doesNotMatch(last(h), /Источники:/);
  assert.doesNotMatch(last(h), /example\.org/);
});
