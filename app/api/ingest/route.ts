import { NextRequest, NextResponse } from "next/server";
import { extractDocument } from "@/lib/extract";
import { chunkDocument } from "@/lib/chunk";
import { embed } from "@/lib/openai";
import { supabaseAdmin, DOCUMENTS_BUCKET } from "@/lib/supabase";
import { ensureSchema, isMissingTableError } from "@/lib/ensureSchema";
import { invalidateCorpus } from "@/lib/corpus";
import { TEXT_CONVERTIBLE, extractTextFromFile, resolveMimeType } from "@/lib/parseDocument";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Deterministic completeness audit: every number the model transcribed in
 * full_text should also appear in the TABLES. Numbers that don't are still
 * retrievable via the full_text chunks, but the gap is surfaced so a table that
 * silently dropped a cell (the MQGHV-clarity loss) is visible at ingest time
 * instead of only when a caller asks and gets a wrong count.
 */
function coverageAudit(data: Record<string, unknown>): string | null {
  const { full_text, confidence_notes, summary, ...structured } = data as {
    full_text: string;
    [k: string]: unknown;
  };
  const structuredBlob = JSON.stringify(structured).replace(/[\s,]/g, "");

  const numbers = [...new Set(full_text.match(/\d[\d,.\-/]*\d|\d{2,}/g) ?? [])];
  const missing = numbers.filter(
    (n) => !structuredBlob.includes(n.replace(/[\s,]/g, ""))
  );

  if (missing.length === 0) return null;
  return `${missing.length}/${numbers.length} numbers appear only in full_text (still searchable, but not structured): ${missing
    .slice(0, 10)
    .join(", ")}${missing.length > 10 ? ", …" : ""}`;
}

const VISION_ACCEPTED = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);

const ACCEPTED = new Set([...VISION_ACCEPTED, ...TEXT_CONVERTIBLE]);

/**
 * Each file is held in memory several times over (Buffer + base64 + the JSON
 * payload), so an unbounded upload is an OOM, not just a slow request.
 */
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES ?? 20_000_000);
const MAX_FILES_PER_REQUEST = 10;

/**
 * Step 2 + 3 of the pipeline:
 *   file -> vision extraction -> JSON -> documents row -> chunks -> embeddings.
 * Accepts one or more files under the `files` field of a multipart form.
 */
export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data." }, { status: 400 });
  }

  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return NextResponse.json({ error: "No files uploaded." }, { status: 400 });
  }
  if (files.length > MAX_FILES_PER_REQUEST) {
    return NextResponse.json(
      { error: `Too many files (max ${MAX_FILES_PER_REQUEST} per upload).` },
      { status: 400 }
    );
  }

  let db;
  try {
    db = supabaseAdmin();
    // Auto-create the RAG tables on first upload to a fresh/wiped project, so a
    // folder drop never fails with "Could not find the table 'public.documents'".
    await ensureSchema();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }

  const results: unknown[] = [];

  for (const file of files) {
    // Tracked so a failure AFTER the row exists (embedding, chunk insert) can
    // roll it back — a chunk-less document row is invisible to retrieval but
    // still lists in the UI and still holds the extracted PII.
    let createdId: string | null = null;
    let storedPath: string | null = null;
    try {
      const mimeType = resolveMimeType(file.type, file.name);
      if (file.size > MAX_UPLOAD_BYTES) {
        results.push({
          file_name: file.name,
          ok: false,
          error: `File too large (${(file.size / 1e6).toFixed(1)} MB, limit ${MAX_UPLOAD_BYTES / 1e6} MB).`,
        });
        continue;
      }
      if (!ACCEPTED.has(mimeType)) {
        results.push({
          file_name: file.name,
          ok: false,
          error: `Unsupported type ${mimeType || "unknown"}. Upload a PDF, image, spreadsheet, or document.`,
        });
        continue;
      }

      const bytes = Buffer.from(await file.arrayBuffer());

      // --- read the document --------------------------------------------------
      // Spreadsheets/docx/csv/txt are converted to plain text first; PDFs and
      // images go straight through vision. Same extraction schema either way.
      const data = TEXT_CONVERTIBLE.has(mimeType)
        ? await extractDocument({
            fileName: file.name,
            mimeType,
            text: await extractTextFromFile(bytes, mimeType),
          })
        : await extractDocument({
            fileName: file.name,
            mimeType,
            base64: bytes.toString("base64"),
          });

      // --- keep the original alongside the JSON (best-effort) ---------------
      const storagePath = `${Date.now()}-${file.name.replace(/[^\w.\-]+/g, "_")}`;
      const upload = await db.storage
        .from(DOCUMENTS_BUCKET)
        .upload(storagePath, bytes, { contentType: mimeType, upsert: false });

      // --- documents row ----------------------------------------------------
      const insertRow = {
        file_name: file.name,
        mime_type: mimeType,
        storage_path: upload.error ? null : storagePath,
        doc_type: data.document_type,
        title: data.title,
        summary: data.summary,
        data,
      };
      let { data: row, error: insertError } = await db
        .from("documents")
        .insert(insertRow)
        .select("id")
        .single();
      // The tables can vanish under a long-running process (a project reset mid
      // upload). If the insert hits PGRST205, re-provision once and retry before
      // giving up on this file.
      if (insertError && isMissingTableError(insertError)) {
        await ensureSchema(true);
        ({ data: row, error: insertError } = await db
          .from("documents")
          .insert(insertRow)
          .select("id")
          .single());
      }

      if (insertError || !row) {
        throw new Error(`Insert failed: ${insertError?.message ?? "no row returned"}`);
      }
      createdId = row.id;
      if (!upload.error) storedPath = storagePath;

      // --- chunk + embed ----------------------------------------------------
      const chunks = chunkDocument(data, file.name);
      const vectors = await embed(chunks.map((c) => c.content));

      const { error: chunkError } = await db.from("doc_chunks").insert(
        chunks.map((c, i) => ({
          document_id: row.id,
          chunk_index: i,
          section: c.section,
          content: c.content,
          embedding: vectors[i],
        }))
      );
      if (chunkError) {
        throw new Error(`Chunk insert failed: ${chunkError.message}`);
      }
      createdId = null; // fully indexed — nothing to roll back
      storedPath = null;

      results.push({
        file_name: file.name,
        ok: true,
        document_id: row.id,
        chunks: chunks.length,
        storage_warning: upload.error
          ? `Original not stored: ${upload.error.message}`
          : null,
        coverage_warning: coverageAudit(data as unknown as Record<string, unknown>),
        data,
      });
    } catch (err) {
      // Surface the real cause in the server log — the per-file error otherwise
      // only reaches the client JSON, so a 502 in the dev terminal is opaque.
      console.error(
        `[ingest] failed: ${file.name} —`,
        err instanceof Error ? (err.stack ?? err.message) : err
      );
      // Roll back whatever this file already created, so a failed ingest never
      // leaves an unsearchable row or an orphaned original in the bucket.
      if (createdId) {
        const { error } = await db.from("documents").delete().eq("id", createdId);
        if (error) console.error("[ingest] rollback failed", createdId, error.message);
      }
      if (storedPath) {
        await db.storage.from(DOCUMENTS_BUCKET).remove([storedPath]);
      }
      results.push({
        file_name: file.name,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // A new document changes the corpus prefix — drop the memo so the next call
  // rebuilds it (and deliberately re-seeds the provider cache once).
  invalidateCorpus();

  const failed = results.filter((r) => !(r as { ok: boolean }).ok).length;
  return NextResponse.json(
    { results, ingested: results.length - failed, failed },
    { status: failed === results.length ? 502 : 200 }
  );
}
