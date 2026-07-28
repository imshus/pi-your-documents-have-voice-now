import { NextRequest } from "next/server";
import { openaiFetch, CHAT_MODEL } from "@/lib/openai";
import { retrieve, RetrievalHit } from "@/lib/retrieval";
import { PERSONA, PROMPT_CACHE_KEY } from "@/lib/persona";

/**
 * Client-side priming runs retrieval on the caller's PARTIAL transcript while
 * they are still speaking. The final utterance usually just adds a couple of
 * trailing words, so prefetched results are accepted when the final message
 * introduces at most two tokens the primed query didn't have — otherwise we
 * retrieve fresh (losing only the head start, never correctness).
 */
function prefetchUsable(finalMessage: string, primedFor: string): boolean {
  const tokens = (s: string) =>
    new Set(s.toLowerCase().split(/[\s,।?.!\-]+/).filter(Boolean));
  const final = tokens(finalMessage);
  const primed = tokens(primedFor);
  let novel = 0;
  for (const t of final) if (!primed.has(t)) novel++;
  return novel <= 2;
}

export const runtime = "nodejs";
export const maxDuration = 120;

type Turn = { role: "user" | "assistant"; content: string };

/**
 * The middle of the voice pipeline: retrieve, then generate.
 * Retrieval runs on every turn (no tool round-trip); the model runs at
 * reasoning effort "none" — on 5.6-family models omitting the parameter
 * silently defaults to "medium" and costs ~1.3s of time-to-first-token.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    message?: string;
    history?: Turn[];
    document_id?: string | null;
    prefetched?: { for: string; results: RetrievalHit[] } | null;
  };

  const message = (body.message ?? "").trim();
  if (!message) {
    return Response.json({ error: "Missing `message`." }, { status: 400 });
  }

  try {
    // ---- retrieve ---------------------------------------------------------
    const history = (body.history ?? []).slice(-8);

    // Fold in the previous turn so follow-ups like "aur branch?" still
    // retrieve against the right document.
    const lastUser = [...history].reverse().find((t) => t.role === "user");
    const searchText = lastUser ? `${lastUser.content}\n${message}` : message;

    const tRetrieve = Date.now();
    let retrievalSource = "live";
    let chunks: RetrievalHit[];
    if (
      body.prefetched &&
      body.prefetched.results.length > 0 &&
      prefetchUsable(message, body.prefetched.for)
    ) {
      // Primed during the caller's speech — the whole retrieval leg is free.
      chunks = body.prefetched.results;
      retrievalSource = "prefetched";
    } else {
      // Stale-scope fallback happens inside retrieve() reusing the embedding.
      chunks = await retrieve(searchText, body.document_id ?? null, 8);
    }

    const context = chunks.length
      ? chunks
          .map((c, i) => `[${i + 1}] (${c.doc_type ?? "document"} — ${c.section})\n${c.content}`)
          .join("\n\n")
      : "(nothing relevant found in the caller's documents)";

    const retrieveMs = Date.now() - tRetrieve;

    // ---- generate ---------------------------------------------------------
    const tLlm = Date.now();
    const upstream = await openaiFetch("/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: CHAT_MODEL,
        stream: true,
        // Pinned: 5.6 models default to "medium" reasoning when omitted.
        reasoning_effort: "none",
        // Short spoken answers; parameter-level backstop for the prompt rule.
        verbosity: "low",
        // 5.6+ caching needs an explicit key for reliable prefix matching.
        prompt_cache_key: PROMPT_CACHE_KEY,
        // Final usage frame so we can log how much of the input prefix
        // (PERSONA + history) was served from cache vs billed fresh.
        stream_options: { include_usage: true },
        messages: [
          { role: "system", content: PERSONA },
          ...history,
          {
            role: "user",
            content: `${message}\n\nCONTEXT (retrieved from the caller's documents):\n${context}`,
          },
        ],
      }),
    });

    // Re-emit the SSE deltas as plain text so the client can start speaking the
    // first sentence before the answer has finished generating.
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const reader = upstream.body!.getReader();
        const decoder = new TextDecoder();
        const encoder = new TextEncoder();
        let buffer = "";
        let ttft: number | null = null;
        let usage:
          | { prompt_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }
          | null = null;

        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              if (!line.startsWith("data:")) continue;
              const payload = line.slice(5).trim();
              if (!payload || payload === "[DONE]") continue;

              try {
                const json = JSON.parse(payload);
                if (json.usage) usage = json.usage;
                const delta = json.choices?.[0]?.delta?.content;
                if (delta) {
                  if (ttft === null) {
                    ttft = Date.now() - tLlm;
                    // Per-turn latency line in the dev console: which leg is
                    // slow is a measurement, not a guess.
                    console.log(
                      `[chat] retrieve=${retrieveMs}ms llm_ttft=${ttft}ms chunks=${chunks.length}`
                    );
                  }
                  controller.enqueue(encoder.encode(delta));
                }
              } catch {
                // Partial JSON across chunk boundaries — skip it.
              }
            }
          }
        } finally {
          if (usage) {
            const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
            const prompt = usage.prompt_tokens ?? 0;
            const pct = prompt ? Math.round((cached / prompt) * 100) : 0;
            // Cached input = the stable PERSONA + history prefix reused each
            // turn; only the fresh retrieval + new user message is billed full.
            console.log(`[chat] input=${prompt}tok cached=${cached}tok (${pct}%)`);
          }
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Retrieved-Chunks": String(chunks.length),
        "X-Retrieve-Ms": String(retrieveMs),
        "X-Retrieval": retrievalSource,
      },
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
