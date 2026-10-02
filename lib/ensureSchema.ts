import { readFileSync } from "node:fs";
import { join } from "node:path";
import { supabaseAdmin, DOCUMENTS_BUCKET } from "./supabase";

/**
 * The RAG store (documents + doc_chunks + match_chunks) is defined in
 * supabase/schema.sql. On a fresh or wiped Supabase project those tables don't
 * exist, and every insert fails with PGRST205:
 *   "Could not find the table 'public.documents' in the schema cache".
 *
 * Rather than make the operator run that SQL by hand before the first upload,
 * ensureSchema() provisions it automatically from the SAME file, using the
 * Supabase Management API (a personal access token, SUPABASE_ACCESS_TOKEN).
 *
 * Memoized per process: one cheap probe on the first upload, then free.
 * schema.sql is idempotent (create table if not exists / create or replace), so
 * re-running it is harmless.
 */

let provisioned = false;

/** PGRST205 / stale-cache "table not found" — the error ensureSchema repairs. */
export function isMissingTableError(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  const msg = e?.message ?? (err instanceof Error ? err.message : String(err ?? ""));
  return (
    e?.code === "PGRST205" ||
    /schema cache/i.test(msg) ||
    /could not find the table/i.test(msg)
  );
}

function projectRef(): string {
  const url = process.env.SUPABASE_URL ?? "";
  const m = url.match(/^https:\/\/([a-z0-9]+)\.supabase\.co/i);
  if (!m) {
    throw new Error(`Cannot derive the Supabase project ref from SUPABASE_URL ("${url}").`);
  }
  return m[1];
}

/** Run arbitrary SQL through the Management API (the only server-side path that
 * can issue DDL — the service-role key goes through PostgREST, which cannot). */
async function runSql(sql: string): Promise<void> {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) {
    throw new Error(
      "The 'documents' table is missing and SUPABASE_ACCESS_TOKEN is not set, so it cannot be " +
        "created automatically. Add a personal access token (sbp_...) to .env, or run " +
        "supabase/schema.sql once in the Supabase SQL editor."
    );
  }
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef()}/database/query`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: sql }),
    }
  );
  if (!res.ok) {
    throw new Error(
      `Schema provisioning failed (${res.status}): ${(await res.text()).slice(0, 400)}`
    );
  }
}

/** Private bucket for the original files. Best-effort — storage upload already
 * degrades gracefully in the ingest route, but create it from the first run. */
async function ensureBucket(): Promise<void> {
  const { error } = await supabaseAdmin().storage.createBucket(DOCUMENTS_BUCKET, {
    public: false,
  });
  if (error && !/exist/i.test(error.message)) {
    console.warn(`[ensureSchema] could not create storage bucket: ${error.message}`);
  }
}

/**
 * Ensure the RAG tables exist, creating them from supabase/schema.sql if they
 * don't. Call before the first insert of an ingest request. Pass force=true to
 * re-check after a mid-request PGRST205 (e.g. the table was dropped underneath).
 */
export async function ensureSchema(force = false): Promise<void> {
  if (provisioned && !force) return;

  const { error } = await supabaseAdmin().from("documents").select("id").limit(1);
  if (!error) {
    provisioned = true;
    return;
  }
  if (!isMissingTableError(error)) {
    // A different failure (auth, network). Not something schema creation fixes —
    // leave it for the caller's own insert to surface rather than masking it.
    return;
  }

  const schemaPath = join(process.cwd(), "supabase", "schema.sql");
  let sql: string;
  try {
    sql = readFileSync(schemaPath, "utf8");
  } catch {
    throw new Error(`Could not read the schema file at ${schemaPath} to auto-create the tables.`);
  }

  await runSql(sql);
  // PostgREST caches the schema; nudge it so the new tables are visible at once.
  await runSql("notify pgrst, 'reload schema';");
  await ensureBucket();
  provisioned = true;
  console.log("[ensureSchema] provisioned public.documents / doc_chunks / match_chunks");
}
