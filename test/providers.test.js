import { test } from "node:test";
import assert from "node:assert/strict";
import { callAI, CF_MODEL, CF_TEXT_FALLBACK, OPENROUTER_MODEL, ZAI_TEXT_MODEL, ZAI_VISION_MODEL } from "../src/providers.js";
import { SEARCH_DAILY_LIMIT, SEARCH_MONTHLY_LIMIT, SearchBudget, searchEnabled, webSearch } from "../src/search.js";
import { makeStorage } from "./harness.js";

const messages = [{ role: "user", content: "тест" }];
const response = (text) => Response.json({ choices: [{ message: { content: text }, finish_reason: "stop" }] });

function budgetEnv() {
  const storage = makeStorage();
  const budget = new SearchBudget({ storage });
  return { storage, budget, env: {
    TAVILY_API_KEY: "fake-tavily-key", EXA_API_KEY: "fake-exa-key",
    SEARCH_BUDGET: { idFromName: (x) => x, get: () => ({ fetch: (url, opts) => budget.fetch(new Request(url, opts)) }) },
  } };
}
function mcpEvent(result) {
  return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result })}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
}

test("первой используется Cloudflare без обращения к резервам", async () => {
  const models = []; let http = 0;
  const env = { AI: { async run(model) { models.push(model); return { choices: [{ message: { content: "ОК" } }] }; } }, ZAI_API_KEY: "fake", OPENROUTER_API_KEY: "fake", OPENROUTER_NO_BYOK_CONFIRMED: "true" };
  const answer = await callAI(env, messages, { fetchImpl: async () => { http++; throw new Error(); } });
  assert.equal(answer.provider, "Cloudflare");
  assert.deepEqual(models, [CF_MODEL]);
  assert.equal(http, 0);
});

test("вторая модель Cloudflare помогает при сбое основной только для текста", async () => {
  const models = [];
  const env = { AI: { async run(model) { models.push(model); if (model === CF_MODEL) throw new Error("недоступна"); return { choices: [{ message: { content: "резерв" } }] }; } } };
  assert.equal((await callAI(env, messages)).provider, "Cloudflare");
  assert.deepEqual(models, [CF_MODEL, CF_TEXT_FALLBACK]);
  models.length = 0;
  assert.equal(await callAI(env, messages, { image: true }), null);
  assert.deepEqual(models, [CF_MODEL]);
});

test("при сбое Cloudflare сначала вызывается бесплатная модель Z.AI, затем подтверждённый OpenRouter", async () => {
  const calls = [], models = [];
  const env = { AI: { async run(model) { models.push(model); throw new Error("429 fake secret"); } }, ZAI_API_KEY: "fake-zai", OPENROUTER_API_KEY: "fake-openrouter", OPENROUTER_NO_BYOK_CONFIRMED: "true" };
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ url, body, options });
    if (String(url).includes("z.ai")) return new Response("error", { status: 503 });
    return response("резервный ответ");
  };
  const answer = await callAI(env, messages, { fetchImpl, tools: true });
  assert.deepEqual(models, [CF_MODEL, CF_TEXT_FALLBACK]);
  assert.equal(answer.provider, "OpenRouter (free)");
  assert.equal(calls[0].body.model, ZAI_TEXT_MODEL);
  assert.equal(calls[0].body.tools[0].type, "function"); // Not Z.AI's paid built-in type:web_search.
  assert.equal(calls[1].body.model, OPENROUTER_MODEL);
  assert.deepEqual(calls[1].body.provider.max_price, { prompt: 0, completion: 0, request: 0, image: 0 });
  assert.ok(calls.every((c) => c.options.redirect === "manual"));
  assert.ok(!JSON.stringify(answer).includes("fake"));
});

test("сохранённый ключ OpenRouter сам по себе не включает рискованный BYOK", async () => {
  for (const flag of [undefined, "false", true, "TRUE"]) {
    let requests = 0;
    const env = { OPENROUTER_API_KEY: "fake-openrouter", OPENROUTER_NO_BYOK_CONFIRMED: flag };
    const answer = await callAI(env, messages, { fetchImpl: async () => { requests++; return response("не должен вызываться"); } });
    assert.equal(answer, null);
    assert.equal(requests, 0);
  }
});

test("для изображения Z.AI получает только бесплатную vision-модель, OpenRouter ограничивает цену изображения", async () => {
  let body;
  const image = [{ role: "user", content: [{ type: "text", text: "скрин" }, { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/" } }] }];
  const answer = await callAI({ ZAI_API_KEY: "fake" }, image, {
    image: true, fetchImpl: async (_url, options) => { body = JSON.parse(options.body); return response("вижу"); },
  });
  assert.equal(answer.provider, "Z.AI");
  assert.equal(body.model, ZAI_VISION_MODEL);
  await callAI({ OPENROUTER_API_KEY: "fake", OPENROUTER_NO_BYOK_CONFIRMED: "true" }, image, {
    image: true, fetchImpl: async (_url, options) => { body = JSON.parse(options.body); return response("вижу"); },
  });
  assert.equal(body.provider.max_price.image, 0);
  assert.equal(body.model, OPENROUTER_MODEL);
});

test("инструмент поиска может быть вызван моделью в обоих форматах ответа", async () => {
  for (const tool_calls of [
    [{ type: "function", function: { name: "web_search", arguments: '{"query":"версия Node"}' } }],
    [{ name: "web_search", arguments: { query: "версия Node" } }],
  ]) {
    const env = { AI: { async run(_model, input) { assert.equal(input.tools[0].function.name, "web_search"); return { choices: [{ message: { content: null, tool_calls } }] }; } } };
    const answer = await callAI(env, messages, { tools: true });
    assert.equal(answer.calls[0].query, "версия Node");
  }
});

test("таймаут и ошибки всех моделей возвращают null без утечки ключей", async () => {
  const env = { AI: { run: () => new Promise(() => {}) }, ZAI_API_KEY: "secret-key", OPENROUTER_API_KEY: "secret-key2", OPENROUTER_NO_BYOK_CONFIRMED: "true" };
  const answer = await callAI(env, messages, { timeoutMs: 5, fetchImpl: async () => { throw new Error("secret-key"); } });
  assert.equal(answer, null);
});

test("по умолчанию Tavily keyless не использует сохранённые платные ключи", async () => {
  const { env, storage } = budgetEnv(); const calls = [];
  const answer = await webSearch(env, "документация Node", async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return Response.json({ results: [
      { title: "Источник", url: "https://example.org/a", content: "факт" },
      { title: "Повтор", url: "https://example.org/a", content: "x" },
      { title: "Опасно", url: "javascript:alert(1)", content: "x" },
      { title: "Пароль", url: "https://user:pass@example.net/", content: "x" },
    ] });
  });
  assert.equal(answer.provider, "tavily-keyless");
  assert.equal(answer.results.length, 1);
  assert.equal(calls[0].body.search_depth, "basic");
  assert.equal(calls[0].body.auto_parameters, false);
  assert.equal(calls[0].options.headers["X-Tavily-Access-Mode"], "keyless");
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.equal(calls[0].options.redirect, "manual");
  assert.ok(!JSON.stringify(calls).includes("fake-tavily-key"));
  assert.ok(!JSON.stringify(calls).includes("fake-exa-key"));
  assert.ok(!JSON.stringify([...storage.map.values()]).includes("документация"));
});

test("при сбое Tavily используется keyless Exa MCP и разбирается SSE", async () => {
  const { env } = budgetEnv(); const calls = [];
  const answer = await webSearch(env, "новости Node", async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    if (url.includes("tavily")) return new Response("unavailable", { status: 503 });
    return mcpEvent({ structuredContent: { results: [
      { title: "good", url: "https://example.net/info", highlights: ["сведения"] },
      { title: "bad", url: "javascript:alert(1)", text: "x" },
    ] } });
  });
  assert.equal(answer.provider, "exa-keyless");
  assert.deepEqual(answer.results.map((r) => r.url), ["https://example.net/info"]);
  assert.equal(calls[1].body.method, "tools/call");
  assert.equal(calls[1].body.params.name, "web_search_advanced_exa");
  assert.equal(calls[1].body.params.arguments.type, "lite");
  assert.equal(calls[1].options.headers["x-api-key"], undefined);
  assert.equal(calls[1].options.headers.Authorization, undefined);
  assert.ok(!JSON.stringify(calls).includes("fake-exa-key"));
});

test("Exa MCP JSON в text content поддерживается; rate-limit в HTTP 200 не считается успехом", async () => {
  const { env } = budgetEnv();
  env.SEARCH_PROVIDERS = "exa-keyless";
  const payload = { results: [{ title: "ok", url: "https://example.org/one", text: "text" }] };
  const ok = await webSearch(env, "информация", async () => mcpEvent({ content: [{ type: "text", text: JSON.stringify(payload) }] }));
  assert.equal(ok.results.length, 1);
  for (const result of [
    { isError: true, structuredContent: payload },
    { _meta: { "ai.exa/rateLimited": true }, structuredContent: payload },
  ]) {
    const limited = await webSearch(env, "информация", async () => mcpEvent(result));
    assert.equal(limited.error, "unavailable");
    assert.deepEqual(limited.results, []);
  }
  const invalid = await webSearch(env, "информация", async () => new Response("not JSON"));
  assert.equal(invalid.error, "unavailable");
});

test("выключенный или неверно настроенный поиск и секретоподобный запрос не обращаются к сети", async () => {
  const { env } = budgetEnv(); let calls = 0;
  const fetchImpl = async () => { calls++; return Response.json({ results: [] }); };
  assert.equal(searchEnabled(env), true);
  for (const overrides of [{ SEARCH_ENABLED: "false" }, { SEARCH_PROVIDERS: "typo" }, { SEARCH_PROVIDERS: "tavily-keyless,tavily-keyless" }, { SEARCH_PROVIDERS: "tavily" }, { SEARCH_PROVIDERS: "exa" }, { SEARCH_PROVIDERS: "tavily", SEARCH_ACCOUNT_KEYS_ENABLED: "true", TAVILY_API_KEY: "" }]) {
    assert.equal((await webSearch({ ...env, ...overrides }, "новости", fetchImpl)).error, "disabled");
  }
  assert.equal((await webSearch(env, "", fetchImpl)).error, "empty");
  assert.equal((await webSearch(env, "мой ключ sk-abcdefghijklmnopqrstuv", fetchImpl)).error, "secret");
  assert.equal(calls, 0);
});

test("провайдеры с аккаунтными ключами требуют явного выбора и не смешивают keyless-заголовки", async () => {
  const { env } = budgetEnv(); const calls = [];
  const fake = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return Response.json({ results: [{ title: "x", url: "https://example.org/x", content: "x", highlights: ["x"] }] });
  };
  assert.equal((await webSearch({ ...env, SEARCH_PROVIDERS: "tavily", SEARCH_ACCOUNT_KEYS_ENABLED: "true" }, "тест", fake)).provider, "tavily");
  assert.equal(calls[0].options.headers.Authorization, "Bearer fake-tavily-key");
  assert.equal(calls[0].options.headers["X-Tavily-Access-Mode"], undefined);
  assert.equal((await webSearch({ ...env, SEARCH_PROVIDERS: "exa", SEARCH_ACCOUNT_KEYS_ENABLED: "true" }, "тест", fake)).provider, "exa");
  assert.equal(calls[1].options.headers["x-api-key"], "fake-exa-key");
  assert.equal(calls[1].body.type, "lite");
});

test("общий дневной бюджет атомарно ограничивает параллельные попытки", async () => {
  const { env, storage } = budgetEnv(); let count = 0;
  const fetchImpl = async () => { count++; return Response.json({ results: [{ title: "x", url: "https://example.org", content: "x" }] }); };
  const results = await Promise.all(Array.from({ length: SEARCH_DAILY_LIMIT + 8 }, () => webSearch(env, "тест", fetchImpl)));
  assert.equal(results.filter((r) => r.results.length).length, SEARCH_DAILY_LIMIT);
  assert.equal(results.filter((r) => r.error === "limit").length, 8);
  assert.equal(count, SEARCH_DAILY_LIMIT);
  assert.ok(!JSON.stringify([...storage.map.values()]).includes("тест"));
});

test("месячный бюджет и недоступное хранилище закрывают поиск", async () => {
  const { env, storage } = budgetEnv(); let calls = 0;
  const fetchImpl = async () => { calls++; return Response.json({ results: [] }); };
  const now = new Date().toISOString();
  storage.map.set("usage", { day: now.slice(0, 10), month: now.slice(0, 7), daily: 0, monthly: SEARCH_MONTHLY_LIMIT });
  assert.equal((await webSearch(env, "тест", fetchImpl)).error, "limit");
  assert.equal((await webSearch({ ...env, SEARCH_BUDGET: undefined }, "тест", fetchImpl)).error, "limit");
  assert.equal((await webSearch({ ...env, SEARCH_BUDGET: { idFromName() { throw new Error(); } } }, "тест", fetchImpl)).error, "limit");
  assert.equal(calls, 0);
});
