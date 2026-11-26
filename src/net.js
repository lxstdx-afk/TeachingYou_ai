// No exception from this module should be written to logs: Telegram URLs can
// contain the bot token and other requests can contain user data or API keys.
export async function readBytes(response, maxBytes) {
  const len = response.headers.get("content-length");
  if (len && /^\d+$/.test(len) && Number(len) > maxBytes) throw new Error("too large");
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* Ignore close races. */ }
      throw new Error("too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export async function readJson(response, maxBytes = 512 * 1024) {
  const bytes = await readBytes(response, maxBytes);
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function validKey(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= 4096 && !/[\r\n]/.test(value) && !/^https?:\/\//i.test(value);
}

export async function timeLimit(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

export function abortAfter(ms) { return AbortSignal.timeout(ms); }
