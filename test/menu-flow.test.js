import { test } from "node:test";
import assert from "node:assert/strict";
import { UI } from "../src/menu.js";
import { UserConversations } from "../worker.js";
import { ALICE, BOB, makeHarness } from "./harness.js";

function driver(h) {
  let id = 1;
  return async (text, user = ALICE, extra = {}, opts) => h.send(h.message(user, text, id++, extra), opts);
}
async function consent(send, user = ALICE) { await send("/start", user); await send("✅ Согласен(на), начать", user); }
function last(h, user = ALICE) { return h.telegram().filter((call) => call.body.chat_id === user).at(-1).body; }
function buttons(h, user = ALICE) { return last(h, user).reply_markup?.keyboard?.flat().map((button) => button.text) || []; }
function state(h, user = ALICE) { const raw = h.user(user).meta("ui_flow"); return raw ? JSON.parse(raw) : null; }

test("/menu открывается по запросу, разделы объясняются, навигация не тратит ИИ", async () => {
  const h = makeHarness(), send = driver(h); await consent(send);
  assert.equal(last(h).reply_markup.remove_keyboard, true);
  await send("/menu");
  assert.deepEqual(buttons(h), [UI.chats, UI.search, UI.memory, UI.reminder, UI.settings, UI.help, UI.hide]);
  assert.ok(!last(h).reply_markup.inline_keyboard);
  await send(UI.chats);
  assert.match(last(h).text, /отдельные темы/i);
  assert.ok(buttons(h).includes(UI.listChats));
  await send(UI.back);
  await send(UI.search);
  assert.ok(buttons(h).includes(UI.web));
  assert.ok(buttons(h).includes(UI.book));
  await send(UI.back); await send(UI.memory);
  assert.match(last(h).text, /могут ошибаться/i);
  await send(UI.back); await send(UI.settings);
  assert.match(last(h).text, /подтверждение/i);
  await send(UI.back); await send(UI.help);
  assert.match(last(h).text, /\/menu/);
  await send(UI.hide);
  assert.equal(last(h).reply_markup.remove_keyboard, true);
  assert.equal(h.aiCalls.length, 0);
  assert.equal(h.user().rows("SELECT COUNT(*) AS n FROM messages")[0].n, 0);
  assert.ok(h.calls.every((c) => !c.url.endsWith("/setWebhook")));
});

test("кнопки чатов и памяти используют старые обработчики и отдельное подтверждение удаления", async () => {
  const h = makeHarness(), send = driver(h); await consent(send);
  await send("/menu"); await send(UI.chats); await send(UI.newChat);
  assert.equal(h.user().meta("current"), "2");
  await send("/menu"); await send(UI.chats); await send(UI.renameChat);
  assert.equal(state(h).kind, "rename");
  await send("Учёба на Mac");
  assert.equal(h.user().chat(2).title, "Учёба на Mac");
  assert.equal(last(h).reply_markup.remove_keyboard, true);
  assert.equal(state(h), null);
  await send("/menu"); await send(UI.memory); await send(UI.pin); await send("Люблю наглядные примеры");
  assert.equal(h.user().rows("SELECT text FROM pins WHERE chat_id=2")[0].text, "Люблю наглядные примеры");
  await send("/menu"); await send(UI.memory); await send(UI.showMemory);
  assert.match(last(h).text, /Люблю наглядные примеры/);
  await send("/menu"); await send(UI.memory); await send(UI.removeNote); await send("1");
  assert.equal(h.user().rows("SELECT COUNT(*) AS n FROM pins WHERE chat_id=2")[0].n, 0);
  await send("/menu"); await send(UI.chats); await send(UI.listChats);
  assert.ok(buttons(h).includes("💬 Чат 1"));
  await send("💬 Чат 1");
  assert.equal(h.user().meta("current"), "1");
  await send("/menu"); await send(UI.chats); await send(UI.deleteChat);
  assert.ok(h.user().chat(1));
  assert.match(last(h).text, /Подтверди/);
  await send(UI.cancel);
  assert.ok(h.user().chat(1));
  assert.equal(h.aiCalls.length, 0);
});

test("старые команды по-прежнему принимаются и полный список доступен отдельно", async () => {
  const h = makeHarness(), send = driver(h); await consent(send);
  await send("/remember Прежняя команда");
  await send("/memory"); assert.match(last(h).text, /Прежняя команда/);
  await send("/mode"); assert.ok(buttons(h).some((label) => label.includes("Наставник")));
  await send("/help all");
  for (const name of ["/menu", "/remind", "/new", "/chats", "/chat ", "/rename", "/mode", "/memory", "/remember", "/unpin", "/forget", "/search", "/book", "/clear", "/delete", "/deleteall", "/privacy", "/help", "/start", "/agree"]) assert.ok(last(h).text.includes(name), name);
  assert.equal(h.aiCalls.length, 0);
});

test("поисковая кнопка ждёт запрос и запускает старый поиск ровно с этим запросом", async () => {
  const h = makeHarness(), send = driver(h); await consent(send);
  await send("/menu"); await send(UI.search); await send(UI.web);
  assert.equal(h.aiCalls.length, 0);
  await send("Версия JavaScript сейчас");
  const search = h.calls.find((c) => c.url === "https://api.tavily.com/search");
  assert.equal(search.body.query, "Версия JavaScript сейчас");
  assert.equal(h.aiCalls.length, 1);
  assert.match(last(h).text, /Источники/);
  assert.equal(last(h).reply_markup.remove_keyboard, true);
  assert.equal(state(h), null);
});

test("кнопка книги ищет название в каталогах без вызова ИИ", async () => {
  const networkImpl = async (address) => {
    if (address.startsWith("https://commons.wikimedia.org/")) return Response.json({ query: { pages: [] } });
    if (address.startsWith("https://archive.org/advancedsearch.php")) return Response.json({ response: { docs: [] } });
    return null;
  };
  const h = makeHarness({ networkImpl }), send = driver(h); await consent(send);
  await send("/menu"); await send(UI.search); await send(UI.book);
  await send("Война и мир | Толстой");
  assert.ok(h.calls.some((c) => c.url.startsWith("https://commons.wikimedia.org/")));
  assert.ok(h.calls.some((c) => c.url.startsWith("https://archive.org/advancedsearch.php")));
  assert.match(last(h).text, /Не нашёл/);
  assert.equal(h.aiCalls.length, 0);
});

test("при прерывании после сохранения поискового ввода задача восстанавливает именно поиск", async () => {
  const h = makeHarness(), send = driver(h); await consent(send);
  await send("/menu"); await send(UI.search); await send(UI.web);
  await send("поиск после перезапуска", ALICE, {}, { run: false });
  const obj = h.user(), job = obj.rows("SELECT * FROM jobs LIMIT 1")[0], payload = JSON.parse(job.payload);
  obj.transaction(() => assert.equal(obj.command(job, payload), null));
  assert.match(obj.rows("SELECT payload FROM jobs LIMIT 1")[0].payload, /\/search поиск после перезапуска/);
  const reboot = new UserConversations({ storage: h.stores.get(String(ALICE)) }, h.env);
  h.users.set(String(ALICE), reboot);
  await h.drain();
  assert.equal(h.calls.find((c) => c.url === "https://api.tavily.com/search").body.query, "поиск после перезапуска");
  assert.match(last(h).text, /Источники/);
});

test("быстрое напоминание: только Telegram date_time, без ИИ, истории и планировщика напоминаний", async () => {
  const h = makeHarness(), send = driver(h); await consent(send);
  await send("/menu"); await send(UI.reminder);
  assert.match(last(h).text, /без ИИ/);
  assert.ok(buttons(h).includes(UI.in5));
  const before = Date.now();
  await send(UI.in5);
  const draftTime = state(h).at;
  assert.ok(draftTime >= before + 5 * 60_000 && draftTime <= Date.now() + 5 * 60_000);
  await send("😀 Позвонить маме");
  const body = last(h), entity = body.entities.find((e) => e.type === "date_time");
  assert.ok(entity);
  assert.equal(entity.unix_time, Math.floor(draftTime / 1000));
  assert.match(body.text, /😀 Позвонить маме/);
  assert.match(body.text.slice(entity.offset, entity.offset + entity.length), /UTC$/);
  assert.match(body.text, /Пока не подтвердил — оно не создано/);
  assert.equal(body.reply_markup.remove_keyboard, true);
  assert.equal(state(h), null);
  assert.equal(h.user().rows("SELECT COUNT(*) AS n FROM messages")[0].n, 0);
  assert.equal(h.user().rows("SELECT COUNT(*) AS n FROM jobs")[0].n, 0);
  assert.equal(h.aiCalls.length, 0);
  assert.ok(!h.calls.some((c) => c.url.endsWith("/setWebhook")));
  assert.ok(h.calls.every((c) => new URL(c.url).hostname === "api.telegram.org"));
});

test("напоминание не запускает автопамять даже при накопленной истории", async () => {
  const h = makeHarness(), send = driver(h); await consent(send);
  const obj = h.user();
  obj.transaction(() => {
    for (let i = 0; i < 6; i++) obj.addMessage(1, i % 2 ? "assistant" : "user", `Старая запись ${i}`, 10_000 + i);
  });
  await send("/remind"); await send(UI.in5); await send("Купить чай");
  assert.ok(last(h).entities.some((e) => e.type === "date_time"));
  assert.equal(h.aiCalls.length, 0);
  assert.equal(obj.rows("SELECT COUNT(*) AS n FROM messages")[0].n, 6);
  assert.equal(obj.rows("SELECT COUNT(*) AS n FROM memory_notes")[0].n, 0);
  assert.equal(obj.chat(1).summary_through, 0);
});

test("подготовленное напоминание переживает рестарт очереди без вызова модели", async () => {
  const h = makeHarness(), send = driver(h); await consent(send);
  await send("/remind"); await send(UI.in5);
  await send("Проверить задачу", ALICE, {}, { run: false });
  const obj = h.user(), job = obj.rows("SELECT * FROM jobs LIMIT 1")[0], payload = JSON.parse(job.payload);
  obj.transaction(() => {
    const prepared = obj.command(job, payload);
    assert.ok(prepared.reminder);
    obj.sql.exec("UPDATE jobs SET state='prepared',result=? WHERE update_id=?", JSON.stringify(prepared), job.update_id);
  });
  h.users.set(String(ALICE), new UserConversations({ storage: h.stores.get(String(ALICE)) }, h.env));
  await h.drain();
  assert.ok(last(h).entities.some((e) => e.type === "date_time"));
  assert.equal(h.telegram().filter((c) => c.body.entities?.some((e) => e.type === "date_time")).length, 1);
  assert.equal(h.aiCalls.length, 0);
});

test("точная дата требует явного часового пояса, хранит его отдельно для каждого пользователя", async () => {
  const h = makeHarness(), send = driver(h); await consent(send, ALICE); await consent(send, BOB);
  await send("/remind", ALICE); await send(UI.exact, ALICE);
  assert.match(last(h, ALICE).text, /сохранит/);
  assert.match(last(h, ALICE).text, /\/deleteall/);
  assert.ok(buttons(h, ALICE).includes(UI.moscow));
  await send(UI.moscow, ALICE);
  assert.equal(h.user(ALICE).meta("reminder_timezone"), "Europe/Moscow");
  await send("завтра 18:00", ALICE);
  const aliceTime = state(h, ALICE).at;
  await send("Дело Алисы", ALICE);
  await send("/remind", BOB); await send(UI.exact, BOB); await send(UI.stockholm, BOB);
  assert.equal(h.user(BOB).meta("reminder_timezone"), "Europe/Stockholm");
  await send("завтра 18:00", BOB);
  const bobTime = state(h, BOB).at;
  await send("Дело Боба", BOB);
  assert.equal(last(h, ALICE).entities[0].unix_time, Math.floor(aliceTime / 1000));
  assert.equal(last(h, BOB).entities[0].unix_time, Math.floor(bobTime / 1000));
  assert.ok(!last(h, BOB).text.includes("Дело Алисы"));
  assert.equal(h.aiCalls.length, 0);
  await send("/remind", ALICE); await send(UI.exact, ALICE);
  assert.match(last(h, ALICE).text, /Europe\/Moscow/);
  assert.ok(buttons(h, ALICE).includes(UI.changeZone));
});

test("часовой пояс можно изменить; неверные и неопределённые даты не создают напоминание", async () => {
  const h = makeHarness(), send = driver(h); await consent(send);
  await send("/remind"); await send(UI.exact); await send(UI.otherZone);
  await send("UTC+99"); assert.equal(state(h).step, "zoneInput");
  await send("UTC+05:45"); assert.equal(h.user().meta("reminder_timezone"), "UTC+05:45");
  await send("31.02.2030 18:00"); assert.equal(state(h).step, "date"); assert.match(last(h).text, /Такой даты/);
  await send("когда-нибудь"); assert.equal(state(h).step, "date"); assert.match(last(h).text, /Не понял дату/);
  await send(UI.changeZone); await send(UI.moscow);
  assert.equal(h.user().meta("reminder_timezone"), "Europe/Moscow");
  assert.equal(h.aiCalls.length, 0);
  assert.ok(!h.telegram().some((c) => c.body.entities?.some((e) => e.type === "date_time")));
});

test("повторный тап по прошлой кнопке времени не превращается в текст напоминания", async () => {
  const h = makeHarness(), send = driver(h); await consent(send);
  await send("/remind"); await send(UI.in5); await send(UI.in5);
  assert.equal(state(h).step, "text");
  assert.match(last(h).text, /нужен текст/i);
  assert.ok(!h.telegram().some((c) => c.body.entities?.some((e) => e.type === "date_time")));
  await send("Настоящий текст");
  assert.ok(last(h).entities.some((e) => e.type === "date_time"));
  assert.equal(h.aiCalls.length, 0);
});

test("мастер не выполняется в другом внутреннем чате", async () => {
  const h = makeHarness(), send = driver(h); await consent(send);
  await send("/new Второй"); await send("/chat 1"); await send("/remind"); await send(UI.in5);
  const obj = h.user(); obj.transaction(() => obj.setMeta("current", "2"));
  await send("Текст для первого чата");
  assert.match(last(h).text, /чат изменился/i);
  assert.equal(state(h), null);
  assert.equal(h.aiCalls.length, 0);
  assert.ok(!h.telegram().some((c) => c.body.entities?.some((e) => e.type === "date_time")));
});

test("обычная фотография с похожей подписью не перехватывается меню", async () => {
  const h = makeHarness(), send = driver(h); await consent(send);
  await send(UI.chats, ALICE, { photo: [{ file_id: "photo-id", width: 10, height: 10 }] });
  await send(UI.newChat, ALICE, { photo: [{ file_id: "photo-id", width: 10, height: 10 }] });
  assert.equal(h.aiCalls.length, 2);
  assert.ok(h.aiCalls.every((call) => JSON.stringify(call.input.messages).includes("image_url")));
  assert.equal(h.user().rows("SELECT COUNT(*) AS n FROM chats")[0].n, 1);
});

test("модель получает явное указание не выдавать неподтверждённое напоминание за созданное", async () => {
  const h = makeHarness(), send = driver(h); await consent(send);
  await send("Привет");
  const system = h.aiCalls[0].input.messages[0].content;
  assert.match(system, /Не обещай сам установить напоминание/);
  assert.match(system, /подтверждение в Telegram/);
});

test("отмена, /menu и просроченный мастер не превращают выбор в запрос к ИИ", async () => {
  const h = makeHarness(), send = driver(h); await consent(send);
  await send("/remind"); await send(UI.in5); await send(UI.cancel);
  assert.equal(state(h), null);
  await send(UI.in5); assert.match(last(h).text, /устарела/); assert.equal(h.aiCalls.length, 0);
  await send("/remind"); await send(UI.in5); await send("/menu");
  assert.equal(state(h), null); assert.ok(buttons(h).includes(UI.reminder));
  await send("/remind");
  const obj = h.user(), flow = state(h); flow.expiresAt = Date.now() - 1;
  obj.transaction(() => obj.setMeta("ui_flow", JSON.stringify(flow)));
  await send("обычный вопрос после истечения");
  assert.match(last(h).text, /истекло/); assert.equal(h.aiCalls.length, 0); assert.equal(state(h), null);
  await send("обычный вопрос ещё раз"); assert.equal(h.aiCalls.length, 1);
});

test("команды и фото с командами внутри мастера не запускают поиск или ИИ", async () => {
  const h = makeHarness(), send = driver(h); await consent(send);
  await send("/remind");
  await send("/search личная заметка");
  assert.ok(buttons(h).includes(UI.in5));
  await send("/search подпись к фото", ALICE, { photo: [{ file_id: "photo-id", width: 10, height: 10 }] });
  assert.ok(buttons(h).includes(UI.in5));
  await send(UI.in5);
  await send("/search личная заметка");
  assert.match(last(h).text, /сначала нажми «Отмена»/);
  assert.equal(state(h).step, "text");
  await send("/search личная фотография", ALICE, { photo: [{ file_id: "photo-id", width: 10, height: 10 }] });
  assert.match(last(h).text, /нужен текст/i);
  assert.equal(state(h).step, "text");
  await send("/new Второй");
  assert.match(last(h).text, /сначала нажми «Отмена»/);
  assert.equal(h.user().rows("SELECT COUNT(*) AS n FROM chats")[0].n, 1);
  assert.equal(h.aiCalls.length, 0);
  assert.ok(!h.calls.some((call) => call.url === "https://api.tavily.com/search" || call.url.endsWith("/getFile")));
  await send("Напомнить: /search документация");
  assert.ok(last(h).entities.some((e) => e.type === "date_time"));
  assert.equal(h.aiCalls.length, 0);
  await send("/new Второй");
  assert.equal(h.user().rows("SELECT COUNT(*) AS n FROM chats")[0].n, 2);
});

test("команда, похожая на содержимое просроченного напоминания, не отправляется модели", async () => {
  const h = makeHarness(), send = driver(h); await consent(send);
  await send("/remind"); await send(UI.in5);
  const obj = h.user(), flow = state(h); flow.expiresAt = Date.now() - 1;
  obj.transaction(() => obj.setMeta("ui_flow", JSON.stringify(flow)));
  await send("/search личная заметка");
  assert.match(last(h).text, /истекло/);
  assert.equal(h.aiCalls.length, 0);
  assert.ok(!h.calls.some((call) => call.url === "https://api.tavily.com/search"));
  assert.equal(state(h), null);
});

test("истёкшее время, длинный текст, изображение и распознанный секрет не создают заготовку", async () => {
  const h = makeHarness(), send = driver(h); await consent(send);
  await send("/remind"); await send(UI.in5);
  await send("x".repeat(401)); assert.match(last(h).text, /слишком длинный/i); assert.equal(state(h).step, "text");
  await send("", ALICE, { photo: [{ file_id: "photo-id", width: 10, height: 10 }] });
  assert.match(last(h).text, /нужен текст/i); assert.equal(h.aiCalls.length, 0);
  await send("123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefg");
  assert.match(last(h).text, /ключ или токен/i); assert.equal(state(h).step, "text");
  const obj = h.user(), flow = state(h); flow.at = Date.now() - 1000;
  obj.transaction(() => obj.setMeta("ui_flow", JSON.stringify(flow)));
  await send("Позвонить");
  assert.match(last(h).text, /слишком близко/i); assert.equal(state(h), null);
  assert.equal(h.aiCalls.length, 0);
  assert.ok(!h.telegram().some((c) => c.body.entities?.some((e) => e.type === "date_time")));
});

test("без согласия текст напоминания не записывается в очередь и не отправляется ИИ", async () => {
  const h = makeHarness();
  const item = h.message(ALICE, "напоминание без согласия", 1);
  await h.send(item, { run: false });
  assert.doesNotMatch(h.user().rows("SELECT payload FROM jobs")[0].payload, /напоминание без согласия/);
  await h.drain();
  assert.match(last(h).text, /Перед началом/);
  assert.equal(h.aiCalls.length, 0);
});

test("после долгого прерывания подготовленная, но просроченная дата не отправляется", async () => {
  const h = makeHarness(), send = driver(h); await consent(send);
  await send("/remind"); await send(UI.in5);
  await send("Позвонить", ALICE, {}, { run: false });
  const obj = h.user(), job = obj.rows("SELECT * FROM jobs LIMIT 1")[0], payload = JSON.parse(job.payload);
  obj.transaction(() => {
    const prepared = obj.command(job, payload);
    assert.ok(prepared.reminder);
    prepared.reminder.at = Date.now() - 1000;
    obj.sql.exec("UPDATE jobs SET state='prepared',result=? WHERE update_id=?", JSON.stringify(prepared), job.update_id);
  });
  await h.drain();
  assert.match(last(h).text, /прошло или слишком близко/);
  assert.ok(!last(h).entities?.some((e) => e.type === "date_time"));
  assert.equal(h.aiCalls.length, 0);
});

test("повтор Telegram update не создаёт второе сообщение с датой", async () => {
  const h = makeHarness(), send = driver(h); await consent(send);
  await send("/remind"); await send(UI.in5);
  const item = h.message(ALICE, "Один раз", 1000);
  await h.send(item); await h.send(item);
  assert.equal(h.telegram().filter((c) => c.body.entities?.some((e) => e.type === "date_time")).length, 1);
  assert.equal(h.aiCalls.length, 0);
});

test("очистка всех данных удаляет сохранённый пояс и мастер только своего пользователя", async () => {
  const h = makeHarness(), send = driver(h); await consent(send, ALICE); await consent(send, BOB);
  for (const [user, zone] of [[ALICE, UI.moscow], [BOB, UI.stockholm]]) {
    await send("/remind", user); await send(UI.exact, user); await send(zone, user);
  }
  await send("/deleteall", ALICE);
  const confirmation = buttons(h, ALICE)[0];
  await send(confirmation, ALICE);
  assert.equal(h.user(ALICE).meta("reminder_timezone"), undefined);
  assert.equal(h.user(ALICE).meta("ui_flow"), undefined);
  assert.equal(h.user(ALICE).meta("consent"), undefined);
  assert.equal(h.user(BOB).meta("reminder_timezone"), "Europe/Stockholm");
  assert.equal(state(h, BOB).step, "date");
});
