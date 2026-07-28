import { createClient, SupabaseClient } from "@supabase/supabase-js";

export const DOCUMENTS_BUCKET = "documents";

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
export type ExtractedDocument = {
  document_type: string;
  title: string;
  summary: string;
  issuer: string | null;
  account_holder: {
    name: string | null;
    address: string | null;
    date_of_birth: string | null;
    contact: string | null;
    identifiers: { label: string; value: string }[];
  };
  account: {
    number: string | null;
    type: string | null;
    ifsc_or_routing: string | null;
    branch: string | null;
    currency: string | null;
    opened_on: string | null;
    status: string | null;
    balance: string | null;
  };
  parties: { role: string; name: string; details: string }[];
  fields: { label: string; value: string }[];
  tables: { name: string; columns: string[]; rows: string[][] }[];
  dates: { label: string; value: string }[];
  amounts: { label: string; value: string }[];
  remarks: string[];
  stamps_and_annotations: string[];
  full_text: string;
  confidence_notes: string;
};
