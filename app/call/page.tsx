"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { SpeechQueue } from "./speechQueue";
import { takeSentences } from "@/lib/sentences";
import { askLanguage, ttsLanguage } from "@/lib/askLanguage";

type DocSummary = {
  id: string;
  file_name: string;
  doc_type: string | null;
  title: string | null;
  summary: string | null;
};

type Turn = { role: "user" | "assistant"; content: string };
type LogLine = { kind: "caller" | "agent" | "note"; text: string };
type Status = "idle" | "connecting" | "live" | "ended" | "error";

/** The answering model appends this to its goodbye when the caller is done. */
const END_MARKER = "[END_CALL]";
/** Silence before the agent checks in, then before it politely hangs up. */
const IDLE_PROMPT_MS = 30_000;
const IDLE_END_MS = 20_000;
// Devanagari for Hindi words, Latin for English — romanized Hindi measurably
// degrades Sarvam's pronunciation. Verb forms are feminine to match priya.
const IDLE_PROMPT_LINE = "क्या आप सुन रहे हैं? कोई और सवाल हो तो बोलिए।";
const IDLE_GOODBYE_LINE = "लगता है आप busy हैं। धन्यवाद, फिर बात करेंगे!";

/**
 * One TTS language for a whole turn. Shared with the chat route so the spoken
 * number language and the reply's script are always the SAME decision — if they
 * diverged the voice would read Hindi digits over an English sentence.
 */
function turnTtsLanguage(utterance: string): string {
  return ttsLanguage(askLanguage(utterance));
}

/**
 * Worklet that batches mic frames before handing them to the main thread.
 * A render quantum is 128 samples (8 ms); Flux wants ~80 ms chunks, so
 * batching here means one socket write per chunk instead of ten.
 */
const CAPTURE_WORKLET = `
class Capture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.size = options.processorOptions.chunkSamples;
    this.buf = new Float32Array(this.size);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.size) {
        this.port.postMessage(this.buf.slice());
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('capture', Capture);
`;

export default function CallPage() {
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [scope, setScope] = useState("all");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [partial, setPartial] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [muted, setMuted] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const micRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const queueRef = useRef<SpeechQueue | null>(null);

  const historyRef = useRef<Turn[]>([]);
  /** Bumped on every new caller turn so stale streams can be discarded. */
  const genRef = useRef(0);
  const busyRef = useRef(false);
  /**
   * Speculative draft started on EagerEndOfTurn: the LLM runs while the caller
   * is still trailing off, but its sentences are BUFFERED — audio is only
   * released when the real EndOfTurn confirms the turn (Flux guarantees the
   * transcripts match), and the whole draft is discarded on TurnResumed.
   */
  const draftRef = useRef<{
    gen: number;
    transcript: string;
    committed: boolean;
    buffered: string[];
    historyMark: number;
    // Caller's ask language (hi-IN when they asked in Hindi/Devanagari) — forces
    // the spoken number language for this whole turn's audio.
    lang?: string;
    // Set when the eager stream finishes before the turn is confirmed: the
    // answer is held here (invisible) until commitDraft surfaces it.
    finalText?: string;
    sawEnd?: boolean;
    done?: boolean;
  } | null>(null);
  const callStartRef = useRef(0);
  /**
   * Retrieval primed on the caller's PARTIAL transcript (while they still
   * speak). Passed to /api/chat, which uses it when the final utterance
   * matches closely — the whole retrieval leg then costs ~0ms.
   */
  const primeRef = useRef<{
    for: string;
    results: unknown[] | null;
    inflight: boolean;
    lastFiredAt: number;
  }>({ for: "", results: null, inflight: false, lastFiredAt: 0 });
  /** Set right before we close the socket ourselves, so onclose stays quiet. */
  const intentionalCloseRef = useRef(false);
  /** Aborts the in-flight /api/chat stream on barge-in or hang-up. */
  const chatAbortRef = useRef<AbortController | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 0 = fresh silence, 1 = already prompted once — next expiry hangs up. */
  const idleStageRef = useRef(0);
  const statusRef = useRef<Status>("idle");

  useEffect(() => {
    statusRef.current = status;
  }, [status]);
  const scopeRef = useRef("all");
  const logBoxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scopeRef.current = scope;
  }, [scope]);

  useEffect(() => {
    fetch("/api/documents")
      .then((r) => r.json())
      .then((j) => !j.error && setDocs(j.documents as DocSummary[]))
      .catch(() => {});
    return () => hangUp();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    logBoxRef.current?.scrollTo({ top: logBoxRef.current.scrollHeight, behavior: "smooth" });
  }, [log, partial]);

  const note = (kind: LogLine["kind"], text: string) =>
    setLog((prev) => [...prev, { kind, text }]);

  // ----------------------------------------------------------- idle timeout
  function clearIdleTimer() {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = null;
  }

  /** Armed whenever the agent falls silent; any caller speech resets it. */
  function armIdleTimer() {
    clearIdleTimer();
    if (statusRef.current !== "live") return;
    idleTimerRef.current = setTimeout(
      onIdleExpired,
      idleStageRef.current === 0 ? IDLE_PROMPT_MS : IDLE_END_MS
    );
  }

  function onIdleExpired() {
    if (statusRef.current !== "live" || busyRef.current || queueRef.current?.isSpeaking) return;
    if (idleStageRef.current === 0) {
      // First expiry: check in once. The timer re-arms (at the shorter
      // interval) when this line finishes playing.
      idleStageRef.current = 1;
      note("agent", IDLE_PROMPT_LINE);
      queueRef.current?.push(IDLE_PROMPT_LINE);
    } else {
      // Second expiry: polite goodbye, then hang up for real.
      const gen = ++genRef.current;
      note("agent", IDLE_GOODBYE_LINE);
      queueRef.current?.push(IDLE_GOODBYE_LINE);
      void (async () => {
        await queueRef.current?.idle();
        if (gen === genRef.current && statusRef.current === "live") {
          note("note", "no response — agent ended the call");
          hangUp();
        }
      })();
    }
  }

  function noteCallerActivity() {
    idleStageRef.current = 0;
    clearIdleTimer();
  }

  /** Fire retrieval on a stable partial transcript, at most every 400ms. */
  function primeRetrieval(partial: string) {
    const p = primeRef.current;
    if (
      partial.split(/\s+/).length < 3 ||
      partial === p.for ||
      p.inflight ||
      Date.now() - p.lastFiredAt < 400
    )
      return;

    p.inflight = true;
    p.lastFiredAt = Date.now();
    // The turn this prime belongs to. If it resolves after the turn is over it
    // must be dropped, or the NEXT turn answers from the previous utterance's
    // retrieval results.
    const primeGen = genRef.current;
    fetch("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: partial,
        document_id: scopeRef.current === "all" ? null : scopeRef.current,
      }),
    })
      .then((r) => r.json())
      .then((j) => {
        if (primeGen !== genRef.current || statusRef.current !== "live") {
          primeRef.current.inflight = false;
          return;
        }
        if (j.results) primeRef.current = { for: partial, results: j.results, inflight: false, lastFiredAt: p.lastFiredAt };
        else p.inflight = false;
      })
      .catch(() => {
        p.inflight = false;
      });
  }

  /**
   * TTS problems are never fatal: one skipped sentence must not stop the call
   * or throw up the red error banner — grey transcript note + console only.
   */
  function handleTtsIssue(message: string) {
    console.warn("tts:", message);
    note("note", `tts: ${message}`);
  }

  /** Speaking-state hook: UI + idle timer in one place. */
  function handleSpeaking(s: boolean) {
    setSpeaking(s);
    if (s) clearIdleTimer();
    else if (statusRef.current === "live" && !busyRef.current) armIdleTimer();
  }

  // ------------------------------------------------------------ agent turn
  async function respondTo(utterance: string, speculative = false) {
    const gen = ++genRef.current;
    // ONE language for the whole turn, resolved from the caller's ask. Resolving
    // per sentence let a single Devanagari unit word flip mid-answer, so the
    // voice and the number language changed between clips of one reply.
    const turnLang = turnTtsLanguage(utterance);
    const draft: NonNullable<typeof draftRef.current> | null = speculative
      ? {
          gen,
          transcript: utterance,
          committed: false,
          buffered: [],
          historyMark: historyRef.current.length,
          lang: turnLang,
        }
      : null;
    draftRef.current = draft;

    busyRef.current = true;
    setThinking(true);

    historyRef.current = [...historyRef.current, { role: "user", content: utterance }];

    const pushSentence = (raw: string) => {
      const s = raw.replaceAll(END_MARKER, "").trim();
      if (!s) return;
      if (draft && !draft.committed) draft.buffered.push(s);
      else queueRef.current?.push(s, turnLang);
    };
    let sawEndMarker = false;

    // One controller per turn: barge-in and hang-up abort it, which also tells
    // the server to stop the upstream generation instead of paying for tokens
    // nobody will hear.
    chatAbortRef.current?.abort();
    const ac = new AbortController();
    chatAbortRef.current = ac;

    try {
      const prime = primeRef.current;
      const res = await fetch("/api/chat", {
        method: "POST",
        signal: ac.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: utterance,
          history: historyRef.current.slice(0, -1),
          document_id: scopeRef.current === "all" ? null : scopeRef.current,
          // Retrieval primed during the caller's speech; the server validates
          // that the final utterance still matches before using it.
          prefetched: prime.results ? { for: prime.for, results: prime.results } : null,
        }),
      });

      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Chat failed (${res.status})`);
      }

      note(
        "note",
        `retrieved ${res.headers.get("X-Retrieved-Chunks") ?? "?"} chunks${
          res.headers.get("X-Retrieval") === "prefetched" ? " (primed)" : ""
        }`
      );
      primeRef.current = { for: "", results: null, inflight: false, lastFiredAt: 0 };
      setThinking(false);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let full = "";
      let firstSpoken = false;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (gen !== genRef.current) return; // barged in — drop the rest

        const text = decoder.decode(value, { stream: true });
        buffer += text;
        full += text;

        // The first sentence ships the instant it terminates — that is the
        // latency the caller feels; later ones batch for smoothness.
        const { sentences, rest } = takeSentences(buffer, { eagerFirst: !firstSpoken });
        buffer = rest;
        if (sentences.length > 0) firstSpoken = true;
        sentences.forEach(pushSentence);
      }

      if (gen !== genRef.current) return;
      if (buffer.trim()) pushSentence(buffer.trim());

      if (full.includes(END_MARKER)) sawEndMarker = true;
      const cleaned = full.replaceAll(END_MARKER, "").trim();

      // An unconfirmed speculative draft must stay INVISIBLE: stash the result
      // and let commitDraft surface it. Writing the "agent" transcript line
      // (or history, or the goodbye/hang-up) here for an eager guess that
      // EndOfTurn later discards is exactly what showed the answer twice.
      if (draft && !draft.committed) {
        draft.finalText = cleaned;
        draft.sawEnd = sawEndMarker;
        draft.done = true;
        return;
      }

      await finalizeAnswer(gen, cleaned, sawEndMarker);
      return;
    } catch (err) {
      // An abort is us cancelling the turn, not a failure — never show it.
      const aborted = err instanceof DOMException && err.name === "AbortError";
      // A draft that died mid-stream must be marked terminal, or commitDraft
      // would later speak its buffered half-answer with nothing in history.
      if (draft && !draft.committed) {
        draft.done = true;
        draft.finalText = "";
        draft.sawEnd = false;
      }
      if (!aborted && gen === genRef.current) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (gen === genRef.current) {
        busyRef.current = false;
        setThinking(false);
        // The turn produced no audio (empty answer, error, abort): nothing will
        // fire handleSpeaking(false), so re-arm the idle watchdog here or the
        // call sits silent forever.
        if (statusRef.current === "live" && !queueRef.current?.isSpeaking) {
          armIdleTimer();
        }
      }
    }
  }

  /** A caller turn always wins: kill playback and any in-flight generation. */
  function bargeIn() {
    if (!queueRef.current?.isSpeaking && !busyRef.current) return;
    genRef.current++;
    busyRef.current = false;
    setThinking(false);
    chatAbortRef.current?.abort();
    chatAbortRef.current = null;
    queueRef.current?.cancel();
    queueRef.current = new SpeechQueue(handleSpeaking, handleTtsIssue);
    note("note", "interrupted");
  }

  /** Discard an uncommitted speculative draft (caller kept talking). */
  function abortDraft() {
    const d = draftRef.current;
    draftRef.current = null;
    if (!d || d.committed) return;

    genRef.current++; // stops the draft's stream loop
    busyRef.current = false;
    setThinking(false);
    chatAbortRef.current?.abort();
    chatAbortRef.current = null;
    // Roll history back to before the draft's provisional user turn (and any
    // assistant turn the finished draft appended).
    historyRef.current = historyRef.current.slice(0, d.historyMark);
    if (statusRef.current === "live" && !queueRef.current?.isSpeaking) armIdleTimer();
  }

  /** Release a draft's buffered speech — the turn is confirmed over. */
  function commitDraft(d: NonNullable<typeof draftRef.current>) {
    d.committed = true;
    d.buffered.forEach((s) => queueRef.current?.push(s, d.lang));
    d.buffered = [];
    // If the eager stream already finished while unconfirmed, its answer was
    // stashed and never shown — surface it now that the turn is confirmed.
    // finalText "" means the draft's stream failed: nothing to log or remember.
    if (d.done && d.finalText) {
      void finalizeAnswer(d.gen, d.finalText, d.sawEnd ?? false);
    }
  }

  /**
   * Surface a confirmed answer exactly once: the visible transcript line, the
   * history entry the next turn is conditioned on, and (if the model ended the
   * call) the goodbye-then-hang-up. Called from a non-speculative respondTo or,
   * for an eager draft, from commitDraft — never from an unconfirmed guess.
   */
  async function finalizeAnswer(gen: number, cleaned: string, sawEnd: boolean) {
    historyRef.current = [...historyRef.current, { role: "assistant", content: cleaned }];
    note("agent", cleaned);
    if (sawEnd) {
      busyRef.current = false;
      setThinking(false);
      await queueRef.current?.idle();
      if (gen === genRef.current && statusRef.current === "live") {
        note("note", "caller said goodbye — agent ended the call");
        hangUp();
      }
    }
  }

  // ------------------------------------------------------------- transport
  /**
   * Flux emits turn-shaped events, so there is no interim/final bookkeeping and
   * no endpointing heuristic here — the model decides when the caller is done.
   */
  function handleFlux(raw: string) {
    let msg: { type?: string; event?: string; transcript?: string; description?: string };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === "Error") {
      setError(msg.description ?? "Deepgram error.");
      return;
    }
    if (msg.type !== "TurnInfo") return;

    const transcript = (msg.transcript ?? "").trim();

    switch (msg.event) {
      case "StartOfTurn":
        // Deliberately not interrupting here: voice activity alone is too easy
        // to trigger with the agent's own audio. We wait for actual words.
        break;

      case "Update":
        setPartial(transcript);
        if (transcript) {
          noteCallerActivity();
          bargeIn();
          // Start retrieval while they're still talking — by EndOfTurn the
          // chunks are usually already in hand.
          primeRetrieval(transcript);
        }
        break;

      case "EagerEndOfTurn":
        // Medium confidence the caller is done: start retrieval + generation
        // now, ~100-200ms early, but hold all audio until the real EndOfTurn.
        setPartial(transcript);
        if (transcript) {
          noteCallerActivity();
          bargeIn();
          abortDraft(); // replace any earlier draft for this turn
          void respondTo(transcript, true);
        }
        break;

      case "TurnResumed":
        // The caller kept talking — the eager guess was wrong. Throw the
        // draft away; nothing was spoken, so the caller never notices.
        abortDraft();
        setPartial(transcript);
        break;

      case "EndOfTurn": {
        setPartial("");
        if (!transcript) {
          abortDraft();
          break;
        }
        note("caller", transcript);
        noteCallerActivity();

        const d = draftRef.current;
        if (d && !d.committed && d.gen === genRef.current && d.transcript === transcript) {
          // Flux guarantees the EndOfTurn transcript matches the eager one
          // when no TurnResumed fired — the draft is exactly right. Release it.
          commitDraft(d);
        } else {
          abortDraft();
          void respondTo(transcript);
        }
        break;
      }
    }
  }

  async function startCall() {
    // Guard on the REF, not `status`: the state value is a stale closure, so
    // rapid double-clicks all read the old "idle"/"ended", all passed, and each
    // ran startCall concurrently — every run cleared the log then re-appended
    // the greeting and opened its own Deepgram socket (the "greeting ×4" + the
    // socket errors). The ref flips synchronously, so the 2nd click is blocked.
    if (statusRef.current === "connecting" || statusRef.current === "live") return;
    statusRef.current = "connecting";
    setStatus("connecting");
    setError(null);
    setLog([]);
    historyRef.current = [];
    draftRef.current = null;
    intentionalCloseRef.current = false;
    queueRef.current = new SpeechQueue(handleSpeaking, handleTtsIssue);

    // Fire-and-forget: open the server's TLS pools to OpenAI/Supabase/Sarvam
    // now, so turn 1 of the call is as fast as turn 5.
    void fetch("/api/warmup", { method: "POST" }).catch(() => {});
    primeRef.current = { for: "", results: null, inflight: false, lastFiredAt: 0 };

    try {
      // 0. Re-validate the scope against the CURRENT document list — the page
      //    may have been open while documents were re-ingested under new ids.
      try {
        const fresh = await fetch("/api/documents").then((r) => r.json());
        if (!fresh.error) {
          const list = fresh.documents as DocSummary[];
          setDocs(list);
          if (scopeRef.current !== "all" && !list.some((x) => x.id === scopeRef.current)) {
            setScope("all");
            scopeRef.current = "all";
          }
        }
      } catch {
        // Offline doc refresh must not block the call; scope falls back server-side.
      }

      // 1. Mic FIRST. This must happen before the token is minted: the
      //    permission prompt blocks for as long as the caller ignores it, and
      //    the Deepgram token only lives 60s. Granting first meant a caller who
      //    took a minute to click "Allow" always connected with an expired
      //    token — a 401 on the handshake, which a browser WebSocket can only
      //    report as a bare "error" + close 1006 with no reason. That is the
      //    intermittent "deepgram not responding" with no detail.
      //    navigator.mediaDevices only exists in a secure context (https or
      //    localhost); over a plain-http LAN IP it is undefined, so guard first.
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error(
          "Microphone unavailable. Open the app at http://localhost:3300 or over HTTPS — browsers block mic access on insecure origins."
        );
      }
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      micRef.current = mic;

      // 2. Short-lived Deepgram credential — minted only once the mic is in
      //    hand, so the whole TTL is spent on the handshake, not on the prompt.
      const tokenRes = await fetch("/api/voice/token", { method: "POST" });
      const token = await tokenRes.json();
      if (!tokenRes.ok || !token.access_token) {
        throw new Error(token.error ?? "Could not get a Deepgram token.");
      }

      const ctx = new AudioContext({ sampleRate: token.sample_rate });
      ctxRef.current = ctx;
      // Created a couple of awaits after the click, so autoplay policy may have
      // parked it. Without this the graph runs but never pulls any audio.
      if (ctx.state === "suspended") await ctx.resume();

      // 3. Socket straight to Deepgram with the temporary token. Flux's
      //    /v2/listen takes the token as a `bearer` subprotocol — the
      //    access_token query param is rejected there (verified live).
      const ws = new WebSocket(token.listen_url, ["bearer", token.access_token]);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onmessage = (e) => handleFlux(e.data as string);
      // The browser's error event carries no detail by design — the actionable
      // information is in the CLOSE frame, so report that instead of a bare
      // "socket error" (1008/4001/4003 = auth or bad query param, 1006 =
      // handshake never completed).
      ws.onerror = () => console.warn("deepgram: socket error event");
      ws.onclose = (e) => {
        // Hanging up closes the socket on purpose — that must not raise the red
        // banner. 1005 = "no status", which a normal browser-side close reports.
        const expected =
          intentionalCloseRef.current ||
          statusRef.current === "ended" ||
          e.code === 1000 ||
          e.code === 1005;
        if (!expected) {
          setError(
            `Deepgram closed the socket (code ${e.code}${e.reason ? `: ${e.reason}` : ""}). Run: node scripts/diag-deepgram.mjs`
          );
        }
        setStatus((s) => (s === "live" ? "ended" : s));
      };

      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        setTimeout(() => reject(new Error("Deepgram connection timed out.")), 10000);
      });

      // 4. Pump PCM16 frames into the socket.
      const blob = new Blob([CAPTURE_WORKLET], { type: "application/javascript" });
      const workletUrl = URL.createObjectURL(blob);
      await ctx.audioWorklet.addModule(workletUrl);
      URL.revokeObjectURL(workletUrl);

      const source = ctx.createMediaStreamSource(mic);
      const capture = new AudioWorkletNode(ctx, "capture", {
        processorOptions: { chunkSamples: token.chunk_samples },
      });
      capture.port.onmessage = (e) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const floats = e.data as Float32Array;
        const pcm = new Int16Array(floats.length);
        for (let i = 0; i < floats.length; i++) {
          const s = Math.max(-1, Math.min(1, floats[i]));
          pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        ws.send(pcm.buffer);
      };
      source.connect(capture);
      // Some browsers only pump a worklet that reaches the destination, so route
      // it through a silenced gain node — never let mic audio hit the speakers.
      const silence = ctx.createGain();
      silence.gain.value = 0;
      capture.connect(silence).connect(ctx.destination);

      // No KeepAlive needed: mic frames flow continuously for the whole call,
      // including while muted (the track is disabled, not detached).

      setStatus("live");
      statusRef.current = "live";
      callStartRef.current = Date.now();
      idleStageRef.current = 0;

      // 5. Agent speaks first.
      const greeting =
        scopeRef.current === "all"
          ? `नमस्ते! मैं account desk से बोल रही हूँ। आपके ${docs.length} documents मेरे पास हैं। बताइए।`
          : "नमस्ते! मैं आपका document देख रही हूँ। बताइए।";
      note("agent", greeting);
      queueRef.current.push(greeting);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
      hangUp(true);
    }
  }

  function hangUp(keepError = false) {
    // Call summary before anything is torn down.
    if (statusRef.current === "live" && callStartRef.current) {
      const secs = Math.round((Date.now() - callStartRef.current) / 1000);
      const turns = historyRef.current.filter((t) => t.role === "user").length;
      note("note", `call ended — ${Math.floor(secs / 60)}m ${secs % 60}s, ${turns} caller turn${turns === 1 ? "" : "s"}`);
      callStartRef.current = 0;
    }
    statusRef.current = "ended";

    genRef.current++;
    busyRef.current = false;
    draftRef.current = null;
    chatAbortRef.current?.abort();
    chatAbortRef.current = null;
    queueRef.current?.cancel();
    clearIdleTimer();
    idleStageRef.current = 0;
    queueRef.current = null;

    intentionalCloseRef.current = true;
    wsRef.current?.close();
    wsRef.current = null;

    micRef.current?.getTracks().forEach((t) => t.stop());
    micRef.current = null;
    void ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;

    setPartial("");
    setThinking(false);
    setStatus((s) => (keepError && s === "error" ? s : "ended"));
  }

  function toggleMute() {
    const next = !muted;
    micRef.current?.getAudioTracks().forEach((t) => (t.enabled = !next));
    setMuted(next);
  }

  const live = status === "live";
  const connecting = status === "connecting";

  return (
    <div className="space-y-7">
      <Link href="/" className="inline-flex items-center gap-1.5 text-[13px] text-ink-muted transition hover:text-ink">
        ← Back
      </Link>

      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Talk to Pi</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Pi listens, retrieves the answer from your documents, and speaks it back. Interrupt any time.
        </p>
      </div>

      {docs.length === 0 ? (
        <p className="rounded-xl border border-border bg-surface p-6 text-sm text-ink-muted shadow-soft">
          No documents indexed yet — Pi would have nothing to read.{" "}
          <Link href="/" className="text-ink underline underline-offset-2 hover:no-underline">
            Upload one first
          </Link>
          .
        </p>
      ) : (
        <label className="block max-w-md text-sm">
          <span className="text-ink-muted">Scope of the call</span>
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            disabled={live || connecting}
            className="mt-1.5 w-full rounded-lg border border-border bg-surface px-3 py-2 text-ink shadow-soft disabled:opacity-50"
          >
            <option value="all">All documents ({docs.length})</option>
            {docs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.title ?? d.file_name}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="flex flex-col items-center gap-4 rounded-2xl border border-border bg-surface py-10 shadow-soft">
        <div className="relative">
          {(live || speaking) && (
            <span className="animate-pulse-ring absolute inset-0 rounded-full border-2 border-accent" />
          )}
          <button
            onClick={live || connecting ? () => hangUp() : startCall}
            disabled={docs.length === 0 && !live}
            className={`relative flex h-24 w-24 items-center justify-center rounded-full transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 ${
              live || connecting
                ? "bg-red-500 text-white hover:bg-red-600"
                : "bg-accent text-canvas hover:bg-accent-strong"
            }`}
            aria-label={live || connecting ? "End call" : "Start call"}
          >
            <svg
              viewBox="0 0 24 24"
              fill="currentColor"
              className={`h-9 w-9 ${live || connecting ? "rotate-[135deg]" : ""}`}
            >
              <path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.46.57 3.6a1 1 0 0 1-.25 1l-2.22 2.2Z" />
            </svg>
          </button>
        </div>

        <p className="text-sm text-ink-muted">
          {status === "idle" && "Tap to call"}
          {connecting && "Connecting…"}
          {live && (thinking ? "Looking it up…" : speaking ? "Speaking…" : "Listening")}
          {status === "ended" && "Call ended"}
          {status === "error" && "Call failed"}
        </p>

        {live && (
          <button
            onClick={toggleMute}
            className="rounded-full border border-border px-4 py-1.5 text-xs text-ink-muted transition hover:border-ink-faint hover:text-ink"
          >
            {muted ? "Unmute" : "Mute"}
          </button>
        )}
      </div>

      {error && (
        <p className="rounded-lg border border-red-900/60 bg-red-950/10 p-3 text-sm text-red-500">
          {error}
        </p>
      )}

      {(log.length > 0 || partial) && (
        <div
          ref={logBoxRef}
          className="max-h-96 space-y-2 overflow-y-auto rounded-xl border border-border bg-surface p-4 shadow-soft"
        >
          {log.map((l, i) => (
            <p
              key={i}
              className={
                l.kind === "caller"
                  ? "text-sm text-ink"
                  : l.kind === "agent"
                    ? "text-sm font-medium text-ink"
                    : "text-xs text-ink-faint"
              }
            >
              {l.kind !== "note" && (
                <span className="mr-2 text-xs uppercase tracking-wide text-ink-faint">
                  {l.kind}
                </span>
              )}
              {l.text}
            </p>
          ))}
          {partial && <p className="text-sm italic text-ink-faint">{partial}</p>}
        </div>
      )}
    </div>
  );
}
