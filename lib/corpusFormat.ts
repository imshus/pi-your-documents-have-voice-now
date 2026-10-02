/**
 * Pure rendering of the corpus block — no database, no env. Split out of
 * lib/corpus.ts so the eval harness can build the IDENTICAL block without
 * pulling the Supabase client in at import time. (lib/chunk.ts is equally
 * pure, so importing it keeps that property.)
 *
 * Every byte here matters: this string becomes the cached prefix, so the same
 * documents must render to the same bytes on every turn of every call.
 */
import {
  chunkDocument,
  isRowGroupChunk,
  isWholeTableChunk,
  type Chunk,
} from "./chunk.ts";

export type CorpusDoc = {
  file_name: string;
  doc_type: string | null;
  title: string | null;
  data: unknown;
};

/**
 * The chunk set for corpus/full-mode use: the SAME chunks retrieval indexes,
 * minus the row-group chunks of any table that also has a whole-table chunk.
 *
 * chunkDocument emits both a whole-table chunk (header + every row + totals) AND
 * granular 8-row chunks — the split ones exist so hybrid retrieval can rank a
 * single row precisely. In full mode there is no retrieval: the entire corpus is
 * inlined, so keeping both would print every table TWICE in the cached prefix.
 * The whole-table chunk already carries every row and the verified totals, so
 * the split copies are dropped. (An oversized table has no whole-table chunk —
 * its row groups and standalone totals chunk are kept.)
 */
function tableChunksFor(doc: CorpusDoc): Chunk[] {
  const chunks = chunkDocument(
    doc.data as Parameters<typeof chunkDocument>[0],
    doc.file_name
  );
  const wholeTableSections = new Set(
    chunks.filter(isWholeTableChunk).map((c) => c.section)
  );
  return chunks.filter(
    (c) => !(isRowGroupChunk(c) && wholeTableSections.has(c.section))
  );
}

/** Rough token estimate. Devanagari runs denser than the 4 ch/token ASCII rule. */
export const estimateTokens = (s: string) => Math.ceil(s.length / 3.5);

/**
 * Header the system message uses to introduce the corpus. Shared so the route,
 * the warm-up and the eval cannot drift apart — a one-character difference
 * between them is a 100% cache miss.
 */
export const CORPUS_HEADER = "THE CALLER'S DOCUMENTS — this is your ONLY source:";

/**
 * All chunk-shaped pieces for a document list — the SAME pieces retrieval
 * indexes, so full mode inherits every chunk-level fix (table headers on every
 * block, the verified/repaired totals, labelled identifier forms) and focusRow
 * can locate rows in full mode exactly as it does in hybrid.
 */
export function corpusChunks(docs: CorpusDoc[]) {
  return docs.flatMap(tableChunksFor);
}

/**
 * Deterministic rendering of one document, built from its CHUNKS rather than
 * raw JSON. The raw-JSON form gave the model tables as unlabelled positional
 * arrays — with the extraction's misaligned totals row included verbatim — and
 * measured 68% accuracy on row questions. The chunk form is what the accuracy
 * work was built on: every table block carries its column header, totals are
 * repaired against the per-item sums and labelled. chunkDocument is a pure
 * function of the stored data, so the output is byte-stable across turns.
 */
function renderDocument(d: CorpusDoc, index: number): string {
  const head = `=== DOCUMENT ${index + 1}: ${d.title ?? d.file_name} (${d.doc_type ?? "document"}) ===`;
  const body = tableChunksFor(d)
    .map((c) => c.content)
    .join("\n\n");
  return `${head}\n${body}`;
}

/** The corpus block for an ALREADY-ORDERED list of documents. */
export function renderCorpus(docs: CorpusDoc[]): string {
  return docs.map(renderDocument).join("\n\n");
}

/** The full system message for full mode. One definition, three call sites. */
export function systemWithCorpus(persona: string, corpusText: string): string {
  return `${persona}\n\n${CORPUS_HEADER}\n${corpusText}`;
}
