import { marked } from "marked";

// Telegram accepts explicit entities with UTF-16 offsets. Unlike parse_mode,
// this does not interpret arbitrary model output as Telegram markup.
const MAX_PART = 3500;
const MAX_PARTS = 4;

function safeLink(value) {
  try {
    if (typeof value !== "string" || value.length > 2048) return null;
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function markdownToTelegram(markdown) {
  let text = "";
  const entities = [];
  const add = (s) => { text += String(s ?? ""); };
  const newline = (count = 1) => {
    if (!text) return;
    const have = (text.match(/\n*$/)?.[0].length ?? 0);
    if (have < count) add("\n".repeat(count - have));
  };
  const span = (type, fn, extra = {}) => {
    const start = text.length;
    fn();
    const length = text.length - start;
    if (length > 0 && text.slice(start).trim()) entities.push({ type, offset: start, length, ...extra });
  };

  function inline(tokens = []) {
    for (const token of tokens) {
      switch (token.type) {
        case "text":
          if (Array.isArray(token.tokens)) inline(token.tokens); else add(token.text);
          break;
        case "escape": add(token.text); break;
        case "strong": span("bold", () => inline(token.tokens)); break;
        case "em": span("italic", () => inline(token.tokens)); break;
        case "del": span("strikethrough", () => inline(token.tokens)); break;
        case "codespan": span("code", () => add(token.text)); break;
        case "br": add("\n"); break;
        case "link": {
          const url = safeLink(token.href);
          if (url) span("text_link", () => inline(token.tokens), { url });
          else inline(token.tokens);
          break;
        }
        case "image": add(token.text || "[изображение]"); break;
        case "html": add(token.text); break; // literal text, not Telegram HTML
        default:
          if (Array.isArray(token.tokens)) inline(token.tokens); else add(token.text ?? token.raw ?? "");
      }
    }
  }

  function blocks(tokens = [], level = 0) {
    for (const token of tokens) {
      switch (token.type) {
        case "space": newline(2); break;
        case "heading":
          newline(1);
          span("bold", () => inline(token.tokens));
          newline(1);
          break;
        case "paragraph":
        case "text":
          if (Array.isArray(token.tokens)) inline(token.tokens); else add(token.text);
          newline(1);
          break;
        case "code": {
          newline(1);
          const lang = typeof token.lang === "string" ? token.lang.trim().split(/\s+/)[0] : "";
          const extra = /^[\w+.-]{1,30}$/.test(lang) ? { language: lang } : {};
          span("pre", () => add(token.text), extra);
          newline(1);
          break;
        }
        case "list":
          newline(1);
          token.items.forEach((item, index) => {
            add("  ".repeat(Math.min(level, 3)) + (token.ordered ? `${(Number(token.start) || 1) + index}. ` : "• "));
            if (item.task) add(item.checked ? "☑ " : "☐ ");
            blocks(item.tokens, level + 1);
            newline(1);
          });
          break;
        case "blockquote":
          newline(1);
          add("▎ ");
          blocks(token.tokens, level + 1);
          newline(1);
          break;
        case "hr": newline(1); add("────────"); newline(1); break;
        case "table": {
          newline(1);
          const row = (cells) => {
            cells.forEach((cell, i) => { if (i) add(" | "); inline(cell.tokens); });
            newline(1);
          };
          span("bold", () => row(token.header));
          for (const cells of token.rows) row(cells);
          break;
        }
        case "html": newline(1); add(token.text); newline(1); break;
        default:
          if (Array.isArray(token.tokens)) blocks(token.tokens, level);
          else if (token.text) { add(token.text); newline(1); }
      }
    }
  }

  try {
    blocks(marked.lexer(String(markdown ?? "").slice(0, 50_000), { gfm: true }));
  } catch {
    // A parser failure must never stop delivery; send text literally instead.
    return { text: String(markdown ?? "").slice(0, 50_000).trim(), entities: [] };
  }
  text = text.trimEnd();
  const end = text.length;
  // Telegram does not allow styles overlapping code/pre. Also remove identical
  // and redundant nested entities of the same type.
  const sorted = entities.filter((e) => e.offset < end).map((e) => ({
    ...e, length: Math.min(e.length, end - e.offset),
  })).filter((e) => e.length > 0).sort((a, b) => a.offset - b.offset || b.length - a.length);
  const code = sorted.filter((e) => e.type === "pre" || e.type === "code");
  const valid = [];
  for (const e of sorted) {
    const overlapCode = e.type !== "pre" && e.type !== "code" && code.some((c) =>
      e.offset < c.offset + c.length && c.offset < e.offset + e.length);
    if (overlapCode) continue;
    if (valid.some((v) => v.type === e.type && v.offset <= e.offset && v.offset + v.length >= e.offset + e.length)) continue;
    valid.push(e);
  }
  return { text, entities: valid };
}

function safeEnd(text, pos) {
  if (pos > 0 && pos < text.length) {
    const a = text.charCodeAt(pos - 1), b = text.charCodeAt(pos);
    if (a >= 0xd800 && a <= 0xdbff && b >= 0xdc00 && b <= 0xdfff) return pos - 1;
  }
  return pos;
}

export function splitTelegramMessage(formatted) {
  let text = formatted.text || "";
  let entities = formatted.entities || [];
  const max = MAX_PART * MAX_PARTS;
  if (text.length > max) {
    const notice = "\n\n… Ответ сокращён. Попроси продолжить или уточни нужную часть.";
    const cut = safeEnd(text, max - notice.length);
    text = text.slice(0, cut) + notice;
    entities = entities.filter((e) => e.offset < cut).map((e) => ({ ...e, length: Math.min(e.length, cut - e.offset) }));
  }
  const parts = [];
  let start = 0;
  while (start < text.length && parts.length < MAX_PARTS) {
    let end = safeEnd(text, Math.min(start + MAX_PART, text.length));
    if (end < text.length) {
      const nl = text.lastIndexOf("\n", end - 1);
      // Do not consume extra messages for a tiny last chunk near the cap.
      if (nl >= start + Math.floor(MAX_PART * 0.75) && text.length - (nl + 1) <= (MAX_PARTS - parts.length - 1) * MAX_PART) end = nl + 1;
    }
    const segment = text.slice(start, end);
    const localEntities = entities.flatMap((entity) => {
      const left = Math.max(start, entity.offset);
      const right = Math.min(end, entity.offset + entity.length);
      return right > left ? [{ ...entity, offset: left - start, length: right - left }] : [];
    });
    if (segment.trim()) parts.push({ text: segment, entities: localEntities });
    start = end;
  }
  return parts;
}

export function formatReply(markdown) {
  return splitTelegramMessage(markdownToTelegram(markdown));
}
