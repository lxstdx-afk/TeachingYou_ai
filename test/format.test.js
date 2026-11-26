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

test("конечные отступы и пробелы в коде не удаляются", () => {
  const markdown = '```python\ndef greet():\n    return "🙂"  \n  \n```';
  const result = markdownToTelegram(markdown);
  assert.equal(result.text, 'def greet():\n    return "🙂"  \n  ');
  assert.deepEqual(result.entities, [{ type: "pre", offset: 0, length: result.text.length, language: "python" }]);
});

test("жирное вокруг вставки кода сохраняется с обеих сторон без пересечения", () => {
  const result = markdownToTelegram("**До `const x` и после**");
  const content = (e) => result.text.slice(e.offset, e.offset + e.length);
  assert.deepEqual(result.entities.filter((e) => e.type === "bold").map(content), ["До ", " и после"]);
  assert.equal(content(result.entities.find((e) => e.type === "code")), "const x");
});

test("длинный блок сохраняет отступы, язык, эмодзи и все символы после деления", async () => {
  const code = 'const x = 1;\n' + '  x += 2;\n'.repeat(420) + 'console.log("🙂");';
  const markdown = 'Пример 🙂\n\n```javascript\n' + code + '\n```\n\nЗначение `x`.';
  const expected = markdownToTelegram(markdown);
  const sent = [];
  const fetchImpl = async (_url, options) => { sent.push(JSON.parse(options.body)); return Response.json({ ok: true }); };
  assert.equal(await sendReply(fetchImpl, "fake", 1, markdown), true);
  assert.ok(sent.length > 1);
  assert.equal(sent.map((part) => part.text).join(""), expected.text);
  assert.equal(sent.flatMap((part) => (part.entities || []).filter((e) => e.type === "pre")
    .map((e) => part.text.slice(e.offset, e.offset + e.length))).join(""), code);
  for (const part of sent) {
    assert.ok(part.text.length <= 3500);
    for (const e of part.entities || []) {
      assert.ok(e.offset >= 0 && e.offset + e.length <= part.text.length);
      if (e.type === "pre") assert.equal(e.language, "javascript");
    }
    for (const c of part.text) assert.ok(!(c.codePointAt(0) >= 0xd800 && c.codePointAt(0) <= 0xdfff));
  }
});

test("небольшой кодовый блок не разрывается из-за предшествующего текста", () => {
  const code = '    print("ok")\n'.repeat(50).trimEnd();
  const markdown = 'a'.repeat(3200) + '\n\n```python\n' + code + '\n```\n\nГотово.';
  const expected = markdownToTelegram(markdown);
  const parts = formatReply(markdown);
  assert.equal(parts.map((p) => p.text).join(""), expected.text);
  const blocks = parts.flatMap((p) => p.entities.filter((e) => e.type === "pre").map((e) => ({ part: p, entity: e })));
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].part.text.slice(blocks[0].entity.offset, blocks[0].entity.offset + blocks[0].entity.length), code);
});

test("предупреждение о сокращении не попадает внутрь форматирования кода", () => {
  const parts = formatReply('```js\n' + 'x'.repeat(15000) + '\n```');
  assert.equal(parts.length, 4);
  const last = parts.at(-1), notice = last.text.indexOf("… Ответ сокращён");
  assert.ok(notice >= 0);
  assert.ok(last.entities.filter((e) => e.type === "pre").every((e) => e.offset + e.length <= notice));
});
