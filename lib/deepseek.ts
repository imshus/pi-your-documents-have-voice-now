/**
 * Thin fetch wrapper around the DeepSeek REST API — the answering model in the
 * voice pipeline. DeepSeek's endpoint is OpenAI-compatible (same /chat/completions
 * shape, same SSE streaming), so this mirrors lib/openai.ts, but the differences
 * are deliberate and load-bearing:
 *   - No reasoning_effort / verbosity / prompt_cache_key — those are OpenAI-only
 *     and DeepSeek 400s on unknown params. We steer answer length via the persona
 *     + max_tokens, and determinism via a low temperature instead.
 *   - Prompt caching is AUTOMATIC (context caching on disk, keyed on the exact
 *     token prefix) — no cache key to pass. Usage reports it as
 *     prompt_cache_hit_tokens / prompt_cache_miss_tokens, not
 *     prompt_tokens_details.cached_tokens.
 *
 * Embeddings and document vision stay on OpenAI (lib/openai.ts) — DeepSeek
 * offers neither.
 */

import { fetch as undiciFetch, Agent } from "undici";

// DeepSeek's base is bare (no /v1); the /v1 path also works but is an alias.
const BASE = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";

/**
 * Long-lived keep-alive pool: a cold TCP+TLS handshake to api.deepseek.com from
 * India costs hundreds of ms; keeping sockets warm across the inter-turn gaps
 * removes it. (Direct undici import — Next's patched global fetch does not honor
 * dispatchers.)
 */
const deepseekAgent = new Agent({
  keepAliveTimeout: 120_000,
  keepAliveMaxTimeout: 600_000,
});

/**
 * Answering model. deepseek-v4-flash is the fast/cheap tier of the V4 line
 * (284B total / 13B active MoE, 1M context). Reasoning is a per-request MODE on
 * this same id, not a separate model — lib/chat.ts pins thinking OFF for the
 * voice loop. The old deepseek-chat / deepseek-reasoner ids were RETIRED
 * 2026-07-24 and now 404, so do not fall back to them.
 */
export const CHAT_MODEL = process.env.DEEPSEEK_CHAT_MODEL ?? "deepseek-v4-flash";

/**
 * 0 = greedy decoding: the model reads values back verbatim instead of
 * paraphrasing or re-rounding them, which is what accuracy means here.
 * DeepSeek's own docs recommend 0.0 for strictly factual work. NOTE this only
 * takes effect with thinking disabled — thinking mode ignores temperature
 * entirely (see lib/chat.ts).
 */
export const CHAT_TEMPERATURE = Number(process.env.DEEPSEEK_TEMPERATURE ?? 0);

function apiKey(): string {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) {
    throw new Error(
      "Missing DEEPSEEK_API_KEY. Copy .env.example to .env.local and fill it in."
    );
  }
  return key;
}

export async function deepseekFetch(
  path: string,
  init: { method?: string; body?: string; headers?: Record<string, string> } = {}
): Promise<Response> {
  const res = await undiciFetch(`${BASE}${path}`, {
    dispatcher: deepseekAgent,
    method: init.method,
    body: init.body,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`DeepSeek ${path} failed (${res.status}): ${body.slice(0, 800)}`);
  }
  return res as unknown as Response;
}
