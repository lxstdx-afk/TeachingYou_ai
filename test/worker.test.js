import { test } from "node:test";
import assert from "node:assert/strict";
import { UserConversations } from "../worker.js";
import { ALICE, BOB, SECRET, TOKEN, makeHarness } from "./harness.js";

async function consent(h, user = ALICE, start = 1) {
  await h.send(h.message(user, "/start", start));
  await h.send(h.message(user, "✅ Согласен(на), начать", start + 1));
}
function texts(h) { return h.telegram().map((c) => c.body.text); }
function chatCalls(h) { return h.aiCalls.filter((call) => String(call.input.messages[0]?.content).includes("TeachingYou AI")); }

test("публичная страница не раскрывает конфигурацию", async () => {
  const h = makeHarness();
  for (const env of [{}, h.env]) {
    const res = await h.worker.fetch(new Request("https://worker.example/"), env, h.ctx);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "TeachingYou AI: Worker работает.");
    assert.equal(res.headers.get("cache-control"), "no-store");
  }
});

test("неверные настройки и секрет закрывают webhook до обращения к хранилищу", async () => {
  const h = makeHarness();
  for (const env of [{}, { ...h.env, TELEGRAM_BOT_TOKEN: "" }, { ...h.env, TELEGRAM_WEBHOOK_SECRET: "short" }, { ...h.env, TELEGRAM_ALLOWED_USER_IDS: "1,broken" }, { ...h.env, TELEGRAM_ALLOWED_USER_IDS: "9007199254740992" }]) {
    assert.equal((await h.worker.fetch(h.request(h.message()), env, h.ctx)).status, 503);
  }
  for (const secret of [null, "wrong", "z".repeat(257)]) assert.equal((await h.worker.fetch(h.request(h.message(), secret), h.env, h.ctx)).status, 403);
  assert.equal(h.users.size, 0);
  assert.equal(h.aiCalls.length, 0);
});

test("посторонние, группы, другие chat_id и сообщения ботов игнорируются", async () => {
  const h = makeHarness();
  const variants = [
    h.message(345678, "чужой", 1),
    { update_id: 2, message: { from: { id: ALICE }, chat: { id: ALICE, type: "group" }, text: "группа" } },
    { update_id: 3, message: { from: { id: ALICE, is_bot: true }, chat: { id: ALICE, type: "private" }, text: "бот" } },
    { update_id: 4, message: { from: { id: ALICE }, chat: { id: BOB, type: "private" }, text: "чужой чат" } },
    { update_id: 5, edited_message: { text: "изменение" } },
  ];
  for (const item of variants) assert.equal((await h.send(item)).status, 200);
  assert.equal(h.users.size, 0);
  assert.equal(h.telegram().length, 0);
});

test("JSON, размер и идентификатор update проверяются", async () => {
  const h = makeHarness();
  assert.equal((await h.worker.fetch(h.request("{bad"), h.env, h.ctx)).status, 400);
  assert.equal((await h.worker.fetch(h.request("x".repeat(131073)), h.env, h.ctx)).status, 413);
  for (const id of [0, -1, "42", 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.equal((await h.send(h.message(ALICE, "x", id))).status, 400);
});

test("до согласия вопрос и file_id не сохраняются и не отправляются ИИ", async () => {
  const h = makeHarness();
  const item = h.message(ALICE, "секретный текст без согласия", 1, { photo: [{ file_id: "private-file", width: 10, height: 10 }] });
  await h.send(item, { run: false });
  const payload = h.user().rows("SELECT payload FROM jobs")[0].payload;
  assert.ok(!payload.includes("секретный"));
  assert.ok(!payload.includes("private-file"));
  await h.drain();
  assert.equal(h.aiCalls.length, 0);
  assert.match(texts(h)[0], /Перед началом/);
  assert.match(texts(h)[0], /внешним ИИ-сервисам/);
  assert.doesNotMatch(texts(h)[0], /Cloudflare|OpenRouter|Z\.AI/);
  assert.equal(h.telegram()[0].body.reply_markup.keyboard[0][0].text, "✅ Согласен(на), начать");
});

test("после согласия ответы форматируются и история передаётся в модель", async () => {
  const h = makeHarness(); await consent(h);
  await h.send(h.message(ALICE, "Меня интересует React", 3));
  await h.send(h.message(ALICE, "А с чего начать?", 4));
  const calls = chatCalls(h);
  assert.equal(calls.length, 2);
  const second = JSON.stringify(calls[1].input.messages);
  assert.ok(second.includes("Меня интересует React"));
  assert.ok(second.includes("А с чего начать?"));
  const response = h.telegram().at(-1).body;
  assert.ok(!response.text.includes("**"));
  assert.ok(!response.text.includes("# Ответ"));
  assert.ok(response.entities.some((e) => e.type === "bold"));
  assert.ok(response.entities.some((e) => e.type === "code"));
  assert.ok(calls[1].input.messages[0].content.includes("Не здоровайся заново"));
});

test("пользователи и чаты не смешивают историю и закреплённую память", async () => {
  const h = makeHarness(); await consent(h, ALICE, 1); await consent(h, BOB, 3);
  await h.send(h.message(ALICE, "Секретное название моего проекта АЛЬФА", 5));
  await h.send(h.message(ALICE, "/remember Мой проект АЛЬФА на Windows", 6));
  await h.send(h.message(ALICE, "/new Проект Бета", 7));
  await h.send(h.message(ALICE, "В новом чате работаю над БЕТА", 8));
  const betaContext = JSON.stringify(chatCalls(h).at(-1).input.messages);
  assert.ok(betaContext.includes("БЕТА"));
  assert.ok(!betaContext.includes("АЛЬФА"));
  await h.send(h.message(BOB, "У меня третий проект ДЕЛЬТА", 9));
  const bobContext = JSON.stringify(chatCalls(h).at(-1).input.messages);
  assert.ok(!bobContext.includes("АЛЬФА"));
  assert.ok(!bobContext.includes("БЕТА"));
  await h.send(h.callback(ALICE, "switch:1", 10));
  await h.send(h.message(ALICE, "Что дальше?", 11));
  const alphaContext = JSON.stringify(chatCalls(h).at(-1).input.messages);
  assert.ok(alphaContext.includes("АЛЬФА"));
  assert.ok(!alphaContext.includes("БЕТА"));
  assert.equal(h.user(ALICE).rows("SELECT COUNT(*) AS n FROM chats")[0].n, 2);
  assert.equal(h.user(BOB).rows("SELECT COUNT(*) AS n FROM chats")[0].n, 1);
});

test("очередь по одному пользователю сохраняет порядок команд и не дублирует update", async () => {
  const h = makeHarness(); await consent(h);
  await h.send(h.message(ALICE, "/new Новый", 4), { run: false });
  await h.send(h.message(ALICE, "/new Новый", 4), { run: false });
  await h.send(h.message(ALICE, "вопрос в новом чате", 5), { run: false });
  await h.drain();
  assert.equal(h.user().rows("SELECT COUNT(*) AS n FROM chats")[0].n, 2);
  const chat = h.user().rows("SELECT id FROM chats WHERE title=?", "Новый")[0];
  assert.equal(h.user().rows("SELECT chat_id FROM messages WHERE role='user'")[0].chat_id, chat.id);
  assert.equal(texts(h).filter((x) => x.includes("Создан новый чат")).length, 1);
});

test("/mode меняет режим только выбранного чата", async () => {
  const h = makeHarness(); await consent(h);
  await h.send(h.callback(ALICE, "mode:1:ideas", 3));
  await h.send(h.message(ALICE, "Предложи идею", 4));
  assert.ok(chatCalls(h).at(-1).input.messages[0].content.includes("Режим: идеи"));
  await h.send(h.message(ALICE, "/new Другая тема", 5));
  assert.equal(h.user().rows("SELECT mode FROM chats WHERE id=2")[0].mode, "mentor");
});

test("старые сообщения находятся по ключевым словам, после повторного создания объекта память сохраняется", async () => {
  const h = makeHarness(); await consent(h);
  const obj = h.user();
  obj.transaction(() => {
    obj.addMessage(1, "user", "Наше уникальное название проекта ЛЮМИНОС и важная настройка", 1000);
    obj.addMessage(1, "assistant", "Помню проект ЛЮМИНОС", 1000);
    for (let i = 0; i < 12; i++) {
      obj.addMessage(1, "user", `Другой вопрос ${i}`, 1100 + i);
      obj.addMessage(1, "assistant", `Другой ответ ${i}`, 1100 + i);
    }
  });
  const storage = h.stores.get(String(ALICE));
  const reboot = new UserConversations({ storage }, h.env);
  const context = JSON.stringify(reboot.context(reboot.chat(1), "Напомни настройку ЛЮМИНОС", null));
  assert.ok(context.includes("Наше уникальное название проекта ЛЮМИНОС"));
});

test("через несколько сообщений создаётся структурированная память, а архив остаётся", async () => {
  const h = makeHarness(); await consent(h);
  for (let i = 0; i < 3; i++) await h.send(h.message(ALICE, `Учим JavaScript шаг ${i}`, i + 3));
  const notes = h.user().rows("SELECT category,text FROM memory_notes WHERE chat_id=1");
  assert.deepEqual(notes.map((n) => [n.category, n.text]), [["goals", "Изучить JavaScript"]]);
  assert.equal(h.user().rows("SELECT COUNT(*) AS n FROM messages WHERE chat_id=1")[0].n, 6);
  await h.send(h.message(ALICE, "/memory", 6));
  assert.match(texts(h).at(-1), /Цели/);
  assert.match(texts(h).at(-1), /Изучить JavaScript/);
});

test("неверный JSON авто-памяти не уничтожает старые данные и историю", async () => {
  const h = makeHarness({ aiImpl: async (_model, input) => {
    if (input.messages[0].content.includes("Извлекай факты")) return { choices: [{ message: { content: "{invalid" } }] };
    return { choices: [{ message: { content: "готово" } }] };
  } });
  await consent(h);
  await h.send(h.message(ALICE, "/remember важный факт", 3));
  for (let i = 0; i < 3; i++) await h.send(h.message(ALICE, `сообщение ${i}`, i + 4));
  assert.equal(h.user().chat(1).summary_through, 0);
  assert.equal(h.user().rows("SELECT COUNT(*) AS n FROM messages")[0].n, 6);
  assert.equal(h.user().rows("SELECT text FROM pins")[0].text, "важный факт");
});

test("очистка и удаление работают только для выбранного чата", async () => {
  const h = makeHarness(); await consent(h);
  await h.send(h.message(ALICE, "Первый проект", 3));
  await h.send(h.message(ALICE, "/remember Факт первого", 4));
  await h.send(h.message(ALICE, "/new Второй", 5));
  await h.send(h.message(ALICE, "Второй проект", 6));
  await h.send(h.message(ALICE, "/clear", 7));
  assert.equal(h.user().rows("SELECT COUNT(*) AS n FROM messages WHERE chat_id=2")[0].n, 2);
  const clear = h.telegram().at(-1).body.reply_markup.keyboard[0][0].text;
  await h.send(h.message(ALICE, clear, 8));
  assert.equal(h.user().rows("SELECT COUNT(*) AS n FROM messages WHERE chat_id=2")[0].n, 0);
  assert.equal(h.user().rows("SELECT COUNT(*) AS n FROM messages WHERE chat_id=1")[0].n, 2);
  assert.equal(h.user().rows("SELECT COUNT(*) AS n FROM pins WHERE chat_id=1")[0].n, 1);
  await h.send(h.message(ALICE, "/chat 1", 9));
  await h.send(h.message(ALICE, "/delete", 10));
  const remove = h.telegram().at(-1).body.reply_markup.keyboard[0][0].text;
  await h.send(h.message(ALICE, remove, 11));
  assert.equal(h.user().rows("SELECT COUNT(*) AS n FROM messages WHERE chat_id=1")[0].n, 0);
  assert.equal(h.user().rows("SELECT COUNT(*) AS n FROM pins WHERE chat_id=1")[0].n, 0);
  assert.equal(h.user().chat(1), undefined);
});

test("deleteall стирает только данные пользователя и повторно спрашивает согласие", async () => {
  const h = makeHarness(); await consent(h, ALICE, 1); await consent(h, BOB, 3);
  await h.send(h.message(ALICE, "Личная история A", 5));
  await h.send(h.message(BOB, "Личная история B", 6));
  await h.send(h.message(ALICE, "/deleteall", 7));
  const confirm = h.telegram().at(-1).body.reply_markup.keyboard[0][0].text;
  await h.send(h.message(ALICE, confirm, 8));
  assert.equal(h.user(ALICE).rows("SELECT COUNT(*) AS n FROM messages")[0].n, 0);
  assert.equal(h.user(ALICE).rows("SELECT COUNT(*) AS n FROM message_search")[0].n, 0);
  assert.equal(h.user(ALICE).meta("consent"), undefined);
  assert.equal(h.user(BOB).rows("SELECT COUNT(*) AS n FROM messages")[0].n, 2);
  const aiBefore = h.aiCalls.length;
  await h.send(h.message(ALICE, "ещё один вопрос", 9));
  assert.equal(h.aiCalls.length, aiBefore);
  assert.match(texts(h).at(-1), /Перед началом/);
});

test("явный запрос ищет, возвращает действительные источники и не передаёт историю в поисковый API", async () => {
  const h = makeHarness(); await consent(h);
  await h.send(h.message(ALICE, "Личный контекст проекта", 3));
  await h.send(h.message(ALICE, "/search актуальная версия Node.js", 4));
  const request = h.calls.find((c) => c.url === "https://api.tavily.com/search");
  assert.equal(request.body.query, "актуальная версия Node.js");
  assert.ok(!JSON.stringify(request.body).includes("Личный контекст"));
  assert.match(texts(h).at(-1), /example.org\/info/);
  assert.match(JSON.stringify(chatCalls(h).at(-1).input.messages), /недоверенные данные/);
});

test("модель сама запрашивает поиск и получает результат перед ответом", async () => {
  const h = makeHarness({ aiImpl: async (_model, input) => {
    if (input.messages[0].content.includes("Извлекай факты")) return { choices: [{ message: { content: '{}' } }] };
    const last = input.messages.at(-1).content;
    if (typeof last === "string" && last.includes("Результаты поиска")) return { choices: [{ message: { content: "По источнику [1] есть новости." } }] };
    return { choices: [{ message: { content: null, tool_calls: [{ function: { name: "web_search", arguments: '{"query":"текущая версия Node.js"}' } }] } }] };
  } });
  await consent(h);
  await h.send(h.message(ALICE, "Какая версия Node сейчас актуальна?", 3));
  assert.ok(h.calls.some((c) => c.url === "https://api.tavily.com/search" && c.body.query === "текущая версия Node.js"));
  assert.match(texts(h).at(-1), /По источнику/);
  assert.match(texts(h).at(-1), /example.org/);
});

test("когда поиск выключен, явный запрос не посылается внешнему сервису", async () => {
  const h = makeHarness({ settings: { SEARCH_ENABLED: "false" } }); await consent(h);
  await h.send(h.message(ALICE, "/search версия Node", 3));
  assert.match(texts(h).at(-1), /Поиск выключен/);
  assert.ok(!h.calls.some((c) => c.url === "https://api.tavily.com/search"));
});

test("фото отправляется в ИИ как bytes, а не как Telegram URL с токеном", async () => {
  const h = makeHarness(); await consent(h);
  await h.send(h.message(ALICE, null, 3, { caption: "Что на скриншоте?", photo: [{ file_id: "fake-file-id", width: 100, height: 100, file_size: 6 }] }));
  const input = chatCalls(h).at(-1).input;
  const image = input.messages.at(-1).content.find((part) => part.type === "image_url").image_url.url;
  assert.ok(image.startsWith("data:image/jpeg;base64,"));
  assert.ok(!JSON.stringify(input).includes(TOKEN));
  assert.ok(!JSON.stringify(input).includes("fake-file-id"));
  const stored = JSON.stringify(h.user().rows("SELECT text FROM messages"));
  assert.ok(!stored.includes("base64"));
  assert.ok(!stored.includes("fake-file-id"));
  assert.equal(h.user().rows("SELECT COUNT(*) AS n FROM jobs")[0].n, 0);
});

test("подозрительный file_path отклоняется без скачивания и вызова ИИ", async () => {
  const h = makeHarness({ networkImpl: async (url) => url.endsWith("/getFile") ? Response.json({ ok: true, result: { file_path: "../../outside" } }) : null });
  await consent(h);
  await h.send(h.message(ALICE, null, 3, { photo: [{ file_id: "fake", width: 20, height: 20 }] }));
  assert.equal(h.aiCalls.length, 0);
  assert.ok(!h.calls.some((c) => c.url.includes("/file/bot")));
  assert.match(texts(h).at(-1), /Не удалось открыть/);
});

test("неизвестный путь /usr/bin отправляется как вопрос, а слишком длинный текст отклоняется", async () => {
  const h = makeHarness(); await consent(h);
  await h.send(h.message(ALICE, "/usr/bin/node — что это?", 3));
  assert.ok(JSON.stringify(chatCalls(h).at(-1).input.messages).includes("/usr/bin/node"));
  const before = h.aiCalls.length;
  await h.send(h.message(ALICE, "x".repeat(8001), 4));
  assert.equal(h.aiCalls.length, before);
  assert.match(texts(h).at(-1), /слишком длинное/);
});

test("после неопределённого сбоя отправка готового сообщения не повторяется", async () => {
  const h = makeHarness(); await consent(h);
  const obj = h.user();
  await h.send(h.message(ALICE, "тест", 3), { run: false });
  obj.sql.exec("UPDATE jobs SET state='sending',result=? WHERE update_id=3", JSON.stringify({ text: "не повторять" }));
  const before = h.telegram().length;
  await h.drain();
  assert.equal(h.telegram().length, before);
  assert.equal(obj.rows("SELECT COUNT(*) AS n FROM jobs")[0].n, 0);
});

test("отсутствующее хранилище приводит к 503, чтобы Telegram мог повторить", async () => {
  const h = makeHarness();
  assert.equal((await h.send(h.message(), { usedEnv: { ...h.env, USER_CHATS: undefined } })).status, 503);
});
