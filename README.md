# Account Desk

Upload account documents → read them into JSON → index them in Supabase pgvector → call a voice agent that answers from them.

```
 Ingest                                        RAG store
 ──────                                        ─────────
 + button    ──┐
 camera      ──┼──▶ OpenAI vision ──▶ JSON ──▶ documents (jsonb)
 drag & drop ──┘          └──▶ chunk ──▶ embed ──▶ doc_chunks (vector 1536)
                                                        │
 Call (cascaded pipeline)                               │
 ───────────────────────                                ▼
 mic ──▶ Deepgram Flux (STT + end-of-turn) ──▶ retrieve ──▶ OpenAI (stream)
                    │                                            │
                    │                                            ▼
                    │                          Sarvam TTS (per sentence) ──▶ speaker
                    └── caller speaks → barge-in: cancel generation + audio ──┘
```

## The five steps

| Step | Where |
| --- | --- |
| 1. Upload via `+` or camera | [app/page.tsx](app/page.tsx), [app/components/CameraCapture.tsx](app/components/CameraCapture.tsx) |
| 2. Analyse → generate JSON | [lib/extract.ts](lib/extract.ts), [app/api/ingest/route.ts](app/api/ingest/route.ts) |
| 3. Load JSON into the RAG DB | [lib/chunk.ts](lib/chunk.ts), [supabase/schema.sql](supabase/schema.sql) |
| 4. Call UI wired to the RAG | [app/call/page.tsx](app/call/page.tsx), [app/api/voice/token/route.ts](app/api/voice/token/route.ts) |
| 5. Agent answers from the documents | [app/api/chat/route.ts](app/api/chat/route.ts) (retrieve → generate), spoken by [app/api/tts/route.ts](app/api/tts/route.ts) |

## The voice pipeline

| Leg | Service | Code |
| --- | --- | --- |
| STT | Deepgram **Flux** (`flux-general-multi`) on `/v2/listen` with `numerals` + banking `keyterm`s, streaming over a browser WebSocket with a 60s server-minted token. Hindi/English switched mid-conversation | [lib/deepgram.ts](lib/deepgram.ts) |
| Turn-taking | Flux model-integrated end-of-turn (`eot_threshold=0.8`, `eot_timeout_ms=7000`) **plus eager mode**: on `EagerEndOfTurn` the LLM starts ~100–200ms early with audio held; `TurnResumed` discards the draft, `EndOfTurn` releases it | [app/call/page.tsx](app/call/page.tsx) |
| Retrieve → generate | **Hybrid** retrieval (pgvector cosine + full-text, RRF-fused — lexical arm carries exact account numbers that embeddings are near-blind to), context in the *last* message so the `[system + history]` prefix stays prompt-cache-stable; answering model is `CHAT_PROVIDER`-selected — **DeepSeek** (default) or OpenAI — streamed and prefix-cached either way | [lib/retrieval.ts](lib/retrieval.ts), [app/api/chat/route.ts](app/api/chat/route.ts) |
| TTS | Sarvam `bulbul:v3` over the **streaming** endpoint (raw chunked binary — first audio while the sentence is still synthesizing), speaker `priya`, sentence-chunked | [lib/sarvam.ts](lib/sarvam.ts), [app/call/speechQueue.ts](app/call/speechQueue.ts) |

Both provider keys stay server-side. Deepgram is reached with a short-lived token; Sarvam is proxied, so the browser only ever receives audio bytes.

**Barge-in**: the first Flux `Update` carrying actual words cancels playback and discards the in-flight generation. `StartOfTurn` is deliberately *not* the trigger — voice activity alone fires too easily on the agent's own audio leaking back through the mic. Browser echo cancellation is on; a headset removes the problem entirely.

**Why Flux over Nova-3**: same accuracy, but end-of-turn is decided by the model rather than by a silence timer, which is the single biggest source of awkward interruptions in a cascaded agent. Flux also speaks a different protocol — `/v2/listen` with `TurnInfo` events (`StartOfTurn` / `Update` / `EndOfTurn`) instead of `Results` with `is_final` / `speech_final`. To fall back to Nova-3 you'd revert both [lib/deepgram.ts](lib/deepgram.ts) and `handleFlux`, not just the model string.

**Known gap**: Flux Multilingual doesn't do numeral formatting for Hindi, so digits spoken in Hindi come back as words rather than `54321`. It doesn't affect this app much — the caller asks questions, the *documents* supply the numbers — but if you add flows where callers dictate account numbers for verification, test that path specifically.

## Setup

**1. Supabase.** Create a project, then paste [supabase/schema.sql](supabase/schema.sql) into the SQL editor and run it. It enables `pgvector`, creates `documents` + `doc_chunks`, the HNSW index, and the `match_chunks` function. Then create a **private** storage bucket named `documents` (Storage → New bucket, Public off) so originals are kept alongside the JSON. Ingest still works without the bucket — you just get a warning and no stored original.

**2. Env.**

```bash
cp .env.example .env.local
```

Fill in `OPENAI_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DEEPGRAM_API_KEY`, `SARVAM_API_KEY`. The Deepgram key needs Member or higher permissions to mint browser tokens. Nothing is prefixed `NEXT_PUBLIC_` — no key reaches the browser.

**3. Run.**

```bash
npm install
npm run dev
```

Open http://localhost:3300.

## Using it

1. **Upload** — `+` for files, the camera icon for a live capture (rear camera on phones; keeps shooting so you can do multi-page docs), or drag and drop. Press **Process & index**. You see the generated JSON per file.
2. **Documents** — everything indexed, with its JSON and a delete button (chunks cascade).
3. **Call** — pick *all documents* or scope to one, press the green button, allow the mic, and talk. The agent greets you first. Interrupt any time. Grey lines in the transcript show retrieval counts and interruptions; italic grey is your live partial transcript.

## Verifying it works

The verify script spends OpenAI, Deepgram and Sarvam credits, so it is not run automatically. With `npm run dev` in another terminal:

```bash
npm run verify -- "C:\path\to\statement.pdf"
```

It walks the whole chain: env vars → Supabase → ingest → retrieval → Deepgram token grant → a real RAG answer → Sarvam synthesis of that answer. It prints the extracted summary, the top retrieved chunk, and the spoken answer text, so you can judge quality rather than just liveness. Everything except the mic capture is covered.

## Notes and knobs

- **Models** are all env-driven. Vision ([lib/openai.ts](lib/openai.ts)) defaults to `gpt-5.5` (measured extraction leader, ~$0.055/page); `gpt-5.6-terra` halves the cost but ranks bottom-quartile on data extraction. Answering is provider-switched by `CHAT_PROVIDER` ([lib/chat.ts](lib/chat.ts)): **DeepSeek** (default, [lib/deepseek.ts](lib/deepseek.ts)) — `deepseek-v4-flash` with thinking mode explicitly **disabled** (its default-on reasoning would wreck voice TTFT and silently void `temperature`) at low `temperature` for verbatim read-back — or **OpenAI** `gpt-5.6-luna` with reasoning effort pinned to `none` (omit that pin and 5.6 models silently default to `medium`, +~1.3s TTFT). Both cache the stable `[system + history]` prefix; the switch also normalizes each provider's differing request params and cache-usage fields. Embeddings are OpenAI `text-embedding-3-large` at `dimensions=1536` (same column width; switching models means re-embedding everything).
- **Hinglish output convention**: the answering prompt requires Hindi words in **Devanagari** and English in Latin script — Sarvam's docs say romanized Hindi input measurably degrades the voice. Flux doesn't format Hindi-spoken numerals into digits (confirmed gap), so [lib/retrieval.ts](lib/retrieval.ts) maps spoken number-word runs ("paanch chaar teen do…") to digit strings before retrieval.- **Extraction schema** lives in [lib/extract.ts](lib/extract.ts) as a strict JSON Schema — add fields there and they flow into the DB and the chunks automatically.
- **Retrieval shape** is in [lib/chunk.ts](lib/chunk.ts). Facts are grouped (holder details, account details, 12 fields per chunk, 8 table rows per chunk) rather than embedded one per line, because single label/value vectors retrieve badly against spoken questions.
- **Grounding**: retrieval runs on every turn rather than behind a tool call — one fewer model round-trip, which on a voice line is the difference between a natural pause and a dead one. The prompt allows answers only from the retrieved context and requires "I can't find that" over a guess.
- **Follow-ups**: the retrieval query folds in the previous caller turn, so "and the branch?" still searches against the right document.
- **Latency knobs**: `DEEPGRAM_EOT_THRESHOLD` / `DEEPGRAM_EOT_TIMEOUT_MS` (how eagerly a turn is called over) and the 40-character sentence floor in [app/call/speechQueue.ts](app/call/speechQueue.ts) (smaller = speech starts sooner but choppier) are the two that matter most.
- **Telephony**: `/api/chat` and `/api/tts` are plain HTTP, so pointing a real phone line (Vobiz/Twilio) at this instead of the browser means replacing only [app/call/page.tsx](app/call/page.tsx) with a media-stream bridge.
