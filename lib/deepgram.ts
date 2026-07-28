/**
 * Deepgram streaming STT on Flux — their conversational model, which carries
 * Nova-3 level accuracy but adds model-integrated end-of-turn detection. That
 * replaces the endpointing/VAD guesswork a voice agent otherwise has to do in
 * the client.
 *
 * Flux speaks a different protocol from Nova-3: /v2/listen, and turn-shaped
 * `TurnInfo` events instead of `Results` + `speech_final` + `UtteranceEnd`.
 *
 * The browser opens the WebSocket itself, so the server's only job is to mint a
 * short-lived token — the real API key never leaves this process.
 */

const DEEPGRAM_API = "https://api.deepgram.com";

/** `flux-general-multi` detects and switches language mid-conversation. */
export const DEEPGRAM_MODEL = process.env.DEEPGRAM_MODEL ?? "flux-general-multi";

/**
 * Biases the multilingual model toward the languages we actually expect.
 * Ignored by the English-only model.
 */
const LANGUAGE_HINTS = (process.env.DEEPGRAM_LANGUAGE_HINTS ?? "hi,en")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** Flux wants 16 kHz mono PCM in ~80 ms chunks. */
export const SAMPLE_RATE = 16000;
export const CHUNK_SAMPLES = 1280;

/** Domain terms Flux should bias toward (500-token cap across all keyterms). */
const KEYTERMS = (process.env.DEEPGRAM_KEYTERMS ?? "Aadhaar,IFSC,PAN,KYC,passbook")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export function buildListenUrl(): string {
  const params = new URLSearchParams({
    model: DEEPGRAM_MODEL,
    encoding: "linear16",
    sample_rate: String(SAMPLE_RATE),
    // Confidence needed to call the turn over (0.5–0.9, default 0.7). Higher =
    // more patient, which matters when a caller pauses mid account number.
    eot_threshold: process.env.DEEPGRAM_EOT_THRESHOLD ?? "0.8",
    // Hard ceiling on silence before the turn is forced closed REGARDLESS of
    // confidence (500–60000 ms, default 5000). Deepgram's own guidance: raise
    // it for callers with frequent mid-utterance pauses — reading an account
    // number aloud is exactly that.
    eot_timeout_ms: process.env.DEEPGRAM_EOT_TIMEOUT_MS ?? "7000",
    // Enables EagerEndOfTurn/TurnResumed: the client starts retrieval + LLM
    // speculatively ~150-250ms early and cancels if the caller resumes. Must
    // be <= eot_threshold. TTS still waits for the real EndOfTurn, so firing
    // early is caller-inaudible — 0.4 is Deepgram's low-latency preset value.
    eager_eot_threshold: process.env.DEEPGRAM_EAGER_EOT_THRESHOLD ?? "0.4",
    // Spoken numbers -> digits for English/European turns. Hindi is NOT
    // covered (confirmed July 2026) — lib/retrieval.ts papers over that gap.
    numerals: "true",
  });

  if (DEEPGRAM_MODEL.endsWith("-multi")) {
    for (const hint of LANGUAGE_HINTS) params.append("language_hint", hint);
  }
  for (const term of KEYTERMS) params.append("keyterm", term);

  return `wss://api.deepgram.com/v2/listen?${params.toString()}`;
}

/**
 * Grants a temporary JWT for browser use. Deepgram's default TTL is 30s, which
 * only has to cover the WebSocket handshake, not the call.
 */
export async function grantDeepgramToken(
  ttlSeconds = 60
): Promise<{ access_token: string; expires_in: number }> {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) {
    throw new Error("Missing DEEPGRAM_API_KEY. Add it to .env.local.");
  }

  const res = await fetch(`${DEEPGRAM_API}/v1/auth/grant`, {
    method: "POST",
    headers: {
      Authorization: `Token ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ttl_seconds: ttlSeconds }),
  });

  if (!res.ok) {
    throw new Error(
      `Deepgram token grant failed (${res.status}): ${(await res.text()).slice(0, 400)}`
    );
  }

  return (await res.json()) as { access_token: string; expires_in: number };
}
