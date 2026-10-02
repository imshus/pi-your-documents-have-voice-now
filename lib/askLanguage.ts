/**
 * Which language the caller asked in — decided in CODE, not by the model.
 *
 * The persona used to describe the rule in prose ("match the caller's language,
 * never write romanized Hindi") and the model kept getting it wrong in both
 * directions: appending "hai" to an English answer, or replying "Bill number
 * RJ0352 है।" to a fully-English question. Language choice is a cheap
 * deterministic classification, so we make it here and TELL the model the
 * answer instead of asking it to infer one.
 *
 * The same decision drives two things, which is exactly why it lives in one
 * place: the reply's script (app/api/chat) and the TTS number language
 * (app/call/page.tsx -> /api/tts -> Sarvam target_language_code). If those two
 * ever disagreed, the voice would speak Hindi digits over an English sentence.
 */

export type AskLanguage = "hi" | "en";

/**
 * Romanized-Hindi markers. Deepgram Flux transcribes a Hindi caller in Latin
 * script about as often as Devanagari, so script alone under-detects: "kitna
 * hua?" is a Hindi question written in ASCII and must get a Hinglish reply.
 * Only function words and unambiguous domain nouns are listed — a word that is
 * also plausible English ("no", "to", "is") would misclassify English asks.
 */
const HINDI_MARKERS =
  /\b(kya|kitna|kitne|kitni|kaun|kahan|kaha|kab|kyun|kyu|hai|hain|hua|hui|mera|meri|mere|aapka|aapki|aur|batao|bataiye|bata|nahi|nahin|haan|thik|theek|acha|accha|ka|ki|ke|ko|se|mein|par|wajan|vajan|bhav|bhaav|maal|daam|paise|paisa|nag|kul|khata|khaata|shesh|baki|baaki|rakam|jama|tarikh|tareekh)\b/i;

/**
 * Devanagari anywhere means Hindi. Otherwise fall back to the marker set, so a
 * romanized Hindi question still counts as Hindi. Everything else is English.
 */
export function askLanguage(utterance: string): AskLanguage {
  if (/[ऀ-ॿ]/.test(utterance)) return "hi";
  return HINDI_MARKERS.test(utterance) ? "hi" : "en";
}

/** Sarvam target_language_code for a detected ask language. */
export function ttsLanguage(lang: AskLanguage): string {
  return lang === "hi" ? "hi-IN" : "en-IN";
}

/**
 * The per-turn instruction appended to the USER message (never the system
 * prompt — that has to stay a byte-stable prefix for DeepSeek's context cache).
 * Stated as a fact about this turn rather than a rule to apply, which is what
 * the model was failing to do reliably.
 */
export function replyDirective(lang: AskLanguage): string {
  return lang === "hi"
    ? // The "do not copy" clause is load-bearing. When the caller typed romanized
      // Hindi ("athvi item ka amount kitna hai?"), the model mirrored their
      // spelling back — "Athvi item ka amount 34,142 rupees hai." — and once one
      // Latin Hindi word is on the page it finishes the whole sentence that way.
      // Mirroring the caller's wording is otherwise desirable, so it has to be
      // overridden explicitly for script.
      "REPLY LANGUAGE FOR THIS TURN: Hinglish. Write every Hindi word in Devanagari (है, नहीं, कितना, आठवीं). English loanwords stay in Latin (total, amount, weight). Do NOT copy the caller's spelling of Hindi words — they may have typed Hindi in Latin letters (athvi, kitna, hai); convert those to Devanagari (आठवीं, कितना, है). Not one Hindi word in Latin letters."
    : "REPLY LANGUAGE FOR THIS TURN: English only. Plain English sentence. No Devanagari, and no Hindi words in Latin letters either — do not end with 'hai'.";
}
