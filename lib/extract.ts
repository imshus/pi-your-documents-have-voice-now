import { openaiFetch, VISION_MODEL } from "./openai";
import type { ExtractedDocument } from "./supabase";

/**
 * JSON Schema handed to the model with strict structured outputs, so every
 * ingested file lands in the database with exactly the same shape.
 *
 * Strict mode rules: every property must be listed in `required`, and
 * "optional" is expressed as a nullable type rather than an absent key.
 */
const labelledValue = {
  type: "array",
  items: {
    type: "object",
    properties: {
      label: { type: "string" },
      value: { type: "string" },
    },
    required: ["label", "value"],
    additionalProperties: false,
  },
} as const;

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
        "3-5 sentences covering who it belongs to, what account/entity it concerns, the period it covers, and the headline numbers.",
    },
    issuer: {
      type: ["string", "null"],
      description: "Bank, institution or company that issued the document.",
    },
    account_holder: {
      type: "object",
      properties: {
        name: { type: ["string", "null"] },
        address: { type: ["string", "null"] },
        date_of_birth: { type: ["string", "null"] },
        contact: {
          type: ["string", "null"],
          description: "Phone and/or email, joined with a comma.",
        },
        identifiers: {
          ...labelledValue,
          description:
            "ID numbers found on the document, e.g. PAN, Aadhaar, customer ID, CIF.",
        },
      },
      required: ["name", "address", "date_of_birth", "contact", "identifiers"],
      additionalProperties: false,
    },
    account: {
      type: "object",
      properties: {
        number: { type: ["string", "null"] },
        type: { type: ["string", "null"], description: "savings, current, credit card, loan, ..." },
        ifsc_or_routing: { type: ["string", "null"] },
        branch: { type: ["string", "null"] },
        currency: { type: ["string", "null"] },
        opened_on: { type: ["string", "null"] },
        status: { type: ["string", "null"] },
        balance: { type: ["string", "null"], description: "Closing/available balance as printed." },
      },
      required: [
        "number",
        "type",
        "ifsc_or_routing",
        "branch",
        "currency",
        "opened_on",
        "status",
        "balance",
      ],
      additionalProperties: false,
    },
    parties: {
      type: "array",
      description:
        "Every person or company on the document with their role: issuer, customer, consignee, buyer, seller, witness, guarantor, broker.",
      items: {
        type: "object",
        properties: {
          role: { type: "string" },
          name: { type: "string" },
          details: {
            type: "string",
            description: "Address, phone, ID, GST or anything else printed next to them; empty string if nothing.",
          },
        },
        required: ["role", "name", "details"],
        additionalProperties: false,
      },
    },
    fields: {
      ...labelledValue,
      description:
        "Every other label/value pair visible on the document, in reading order.",
    },
    tables: {
      type: "array",
      description: "Any tabular data — transaction lists, line items, schedules.",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
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
    dates: { ...labelledValue, description: "Named dates, e.g. statement period, due date." },
    amounts: { ...labelledValue, description: "Named monetary amounts, with currency symbol." },
    remarks: {
      type: "array",
      items: { type: "string" },
      description: "Printed remarks, terms, conditions, declarations, footnotes — verbatim, one entry each.",
    },
    stamps_and_annotations: {
      type: "array",
      items: { type: "string" },
      description:
        "Stamps, seals, signatures (describe whose/where), and any handwritten additions with their text.",
    },
    full_text: {
      type: "string",
      description: "Complete verbatim transcription of all readable text, preserving line order.",
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
    "issuer",
    "account_holder",
    "account",
    "parties",
    "fields",
    "tables",
    "dates",
    "amounts",
    "remarks",
    "stamps_and_annotations",
    "full_text",
    "confidence_notes",
  ],
  additionalProperties: false,
} as const;

export const INSTRUCTIONS = `You read account and identity documents and transcribe them into structured JSON.

Transcribe exactly what is printed. Never invent, complete, correct or normalise a value that is not legible — if a digit is unclear, put what you can read and describe the uncertainty in confidence_notes. Keep numbers, dates and currency symbols in the document's own format.

Documents may be in English, Hindi, or mixed Hinglish, and may be photographed at an angle or handwritten. Transliterate Devanagari values into Latin script in the structured fields, but keep the original script in full_text.

If a field genuinely does not appear on the document, use null (or an empty array) rather than a placeholder.

Completeness contract — capture EVERYTHING on the page:
- Every label/value pair, however minor (page numbers, reference codes, file numbers, headers, footers).
- Every table cell verbatim. Never summarize, merge, or truncate rows — a 40-row table produces 40 rows.
- Every person/company anywhere on the document goes in parties with their role.
- Stamps, seals, signature blocks, and handwritten additions go in stamps_and_annotations.
- Printed terms, conditions, declarations, and notes go verbatim in remarks.
- A detail that fits no other field still goes in fields. full_text must contain every readable character on the page.`;

export type SupportedInput = {
  fileName: string;
  mimeType: string;
  /** Raw file bytes as base64 (no data: prefix). */
  base64: string;
};

/**
 * Sends one file to the OpenAI vision model and returns the structured
 * payload. PDFs go through as input_file; images as input_image.
 */
export async function extractDocument(
  input: SupportedInput
): Promise<ExtractedDocument> {
  const dataUrl = `data:${input.mimeType};base64,${input.base64}`;

  const filePart =
    input.mimeType === "application/pdf"
      ? { type: "input_file", filename: input.fileName, file_data: dataUrl }
      : // "original" skips downsampling — on gpt-5.5/5.6 "auto" already behaves
        // like this, but pinning it keeps 5.4-tier models honest if swapped in.
        { type: "input_image", image_url: dataUrl, detail: "original" };

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
      // Low effort, high verbosity is the documented sweet spot for verbatim
      // transcription: higher reasoning does not improve parsing and has been
      // measured to hallucinate characters, split tables, and fill blank cells
      // with invented values. Verbosity high pushes toward literal rendering.
      reasoning: { effort: "low" },
      text: {
        verbosity: "high",
        format: {
          type: "json_schema",
          name: "account_document",
          strict: true,
          schema: DOCUMENT_SCHEMA,
        },
      },
    }),
  });

  const json = (await res.json()) as {
    output_text?: string;
    output?: { type: string; content?: { type: string; text?: string }[] }[];
  };

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
