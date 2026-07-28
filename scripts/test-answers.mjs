// Runs the real retrieve -> answer pipeline against the indexed data, comparing
// the configured chat model with the intended one. Read-only. No secrets printed.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

function loadEnv() {
  const env = {};
  for (const file of [".env.local", ".env"]) {
    let raw;
    try { raw = readFileSync(new URL(`../${file}`, import.meta.url), "utf8"); } catch { continue; }
    for (const line of raw.split(/\r?\n/)) {
      if (line.trim().startsWith("#")) continue;
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in env)) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return env;
}
const env = loadEnv();
const BASE = env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function embed(text) {
  const r = await fetch(`${BASE}/embeddings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small", input: [text], dimensions: 1536 }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`embed ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return j.data[0].embedding;
}

async function retrieve(query) {
  const v = await embed(query);
  const { data, error } = await sb.rpc("match_chunks", {
    query_embedding: v, query_text: query, match_count: 8,
    filter_document_id: null, full_text_weight: 1, semantic_weight: 1,
  });
  if (error) throw new Error(error.message);
  return data ?? [];
}

const PERSONA = `You are an account desk voice assistant. Answer ONLY from the CONTEXT block, which comes from the caller's documents.
Read the exact value word-for-word from the context; never guess. Answer the specific thing asked, one short spoken sentence.
Match the caller's language (Hinglish gets a Hinglish reply with Hindi words in Devanagari). Write numbers as digits.`;

async function answer(model, query, context) {
  const body = {
    model, stream: false, reasoning_effort: "none", verbosity: "low",
    messages: [
      { role: "system", content: PERSONA },
      { role: "user", content: `${query}\n\nCONTEXT:\n${context}` },
    ],
  };
  let r = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    // Retry without the 5.6-only params in case this model rejects them.
    const t = await r.text();
    delete body.reasoning_effort; delete body.verbosity;
    r = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) return `<ERROR ${r.status}: ${(await r.text()).slice(0, 160)} | first: ${t.slice(0, 120)}>`;
  }
  const j = await r.json();
  return j.choices?.[0]?.message?.content ?? "<no content>";
}

const QUESTIONS = [
  { q: "item 5 ka amount kitna hai?", expect: "17250" },
  { q: "labour amount kitna hai?", expect: "49493" },
  { q: "stone amount kitna hai?", expect: "4498" },
  { q: "bill number kya hai?", expect: "RJ0352" },
  { q: "item 8 ka gross weight kitna hai?", expect: "9.876" },
  { q: "aathvi item ka amount kitna hai?", expect: "34142" },
  { q: "item 2 ka amount?", expect: "15570" },
];
const MODELS = [env.OPENAI_CHAT_MODEL ?? "gpt-5.4-nano", "gpt-5.6-luna"];

for (const { q, expect } of QUESTIONS) {
  const hits = await retrieve(q);
  const context = hits.map((c, i) => `[${i + 1}] (${c.doc_type} — ${c.section})\n${c.content}`).join("\n\n");
  console.log(`\nQ: ${q}   (correct answer contains: ${expect})`);
  console.log(`   retrieved ${hits.length} chunks, top section: ${hits[0]?.section}`);
  for (const model of MODELS) {
    const a = await answer(model, q, context);
    const ok = a.includes(expect) ? "✅" : "❌";
    console.log(`   ${ok} [${model}] ${a.replace(/\s+/g, " ").trim().slice(0, 180)}`);
  }
}
