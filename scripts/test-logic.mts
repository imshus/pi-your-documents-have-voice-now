/**
 * Offline regression tests for the pure logic in the voice path — the parts
 * that decide WHAT gets spoken and in WHICH language. No network, no API keys,
 * no cost. Run: npm run test:logic
 *
 * Every case here is a bug that actually shipped; a failure means it regressed.
 */
import assert from "node:assert/strict";
import { takeSentences } from "../lib/sentences.ts";
import {
  digitRunsFromWords,
  expandHinglish,
  expandOrdinals,
  canonicalizeOrdinals,
  targetRow,
} from "../lib/queryText.ts";
import { normalizeForSpeech, languageFor } from "../lib/sarvam.ts";
import { askLanguage, replyDirective } from "../lib/askLanguage.ts";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}`);
    console.log(`       ${err instanceof Error ? err.message.split("\n")[0] : err}`);
  }
}

console.log("\ntakeSentences — must never split a number across two clips");

test("holds a trailing decimal point until the fraction arrives", () => {
  // Mid-stream: "60." is a decimal whose tail hasn't streamed yet.
  const { sentences, rest } = takeSentences("वज़न 60.", { eagerFirst: true });
  assert.deepEqual(sentences, []);
  assert.equal(rest, "वज़न 60.");
});

test("emits the whole figure once the fraction arrives", () => {
  const { sentences } = takeSentences("वज़न 60.433 ग्राम।", { eagerFirst: true });
  assert.deepEqual(sentences, ["वज़न 60.433 ग्राम।"]);
});

test("still terminates a real sentence ending in a digit", () => {
  const { sentences } = takeSentences("Total is 500. ", { eagerFirst: true });
  assert.deepEqual(sentences, ["Total is 500."]);
});

test("does not split the persona's own example across clips", () => {
  const full = "इसमें 12 माल हैं, total वज़न 60.433 ग्राम।";
  let buffer = "";
  const out: string[] = [];
  // Feed it the way the SSE stream does — token by token.
  for (const tok of ["इसमें 12 माल हैं,", " total", " वज़न", " 60", ".", "433", " ग्राम", "।"]) {
    buffer += tok;
    const { sentences, rest } = takeSentences(buffer, { eagerFirst: out.length === 0 });
    buffer = rest;
    out.push(...sentences);
  }
  if (buffer.trim()) out.push(buffer.trim());
  assert.equal(out.join(" "), full, `got: ${JSON.stringify(out)}`);
  assert.ok(
    !out.some((s) => /\d\.$/.test(s)),
    `a clip ends on a bare decimal point: ${JSON.stringify(out)}`
  );
});

test("normal multi-sentence text still splits", () => {
  const { sentences } = takeSentences(
    "आपका balance 5,000 रुपये है। और कुछ जानना चाहेंगे? ",
    { eagerFirst: true }
  );
  assert.equal(sentences.length, 2);
});

console.log("\ndigitRunsFromWords — spoken account numbers");

test("maps a spoken Hindi digit run to digits", () => {
  assert.deepEqual(digitRunsFromWords("paanch chaar teen do"), ["5432"]);
});

test("ignores short runs so 'do lakh' is not mangled", () => {
  assert.deepEqual(digitRunsFromWords("do lakh rupaye"), []);
});

test("prototype keys do not resolve through Object.prototype", () => {
  // "constructor" used to resolve to a function and poison the run.
  const runs = digitRunsFromWords("constructor toString valueOf hasOwnProperty");
  assert.deepEqual(runs, []);
});

console.log("\nexpandHinglish — lexical arm");

test("expands Devanagari banking terms to English", () => {
  assert.ok(expandHinglish("मेरा खाता नंबर").includes("account"));
});

test("prototype keys are not treated as lexicon hits", () => {
  assert.deepEqual(expandHinglish("constructor toString"), []);
});

console.log("\naskLanguage — decides reply script AND spoken number language");

test("romanized Hindi question is Hindi, not English", () => {
  assert.equal(askLanguage("total kitna hua?"), "hi");
  assert.equal(askLanguage("labour amount kitna hai?"), "hi");
});

test("Devanagari anywhere is Hindi", () => {
  assert.equal(askLanguage("आपका balance kitna hai"), "hi");
});

test("plain English stays English", () => {
  assert.equal(askLanguage("What is the bill number?"), "en");
  assert.equal(askLanguage("Show me the closing balance please"), "en");
});

test("English words that look like Hindi markers do not misfire", () => {
  // "is", "to", "no", "so" must NOT be in the marker set.
  assert.equal(askLanguage("Is there a service charge to note?"), "en");
});

test("the directive names the right script", () => {
  assert.match(replyDirective("en"), /English only/);
  assert.match(replyDirective("hi"), /Devanagari/);
});

console.log("\nexpandOrdinals — 'aathvi item' must retrieve row 8");

test("romanized Hindi ordinal resolves to the row number", () => {
  assert.deepEqual(expandOrdinals("aathvi item ka amount kitna hai?"), ["8", "item 8"]);
});

test("Devanagari ordinal resolves too", () => {
  assert.deepEqual(expandOrdinals("आठवां item"), ["8", "item 8"]);
});

test("feminine and masculine forms both resolve", () => {
  assert.deepEqual(expandOrdinals("paanchvi"), expandOrdinals("paanchva"));
});

test("a question with no ordinal expands to nothing", () => {
  assert.deepEqual(expandOrdinals("bill number kya hai"), []);
});

console.log("\ncanonicalizeOrdinals / targetRow — same question must not get two answers");

test("spelling variants collapse to one identical query", () => {
  // These two returned DIFFERENT amounts in production because they embedded
  // differently: aathvi -> item 5's value, athvi -> item 8's value.
  const a = canonicalizeOrdinals("aathvi item ka amount kitna hai?");
  const b = canonicalizeOrdinals("athvi item ka amount kitna hai?");
  assert.equal(a, b);
  assert.equal(a, "item 8 ka amount kitna hai?");
});

test("Devanagari ordinals canonicalize despite combining marks", () => {
  // \p{L}+ alone splits आठवीं at the vowel sign and never matches.
  assert.equal(canonicalizeOrdinals("आठवीं item ka amount"), "item 8 ka amount");
  assert.equal(canonicalizeOrdinals("आठवां item ka amount"), "item 8 ka amount");
});

test("no doubled 'item' echo", () => {
  assert.ok(!/item\s+\d+\s+item/i.test(canonicalizeOrdinals("aathvi item ka amount")));
});

test("targetRow finds the row from ordinal or explicit form", () => {
  assert.equal(targetRow("aathvi item ka amount kitna hai?"), "8");
  assert.equal(targetRow("आठवीं item ka amount"), "8");
  assert.equal(targetRow("item 8 ka amount"), "8");
  assert.equal(targetRow("row 3 amount"), "3");
});

test("targetRow is null when no row is referenced", () => {
  assert.equal(targetRow("bill number kya hai"), null);
  assert.equal(targetRow("labour amount kitna hai"), null);
});

console.log("\nnormalizeForSpeech — how a number is written decides how it is read");

test("groups a bare 4-digit amount so it is spoken as one quantity", () => {
  assert.equal(normalizeForSpeech("Total 1234 rupees"), "Total 1,234 rupees");
});

test("groups lakh-scale Indian-style", () => {
  assert.equal(normalizeForSpeech("120000"), "1,20,000");
});

test("leaves a decimal weight alone", () => {
  assert.equal(normalizeForSpeech("वज़न 60.433 ग्राम"), "वज़न 60.433 ग्राम");
});

test("does NOT group an IFSC code", () => {
  assert.equal(normalizeForSpeech("IFSC SBIN0001234"), "IFSC SBIN0001234");
});

test("does NOT group an invoice number", () => {
  assert.equal(normalizeForSpeech("Bill INV1234"), "Bill INV1234");
});

test("does NOT group a hyphenated id", () => {
  assert.equal(normalizeForSpeech("ID-100234"), "ID-100234");
});

test("leaves a spaced-out account number digit-by-digit", () => {
  assert.equal(normalizeForSpeech("5 4 3 2 1 0"), "5 4 3 2 1 0");
});

test("strips leaked CJK characters before they reach the voice", () => {
  assert.equal(normalizeForSpeech("आपका balance 极 है"), "आपका balance है");
});

console.log("\nlanguageFor — number language must not flip on one unit word");

test("an English sentence with a lone Devanagari unit stays English", () => {
  assert.equal(languageFor("The total weight is 60.433 ग्राम"), "en-IN");
});

test("a Hindi sentence is Hindi", () => {
  assert.equal(languageFor("आपका total वज़न 60.433 ग्राम है"), "hi-IN");
});

test("a pure English sentence is English", () => {
  assert.equal(languageFor("Your balance is 5,000 rupees"), "en-IN");
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
