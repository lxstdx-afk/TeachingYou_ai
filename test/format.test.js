import { test } from "node:test";
import assert from "node:assert/strict";
import { formatReply, markdownToTelegram } from "../src/format.js";
import { sendReply } from "../src/telegram.js";

test("заголовки, жирный текст, списки и код превращаются в Telegram entities", () => {
  const result = markdownToTelegram('# Заголовок\n\nТекст **жирный**, *курсив* и `x_y`.\n\n- первый\n- второй\n\n```js\nif (a < 2 && b > 0) {\n  x++;\n}\n```');
  assert.ok(!result.text.includes("# Заголовок"));
  assert.ok(!result.text.includes("**жирный**"));
  assert.match(result.text, /• первый/);
  assert.match(result.text, /if \(a < 2 && b > 0\)/);
  assert.ok(result.entities.some((e) => e.type === "bold" && result.text.slice(e.offset, e.offset + e.length) === "Заголовок"));
  assert.ok(result.entities.some((e) => e.type === "bold" && result.text.slice(e.offset, e.offset + e.length) === "жирный"));
  assert.ok(result.entities.some((e) => e.type === "italic"));
  assert.ok(result.entities.some((e) => e.type === "code" && result.text.slice(e.offset, e.offset + e.length) === "x_y"));
  assert.ok(result.entities.some((e) => e.type === "pre" && e.language === "js"));
});

test("ссылки ограничены HTTP(S), HTML остаётся обычным текстом", () => {
  const result = markdownToTelegram('🙂 [источник](https://example.org/a?x=1) и [опасно](javascript:alert(1)) <script>alert(1)</script>');
  const links = result.entities.filter((e) => e.type === "text_link");
  assert.equal(links.length, 1);
  assert.equal(links[0].url, "https://example.org/a?x=1");
  assert.equal(result.text.slice(links[0].offset, links[0].offset + links[0].length), "источник");
  assert.match(result.text, /<script>/);
  assert.ok(!JSON.stringify(links).includes("javascript"));
});

test("перекрытие code и жирного текста не создаёт запрещённых вложений", () => {
  const result = markdownToTelegram("**Текст `const value` внутри** и отдельно **жирно**");
  const code = result.entities.find((e) => e.type === "code");
  assert.ok(code);
  for (const e of result.entities.filter((x) => x.type !== "code" && x.type !== "pre")) {
    assert.ok(e.offset + e.length <= code.offset || code.offset + code.length <= e.offset);
  }
});

test("длинный ответ делится без разрыва эмодзи и с корректными offsets", () => {
  const source = "**" + "а".repeat(3498) + "🙂" + "б".repeat(3900) + "**";
  const parts = formatReply(source);
  assert.equal(parts.length, 3);
  assert.equal(parts.map((p) => p.text).join(""), source.slice(2, -2));
  for (const part of parts) {
    assert.ok(part.text.length <= 3500);
    for (const c of part.text) assert.ok(!(c.codePointAt(0) >= 0xd800 && c.codePointAt(0) <= 0xdfff));
    for (const e of part.entities) assert.ok(e.offset >= 0 && e.length > 0 && e.offset + e.length <= part.text.length);
  }
});

test("очень длинный ответ ограничивается четырьмя частями с уведомлением", () => {
  const parts = formatReply("🙂".repeat(10000));
  assert.equal(parts.length, 4);
  assert.match(parts.at(-1).text, /Ответ сокращён/);
  assert.ok(parts.every((p) => p.text.length <= 3500));
});

test("Telegram 400 именно из-за разметки повторяется как простой текст", async () => {
  const attempts = [];
  const f = async (_url, options) => {
    const body = JSON.parse(options.body); attempts.push(body);
    if (attempts.length === 1) return Response.json({ ok: false, description: "Bad Request: can't parse entities" }, { status: 400 });
    return Response.json({ ok: true });
  };
  assert.equal(await sendReply(f, "fake", 1, "**Текст**"), true);
  assert.equal(attempts.length, 2);
  assert.ok(attempts[0].entities);
  assert.equal(attempts[1].entities, undefined);
  assert.equal(attempts[1].text, "Текст");
});

test("неопределённая ошибка сети не вызывает повторной отправки", async () => {
  let attempts = 0;
  const f = async () => { attempts++; throw new Error("network"); };
  assert.equal(await sendReply(f, "fake", 1, "**Текст**"), false);
  assert.equal(attempts, 1);
});
