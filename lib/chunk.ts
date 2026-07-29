import type { ExtractedDocument } from "./supabase";

export type Chunk = { section: string; content: string };

const MAX_CHARS = 900;

/**
 * OCR renders identifiers as "1234 5678 9012"; full-text search tokenizes on
 * whitespace, so the grouped form never matches a spoken-then-transcribed
 * query. Appending the collapsed form makes exact-identifier lookup work.
 */
function normalizedIdentifier(value: string): string | null {
  const collapsed = value.replace(/[\s\-]/g, "");
  // Only worth it for identifier-shaped values that actually had separators.
  if (collapsed === value) return null;
  if (!/^[A-Za-z0-9]{6,}$/.test(collapsed)) return null;
  return collapsed;
}

function withNormalized(label: string, value: string): string {
  const norm = normalizedIdentifier(value);
  return norm ? `${label}: ${value} (${norm})` : `${label}: ${value}`;
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
    content: `${header}\nIssuer: ${doc.issuer ?? "unknown"}\n\n${doc.summary}`,
  });

  const holder = doc.account_holder;
  const holderLines = [
    holder.name && `Account holder name: ${holder.name}`,
    holder.address && `Address: ${holder.address}`,
    holder.date_of_birth && `Date of birth: ${holder.date_of_birth}`,
    holder.contact && `Contact: ${holder.contact}`,
    ...holder.identifiers.map((i) => withNormalized(i.label, i.value)),
  ].filter(Boolean);
  if (holderLines.length) {
    chunks.push({
      section: "account_holder",
      content: `${header}\nAccount holder details:\n${holderLines.join("\n")}`,
    });
  }

  const acc = doc.account;
  const accLines = [
    acc.number && withNormalized("Account number", acc.number),
    acc.type && `Account type: ${acc.type}`,
    acc.ifsc_or_routing && withNormalized("IFSC / routing code", acc.ifsc_or_routing),
    acc.branch && `Branch: ${acc.branch}`,
    acc.currency && `Currency: ${acc.currency}`,
    acc.opened_on && `Opened on: ${acc.opened_on}`,
    acc.status && `Status: ${acc.status}`,
    acc.balance && `Balance: ${acc.balance}`,
  ].filter(Boolean);
  if (accLines.length) {
    chunks.push({
      section: "account",
      content: `${header}\nAccount details:\n${accLines.join("\n")}`,
    });
  }

  if (doc.parties.length) {
    // splitLongText, not a bare push: a document with many parties produced one
    // oversized chunk whose embedding was too diluted to retrieve. (It returns
    // the single chunk unchanged when the text is already under budget.)
    chunks.push(
      ...splitLongText(
        "parties",
        `${header}\nPeople and companies on this document:\n${doc.parties
          .map((p) => `${p.role}: ${p.name}${p.details ? ` — ${p.details}` : ""}`)
          .join("\n")}`
      )
    );
  }

  const notes = [
    ...doc.remarks.map((r) => `Remark: ${r}`),
    ...doc.stamps_and_annotations.map((s) => `Stamp/annotation: ${s}`),
  ];
  if (notes.length) {
    chunks.push(
      ...splitLongText(
        "notes",
        `${header}\nRemarks, stamps and annotations:\n${notes.join("\n")}`
      )
    );
  }

  const misc = [
    ...doc.dates.map((d) => `${d.label}: ${d.value}`),
    ...doc.amounts.map((a) => `${a.label}: ${a.value}`),
    ...doc.fields.map((f) => withNormalized(f.label, f.value)),
  ];
  // 12 label/value pairs per chunk keeps each vector topically tight.
  for (let i = 0; i < misc.length; i += 12) {
    chunks.push(
      ...splitLongText(
        "fields",
        `${header}\nDetails from the document:\n${misc.slice(i, i + 12).join("\n")}`
      )
    );
  }

  for (const table of doc.tables) {
    const head = `${header}\nTable "${table.name}" — columns: ${table.columns.join(
      " | "
    )}`;
    // 8 rows per chunk so a single transaction question retrieves its neighbours.
    for (let i = 0; i < table.rows.length; i += 8) {
      const rows = table.rows
        .slice(i, i + 8)
        .map((r) => r.join(" | "))
        .join("\n");
      chunks.push(
        ...splitLongText(
          `table:${table.name}`,
          `${head}\nRows ${i + 1}-${i + Math.min(8, table.rows.length - i)}:\n${rows}`
        )
      );
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
