// Первый этап: проверка настройки секрета без вызовов Telegram или моделей.
// Содержимое секрета не выводится. Позже заменим этот тест кодом бота.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method !== "GET" || url.pathname !== "/") {
      return new Response("Пока не настроено", { status: 404 });
    }

    const message = env.TELEGRAM_BOT_TOKEN
      ? "✅ Секрет Telegram найден!"
      : "❌ Секрет Telegram не найден. Проверь его имя.";

    return new Response(message, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  },
};
