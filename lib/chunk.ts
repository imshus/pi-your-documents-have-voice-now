import type { ExtractedDocument } from "./supabase";

export type Chunk = { section: string; content: string };

const MAX_CHARS = 900;

/**
 * The whole-table chunk is deliberately exempt from MAX_CHARS — its whole point
 * is to hold the entire table in one retrievable unit — but it still has to fit
 * a single embedding vector (~8k-token cap). estimateTokens counts ~3.5 chars
 * per token, so this ceiling keeps even a dense table well under the limit; a
 * table larger than this stays split-only.
 */
const MAX_WHOLE_TABLE_CHARS = 24000;

/** Numeric cell -> number, else null. Accepts comma grouping ("1,234"). */
function numericCell(v: string | undefined | null): number | null {
  const s = String(v ?? "").trim();
  if (!/^-?[\d,]+(\.\d+)?$/.test(s)) return null;
  return parseFloat(s.replace(/,/g, ""));
}

/** Equality at 3 decimal places — weights are printed to 3dp. */
function eq3(a: number, b: number): boolean {
  return Math.round(a * 1000) === Math.round(b * 1000);
}

/**
 * Per-column sums over the ITEM rows (null where a column has no numeric
 * cells). The per-item cells are what extraction aligns reliably — they are
 * cross-checked by the eval — so these sums are the ground truth the printed
 * Total row is verified against.
 */
export function columnSums(
  columns: string[],
  itemRows: string[][]
): (number | null)[] {
  return columns.map((_, i) => {
    let sum = 0;
    let any = false;
    for (const r of itemRows) {
      const n = numericCell(r[i]);
      if (n !== null) {
        sum += n;
        any = true;
      }
    }
    return any ? Math.round(sum * 1000) / 1000 : null;
  });
}

/**
 * Repairs a printed Total row against the computed column sums.
 *
 * WHY: vision extraction misaligns the totals line of a wide table — observed
 * live: the packing list's total stone amount 4498 landed under "Stone Rate"
 * (whose real sum is 7500) while "Stone Amt" sat empty; the model then
 * faithfully reported stone pieces and weight but "couldn't find" the amount.
 * The item cells are aligned correctly, so each printed total can be VERIFIED:
 * a value that matches no sum in its own column but exactly matches the sum of
 * a nearby column belongs there; a value duplicating a neighbour that already
 * matches its own sum is an extraction artifact and is dropped.
 */
export function repairTotalRow(
  columns: string[],
  itemRows: string[][],
  totalRow: string[]
): string[] {
  const sums = columnSums(columns, itemRows);
  const group = (i: number) => (columns[i] ?? "").trim().split(/\s+/)[0];
  const repaired = [...totalRow.map((v) => String(v ?? "").trim())];

  for (let j = 0; j < columns.length; j++) {
    const v = numericCell(repaired[j]);
    if (v === null) continue; // "Total", empty — leave alone
    if (sums[j] !== null && eq3(v, sums[j]!)) continue; // correctly placed

    // Find where this value actually belongs: same column group or adjacent.
    for (let k = 0; k < columns.length; k++) {
      if (k === j || sums[k] === null || !eq3(v, sums[k]!)) continue;
      if (group(k) !== group(j) && Math.abs(k - j) > 2) continue;

      const atK = numericCell(repaired[k]);
      if (atK === null && !repaired[k]) {
        repaired[k] = repaired[j]; // relocate into the empty rightful column
        repaired[j] = "";
      } else if (atK !== null && eq3(atK, v)) {
        repaired[j] = ""; // duplicate of a value already in its right place
      }
      break;
    }
  }
  return repaired;
}

/** amt/amount/pcs/pieces/wt/weight columns — the only ones worth summing. */
function isQuantityColumn(column: string): boolean {
  return /(amt|amount|pcs|pieces|wt|weight)\s*(\(|$)/i.test(column.trim());
}

/**
 * Labelled column totals for a table, CORRECTED against the per-item sums.
 *
 * Vision misaligns the printed total line of a wide table: each amount total is
 * dropped one or two columns to the LEFT, into the neighbouring rate column
 * (observed live: labour's 49,493 landed under "Labour Rate" while 237,483 —
 * the grand total — sat under "Labour Amt", so "labour amount" answered the
 * wrong number). repairTotalRow only relocates into EMPTY columns, so it can't
 * fix this cascade where each amount's rightful column is occupied by the next
 * shifted value.
 *
 * The per-item cells ARE aligned, so a quantity column whose computed sum also
 * appears verbatim on the printed line is pinned to that column
 * ("corroboration": two independent signals agree on the number, and the sum
 * settles which column owns it). A different figure squatting in a corroborated
 * column is itself a left-shifted total and is pushed one place right, into the
 * next quantity column with no total of its own — so the grand total isn't
 * dropped on the floor.
 *
 * With no printed total line (the spreadsheet variant) the quantity columns are
 * summed directly, dropping a pieces column whose sum is not a whole number
 * (a fraction means some cells are misaligned).
 */
export function tableTotals(
  columns: string[],
  itemRows: string[][],
  totalRows: string[][],
  labels: string[]
): string[] {
  const sums = columnSums(columns, itemRows);

  if (totalRows.length === 0) {
    if (itemRows.length <= 1) return [];
    return columns
      .map((c, i) => [labels[i], sums[i], c] as const)
      .filter(([, s, c]) => s !== null && isQuantityColumn(c))
      .filter(([, s, c]) => !/pcs|pieces/i.test(c) || Number.isInteger(s as number))
      .map(([label, s]) => `Total ${label}: ${s}`);
  }

  const out: string[] = [];
  for (const totalRow of totalRows) {
    const repaired = repairTotalRow(columns, itemRows, totalRow);
    const printedVals = totalRow
      .map((v) => numericCell(v))
      .filter((n): n is number => n !== null);
    const printedHas = (x: number) => printedVals.some((p) => eq3(p, x));

    // Seed each column's total from the best-effort repaired printed row. Keyed
    // by COLUMN, not by the printed row's length: vision often prints a total
    // line with fewer cells than the table has columns (it drops empty ones), so
    // the rightmost columns would otherwise be `undefined` rather than an empty
    // slot a relocation can fill.
    const totals: (string | null)[] = columns.map((_, i) => {
      const s = String(repaired[i] ?? "").trim();
      return s === "" || /^total$/i.test(s) ? null : s;
    });

    // Pin corroborated quantity columns to their per-item sum, relocating any
    // squatter one column right first.
    const consumed: number[] = [];
    for (let i = 0; i < columns.length; i++) {
      const s = sums[i];
      if (s === null || !isQuantityColumn(columns[i])) continue;
      if (/pcs|pieces/i.test(columns[i]) && !Number.isInteger(s)) continue;
      if (!printedHas(s)) continue;

      const squatter = numericCell(totals[i] ?? "");
      if (squatter !== null && !eq3(squatter, s)) {
        for (let k = i + 1; k < columns.length; k++) {
          if (!isQuantityColumn(columns[k])) continue;
          if (sums[k] !== null && printedHas(sums[k]!)) continue; // k owns its own total
          if (totals[k] === null) {
            totals[k] = String(squatter);
            break;
          }
        }
      }
      totals[i] = String(s);
      consumed.push(s);
    }

    for (let i = 0; i < columns.length; i++) {
      const v = totals[i];
      if (v === null) continue;
      const n = numericCell(v);
      // A corroborated figure still duplicated under a wrong (rate/code) label
      // is the shift artifact — drop it so only the right label survives.
      if (n !== null && !isQuantityColumn(columns[i]) && consumed.some((c) => eq3(c, n)))
        continue;
      out.push(`Total ${labels[i] ?? `Column ${i + 1}`}: ${v}`);
    }
  }
  return out;
}

/** The single whole-table chunk (header + every row + the totals block). */
export function isWholeTableChunk(chunk: Chunk): boolean {
  return chunk.section.startsWith("table:") && chunk.content.includes("\nFull table");
}

/** A granular row-group chunk ("Rows a-b:") — redundant once a whole-table chunk exists. */
export function isRowGroupChunk(chunk: Chunk): boolean {
  return chunk.section.startsWith("table:") && /\nRows \d+-\d+:/.test(chunk.content);
}

function splitLongText(section: string, text: string): Chunk[] {
  const clean = text.trim();
  if (!clean) return [];
  if (clean.length <= MAX_CHARS) return [{ section, content: clean }];

  const chunks: Chunk[] = [];
  const lines = clean.split(/\r?\n/);
  let buf = "";

  for (const line of lines) {
    if (buf.length + line.length + 1 > MAX_CHARS && buf) {
      chunks.push({ section, content: buf.trim() });
      buf = "";
    }
    // A single line longer than the budget gets hard-split.
    if (line.length > MAX_CHARS) {
      for (let i = 0; i < line.length; i += MAX_CHARS) {
        chunks.push({ section, content: line.slice(i, i + MAX_CHARS) });
      }
      continue;
    }
    buf += (buf ? "\n" : "") + line;
  }
  if (buf.trim()) chunks.push({ section, content: buf.trim() });
  return chunks;
}

/**
 * Turns the extracted JSON into retrievable text units.
 *
 * Facts are grouped rather than embedded one-per-field: a lone "IFSC: SBIN0001"
 * vector matches almost nothing, while a labelled group of related facts
 * retrieves well for the way people actually ask over the phone.
 */
export function chunkDocument(doc: ExtractedDocument, fileName: string): Chunk[] {
  const chunks: Chunk[] = [];
  const header = `Document: ${doc.title || fileName} (${doc.document_type})`;

  chunks.push({
    section: "summary",
    content: `${header}\n\n${doc.summary}`,
  });

  // Table-first storage: the document IS its tables (line items, and any
  // labelled key/value block the extractor rendered as a "fields" table) plus
  // the verbatim full_text below. Everything table-shaped flows through the one
  // loop, so totals repair, whole-table and per-row chunks apply uniformly.
  for (const table of doc.tables) {
    const head = `${header}\nTable "${table.name}" — columns: ${table.columns.join(
      " | "
    )}`;

    const itemRows = table.rows.filter(
      (r) => !/total/i.test(String(r[0] ?? "").trim())
    );
    const totalRows = table.rows.filter((r) =>
      /total/i.test(String(r[0] ?? "").trim())
    );

    // Duplicate headers ("Pcs" appears for both the diamond and stone groups
    // in the spreadsheet) get an index, matching focusRow's labelling, so a
    // totals line never carries two identical "Total Pcs:" labels.
    const seen = new Map<string, number>();
    const labels = table.columns.map((c) => {
      const n = (seen.get(c) ?? 0) + 1;
      seen.set(c, n);
      return n === 1 ? c : `${c} (${n})`;
    });

    // Labelled column totals, corrected against the per-item sums (see
    // tableTotals). A detail/breakup table that prints no totals line is left
    // untotalled: its rows re-list the primary table's items, so summing them
    // would double-count.
    const isDetailTable = /detail|breakup|break-up|line/i.test(table.name);
    const totalsLines =
      totalRows.length > 0
        ? tableTotals(table.columns, itemRows, totalRows, labels)
        : !isDetailTable && itemRows.length > 1
          ? tableTotals(table.columns, itemRows, [], labels)
          : [];
    const totalsNote =
      totalRows.length > 0
        ? "verified against the per-item columns"
        : "computed by summing the item rows — the document prints no totals line";
    // Kept at the END of a chunk so focusTotals (which slices from the marker to
    // the end) captures the totals and not the rows above them.
    const totalsBlock = totalsLines.length
      ? `\n\nTOTALS for all ${itemRows.length} items (${totalsNote}):\n${totalsLines.join("\n")}`
      : "";

    const rendered = itemRows.map((r) => r.join(" | "));

    // ONE whole-table chunk: the entire table in a single retrievable unit,
    // header + every row + the verified totals. A total or whole-column
    // question ("labour amount kitna hai") then reads from a view where the
    // rows and totals line up under one header, instead of an 8-row fragment
    // that may not even be the fragment retrieval returned. The row-group
    // chunks below still give dense, per-row retrieval for "item N" questions.
    //
    // Guarded by size: a table too large to embed as one vector stays
    // split-only, with its totals kept in a standalone chunk so a total
    // question can still find them.
    if (rendered.length > 0) {
      const whole = `${head}\nFull table — all ${rendered.length} rows:\n${rendered.join(
        "\n"
      )}${totalsBlock}`;
      if (whole.length <= MAX_WHOLE_TABLE_CHARS) {
        chunks.push({ section: `table:${table.name}`, content: whole });
      } else if (totalsBlock) {
        chunks.push({ section: `table:${table.name}`, content: `${head}${totalsBlock}` });
      }
    }

    // Split tables by ROW, never by character, and repeat the header on every
    // chunk. Routing these through splitLongText looked like a tidy way to
    // enforce MAX_CHARS, but it cut a wide table mid-block: the first piece kept
    // the "columns:" line and the rest were bare pipe rows with nothing saying
    // what the columns meant. A 23-column jewellery row is unreadable that way —
    // retrieval returned the chunk holding item 5, and the agent still answered
    // "not in your documents" because it could not tell which number was the
    // amount. Rows are only useful next to their header, so the header is part
    // of the budget, not something to be split away from.
    let start = 0;
    while (start < rendered.length) {
      let end = start;
      let size = head.length;
      // Pack rows until the next one would overflow; always take at least one,
      // so a single very wide row still becomes its own labelled chunk.
      while (end < rendered.length) {
        const next = rendered[end].length + 1;
        if (end > start && size + next > MAX_CHARS) break;
        size += next;
        end++;
        // Keep the old 8-row grouping as a ceiling so one question still
        // retrieves its neighbouring rows for context.
        if (end - start >= 8) break;
      }
      chunks.push({
        section: `table:${table.name}`,
        content: `${head}\nRows ${start + 1}-${end}:\n${rendered
          .slice(start, end)
          .join("\n")}`,
      });
      start = end;
    }
  }

  chunks.push(...splitLongText("full_text", `${header}\n\n${doc.full_text}`));

  if (doc.confidence_notes.trim()) {
    chunks.push({
      section: "confidence_notes",
      content: `${header}\nParts of this document were unclear: ${doc.confidence_notes}`,
    });
  }

  return chunks.filter((c) => c.content.trim().length > 0);
}
