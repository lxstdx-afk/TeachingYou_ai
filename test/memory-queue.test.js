import { test } from "node:test";
import assert from "node:assert/strict";
import { UserConversations } from "../worker.js";
import { ALICE, BOB, makeHarness, makeStorage } from "./harness.js";

async function consent(h, user = ALICE, start = 1) {
  await h.send(h.message(user, "/start", start));
  await h.send(h.message(user, "✅ Согласен(на), начать", start + 1));
}
function last(h) { return h.telegram().at(-1).body; }
function confirmData(h) { return last(h).reply_markup.keyboard[0][0].text; }

function oldChats(storage, withSummary = true) {
  storage.db.exec(`CREATE TABLE chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'mentor',
    ${withSummary ? "summary TEXT NOT NULL DEFAULT '{}'," : ""} summary_through INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
  )`);
}

test("старые JSON-сводки мигрируют в индексированные заметки без повторов и не теряют архив", () => {
  const h = makeHarness(), storage = makeStorage();
  oldChats(storage);
  const legacy = JSON.stringify({ goals: ["Цель ЛЮМИНОС"], constraints: [], decisions: [], facts: ["Используем Windows"], progress: [], next: [] });
  storage.db.prepare("INSERT INTO chats(title,summary,summary_through,created_at) VALUES (?,?,?,?)").run("Старый", legacy, 8, Date.now());
  storage.db.prepare("INSERT INTO chats(title,summary,created_at) VALUES (?,?,?)").run("Некорректный", "{bad-json", Date.now());
  const first = new UserConversations({ storage }, h.env);
  assert.equal(first.chat(1).summary, "{}");
  assert.equal(first.chat(1).summary_through, 8);
  assert.deepEqual(first.rows("SELECT category,text FROM memory_notes WHERE chat_id=1 ORDER BY id").map((n) => [n.category, n.text]), [["goals", "Цель ЛЮМИНОС"], ["facts", "Используем Windows"]]);
  assert.ok(JSON.stringify(first.context(first.chat(1), "Что про ЛЮМИНОС?", null)).includes("Цель ЛЮМИНОС"));
  assert.equal(first.chat(2).summary, "{bad-json");
  const reboot = new UserConversations({ storage }, h.env);
  assert.equal(reboot.rows("SELECT COUNT(*) AS n FROM memory_notes")[0].n, 2);
  reboot.transaction(() => reboot.clearChat(2));
  assert.equal(reboot.chat(2).summary, "{}");
});

test("локальная схема без summary дополняется без потери чатов", () => {
  const h = makeHarness(), storage = makeStorage();
  oldChats(storage, false);
  storage.db.prepare("INSERT INTO chats(title,created_at) VALUES (?,?)").run("Сохранённый", Date.now());
  const obj = new UserConversations({ storage }, h.env);
  assert.equal(obj.chat(1).title, "Сохранённый");
  assert.equal(obj.chat(1).summary, "{}");
  obj.transaction(() => obj.clearChat(1));
  assert.equal(obj.chat(1).title, "Сохранённый");
});

test("старые заметки находятся по запросу, списки постраничны и удаление из индекса изолировано", async () => {
  const h = makeHarness(); await consent(h);
  const obj = h.user();
  obj.transaction(() => {
    obj.addNote(1, "facts", "ЛЮМИНОС важная старая настройка");
    obj.addNote(1, "facts", "ЛЮМИНОС важная старая настройка");
    for (let i = 0; i < 40; i++) obj.addNote(1, "progress", `Другой шаг номер ${i}`);
  });
  assert.equal(obj.rows("SELECT COUNT(*) AS n FROM memory_notes WHERE chat_id=1")[0].n, 41);
  const oldId = obj.rows("SELECT id FROM memory_notes WHERE text=?", "ЛЮМИНОС важная старая настройка")[0].id;
  const context = JSON.stringify(obj.context(obj.chat(1), "Напомни настройку ЛЮМИНОС", null));
  assert.ok(context.includes("ЛЮМИНОС важная старая настройка"));
  await h.send(h.message(ALICE, "/memory", 3));
  assert.match(last(h).text, /страница 1\/4/);
  const next = last(h).reply_markup.keyboard[0].at(-1).text;
  await h.send(h.message(ALICE, next, 4));
  assert.match(last(h).text, /страница 2\/4/);
  await h.send(h.message(ALICE, `/forget A${oldId}`, 5));
  assert.equal(obj.rows("SELECT COUNT(*) AS n FROM memory_notes WHERE id=?", oldId)[0].n, 0);
  assert.equal(obj.rows("SELECT COUNT(*) AS n FROM memory_search WHERE rowid=?", oldId)[0].n, 0);
  assert.match(last(h).text, /Автозаметка удалена/);
  await h.send(h.message(ALICE, "/new Другой чат", 6));
  await h.send(h.message(ALICE, `/forget ${oldId + 1}`, 7));
  assert.match(last(h).text, /не найдена/);
  assert.equal(obj.rows("SELECT COUNT(*) AS n FROM memory_notes WHERE chat_id=1")[0].n, 40);
});

test("очистка удаляет заметки, FTS, старую сводку и закрепления только своего чата", async () => {
  const h = makeHarness(); await consent(h);
  await h.send(h.message(ALICE, "один", 3));
  await h.send(h.message(ALICE, "/remember важное", 4));
  const obj = h.user();
  obj.transaction(() => {
    obj.addNote(1, "facts", "старый факт");
    obj.sql.exec("UPDATE chats SET summary=? WHERE id=1", '{"goals":["legacy"]}');
  });
  await h.send(h.message(ALICE, "/clear", 5));
  const button = confirmData(h);
  await h.send(h.message(ALICE, button, 6));
  assert.equal(obj.rows("SELECT COUNT(*) AS n FROM messages")[0].n, 0);
  assert.equal(obj.rows("SELECT COUNT(*) AS n FROM message_search")[0].n, 0);
  assert.equal(obj.rows("SELECT COUNT(*) AS n FROM memory_notes")[0].n, 0);
  assert.equal(obj.rows("SELECT COUNT(*) AS n FROM memory_search")[0].n, 0);
  assert.equal(obj.rows("SELECT COUNT(*) AS n FROM pins")[0].n, 0);
  assert.equal(obj.chat(1).summary, "{}");
});

test("подтверждения одноразовые, истекают и старые статические кнопки не удаляют данные", async () => {
  const h = makeHarness(); await consent(h);
  await h.send(h.message(ALICE, "первая история", 3));
  await h.send(h.message(ALICE, "/clear", 4));
  const first = confirmData(h);
  assert.match(first, /^🗑 Очистить чат · [a-f0-9]{12}$/u);
  await h.send(h.message(ALICE, first, 5));
  await h.send(h.message(ALICE, "новая история", 6));
  await h.send(h.message(ALICE, first, 7));
  assert.match(last(h).text, /устарела или уже использована/);
  await h.send(h.callback(ALICE, "clear:1", 8));
  assert.match(last(h).text, /больше не действует/);
  await h.send(h.message(ALICE, "/clear", 9));
  const expired = confirmData(h);
  h.user().sql.exec("UPDATE confirmations SET expires_at=? WHERE substr(token,1,12)=?", Date.now() - 1000, expired.slice(-12));
  await h.send(h.message(ALICE, expired, 10));
  assert.match(last(h).text, /устарела/);
  assert.equal(h.user().rows("SELECT COUNT(*) AS n FROM messages")[0].n, 2);
});

test("распознанный токен не попадает даже во временную очередь", async () => {
  const h = makeHarness(); await consent(h);
  const token = "sk-abcdefghijklmnopqrstuv_fake";
  await h.send(h.message(ALICE, `Мой ключ ${token}`, 3), { run: false });
  assert.ok(!JSON.stringify(h.user().rows("SELECT payload FROM jobs")).includes(token));
  await h.drain();
  assert.equal(h.aiCalls.length, 0);
  assert.match(last(h).text, /перевыпусти/);
  assert.equal(h.user().rows("SELECT COUNT(*) AS n FROM messages")[0].n, 0);
});

test("параллельные события не превышают лимит очереди; дубликат не создаёт вторую работу", async () => {
  const h = makeHarness(); await consent(h);
  const obj = h.user(), storage = h.stores.get(String(ALICE));
  const originalGetAlarm = storage.getAlarm.bind(storage);
  storage.getAlarm = async () => { await new Promise((r) => setTimeout(r, 3)); return originalGetAlarm(); };
  const enqueue = (id) => obj.fetch(new Request("https://user.internal/enqueue", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ updateId: id, chatId: ALICE, kind: "message", text: `вопрос ${id}` }),
  }));
  const results = await Promise.all(Array.from({ length: 30 }, (_, i) => enqueue(i + 100)));
  assert.equal(results.filter((r) => r.status === 201).length, 25);
  assert.equal(results.filter((r) => r.status === 429).length, 5);
  assert.equal(obj.rows("SELECT COUNT(*) AS n FROM jobs")[0].n, 25);
  assert.equal((await enqueue(100)).status, 200);
  assert.equal(obj.rows("SELECT COUNT(*) AS n FROM jobs WHERE update_id=100")[0].n, 1);
});

test("при сбое setAlarm повтор webhook заново заводит сохранённую задачу", async () => {
  const h = makeHarness(); await consent(h);
  const storage = h.stores.get(String(ALICE));
  storage.alarmAt = null;
  const setAlarm = storage.setAlarm.bind(storage);
  storage.setAlarm = async () => { throw new Error("storage down"); };
  const update = h.message(ALICE, "проверка повтора", 3);
  assert.equal((await h.send(update, { run: false })).status, 503);
  assert.equal(h.user().rows("SELECT COUNT(*) AS n FROM jobs")[0].n, 1);
  storage.setAlarm = setAlarm;
  assert.equal((await h.send(update, { run: false })).status, 200);
  assert.notEqual(storage.alarmAt, null);
  await h.drain();
  assert.equal(h.user().rows("SELECT COUNT(*) AS n FROM messages WHERE role='user'")[0].n, 1);
  assert.equal(h.telegram().filter((x) => x.body.text.includes("Давай разберём")).length, 1);
});

test("deleteall после занятого ИИ удаляет ожидающие сообщения и отзывает согласие", async () => {
  let release, startedResolve;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const h = makeHarness({ aiImpl: async (_model, input) => {
    if (JSON.stringify(input.messages).includes("ДОЛГИЙ ВОПРОС")) { startedResolve(); await gate; }
    return { choices: [{ message: { content: "ответ" } }] };
  } });
  await consent(h);
  await h.send(h.message(ALICE, "/deleteall", 3));
  const confirm = confirmData(h);
  await h.send(h.message(ALICE, "ДОЛГИЙ ВОПРОС", 4), { run: false });
  const inFlight = h.user().alarm();
  await started;
  await h.send(h.message(ALICE, confirm, 5), { run: false });
  await h.send(h.message(ALICE, "ПОСЛЕ УДАЛЕНИЯ", 6), { run: false });
  release(); await inFlight; await h.drain();
  assert.equal(h.user().meta("consent"), undefined);
  assert.equal(h.user().rows("SELECT COUNT(*) AS n FROM messages")[0].n, 0);
  assert.equal(h.user().rows("SELECT COUNT(*) AS n FROM jobs")[0].n, 0);
  assert.ok(!JSON.stringify(h.aiCalls).includes("ПОСЛЕ УДАЛЕНИЯ"));
  await h.send(h.message(ALICE, "Начать заново", 7));
  assert.match(last(h).text, /Перед началом/);
});

test("память другого пользователя не удаляется и недоступна в запросе", async () => {
  const h = makeHarness(); await consent(h, ALICE, 1); await consent(h, BOB, 3);
  h.user(ALICE).transaction(() => h.user(ALICE).addNote(1, "facts", "ФАКТ АЛИСЫ"));
  h.user(BOB).transaction(() => h.user(BOB).addNote(1, "facts", "ФАКТ БОБА"));
  await h.send(h.message(ALICE, "/deleteall", 5));
  await h.send(h.message(ALICE, confirmData(h), 6));
  assert.equal(h.user(ALICE).rows("SELECT COUNT(*) AS n FROM memory_notes")[0].n, 0);
  assert.equal(h.user(ALICE).rows("SELECT COUNT(*) AS n FROM memory_search")[0].n, 0);
  assert.equal(h.user(BOB).rows("SELECT COUNT(*) AS n FROM memory_notes")[0].n, 1);
  await h.send(h.message(BOB, "Мой вопрос", 7));
  assert.ok(!JSON.stringify(h.aiCalls.at(-1).input.messages).includes("ФАКТ АЛИСЫ"));
});

test("очень длинные номера команд не ломают очередь", async () => {
  const h = makeHarness(); await consent(h);
  await h.send(h.message(ALICE, `/chat ${"9".repeat(4000)}`, 3));
  assert.match(last(h).text, /Чат не найден/);
  await h.send(h.message(ALICE, `/forget ${"9".repeat(4000)}`, 4));
  assert.match(last(h).text, /не найдена/);
  assert.equal(h.user().rows("SELECT COUNT(*) AS n FROM jobs")[0].n, 0);
});
