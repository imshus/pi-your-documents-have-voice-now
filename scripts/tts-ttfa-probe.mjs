/**
 * Measures Sarvam TTS TIME-TO-FIRST-AUDIO-BYTE on a WARM keep-alive connection,
 * across text lengths and codecs. Answers the two numbers nobody publishes:
 *
 *   1. Is Bulbul v3's first-byte latency text-length dependent?
 *      (does a 2-word sentence start faster than a 10-word one?)
 *   2. Does linear16 / wav / opus start faster than mp3?
 *
 * THIS SPENDS SARVAM CREDITS — one synthesis per row (default 6 rows x 3 reps
 * = 18 short calls). Run it deliberately, not in CI.
 *
 *   node scripts/tts-ttfa-probe.mjs
 *
 * Reads SARVAM_API_KEY from .env.local / .env.
 */
import { fetch as undiciFetch, Agent } from "undici";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

function envKey() {
  for (const file of [".env.local", ".env"]) {
    try {
      const raw = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
      const m = raw.match(/^\s*SARVAM_API_KEY\s*=\s*(.+)\s*$/m);
      if (m) return m[1].trim().replace(/^["']|["']$/g, "");
    } catch {
      /* ignore */
    }
  }
  return process.env.SARVAM_API_KEY ?? null;
}

const KEY = envKey();
if (!KEY) {
  console.error("Missing SARVAM_API_KEY in .env.local / .env.");
  process.exit(1);
}

// Same dispatcher shape as lib/sarvam.ts, so the numbers are the ones the app sees.
const agent = new Agent({
  keepAliveTimeout: 120_000,
  keepAliveMaxTimeout: 600_000,
  allowH2: true,
});

const MODEL = "bulbul:v3";
const SPEAKER = "priya";
const LANG = "hi-IN";
const REPS = 3;

/** Realistic Hinglish first-sentences of increasing length. */
const TEXTS = [
  ["2 words  (12 ch)", "जी हाँ।"],
  ["5 words  (32 ch)", "जी हाँ, आपका order confirm है।"],
  ["10 words (68 ch)", "जी हाँ, आपका order confirm हो गया है और कल तक deliver हो जाएगा।"],
  [
    "25 words (170 ch)",
    "जी हाँ, आपका order confirm हो गया है और कल शाम तक deliver हो जाएगा। " +
      "अगर कोई problem हो तो आप हमें call कर सकते हैं, हमारी team हमेशा available रहती है।",
  ],
];

/** codec -> what one second of audio costs in bytes, for context in the output. */
const CODECS = [
  ["mp3", 24000],
  ["linear16", 24000],
  ["linear16", 16000],
  ["wav", 24000],
  ["opus", 24000],
];

/**
 * One synthesis. Returns ms to the FIRST BYTE of the audio body (not headers,
 * not completion) — that is the number the caller's ear is waiting on.
 */
async function probe(text, codec, rate) {
  const t0 = performance.now();
  const res = await undiciFetch("https://api.sarvam.ai/text-to-speech/stream", {
    dispatcher: agent,
    method: "POST",
    headers: { "api-subscription-key": KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      target_language_code: LANG,
      speaker: SPEAKER,
      model: MODEL,
      output_audio_codec: codec,
      speech_sample_rate: rate,
      pace: 1.0,
      temperature: 0.2,
    }),
  });

  const headersAt = performance.now() - t0;
  if (!res.ok) {
    return { error: `${res.status} ${(await res.text()).slice(0, 200)}` };
  }

  let firstByteAt = null;
  let total = 0;
  const contentType = res.headers.get("content-type") ?? "(none)";
  for await (const chunk of res.body) {
    if (firstByteAt === null) firstByteAt = performance.now() - t0;
    total += chunk.length;
  }
  return {
    headersAt,
    firstByteAt,
    doneAt: performance.now() - t0,
    bytes: total,
    contentType,
  };
}

const pad = (s, n) => String(s).padEnd(n);
const ms = (n) => (n === null || n === undefined ? "   —  " : `${n.toFixed(0)}ms`.padStart(7));

console.log(`\nSarvam TTS time-to-first-audio-byte — ${MODEL} / ${SPEAKER} / ${LANG}`);
console.log("Warm keep-alive + h2 dispatcher (same config as lib/sarvam.ts).");
console.log(`Best of ${REPS} per row. First row of each codec also pays connection warm-up.\n`);

for (const [codec, rate] of CODECS) {
  console.log(`--- ${codec} @ ${rate} Hz ---`);
  console.log(pad("text", 20) + pad("hdrs", 9) + pad("1st byte", 11) + pad("complete", 11) + pad("bytes", 10) + "content-type");

  // One throwaway call so the socket + any server-side warm path is hot.
  await probe("नमस्ते।", codec, rate).catch(() => {});

  for (const [label, text] of TEXTS) {
    let best = null;
    let err = null;
    for (let i = 0; i < REPS; i++) {
      const r = await probe(text, codec, rate);
      if (r.error) {
        err = r.error;
        break;
      }
      if (!best || r.firstByteAt < best.firstByteAt) best = r;
    }
    if (err) {
      console.log(pad(label, 20) + `FAILED: ${err}`);
      continue;
    }
    console.log(
      pad(label, 20) +
        ms(best.headersAt) +
        "  " +
        ms(best.firstByteAt) +
        "    " +
        ms(best.doneAt) +
        "    " +
        pad(best.bytes, 10) +
        best.contentType
    );
  }
  console.log("");
}

console.log("How to read this:");
console.log("  * '1st byte' flat across text lengths  => TTFB is NOT length-dependent;");
console.log("    shortening the first sentence buys nothing, so stop clipping it.");
console.log("  * '1st byte' rising with length        => the model waits on full text;");
console.log("    a short first sentence is worth the seam risk.");
console.log("  * linear16 '1st byte' << mp3 '1st byte' => encoder framing is on the path.");
console.log("  * 'complete' minus '1st byte', divided by the audio's real duration,");
console.log("    is Bulbul's realtime factor — that is what decides how much the");
console.log("    browser's 200ms decoded-audio playback threshold actually costs you.");
console.log("  * Check content-type: the docs promise audio/mpeg, the live endpoint has");
console.log("    been seen sending application/octet-stream (see app/api/tts/route.ts).\n");
