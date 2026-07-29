/**
 * Pure rendering of the corpus block — no database, no env, no imports.
 * Split out of lib/corpus.ts so the eval harness can build the IDENTICAL block
 * without pulling the Supabase client in at import time.
 *
 * Every byte here matters: this string becomes the cached prefix, so the same
 * documents must render to the same bytes on every turn of every call.
 */

export type CorpusDoc = {
  file_name: string;
  doc_type: string | null;
  title: string | null;
  data: unknown;
};

/** Rough token estimate. Devanagari runs denser than the 4 ch/token ASCII rule. */
export const estimateTokens = (s: string) => Math.ceil(s.length / 3.5);

/**
 * Header the system message uses to introduce the corpus. Shared so the route,
 * the warm-up and the eval cannot drift apart — a one-character difference
 * between them is a 100% cache miss.
 */
export const CORPUS_HEADER = "THE CALLER'S DOCUMENTS — this is your ONLY source:";

/**
 * Deterministic rendering of one document. Field order is FIXED: the extracted
 * JSON already holds full_text, every label/value pair and every table row, and
 * JSON.stringify with a fixed indent is stable for a fixed input.
 */
function renderDocument(d: CorpusDoc, index: number): string {
  const head = `=== DOCUMENT ${index + 1}: ${d.title ?? d.file_name} (${d.doc_type ?? "document"}) ===`;
  return `${head}\n${JSON.stringify(d.data, null, 2)}`;
}

/** The corpus block for an ALREADY-ORDERED list of documents. */
export function renderCorpus(docs: CorpusDoc[]): string {
  return docs.map(renderDocument).join("\n\n");
}

/** The full system message for full mode. One definition, three call sites. */
export function systemWithCorpus(persona: string, corpusText: string): string {
  return `${persona}\n\n${CORPUS_HEADER}\n${corpusText}`;
}
