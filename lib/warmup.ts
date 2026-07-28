import { openaiFetch, embed, CHAT_MODEL } from "./openai";
import { supabaseAdmin } from "./supabase";
import { PERSONA, PROMPT_CACHE_KEY } from "./persona";

/**
 * Primes the OpenAI prompt cache for the answering model: one tiny completion
 * carrying the EXACT PERSONA prefix + the same prompt_cache_key the chat route
 * uses. After this, the caller's first turn hits a warm cache instead of paying
 * full prefix-processing latency. reasoning_effort "none" means no reasoning
 * tokens, so the 16-token cap is plenty; we only care that the prefix is cached.
 */
async function primeChatCache(): Promise<void> {
  const res = await openaiFetch("/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: CHAT_MODEL,
      reasoning_effort: "none",
      verbosity: "low",
      max_completion_tokens: 16,
      prompt_cache_key: PROMPT_CACHE_KEY,
      messages: [
        { role: "system", content: PERSONA },
        { role: "user", content: "warmup" },
      ],
    }),
  });
  await res.text(); // drain so the socket returns to the keep-alive pool
}

/**
 * Warms every upstream the voice pipeline touches so the first real turn skips
 * both cold TLS handshakes AND a cold prompt cache. Safe to call repeatedly;
 * each leg is independent and failures are swallowed by the caller.
 */
export async function warmUp(): Promise<{ ms: number; warmed: string[] }> {
  const t0 = Date.now();
  const legs = ["chat", "embed", "supabase", "sarvam"];
  const results = await Promise.allSettled([
    primeChatCache(), // OpenAI chat pool + prompt cache
    embed(["hi"]), // OpenAI embeddings pool
    supabaseAdmin().from("documents").select("id").limit(1),
    fetch("https://api.sarvam.ai/text-to-speech/stream", { method: "POST" }), // 4xx after TLS — free
  ]);
  return {
    ms: Date.now() - t0,
    // sarvam intentionally 4xx's (invalid body) but the TLS handshake still warms.
    warmed: legs.filter((_, i) => results[i].status === "fulfilled" || i === 3),
  };
}
