import { UI, REMINDER_DELAYS, mainKeyboard, sectionKeyboard, reminderWhenKeyboard, reminderZoneKeyboard, reminderDateKeyboard, inputKeyboard } from "./menu.js";
import { MAX_REMINDER_TEXT, MIN_REMINDER_LEAD_MS, exampleDate, normalizeTimeZone, parseReminderTime } from "./reminders.js";

const UI_FLOW_TTL = 15 * 60 * 1000;
const REMOVE_KEYBOARD = { remove_keyboard: true };
const ALL_LABELS = new Set(Object.values(UI));
const aliases = new Map([
  [UI.listChats, "chats"], [UI.deleteChat, "delete"], [UI.showMemory, "memory"],
  [UI.mode, "mode"], [UI.privacy, "privacy"], [UI.clearChat, "clear"], [UI.deleteAll, "deleteall"],
]);
const inputs = new Map([
  [UI.renameChat, "rename"], [UI.web, "search"], [UI.book, "book"],
  [UI.pin, "remember"], [UI.removeNote, "removeNote"],
]);
const inputHints = {
  rename: "Отправь новое название текущего чата — до 60 символов.",
  search: "Напиши, что найти в интернете. Я покажу ответ и доступные источники.",
  book: "Напиши название книги; если знаешь автора, добавь его через |. Ищу только открытые PDF.",
  remember: "Напиши заметку, которую нужно закрепить в памяти текущего чата — до 400 символов.",
  removeNote: "Напиши номер заметки из раздела «Посмотреть память»: например, 3 для закрепления или A3 для автозаметки.",
};
function escapeMd(value) { return String(value ?? "").replace(/[\\`*_{}\[\]<>]/g, "\\$&"); }
function reply(value) { return { reply: value }; }
function flowKeyboard(flow) {
  if (flow?.kind === "reminder") {
    if (flow.step === "when") return reminderWhenKeyboard();
    if (flow.step === "zone") return reminderZoneKeyboard();
    if (flow.step === "date") return reminderDateKeyboard();
  }
  return inputKeyboard();
}

export function clearUi(bot) {
  if (bot.meta("ui_flow")) bot.sql.exec("DELETE FROM meta WHERE key='ui_flow'");
}
function saveUi(bot, chat, value) {
  // A reminder's text is never kept in this wizard state: time is selected
  // first and the final text goes straight from the queued job to Telegram.
  bot.setMeta("ui_flow", JSON.stringify({ ...value, chatId: chat.id, expiresAt: Date.now() + UI_FLOW_TTL }));
}
function loadUi(bot) {
  const raw = bot.meta("ui_flow");
  if (!raw) return { flow: null, expired: false };
  try {
    const flow = JSON.parse(raw);
    if (flow && typeof flow.kind === "string" && Number.isSafeInteger(flow.chatId) &&
        Number.isSafeInteger(flow.expiresAt) && flow.expiresAt > Date.now()) return { flow, expired: false };
  } catch { /* Discard corrupt state rather than routing it to the model. */ }
  clearUi(bot);
  return { flow: null, expired: true };
}

export function openMenu(chat) {
  return {
    text: `**Главное меню**\nОткрыт чат: **${escapeMd(chat.title)}**.\n\nВыбери раздел под полем ввода. Вопрос можно написать обычным текстом; /menu снова откроет кнопки.`,
    markup: mainKeyboard(),
  };
}
function section(chat, name) {
  const copy = {
    chats: `**Чаты** · ${escapeMd(chat.title)}\nСоздавай отдельные темы и переключайся между ними. У каждого чата своя история и память.`,
    search: "**Поиск и книги**\nМожно найти информацию в интернете с источниками или поискать открытый PDF по названию. Проверяй издание и условия использования книги.",
    memory: `**Память чата «${escapeMd(chat.title)}»**\nПосмотри заметки, закрепи важное или удали заметку по номеру. Автоматические заметки могут ошибаться.`,
    settings: "**Настройки**\nЗдесь можно выбрать режим и посмотреть сведения о данных. Очистка и удаление запросят отдельное подтверждение.",
  };
  return { text: copy[name], markup: sectionKeyboard(name) };
}

export function beginReminder(bot, chat) {
  saveUi(bot, chat, { kind: "reminder", step: "when" });
  return {
    text: "**Напоминание в Telegram**\nВыбери время, затем пришли текст. Бот обработает его без ИИ и покажет дату для напоминания в «Избранном». До подтверждения в Telegram оно не установлено.",
    markup: reminderWhenKeyboard(),
  };
}
function zonePrompt(bot, chat) {
  saveUi(bot, chat, { kind: "reminder", step: "zone" });
  return { text: "Выбери часовой пояс для точной даты. Бот сохранит его для следующих напоминаний; изменить выбор можно при создании напоминания, удалить — через /deleteall. Автоматически пояс не определяю.", markup: reminderZoneKeyboard() };
}
function datePrompt(bot, chat, zone) {
  saveUi(bot, chat, { kind: "reminder", step: "date", zone });
  return {
    text: `**Точное время**\nПояс: ${escapeMd(zone)}.\n\nОтправь дату и время, например: ${exampleDate(zone)}. Можно также: завтра 18:00.\n\nПоддерживаются даты не более чем на 365 дней вперёд.`,
    markup: reminderDateKeyboard(),
  };
}
function askReminderText(bot, chat, at) {
  saveUi(bot, chat, { kind: "reminder", step: "text", at });
  return { text: `Напиши, о чём напомнить, одним текстовым сообщением (до ${MAX_REMINDER_TEXT} символов). Затем нужно нажать дату и подтвердить в Telegram.`, markup: inputKeyboard() };
}
const TIME_ERRORS = {
  zone: "Часовой пояс не распознан. Выбери его ещё раз.",
  format: "Не понял дату. Напиши в формате ДД.ММ.ГГГГ ЧЧ:ММ или, например, завтра 18:00.",
  invalid: "Такой даты или времени нет. Проверь день, месяц и часы.",
  nonexistent: "Это местное время не существует из-за перехода часов. Выбери другое время.",
  ambiguous: "Это местное время повторяется из-за перевода часов. Выбери другое время или укажи точное UTC-смещение через «Изменить часовой пояс».",
  past: "Время уже прошло или слишком близко. Выбери хотя бы через минуту.",
  far: "Для этой версии выбери время не дальше 365 дней вперёд.",
};
function routeReminder(bot, chat, flow, text) {
  if (flow.step === "when") {
    const delay = REMINDER_DELAYS[text];
    if (Number.isSafeInteger(delay)) return askReminderText(bot, chat, Date.now() + delay);
    if (text === UI.exact) {
      const zone = normalizeTimeZone(bot.meta("reminder_timezone"));
      return zone ? datePrompt(bot, chat, zone) : zonePrompt(bot, chat);
    }
    return { text: "Выбери один из вариантов времени кнопкой или нажми «Отмена».", markup: reminderWhenKeyboard() };
  }
  if (flow.step === "zone") {
    if (text === UI.otherZone) {
      saveUi(bot, chat, { kind: "reminder", step: "zoneInput" });
      return { text: "Напиши часовой пояс, например Europe/Moscow, Europe/Stockholm или UTC+03:00. Фиксированное UTC-смещение не меняется при переводе часов.", markup: inputKeyboard() };
    }
    const requested = text === UI.moscow ? "Europe/Moscow" : text === UI.stockholm ? "Europe/Stockholm" : text;
    const zone = normalizeTimeZone(requested);
    if (!zone) return { text: "Пояс не распознан. Выбери город кнопкой или «Другой часовой пояс».", markup: reminderZoneKeyboard() };
    bot.setMeta("reminder_timezone", zone);
    return datePrompt(bot, chat, zone);
  }
  if (flow.step === "zoneInput") {
    const zone = normalizeTimeZone(text);
    if (!zone) return { text: "Пояс не распознан. Пример: Europe/Moscow или UTC+03:00. Попробуй ещё раз либо нажми «Отмена».", markup: inputKeyboard() };
    bot.setMeta("reminder_timezone", zone);
    return datePrompt(bot, chat, zone);
  }
  if (flow.step === "date") {
    if (text === UI.changeZone) return zonePrompt(bot, chat);
    const value = parseReminderTime(text, flow.zone);
    if (value.error === "zone") return zonePrompt(bot, chat);
    if (value.error) return { text: `${TIME_ERRORS[value.error]}\nЧасовой пояс: ${escapeMd(flow.zone)}.`, markup: reminderDateKeyboard() };
    return askReminderText(bot, chat, value.at);
  }
  if (flow.step === "text") {
    if (!Number.isSafeInteger(flow.at) || flow.at < Date.now() + MIN_REMINDER_LEAD_MS) {
      clearUi(bot);
      return { text: "Выбранное время уже прошло или слишком близко. Начни заново через /remind.", markup: REMOVE_KEYBOARD };
    }
    if (!text) return { text: "Напиши, о чём напомнить, или нажми «Отмена».", markup: inputKeyboard() };
    if (text.length > MAX_REMINDER_TEXT) return { text: `Текст слишком длинный. Сократи его до ${MAX_REMINDER_TEXT} символов.`, markup: inputKeyboard() };
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return { text: "В тексте есть неподдерживаемые служебные символы. Пришли его обычным сообщением.", markup: inputKeyboard() };
    clearUi(bot);
    return { reminder: { text, at: flow.at }, markup: REMOVE_KEYBOARD };
  }
  clearUi(bot);
  return { text: "Шаг напоминания устарел. Начни заново через /remind.", markup: REMOVE_KEYBOARD };
}

// Called inside the queue's existing storage transaction. A result is either a
// completed reply or a command to run through the existing command handlers.
export function routeUi(bot, job, payload, chat, cmd, data) {
  if (payload.kind === "message" && payload.photo) {
    const state = loadUi(bot);
    if (state.expired) return reply({ text: "Предыдущее действие истекло. Открой /menu и начни ещё раз.", markup: REMOVE_KEYBOARD });
    if (state.flow) return reply({ text: "Здесь нужен текст или выбор кнопкой, а не изображение. Продолжи действие или нажми «Отмена».", markup: flowKeyboard(state.flow) });
    return null; // A normal photo remains a question for the vision model.
  }
  if (payload.kind === "message" && cmd && !["menu", "remind", "start", "help", "privacy", "clear", "delete", "deleteall"].includes(cmd.name)) {
    const state = loadUi(bot);
    if (state.expired) return reply({ text: "Предыдущее действие истекло. Открой /menu и начни ещё раз.", markup: REMOVE_KEYBOARD });
    // A slash command in a reminder draft might actually be the reminder text.
    // Never send it to search/the model or mutate memory without an explicit
    // cancellation first. Navigation and privacy/deletion commands remain exits;
    // destructive actions still require their existing separate confirmation.
    if (state.flow?.kind === "reminder") return reply({
      text: "Сейчас создаётся заготовка. Чтобы выполнить другую команду, сначала нажми «Отмена». Если это текст напоминания, добавь в начале слова, например «Напомнить:».",
      markup: flowKeyboard(state.flow),
    });
  }
  if (payload.kind !== "message" || cmd || data) {
    if (cmd || data || payload.kind === "callback") clearUi(bot);
    return null;
  }
  const text = String(payload.text || "").trim();
  if (text === UI.back) { clearUi(bot); return reply(openMenu(chat)); }
  if (text === UI.hide) { clearUi(bot); return reply({ text: "Меню скрыто. Открыть снова — /menu.", markup: REMOVE_KEYBOARD }); }
  if (text === UI.chats) { clearUi(bot); return reply(section(chat, "chats")); }
  if (text === UI.search) { clearUi(bot); return reply(section(chat, "search")); }
  if (text === UI.memory) { clearUi(bot); return reply(section(chat, "memory")); }
  if (text === UI.settings) { clearUi(bot); return reply(section(chat, "settings")); }
  if (text === UI.help) { clearUi(bot); return reply({ text: bot.help(chat), markup: inputKeyboard() }); }
  if (text === UI.reminder) { clearUi(bot); return reply(beginReminder(bot, chat)); }
  if (aliases.has(text)) { clearUi(bot); return { command: { name: aliases.get(text), arg: "" } }; }
  if (inputs.has(text)) {
    clearUi(bot);
    const kind = inputs.get(text);
    saveUi(bot, chat, { kind });
    return reply({ text: inputHints[kind], markup: inputKeyboard() });
  }
  const { flow, expired } = loadUi(bot);
  if (expired) return reply({ text: "Предыдущее действие истекло. Открой /menu и начни ещё раз.", markup: REMOVE_KEYBOARD });
  if (!flow) {
    if (ALL_LABELS.has(text)) return reply({ text: "Эта кнопка устарела. Открой /menu и выбери действие снова.", markup: REMOVE_KEYBOARD });
    return null;
  }
  if (flow.chatId !== chat.id || !bot.chat(flow.chatId)) {
    clearUi(bot);
    return reply({ text: "Исходный чат изменился. Открой /menu и начни действие заново.", markup: REMOVE_KEYBOARD });
  }
  // A repeated tap on an earlier preset must not become the reminder's text
  // (or a chat title / search query) just because the next step has begun.
  if (ALL_LABELS.has(text) && (flow.kind !== "reminder" || flow.step === "text")) {
    return reply({ text: "Сейчас нужен текст. Напиши его или нажми «Отмена».", markup: inputKeyboard() });
  }
  if (flow.kind === "reminder") return reply(routeReminder(bot, chat, flow, text));
  const limit = flow.kind === "rename" ? 60 : 400;
  if (!text) return reply({ text: "Пришли текст или нажми «Отмена».", markup: inputKeyboard() });
  if (text.length > limit) return reply({ text: `Слишком длинно: не больше ${limit} символов. Попробуй ещё раз.`, markup: inputKeyboard() });
  let name = flow.kind, arg = text;
  if (name === "removeNote") {
    const match = text.match(/^([aа]?)(\d{1,16})$/iu);
    if (!match) return reply({ text: "Укажи номер из памяти: например, 3 или A3.", markup: inputKeyboard() });
    name = match[1] ? "forget" : "unpin";
    arg = match[2];
  }
  if (!["rename", "search", "book", "remember", "forget", "unpin"].includes(name)) {
    clearUi(bot);
    return reply({ text: "Это действие устарело. Открой /menu и попробуй снова.", markup: REMOVE_KEYBOARD });
  }
  clearUi(bot);
  // Persist the transformed search/book payload atomically with consuming the
  // wizard state. If the alarm is interrupted, retry takes the same route and
  // will not accidentally send the user's input to a different handler.
  payload.text = `/${name} ${arg}`;
  payload.uiCompleted = true;
  bot.sql.exec("UPDATE jobs SET payload=? WHERE update_id=?", JSON.stringify(payload), job.update_id);
  return { command: { name, arg } };
}
