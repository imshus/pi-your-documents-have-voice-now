// Reproduces the browser's exact Deepgram Flux connect from Node so we can read
// the close code/reason the browser hides. Usage: node scripts/diag-deepgram.mjs [model]
import { readFileSync } from "node:fs";
import { WebSocket } from "undici";

function loadEnv() {
  const env = {};
  for (const file of [".env.local", ".env"]) {
    let raw;
    try { raw = readFileSync(new URL(`../${file}`, import.meta.url), "utf8"); }
    catch { continue; }
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m || line.trim().startsWith("#")) continue;
      const key = m[1];
      let val = m[2].replace(/^["']|["']$/g, "");
      if (!(key in env)) env[key] = val; // .env.local wins
    }
  }
  return env;
}

const env = loadEnv();
const KEY = env.DEEPGRAM_API_KEY;
if (!KEY) { console.error("No DEEPGRAM_API_KEY in .env/.env.local"); process.exit(1); }

const MODEL = process.argv[2] ?? env.DEEPGRAM_MODEL ?? "flux-general-multi";
// Same host for grant + socket, so `DEEPGRAM_HOST=api.au.deepgram.com node
// scripts/diag-deepgram.mjs` verifies a region really serves this model.
const HOST = process.env.DEEPGRAM_HOST ?? env.DEEPGRAM_HOST ?? "api.deepgram.com";

function buildUrl(model) {
  const p = new URLSearchParams({
    model,
    encoding: "linear16",
    sample_rate: "16000",
    eot_threshold: env.DEEPGRAM_EOT_THRESHOLD ?? "0.8",
    eot_timeout_ms: env.DEEPGRAM_EOT_TIMEOUT_MS ?? "7000",
    eager_eot_threshold: env.DEEPGRAM_EAGER_EOT_THRESHOLD ?? "0.4",
    numerals: "true",
  });
  if (model.endsWith("-multi")) for (const h of (env.DEEPGRAM_LANGUAGE_HINTS ?? "hi,en").split(",")) p.append("language_hint", h.trim());
  for (const t of (env.DEEPGRAM_KEYTERMS ?? "Aadhaar,IFSC,PAN,KYC,passbook").split(",")) p.append("keyterm", t.trim());
  return `wss://${HOST}/v2/listen?${p.toString()}`;
}

async function grant() {
  const res = await fetch(`https://${HOST}/v1/auth/grant`, {
    method: "POST",
    headers: { Authorization: `Token ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ttl_seconds: 60 }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`grant ${res.status}: ${body}`);
  return JSON.parse(body).access_token;
}

const url = buildUrl(MODEL);
console.log(`host=${HOST}`);
console.log(`model=${MODEL}`);
console.log(`url=${url}`);

const token = await grant();
console.log("token grant: OK");

const ws = new WebSocket(url, ["bearer", token]);
const timer = setTimeout(() => { console.log("no open/close within 8s — giving up"); ws.close(); process.exit(0); }, 8000);

ws.addEventListener("open", () => console.log("OPEN ✅ — Flux accepted the connection"));
ws.addEventListener("message", (e) => console.log("MSG:", typeof e.data === "string" ? e.data.slice(0, 300) : `<binary ${e.data.byteLength}b>`));
ws.addEventListener("error", (e) => console.log("ERROR event:", e.message ?? e.error?.message ?? "(no detail)"));
ws.addEventListener("close", (e) => {
  clearTimeout(timer);
  console.log(`CLOSE ❌ code=${e.code} reason=${JSON.stringify(e.reason)}`);
  process.exit(0);
});
