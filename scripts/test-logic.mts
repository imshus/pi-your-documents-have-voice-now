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
  carriedRow,
} from "../lib/queryText.ts";
import { normalizeForSpeech, languageFor } from "../lib/sarvam.ts";
import { askLanguage, replyDirective } from "../lib/askLanguage.ts";
import { focusRow, focusTotals, wantsTotals, focusColumn, wantsColumn } from "../lib/rowFocus.ts";
import { chunkDocument, repairTotalRow, tableTotals } from "../lib/chunk.ts";
import { renderCorpus, corpusChunks } from "../lib/corpusFormat.ts";

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

test("the Hindi directive forbids echoing the caller's romanized spelling", () => {
  // "athvi item ka amount kitna hai?" came back as "Athvi item ka amount ...
  // rupees hai." — the model mirrored the caller's Latin spelling.
  assert.match(replyDirective("hi"), /[Dd]o NOT copy the caller's spelling/);
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

console.log("\nchunkDocument — every table chunk must carry its column header");

const CHUNK_DOC_BASE = {
  document_type: "invoice", title: "Packing List", summary: "s", issuer: null,
  account_holder: { name: null, address: null, date_of_birth: null, contact: null, identifiers: [] },
  account: { number: null, type: null, ifsc_or_routing: null, branch: null, currency: null, opened_on: null, status: null, balance: null },
  parties: [], fields: [], dates: [], amounts: [], remarks: [], stamps_and_annotations: [],
  full_text: "x", confidence_notes: "",
};

test("a wide table never orphans rows from the columns line", () => {
  // 23 columns x 12 rows, the real shape of the indexed packing list. Routing
  // these through the character splitter produced chunks of bare pipe rows with
  // no "columns:" line, so nothing downstream could tell which number was the
  // amount — and the agent said "not in your documents" for a row it had.
  const columns = [
    "Sr.", "Item No.", "Design", "Code", "Gr Wt", "Net Wt", "Pure Wt",
    "Clarity Rate", "Diamond Shape/Size", "Diamond Pcs", "Diamond Wt",
    "Diamond Rate", "Diamond Amt", "Stone Code", "Stone Pcs", "Stone Wt",
    "Stone Rate", "Stone Amt", "Other Code", "Other Amt", "Labour Rate",
    "Labour Amt", "Amount (INR)",
  ];
  const rows = Array.from({ length: 12 }, (_, i) => [
    String(i + 1), "261313", "LR110711", "G18K", "3.410", "3.279", "2.558",
    "78.00", "RDGHVS SI", "65", "0.654", "14388", "14388", "", "", "", "", "",
    "HUID", "75", "850", "2787", String(17000 + i),
  ]);
  const doc = { ...CHUNK_DOC_BASE, tables: [{ name: "Packing list items", columns, rows }] };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const produced = chunkDocument(doc as any, "Packing List-1.pdf");
  const tableChunks = produced.filter((c) => c.section.startsWith("table:"));
  assert.ok(tableChunks.length > 1, "a 12-row wide table should span several chunks");
  for (const c of tableChunks) {
    assert.ok(
      c.content.includes("columns:"),
      `chunk without a header:\n${c.content.slice(0, 120)}`
    );
  }
  // The whole-table chunk holds every row; the row-group chunks then split
  // those same rows so each appears in exactly one GROUP (as well as the whole).
  const wholeChunk = tableChunks.find((c) => c.content.includes("Full table"));
  assert.ok(wholeChunk, "a whole-table chunk should be emitted");
  const groupChunks = tableChunks.filter((c) => c !== wholeChunk);
  for (let i = 1; i <= 12; i++) {
    const re = new RegExp(`^${i} \\|`, "m");
    assert.ok(re.test(wholeChunk!.content), `row ${i} missing from the whole-table chunk`);
    const hits = groupChunks.filter((c) => re.test(c.content));
    assert.equal(hits.length, 1, `row ${i} appears in ${hits.length} row-group chunks`);
  }
});

test("focusRow can read every row of the chunks the chunker produces", () => {
  const columns = ["Sr.", "Item No.", "Gr Wt", "Amount (INR)"];
  const rows = Array.from({ length: 12 }, (_, i) => [
    String(i + 1), "2613" + i, "3.410", String(17000 + i),
  ]);
  const doc = { ...CHUNK_DOC_BASE, tables: [{ name: "Packing list items", columns, rows }] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const produced = chunkDocument(doc as any, "Packing List-1.pdf");
  for (let i = 1; i <= 12; i++) {
    const out = focusRow(produced, String(i));
    assert.ok(out, `row ${i} should be locatable`);
    assert.match(out!, new RegExp(`Amount \\(INR\\): ${17000 + i - 1}`));
  }
});

console.log("\nrepairTotalRow — a misaligned printed total is verified against column sums");

// The REAL failure, verbatim from the indexed PDF: the printed 4498 (total
// stone amount) landed under "Stone Rate" while "Stone Amt" sat empty, and
// Diamond Rate duplicated Diamond Amt's 182442. The model then read labels
// faithfully and reported stone pieces/weight but "couldn't find" the amount.
const TOTAL_COLUMNS = [
  "Sr.", "Item No.", "Gr Wt", "Diamond Rate", "Diamond Amt",
  "Stone Pcs", "Stone Wt", "Stone Rate", "Stone Amt", "Amount (INR)",
];
const TOTAL_ITEMS = [
  ["1", "261323", "10.390", "22000", "91221", "100", "1.996", "1500", "2249", "118742"],
  ["2", "261324", "50.043", "22000", "91221", "51", "1.000", "6000", "2249", "118741"],
];
// sums: GrWt 60.433, DiamondAmt 182442, StonePcs 151, StoneWt 2.996, StoneAmt 4498, Amount 237483
const TOTAL_PRINTED = ["Total", "", "60.433", "182442", "182442", "151", "2.996", "4498", "", "237483"];

test("relocates a total into its rightful empty column", () => {
  const r = repairTotalRow(TOTAL_COLUMNS, TOTAL_ITEMS, TOTAL_PRINTED);
  assert.equal(r[8], "4498", "Stone Amt should receive the relocated total");
  assert.equal(r[7], "", "Stone Rate should be vacated");
});

test("drops a duplicate of a value already in its right place", () => {
  const r = repairTotalRow(TOTAL_COLUMNS, TOTAL_ITEMS, TOTAL_PRINTED);
  assert.equal(r[4], "182442", "Diamond Amt keeps its correct total");
  assert.equal(r[3], "", "Diamond Rate's duplicate is dropped");
});

test("correctly placed totals are untouched", () => {
  const r = repairTotalRow(TOTAL_COLUMNS, TOTAL_ITEMS, TOTAL_PRINTED);
  assert.equal(r[2], "60.433");
  assert.equal(r[5], "151");
  assert.equal(r[9], "237483");
  assert.equal(r[0], "Total");
});

console.log("\nchunkDocument totals — labelled, verified, no pipe-counting");

test("a printed Total row becomes a labelled TOTALS chunk with the repair applied", () => {
  const doc = {
    ...CHUNK_DOC_BASE,
    tables: [{ name: "Packing list items", columns: TOTAL_COLUMNS, rows: [...TOTAL_ITEMS, TOTAL_PRINTED] }],
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const produced = chunkDocument(doc as any, "Packing List-1.pdf");
  const totals = produced.find((c) => c.content.includes("TOTALS for all"));
  assert.ok(totals, "totals chunk should exist");
  assert.match(totals!.content, /Total Stone Amt: 4498/);
  assert.ok(!/Total Stone Rate:/.test(totals!.content), "misaligned label must not survive");
  // The Total row must not also ride as a pipe row.
  const pipeChunks = produced.filter((c) => c.section.startsWith("table:") && !c.content.includes("TOTALS"));
  assert.ok(!pipeChunks.some((c) => /^Total \|/m.test(c.content)), "Total row stays out of the pipe rows");
});

test("a table with no printed totals gets computed sums for quantity columns only", () => {
  const doc = {
    ...CHUNK_DOC_BASE,
    tables: [{
      name: "Packing List Items",
      columns: ["Sr", "Item No.", "Tunch Rate", "Pcs", "Wt", "Amt", "Pcs", "Wt", "Amt"],
      rows: [
        ["1", "261323", "84", "2", "0.010", "300", "31", "0.324", "599"],
        ["2", "261324", "84", "12", "0.047", "1410", "34", "0.175", "324"],
      ],
    }],
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const produced = chunkDocument(doc as any, "x.xlsx");
  const totals = produced.find((c) => c.content.includes("TOTALS for all"));
  assert.ok(totals, "computed totals chunk should exist");
  assert.match(totals!.content, /Total Pcs: 14/);
  assert.match(totals!.content, /Total Pcs \(2\): 65/, "duplicate labels are disambiguated");
  assert.match(totals!.content, /Total Amt: 1710/);
  assert.match(totals!.content, /Total Amt \(2\): 923/);
  // The header line legitimately names every column; what must never exist
  // is a SUMMED pair for a rate column.
  assert.ok(!/Total Tunch Rate:/.test(totals!.content), "rate columns are never summed");
});

console.log("\ntableTotals — a left-shifted amount total lands on the right label");

test("corroborated column sum pins a total vision dropped in a neighbour column", () => {
  // The REAL labour bug: the printed Labour Amt total (12822) landed under
  // "Labour Rate", and the grand total (50385) sat under "Labour Amt" — whose
  // rightful column (Amount (INR)) sums to something else because the amount is
  // double-counted by subtotal rows. repairTotalRow can't fix it (every target
  // column is occupied); the per-item sum pins each figure to its real column.
  const columns = ["Sr.", "Labour Rate", "Labour Amt", "Amount (INR)"];
  const itemRows = [
    ["1", "850", "8578", "34815"],
    ["2", "850", "4244", "15570"],
    ["1", "", "", "34815"], // subtotal row echoes the amount -> Amount col doubles
    ["2", "", "", "15570"],
  ];
  const labels = columns; // no duplicate headers here
  // Labour Amt sum = 12822; the printed total is shifted one column left AND is
  // short a cell (vision drops the trailing empty column) — so the rightful
  // Amount (INR) slot must be created, not read off the printed row.
  const printed = ["Total", "12822", "50385"];
  const out = tableTotals(columns, itemRows, [printed], labels).join("\n");

  assert.match(out, /Total Labour Amt: 12822/, "labour total pinned to Labour Amt");
  assert.match(out, /Total Amount \(INR\): 50385/, "grand total pushed to its column");
  assert.ok(!/Total Labour Rate: 12822/.test(out), "the shift artifact under the rate label is dropped");
  assert.ok(!/Total Labour Amt: 50385/.test(out), "the grand total is not left mislabelled");
  assert.ok(!/undefined/.test(out), "no column emits an undefined value");
});

test("detail/breakup tables never get synthesized totals", () => {
  const doc = {
    ...CHUNK_DOC_BASE,
    tables: [{
      name: "Detailed Stone / HUID Lines",
      columns: ["Line", "Item No.", "Pcs", "Amt"],
      rows: [
        ["1", "261323", "2", "300"],
        ["2", "261323", "3", "330"],
      ],
    }],
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const produced = chunkDocument(doc as any, "x.xlsx");
  assert.ok(!produced.some((c) => c.content.includes("TOTALS for all")), "no totals for detail tables");
});


console.log("\nfocusRow — hand the model the row, don't make it count columns");

// Verbatim shape of a real table chunk from the indexed corpus.
const TABLE_CHUNK = {
  section: 'table:Packing list items',
  content: [
    "Document: Packing List (invoice)",
    'Table "Packing list items" — columns: Sr. | Item No. | Design | Code | Gr Wt | Net Wt | Pure Wt | Clarity Rate | Diamond Pcs | Diamond Wt | Stone Pcs | Stone Amt | Labour Amt | Amount (INR)',
    "Rows 1-8:",
    "1 | 261323 | PS10189 | G18K | 10.390 | 10.092 | 7.872 | 78.00 | 153 | 1.167 | 31 | 488 | 8578 | 34815",
    "2 | 261324 | PSE10189 | G18K | 5.127 | 4.993 | 3.895 | 78.00 | 128 | 0.496 | 34 | 264 | 4244 | 15570",
    "5 | 261313 | LR110711 | G18K | 3.410 | 3.279 | 2.558 | 78.00 | 65 | 0.654 |  |  | 2787 | 17250",
    "8 | 261299 | PS10187 | G18K | 9.876 | 9.641 | 7.520 | 78.00 | 191 | 1.176 |  |  | 8195 | 34142",
  ].join("\n"),
};

test("picks the asked row, not a neighbour (the observed bug)", () => {
  // "item 2 ka amount" was answered 34,815 — row 1's amount.
  const out = focusRow([TABLE_CHUNK], "2");
  assert.ok(out, "row 2 should be found");
  assert.match(out!, /Amount \(INR\): 15570/);
  assert.ok(!out!.includes("34815"), "must not leak row 1");
});

test("labels the amount column instead of leaving 14 bare pipes", () => {
  const out = focusRow([TABLE_CHUNK], "8");
  assert.match(out!, /Amount \(INR\): 34142/);
  assert.match(out!, /Gr Wt: 9\.876/);
});

test("row 1 is not matched by rows 10/11 style prefixes", () => {
  const out = focusRow([TABLE_CHUNK], "1");
  assert.match(out!, /Amount \(INR\): 34815/);
});

test("returns null when the row is absent, so the agent can refuse", () => {
  assert.equal(focusRow([TABLE_CHUNK], "99"), null);
});

test("ignores non-table chunks", () => {
  assert.equal(focusRow([{ section: "fields", content: "8 | nope" }], "8"), null);
});

test("empty cells are dropped rather than labelled blank", () => {
  const out = focusRow([TABLE_CHUNK], "5");
  assert.ok(!/Stone Pcs:\s*$/m.test(out!), "blank cells should not appear");
  assert.match(out!, /Amount \(INR\): 17250/);
});


console.log("\nfocusTotals / wantsTotals — totals are located in code, not by the model");

test("total-intent questions are detected in both languages", () => {
  assert.ok(wantsTotals("stone amount kitna hai?"));
  assert.ok(wantsTotals("total kitna hua?"));
  assert.ok(wantsTotals("कुल कितना हुआ?"));
  assert.ok(wantsTotals("labour amount?"));
});

test("item questions are NOT treated as totals", () => {
  assert.ok(!wantsTotals("item 5 ka amount kitna hai?"));
  assert.ok(!wantsTotals("bill number kya hai?"));
});

test("focusTotals returns the labelled TOTALS block", () => {
  const chunk = {
    section: "table:Packing list items",
    content:
      "Document: Packing List (invoice)\nTable header\nTOTALS for all 12 items (verified against the per-item columns):\nTotal Stone Amt: 4498\nTotal Labour Amt: 49493",
  };
  const out = focusTotals([chunk]);
  assert.ok(out);
  assert.match(out!, /Total Stone Amt: 4498/);
  assert.match(out!, /already located for you/);
});

test("focusTotals returns null when no totals block exists", () => {
  assert.equal(focusTotals([{ section: "table:x", content: "1 | 2 | 3" }]), null);
});

console.log("\nfocusColumn / wantsColumn — column-aggregation answers computed in code");

const COL_CHUNK = {
  section: "table:Packing list items",
  content: [
    "Document: Packing List (invoice)",
    'Table "Packing list items" — columns: Sr. | Diamond Shape/Size | Diamond Rate | Stone Code | Stone Rate | Labour Rate | Amount (INR)',
    "Rows 1-4:",
    "1 | RDVSSI | 22000 | RUB | 1500 | 850 | 34815",
    "2 | RDVSSI | 22000 | RUB | 1500 | 850 | 15570",
    "3 | RDGHVS SI | 22000 |  |  | 850 | 20188",
    "4 | RDGHVS SI | 22000 |  |  | 850 | 20128",
  ].join(String.fromCharCode(10)),
};

test("a uniform column is reported as uniform, never as varying (the hallucination fix)", () => {
  const out = focusColumn([COL_CHUNK], "diamond ka rate kya hai?");
  assert.ok(out);
  assert.match(out!, /Every one of the 4 items has the same Diamond Rate: 22000/);
  // The live bug invented a per-item exception; nothing here may suggest one.
  assert.ok(!/38000|MQGHV/.test(out!));
});

test("distinct values are counted for a type/shape question", () => {
  const out = focusColumn([COL_CHUNK], "diamond kitne type ka hai?");
  assert.match(out!, /2 distinct Diamond Shape/);
  assert.match(out!, /RDVSSI \(2 items\)/);
  assert.match(out!, /RDGHVS SI \(2 items\)/);
});

test("a qualifier is binding — stone rate never resolves to Diamond Rate", () => {
  const out = focusColumn([COL_CHUNK], "stone ka rate kya hai?");
  assert.ok(out);
  assert.match(out!, /Stone Rate/);
  assert.ok(!/Diamond Rate/.test(out!));
});

test("an unqualified ambiguous noun returns null (many Rate columns)", () => {
  assert.equal(focusColumn([COL_CHUNK], "rate kya hai?"), null);
});

test("a qualifier with no matching column returns null, not a wrong group", () => {
  // No Stone Shape column exists.
  assert.equal(focusColumn([COL_CHUNK], "stone kitne type ka hai?"), null);
});

test("a multi-code cell counts each code — 'RDVSSI / MQGHV SSI' is not one type", () => {
  // The live doc has three clarity types, but extraction collapsed item 3's
  // "RDVSSI / MQGHV SSI" to "RDVSSI" and the count came out 2. With the cell
  // preserved, the split must recover all three, and drop "various sizes" noise.
  const chunk = {
    section: "table:x",
    content: [
      "Document: x",
      'Table "x" — columns: Sr. | Diamond Shape/Size | Diamond Rate',
      "Rows 1-4:",
      "1 | RDVSSI / various sizes | 22000",
      "2 | RDVSSI | 22000",
      "3 | RDVSSI / MQGHV SSI | 22000",
      "4 | RDGHVS SI | 22000",
    ].join(String.fromCharCode(10)),
  };
  const out = focusColumn([chunk], "diamond kitne type ka hai?");
  assert.match(out!, /3 distinct/);
  assert.match(out!, /MQGHV SSI/);
  assert.ok(!/various sizes/.test(out!), "size-note fragments are not codes");
  // A rate cell is never split into pieces.
  assert.match(focusColumn([chunk], "diamond ka rate?")!, /same Diamond Rate: 22000/);
});

test("wantsColumn detects column-aggregation intent, not row lookups", () => {
  assert.ok(wantsColumn("diamond kitne type ka hai?", [COL_CHUNK]));
  assert.ok(wantsColumn("diamond ka rate kya hai?", [COL_CHUNK]));
  assert.ok(!wantsColumn("item 5 ka amount kitna hai?", [COL_CHUNK]));
});

console.log("\ncarriedRow — follow-ups inherit the previous turn\'s row");

test("anaphora carries the previous row", () => {
  assert.equal(carriedRow("uska weight kitna hai?", "item 5 ka amount kitna hai?"), "5");
  assert.equal(carriedRow("उसका weight?", "आठवीं item ka amount"), "8");
});

test("a message with its own row never carries", () => {
  assert.equal(carriedRow("uska item 3 ka weight?", "item 5 ka amount"), null);
});

test("no anaphora word, no carry", () => {
  assert.equal(carriedRow("weight kitna hai?", "item 5 ka amount"), null);
});

test("no previous turn, no carry", () => {
  assert.equal(carriedRow("uska weight?", null), null);
});

console.log("\ncorpus rendering — full mode must see the same repaired view as hybrid");

const CORPUS_TEST_DOC = {
  file_name: "Packing List-1.pdf", doc_type: "invoice", title: "Packing List",
  data: {
    ...CHUNK_DOC_BASE,
    tables: [{ name: "Packing list items", columns: TOTAL_COLUMNS, rows: [...TOTAL_ITEMS, TOTAL_PRINTED] }],
  },
};

test("the corpus text carries table headers and repaired totals, not raw JSON", () => {
  const text = renderCorpus([CORPUS_TEST_DOC]);
  assert.match(text, /columns: Sr\./, "table header must be present");
  assert.match(text, /Total Stone Amt: 4498/, "repaired totals must be inlined");
  assert.ok(!text.includes('"tables"'), "raw JSON rendering must be gone");
});

test("focusRow locates rows in the corpus chunks (full-mode row questions)", () => {
  const out = focusRow(corpusChunks([CORPUS_TEST_DOC]), "2");
  assert.ok(out, "row 2 should be locatable from corpus chunks");
  assert.match(out!, /Amount \(INR\): 118741/);
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
