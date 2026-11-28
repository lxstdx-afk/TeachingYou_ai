// These are ordinary reply-keyboard labels: they arrive as message updates and
// do not require changing the existing message-only Telegram webhook.
export const UI = Object.freeze({
  chats: "💬 Чаты", search: "🔎 Поиск и книги", memory: "🧠 Память", reminder: "⏰ Напоминание",
  settings: "⚙️ Настройки", help: "❓ Помощь", back: "⬅️ В меню", hide: "✍️ Скрыть меню",
  newChat: "🆕 Новый чат", listChats: "📂 Мои чаты", renameChat: "✏️ Назвать чат", deleteChat: "🗑 Удалить чат",
  web: "🌐 Поиск в интернете", book: "📚 Найти книгу в PDF",
  showMemory: "📝 Посмотреть память", pin: "📌 Закрепить заметку", removeNote: "🗑 Удалить заметку",
  mode: "🎭 Режим общения", privacy: "🔒 О данных", clearChat: "🧹 Очистить чат", deleteAll: "🗑 Удалить все данные",
  in5: "⏱ Через 5 минут", in30: "⏱ Через 30 минут", in60: "⏱ Через 1 час", in24h: "⏱ Через 24 часа",
  exact: "📅 Дата и время", moscow: "🇷🇺 Москва", stockholm: "🇸🇪 Стокгольм", otherZone: "🌍 Другой часовой пояс",
  changeZone: "🌍 Изменить часовой пояс", cancel: "❌ Отмена",
});

export const REMINDER_DELAYS = Object.freeze({
  [UI.in5]: 5 * 60_000, [UI.in30]: 30 * 60_000,
  [UI.in60]: 60 * 60_000, [UI.in24h]: 24 * 60 * 60_000,
});

export function uiKeyboard(rows) {
  return { keyboard: rows.map((row) => row.map((text) => ({ text }))), resize_keyboard: true, one_time_keyboard: true };
}
export function mainKeyboard() {
  return uiKeyboard([[UI.chats, UI.search], [UI.memory, UI.reminder], [UI.settings, UI.help], [UI.hide]]);
}
export function sectionKeyboard(section) {
  const tail = [[UI.back, UI.hide]];
  if (section === "chats") return uiKeyboard([[UI.newChat, UI.listChats], [UI.renameChat, UI.deleteChat], ...tail]);
  if (section === "search") return uiKeyboard([[UI.web], [UI.book], ...tail]);
  if (section === "memory") return uiKeyboard([[UI.showMemory], [UI.pin, UI.removeNote], ...tail]);
  if (section === "settings") return uiKeyboard([[UI.mode, UI.privacy], [UI.clearChat, UI.deleteAll], ...tail]);
  return mainKeyboard();
}
export function reminderWhenKeyboard() {
  return uiKeyboard([[UI.in5, UI.in30], [UI.in60, UI.in24h], [UI.exact], [UI.cancel, UI.back]]);
}
export function reminderZoneKeyboard() {
  return uiKeyboard([[UI.moscow, UI.stockholm], [UI.otherZone], [UI.cancel, UI.back]]);
}
export function reminderDateKeyboard() { return uiKeyboard([[UI.changeZone], [UI.cancel, UI.back]]); }
export function inputKeyboard() { return uiKeyboard([[UI.cancel, UI.back]]); }
