import { test } from "node:test";
import assert from "node:assert/strict";
import { ALICE, makeHarness } from "./harness.js";

test("завершившаяся после очистки сводка не восстанавливает удалённые заметки", async () => {
  let release, notify;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { notify = resolve; });
  const h = makeHarness({ aiImpl: async (_model, input) => {
    if (String(input.messages[0]?.content).includes("Извлекай факты")) {
      notify(); await gate;
      return { choices: [{ message: { content: JSON.stringify({ facts: ["удалённая настройка"] }) } }] };
    }
    return { choices: [{ message: { content: "ответ" } }] };
  } });
  await h.send(h.message(ALICE, "/start", 1));
  await h.send(h.callback(ALICE, "consent:yes", 2));
  const obj = h.user();
  obj.transaction(() => {
    for (let i = 0; i < 3; i++) {
      obj.addMessage(1, "user", `Важный вопрос ${i}`, i + 10);
      obj.addMessage(1, "assistant", `Ответ ${i}`, i + 10);
    }
  });
  const pending = obj.updateMemory(1);
  await started;
  obj.transaction(() => obj.clearChat(1));
  release(); await pending;
  assert.equal(obj.rows("SELECT COUNT(*) AS n FROM memory_notes")[0].n, 0);
  assert.equal(obj.rows("SELECT COUNT(*) AS n FROM memory_search")[0].n, 0);
  assert.equal(obj.rows("SELECT COUNT(*) AS n FROM messages")[0].n, 0);
  assert.equal(obj.chat(1).summary_through, 0);
});
