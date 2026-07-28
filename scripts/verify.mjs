/**
 * End-to-end smoke test. Run it yourself — it spends OpenAI credits.
 *
 *   npm run dev          (in one terminal)
 *   npm run verify -- ./path/to/statement.pdf
 *
 * Checks, in order: env vars -> Supabase schema -> ingest -> retrieval ->
 * realtime session minting.
 */
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

const BASE = process.env.APP_URL ?? "http://localhost:3300";
const file = process.argv[2];

const MIME = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const bad = (m) => {
  failures++;
  console.log(`  FAIL ${m}`);
};

console.log(`\nVerifying ${BASE}\n`);

// ---------------------------------------------------------------- 1. env ---
console.log("1. Environment");
for (const key of [
  "OPENAI_API_KEY",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "DEEPGRAM_API_KEY",
  "SARVAM_API_KEY",
]) {
  process.env[key] ? ok(key) : bad(`${key} is not set in this shell (the app reads .env.local)`);
}

// ------------------------------------------------------- 2. db reachable ---
console.log("\n2. Supabase tables");
try {
  const res = await fetch(`${BASE}/api/documents`);
  const json = await res.json();
  if (json.error) bad(`/api/documents -> ${json.error}`);
  else ok(`documents table reachable (${json.documents.length} rows)`);
} catch (err) {
  bad(`/api/documents unreachable — is \`npm run dev\` running? ${err.message}`);
}

// ------------------------------------------------------------- 3. ingest ---
let documentId = null;
if (file) {
  console.log(`\n3. Ingest ${basename(file)}`);
  try {
    const bytes = await readFile(file);
    const type = MIME[extname(file).toLowerCase()];
    if (!type) throw new Error(`Unsupported extension ${extname(file)}`);

    const form = new FormData();
    form.append("files", new Blob([bytes], { type }), basename(file));

    const res = await fetch(`${BASE}/api/ingest`, { method: "POST", body: form });
    const json = await res.json();
    const result = json.results?.[0];

    if (result?.ok) {
      documentId = result.document_id;
      ok(`extracted "${result.data.title}" (${result.data.document_type}), ${result.chunks} chunks`);
      if (result.storage_warning) console.log(`  warn ${result.storage_warning}`);
      console.log(`\n  summary: ${result.data.summary}\n`);
    } else {
      bad(result?.error ?? JSON.stringify(json));
    }
  } catch (err) {
    bad(err.message);
  }
} else {
  console.log("\n3. Ingest — skipped (pass a file path to test it)");
}

// ---------------------------------------------------------- 4. retrieval ---
console.log("\n4. Retrieval");
try {
  const res = await fetch(`${BASE}/api/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "what is the account number and balance", document_id: documentId }),
  });
  const json = await res.json();
  if (json.error) bad(json.error);
  else if (!json.results.length) bad("0 matches — nothing indexed, or embeddings are missing");
  else {
    ok(`${json.results.length} matches, top similarity ${json.results[0].similarity}`);
    console.log(`\n  top hit (${json.results[0].section}):\n  ${json.results[0].content.slice(0, 300)}\n`);
  }
} catch (err) {
  bad(err.message);
}

// -------------------------------------------------- 5. voice pipeline legs ---
console.log("5. Deepgram token");
try {
  const res = await fetch(`${BASE}/api/voice/token`, { method: "POST" });
  const json = await res.json();
  if (json.access_token) ok(`temporary token granted (expires in ${json.expires_in}s)`);
  else bad(json.error ?? JSON.stringify(json));
} catch (err) {
  bad(err.message);
}

console.log("\n6. Answering model (RAG -> text)");
let answer = "";
try {
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "Mera account number kya hai?",
      history: [],
      document_id: documentId,
    }),
  });
  if (!res.ok) {
    bad((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  } else {
    answer = await res.text();
    ok(`answered using ${res.headers.get("X-Retrieved-Chunks")} chunks`);
    console.log(`\n  "${answer.trim()}"\n`);
  }
} catch (err) {
  bad(err.message);
}

console.log("7. Sarvam TTS");
try {
  const res = await fetch(`${BASE}/api/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: answer.trim() || "Namaste, main aapka account desk hoon." }),
  });
  if (!res.ok) {
    bad((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  } else {
    const bytes = (await res.arrayBuffer()).byteLength;
    bytes > 1000 ? ok(`${(bytes / 1024).toFixed(1)} KB of audio returned`) : bad("suspiciously small audio payload");
  }
} catch (err) {
  bad(err.message);
}

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
