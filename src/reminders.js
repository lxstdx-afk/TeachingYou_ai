// Prepare a Telegram-native reminder. The bot sends a clickable date, but the
// user must create and confirm the scheduled message in their own Telegram.
// No bot scheduler, user-account session, or model call is involved.

export const MAX_REMINDER_TEXT = 400;
export const MIN_REMINDER_LEAD_MS = 60_000;
// A conservative application limit, not a claim about Telegram's limits.
export const MAX_REMINDER_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;

function pad(value) { return String(value).padStart(2, "0"); }
function offsetName(minutes) {
  if (minutes === 0) return "UTC";
  const sign = minutes >= 0 ? "+" : "-", absolute = Math.abs(minutes);
  return `UTC${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

// An explicit fixed UTC offset or an IANA time-zone name. Never guess a user's
// time zone from language, IP, the worker's zone, or the device clock.
export function normalizeTimeZone(input) {
  const text = String(input ?? "").trim();
  if (!text || text.length > 80) return null;
  if (/^(?:UTC|GMT|Z)$/i.test(text)) return "UTC";
  const match = text.match(/^(?:(?:UTC|GMT)\s*)?([+-])(\d{1,2})(?::(\d{2}))?$/i);
  if (match) {
    const hours = Number(match[2]), minutes = Number(match[3] || 0);
    if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return null;
    const total = (hours * 60 + minutes) * (match[1] === "-" ? -1 : 1);
    return offsetName(total);
  }
  if (!/^[A-Za-z0-9_+./-]+$/.test(text) || !text.includes("/")) return null;
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: text }).resolvedOptions().timeZone;
  } catch { return null; }
}

function fixedOffset(zone) {
  if (zone === "UTC") return 0;
  const match = String(zone).match(/^UTC([+-])(\d{2}):(\d{2})$/);
  if (!match) return null;
  return (Number(match[2]) * 60 + Number(match[3])) * (match[1] === "-" ? -1 : 1);
}

function utcParts(ms) {
  const date = new Date(ms);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(),
    hour: date.getUTCHours(), minute: date.getUTCMinutes() };
}

function zoneFormatter(zone) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
}
export function localParts(ms, zone, formatter = undefined) {
  const fixed = fixedOffset(zone);
  if (fixed !== null) return utcParts(ms + fixed * 60_000);
  const fields = Object.fromEntries((formatter || zoneFormatter(zone)).formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
  return { year: Number(fields.year), month: Number(fields.month), day: Number(fields.day),
    hour: Number(fields.hour), minute: Number(fields.minute) };
}
function wallStamp(parts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
}
function sameWall(a, b) {
  return a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute;
}

// Sample the offsets on both sides of a transition, then round-trip the wall
// time. Refuse nonexistent and repeated local times instead of guessing.
function wallToInstants(parts, zone) {
  const target = wallStamp(parts), fixed = fixedOffset(zone);
  if (fixed !== null) return [target - fixed * 60_000];
  const offsets = new Set(), formatter = zoneFormatter(zone);
  for (let hours = -48; hours <= 48; hours += 6) {
    const probe = target + hours * 3_600_000;
    offsets.add(wallStamp(localParts(probe, zone, formatter)) - probe);
  }
  const candidates = [];
  for (const offset of offsets) {
    const candidate = target - offset;
    if (sameWall(localParts(candidate, zone, formatter), parts)) candidates.push(candidate);
  }
  return [...new Set(candidates)].sort((a, b) => a - b);
}

// Accepted wall-time forms are deliberately explicit; arbitrary natural text is
// not sent to an AI model. A known zone is required for absolute times.
export function parseReminderTime(input, zone, now = Date.now()) {
  const normalizedZone = normalizeTimeZone(zone);
  if (!normalizedZone || !Number.isFinite(now)) return { error: "zone" };
  const text = String(input ?? "").trim().toLowerCase();
  const relativeDay = text.match(/^(сегодня|завтра)\s+(?:в\s+)?(\d{1,2}):(\d{2})$/u);
  const explicit = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})$/);
  if (!relativeDay && !explicit) return { error: "format" };
  let parts;
  if (relativeDay) {
    const current = localParts(now, normalizedZone);
    const day = new Date(Date.UTC(current.year, current.month - 1, current.day + (relativeDay[1] === "завтра" ? 1 : 0)));
    parts = { year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate(),
      hour: Number(relativeDay[2]), minute: Number(relativeDay[3]) };
  } else {
    parts = { year: Number(explicit[3]), month: Number(explicit[2]), day: Number(explicit[1]),
      hour: Number(explicit[4]), minute: Number(explicit[5]) };
  }
  if (parts.year < 1970 || parts.year > 2099 || parts.month < 1 || parts.month > 12 || parts.day < 1 || parts.day > 31 ||
      parts.hour > 23 || parts.minute > 59 || !sameWall(utcParts(wallStamp(parts)), parts)) return { error: "invalid" };
  const instants = wallToInstants(parts, normalizedZone);
  if (instants.length === 0) return { error: "nonexistent" };
  if (instants.length > 1) return { error: "ambiguous" };
  const at = instants[0];
  if (at < now + MIN_REMINDER_LEAD_MS) return { error: "past" };
  if (at > now + MAX_REMINDER_AHEAD_MS) return { error: "far" };
  return { at, zone: normalizedZone };
}

export function exampleDate(zone, now = Date.now()) {
  const p = localParts(now + 7 * 86_400_000, zone);
  return `${pad(p.day)}.${pad(p.month)}.${p.year} 18:00`;
}

// Telegram offsets and lengths are UTF-16 units, which is JavaScript's string
// length. The raw date remains understandable in old clients that don't render
// date_time entities. Newer Telegram clients display it in their local zone.
export function buildReminderMessage(note, at) {
  if (typeof note !== "string" || !note.trim() || note.length > MAX_REMINDER_TEXT ||
      !Number.isSafeInteger(at) || at < 0) throw new TypeError("invalid reminder");
  const unixTime = Math.floor(at / 1000);
  const iso = new Date(unixTime * 1000).toISOString();
  const label = `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
  const prefix = `🔔 ${note.trim()}\n\n⏰ `;
  const suffix = `\n\nДля проверки: ${label}. Дату выше Telegram может показать по часовому поясу устройства.\n\nЧтобы создать напоминание, нажми на дату → «Установить напоминание», проверь время и подтверди. Пока не подтвердил — оно не создано. Посмотреть или отменить его можно в «Избранном». Если дата не нажимается, создай напоминание в «Избранном» вручную, пересчитав время из UTC.`;
  return {
    text: prefix + label + suffix,
    entities: [{ type: "date_time", offset: prefix.length, length: label.length,
      unix_time: unixTime, date_time_format: "wDt" }],
  };
}
