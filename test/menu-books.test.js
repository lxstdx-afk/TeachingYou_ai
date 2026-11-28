import { test } from "node:test";
import assert from "node:assert/strict";
import { BOT_COMMANDS, sendBook } from "../src/telegram.js";
import { findBooks, isSafeBook, MAX_BOOK_BYTES } from "../src/books.js";
import { UI } from "../src/menu.js";
import { ALICE, BOB, makeHarness } from "./harness.js";

const commonBook = {
  index: 1, title: "File:Война и мир.pdf", imageinfo: [{
    mime: "application/pdf", size: 1_400_000, pagecount: 300,
    url: "https://upload.wikimedia.org/wikipedia/commons/a/ab/War_and_Peace.pdf?utm_source=example",
    descriptionurl: "https://commons.wikimedia.org/wiki/File:War_and_Peace.pdf",
    extmetadata: { Artist: { value: '<a href="https://example.org">Лев Толстой</a>' }, LicenseShortName: { value: "Public domain" }, Restrictions: { value: "" } },
  }],
};
function archiveRecord(overrides = {}, fileOverrides = {}) {
  return {
    metadata: { mediatype: "texts", title: "Война и мир", creator: "Лев Толстой", year: "1869", language: "Russian", volume: "1", imagecount: "306", licenseurl: "https://creativecommons.org/publicdomain/mark/1.0/", ...overrides },
    files: [{ name: "War and Peace.pdf", format: "Text PDF", size: "1300000", ...fileOverrides }],
  };
}
function catalogNetwork({ commons = [commonBook], docs = [{ identifier: "tolstoy-book" }], records = { "tolstoy-book": archiveRecord() }, failures = [] } = {}) {
  return async (address) => {
    const u = new URL(address);
    if (u.hostname === "commons.wikimedia.org") {
      if (failures.includes("commons")) return new Response("error", { status: 503 });
      return Response.json({ query: { pages: commons } });
    }
    if (u.hostname === "archive.org" && u.pathname === "/advancedsearch.php") {
      if (failures.includes("archive")) return new Response("error", { status: 503 });
      return Response.json({ response: { docs } });
    }
    if (u.hostname === "archive.org" && u.pathname.startsWith("/metadata/")) return Response.json(records[u.pathname.split("/").at(-1)] || {});
    return null;
  };
}
async function consent(h, user = ALICE, first = 1) {
  await h.send(h.message(user, "/start", first));
  await h.send(h.message(user, "✅ Согласен(на), начать", first + 1));
}
function last(h) { return h.telegram().at(-1).body; }
function labels(h) { return last(h).reply_markup.keyboard.flat().map((b) => b.text); }
function docs(h) { return h.calls.filter((c) => c.url.endsWith("/sendDocument")); }
function catalogs(h) { return h.calls.filter((c) => /(?:commons\.wikimedia\.org|archive\.org)/.test(c.url)); }
function apiCalls(h, method) { return h.calls.filter((c) => c.url.endsWith(`/${method}`)); }

const expectedCommands = ["menu", "new", "chats", "remind", "help"];

test("/start настраивает короткое левое меню только для разрешённого личного чата", async () => {
  const h = makeHarness();
  await h.send(h.message(ALICE, "/start", 1));
  const registrations = apiCalls(h, "setMyCommands"), menu = apiCalls(h, "setChatMenuButton");
  assert.equal(registrations.length, 2);
  assert.equal(menu.length, 1);
  assert.deepEqual(menu[0].body, { chat_id: ALICE, menu_button: { type: "commands" } });
  for (const call of registrations) {
    assert.deepEqual(call.body.scope, { type: "chat", chat_id: ALICE });
    assert.deepEqual(call.body.commands, BOT_COMMANDS);
    assert.deepEqual(call.body.commands.map((c) => c.command).sort(), [...expectedCommands].sort());
    assert.ok(call.body.commands.every((c) => /^[a-z0-9_]{1,32}$/.test(c.command) && c.description.length <= 256));
  }
  assert.deepEqual(registrations.map((r) => r.body.language_code ?? "").sort(), ["", "ru"]);
  const before = h.calls.length;
  await h.send(h.message(987654, "/start", 2));
  assert.equal(h.calls.length, before);
});

test("меню обновляет также язык пользователя, указанный Telegram, и не дублирует русский", async () => {
  for (const [languageCode, expected] of [["en", ["", "ru", "en"]], ["pt-BR", ["", "ru", "pt"]], ["ru-RU", ["", "ru"]], ["invalid!", ["", "ru"]]]) {
    const h = makeHarness();
    await h.send(h.message(ALICE, "/start", 1, { from: { id: ALICE, is_bot: false, language_code: languageCode } }));
    assert.deepEqual(apiCalls(h, "setMyCommands").map((r) => r.body.language_code ?? ""), expected);
    assert.ok(apiCalls(h, "setMyCommands").every((r) => r.body.commands.length === expectedCommands.length));
  }
});

test("команды с обязательными аргументами объясняют, что делать после выбора из меню", async () => {
  const h = makeHarness(); await consent(h);
  const examples = { "/chat": /\/chats|\/chat 1/, "/rename": /\/rename/, "/search": /\/search/, "/book": /\/book/,
    "/remember": /\/remember/, "/unpin": /\/unpin/, "/forget": /\/forget/ };
  let id = 3;
  for (const [command, hint] of Object.entries(examples)) {
    await h.send(h.message(ALICE, command, id++));
    assert.match(last(h).text, hint, command);
  }
  assert.equal(h.aiCalls.length, 0);
});

test("ошибка настройки меню не мешает ответу и может быть повторена через /start", async () => {
  const h = makeHarness({ networkImpl: async (url) => /setMyCommands|setChatMenuButton/.test(url) ? new Response("fail", { status: 503 }) : null });
  await h.send(h.message(ALICE, "/start", 1));
  assert.match(last(h).text, /Перед началом/);
  await h.send(h.message(ALICE, "/start", 2));
  assert.equal(apiCalls(h, "setChatMenuButton").length, 2);
});

test("новый чат создаётся из списка, его история изолирована; повтор update не создаёт дубликат", async () => {
  const h = makeHarness(); await consent(h);
  await h.send(h.message(ALICE, "История первого", 3));
  await h.send(h.message(ALICE, "/chats", 4));
  assert.ok(labels(h).includes("🆕 Новый чат"));
  await h.send(h.message(ALICE, "🆕 Новый чат", 5));
  assert.equal(h.user().meta("current"), "2");
  assert.equal(last(h).reply_markup.remove_keyboard, true);
  assert.match(last(h).text, /\/rename/);
  await h.send(h.message(ALICE, "🆕 Новый чат", 5));
  assert.equal(h.user().rows("SELECT COUNT(*) AS n FROM chats")[0].n, 2);
  await h.send(h.message(ALICE, "История второго", 6));
  const input = h.aiCalls.at(-1).input.messages;
  assert.ok(!JSON.stringify(input).includes("История первого"));
  assert.equal(h.user().rows("SELECT COUNT(*) AS n FROM messages WHERE chat_id=1")[0].n, 2);
  assert.equal(h.user().rows("SELECT COUNT(*) AS n FROM messages WHERE chat_id=2")[0].n, 2);
  await h.send(h.message(ALICE, "/new", 7));
  assert.equal(h.user().rows("SELECT COUNT(*) AS n FROM chats")[0].n, 3);
});

test("/book показывает пример без сетевого поиска", async () => {
  const h = makeHarness({ networkImpl: catalogNetwork() }); await consent(h);
  await h.send(h.message(ALICE, "/book", 3));
  assert.match(last(h).text, /\/book Война и мир/);
  assert.equal(catalogs(h).length, 0);
  assert.equal(h.aiCalls.length, 0);
});

test("по названию находятся варианты, выбранный PDF отправляется как документ", async () => {
  const h = makeHarness({ networkImpl: catalogNetwork() }); await consent(h);
  const before = h.telegram().length;
  await h.send(h.message(ALICE, "/book Война и мир", 3));
  assert.equal(h.aiCalls.length, 0);
  assert.match(last(h).text, /Нашёл варианты PDF/);
  assert.match(last(h).text, /Война и мир/);
  assert.match(last(h).text, /Условия по каталогу: Public domain/);
  assert.match(last(h).text, /Язык по каталогу: русский/);
  assert.match(last(h).text, /306 сканов в записи/);
  assert.match(last(h).text, /15 минут/);
  assert.ok(last(h).entities.some((e) => e.type === "text_link" && e.url === "https://commons.wikimedia.org/wiki/File:War_and_Peace.pdf"));
  assert.ok(last(h).entities.some((e) => e.type === "text_link" && e.url === "https://archive.org/details/tolstoy-book"));
  assert.equal(h.telegram().length, before + 1);
  assert.ok(apiCalls(h, "sendChatAction").some((c) => c.body.action === "typing"));
  const button = labels(h).find((s) => /^📖 PDF 1/.test(s));
  assert.ok(button); assert.ok(h.user().getBookChoices());
  await h.send(h.message(ALICE, button, 4));
  assert.equal(docs(h).length, 1);
  assert.equal(docs(h)[0].body.chat_id, ALICE);
  assert.equal(docs(h)[0].body.document, "https://upload.wikimedia.org/wikipedia/commons/a/ab/War_and_Peace.pdf");
  assert.match(docs(h)[0].body.caption, /Лев Толстой/);
  assert.match(docs(h)[0].body.caption, /Public domain/);
  assert.match(docs(h)[0].body.caption, /commons\.wikimedia\.org/);
  assert.deepEqual(docs(h)[0].body.reply_markup, { remove_keyboard: true });
  assert.ok(apiCalls(h, "sendChatAction").some((c) => c.body.action === "upload_document"));
  assert.equal(h.user().getBookChoices(), null);
  await h.send(h.message(ALICE, button, 5));
  assert.equal(docs(h).length, 1);
  assert.match(last(h).text, /устарел/);
});

test("после поиска PDF через раздел меню клавиатура с вариантами не скрывается", async () => {
  const h = makeHarness({ networkImpl: catalogNetwork() }); await consent(h);
  await h.send(h.message(ALICE, "/menu", 3));
  await h.send(h.message(ALICE, UI.search, 4));
  await h.send(h.message(ALICE, UI.book, 5));
  await h.send(h.message(ALICE, "Война и мир", 6));
  assert.match(last(h).text, /Нашёл варианты PDF/);
  const button = labels(h).find((label) => /^📖 PDF 1/.test(label));
  assert.ok(button);
  assert.equal(h.aiCalls.length, 0);
  await h.send(h.message(ALICE, button, 7));
  assert.equal(docs(h).length, 1);
});

test("обычная просьба прислать книгу в PDF тоже запускает каталоги без ИИ", async () => {
  const h = makeHarness({ networkImpl: catalogNetwork() }); await consent(h);
  await h.send(h.message(ALICE, "Пожалуйста, пришли PDF книги «Война и мир»", 3));
  assert.ok(catalogs(h).length > 0);
  assert.equal(h.aiCalls.length, 0);
  assert.match(last(h).text, /варианты PDF/);
  const request = catalogs(h).find((c) => c.url.includes("commons.wikimedia.org"));
  assert.equal(new URL(request.url).searchParams.get("gsrsearch"), "Война и мир filemime:pdf");
});

test("несколько понятных формулировок запроса PDF сохраняют само название", async () => {
  const h = makeHarness({ networkImpl: catalogNetwork() }); await consent(h);
  const inputs = [
    "Найди мне книгу «Война и мир» в формате PDF, пожалуйста",
    "Пришли книжку под названием Война и мир",
    "Найди PDF Война и мир",
    "Отправь книгу в PDF Война и мир",
    "Найди книгу Война и мир в PDF и отправь мне",
    "Найди книгу Война и мир в интернете, пожалуйста",
  ];
  let id = 3;
  for (const input of inputs) {
    const before = catalogs(h).length;
    await h.send(h.message(ALICE, input, id++));
    assert.match(last(h).text, /варианты PDF/, input);
    const req = catalogs(h).slice(before).find((c) => c.url.includes("commons.wikimedia.org"));
    assert.equal(new URL(req.url).searchParams.get("gsrsearch"), "Война и мир filemime:pdf", input);
  }
  assert.equal(h.aiCalls.length, 0);
  await h.send(h.message(ALICE, "Найди книгу", id));
  assert.match(last(h).text, /\/book Война и мир/);
});

test("запрет поиска и отсутствие согласия не отправляют книгу в каталоги", async () => {
  const h = makeHarness({ networkImpl: catalogNetwork() });
  await h.send(h.message(ALICE, "/book Война и мир", 1));
  assert.equal(catalogs(h).length, 0);
  assert.match(last(h).text, /Перед началом/);
  await h.send(h.message(ALICE, "✅ Согласен(на), начать", 2));
  await h.send(h.message(ALICE, "/book Война и мир, не ищи, пожалуйста", 3));
  assert.match(last(h).text, /не ищу/);
  assert.equal(catalogs(h).length, 0);
  await h.send(h.message(ALICE, "Не ищи, пожалуйста, книгу Война и мир", 4));
  assert.equal(catalogs(h).length, 0);
  assert.equal(h.aiCalls.at(-1).input.tools, undefined);
});

test("отказ одного каталога не мешает другому, при отказе обоих бот честно сообщает о проблеме", async () => {
  const a = makeHarness({ networkImpl: catalogNetwork({ failures: ["archive"] }) }); await consent(a);
  await a.send(a.message(ALICE, "/book Война и мир", 3));
  assert.match(last(a).text, /варианты PDF/);
  assert.match(last(a).text, /не все каталоги/i);
  const empty = makeHarness({ networkImpl: catalogNetwork({ commons: [], failures: ["archive"] }) }); await consent(empty);
  await empty.send(empty.message(ALICE, "/book Война и мир", 3));
  assert.match(last(empty).text, /не нашёл подходящий открытый PDF/i);
  assert.match(last(empty).text, /не все каталоги/i);
  const b = makeHarness({ networkImpl: catalogNetwork({ failures: ["archive", "commons"] }) }); await consent(b);
  await b.send(b.message(ALICE, "/book Война и мир", 3));
  assert.match(last(b).text, /не удалось связаться с каталогами/i);
  assert.equal(docs(b).length, 0);
});

test("пустой каталог не выдаётся за найденную книгу", async () => {
  const h = makeHarness({ networkImpl: catalogNetwork({ commons: [], docs: [] }) }); await consent(h);
  await h.send(h.message(ALICE, "/book Несуществующий заголовок", 3));
  assert.match(last(h).text, /не нашёл подходящий открытый PDF/i);
  assert.equal(docs(h).length, 0);
});

test("лимит и отключение поиска блокируют оба каталога", async () => {
  const h = makeHarness({ networkImpl: catalogNetwork(), settings: { SEARCH_ENABLED: "false" } }); await consent(h);
  await h.send(h.message(ALICE, "/book Война и мир", 3));
  assert.match(last(h).text, /поиск сейчас выключен/i);
  assert.equal(catalogs(h).length, 0);
  const b = makeHarness({ networkImpl: catalogNetwork() }); await consent(b);
  const now = new Date().toISOString();
  b.budgetStorage.map.set("usage", { day: now.slice(0, 10), month: now.slice(0, 7), daily: 20, monthly: 20 });
  await b.send(b.message(ALICE, "/book Война и мир", 3));
  assert.match(last(b).text, /лимит поиска/i);
  assert.equal(catalogs(b).length, 0);
});

test("поиск отбрасывает закрытые, большие, небезопасные и неподтверждённые файлы", async () => {
  const copy = (info) => ({ ...commonBook, imageinfo: [{ ...commonBook.imageinfo[0], ...info }] });
  const commons = [
    commonBook,
    copy({ size: MAX_BOOK_BYTES + 1 }), copy({ mime: "text/html" }), copy({ pagecount: 1 }),
    copy({ url: "https://127.0.0.1/wikipedia/commons/a/ab/book.pdf" }),
    copy({ descriptionurl: "https://evil.example/wiki/File:book.pdf" }),
    copy({ extmetadata: { LicenseShortName: { value: "All rights reserved" } } }),
    copy({ extmetadata: { LicenseShortName: { value: "Public domain" }, Restrictions: { value: "Restrictions apply" } } }),
  ];
  const records = {
    ok: archiveRecord(),
    restricted: archiveRecord({ "access-restricted-item": "true" }),
    borrowed: archiveRecord({ lending_identifier: "loan-1" }),
    private: archiveRecord({}, { private: "true" }),
    badlicense: archiveRecord({ licenseurl: "https://example.org/license" }),
    toolarge: archiveRecord({}, { size: String(MAX_BOOK_BYTES + 1) }),
  };
  const network = catalogNetwork({ commons, docs: Object.keys(records).map((identifier) => ({ identifier })), records });
  const h = makeHarness({ networkImpl: network });
  const result = await findBooks(h.env, "Война и мир", h.env.__testFetch);
  assert.equal(result.error, undefined);
  assert.equal(result.books.length, 2);
  assert.ok(result.books.every(isSafeBook));
  assert.ok(result.books.every((b) => b.size <= MAX_BOOK_BYTES));
  await findBooks(h.env, 'Война и мир") OR evil:*', h.env.__testFetch);
  const search = catalogs(h).filter((c) => c.url.includes("advancedsearch.php")).at(-1);
  const q = new URL(search.url).searchParams.get("q");
  assert.match(q, /AND mediatype:texts AND format:pdf AND licenseurl:\*$/);
  assert.ok(!q.includes('evil:*'));
  assert.ok(catalogs(h).every((c) => c.options.redirect === "manual" && !c.options.headers.Authorization));
});

test("нерелевантные документы не выдаются за книги с совпадающим названием", async () => {
  const irrelevant = { ...commonBook, title: "File:Путеводитель по Москве.pdf" };
  const h = makeHarness({ networkImpl: catalogNetwork({ commons: [irrelevant], docs: [] }) });
  const result = await findBooks(h.env, "Война и мир", h.env.__testFetch);
  assert.deepEqual(result.books, []);
});

test("закрытые или недоступные записи и скрытые файлы Archive не предлагаются", async () => {
  const records = {
    allowed: archiveRecord(),
    dark: { ...archiveRecord(), is_dark: true },
    notready: { ...archiveRecord(), nodownload: true },
    privateitem: archiveRecord({ private: "true" }),
    hidden: archiveRecord({ geo_restricted: "US" }),
    restricted: archiveRecord({}, { geo_restricted: "SE" }),
  };
  const h = makeHarness({ networkImpl: catalogNetwork({ commons: [], docs: Object.keys(records).map((identifier) => ({ identifier })), records }) });
  const result = await findBooks(h.env, "Война и мир", h.env.__testFetch);
  assert.equal(result.books.length, 1);
  assert.equal(result.books[0].sourceUrl, "https://archive.org/details/allowed");
  assert.equal(result.books[0].language, "русский");
  assert.equal(result.books[0].volume, "1");
  assert.equal(result.books[0].scanCount, 306);
  const extra = { hiddenfile: archiveRecord({}, { hidden: "true" }), hiddenitem: archiveRecord({ hidden: true }) };
  const h2 = makeHarness({ networkImpl: catalogNetwork({ commons: [], docs: Object.keys(extra).map((identifier) => ({ identifier })), records: extra }) });
  assert.deepEqual((await findBooks(h2.env, "Война и мир", h2.env.__testFetch)).books, []);
});

test("частичный сбой отдельных записей помечается, но остальные результаты сохраняются", async () => {
  const base = catalogNetwork({ docs: [{ identifier: "tolstoy-book" }, { identifier: "broken" }] });
  const h = makeHarness({ networkImpl: (url, options, body) => url.endsWith("/metadata/broken") ? new Response("error", { status: 503 }) : base(url, options, body) });
  await consent(h); await h.send(h.message(ALICE, "/book Война и мир", 3));
  assert.match(last(h).text, /варианты PDF/);
  assert.match(last(h).text, /не все каталоги или записи/i);
});

test("нельзя отправить произвольный URL под видом книги", async () => {
  const h = makeHarness({ networkImpl: catalogNetwork() });
  const found = await findBooks(h.env, "Война и мир", h.env.__testFetch);
  const valid = found.books[0];
  assert.equal(isSafeBook(valid), true);
  for (const bad of [
    { ...valid, url: "https://localhost/secret.pdf" },
    { ...valid, url: valid.url + "?token=secret" },
    { ...valid, sourceUrl: "https://evil.example/file" },
    { ...valid, size: MAX_BOOK_BYTES + 1 },
    { ...valid, license: { label: "unknown", url: "" } },
  ]) {
    assert.equal(isSafeBook(bad), false);
    assert.equal((await sendBook(h.env.__testFetch, "fake", ALICE, bad)).ok, false);
  }
  assert.equal(docs(h).length, 0);
});

test("длинные метаданные не мешают отправке: источник и условия остаются в подписи", async () => {
  const prefix = "https://commons.wikimedia.org/wiki/File:";
  const book = { title: "A".repeat(180), author: "B".repeat(120), source: "Wikimedia Commons",
    url: "https://upload.wikimedia.org/wikipedia/commons/a/ab/test.pdf", sourceUrl: prefix + "X".repeat(450 - prefix.length),
    size: MAX_BOOK_BYTES, pages: 100000, year: "Y".repeat(10), language: "L".repeat(60), volume: "V".repeat(40), scanCount: 100000,
    license: { label: "CC BY-SA 4.0", url: "https://creativecommons.org/licenses/by-sa/4.0/" } };
  const h = makeHarness();
  assert.equal(isSafeBook(book), true);
  assert.equal((await sendBook(h.env.__testFetch, "fake", ALICE, book)).ok, true);
  const caption = docs(h)[0].body.caption;
  assert.ok(caption.length <= 1024);
  assert.ok(caption.includes(book.sourceUrl));
  assert.ok(caption.includes(book.license.url));
  assert.ok(caption.includes(book.author));
});

test("выбор файла привязан к пользователю, исходному чату и сроку", async () => {
  const h = makeHarness({ networkImpl: catalogNetwork() }); await consent(h, ALICE, 1); await consent(h, BOB, 3);
  await h.send(h.message(ALICE, "/book Война и мир", 5)); const button = labels(h)[0];
  await h.send(h.message(BOB, button, 6)); assert.match(last(h).text, /устарел/); assert.equal(docs(h).length, 0);
  await h.send(h.message(ALICE, "/new Второй", 7));
  await h.send(h.message(ALICE, button, 8)); assert.match(last(h).text, /исходный чат/); assert.equal(docs(h).length, 0);
  await h.send(h.message(ALICE, "/chat 1", 9));
  const choices = h.user().getBookChoices(); choices.expiresAt = Date.now() - 1; h.user().setMeta("book_choices", JSON.stringify(choices));
  await h.send(h.message(ALICE, button, 10)); assert.match(last(h).text, /устарел/); assert.equal(docs(h).length, 0);
});

test("очистка чата и отмена удаляют ожидаемый выбор книги", async () => {
  const h = makeHarness({ networkImpl: catalogNetwork() }); await consent(h);
  await h.send(h.message(ALICE, "/book Война и мир", 3)); const old = labels(h)[0];
  await h.send(h.message(ALICE, "/clear", 4)); const confirm = labels(h)[0];
  await h.send(h.message(ALICE, confirm, 5)); assert.equal(h.user().getBookChoices(), null);
  await h.send(h.message(ALICE, old, 6)); assert.match(last(h).text, /устарел/);
  await h.send(h.message(ALICE, "/book Война и мир", 7)); assert.ok(h.user().getBookChoices());
  await h.send(h.message(ALICE, "❌ Отмена", 8)); assert.equal(h.user().getBookChoices(), null);
});

test("новый неуспешный поиск инвалидирует старые кнопки; истёкшие варианты очищаются", async () => {
  let offline = false;
  const base = catalogNetwork();
  const h = makeHarness({ networkImpl: (url, options, body) => offline && /(?:commons\.wikimedia\.org|archive\.org)/.test(url) ? new Response("error", { status: 503 }) : base(url, options, body) });
  await consent(h); await h.send(h.message(ALICE, "/book Война и мир", 3)); const old = labels(h)[0];
  offline = true; await h.send(h.message(ALICE, "/book Другая книга", 4));
  assert.match(last(h).text, /не удалось связаться с каталогами/i);
  assert.equal(last(h).reply_markup.remove_keyboard, true);
  assert.equal(h.user().meta("book_choices"), undefined);
  await h.send(h.message(ALICE, old, 5)); assert.match(last(h).text, /устарел/); assert.equal(docs(h).length, 0);
  offline = false; await h.send(h.message(ALICE, "/book Война и мир", 6));
  const choices = h.user().getBookChoices(); choices.expiresAt = Date.now() - 1; h.user().setMeta("book_choices", JSON.stringify(choices));
  await h.send(h.message(ALICE, "/help", 7));
  assert.equal(h.user().meta("book_choices"), undefined);
});

test("после перезапуска в состоянии sending документ автоматически не отправляется", async () => {
  const h = makeHarness({ networkImpl: catalogNetwork() }); await consent(h);
  await h.send(h.message(ALICE, "/book Война и мир", 3));
  const obj = h.user(), book = obj.getBookChoices().books[0];
  obj.sql.exec("INSERT INTO jobs(update_id,payload,state,result,created_at) VALUES (?,?,?,?,?)", 99,
    JSON.stringify({ kind: "message", chatId: ALICE }), "sending", JSON.stringify({ document: book, text: "ошибка" }), Date.now());
  await obj.alarm();
  assert.equal(docs(h).length, 0);
  assert.equal(obj.rows("SELECT COUNT(*) AS n FROM jobs WHERE update_id=99")[0].n, 0);
});

test("неопределённая ошибка sendDocument не вызывает повторной отправки", async () => {
  const base = catalogNetwork();
  const h = makeHarness({ networkImpl: async (url, options, body) => {
    if (url.endsWith("/sendDocument")) throw new Error("connection dropped");
    return base(url, options, body);
  } });
  await consent(h); await h.send(h.message(ALICE, "/book Война и мир", 3)); const choice = labels(h)[0];
  await h.send(h.message(ALICE, choice, 4));
  assert.equal(docs(h).length, 1);
  assert.match(last(h).text, /не удалось подтвердить отправку PDF/i);
  assert.match(last(h).text, /страница источника/i);
  assert.equal(h.user().rows("SELECT COUNT(*) AS n FROM jobs")[0].n, 0);
});
