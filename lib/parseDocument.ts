import * as XLSX from "xlsx";
import mammoth from "mammoth";

/** MIME types (plus common fallbacks) that get converted to plain text before extraction, instead of going through vision. */
export const TEXT_CONVERTIBLE = new Set([
  "text/csv",
  "text/plain",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

const EXTENSION_MIME: Record<string, string> = {
  csv: "text/csv",
  txt: "text/plain",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

/** Browsers sometimes report an empty/generic type for these extensions — recover it from the file name. */
export function resolveMimeType(reported: string, fileName: string): string {
  if (reported && reported !== "application/octet-stream") return reported;
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_MIME[ext] ?? reported;
}

function sheetsToText(buffer: Buffer): string {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  return workbook.SheetNames.map((name) => {
    const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[name]);
    return `--- Sheet: ${name} ---\n${csv}`;
  }).join("\n\n");
}

/**
 * Converts a spreadsheet/doc/text file to plain text so it can go through
 * the same structured-extraction schema as scanned documents, just via a
 * text input instead of vision.
 */
export async function extractTextFromFile(buffer: Buffer, mimeType: string): Promise<string> {
  switch (mimeType) {
    case "text/csv":
    case "text/plain":
      return buffer.toString("utf-8");

    case "application/vnd.ms-excel":
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
      return sheetsToText(buffer);

    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
      const { value } = await mammoth.extractRawText({ buffer });
      return value;
    }

    case "application/msword":
      // Legacy binary .doc isn't supported by mammoth — surface a clear error
      // rather than silently returning garbage.
      throw new Error("Legacy .doc files aren't supported yet — please save as .docx and re-upload.");

    default:
      throw new Error(`No text extractor for ${mimeType}.`);
  }
}
