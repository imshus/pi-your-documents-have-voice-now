import { NextRequest } from "next/server";
import { chatBackend, ChatUsage } from "@/lib/chat";
import { askLanguage, replyDirective } from "@/lib/askLanguage";
import { CORPUS_MODE, buildCorpus } from "@/lib/corpus";
import { systemWithCorpus } from "@/lib/corpusFormat";
import { targetRow, carriedRow } from "@/lib/queryText";
import { focusRow, focusTotals, wantsTotals, focusColumn, wantsColumn } from "@/lib/rowFocus";
import {
  history as conversationHistory,
  lastBareUser,
  commitTurn,
} from "@/lib/conversation";
import { retrieve, RetrievalHit } from "@/lib/retrieval";
import { PERSONA } from "@/lib/persona";

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

/** Retrieved chunks, numbered for the model. */
function formatChunks(chunks: RetrievalHit[]): string {
  return chunks.length
    ? chunks
        .map((c, i) => `[${i + 1}] (${c.doc_type ?? "document"} — ${c.section})\n${c.content}`)
        .join("\n\n")
    : "(nothing relevant found in the caller's documents)";
}

type Turn = { role: "user" | "assistant"; content: string };

/**
 * The middle of the voice pipeline: retrieve, then generate.
 * Retrieval runs on every turn (no tool round-trip); generation streams so the
 * client can start speaking the first sentence before the answer finishes. The
 * answering model is chosen by CHAT_PROVIDER (DeepSeek default | OpenAI) — see
 * lib/chat.ts; both cache the stable [system + history] prefix.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    message?: string;
    history?: Turn[];
    document_id?: string | null;
    prefetched?: { for: string; results: RetrievalHit[] } | null;
    call_id?: string | null;
  };
  const callId = typeof body.call_id === "string" ? body.call_id.slice(0, 64) : null;

  const message = (body.message ?? "").trim();
  if (!message) {
    return Response.json({ error: "Missing `message`." }, { status: 400 });
  }

  try {
    // ---- retrieve ---------------------------------------------------------
    // Prefer the SERVER's record of what was actually sent. The client stores
    // the caller's bare utterance, but the request carries that utterance PLUS
    // the context and directives — so replaying the client's copy diverged from
    // the real prefix at message index 1 and pinned the cache at PERSONA. The
    // server log is byte-exact, so the prefix genuinely extends each turn.
    const logged = conversationHistory(callId);
    const history =
      logged.length > 0
        ? logged
        : // No call id (the text chat) — fall back to the client's history, and
          // validate the roles: spreading this unchecked let a crafted request
          // inject a `system` turn and override the grounding rules.
          (body.history ?? [])
            .filter(
              (t): t is Turn =>
                !!t &&
                (t.role === "user" || t.role === "assistant") &&
                typeof t.content === "string"
            )
            .map((t) => ({ role: t.role, content: t.content.slice(0, 2000) }))
            .slice(-8);

    // Fold in the previous turn so follow-ups like "aur branch?" still
    // retrieve against the right document — the BARE utterance, never the
    // composed message. The conversation log's user turns carry the retrieved
    // chunks and directives for prefix caching, and folding THAT in embedded
    // ~3k tokens of chunk text per follow-up and dragged the trigram search
    // arm from ~130ms to ~1.4s (measured live: retrieve=2195ms).
    const prevUtterance =
      lastBareUser(callId) ??
      [...history].reverse().find((t) => t.role === "user")?.content ??
      null;
    const searchText = prevUtterance ? `${prevUtterance}\n${message}` : message;

    const tRetrieve = Date.now();
    let retrievalSource = "live";
    let chunks: RetrievalHit[] = [];
    let context: string;
    // The corpus block, when full mode is on AND the corpus is small enough.
    // It goes in the SYSTEM message so [PERSONA + corpus] is one byte-stable
    // prefix that caches on every turn of every call.
    let corpusBlock: string | null = null;

    // Chunk-shaped view of whatever the model will see, for focusRow — the
    // retrieval hits in hybrid mode, the corpus's own chunks in full mode.
    let rowSource: { section: string | null; content: string }[] = [];

    if (CORPUS_MODE === "full") {
      const corpus = await buildCorpus(body.document_id ?? null);
      if (corpus) {
        corpusBlock = corpus.text;
        rowSource = corpus.chunks;
        retrievalSource = "corpus";
        // No per-turn context: the documents are already in the prefix, and
        // repeating them here would put a copy in the volatile tail too.
        context = "";
      } else {
        // Too large to inline, or nothing indexed — fall back to retrieval.
        chunks = await retrieve(searchText, body.document_id ?? null, 8);
        context = formatChunks(chunks);
      }
    } else if (
      body.prefetched &&
      body.prefetched.results.length > 0 &&
      prefetchUsable(message, body.prefetched.for)
    ) {
      // Primed during the caller's speech — the whole retrieval leg is free.
      chunks = body.prefetched.results;
      retrievalSource = "prefetched";
      context = formatChunks(chunks);
    } else {
      chunks = await retrieve(searchText, body.document_id ?? null, 8);
      context = formatChunks(chunks);
    }

    const retrieveMs = Date.now() - tRetrieve;

    // Better than telling the model which row to find: find it here and hand
    // over the row's values already labelled, so it never has to count 20-odd
    // pipe-delimited columns (a header where "Pcs"/"Wt"/"Amt" each repeat).
    // Works in BOTH modes — hybrid reads the retrieval hits, full mode reads
    // the corpus's own chunks. Falls back to the instruction when the row is
    // not present in either.
    // "uska weight?" after "item 5 ka amount?" names no row — carry the
    // previous turn's row so the follow-up gets the same deterministic focus.
    const row = targetRow(message) ?? carriedRow(message, lastBareUser(callId));
    const source = rowSource.length > 0 ? rowSource : chunks;
    const focused = row ? focusRow(source, row) : null;
    // Totals questions get the labelled TOTALS block the same way — locating
    // it is deterministic, so never leave it to retrieval rank or column
    // counting. Row focus wins when both could apply ("item 5 ka total").
    const totals = !focused && wantsTotals(message) ? focusTotals(source) : null;
    // Column-aggregation questions ("diamond kitne type?", "diamond ka rate?")
    // ask about a whole column across every item — the class that made the
    // model hallucinate a value. Compute the de-duplicated column and hand it
    // over. Lowest priority: a specific row or a totals line beats it.
    const column =
      !focused && !totals && wantsColumn(message, source)
        ? focusColumn(source, message)
        : null;
    const rowDirective = focused
      ? `${focused}\n\n`
      : totals
        ? `${totals}\n\n`
        : column
          ? `${column}\n\n`
          : row
            ? `ROW: the caller is asking about item ${row}. Read the value from the line for item ${row} only — the context contains several item rows and the neighbouring ones are NOT the answer. If no line for item ${row} appears in the context, say it is not in the documents rather than answering from another row.\n\n`
            : "";

    // ---- generate ---------------------------------------------------------
    // Built once and reused for BOTH the request and the conversation log —
    // the log is only useful if it holds the exact bytes that were sent.
    const userContent = corpusBlock
      ? `${message}

${rowDirective}${replyDirective(askLanguage(message))}`
      : `${message}

CONTEXT (retrieved from the caller's documents):
${context}

${rowDirective}${replyDirective(askLanguage(message))}`;

    const tLlm = Date.now();
    const backend = chatBackend();
    const upstream = await backend.fetch("/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: backend.model,
        stream: true,
        // Provider-specific tuning (reasoning/verbosity/cache-key vs temperature).
        ...backend.tuning,
        // Short spoken answers; parameter-level backstop for the prompt rule.
        // 200 occasionally clipped a longer reply mid-sentence (an answer that
        // read back a value plus a unit and a follow-through) — the persona
        // still keeps replies short, so 400 only prevents truncation, it does
        // not make answers longer.
        [backend.capField]: 400,
        // Final usage frame so we can log how much of the input prefix
        // (PERSONA + history) was served from cache vs billed fresh.
        stream_options: { include_usage: true },
        messages: [
          {
            role: "system",
            // In full mode the corpus is appended HERE, making [PERSONA +
            // corpus] one byte-stable prefix that caches on every turn of every
            // call. In hybrid mode this is PERSONA alone and the per-turn
            // context rides in the volatile tail below.
            content: corpusBlock
              ? systemWithCorpus(PERSONA, corpusBlock)
              : PERSONA,
          },
          ...history,
          {
            role: "user",
            // Directives go LAST, after the context: closest to the answer is
            // where they hold best, and keeping them out of the system prompt
            // leaves [system + history] a byte-stable cacheable prefix.
            content: corpusBlock
              ? `${message}\n\n${rowDirective}${replyDirective(askLanguage(message))}`
              : `${message}\n\nCONTEXT (retrieved from the caller's documents):\n${context}\n\n${rowDirective}${replyDirective(askLanguage(message))}`,
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
        let usage: ChatUsage | null = null;
        let errored = false;
        // Accumulated so the completed turn can be committed to the log.
        let answer = "";

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

              let json: {
                usage?: ChatUsage;
                error?: { message?: string };
                choices?: { delta?: { content?: string } }[];
              };
              try {
                json = JSON.parse(payload);
              } catch {
                // Partial JSON across chunk boundaries — skip it.
                continue;
              }
              {
                // A provider error frame arrives as a normal SSE line. Dropping
                // it silently truncated the answer and the caller heard a
                // half-value spoken as fact.
                if (json.error) {
                  throw new Error(json.error.message ?? "upstream error");
                }
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
                  answer += delta;
                  controller.enqueue(encoder.encode(delta));
                }
              }
            }
          }
        } catch (err) {
          // Must ERROR the stream, not close it: closing looks identical to a
          // finished answer, so the client spoke a truncated value and wrote it
          // into history as fact.
          errored = true;
          console.error("[chat] stream aborted:", err);
          controller.error(err);
        } finally {
          if (usage) {
            const { cached, prompt } = backend.usage(usage);
            const pct = prompt ? Math.round((cached / prompt) * 100) : 0;
            // Cached input = the stable PERSONA + history prefix reused each
            // turn; only the fresh retrieval + new user message is billed full.
            console.log(
              `[chat] input=${prompt}tok cached=${cached}tok (${pct}%) turns=${history.length / 2}`
            );
          }
          // Commit ONLY a completed turn. An aborted/failed one is left out, so
          // the next turn still extends the last good prefix (and the cache
          // still hits) instead of inheriting a half-answer.
          if (!errored && answer) commitTurn(callId, userContent, answer, message);
          if (!errored) controller.close();
        }
      },
      // Client hung up or barged in — stop the upstream generation instead of
      // paying for tokens nobody will hear.
      async cancel(reason) {
        await upstream.body!.cancel(reason).catch(() => {});
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
