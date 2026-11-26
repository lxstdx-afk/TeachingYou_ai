import { test } from "node:test";
import assert from "node:assert/strict";
import { ALICE, BOB, makeHarness } from "./harness.js";

// Model the original Telegram subscription: only "message" updates arrive.
async function messageOnly(h, update, options) {
  assert.ok(update.message, "message-only webhook must not need callback_query");
  return h.send(update, options);
}
function last(h) { return h.telegram().at(-1).body; }
function buttons(h) { return last(h).reply_markup.keyboard.flat().map((button) => button.text); }
async function accept(h, user, firstId) {
  await messageOnly(h, h.message(user, "/start", firstId));
  const button = buttons(h).find((label) => label.includes("начать"));
  assert.ok(button);
  await messageOnly(h, h.message(user, button, firstId + 1));
}

test("настоящий путь согласия через message-only webhook и форматирование ответа", async () => {
  const h = makeHarness({ aiImpl: async () => ({ choices: [{ message: { content: "Короткая вставка `x`.\n\n```python\ndef greet(name):\n    return f'Привет, {name}!'\n```" }, finish_reason: "stop" }] }) });
  await messageOnly(h, h.message(ALICE, "/start", 1));
  const notice = last(h);
  assert.equal(notice.reply_markup.inline_keyboard, undefined);
  assert.match(notice.text, /Владелец бота может получить/);
  assert.match(notice.text, /Сообщения и фото передаются внешним ИИ-сервисам/);
  assert.match(notice.text, /Поисковые запросы/);
  assert.match(notice.text, /\/clear/);
  assert.match(notice.text, /\/deleteall/);
  assert.match(notice.text, /Копии/);
  assert.doesNotMatch(notice.text, /Cloudflare|OpenRouter|Z\.AI|SQLite/);
  assert.ok(notice.text.length < 700);
  assert.equal(h.aiCalls.length, 0);

  const choice = buttons(h)[0];
  await messageOnly(h, h.message(ALICE, choice, 2));
  assert.equal(h.user().meta("consent"), "yes");
  assert.equal(last(h).reply_markup.remove_keyboard, true);
  assert.match(last(h).text, /Готово/);
  assert.equal(h.aiCalls.length, 0);

  await messageOnly(h, h.message(ALICE, "Как написать функцию?", 3));
  const response = last(h), system = h.aiCalls[0].input.messages[0].content;
  assert.ok(system.includes("Отвечай кратко"));
  assert.ok(system.includes("тройными обратными кавычками"));
  const inline = response.entities.find((e) => e.type === "code");
  const block = response.entities.find((e) => e.type === "pre");
  assert.equal(response.text.slice(inline.offset, inline.offset + inline.length), "x");
  assert.equal(block.language, "python");
  assert.equal(response.text.slice(block.offset, block.offset + block.length), "def greet(name):\n    return f'Привет, {name}!'");
  assert.doesNotMatch(response.text, /```/);
});

test("/agree остаётся запасным способом, старый callback тоже поддерживается при наличии подписки", async () => {
  const h = makeHarness();
  await messageOnly(h, h.message(ALICE, "/start", 1));
  await messageOnly(h, h.message(ALICE, "/agree", 2));
  assert.equal(h.user(ALICE).meta("consent"), "yes");
  await h.send(h.message(BOB, "/start", 3));
  await h.send(h.callback(BOB, "consent:yes", 4));
  assert.equal(h.user(BOB).meta("consent"), "yes");
  assert.ok(h.calls.some((c) => c.url.endsWith("/answerCallbackQuery")));
});

test("переключение чатов, режим и страницы памяти работают только через сообщения", async () => {
  const h = makeHarness(); await accept(h, ALICE, 1);
  await messageOnly(h, h.message(ALICE, "/new Второй", 3));
  await messageOnly(h, h.message(ALICE, "/chats", 4));
  const openFirst = buttons(h).find((label) => label === "💬 Чат 1");
  assert.ok(openFirst);
  await messageOnly(h, h.message(ALICE, openFirst, 5));
  assert.equal(h.user().meta("current"), "1");
  assert.equal(last(h).reply_markup.remove_keyboard, true);

  await messageOnly(h, h.message(ALICE, "/mode", 6));
  const ideasForFirst = buttons(h).find((label) => label === "💡 Идеи · чат 1");
  assert.ok(ideasForFirst);
  // An old mode button is bound to its original chat, not whichever chat is
  // current when it eventually arrives.
  await messageOnly(h, h.message(ALICE, "/chat 2", 7));
  await messageOnly(h, h.message(ALICE, ideasForFirst, 8));
  assert.equal(h.user().chat(1).mode, "ideas");
  assert.equal(h.user().chat(2).mode, "mentor");

  h.user().transaction(() => { for (let i = 0; i < 13; i++) h.user().addNote(2, "facts", `заметка ${i}`); });
  await messageOnly(h, h.message(ALICE, "/memory", 9));
  assert.match(last(h).text, /страница 1\/2/);
  const next = buttons(h).find((label) => label === "📄 Страница 2 · чат 2");
  await messageOnly(h, h.message(ALICE, next, 10));
  assert.match(last(h).text, /страница 2\/2/);
  assert.equal(h.aiCalls.length, 0);
});

test("подтверждения привязаны к действию, чату и пользователю; старые и отменённые не удаляют", async () => {
  const h = makeHarness(); await accept(h, ALICE, 1); await accept(h, BOB, 3);
  await messageOnly(h, h.message(ALICE, "История первого", 5));
  await messageOnly(h, h.message(ALICE, "/clear", 6));
  const old = buttons(h)[0];
  await messageOnly(h, h.message(ALICE, "/clear", 7));
  const fresh = buttons(h)[0];
  assert.notEqual(old, fresh);
  await messageOnly(h, h.message(ALICE, old, 8));
  assert.match(last(h).text, /устарела/);
  assert.equal(h.user(ALICE).rows("SELECT COUNT(*) AS n FROM messages")[0].n, 2);
  await messageOnly(h, h.message(BOB, fresh, 9));
  assert.match(last(h).text, /устарела/);
  assert.equal(h.user(ALICE).rows("SELECT COUNT(*) AS n FROM messages")[0].n, 2);
  await messageOnly(h, h.message(ALICE, fresh.replace("Очистить чат", "Удалить всё"), 10));
  assert.match(last(h).text, /устарела/);
  assert.equal(h.user(ALICE).rows("SELECT COUNT(*) AS n FROM messages")[0].n, 2);
  await messageOnly(h, h.message(ALICE, "/new Второй", 11));
  await messageOnly(h, h.message(ALICE, "История второго", 12));
  await messageOnly(h, h.message(ALICE, fresh, 13));
  assert.equal(h.user(ALICE).rows("SELECT COUNT(*) AS n FROM messages WHERE chat_id=1")[0].n, 0);
  assert.equal(h.user(ALICE).rows("SELECT COUNT(*) AS n FROM messages WHERE chat_id=2")[0].n, 2);
  await messageOnly(h, h.message(ALICE, "/delete", 14));
  const deletion = buttons(h)[0];
  await messageOnly(h, h.message(ALICE, "❌ Отмена", 15));
  await messageOnly(h, h.message(ALICE, deletion, 16));
  assert.match(last(h).text, /устарела/);
  assert.ok(h.user(ALICE).chat(2));
});

test("уже выпущенное полное callback-подтверждение остаётся совместимым", async () => {
  const h = makeHarness(); await accept(h, ALICE, 1);
  await messageOnly(h, h.message(ALICE, "история", 3));
  await messageOnly(h, h.message(ALICE, "/clear", 4));
  const token = h.user().rows("SELECT token FROM confirmations")[0].token;
  await h.send(h.callback(ALICE, `confirm:${token}`, 5));
  assert.equal(h.user().rows("SELECT COUNT(*) AS n FROM messages")[0].n, 0);
});

test("резервный ответ не дополняется названиями провайдеров", async () => {
  const h = makeHarness({
    settings: { ZAI_API_KEY: "fake-zai-key" },
    aiImpl: async () => { throw new Error("unavailable"); },
    networkImpl: async (url) => url === "https://api.z.ai/api/paas/v4/chat/completions"
      ? Response.json({ choices: [{ message: { content: "Ответ по делу." }, finish_reason: "stop" }] }) : null,
  });
  await accept(h, ALICE, 1);
  await messageOnly(h, h.message(ALICE, "Привет", 3));
  assert.equal(last(h).text, "Ответ по делу.");
});
