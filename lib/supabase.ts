import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { fetch as undiciFetch, Agent } from "undici";

export const DOCUMENTS_BUCKET = "documents";

/**
 * supabase-js calls the GLOBAL fetch, whose undici dispatcher defaults to a
 * 4s keepAliveTimeout — and *.supabase.co sends `Connection: keep-alive` with
 * no `Keep-Alive: timeout=` hint, so undici applies that 4s default. Every
 * inter-turn gap on a phone call is longer than 4s, so retrieval was paying a
 * fresh TCP+TLS handshake EVERY caller turn, on the leg that sits directly in
 * the voice latency path. OpenAI, DeepSeek and Sarvam already had their own
 * long-lived agents; Supabase was the one that was missed.
 */
const supabaseAgent = new Agent({
  keepAliveTimeout: 120_000,
  keepAliveMaxTimeout: 600_000,
  allowH2: true,
});

let cached: SupabaseClient | null = null;

/**
 * Server-only client. Uses the service-role key, so it bypasses RLS — never
 * import this from a "use client" file.
 */
export function supabaseAdmin(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Copy .env.example to .env.local and fill it in."
    );
  }

  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    // Route every PostgREST/storage call through the warm pool above instead of
    // Node's global fetch. (Cast: undici's fetch signature is structurally
    // compatible but not nominally identical to the DOM one supabase-js wants.)
    global: {
      fetch: ((input: unknown, init?: Record<string, unknown>) =>
        undiciFetch(input as never, {
          ...(init ?? {}),
          dispatcher: supabaseAgent,
        } as never)) as unknown as typeof fetch,
    },
  });
  return cached;
}

export type DocumentRow = {
  id: string;
  created_at: string;
  file_name: string;
  mime_type: string | null;
  storage_path: string | null;
  doc_type: string | null;
  title: string | null;
  summary: string | null;
  data: ExtractedDocument;
};

export type MatchedChunk = {
  id: number;
  document_id: string;
  section: string | null;
  content: string;
  file_name: string;
  doc_type: string | null;
  similarity: number;
};

/** Shape produced by lib/extract.ts — kept here so both client and server can import it. */
/**
 * Table-first extraction. The document is stored as its TABLE(S) plus a
 * verbatim full_text and a short summary — nothing else. The old rich schema
 * (account_holder, parties, fields, dates, amounts, …) gave the vision model a
 * dozen fuzzy buckets to sort values into, and it lost data doing so (it
 * dropped a diamond's second clarity code out of a table cell). Tables are the
 * one thing these documents ARE, so extraction transcribes them faithfully;
 * anything not in a table still lives verbatim in full_text and is retrievable.
 */
export type ExtractedDocument = {
  document_type: string;
  title: string;
  summary: string;
  tables: { name: string; columns: string[]; rows: string[][] }[];
  full_text: string;
  confidence_notes: string;
};
