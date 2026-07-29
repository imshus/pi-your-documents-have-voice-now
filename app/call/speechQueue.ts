/**
 * Sentence-level playback queue over the STREAMING TTS route.
 *
 * Each sentence becomes an <audio> element pointed at GET /api/tts?text=… —
 * the browser starts downloading (i.e. Sarvam starts synthesizing) the moment
 * the element is created, and mp3 plays progressively, so the first words are
 * audible while the tail of the sentence is still being synthesized and the
 * rest of the answer is still being generated.
 */
/** No audio progress for this long = the clip is dead; skip it, keep the call. */
const STALL_MS = 8000;

export class SpeechQueue {
  private pending: HTMLAudioElement[] = [];
  private draining = false;
  private cancelled = false;
  private current: HTMLAudioElement | null = null;

  constructor(
    private readonly onSpeakingChange: (speaking: boolean) => void,
    private readonly onError: (message: string) => void
  ) {}

  /**
   * Queue one sentence. Synthesis starts immediately; playback stays ordered.
   * `lang` (hi-IN | en-IN) forces the spoken number language to the caller's
   * ask language; omit to let the TTS infer it from the sentence's script.
   */
  push(text: string, lang?: string) {
    if (this.cancelled || !text.trim()) return;

    const q = lang ? `&lang=${encodeURIComponent(lang)}` : "";
    const audio = new Audio(`/api/tts?text=${encodeURIComponent(text.trim())}${q}`);
    audio.preload = "auto"; // begin fetching (= synthesizing) right away
    this.pending.push(audio);

    if (!this.draining) void this.drain();
  }

  private async drain() {
    this.draining = true;
    this.onSpeakingChange(true);

    while (this.pending.length > 0) {
      const audio = this.pending.shift()!;
      if (this.cancelled) break;
      await this.playOne(audio);
      if (this.cancelled) break;
    }

    this.draining = false;
    this.onSpeakingChange(false);
  }

  /**
   * Plays one clip. Never wedges the queue and never treats barge-in as a
   * failure. Order of attempts:
   *   1. progressive streaming element (fastest start)
   *   2. full download -> blob playback (sidesteps streaming-decode quirks,
   *      and distinguishes a server failure from a player failure)
   * A sentence that fails both is skipped and quietly reported; the call
   * always continues.
   */
  private async playOne(audio: HTMLAudioElement): Promise<void> {
    const url = audio.src;

    if ((await this.tryPlay(audio)) || this.cancelled) return;

    try {
      const res = await fetch(url);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        if (!this.cancelled) this.onError(body?.error ?? `synthesis failed (${res.status})`);
        return;
      }
      // The download raced a barge-in: playing now would talk over the caller
      // (or after the call ended), and this element is not in `pending` so
      // cancel() cannot stop it.
      if (this.cancelled) return;
      const blobUrl = URL.createObjectURL(await res.blob());
      try {
        if (this.cancelled) return;
        const ok = await this.tryPlay(new Audio(blobUrl));
        if (!ok && !this.cancelled) this.onError("audio playback failed — sentence skipped");
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
    } catch {
      if (!this.cancelled) this.onError("synthesis unreachable — sentence skipped");
    }
  }

  /**
   * Plays one element and settles EXACTLY once. A stalled stream (Sarvam
   * connection dies mid-clip) fires neither `ended` nor `error`, which would
   * wedge drain() — and therefore idle() and the whole call — forever, so a
   * no-progress watchdog resolves false instead.
   */
  private tryPlay(el: HTMLAudioElement): Promise<boolean> {
    return new Promise((resolve) => {
      this.current = el;
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;

      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        el.onended = el.onerror = el.onstalled = el.onprogress = el.ontimeupdate = null;
        resolve(ok);
      };
      // Reset on any sign of life; only true silence trips it.
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => done(false), STALL_MS);
      };

      el.onended = () => done(true);
      el.onerror = () => done(false);
      el.onstalled = () => done(false);
      el.onprogress = arm;
      el.ontimeupdate = arm;
      arm();
      el.play().catch(() => done(false));
    });
  }

  /**
   * Resolves once everything queued has finished playing (or the queue is
   * cancelled). Used to let a goodbye finish before the call is torn down.
   */
  async idle(): Promise<void> {
    while (!this.cancelled && (this.draining || this.pending.length > 0)) {
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  /** Barge-in: stop mid-sentence and drop everything still queued. */
  cancel() {
    this.cancelled = true;
    for (const a of this.pending) a.src = "";
    this.pending = [];
    if (this.current) {
      this.current.pause();
      this.current.src = "";
      this.current = null;
    }
    this.onSpeakingChange(false);
  }

  get isSpeaking() {
    return this.draining;
  }
}
