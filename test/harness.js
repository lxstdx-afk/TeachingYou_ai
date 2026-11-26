import { DatabaseSync } from "node:sqlite";
import { createWorker, UserConversations, SearchBudget } from "../worker.js";

// Local test doubles. No real keys, messages or network requests are used.
export const TOKEN = "fake-bot-token";
export const SECRET = "fake_webhook_secret_0123456789_abcdefgh";
export const ALICE = 123456;
export const BOB = 234567;

export function makeStorage() {
  const db = new DatabaseSync(":memory:");
  const map = new Map();
  return {
    db, map, alarmAt: null,
    sql: {
      exec(query, ...args) {
        const q = query.trim();
        if (/^CREATE TABLE IF NOT EXISTS meta/i.test(q)) { db.exec(query); return { toArray() { return []; } }; }
        const stmt = db.prepare(query);
        const result = /^(SELECT|PRAGMA)\b/i.test(q) ? stmt.all(...args) : (stmt.run(...args), []);
        return { toArray() { return result; }, one() { if (result.length !== 1) throw new Error("expected one"); return result[0]; } };
      },
    },
    kv: { get(key) { return map.get(key); }, put(key, value) { map.set(key, value); }, delete(key) { map.delete(key); } },
    transactionSync(fn) {
      db.exec("BEGIN");
      try { const result = fn(); db.exec("COMMIT"); return result; }
      catch (err) { db.exec("ROLLBACK"); throw err; }
    },
    async getAlarm() { return this.alarmAt; },
    async setAlarm(at) { this.alarmAt = Number(at); },
    async deleteAll() { map.clear(); this.alarmAt = null; },
  };
}

export function makeHarness({ aiImpl, networkImpl, settings = {} } = {}) {
  const users = new Map(), stores = new Map(), calls = [], aiCalls = [], tasks = [];
  const budgetStorage = makeStorage();
  const budget = new SearchBudget({ storage: budgetStorage });
  const env = {
    TELEGRAM_BOT_TOKEN: TOKEN,
    TELEGRAM_WEBHOOK_SECRET: SECRET,
    TELEGRAM_ALLOWED_USER_IDS: `${ALICE},${BOB}`,
    SEARCH_ENABLED: "true", TAVILY_API_KEY: "fake-tavily-key", EXA_API_KEY: "fake-exa-key",
    ...settings,
  };
  env.AI = {
    async run(model, input) {
      aiCalls.push({ model, input });
      if (aiImpl) return aiImpl(model, input);
      if (input.messages[0]?.content?.includes("Извлекай факты в JSON")) {
        return { choices: [{ message: { content: JSON.stringify({ goals: ["Изучить JavaScript"], constraints: [], decisions: [], facts: [], progress: [], next: [] }) } }] };
      }
      return { choices: [{ message: { content: "# Ответ\n\nДавай **разберём** пример: `const x = 1`." }, finish_reason: "stop" }] };
    },
  };
  const fetchImpl = async (url, options = {}) => {
    const address = String(url);
    let body = options.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch {} }
    calls.push({ url: address, options, body });
    if (networkImpl) {
      const result = await networkImpl(address, options, body, calls);
      if (result) return result;
    }
    if (address.includes("/sendMessage") || address.includes("/answerCallbackQuery")) return Response.json({ ok: true, result: {} });
    if (address.endsWith("/getFile")) return Response.json({ ok: true, result: { file_path: "photos/test.jpg", file_size: 6 } });
    if (address.includes("/file/bot")) return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x12, 0x34]), { headers: { "Content-Type": "image/jpeg" } });
    if (address === "https://api.tavily.com/search") return Response.json({ results: [{ title: "Пример источника", url: "https://example.org/info", content: "Свежие сведения." }] });
    if (address === "https://api.exa.ai/search") return Response.json({ results: [{ title: "Резервный источник", url: "https://example.net/info", highlights: ["Другие сведения."] }] });
    if (address === "https://api.z.ai/api/paas/v4/chat/completions") return Response.json({ choices: [{ message: { content: "Ответ Z.AI" } }] });
    if (address === "https://openrouter.ai/api/v1/chat/completions") return Response.json({ choices: [{ message: { content: "Ответ OpenRouter" } }] });
    throw new Error(`unexpected test URL: ${address}`);
  };
  env.__testFetch = fetchImpl;
  env.SEARCH_BUDGET = { idFromName: (s) => s, get: () => ({ fetch: (url, init) => budget.fetch(new Request(url, init)) }) };
  env.USER_CHATS = {
    idFromName: (s) => s,
    get(name) {
      if (!users.has(name)) {
        const storage = makeStorage();
        stores.set(name, storage);
        users.set(name, new UserConversations({ storage }, env));
      }
      return { fetch: (url, init) => users.get(name).fetch(new Request(url, init)) };
    },
  };
  const worker = createWorker({ fetchImpl });
  const ctx = { waitUntil(p) { tasks.push(p); } };
  function message(user = ALICE, text = "Вопрос", id = 1, extra = {}) {
    return { update_id: id, message: { from: { id: user, is_bot: false }, chat: { id: user, type: "private" }, ...(text === null ? {} : { text }), ...extra } };
  }
  function callback(user = ALICE, data = "consent:yes", id = 1) {
    return { update_id: id, callback_query: { id: `query-${id}`, from: { id: user, is_bot: false }, data, message: { chat: { id: user, type: "private" } } } };
  }
  function request(update, secret = SECRET, headers = {}) {
    const hs = { "Content-Type": "application/json", ...headers };
    if (secret !== null) hs["X-Telegram-Bot-Api-Secret-Token"] = secret;
    return new Request("https://worker.example/telegram/webhook", { method: "POST", headers: hs, body: typeof update === "string" ? update : JSON.stringify(update) });
  }
  async function drain() {
    let steps = 0;
    for (;;) {
      let progressed = false;
      for (const obj of users.values()) {
        if (obj.rows("SELECT update_id FROM jobs LIMIT 1").length) {
          if (++steps > 500) throw new Error("alarm loop");
          await obj.alarm();
          progressed = true;
        }
      }
      if (!progressed) break;
    }
    await Promise.all(tasks);
  }
  async function send(update, { secret = SECRET, usedEnv = env, run = true } = {}) {
    const response = await worker.fetch(request(update, secret), usedEnv, ctx);
    if (run) await drain();
    return response;
  }
  return { env, worker, ctx, users, stores, calls, aiCalls, tasks, budget, budgetStorage, message, callback, request, send, drain,
    telegram() { return calls.filter((c) => c.url.includes("/sendMessage")); },
    user(id = ALICE) { return users.get(String(id)); },
  };
}
