/**
 * Sarvam TTS (Bulbul v3) over the HTTP STREAMING endpoint — raw chunked binary
 * out (application/octet-stream, no base64), so first audio arrives while the
 * rest of the sentence is still synthesizing. The REST /text-to-speech
 * endpoint only answers after full synthesis, base64-wrapped in JSON.
 *
 * (Sarvam's WebSocket endpoint is lower-latency still on a warm connection,
 * but needs a per-call stateful socket — a poor fit for Next.js route
 * handlers. The HTTP stream is the documented stateless middle option.)
 *
 * Proxied through our server so the subscription key stays server-side.
 */

import { fetch as undiciFetch, Agent } from "undici";

const SARVAM_API = "https://api.sarvam.ai";

/**
 * Sarvam (hosted in Pune — ~40-60ms away) replies keep-alive but sends no
 * timeout hint, so undici's 4s default closes the pooled connection during
 * every caller-speech + LLM gap and the first sentence of each turn paid a
 * ~120-165ms fresh TCP+TLS handshake. A long-lived agent keeps it warm.
 * (Direct undici import: Next's patched global fetch ignores dispatchers.)
 */
const sarvamAgent = new Agent({
  keepAliveTimeout: 120_000,
  keepAliveMaxTimeout: 600_000,
});

export const TTS_MODEL = process.env.SARVAM_MODEL ?? "bulbul:v3";
/**
 * priya is the only speaker that is both Tier 1 (0.13% critical-error rate,
 * "first choice for production") AND on the docs' recommended-for-Hindi list.
 */
export const TTS_SPEAKER = process.env.SARVAM_SPEAKER ?? "priya";
/**
 * target_language_code drives how numbers and abbreviations are SPOKEN.
 * It is chosen per sentence: text containing Devanagari (a Hinglish reply)
 * speaks numbers in Hindi; a pure-Latin sentence (an English reply) speaks
 * them in English. Same voice (speaker) either way.
 */
export const TTS_LANGUAGE = process.env.SARVAM_LANGUAGE ?? "hi-IN";
export const TTS_LANGUAGE_EN = process.env.SARVAM_LANGUAGE_EN ?? "en-IN";

function languageFor(text: string): string {
  return /[ऀ-ॿ]/.test(text) ? TTS_LANGUAGE : TTS_LANGUAGE_EN;
}
/** 24 kHz is bulbul:v3's native rate. */
const SAMPLE_RATE = Number(process.env.SARVAM_SAMPLE_RATE ?? 24000);

/** The streaming endpoint caps text at 3,500 chars. */
const MAX_CHARS = 3500;

/**
 * Light clean-up before synthesis:
 *  - collapse stray whitespace/newlines (Bulbul turns them into audible pauses).
 *  - group bare 4+ digit integers Indian-style (1234 -> 1,234) so numbers are
 *    spoken as a quantity, not "one two three four". Decimals (60.433) and
 *    already-grouped or space-separated identifiers (5 4 3 2 1 0) are left as-is.
 */
function normalizeForSpeech(text: string): string {
  const grouped = text.replace(/(?<![\d.,])\d{4,}(?![\d.,])/g, (run) => {
    const last3 = run.slice(-3);
    let rest = run.slice(0, -3);
    const parts: string[] = [];
    while (rest.length > 2) {
      parts.unshift(rest.slice(-2));
      rest = rest.slice(0, -2);
    }
    if (rest) parts.unshift(rest);
    return `${parts.join(",")},${last3}`;
  });
  return grouped.replace(/[ \t\r\n]+/g, " ").trim();
}

/** Returns the upstream streaming response; caller pipes the body through. */
export async function speak(text: string): Promise<Response> {
  const key = process.env.SARVAM_API_KEY;
  if (!key) {
    throw new Error("Missing SARVAM_API_KEY. Add it to .env.local.");
  }

  const clean = normalizeForSpeech(text);
  const res = await undiciFetch(`${SARVAM_API}/text-to-speech/stream`, {
    dispatcher: sarvamAgent,
    method: "POST",
    headers: {
      "api-subscription-key": key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: clean.slice(0, MAX_CHARS),
      target_language_code: languageFor(clean),
      speaker: TTS_SPEAKER,
      model: TTS_MODEL,
      output_audio_codec: "mp3",
      speech_sample_rate: SAMPLE_RATE,
      pace: Number(process.env.SARVAM_PACE ?? 1.0),
      // 0.4 sits firmly in the documented "controlled, professional" band —
      // the steady, confident register — with fewer artifacts than the 0.6
      // default. (enable_preprocessing is a v2-only flag; not sent on v3.)
      temperature: Number(process.env.SARVAM_TEMPERATURE ?? 0.4),
    }),
  });

  if (!res.ok) {
    throw new Error(
      `Sarvam TTS failed (${res.status}): ${(await res.text()).slice(0, 400)}`
    );
  }
  if (!res.body) {
    throw new Error("Sarvam returned no audio stream.");
  }
  // undici's Response is structurally identical for our streaming use.
  return res as unknown as Response;
}
