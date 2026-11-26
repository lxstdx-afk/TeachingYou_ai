import { abortAfter, readBytes, readJson, validKey } from "./net.js";

// Limits count search attempts across both users. They are not a billing cap on
// a provider account and do not cover other applications using the same key.
export const SEARCH_DAILY_LIMIT = 20;
export const SEARCH_MONTHLY_LIMIT = 300;
const DEFAULT_PROVIDERS = ["tavily-keyless", "exa-keyless"];
const KNOWN_PROVIDERS = new Set([...DEFAULT_PROVIDERS, "tavily", "exa"]);

export class SearchBudget {
  constructor(state) { this.state = state; }
  async fetch(request) {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const now = new Date().toISOString();
    const day = now.slice(0, 10), month = now.slice(0, 7);
    const old = this.state.storage.kv.get("usage") || {};
    const daily = old.day === day ? old.daily || 0 : 0;
    const monthly = old.month === month ? old.monthly || 0 : 0;
    if (daily >= SEARCH_DAILY_LIMIT || monthly >= SEARCH_MONTHLY_LIMIT) return new Response("limit", { status: 429 });
    this.state.storage.kv.put("usage", { day, month, daily: daily + 1, monthly: monthly + 1 });
    return new Response("ok", { status: 201 });
  }
}

function configuredProviders(env) {
  if (env.SEARCH_ENABLED === "false") return [];
  const raw = typeof env.SEARCH_PROVIDERS === "string" ? env.SEARCH_PROVIDERS.trim() : "";
  const values = raw ? raw.split(",").map((v) => v.trim().toLowerCase()) : DEFAULT_PROVIDERS;
  // Fail closed if configuration contains an unknown provider or duplicates.
  if (!values.length || values.some((v) => !KNOWN_PROVIDERS.has(v)) || new Set(values).size !== values.length) return [];
  // Account-based search may spend credits or money. Besides naming a keyed
  // provider, require a separate explicit opt-in; saved secrets alone never
  // activate it. This project recommends keyless mode for the free setup.
  const accountKeysEnabled = env.SEARCH_ACCOUNT_KEYS_ENABLED === "true";
  return values.filter((provider) => provider === "tavily" ? accountKeysEnabled && validKey(env.TAVILY_API_KEY) : provider === "exa" ? accountKeysEnabled && validKey(env.EXA_API_KEY) : true);
}

export function searchEnabled(env) { return configuredProviders(env).length > 0; }

function looksLikeSecret(query) {
  // A small precaution, not a comprehensive secret detector.
  return /\b(?:sk-[A-Za-z0-9_-]{16,}|tvly-[A-Za-z0-9_-]{12,}|gh[opsu]_[A-Za-z0-9]{20,}|\d{6,}:[A-Za-z0-9_-]{25,}|AKIA[A-Z0-9]{16})\b/i.test(query);
}

function safeResultUrl(value) {
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.href.length > 1000) return null;
    return url.href;
  } catch { return null; }
}

function cleanText(value, limit) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, limit) : "";
}

function normalizeResults(data, provider) {
  if (!Array.isArray(data?.results)) return [];
  const seen = new Set();
  return data.results.flatMap((item) => {
    const url = safeResultUrl(item?.url);
    if (!url || seen.has(url)) return [];
    seen.add(url);
    const highlights = Array.isArray(item?.highlights) ? item.highlights.filter((s) => typeof s === "string").join(" ") : "";
    const snippet = provider === "tavily" ? (item.content ?? item.text) : (highlights || item.text || item.content);
    return [{ title: cleanText(item.title, 180) || new URL(url).hostname, url, snippet: cleanText(snippet, 900) }];
  }).slice(0, 5);
}

// Shared by ordinary web search and public-book discovery.
export async function claimBudget(env) {
  try {
    if (!env.SEARCH_BUDGET) return false;
    const id = env.SEARCH_BUDGET.idFromName("shared-search-budget");
    const response = await env.SEARCH_BUDGET.get(id).fetch("https://budget.internal/claim", { method: "POST" });
    return response.status === 201;
  } catch { return false; }
}

async function queryTavily(fetchImpl, key, query) {
  const headers = { "Content-Type": "application/json" };
  // Crucially, never combine keyless mode and Authorization: Tavily would then
  // charge the key's account. Default search does not read the saved key.
  if (key) headers.Authorization = `Bearer ${key}`;
  else headers["X-Tavily-Access-Mode"] = "keyless";
  const body = { query, search_depth: "basic", auto_parameters: false, max_results: 5, include_answer: false, include_raw_content: false };
  const response = await fetchImpl("https://api.tavily.com/search", { method: "POST", redirect: "manual", headers, body: JSON.stringify(body), signal: abortAfter(12_000) });
  if (!response.ok) { try { await response.body?.cancel(); } catch {} return []; }
  return normalizeResults(await readJson(response), "tavily");
}

async function queryExaKeyed(fetchImpl, key, query) {
  const body = { query, type: "lite", numResults: 5, contents: { highlights: true } };
  const response = await fetchImpl("https://api.exa.ai/search", {
    method: "POST", redirect: "manual", headers: { "Content-Type": "application/json", "x-api-key": key },
    body: JSON.stringify(body), signal: abortAfter(12_000),
  });
  if (!response.ok) { try { await response.body?.cancel(); } catch {} return []; }
  return normalizeResults(await readJson(response), "exa");
}

function parseMcpResult(raw) {
  // Hosted Exa MCP may return JSON or a single SSE event. Reject throttling,
  // arbitrary text and errors; only a real results array is accepted.
  const frames = raw.split(/\r?\n\r?\n/);
  const candidates = [];
  for (const frame of frames) {
    const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n");
    if (data) candidates.push(data);
  }
  if (!candidates.length) candidates.push(raw);
  for (const text of candidates) {
    let outer;
    try { outer = JSON.parse(text); } catch { continue; }
    const result = outer?.result;
    if (outer?.error || result?.isError || result?._meta?.["ai.exa/rateLimited"]) continue;
    const values = [result?.structuredContent];
    for (const entry of Array.isArray(result?.content) ? result.content : []) {
      if (entry?.type === "text" && typeof entry.text === "string") {
        try { values.push(JSON.parse(entry.text)); } catch { /* Not structured search results. */ }
      }
    }
    for (const value of values) {
      const normalized = normalizeResults(value, "exa");
      if (normalized.length) return normalized;
    }
  }
  return [];
}

async function queryExaKeyless(fetchImpl, query) {
  // The public MCP endpoint currently supports a stateless tools/call. It is
  // unauthenticated, rate-limited, and never receives EXA_API_KEY or a payment.
  const body = {
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "web_search_advanced_exa", arguments: { query, numResults: 5, type: "lite", enableHighlights: true, highlightsMaxCharacters: 900 } },
  };
  const response = await fetchImpl("https://mcp.exa.ai/mcp?tools=web_search_advanced_exa", {
    method: "POST", redirect: "manual", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify(body), signal: abortAfter(12_000),
  });
  if (!response.ok) { try { await response.body?.cancel(); } catch {} return []; }
  return parseMcpResult(new TextDecoder().decode(await readBytes(response, 512 * 1024)));
}

export async function webSearch(env, rawQuery, fetchImpl = fetch) {
  const providers = configuredProviders(env);
  if (!providers.length) return { error: "disabled", results: [] };
  const query = typeof rawQuery === "string" ? rawQuery.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 400) : "";
  if (!query) return { error: "empty", results: [] };
  if (looksLikeSecret(query)) return { error: "secret", results: [] };
  for (const provider of providers) {
    if (!(await claimBudget(env))) return { error: "limit", results: [] };
    try {
      let results;
      if (provider === "tavily-keyless") results = await queryTavily(fetchImpl, null, query);
      else if (provider === "exa-keyless") results = await queryExaKeyless(fetchImpl, query);
      else if (provider === "tavily") results = await queryTavily(fetchImpl, env.TAVILY_API_KEY, query);
      else results = await queryExaKeyed(fetchImpl, env.EXA_API_KEY, query);
      if (results.length) return { results, provider };
    } catch { /* Try the next explicitly configured search service. */ }
  }
  return { error: "unavailable", results: [] };
}

export function searchErrorMessage(error) {
  switch (error) {
    case "disabled": return "Поиск выключен или неверно настроен владельцем бота.";
    case "empty": return "Напиши, что именно найти: /search твой запрос";
    case "secret": return "В запросе похожие на секрет данные. Не буду отправлять их в поиск; убери ключи и повтори.";
    case "limit": return "Достигнут лимит поисковых запросов бота. Попробуй позже.";
    default: return "Не получилось найти информацию: бесплатные поисковые сервисы сейчас недоступны или их лимит исчерпан. Попробуй позже.";
  }
}

export function formatSearchContext(results) {
  return results.map((item, i) => `[${i + 1}] ${item.title}\n${item.url}\n${item.snippet}`).join("\n\n");
}

export function formatSearchSources(results) {
  const escape = (s) => String(s).replace(/[\\`*_{}\[\]<>]/g, "\\$&");
  return "\n\nИсточники:\n" + results.map((r, i) => `${i + 1}. ${escape(r.title)}\n<${r.url}>`).join("\n");
}
