/**
 * Provider switch for the answering model. CHAT_PROVIDER selects DeepSeek
 * (default) or OpenAI. The two are OpenAI-compatible on the wire but differ in
 * three load-bearing ways, all captured here so the route and the warmer stay
 * provider-agnostic:
 *   - request tuning: OpenAI takes reasoning_effort/verbosity/prompt_cache_key;
 *     DeepSeek takes temperature and rejects those unknown params.
 *   - token-cap field name: OpenAI = max_completion_tokens, DeepSeek = max_tokens.
 *   - usage cache shape: OpenAI reports prompt_tokens_details.cached_tokens;
 *     DeepSeek reports prompt_cache_hit_tokens / prompt_cache_miss_tokens.
 */

import { openaiFetch, OPENAI_CHAT_MODEL } from "./openai";
import { deepseekFetch, CHAT_MODEL as DEEPSEEK_CHAT_MODEL, CHAT_TEMPERATURE } from "./deepseek";
import { PROMPT_CACHE_KEY } from "./persona";

export type ChatProvider = "deepseek" | "openai";

export const CHAT_PROVIDER: ChatProvider =
  process.env.CHAT_PROVIDER === "openai" ? "openai" : "deepseek";

/** Superset of the usage fields either provider emits in its final frame. */
export type ChatUsage = {
  prompt_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
};

export interface ChatBackend {
  /** Provider-specific fetch (own keep-alive pool + auth). Same signature. */
  fetch: typeof deepseekFetch;
  model: string;
  /** Extra completion-body fields this provider needs (and the other rejects). */
  tuning: Record<string, unknown>;
  /** The provider's name for the output-token cap field. */
  capField: "max_tokens" | "max_completion_tokens";
  /** cached vs total input tokens, normalized across the two usage shapes. */
  usage(u: ChatUsage): { cached: number; prompt: number };
}

export function chatBackend(): ChatBackend {
  if (CHAT_PROVIDER === "openai") {
    return {
      fetch: openaiFetch,
      model: OPENAI_CHAT_MODEL,
      // Pinned: 5.6 models default to "medium" reasoning when omitted (+~1.3s TTFT).
      tuning: {
        reasoning_effort: "none",
        verbosity: "low",
        prompt_cache_key: PROMPT_CACHE_KEY,
      },
      capField: "max_completion_tokens",
      usage: (u) => ({
        cached: u.prompt_tokens_details?.cached_tokens ?? 0,
        prompt: u.prompt_tokens ?? 0,
      }),
    };
  }
  return {
    fetch: deepseekFetch,
    model: DEEPSEEK_CHAT_MODEL,
    // thinking:disabled is MANDATORY here, not optional. deepseek-v4-flash
    // defaults thinking ON, which (1) streams a chain-of-thought before the
    // answer — first-token latency in the tens of seconds, unusable for a phone
    // line — and (2) makes the API silently IGNORE temperature/top_p, so the
    // low temperature below only takes effect once thinking is off. Prefix
    // caching stays automatic (no key).
    tuning: { thinking: { type: "disabled" }, temperature: CHAT_TEMPERATURE },
    capField: "max_tokens",
    usage: (u) => {
      const cached = u.prompt_cache_hit_tokens ?? 0;
      return {
        cached,
        prompt: u.prompt_tokens ?? cached + (u.prompt_cache_miss_tokens ?? 0),
      };
    },
  };
}
