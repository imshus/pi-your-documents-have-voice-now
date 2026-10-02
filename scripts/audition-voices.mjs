/**
 * Synthesizes ONE representative agent line in every candidate speaker and
 * saves the clips side by side, so "which voice sounds most professional" is a
 * 60-second listening decision instead of blind .env roulette.
 *
 *   node scripts/audition-voices.mjs
 *
 * Writes audition/<speaker>.wav next to the project. Uses the same model,
 * language, pace and temperature the app ships, so what you hear is exactly
 * what a caller would hear. Costs a few seconds of Sarvam TTS credit per voice.
 * Pick the winner and set SARVAM_SPEAKER=<name> in .env.
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";

function loadEnv() {
  const env = {};
  for (const file of [".env.local", ".env"]) {
    let raw;
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
if (!env.SARVAM_API_KEY) {
  console.error("Missing SARVAM_API_KEY in .env / .env.local");
  process.exit(1);
}

/**
 * Tier-1 candidates (0.13-0.30% critical error rate) from Sarvam's speaker
 * reliability table, female then male. The current .env speaker is included
 * automatically so you always have the incumbent to compare against.
 */
const CANDIDATES = [...new Set([env.SARVAM_SPEAKER, "priya", "suhani", "ishita", "shubh", "ratan", "mani"])].filter(Boolean);

/** A line with everything that matters: Hinglish, an amount, a follow-through. */
const SAMPLE =
  "नमस्ते! मैं account desk से बोल रही हूँ। आपका total amount ₹2,37,483 है, और labour amount ₹49,493 है।";

const outDir = new URL("../audition/", import.meta.url);
mkdirSync(outDir, { recursive: true });

console.log(`\nmodel=${env.SARVAM_MODEL ?? "bulbul:v3"}  temp=${env.SARVAM_TEMPERATURE ?? "0.4"}  pace=${env.SARVAM_PACE ?? "1.0"}\n`);

for (const speaker of CANDIDATES) {
  try {
    const res = await fetch("https://api.sarvam.ai/text-to-speech", {
      method: "POST",
      headers: {
        "api-subscription-key": env.SARVAM_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: SAMPLE,
        target_language_code: env.SARVAM_LANGUAGE ?? "hi-IN",
        speaker,
        model: env.SARVAM_MODEL ?? "bulbul:v3",
        speech_sample_rate: Number(env.SARVAM_SAMPLE_RATE ?? 24000),
        pace: Number(env.SARVAM_PACE ?? 1.0),
        temperature: Number(env.SARVAM_TEMPERATURE ?? 0.4),
      }),
    });
    const json = await res.json();
    if (!res.ok) {
      console.log(`  FAIL ${speaker}: ${res.status} ${JSON.stringify(json).slice(0, 120)}`);
      continue;
    }
    // REST endpoint returns base64 wav in audios[0].
    const b64 = json.audios?.[0];
    if (!b64) {
      console.log(`  FAIL ${speaker}: no audio in response`);
      continue;
    }
    const file = new URL(`${speaker}.wav`, outDir);
    writeFileSync(file, Buffer.from(b64, "base64"));
    const mark = speaker === env.SARVAM_SPEAKER ? "  <- current" : "";
    console.log(`  ok   audition/${speaker}.wav${mark}`);
  } catch (err) {
    console.log(`  FAIL ${speaker}: ${err.message}`);
  }
}

console.log(`\nListen, pick one, set SARVAM_SPEAKER=<name> in .env, restart the server.\n`);
