import { embed } from "./openai";
import { chatBackend } from "./chat";
import { CORPUS_MODE, buildCorpus } from "./corpus";
import { systemWithCorpus } from "./corpusFormat";
import { supabaseAdmin } from "./supabase";
import { PERSONA } from "./persona";

/**
 * Primes the active provider's prompt cache for the answering model: one tiny
 * completion carrying the EXACT PERSONA prefix. After this the caller's first
 * turn reuses the cached PERSONA instead of paying full prefix-processing
 * latency. The 16-token cap is plenty — we only care that the prefix gets
 * cached, not the output.
 */
async function primeChatCache(): Promise<void> {
  const backend = chatBackend();

  // Must be the EXACT system content the chat route will send, or the prefix
  // differs and this primes nothing. In full mode that means the corpus too —
  // which is the whole point: the caller's first turn then hits ~14k cached
  // tokens instead of prefilling them cold.
  let system = PERSONA;
  if (CORPUS_MODE === "full") {
    const corpus = await buildCorpus(null).catch(() => null);
    if (corpus) {
      system = systemWithCorpus(PERSONA, corpus.text);
      console.log(`[warmup] priming corpus prefix: ${corpus.docCount} docs, ~${corpus.tokens} tokens`);
    }
  }

  const res = await backend.fetch("/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: backend.model,
      ...backend.tuning,
      [backend.capField]: 16,
      messages: [
        { role: "system", content: system },
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
    primeChatCache(), // answering-model chat pool + prompt cache
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
