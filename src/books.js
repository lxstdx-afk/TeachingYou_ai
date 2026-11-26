import { abortAfter, readJson } from "./net.js";
import { claimBudget } from "./search.js";

// Telegram fetches documents by URL with a 20 MB limit. Stay below that limit;
// the Worker never downloads or keeps the book itself.
export const MAX_BOOK_BYTES = 19_000_000;
const BOOKS_LIMIT = 5;
const CATALOG_TIMEOUT = 10_000;
const HEADERS = {
  Accept: "application/json",
  "User-Agent": "TeachingYouAI/1.0 (https://github.com/lxstdx-afk/TeachingYou_ai)",
};

function cleanText(value, max = 180) {
  const text = Array.isArray(value) ? value.join(", ") : value;
  if (typeof text !== "string") return "";
  // Commons extmetadata may contain HTML. Display it only as plain text.
  return text.slice(0, 5000).replace(/<[^>]*>/g, " ")
    .replace(/&(?:amp|#38);/gi, "&").replace(/&(?:quot|#34);/gi, '"')
    .replace(/&(?:apos|#39);/gi, "'").replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
function looksLikeSecret(text) {
  return /\b(?:sk-[A-Za-z0-9_-]{16,}|tvly-[A-Za-z0-9_-]{12,}|gh[opsu]_[A-Za-z0-9]{20,}|\d{6,}:[A-Za-z0-9_-]{25,}|AKIA[A-Z0-9]{16})\b/i.test(text);
}
function safeUrl(value, hostname, pathPattern, max = 700) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== hostname || url.port || url.username || url.password) return null;
    if (!pathPattern.test(url.pathname) || /%(?:2f|5c)/i.test(url.pathname)) return null;
    url.search = ""; url.hash = "";
    return url.href.length <= max ? url.href : null;
  } catch { return null; }
}
function creativeLicense(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || !["creativecommons.org", "www.creativecommons.org"].includes(url.hostname) || url.username || url.password || url.port || url.search || url.hash) return null;
    const path = url.pathname.toLowerCase().replace(/\/+$/, "");
    if (path === "/publicdomain/mark/1.0") return { label: "Public domain", url: "https://creativecommons.org/publicdomain/mark/1.0/" };
    if (path === "/publicdomain/zero/1.0") return { label: "CC0 1.0", url: "https://creativecommons.org/publicdomain/zero/1.0/" };
    const match = path.match(/^\/licenses\/(by|by-sa)\/(2\.0|2\.5|3\.0|4\.0)$/);
    if (!match) return null;
    return { label: `CC ${match[1].toUpperCase()} ${match[2]}`, url: `https://creativecommons.org/licenses/${match[1]}/${match[2]}/` };
  } catch { return null; }
}
function isOpenLicense(license) {
  return !!license && (license.label === "Public domain" && !license.url ||
    creativeLicense(license.url)?.label === license.label);
}
function isRestricted(value) {
  return value === true || value === 1 || /^(?:1|true|yes)$/i.test(String(value ?? ""));
}
function hasGeoRestriction(value) {
  if (Array.isArray(value)) return value.some(hasGeoRestriction);
  const text = String(value ?? "").trim();
  // Internet Archive may use a country code such as "US", not just true.
  return !!text && !/^(?:0|false|no)$/i.test(text);
}
function numericSize(value) {
  const size = Number(value);
  return Number.isSafeInteger(size) && size > 0 && size <= MAX_BOOK_BYTES ? size : 0;
}
function positiveCount(value) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count > 0 && count <= 100_000 ? count : 0;
}
function languageLabel(value) {
  const raw = cleanText(value, 60);
  const names = { ru: "русский", rus: "русский", russian: "русский", en: "английский", eng: "английский", english: "английский" };
  return names[raw.toLowerCase()] || raw;
}

// Validate again immediately before passing a URL to Telegram. Neither a user
// message nor AI output can supply an arbitrary address or a Telegram token.
export function isSafeBook(book) {
  if (!book || typeof book !== "object" || !cleanText(book.title) || !numericSize(book.size) || !isOpenLicense(book.license)) return false;
  if (book.license.label.startsWith("CC BY") && !cleanText(book.author)) return false;
  if (book.source === "Wikimedia Commons") {
    return !!book.url && safeUrl(book.url, "upload.wikimedia.org", /^\/wikipedia\/commons\/[^/]+\/[^/]+\/[^/]+\.pdf$/i) === book.url &&
      !!book.sourceUrl && safeUrl(book.sourceUrl, "commons.wikimedia.org", /^\/wiki\/File:/i, 450) === book.sourceUrl;
  }
  if (book.source === "Internet Archive") {
    const pdf = safeUrl(book.url, "archive.org", /^\/download\/[A-Za-z0-9_.-]+\/[^/]+\.pdf$/i);
    const page = safeUrl(book.sourceUrl, "archive.org", /^\/details\/[A-Za-z0-9_.-]+$/, 450);
    return !!pdf && pdf === book.url && !!page && page === book.sourceUrl &&
      new URL(pdf).pathname.split("/")[2] === new URL(page).pathname.split("/")[2];
  }
  return false;
}

async function getJson(fetchImpl, url, signal) {
  const response = await fetchImpl(url, { method: "GET", headers: HEADERS, redirect: "manual", signal });
  if (!response.ok) { try { await response.body?.cancel(); } catch {} throw new Error("catalog unavailable"); }
  return readJson(response, 512 * 1024);
}

async function commonsSearch(fetchImpl, query, signal) {
  const url = new URL("https://commons.wikimedia.org/w/api.php");
  for (const [key, value] of Object.entries({
    action: "query", format: "json", formatversion: "2", generator: "search",
    gsrnamespace: "6", gsrlimit: "30", gsrsearch: `${query} filemime:pdf`, prop: "imageinfo",
    iiprop: "url|size|mime|extmetadata", iiextmetadatafilter: "LicenseShortName|LicenseUrl|Artist|AttributionRequired|Restrictions",
  })) url.searchParams.set(key, value);
  const data = await getJson(fetchImpl, url.href, signal);
  if (data?.error || !data || typeof data !== "object") throw new Error("catalog unavailable");
  const pages = Array.isArray(data.query?.pages) ? data.query.pages : [];
  const books = [];
  for (const page of [...pages].sort((a, b) => (a.index || 0) - (b.index || 0))) {
    const info = page?.imageinfo?.[0], meta = info?.extmetadata || {};
    if (info?.mime !== "application/pdf" || !numericSize(info.size)) continue;
    // A one-page diagram or cover is not a book. Some records lack a count;
    // keep those but show that the page count is unknown.
    if (Number.isFinite(info.pagecount) && info.pagecount < 10) continue;
    if (cleanText(meta.Restrictions?.value)) continue;
    const author = cleanText(meta.Artist?.value, 120);
    const shortLicense = cleanText(meta.LicenseShortName?.value, 80);
    let license;
    if (/^public domain$/i.test(shortLicense)) license = { label: "Public domain", url: "" };
    else if (/^CC0(?: 1\.0)?$/i.test(shortLicense)) license = { label: "CC0 1.0", url: "https://creativecommons.org/publicdomain/zero/1.0/" };
    else {
      license = creativeLicense(meta.LicenseUrl?.value);
      if (!license || license.label.toLowerCase() !== shortLicense.toLowerCase()) continue;
    }
    const book = {
      title: cleanText(String(page.title || "").replace(/^File:/, "")), author,
      source: "Wikimedia Commons",
      url: safeUrl(info.url, "upload.wikimedia.org", /^\/wikipedia\/commons\/[^/]+\/[^/]+\/[^/]+\.pdf$/i),
      sourceUrl: safeUrl(info.descriptionurl, "commons.wikimedia.org", /^\/wiki\/File:/i, 450),
      size: numericSize(info.size), pages: Number.isSafeInteger(info.pagecount) && info.pagecount > 0 ? info.pagecount : 0,
      year: "", license,
    };
    if (isSafeBook(book)) books.push(book);
    if (books.length >= BOOKS_LIMIT) break;
  }
  return books;
}

function archiveId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value) && value !== "." && value !== ".." ? value : null;
}
function archiveBook(id, data) {
  const meta = data?.metadata;
  if (!meta || meta.mediatype !== "texts" || isRestricted(data.is_dark) || isRestricted(data.nodownload) ||
      isRestricted(meta["access-restricted-item"]) || isRestricted(meta["access-restricted"]) ||
      isRestricted(meta.private) || isRestricted(meta.hidden) || isRestricted(meta["noindex"]) ||
      hasGeoRestriction(meta.geo_restricted) || meta.lending_identifier || meta.lendinginfo) return null;
  const license = creativeLicense(Array.isArray(meta.licenseurl) ? meta.licenseurl[0] : meta.licenseurl);
  if (!license || !Array.isArray(data.files)) return null;
  const author = cleanText(meta.creator, 120);
  if (license.label.startsWith("CC BY") && !author) return null;
  const file = data.files.find((f) => {
    const name = f?.name;
    return typeof name === "string" && name.length <= 220 && !/[\\/\u0000-\u001f\u007f]/.test(name) && /\.pdf$/i.test(name) &&
      /pdf/i.test(String(f.format || "")) && !isRestricted(f.private) && !isRestricted(f["access-restricted"]) &&
      !hasGeoRestriction(f.geo_restricted) && !isRestricted(f.hidden) && numericSize(f.size) &&
      !/(?:^|[_ .-])(?:preview|sample|excerpt|encrypted|drm)(?:[_ .-]|$)/i.test(name);
  });
  if (!file) return null;
  const book = {
    title: cleanText(meta.title), author, source: "Internet Archive",
    url: `https://archive.org/download/${id}/${encodeURIComponent(file.name)}`,
    sourceUrl: `https://archive.org/details/${id}`,
    size: numericSize(file.size), pages: 0, scanCount: positiveCount(meta.imagecount),
    year: cleanText(String(meta.year || ""), 10), language: languageLabel(meta.language),
    volume: cleanText(meta.volume, 40), license,
  };
  return isSafeBook(book) ? book : null;
}

async function archiveSearch(fetchImpl, title, signal) {
  const url = new URL("https://archive.org/advancedsearch.php");
  // The title contains only Unicode letters/numbers and spaces: no query syntax
  // can remove the public-access filters or change the request host.
  url.searchParams.set("q", `title:("${title}") AND mediatype:texts AND format:pdf AND licenseurl:*`);
  for (const field of ["identifier", "title", "creator", "licenseurl"]) url.searchParams.append("fl[]", field);
  url.searchParams.set("rows", "6"); url.searchParams.set("output", "json"); url.searchParams.append("sort[]", "downloads desc");
  const data = await getJson(fetchImpl, url.href, signal);
  if (!data?.response || !Array.isArray(data.response.docs)) throw new Error("catalog unavailable");
  const ids = data.response.docs.map((item) => archiveId(item?.identifier)).filter(Boolean).slice(0, 6);
  let checked = 0, failed = false;
  const books = [];
  // At most two manifest requests at once, leaving room for status refreshes.
  for (let i = 0; i < ids.length && books.length < 3 && !signal.aborted; i += 2) {
    const batch = await Promise.all(ids.slice(i, i + 2).map(async (id) => {
      try {
        const result = archiveBook(id, await getJson(fetchImpl, `https://archive.org/metadata/${id}`, signal));
        checked++;
        return result;
      } catch { failed = true; return null; }
    }));
    books.push(...batch.filter(Boolean));
  }
  if (ids.length && !checked) throw new Error("catalog unavailable");
  return { books, partial: failed || signal.aborted };
}

function searchWords(query) {
  const all = [...new Set((query.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((w) => w.length >= 2))];
  const skip = new Set(["и", "в", "на", "по", "the", "and", "of", "in"]);
  const meaningful = all.filter((w) => !skip.has(w));
  return meaningful.length ? meaningful : all;
}
function matchesTitle(book, queryTitle) {
  const words = searchWords(queryTitle), title = book.title.toLowerCase();
  const titleWords = new Set(title.match(/[\p{L}\p{N}]+/gu) || []);
  if (!words.length) return false;
  // Common short words must match a complete word rather than a substring.
  // A partial title overlap is still only a candidate, never proof of an edition.
  const matched = words.filter((w) => w.length < 4 ? titleWords.has(w) : title.includes(w)).length;
  return matched >= Math.ceil(words.length * 0.6);
}
function relevance(book, query) {
  const title = book.title.toLowerCase(), author = book.author.toLowerCase();
  return searchWords(query).reduce((score, word) => score + (title.includes(word) ? 3 : author.includes(word) ? 1 : 0), 0);
}

export async function findBooks(env, rawQuery, fetchImpl = fetch) {
  if (env.SEARCH_ENABLED === "false") return { error: "disabled", books: [] };
  if (typeof rawQuery !== "string" || looksLikeSecret(rawQuery)) return { error: "secret", books: [] };
  const parts = rawQuery.slice(0, 200).split(/\s*\|\s*/, 2);
  const normalize = (s) => (s.match(/[\p{L}\p{N}]+/gu) || []).slice(0, 14).join(" ").slice(0, 160).trim();
  const title = normalize(parts[0] || ""), query = normalize(parts.join(" "));
  if (title.length < 2 || query.length < 2) return { error: "empty", books: [] };
  if (!(await claimBudget(env))) return { error: "limit", books: [] };
  // One overall deadline; don't keep fetching manifests after the user has
  // already waited ten seconds or one catalogue has stopped responding.
  const signal = abortAfter(CATALOG_TIMEOUT);
  const results = await Promise.allSettled([commonsSearch(fetchImpl, query, signal), archiveSearch(fetchImpl, title, signal)]);
  if (results.every((r) => r.status === "rejected")) return { error: "unavailable", books: [] };
  const partial = results.some((r) => r.status === "rejected" || r.value?.partial);
  const lists = results.map((r) => r.status === "fulfilled" ? (Array.isArray(r.value) ? r.value : r.value.books) : []), combined = [];
  for (let i = 0; i < BOOKS_LIMIT; i++) for (const list of lists) if (list[i]) combined.push(list[i]);
  const unique = [...new Map(combined.filter((b) => matchesTitle(b, title)).map((b) => [b.url, b])).values()];
  unique.sort((a, b) => relevance(b, query) - relevance(a, query));
  return { books: unique.slice(0, BOOKS_LIMIT), partial };
}

export function bookErrorMessage(error) {
  switch (error) {
    case "disabled": return "Поиск сейчас выключен владельцем бота.";
    case "empty": return "Напиши название: /book Война и мир";
    case "secret": return "Похоже, запрос содержит секрет. Убери его и повтори.";
    case "limit": return "Достигнут общий лимит поиска бота. Попробуй позже.";
    default: return "Не удалось связаться с каталогами книг. Попробуй позже.";
  }
}
