import { NextRequest, NextResponse } from "next/server";
import { extractDocument } from "@/lib/extract";
import { chunkDocument } from "@/lib/chunk";
import { embed } from "@/lib/openai";
import { supabaseAdmin, DOCUMENTS_BUCKET } from "@/lib/supabase";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Deterministic completeness audit: every number the model transcribed in
 * full_text should also appear somewhere in the structured sections. Numbers
 * that don't are still retrievable via the full_text chunks, but the mismatch
 * is surfaced so a sloppy extraction is visible instead of silent.
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

const ACCEPTED = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);

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

  let db;
  try {
    db = supabaseAdmin();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }

  const results: unknown[] = [];

  for (const file of files) {
    try {
      const mimeType = file.type || "application/octet-stream";
      if (!ACCEPTED.has(mimeType)) {
        results.push({
          file_name: file.name,
          ok: false,
          error: `Unsupported type ${mimeType}. Upload a PDF or an image.`,
        });
        continue;
      }

      const bytes = Buffer.from(await file.arrayBuffer());

      // --- read the document ------------------------------------------------
      const data = await extractDocument({
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
      const { data: row, error: insertError } = await db
        .from("documents")
        .insert({
          file_name: file.name,
          mime_type: mimeType,
          storage_path: upload.error ? null : storagePath,
          doc_type: data.document_type,
          title: data.title,
          summary: data.summary,
          data,
        })
        .select("id")
        .single();

      if (insertError || !row) {
        throw new Error(`Insert failed: ${insertError?.message ?? "no row returned"}`);
      }

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
        // Leave no half-indexed document behind.
        await db.from("documents").delete().eq("id", row.id);
        throw new Error(`Chunk insert failed: ${chunkError.message}`);
      }

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
      results.push({
        file_name: file.name,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const failed = results.filter((r) => !(r as { ok: boolean }).ok).length;
  return NextResponse.json(
    { results, ingested: results.length - failed, failed },
    { status: failed === results.length ? 502 : 200 }
  );
}
