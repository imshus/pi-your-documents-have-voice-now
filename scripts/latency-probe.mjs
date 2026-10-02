/**
 * Measures the NETWORK floor to every upstream on the voice critical path,
 * from this machine. Pure DNS + TCP + TLS timing — it sends no API request and
 * spends no credits, so it is safe to run any time.
 *
 * What it tells you: the irreducible per-turn cost of where each service lives.
 * No amount of code tuning gets below the "warm" column; the gap between "cold"
 * and "warm" is exactly what the keep-alive agents are saving you, per turn.
 *
 *   node scripts/latency-probe.mjs
 */
import { connect as tlsConnect } from "node:tls";
import { lookup } from "node:dns/promises";
import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";

function projectRef() {
  for (const file of [".env.local", ".env"]) {
    try {
      const raw = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
      const m = raw.match(/^\s*SUPABASE_URL\s*=\s*https:\/\/([a-z0-9]+)\.supabase\.co/m);
      if (m) return m[1];
    } catch {
      /* ignore */
    }
  }
  return null;
}

const ref = projectRef();

function envHost() {
  for (const file of [".env.local", ".env"]) {
    try {
      const raw = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
      const m = raw.match(/^\s*DEEPGRAM_HOST\s*=\s*(\S+)/m);
      if (m) return m[1];
    } catch { /* ignore */ }
  }
  return null;
}

const HOSTS = [
  {
    name: "Deepgram  (STT)",
    // Honour the configured region so the probe measures what the app uses.
    host: process.env.DEEPGRAM_HOST ?? envHost() ?? "api.deepgram.com",
    note: "set by DEEPGRAM_HOST",
  },
  { name: "OpenAI    (embed)", host: "api.openai.com", note: "US — serial before Supabase on a prefetch miss" },
  ...(ref
    ? [{ name: "Supabase  (retrieve)", host: `${ref}.supabase.co`, note: "your project region" }]
    : []),
  { name: "DeepSeek  (LLM)", host: "api.deepseek.com", note: "China-hosted" },
  { name: "Sarvam    (TTS)", host: "api.sarvam.ai", note: "Azure Central India (Pune)" },
];

/** One full cold connect: DNS + TCP + TLS, timed at each boundary. */
function probe(host) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let tcpAt = 0;
    const socket = tlsConnect(
      { host, port: 443, servername: host, ALPNProtocols: ["h2", "http/1.1"] },
      () => {
        const done = performance.now();
        const alpn = socket.alpnProtocol || "http/1.1";
        socket.end();
        resolve({ ok: true, tcp: tcpAt - t0, tls: done - tcpAt, total: done - t0, alpn });
      }
    );
    socket.setTimeout(8000);
    socket.on("secureConnect", () => {});
    socket.on("connect", () => {
      tcpAt = performance.now();
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve({ ok: false, error: "timeout after 8s" });
    });
    socket.on("error", (e) => resolve({ ok: false, error: e.message }));
  });
}

const pad = (s, n) => String(s).padEnd(n);
const ms = (n) => `${n.toFixed(0)}ms`.padStart(7);

console.log("\nNetwork floor to each upstream (no API calls, no cost)\n");
console.log(pad("service", 20) + pad("dns", 9) + pad("tcp", 9) + pad("tls", 9) + pad("total", 9) + "alpn");
console.log("-".repeat(72));

let serialTotal = 0;
const rows = [];

for (const { name, host, note } of HOSTS) {
  let dnsMs = 0;
  let ip = "";
  try {
    const t = performance.now();
    const r = await lookup(host);
    dnsMs = performance.now() - t;
    ip = r.address;
  } catch (e) {
    console.log(pad(name, 20) + `DNS FAILED: ${e.message}`);
    continue;
  }

  // Three samples; report the best, which is the closest thing to the true floor.
  let best = null;
  for (let i = 0; i < 3; i++) {
    const r = await probe(host);
    if (!r.ok) {
      best = r;
      break;
    }
    if (!best || r.total < best.total) best = r;
  }

  if (!best?.ok) {
    console.log(pad(name, 20) + `FAILED: ${best?.error ?? "unknown"}`);
    continue;
  }

  console.log(
    pad(name, 20) + ms(dnsMs) + "  " + ms(best.tcp) + "  " + ms(best.tls) + "  " + ms(best.total) + "  " + best.alpn
  );
  rows.push({ name, note, ip, tcp: best.tcp, total: best.total, alpn: best.alpn });
  serialTotal += best.total;
}

console.log("");
for (const r of rows) console.log(`  ${r.name.trim()}  ${r.ip}  — ${r.note}`);

console.log(`\nIf every leg had to connect COLD in one turn: ~${serialTotal.toFixed(0)}ms of pure handshake.`);
console.log("The keep-alive agents avoid that — but only while sockets stay warm.\n");
console.log("Read the tcp column as one-way-RTT x1 (it is a single round trip).");
console.log("Anything above ~60ms means the service is not in/near India.\n");
