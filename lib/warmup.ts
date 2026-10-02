import { embed } from "./openai";
import { warmSarvam } from "./sarvam";
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
async function primeChatCache(documentId: string | null): Promise<void> {
  const backend = chatBackend();

  // Must be the EXACT system content the chat route will send, or the prefix
  // differs and this primes nothing. In full mode that means the corpus for the
  // SAME scope the call will use — priming the all-documents prefix while the
  // call is scoped to one document was a total cache miss, so the first turn
  // paid full cold prefill (the "slow to start"). Prime the scoped corpus.
  let system = PERSONA;
  if (CORPUS_MODE === "full") {
    const corpus = await buildCorpus(documentId).catch(() => null);
    if (corpus) {
      system = systemWithCorpus(PERSONA, corpus.text);
      console.log(`[warmup] priming corpus prefix: ${corpus.docCount} doc(s), ~${corpus.tokens} tokens`);
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
export async function warmUp(
  documentId: string | null = null
): Promise<{ ms: number; warmed: string[] }> {
  const t0 = Date.now();
  const legs = ["chat", "embed", "supabase", "sarvam"];
  const results = await Promise.allSettled([
    primeChatCache(documentId), // answering-model chat pool + prompt cache
    embed(["hi"]), // OpenAI embeddings pool
    // Thunked, so a synchronous throw from supabaseAdmin() (missing env) is
    // captured by allSettled instead of rejecting warmUp() itself.
    (async () => supabaseAdmin().from("documents").select("id").limit(1))(),
    warmSarvam(), // the TTS pool specifically — see lib/sarvam.ts
  ]);

  // Report per leg instead of guessing. A silently-failing warm-up leg just
  // moves its latency into the caller's first turn, so it should be visible.
  const warmed: string[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") warmed.push(legs[i]);
    else console.error(`[warmup] ${legs[i]} failed:`, r.reason);
  });
  return { ms: Date.now() - t0, warmed };
}
