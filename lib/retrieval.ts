import { embed } from "./openai";
import {
  digitRunsFromWords,
  expandHinglish,
  expandOrdinals,
  canonicalizeOrdinals,
} from "./queryText";
import { supabaseAdmin, MatchedChunk } from "./supabase";

/** True when the query is identifier-shaped (long digit run, spoken or literal). */
function looksLikeIdentifierQuery(text: string, wordRuns: string[]): boolean {
  return /\d{6,}/.test(text.replace(/[\s\-]/g, "")) || wordRuns.length > 0;
}

export type RetrievalHit = {
  document_id: string;
  file_name: string;
  doc_type: string | null;
  section: string | null;
  similarity: number;
  content: string;
};

/**
 * Hybrid retrieval: one embedding call, then the RRF function in Postgres.
 * Identifier-shaped queries double the lexical weight — dense vectors are
 * near-blind to exact digit strings, so lexical has to carry those.
 */
export async function retrieve(
  query: string,
  documentId: string | null,
  topK = 8
): Promise<RetrievalHit[]> {
  const wordRuns = digitRunsFromWords(query);
  // Append spoken-word digit runs and collapsed digit groups so the lexical
  // arm sees the same form the chunker indexed.
  const collapsed = (query.match(/\d[\d\s\-]{5,}\d/g) ?? []).map((m) =>
    m.replace(/[\s\-]/g, "")
  );
  // Canonicalised FIRST so spelling variants of the same ordinal ("aathvi" vs
  // "athvi") produce an identical embedding and therefore identical retrieval.
  const queryText = [
    canonicalizeOrdinals(query),
    ...expandHinglish(query),
    ...expandOrdinals(query),
    ...wordRuns,
    ...collapsed,
  ].join(" ");
  const fullTextWeight = looksLikeIdentifierQuery(query, wordRuns) ? 2 : 1;

  const t0 = Date.now();
  const [vector] = await embed([queryText]);
  const embedMs = Date.now() - t0;

  const runRpc = async (docFilter: string | null) => {
    const { data, error } = await supabaseAdmin().rpc("match_chunks", {
      query_embedding: vector,
      query_text: queryText,
      match_count: topK,
      filter_document_id: docFilter,
      full_text_weight: fullTextWeight,
      semantic_weight: 1,
    });
    if (error) throw new Error(error.message);
    return (data ?? []) as MatchedChunk[];
  };

  const t1 = Date.now();
  const hits = await runRpc(documentId);
  // NO silent widening. This used to retry with documentId=null whenever a
  // scoped search came back empty, so a caller who picked one document got
  // answers quoted out of OTHER documents — and the reply sounded just as
  // confident. An empty result is the correct answer here: the chat route then
  // sends "(nothing relevant found)" and the persona's "not in your documents"
  // line fires.
  console.log(`[retrieve] embed=${embedMs}ms rpc=${Date.now() - t1}ms hits=${hits.length}`);

  return hits.map((c) => ({
    document_id: c.document_id,
    file_name: c.file_name,
    doc_type: c.doc_type,
    section: c.section,
    similarity: Number(c.similarity.toFixed(4)),
    content: c.content,
  }));
}
