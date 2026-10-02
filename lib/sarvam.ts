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
  // api.sarvam.ai negotiates HTTP/2 over TLS 1.3 via ALPN (verified against the
  // live origin). Without this undici stays on HTTP/1.1 and each concurrent
  // sentence needs its OWN socket — so a burst of clips pays fresh handshakes
  // (~180-330ms each) instead of multiplexing over the one warm connection.
  allowH2: true,
});

export const TTS_MODEL = process.env.SARVAM_MODEL ?? "bulbul:v3";
/**
 * priya is the only speaker that is both Tier 1 (0.13% critical-error rate,
 * "first choice for production") AND on the docs' recommended-for-Hindi list.
 */
export const TTS_SPEAKER = process.env.SARVAM_SPEAKER ?? "priya";
/**
 * wav by default: lossless, and unlike mp3 it carries no encoder delay/padding
 * baked into each per-sentence clip, so consecutive clips join without the
 * tiny seams of silence mp3 framing creates. mp3 remains available for
 * bandwidth-constrained deployments.
 */
export const TTS_CODEC = process.env.SARVAM_CODEC === "mp3" ? "mp3" : "wav";
/** The Content-Type the proxy route must declare for the chosen codec. */
export const TTS_MIME = TTS_CODEC === "mp3" ? "audio/mpeg" : "audio/wav";
/**
 * target_language_code drives how numbers and abbreviations are SPOKEN.
 * It is chosen per sentence: text containing Devanagari (a Hinglish reply)
 * speaks numbers in Hindi; a pure-Latin sentence (an English reply) speaks
 * them in English. Same voice (speaker) either way.
 */
export const TTS_LANGUAGE = process.env.SARVAM_LANGUAGE ?? "hi-IN";
export const TTS_LANGUAGE_EN = process.env.SARVAM_LANGUAGE_EN ?? "en-IN";

/**
 * Dominance, not any-match: a single Devanagari unit word ("ग्राम") inside an
 * otherwise English sentence must NOT flip the whole sentence to Hindi
 * number-speech. Only used when the caller's ask language isn't passed in.
 */
export function languageFor(text: string): string {
  const devanagari = (text.match(/[ऀ-ॿ]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  return devanagari > latin ? TTS_LANGUAGE : TTS_LANGUAGE_EN;
}
/** 24 kHz is bulbul:v3's native rate. */
const SAMPLE_RATE = Number(process.env.SARVAM_SAMPLE_RATE ?? 24000);

/** The streaming endpoint caps text at 3,500 chars. */
const MAX_CHARS = 3500;

/**
 * Isolated CJK (Han/kana/Hangul) characters. DeepSeek's tokenizer occasionally
 * leaks a stray Chinese character (e.g. "极") into otherwise Hindi/English
 * output — a documented failure mode of the model. Handed to an Indian TTS this
 * mispronounces or breaks the clip, so it is scrubbed before synthesis.
 */
const CJK = /[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯가-힯]/g;

/**
 * Light clean-up before synthesis:
 *  - strip stray CJK characters that DeepSeek can leak into a Hindi/English reply.
 *  - group bare 4+ digit integers Indian-style (1234 -> 1,234) so numbers are
 *    spoken as a quantity, not "one two three four". Decimals (60.433) and
 *    already-grouped or space-separated identifiers (5 4 3 2 1 0) are left as-is.
 *  - collapse stray whitespace/newlines (Bulbul turns them into audible pauses).
 */
export function normalizeForSpeech(text: string): string {
  const deleaked = text.replace(CJK, "");
  // Boundaries include letters/underscore/hyphen so identifiers keep their
  // digit-by-digit reading: SBIN0001234, INV1234, 27AAAAA0000A1Z5 and ID-100234
  // must NOT be comma-grouped. Bare amounts/counts (1234, ₹1234) still are.
  const grouped = deleaked.replace(/(?<![\p{L}\d.,_-])\d{4,}(?![\p{L}\d.,_-])/gu, (run) => {
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

/**
 * Opens (and drains) one connection on the SAME pool `speak` uses, so the first
 * real synthesis skips the TCP+TLS handshake.
 *
 * This must go through `sarvamAgent`. The previous warm-up called the GLOBAL
 * fetch, which uses undici's global dispatcher — a different pool entirely — so
 * it warmed a connection the TTS path never touched, and the first clip of
 * every call still paid a cold handshake (measured: 44ms TCP + 83ms TLS to
 * api.sarvam.ai). It also never drained the body, so the socket was never
 * returned to the pool.
 *
 * The empty POST 4xx's before any synthesis runs, so it costs no credits.
 */
export async function warmSarvam(): Promise<void> {
  const res = await undiciFetch(`${SARVAM_API}/text-to-speech/stream`, {
    dispatcher: sarvamAgent,
    method: "POST",
    headers: { "api-subscription-key": process.env.SARVAM_API_KEY ?? "" },
  });
  await res.text(); // drain so the socket returns to the keep-alive pool
}

/**
 * Returns the upstream streaming response; caller pipes the body through.
 * `langOverride` (hi-IN | en-IN) forces the number/abbreviation language — the
 * call site passes the CALLER'S ask language so numbers are spoken in the
 * language they asked in, regardless of any script drift in the model's reply.
 * When omitted, the language is inferred from the reply text's own script.
 */
export async function speak(text: string, langOverride?: string): Promise<Response> {
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
      target_language_code: langOverride ?? languageFor(clean),
      speaker: TTS_SPEAKER,
      model: TTS_MODEL,
      output_audio_codec: TTS_CODEC,
      speech_sample_rate: SAMPLE_RATE,
      pace: Number(process.env.SARVAM_PACE ?? 1.0),
      // Randomness control (v3 only, 0.01-1.0, default 0.6). Every sentence is
      // a separate stateless request with NO seed, so a higher value re-rolls
      // prosody per clip — that is the "voice keeps shifting" symptom. 0.2 sits
      // in Sarvam's documented "flat, highly consistent" band (0.01-0.2), which
      // is what keeps one reply sounding like one voice.
      // (enable_preprocessing is v2-only and does not apply to v3.)
      // 0.01 = the floor of the documented "flat, highly consistent" band.
      // Each sentence is a separate stateless request with NO seed parameter
      // (none exists on this API), so any temperature above the floor re-rolls
      // prosody per clip — the "voice keeps changing" symptom. The floor keeps
      // one reply sounding like one voice, and Sarvam has no style-adaptation
      // features: nothing anywhere in this pipeline varies the voice with the
      // caller's pitch or tone.
      temperature: Number(process.env.SARVAM_TEMPERATURE ?? 0.01),
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
