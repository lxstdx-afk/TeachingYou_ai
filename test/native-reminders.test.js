import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReminderMessage, localParts, MAX_REMINDER_AHEAD_MS, normalizeTimeZone, parseReminderTime } from "../src/reminders.js";
import { sendNativeReminder } from "../src/telegram.js";

const stamp = (text) => Date.parse(text);

test("часовой пояс принимается явно: IANA или корректное фиксированное UTC-смещение", () => {
  assert.equal(normalizeTimeZone("Europe/Moscow"), "Europe/Moscow");
  assert.equal(normalizeTimeZone("Europe/Stockholm"), "Europe/Stockholm");
  assert.equal(normalizeTimeZone("utc+3"), "UTC+03:00");
  assert.equal(normalizeTimeZone("-05:30"), "UTC-05:30");
  assert.equal(normalizeTimeZone("UTC+05:45"), "UTC+05:45");
  assert.equal(normalizeTimeZone("UTC"), "UTC");
  for (const bad of ["", "Moscow", "Europe/NoSuchCity", "UTC+14:01", "UTC-15", "UTC+03:60", "Europe/Moscow;bad", "A".repeat(100)]) {
    assert.equal(normalizeTimeZone(bad), null, bad);
  }
});

test("указанное местное время переводится в UTC с учётом пояса и сезона", () => {
  const winter = stamp("2026-11-22T12:00:00Z");
  assert.equal(parseReminderTime("23.11.2026 18:00", "Europe/Moscow", winter).at, stamp("2026-11-23T15:00:00Z"));
  assert.equal(parseReminderTime("23.11.2026 18:00", "Europe/Stockholm", winter).at, stamp("2026-11-23T17:00:00Z"));
  assert.equal(parseReminderTime("23.11.2026 18:00", "UTC+05:45", winter).at, stamp("2026-11-23T12:15:00Z"));
  assert.equal(parseReminderTime("23.11.2026 18:00", "UTC-03:30", winter).at, stamp("2026-11-23T21:30:00Z"));
  const summer = stamp("2027-06-01T12:00:00Z");
  assert.equal(parseReminderTime("02.07.2027 18:00", "Europe/Stockholm", summer).at, stamp("2027-07-02T16:00:00Z"));
});

test("сегодня и завтра считаются в выбранной зоне, в том числе на границе года", () => {
  const now = stamp("2026-12-31T22:30:00Z"); // In Moscow it is already January 1.
  assert.deepEqual(localParts(now, "Europe/Moscow"), { year: 2027, month: 1, day: 1, hour: 1, minute: 30 });
  assert.equal(parseReminderTime("сегодня в 18:00", "Europe/Moscow", now).at, stamp("2027-01-01T15:00:00Z"));
  assert.equal(parseReminderTime("завтра 18:00", "Europe/Moscow", now).at, stamp("2027-01-02T15:00:00Z"));
  assert.equal(parseReminderTime("завтра 18:00", "UTC-03:30", now).at, stamp("2027-01-01T21:30:00Z"));
});

test("некорректное, прошедшее и слишком далёкое время не принимается молча", () => {
  const now = stamp("2026-11-22T12:00:00Z");
  assert.equal(parseReminderTime("на неделе", "UTC", now).error, "format");
  assert.equal(parseReminderTime("31.11.2026 18:00", "UTC", now).error, "invalid");
  assert.equal(parseReminderTime("23.11.2026 24:00", "UTC", now).error, "invalid");
  assert.equal(parseReminderTime("23.11.2026 12:99", "UTC", now).error, "invalid");
  assert.equal(parseReminderTime("22.11.2026 12:00", "UTC", now).error, "past");
  assert.equal(parseReminderTime("23.11.2028 12:00", "UTC", now).error, "far");
  assert.equal(parseReminderTime("23.11.2026 18:00", "bad", now).error, "zone");
  assert.ok(MAX_REMINDER_AHEAD_MS <= 365 * 86_400_000);
  assert.equal(parseReminderTime("29.02.2027 18:00", "UTC", stamp("2026-12-01T00:00:00Z")).error, "invalid");
  assert.equal(parseReminderTime("29.02.2028 18:00", "UTC", stamp("2027-12-01T00:00:00Z")).at, stamp("2028-02-29T18:00:00Z"));
});

test("пропущенное и повторяющееся местное время при переводе часов не угадываются", () => {
  const spring = parseReminderTime("28.03.2027 02:30", "Europe/Stockholm", stamp("2027-03-20T00:00:00Z"));
  const autumn = parseReminderTime("25.10.2026 02:30", "Europe/Stockholm", stamp("2026-10-20T00:00:00Z"));
  assert.equal(spring.error, "nonexistent");
  assert.equal(autumn.error, "ambiguous");
  assert.equal(parseReminderTime("03.10.2027 02:15", "Australia/Lord_Howe", stamp("2027-09-25T00:00:00Z")).error, "nonexistent");
  assert.equal(parseReminderTime("04.04.2027 01:45", "Australia/Lord_Howe", stamp("2027-03-25T00:00:00Z")).error, "ambiguous");
  assert.equal(parseReminderTime("25.10.2026 02:30", "UTC+02:00", stamp("2026-10-20T00:00:00Z")).at, stamp("2026-10-25T00:30:00Z"));
});

test("кликабельная дата размечена UTF-16, сырая строка остаётся понятной как UTC", () => {
  const at = stamp("2026-12-01T17:42:00Z");
  const msg = buildReminderMessage("😀 Позвонить маме", at);
  assert.equal(msg.entities.length, 1);
  const ent = msg.entities[0];
  assert.deepEqual({ type: ent.type, unix_time: ent.unix_time, date_time_format: ent.date_time_format },
    { type: "date_time", unix_time: at / 1000, date_time_format: "wDt" });
  assert.equal(msg.text.slice(ent.offset, ent.offset + ent.length), "2026-12-01 17:42:00 UTC");
  assert.equal(buildReminderMessage("Таймер", at + 42_987).text.includes("17:42:42 UTC"), true);
  assert.match(msg.text, /Пока не подтвердил — оно не создано/);
  assert.match(msg.text, /часовому поясу устройства/);
  assert.match(msg.text, /Для проверки: 2026-12-01 17:42:00 UTC/);
  assert.match(msg.text, /Избранном/);
  assert.doesNotMatch(msg.text, /уже (?:создано|установлено)/i);
  for (const [note, time] of [["", at], ["a".repeat(401), at], ["ok", NaN]]) {
    assert.throws(() => buildReminderMessage(note, time));
  }
});

test("если Telegram явно отклонил date_time, показывается честный ручной запасной вариант", async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    if (calls.length === 1) return Response.json({ ok: false, description: "Bad Request: can't parse entities: unsupported date_time" }, { status: 400 });
    return Response.json({ ok: true, result: {} });
  };
  const at = stamp("2026-12-01T17:42:00Z");
  assert.equal(await sendNativeReminder(fetcher, "fake-token", 123, { text: "Проверить 😀", at }, { remove_keyboard: true }), true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.entities[0].type, "date_time");
  assert.equal(calls[1].body.entities, undefined);
  assert.match(calls[1].body.text, /напоминание не создано/i);
  assert.match(calls[1].body.text, /2026-12-01 17:42:00 UTC/);
  assert.match(calls[1].body.text, /Избранное/);
});

test("неоднозначную сетевую ошибку отправки заготовки не повторяют", async () => {
  let calls = 0;
  const fetcher = async () => { calls++; throw new Error("connection lost"); };
  const ok = await sendNativeReminder(fetcher, "fake-token", 123, { text: "Позвонить", at: stamp("2026-12-01T17:42:00Z") });
  assert.equal(ok, false);
  assert.equal(calls, 1);
});
