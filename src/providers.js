import { abortAfter, readJson, timeLimit, validKey } from "./net.js";

export const CF_MODEL = "@cf/google/gemma-4-26b-a4b-it";
export const CF_TEXT_FALLBACK = "@cf/zai-org/glm-4.7-flash";
export const ZAI_TEXT_MODEL = "glm-4.7-flash";
export const ZAI_VISION_MODEL = "glm-4.6v-flash";
export const OPENROUTER_MODEL = "openrouter/free";

export const SEARCH_TOOL = {
  type: "function",
  function: {
    name: "web_search",
    description: "Search the public web only when the user asks to search or current factual information is needed. Use concise public keywords; never send passwords, keys, private conversation, names or IDs unless essential for the query.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "A concise public search query." } },
      required: ["query"],
      additionalProperties: false,
    },
  },
};

function extract(result) {
  const choice = result?.choices?.[0];
  const message = choice?.message;
  const content = typeof message?.content === "string" ? message.content : (typeof result?.response === "string" ? result.response : "");
  const rawCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : (Array.isArray(result?.tool_calls) ? result.tool_calls : []);
  const calls = [];
  for (const call of rawCalls.slice(0, 3)) {
    const f = call?.function ?? call;
    if (f?.name !== "web_search") continue;
    let args = f.arguments;
    if (typeof args === "string") { try { args = JSON.parse(args); } catch { continue; } }
    if (typeof args?.query === "string" && args.query.trim()) calls.push({ name: "web_search", query: args.query.trim() });
  }
  if (!content.trim() && !calls.length) return null;
  return { content: content.trim(), calls, truncated: choice?.finish_reason === "length" };
}

async function apiCall(fetchImpl, url, key, body, timeoutMs) {
  const response = await fetchImpl(url, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: abortAfter(timeoutMs),
  });
  if (!response.ok) { try { await response.body?.cancel(); } catch {} return null; }
  return extract(await readJson(response));
}

// Only the specifically free model IDs below are used as fallbacks. Their
// availability and external data policies depend on the user's accounts.
export async function callAI(env, messages, {
  image = false, tools = false, maxTokens = 1024, timeoutMs = 25_000,
  fetchImpl = fetch, temperature = 0.5,
} = {}) {
  const optionalTools = tools ? { tools: [SEARCH_TOOL], tool_choice: "auto" } : {};
  if (env.AI && typeof env.AI.run === "function") {
    // Both models share the Workers AI daily allowance. The text-only second
    // model helps with a model-specific outage, not an exhausted quota.
    for (const model of image ? [CF_MODEL] : [CF_MODEL, CF_TEXT_FALLBACK]) {
      try {
        const answer = extract(await timeLimit(env.AI.run(model, {
          messages,
          max_completion_tokens: maxTokens,
          temperature,
          chat_template_kwargs: { enable_thinking: false },
          store: false,
          ...optionalTools,
        }), timeoutMs));
        if (answer) return { ...answer, provider: "Cloudflare" };
      } catch { /* Try a configured free backup without exposing provider errors. */ }
    }
  }
  if (validKey(env.ZAI_API_KEY)) {
    try {
      const answer = await apiCall(fetchImpl, "https://api.z.ai/api/paas/v4/chat/completions", env.ZAI_API_KEY, {
        model: image ? ZAI_VISION_MODEL : ZAI_TEXT_MODEL,
        messages,
        max_tokens: maxTokens,
        temperature,
        thinking: { type: "disabled" },
        ...optionalTools,
      }, timeoutMs);
      if (answer) return { ...answer, provider: "Z.AI" };
    } catch { /* Continue. */ }
  }
  // OpenRouter BYOK can bill the owner's external provider even for free
  // variants. A zero OpenRouter price ceiling alone does not prevent that.
  // Only use this key after the owner verifies that its workspace has no BYOK
  // provider keys and explicitly sets this confirmation; it is not a
  // guarantee against future pricing changes.
  if (env.OPENROUTER_NO_BYOK_CONFIRMED === "true" && validKey(env.OPENROUTER_API_KEY)) {
    try {
      const answer = await apiCall(fetchImpl, "https://openrouter.ai/api/v1/chat/completions", env.OPENROUTER_API_KEY, {
        model: OPENROUTER_MODEL,
        messages,
        max_tokens: maxTokens,
        temperature,
        // Do not allow token, per-request or per-image prices above zero.
        // The free router may still be unavailable or change its terms.
        provider: { max_price: { prompt: 0, completion: 0, request: 0, image: 0 } },
        ...optionalTools,
      }, timeoutMs);
      if (answer) return { ...answer, provider: "OpenRouter (free)" };
    } catch { /* All configured providers failed. */ }
  }
  return null;
}
