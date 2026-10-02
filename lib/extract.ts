import { openaiFetch, VISION_MODEL } from "./openai";
import type { ExtractedDocument } from "./supabase";

/**
 * JSON Schema handed to the model with strict structured outputs, so every
 * ingested file lands in the database with exactly the same shape.
 *
 * TABLE-FIRST: the document is stored as its table(s) plus a verbatim full_text
 * and a short summary — see the ExtractedDocument type in lib/supabase.ts for
 * why the old dozen-bucket schema was dropped.
 *
 * Strict mode rules: every property must be listed in `required`, and
 * "optional" is expressed as a nullable type rather than an absent key.
 */
export const DOCUMENT_SCHEMA = {
  type: "object",
  properties: {
    document_type: {
      type: "string",
      description:
        "snake_case category, e.g. bank_statement, cheque, aadhaar_card, pan_card, passbook, invoice, kyc_form, salary_slip, unknown",
    },
    title: { type: "string", description: "Short human title for this document." },
    summary: {
      type: "string",
      description:
        "3-5 sentences covering who/what the document concerns, the period it covers, and the headline numbers.",
    },
    tables: {
      type: "array",
      description:
        "Every table on the page — line items, transaction lists, schedules, and ALSO any labelled key/value block rendered as rows (issuer, account details, dates). If the page has no grid at all, use one table named \"fields\" with columns [\"Label\",\"Value\"] and one row per label/value pair. Do NOT leave data out because it is not in an obvious grid.",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "What this table holds, e.g. \"Packing list items\", \"Account details\", \"fields\"." },
          columns: { type: "array", items: { type: "string" } },
          rows: {
            type: "array",
            items: { type: "array", items: { type: "string" } },
          },
        },
        required: ["name", "columns", "rows"],
        additionalProperties: false,
      },
    },
    full_text: {
      type: "string",
      description: "Complete verbatim transcription of ALL readable text on the page, preserving line order. This is the safety net: anything not captured in a table must still appear here.",
    },
    confidence_notes: {
      type: "string",
      description:
        "Anything unreadable, ambiguous, cut off, or guessed. Empty string if the document was fully legible.",
    },
  },
  required: [
    "document_type",
    "title",
    "summary",
    "tables",
    "full_text",
    "confidence_notes",
  ],
  additionalProperties: false,
} as const;

export const INSTRUCTIONS = `You read documents and transcribe them into a TABLE-FIRST structured form: the document's table(s) plus a complete verbatim full_text and a short summary. There are no other fields to fill — do not invent extra structure.

Transcribe exactly what is printed. Never invent, complete, correct or normalise a value that is not legible — if a digit is unclear, put what you can read and describe the uncertainty in confidence_notes. Keep numbers, dates and currency symbols in the document's own format.

Documents may be in English, Hindi, or mixed Hinglish, and may be photographed at an angle or handwritten. Inside tables, transliterate Devanagari values into Latin script; keep the original script in full_text.

TABLES — the priority. Capture EVERY table completely:
- Every row, every column, every cell VERBATIM. Never summarize, merge, or truncate — a 40-row table produces 40 rows.
- Keep the WHOLE cell. A cell holding more than one value ("RDVSSI / MQGHV SSI", "RUB, EM", "22000 / 17684") keeps BOTH parts exactly as printed — never drop an alternative, a slash-separated second code, or a "/ various sizes" note. Dropping half a cell loses data that appears nowhere else.
- Keep the printed TOTALS row of a table as a row (first cell "Total").
- Labelled key/value information that is not in a grid (issuer, account number, IFSC, dates, named amounts, party names) still goes into a table: emit a table named "fields" with columns ["Label","Value"], one row per pair. Nothing labelled on the page should be left out.

full_text is the safety net: it must contain every readable character on the page, so anything a table missed is still there.`;

export type SupportedInput =
  | {
      fileName: string;
      mimeType: string;
      /** Raw file bytes as base64 (no data: prefix). */
      base64: string;
    }
  | {
      fileName: string;
      mimeType: string;
      /** Already-converted plain text (spreadsheets, docx, csv, txt). */
      text: string;
    };

/**
 * Sends one file to the OpenAI model and returns the structured payload.
 * PDFs go through as input_file, images as input_image — both via vision.
 * Spreadsheets/docx/csv/txt are pre-converted to plain text upstream and go
 * through as input_text instead; same schema either way.
 */
/**
 * Image fidelity. `original` = no resize / no patch-budget cap — OpenAI's
 * documented setting for OCR. On gpt-5.4 `auto` resolves to `high` (a resize),
 * NOT original, so it MUST be set explicitly or small text silently degrades.
 */
const IMAGE_DETAIL = process.env.OPENAI_VISION_IMAGE_DETAIL ?? "original";
/**
 * A PDF sent as input_file cannot reach `original` (that path caps at `high`),
 * and — the silent leak — on gpt-5.4-mini the DEFAULT `auto` resolves to `low`
 * (~512px page images), so dense tables were being read at low resolution.
 * Pinning `high` is the biggest confirmed accuracy win for scanned tables. For
 * maximum fidelity, render PDF pages to PNGs and feed them as images instead.
 */
const PDF_DETAIL = process.env.OPENAI_VISION_PDF_DETAIL ?? "high";
/**
 * Reasoning effort. `low` is fine for literal transcription (that's a verbosity
 * job, per OpenAI's doc guidance). Raise it only when cells need disambiguation
 * — a multi-value "RDVSSI / MQGHV SSI" cell is exactly that case — but there is
 * no published benchmark that higher effort helps or hurts OCR, so it is a knob
 * to A/B, not a blind change.
 */
const VISION_EFFORT = process.env.OPENAI_VISION_EFFORT ?? "low";
/** Dense tables produce large JSON; too small a cap truncates it mid-structure. */
const MAX_OUTPUT_TOKENS = Number(process.env.OPENAI_VISION_MAX_TOKENS ?? 32000);

export async function extractDocument(
  input: SupportedInput
): Promise<ExtractedDocument> {
  const filePart =
    "text" in input
      ? { type: "input_text" as const, text: input.text }
      : input.mimeType === "application/pdf"
        ? {
            type: "input_file" as const,
            filename: input.fileName,
            file_data: `data:${input.mimeType};base64,${input.base64}`,
            detail: PDF_DETAIL,
          }
        : { type: "input_image" as const, image_url: `data:${input.mimeType};base64,${input.base64}`, detail: IMAGE_DETAIL };

  const res = await openaiFetch("/responses", {
    method: "POST",
    body: JSON.stringify({
      model: VISION_MODEL,
      instructions: INSTRUCTIONS,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Read this document (${input.fileName}) and fill in the schema.`,
            },
            filePart,
          ],
        },
      ],
      reasoning: { effort: VISION_EFFORT },
      // Verbosity high is OpenAI's documented lever for literal transcription.
      text: {
        verbosity: "high",
        format: {
          type: "json_schema",
          name: "account_document",
          strict: true,
          schema: DOCUMENT_SCHEMA,
        },
      },
      max_output_tokens: MAX_OUTPUT_TOKENS,
    }),
  });

  const json = (await res.json()) as {
    output_text?: string;
    status?: string;
    incomplete_details?: { reason?: string };
    output?: { type: string; content?: { type: string; text?: string }[] }[];
  };

  // A dense table can hit the output cap. Fail LOUD — a truncated response is a
  // half-parsed JSON that would otherwise throw an opaque SyntaxError, or worse
  // parse into a document silently missing its last rows.
  if (json.status === "incomplete") {
    throw new Error(
      `Vision extraction was truncated (${json.incomplete_details?.reason ?? "incomplete"}) — raise OPENAI_VISION_MAX_TOKENS above ${MAX_OUTPUT_TOKENS}.`
    );
  }

  const text =
    json.output_text ??
    json.output
      ?.flatMap((item) => item.content ?? [])
      .find((c) => c.type === "output_text")?.text;

  if (!text) {
    throw new Error("Vision model returned no text output.");
  }

  return JSON.parse(text) as ExtractedDocument;
}
