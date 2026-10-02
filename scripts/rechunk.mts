/**
 * Re-chunks and re-embeds already-ingested documents, WITHOUT re-reading them.
 *
 * When lib/chunk.ts changes, every document indexed before the change keeps its
 * old chunks — the code is fixed but the stored data is not, so the agent keeps
 * failing in the old way. Re-uploading would fix it, but that re-runs the vision
 * extraction, which is the slowest and most expensive step in the pipeline.
 *
 * The extraction result is already in `documents.data`, so this rebuilds chunks
 * from that and only pays for embeddings.
 *
 *   npm run rechunk                              # all documents
 *   npm run rechunk -- "Packing List-1.pdf"      # one document
 *
 * Costs embedding credits (a few thousand tokens per document). Nothing else.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { chunkDocument } from "../lib/chunk.ts";

function loadEnv() {
  const env: Record<string, string> = {};
  for (const file of [".env.local", ".env"]) {
    let raw: string;
    try {
      raw = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      if (line.trim().startsWith("#")) continue;
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in env)) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  return env;
}

const env = loadEnv();
for (const required of ["OPENAI_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
  if (!env[required]) {
    console.error(`Missing ${required} in .env / .env.local`);
    process.exit(1);
  }
}

const only = process.argv[2] ?? null;
const OPENAI_BASE = env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
const EMBEDDING_MODEL = env.OPENAI_EMBEDDING_MODEL;
if (!EMBEDDING_MODEL) {
  console.error(
    "Missing OPENAI_EMBEDDING_MODEL. It must match the model the corpus was embedded with."
  );
  process.exit(1);
}

const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/** Same batching as lib/openai.ts; kept local so this needs no server imports. */
async function embed(texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 96) {
    const res = await fetch(`${OPENAI_BASE}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: texts.slice(i, i + 96),
        dimensions: 1536,
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`embed ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
    for (const item of json.data.sort((a, b) => a.index - b.index)) out.push(item.embedding);
  }
  return out;
}

const { data: docs, error } = await sb
  .from("documents")
  .select("id, file_name, data")
  .order("created_at");
if (error) {
  console.error(error.message);
  process.exit(1);
}

const targets = (docs ?? []).filter((d) => !only || d.file_name === only);
if (targets.length === 0) {
  console.error(
    `No document matched "${only}". Indexed:\n` +
      (docs ?? []).map((d) => `  ${d.file_name}`).join("\n")
  );
  process.exit(1);
}

console.log(`\nre-chunking ${targets.length} document(s) with the current chunker\n`);

let failed = 0;
for (const doc of targets) {
  const t0 = Date.now();
  try {
    if (!doc.data) throw new Error("no stored extraction (`data` is null) — re-upload this one");

    const chunks = chunkDocument(doc.data, doc.file_name);
    const vectors = await embed(chunks.map((c) => c.content));

    // Replace atomically enough for a maintenance script: delete then insert.
    // A failure between the two leaves the document unsearchable, which the
    // final count below makes obvious rather than silent.
    const del = await sb.from("doc_chunks").delete().eq("document_id", doc.id);
    if (del.error) throw new Error(`delete failed: ${del.error.message}`);

    const ins = await sb.from("doc_chunks").insert(
      chunks.map((c, i) => ({
        document_id: doc.id,
        chunk_index: i,
        section: c.section,
        content: c.content,
        embedding: vectors[i],
      }))
    );
    if (ins.error) throw new Error(`insert failed: ${ins.error.message}`);

    const tables = chunks.filter((c) => c.section.startsWith("table:"));
    const headerless = tables.filter((c) => !c.content.includes("columns:")).length;
    console.log(
      `  ok   ${doc.file_name} — ${chunks.length} chunks (${tables.length} table, ${headerless} headerless) in ${Date.now() - t0}ms`
    );
    if (headerless > 0) {
      console.log(`       WARNING: ${headerless} table chunk(s) still lack a column header.`);
    }
  } catch (err) {
    failed++;
    console.log(`  FAIL ${doc.file_name} — ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log(`\n${targets.length - failed}/${targets.length} re-chunked\n`);
process.exit(failed === 0 ? 0 : 1);
