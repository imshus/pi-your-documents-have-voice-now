import { embed } from "./openai";
import { supabaseAdmin, MatchedChunk } from "./supabase";

/**
 * Deepgram Flux's numerals feature does not cover Hindi (confirmed current as
 * of July 2026), so an account number spoken in Hindi arrives as words:
 * "paanch chaar teen do". This maps runs of Hindi/English number words to a
 * digit string that the lexical search arm can match against documents.
 */
const NUMBER_WORDS: Record<string, string> = {
  // English
  zero: "0", one: "1", two: "2", three: "3", four: "4",
  five: "5", six: "6", seven: "7", eight: "8", nine: "9",
  // Romanized Hindi (common transliteration variants)
  shunya: "0", sifar: "0",
  ek: "1", do: "2", teen: "3", tin: "3",
  chaar: "4", char: "4", "chār": "4",
  paanch: "5", panch: "5", pach: "5",
  chhe: "6", che: "6", cheh: "6", chah: "6",
  saat: "7", sat: "7",
  aath: "8", ath: "8",
  nau: "9", no: "9",
  das: "10",
  // Devanagari
  "शून्य": "0", "एक": "1", "दो": "2", "तीन": "3", "चार": "4",
  "पांच": "5", "पाँच": "5", "छह": "6", "छे": "6", "सात": "7",
  "आठ": "8", "नौ": "9", "दस": "10",
};

/**
 * Finds runs of >=4 consecutive number words and returns their digit strings.
 * The length floor keeps amounts ("do lakh") and counts ("teen documents")
 * from being mangled — only identifier-length runs qualify.
 */
export function digitRunsFromWords(text: string): string[] {
  const tokens = text.toLowerCase().split(/[\s,.-]+/);
  const runs: string[] = [];
  let current: string[] = [];

  const flush = () => {
    if (current.length >= 4) runs.push(current.join(""));
    current = [];
  };

  for (const token of tokens) {
    const digit = NUMBER_WORDS[token] ?? (/^\d+$/.test(token) ? token : null);
    if (digit !== null) current.push(digit);
    else flush();
  }
  flush();
  return runs;
}

/**
 * Hinglish -> English banking lexicon. Callers ask in Devanagari or romanized
 * Hindi, but the documents are mostly Latin-script English — the lexical
 * search arm cannot match खाता against "account" on its own, so matched terms
 * get their English equivalents appended to the retrieval query.
 */
const HINGLISH_LEXICON: Record<string, string> = {
  // account & identity
  "खाता": "account", "खाते": "account", "khata": "account", "khaata": "account",
  "खाताधारक": "account holder",
  "नंबर": "number", "नम्बर": "number",
  "नाम": "name", "naam": "name",
  "पता": "address", "pata": "address",
  "जन्मतिथि": "date of birth", "janmtithi": "date of birth",
  "हस्ताक्षर": "signature",
  "ग्राहक": "customer", "grahak": "customer",
  "आधार": "Aadhaar", "पैन": "PAN",
  "पासबुक": "passbook",
  // money
  "शेष": "balance", "बैलेंस": "balance", "shesh": "balance",
  "baki": "balance due", "baaki": "balance due", "बाकी": "balance due",
  "राशि": "amount", "rakam": "amount", "रकम": "amount",
  "ब्याज": "interest", "byaj": "interest", "byaaj": "interest",
  "जमा": "deposit credit", "jama": "deposit credit",
  "निकासी": "withdrawal debit", "nikasi": "withdrawal", "nikaasi": "withdrawal",
  "भुगतान": "payment", "bhugtan": "payment",
  "बकाया": "outstanding due", "bakaya": "outstanding due",
  "किस्त": "installment EMI", "kist": "installment EMI",
  "कर्ज": "loan", "karz": "loan", "लोन": "loan",
  // jewelry / packing lists
  "वज़न": "weight wt gross net", "वजन": "weight wt gross net",
  "vajan": "weight wt gross net", "vazan": "weight wt gross net", "wazan": "weight wt gross net",
  "weight": "wt gross net pure",
  "सोना": "gold metal", "sona": "gold metal",
  "चांदी": "silver metal", "chandi": "silver metal",
  "हीरा": "diamond", "हीरे": "diamond", "heera": "diamond", "heere": "diamond",
  "पत्थर": "stone", "patthar": "stone",
  "मोती": "pearl", "moti": "pearl",
  "शुद्ध": "pure", "shuddh": "pure",
  "कुल": "total", "kul": "total",
  "कीमत": "price amount", "keemat": "price amount", "kimat": "price amount",
  "मजदूरी": "labour", "majdoori": "labour",
  "नग": "pieces pcs", "nag": "pieces pcs", "पीस": "pieces pcs",
  "डिज़ाइन": "design", "डिजाइन": "design",
  // colloquial (callers' everyday words)
  "wajan": "weight wt gross net", "hira": "diamond",
  "भाव": "rate price", "bhav": "rate price", "bhaav": "rate price",
  "माल": "items goods", "maal": "items goods",
  "दाम": "price", "daam": "price",
  "पैसा": "amount money", "पैसे": "amount money", "paisa": "amount money", "paise": "amount money",
  "टोटल": "total", "गिनती": "count", "ginti": "count",
  "मेकिंग": "making labour",
  "पर्चा": "bill invoice", "parcha": "bill invoice",
  // documents & misc
  "चेक": "cheque", "स्टेटमेंट": "statement",
  "विवरण": "statement details", "vivran": "statement details", "vivaran": "statement details",
  "तारीख": "date", "tarikh": "date", "tareekh": "date",
  "बैंक": "bank", "शाखा": "branch", "shakha": "branch",
  "मोबाइल": "mobile phone",
};

/** English equivalents for any Hindi banking terms present in the query. */
export function expandHinglish(text: string): string[] {
  const tokens = text.toLowerCase().split(/[\s,।?.!-]+/);
  const out = new Set<string>();
  for (const token of tokens) {
    const hit = HINGLISH_LEXICON[token];
    if (hit) out.add(hit);
  }
  return [...out];
}

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
  const queryText = [query, ...expandHinglish(query), ...wordRuns, ...collapsed].join(" ");
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
  let hits = await runRpc(documentId);
  // Stale/deleted document scope: fall back to all documents REUSING the
  // already-computed embedding (this used to redo the whole leg).
  if (hits.length === 0 && documentId) hits = await runRpc(null);
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
