/**
 * Sentence-level playback queue over the STREAMING TTS route.
 *
 * Each sentence becomes an <audio> element pointed at GET /api/tts?text=… —
 * the browser starts downloading (i.e. Sarvam starts synthesizing) the moment
 * the element is created, and mp3 plays progressively, so the first words are
 * audible while the tail of the sentence is still being synthesized and the
 * rest of the answer is still being generated.
 */
export class SpeechQueue {
  private pending: HTMLAudioElement[] = [];
  private draining = false;
  private cancelled = false;
  private current: HTMLAudioElement | null = null;

  constructor(
    private readonly onSpeakingChange: (speaking: boolean) => void,
    private readonly onError: (message: string) => void
  ) {}

  /** Queue one sentence. Synthesis starts immediately; playback stays ordered. */
  push(text: string) {
    if (this.cancelled || !text.trim()) return;

    const audio = new Audio(`/api/tts?text=${encodeURIComponent(text.trim())}`);
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
      const blobUrl = URL.createObjectURL(await res.blob());
      try {
        const ok = await this.tryPlay(new Audio(blobUrl));
        if (!ok && !this.cancelled) this.onError("audio playback failed — sentence skipped");
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
    } catch {
      if (!this.cancelled) this.onError("synthesis unreachable — sentence skipped");
    }
  }

  private tryPlay(el: HTMLAudioElement): Promise<boolean> {
    return new Promise((resolve) => {
      this.current = el;
      el.onended = () => resolve(true);
      el.onerror = () => resolve(false);
      el.play().catch(() => resolve(false));
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

/**
 * Splits a growing text buffer into speakable sentences.
 * Returns the sentences ready to speak and whatever tail is still incomplete.
 *
 * The 40-char floor stops "Sure." or "Ji." being sent as its own request —
 * each clip costs a round-trip, so very short ones make speech choppy.
 * EXCEPT the first sentence of a turn (`eagerFirst`): time-to-first-audio is
 * the latency that callers actually feel, so it ships the moment it
 * terminates instead of waiting for enough text to merge with.
 */
export function takeSentences(
  buffer: string,
  opts?: { eagerFirst?: boolean }
): { sentences: string[]; rest: string } {
  const minLen = opts?.eagerFirst ? 2 : 40;
  const sentences: string[] = [];
  let rest = buffer;

  for (;;) {
    // Latin terminators plus the Devanagari danda.
    const match = rest.match(/^([\s\S]*?[.!?।])(\s|$)/);
    if (!match) break;

    const candidate = match[1];
    if (candidate.trim().length < minLen && rest.length > candidate.length + 40) {
      // Too short to be worth its own clip — keep growing it, unless it is all
      // that is left, in which case the flush at end-of-stream will send it.
      const next = rest.slice(candidate.length).match(/^[\s\S]*?[.!?।](\s|$)/);
      if (next) {
        const merged = candidate + rest.slice(candidate.length, candidate.length + next[0].length);
        sentences.push(merged.trim());
        rest = rest.slice(merged.length);
        continue;
      }
      break;
    }

    sentences.push(candidate.trim());
    rest = rest.slice(match[0].length);
  }

  return { sentences, rest };
}
