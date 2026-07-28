/**
 * Thin fetch wrappers around the OpenAI REST API. No SDK — one dependency less,
 * and every request/response shape stays visible.
 */

import { fetch as undiciFetch, Agent } from "undici";

const BASE = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";

/**
 * Long-lived keep-alive pool: a cold TCP+TLS handshake to api.openai.com's
 * origin costs hundreds of ms from India; keeping sockets warm across the
 * inter-turn gaps removes it. (Direct undici import — Next's patched global
 * fetch does not honor dispatchers.)
 */
const openaiAgent = new Agent({
  keepAliveTimeout: 120_000,
  keepAliveMaxTimeout: 600_000,
});

/**
 * Vision + structured-output model used to read the uploaded document.
 * gpt-5.5 is the measured leader for verbatim OCR (91.2%) and targeted
 * extraction (87.6%) as of July 2026 — gpt-5.6-sol/terra both score lower on
 * transcription-style tasks. (gpt-5-mini is deprecated, shutdown 2026-12-11.)
 */
export const VISION_MODEL = process.env.OPENAI_VISION_MODEL ?? "gpt-5.5";
/**
 * text-embedding-3-large at dimensions=1536: Matryoshka-trained, so
 * large@1536 beats small@1536 outright (MIRACL 54.9 vs 44.0 multilingual)
 * while fitting the same vector(1536) column. Changing this requires
 * re-embedding every chunk — small and large vectors are not comparable.
 */
export const EMBEDDING_MODEL =
  process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-large";
export const EMBEDDING_DIMS = 1536;
/**
 * Answering model in the voice pipeline. gpt-5.6-luna at reasoning effort
 * "none": ~0.75s TTFT, fastest output in class, and clearly smarter than the
 * 5.4 minis at the same effort. Effort MUST be pinned to "none" in the call —
 * 5.6 models silently default to "medium", which adds ~1.3s of TTFT.
 */
export const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL ?? "gpt-5.6-luna";

function apiKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error(
      "Missing OPENAI_API_KEY. Copy .env.example to .env.local and fill it in."
    );
  }
  return key;
}

export async function openaiFetch(
  path: string,
  init: { method?: string; body?: string; headers?: Record<string, string> } = {}
): Promise<Response> {
  const res = await undiciFetch(`${BASE}${path}`, {
    dispatcher: openaiAgent,
    method: init.method,
    body: init.body,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI ${path} failed (${res.status}): ${body.slice(0, 800)}`);
  }
  return res as unknown as Response;
}

/** Embeds a batch of strings. Returns vectors in the same order as the input. */
export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const out: number[][] = [];
  // The embeddings endpoint caps input array size; 96 keeps requests small.
  for (let i = 0; i < texts.length; i += 96) {
    const batch = texts.slice(i, i + 96);
    const res = await openaiFetch("/embeddings", {
      method: "POST",
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: batch,
        dimensions: EMBEDDING_DIMS,
      }),
    });
    const json = (await res.json()) as {
      data: { index: number; embedding: number[] }[];
    };
    for (const item of json.data.sort((a, b) => a.index - b.index)) {
      out.push(item.embedding);
    }
  }
  return out;
}
