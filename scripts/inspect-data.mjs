// Dumps what the agent actually has: the extracted JSON per document + its
// indexed chunks. Read-only. Usage: node scripts/inspect-data.mjs
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

function loadEnv() {
  const env = {};
  for (const file of [".env.local", ".env"]) {
    let raw;
    try { raw = readFileSync(new URL(`../${file}`, import.meta.url), "utf8"); }
    catch { continue; }
    for (const line of raw.split(/\r?\n/)) {
      if (line.trim().startsWith("#")) continue;
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      if (!(m[1] in env)) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return env;
}

const env = loadEnv();
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { data: docs, error } = await sb
  .from("documents")
  .select("id, file_name, doc_type, title, summary, data")
  .order("created_at", { ascending: false });
if (error) { console.error("documents error:", error.message); process.exit(1); }

console.log(`=== ${docs.length} document(s) ===\n`);
for (const d of docs) {
  console.log(`FILE: ${d.file_name}  [${d.doc_type}]`);
  console.log(`TITLE: ${d.title}`);
  console.log(`SUMMARY: ${d.summary}`);
  const x = d.data ?? {};
  console.log(`ACCOUNT:`, JSON.stringify(x.account ?? null));
  console.log(`ACCOUNT_HOLDER:`, JSON.stringify(x.account_holder ?? null));
  console.log(`AMOUNTS:`, JSON.stringify(x.amounts ?? null));
  console.log(`FIELDS:`, JSON.stringify(x.fields ?? null));
  console.log(`DATES:`, JSON.stringify(x.dates ?? null));
  console.log(`TABLES:`, JSON.stringify(x.tables ?? null));
  console.log(`CONFIDENCE_NOTES: ${x.confidence_notes ?? ""}`);
  console.log(`FULL_TEXT (first 600): ${(x.full_text ?? "").slice(0, 600)}`);

  const { data: chunks } = await sb
    .from("doc_chunks")
    .select("id, chunk_index, section, content")
    .eq("document_id", d.id)
    .order("chunk_index", { ascending: true });
  console.log(`\n  --- ${chunks?.length ?? 0} chunks ---`);
  for (const c of chunks ?? []) {
    console.log(`  [${c.chunk_index}] (${c.section}) ${c.content.slice(0, 220).replace(/\s+/g, " ")}`);
  }
  console.log("\n" + "=".repeat(70) + "\n");
}
