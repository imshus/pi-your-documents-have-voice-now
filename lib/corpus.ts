/**
 * Whole-corpus context, as an alternative to per-turn retrieval.
 *
 * WHY: DeepSeek caches on an exact token PREFIX. Per-turn retrieval is the
 * enemy of that — the retrieved block changes every turn, so the cacheable
 * prefix stops at PERSONA (~1.3k tokens) and everything after it is re-billed
 * and re-prefilled every single turn.
 *
 * If the whole corpus fits comfortably in context, putting it in the SYSTEM
 * message makes the prefix [PERSONA + corpus] — byte-identical on every turn of
 * every call. Then the only cache miss is the caller's question itself (tens of
 * tokens). Cache-hit input is 50x cheaper, so this is cheaper overall despite
 * sending far more tokens, and it removes the embed + Supabase legs from the
 * voice critical path entirely.
 *
 * TRADE-OFF, and the reason this is OFF by default: retrieval narrows the model
 * to 8 chunks, while full mode hands it everything and asks it to find the right
 * row itself. With several similar documents (two jewelry packing lists, say)
 * that is MORE distractor material, not less — and this agent already has a
 * demonstrated weakness picking the right row out of a multi-row table. It is a
 * cache and latency win but an accuracy UNKNOWN, so it ships behind a flag and
 * `npm run eval -- --full` decides. Do not enable it without running both ways.
 */

import { supabaseAdmin } from "./supabase";
import { renderCorpus, corpusChunks, estimateTokens, type CorpusDoc } from "./corpusFormat";

/**
 * Refuse to inline a corpus larger than this. Deliberately well under the
 * model's context limit: the question is not "does it fit" but "can the model
 * still find one value in it". Past this size, retrieval is the better tool.
 */
const MAX_CORPUS_TOKENS = Number(process.env.CORPUS_MAX_TOKENS ?? 60_000);

export type CorpusMode = "hybrid" | "full";

/** hybrid (default) = per-turn retrieval. full = whole corpus in the prefix. */
export const CORPUS_MODE: CorpusMode =
  process.env.RETRIEVAL_MODE === "full" ? "full" : "hybrid";

import type { Chunk } from "./chunk";

type CacheEntry = {
  text: string;
  tokens: number;
  docCount: number;
  /** Chunk-shaped pieces of the same corpus, so focusRow works in full mode. */
  chunks: Chunk[];
};

/**
 * Per-scope memo. The built string MUST be byte-identical between turns or the
 * prefix cache is defeated, so it is built once and reused verbatim rather than
 * re-serialized per request.
 */
const memo = new Map<string, CacheEntry>();

/** Cleared by ingest and delete so a changed document set is picked up. */
export function invalidateCorpus(): void {
  memo.clear();
}

/**
 * The corpus block for a scope, or null when it is too large to inline (the
 * caller then falls back to retrieval). `documentId` null = all documents.
 */
export async function buildCorpus(
  documentId: string | null
): Promise<CacheEntry | null> {
  const key = documentId ?? "all";
  const hit = memo.get(key);
  if (hit) return hit;

  let q = supabaseAdmin()
    .from("documents")
    .select("id, file_name, doc_type, title, data")
    // Explicit TOTAL ordering. Without it Postgres may return rows in any order
    // and the prefix would differ between turns for the same documents.
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (documentId) q = q.eq("id", documentId);

  const { data, error } = await q;
  if (error) throw new Error(`corpus load failed: ${error.message}`);
  if (!data || data.length === 0) return null;

  const text = renderCorpus(data as CorpusDoc[]);
  const tokens = estimateTokens(text);
  if (tokens > MAX_CORPUS_TOKENS) {
    console.warn(
      `[corpus] ~${tokens} tokens exceeds CORPUS_MAX_TOKENS=${MAX_CORPUS_TOKENS} — falling back to retrieval`
    );
    return null;
  }

  const entry = {
    text,
    tokens,
    docCount: data.length,
    chunks: corpusChunks(data as CorpusDoc[]),
  };
  memo.set(key, entry);
  return entry;
}
