import { formatReply } from "./format.js";
import { abortAfter, readBytes, readJson } from "./net.js";

const TELEGRAM_TIMEOUT_MS = 8_000;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

async function telegramPost(fetchImpl, token, method, body) {
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST", redirect: "manual",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: abortAfter(TELEGRAM_TIMEOUT_MS),
    });
    const data = await readJson(response, 64 * 1024).catch(() => null);
    return { ok: response.ok && data?.ok === true, status: response.status, data };
  } catch { return { ok: false, uncertain: true }; }
}

export async function answerCallback(fetchImpl, token, queryId) {
  if (typeof queryId !== "string" || queryId.length > 256) return;
  await telegramPost(fetchImpl, token, "answerCallbackQuery", { callback_query_id: queryId });
}

export async function sendReply(fetchImpl, token, chatId, markdown, replyMarkup = undefined) {
  const parts = formatReply(markdown);
  if (!parts.length) return false;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const body = { chat_id: chatId, text: part.text };
    if (part.entities.length) body.entities = part.entities;
    if (replyMarkup && i === parts.length - 1) body.reply_markup = replyMarkup;
    let result = await telegramPost(fetchImpl, token, "sendMessage", body);
    // A definite Telegram 400 rejecting entities means the first attempt did not
    // send. Never retry an ambiguous network failure or other 400 responses.
    if (!result.ok && result.status === 400 && body.entities && /entit|parse/i.test(String(result.data?.description || ""))) {
      const { entities: _ignored, ...plain } = body;
      result = await telegramPost(fetchImpl, token, "sendMessage", plain);
    }
    if (!result.ok) return false;
  }
  return true;
}

export function extractPhoto(message) {
  if (Array.isArray(message?.photo) && message.photo.length) {
    const sizes = message.photo.filter((p) => typeof p?.file_id === "string" && p.file_id.length <= 512 &&
      (!Number.isFinite(p.file_size) || p.file_size <= MAX_IMAGE_BYTES));
    if (!sizes.length) return { error: "large" };
    const best = sizes.sort((a, b) => ((b.width || 0) * (b.height || 0)) - ((a.width || 0) * (a.height || 0)))[0];
    return { fileId: best.file_id };
  }
  const doc = message?.document;
  if (doc && /^image\/(?:jpeg|png|webp)$/i.test(doc.mime_type || "")) {
    if (Number.isFinite(doc.file_size) && doc.file_size > MAX_IMAGE_BYTES) return { error: "large" };
    if (typeof doc.file_id === "string" && doc.file_id.length <= 512) return { fileId: doc.file_id };
  }
  return null;
}

function mimeFromMagic(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && [0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a].every((n, i) => bytes[i] === n)) return "image/png";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  return null;
}

function toBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

export async function downloadPhoto(fetchImpl, token, fileId) {
  try {
    const file = await telegramPost(fetchImpl, token, "getFile", { file_id: fileId });
    if (!file.ok) return null;
    const data = file.data.result;
    if (Number.isFinite(data?.file_size) && data.file_size > MAX_IMAGE_BYTES) return null;
    const path = data?.file_path;
    // The token must never be sent to an arbitrary host or redirected.
    if (typeof path !== "string" || path.length > 500 || !/^[A-Za-z0-9_./-]+$/.test(path) || path.startsWith("/") || path.split("/").some((p) => !p || p === "." || p === "..")) return null;
    const response = await fetchImpl(`https://api.telegram.org/file/bot${token}/${path}`, { redirect: "manual", signal: abortAfter(TELEGRAM_TIMEOUT_MS) });
    if (!response.ok) { try { await response.body?.cancel(); } catch {} return null; }
    const bytes = await readBytes(response, MAX_IMAGE_BYTES);
    const mime = mimeFromMagic(bytes);
    if (!mime) return null;
    return `data:${mime};base64,${toBase64(bytes)}`;
  } catch { return null; }
}
