/**
 * Pure query-text helpers: no network, no database, no env. Split out of
 * retrieval.ts so they can be unit-tested without pulling in Supabase and the
 * OpenAI client at import time.
 */

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
 * Hindi ORDINALS — "aathvi item ka amount" means item 8. Callers row-reference
 * this way constantly and the plain number-word table does not cover it
 * (aathvi != aath), so the lexical arm never matched the row and retrieval came
 * back with the wrong items — the model then correctly said "not in your
 * documents" for a value that was sitting right there. Both genders and the
 * common transliteration spellings are listed because callers use all of them.
 */
const ORDINAL_WORDS: Record<string, string> = {
  // romanized, masculine + feminine
  pehla: "1", pehli: "1", pahla: "1", pahli: "1", first: "1",
  dusra: "2", dusri: "2", doosra: "2", doosri: "2", second: "2",
  teesra: "3", teesri: "3", tisra: "3", tisri: "3", third: "3",
  chautha: "4", chauthi: "4", chotha: "4", fourth: "4",
  paanchva: "5", paanchvi: "5", panchva: "5", panchvi: "5", fifth: "5",
  chhata: "6", chhati: "6", chhatha: "6", chhathi: "6", sixth: "6",
  satva: "7", satvi: "7", saatva: "7", saatvi: "7", seventh: "7",
  aathva: "8", aathvi: "8", athva: "8", athvi: "8", eighth: "8",
  nauva: "9", nauvi: "9", navva: "9", navvi: "9", ninth: "9",
  dasva: "10", dasvi: "10", dashva: "10", dashvi: "10", tenth: "10",
  // Devanagari
  "पहला": "1", "पहली": "1", "दूसरा": "2", "दूसरी": "2",
  "तीसरा": "3", "तीसरी": "3", "चौथा": "4", "चौथी": "4",
  "पांचवा": "5", "पांचवीं": "5", "पाँचवा": "5", "पाँचवीं": "5",
  "छठा": "6", "छठी": "6", "सातवां": "7", "सातवीं": "7",
  "आठवां": "8", "आठवीं": "8", "नौवां": "9", "नौवीं": "9",
  "दसवां": "10", "दसवीं": "10",
};

/**
 * Digit forms for any ordinal in the query, phrased the way the chunker indexed
 * table rows ("item 8"), so "aathvi item" retrieves row 8.
 */
export function expandOrdinals(text: string): string[] {
  const tokens = text.toLowerCase().split(/[\s,।?.!-]+/);
  const out = new Set<string>();
  for (const token of tokens) {
    if (Object.hasOwn(ORDINAL_WORDS, token)) {
      const n = ORDINAL_WORDS[token];
      out.add(n);
      out.add(`item ${n}`);
    }
  }
  return [...out];
}

/**
 * Rewrites every recognised ordinal to one canonical form.
 *
 * Without this, "aathvi item ka amount" and "athvi item ka amount" are DIFFERENT
 * strings, so they embed to different vectors and retrieve different chunks —
 * the same question answered two different ways depending on how the caller (or
 * Deepgram) happened to spell it. Both now normalise to "item 8", which makes
 * retrieval deterministic across spellings.
 */
export function canonicalizeOrdinals(text: string): string {
  // \p{M} is essential: Devanagari vowel signs and anusvara are combining marks,
  // not letters, so a bare \p{L}+ splits "आठवीं" into "आठव" + "ी" + "ं" and the
  // lookup never matches.
  const replaced = text.replace(/[\p{L}\p{M}]+/gu, (word) => {
    const lower = word.toLowerCase();
    return Object.hasOwn(ORDINAL_WORDS, lower) ? `item ${ORDINAL_WORDS[lower]}` : word;
  });
  // "aathvi item" would otherwise become "item 8 item" — collapse the echo.
  return replaced.replace(/\b(item\s+\d{1,3})\s+item\b/gi, "$1");
}

/**
 * The specific table row the caller is asking about, or null. Table chunks hold
 * 8 rows each, so "the 8th item" arrives as a block containing items 1-8 and the
 * model has to pick the right line out of it — which is exactly where it was
 * silently returning a neighbouring row's amount. Detecting the row in code lets
 * the prompt state it as a fact instead of leaving it to be inferred.
 */
export function targetRow(text: string): string | null {
  const lower = text.toLowerCase();
  for (const word of lower.split(/[\s,।?.!-]+/)) {
    if (Object.hasOwn(ORDINAL_WORDS, word)) return ORDINAL_WORDS[word];
  }
  // "item 8", "item no 8", "row 8"
  const explicit = lower.match(/\b(?:item|row|line|sr\.?|serial)\s*(?:no\.?|number|#)?\s*(\d{1,3})\b/);
  return explicit ? explicit[1] : null;
}

/**
 * Row carried over from the PREVIOUS turn — "item 5 ka amount?" … "uska weight?"
 * The follow-up names no row, so targetRow() finds nothing, focusRow never
 * fires, and the model is back to counting pipe columns for exactly the
 * question shape callers use most. The anaphora words are unambiguous
 * ("uska"/"iska"/"same"), so carrying the row is deterministic, not a guess.
 */
const ANAPHORA = /\b(uska|uska|iska|usi|isi|same)\b|उसका|उसकी|इसका|इसकी|उसी|इसी/i;

export function carriedRow(
  message: string,
  prevUtterance: string | null | undefined
): string | null {
  if (!prevUtterance) return null;
  // The current message must reference no row of its own AND point backwards.
  if (targetRow(message) !== null) return null;
  if (!ANAPHORA.test(message)) return null;
  return targetRow(prevUtterance);
}

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
    // hasOwn, not a bare lookup: "constructor"/"toString" would otherwise
    // resolve through Object.prototype and push a function into the run.
    const digit = Object.hasOwn(NUMBER_WORDS, token)
      ? NUMBER_WORDS[token]
      : /^\d+$/.test(token)
        ? token
        : null;
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
    const hit = Object.hasOwn(HINGLISH_LEXICON, token)
      ? HINGLISH_LEXICON[token]
      : undefined;
    if (hit) out.add(hit);
  }
  return [...out];
}
