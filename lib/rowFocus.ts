/**
 * Pulls the ONE table row the caller asked about out of the retrieved chunks
 * and re-presents it as labelled fields.
 *
 * WHY THIS EXISTS. Table chunks carry 8 rows of a 20+ column packing list as
 * pipe-delimited text:
 *
 *   columns: Sr | Item No. | Design | ... | Stone Amt | Labour Amt | Amount (INR)
 *   8 | 261299 | PS10187 | ... | 8195 | 34142
 *
 * Answering "item 8 ka amount" then requires the model to count 20-odd pipes
 * and land on the right column — in a header where "Pcs", "Wt" and "Amt" each
 * appear more than once. It gets this wrong in a specific, dangerous way: it
 * returns a neighbouring row's or column's number, which is a plausible amount,
 * so the reply sounds exactly as confident as a correct one. Observed: "item 2
 * ka amount" answered 34,815, which is row 1's amount.
 *
 * Counting columns is deterministic, so we do it in code and hand the model
 * "Amount (INR): 34142" instead of asking it to find that itself.
 */

export type RowChunk = { section: string | null; content: string };

/** Repeated headers ("Pcs" twice) get an index so labels stay unambiguous. */
function uniqueLabels(headers: string[]): string[] {
  const seen = new Map<string, number>();
  return headers.map((h) => {
    const n = (seen.get(h) ?? 0) + 1;
    seen.set(h, n);
    return n === 1 ? h : `${h} (${n})`;
  });
}

const splitCells = (line: string) => line.split("|").map((c) => c.trim());

/** Parse a table chunk into { header labels, item rows }. Null if not a table. */
function parseTable(
  chunk: RowChunk
): { labels: string[]; rows: string[][] } | null {
  if (!chunk.section?.startsWith("table")) return null;
  const lines = chunk.content.split("\n");
  const headerLine = lines.find((l) => l.includes("columns:"));
  if (!headerLine) return null;
  const labels = uniqueLabels(
    splitCells(headerLine.slice(headerLine.indexOf("columns:") + "columns:".length))
  );
  const rows: string[][] = [];
  for (const line of lines) {
    if (!line.includes("|")) continue;
    if (line.includes("columns:")) continue;
    const cells = splitCells(line);
    // Row lines start with a numeric Sr; skip the Total line and header echoes.
    if (!/^\d+$/.test(cells[0])) continue;
    rows.push(cells);
  }
  return rows.length ? { labels, rows } : null;
}

/**
 * COLUMN-AGGREGATION intent + extraction — the columns twin of focusRow.
 *
 * "diamond ka rate kya hai?" and "diamond kitne type ka hai?" ask about a whole
 * COLUMN across every item, not one row. Left to the model, it scans a 23-wide
 * table by eye and hallucinates — observed live: it answered the rate question
 * with a fabricated "item 3 MQGHV SSI 38,000" (there is no such value; every
 * rate is 22,000), pulling a code from the SHAPE column into the RATE answer.
 * Reading a column and de-duplicating it is deterministic, so we do it here.
 */

/** Caller noun -> the header token that identifies its column. */
const COLUMN_NOUNS: { re: RegExp; token: string }[] = [
  { re: /\b(rate|भाव|रेट)\b/i, token: "rate" },
  { re: /\b(type|types|shape|clarity|प्रकार|टाइप|शेप|क्वालिटी|quality)\b/i, token: "shape" },
  { re: /\b(size|साइज़|साइज)\b/i, token: "size" },
  { re: /\b(design|डिज़ाइन|डिजाइन)\b/i, token: "design" },
  { re: /\b(code|कोड)\b/i, token: "code" },
];
/** Optional qualifier that disambiguates repeated column groups. */
const QUALIFIERS = [
  "diamond", "stone", "labour", "labor", "metal", "gross", "net", "pure", "other", "clarity", "tunch",
];
/** Words that signal "across all items", so a column answer is what's wanted. */
const COLUMN_INTENT =
  /\b(kitne|kitna|kaun|type|types|distinct|list|sab|saare|har|each|every|different|alag|how many|what|kya)\b|कितने|कितना|कौन|सब|सारे|हर|अलग|कितने\s*type|प्रकार|टाइप/i;

/** Resolve which column the query is asking about, or null if ambiguous/none. */
function resolveColumn(query: string, labels: string[]): number | null {
  const q = query.toLowerCase();
  const noun = COLUMN_NOUNS.find((n) => n.re.test(query));
  if (!noun) return null;
  const qualifier = QUALIFIERS.find((qf) => q.includes(qf)) ?? null;

  // Candidate columns whose header contains the noun token.
  const candidates = labels
    .map((h, i) => ({ h: h.toLowerCase(), i }))
    .filter((c) => c.h.includes(noun.token));
  if (candidates.length === 0) return null;

  // A qualifier is BINDING: "stone type" must never resolve to Diamond Shape.
  // If the caller named a group and no candidate belongs to it, answer nothing
  // rather than a plausibly-wrong column from another group.
  if (qualifier) {
    const inGroup = candidates.filter((c) => c.h.includes(qualifier));
    return inGroup.length === 1 ? inGroup[0].i : null;
  }

  // No qualifier: only unambiguous when exactly one column matches the noun.
  return candidates.length === 1 ? candidates[0].i : null;
}

/** A column whose non-empty cells are mostly numeric is treated as numeric. */
function isNumericColumn(rows: string[][], col: number): boolean {
  let num = 0;
  let total = 0;
  for (const r of rows) {
    const v = String(r[col] ?? "").trim();
    if (!v) continue;
    total++;
    if (/^-?[\d,]+(\.\d+)?$/.test(v)) num++;
  }
  return total > 0 && num / total > 0.6;
}

/**
 * Distinct values of one column across the item rows, with per-item counts.
 * A CATEGORICAL cell holding several codes ("RDVSSI / MQGHV SSI") is split so
 * each code is counted — otherwise "how many types" under-counts a combo cell
 * as one opaque value. Size/note fragments ("/ various sizes") carry no
 * uppercase code and are dropped. Numeric columns are never split (a rate is
 * one value even if a cell shows two).
 */
function distinctColumn(
  rows: string[][],
  col: number,
  numeric: boolean
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const raw = String(r[col] ?? "").trim();
    if (!raw) continue;
    const parts = numeric
      ? [raw]
      : raw
          .split(/[\/,\n]+/)
          .map((s) => s.trim())
          .filter((s) => /[A-Z]{2,}/.test(s)); // a real code, not "various sizes"
    // Dedupe within one cell, then count the ITEM once per distinct code.
    for (const p of new Set(parts.length ? parts : [raw])) {
      counts.set(p, (counts.get(p) ?? 0) + 1);
    }
  }
  return counts;
}

export function wantsColumn(query: string, chunks: RowChunk[]): boolean {
  if (!COLUMN_INTENT.test(query)) return false;
  for (const c of chunks) {
    const t = parseTable(c);
    if (t && resolveColumn(query, t.labels) !== null) return true;
  }
  return false;
}

/**
 * The labelled column summary, or null when no column resolves. Deduplicates so
 * "kitne type" is answerable and a uniform column can't be reported as varying.
 */
export function focusColumn(chunks: RowChunk[], query: string): string | null {
  for (const chunk of chunks) {
    const t = parseTable(chunk);
    if (!t) continue;
    const col = resolveColumn(query, t.labels);
    if (col === null) continue;

    const numeric = isNumericColumn(t.rows, col);
    const counts = distinctColumn(t.rows, col, numeric);
    if (counts.size === 0) continue;
    const label = t.labels[col];
    const n = t.rows.length;
    const entries = [...counts.entries()];

    let summary: string;
    if (counts.size === 1) {
      summary = `Every one of the ${n} items has the same ${label}: ${entries[0][0]}.`;
    } else if (counts.size <= 8) {
      const list = entries.map(([v, c]) => `${v} (${c} item${c === 1 ? "" : "s"})`).join(", ");
      summary = `There are ${counts.size} distinct ${label} values across the ${n} items: ${list}.`;
    } else {
      const nums = numeric
        ? entries.map(([v]) => Number(v.replace(/,/g, ""))).filter((x) => !Number.isNaN(x))
        : [];
      summary =
        nums.length === entries.length && nums.length > 0
          ? `${label} differs per item across the ${n} items, ranging from ${Math.min(...nums)} to ${Math.max(...nums)}.`
          : `${label} differs across the ${n} items (${counts.size} distinct values).`;
    }
    return `COLUMN LOOKUP — the caller is asking about the "${label}" column across all items; already computed for you, answer from this and add nothing:\n${summary}`;
  }
  return null;
}

/**
 * Finds `row` in any table chunk and renders it as one labelled block.
 * Returns null when the row is not present — the caller then says so rather
 * than answering from a neighbouring row.
 */
/**
 * Total-intent detection + extraction, the totals twin of focusRow.
 *
 * "stone amount kitna hai?" failed twice this session: the answer lives in the
 * TOTALS block, and whether the model surfaced it depended on retrieval rank
 * and its own column reading. Locating the block is deterministic, so hand it
 * over the same way focusRow hands over a row.
 */
const TOTAL_INTENT =
  /\b(total|kul|sab\s*mila|kitna\s+(?:hua|hai\s+sab))\b|कुल|टोटल|कितना\s+हुआ|सब\s+मिला/i;
/** Column-ish words that imply an aggregate even without the word "total". */
const AGGREGATE_HINT =
  /\b(stone|diamond|labour|labor|metal|gross|net|pure)\s*(amount|amt|weight|wt|pcs|pieces)\b/i;

export function wantsTotals(query: string): boolean {
  return TOTAL_INTENT.test(query) || AGGREGATE_HINT.test(query);
}

/** The labelled TOTALS block, if the corpus/chunks carry one. */
export function focusTotals(chunks: RowChunk[]): string | null {
  for (const chunk of chunks) {
    if (!chunk.section?.startsWith("table")) continue;
    const idx = chunk.content.indexOf("TOTALS for all");
    if (idx === -1) continue;
    const block = chunk.content.slice(idx).trim();
    return `THE DOCUMENT'S TOTALS — already located for you; read total/aggregate questions straight from here:\n${block}`;
  }
  return null;
}

export function focusRow(chunks: RowChunk[], row: string): string | null {
  for (const chunk of chunks) {
    if (!chunk.section?.startsWith("table")) continue;

    const lines = chunk.content.split("\n");
    const headerLine = lines.find((l) => l.includes("columns:"));
    if (!headerLine) continue;

    const headers = uniqueLabels(
      splitCells(headerLine.slice(headerLine.indexOf("columns:") + "columns:".length))
    );

    for (const line of lines) {
      if (!line.includes("|")) continue;
      const cells = splitCells(line);
      // The row's own Sr/serial number is the first cell. Match on it exactly —
      // a substring match would make "1" hit rows 1, 10 and 11.
      if (cells[0] !== row) continue;

      const pairs = cells
        .map((v, i) => [headers[i] ?? `Column ${i + 1}`, v] as const)
        .filter(([, v]) => v !== "")
        .map(([k, v]) => `${k}: ${v}`);
      if (pairs.length < 2) continue;

      const table = lines.find((l) => l.startsWith('Table "'))?.trim() ?? "";
      return `THE ROW THE CALLER ASKED FOR — item ${row}${table ? ` of ${table}` : ""}, already located for you. Every value below belongs to item ${row}; read the one they asked for straight from here.\n${pairs.join("\n")}`;
    }
  }
  return null;
}
