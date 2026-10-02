/**
 * The "connecting…" tone, synthesized rather than loaded.
 *
 * Connecting takes real time — mic permission, the Deepgram token grant and the
 * WebSocket handshake — and silence during it reads as "the button didn't
 * work". A soft tone makes the wait feel like a phone call instead of a hung
 * page.
 *
 * Web Audio rather than an <audio> asset: no file to ship, no network request
 * competing with the greeting that is prewarming on the same connection, and no
 * decode delay before it sounds.
 *
 * CONTINUOUS, not pulsed. A ring cadence (on/off/on/rest) chops the sound into
 * bursts, which is exactly the "breaking" quality to avoid here — and it is
 * wrong anyway, because connecting usually finishes mid-cycle and the tone gets
 * cut off at a random point. One steady tone that swells in and fades out reads
 * as "working on it" and can end at any moment without sounding truncated.
 *
 * Softness comes from three things, none of which is loudness:
 *  - a TWO-tone pair (440 + 480 Hz). Their slow 40 Hz beat gives a gentle
 *    living warble; a single sine sits dead flat and gets shrill fast.
 *  - a low-pass at 900 Hz, so there is nothing bright left to cut.
 *  - long swells at both ends, so it never clicks in or out.
 */

/** The classic warm telephone pair; their beat frequency is the warble. */
const TONES_HZ = [440, 480];
/** Rounds off the top so it cannot sound shrill. */
const LOWPASS_HZ = 900;
/** Quiet: this plays under a greeting that is about to speak over it. */
const LEVEL = 0.05;
/** Slow swell in, so it arrives rather than starts. */
const FADE_IN = 0.35;
/** Slow fade out, so ending mid-tone is never abrupt. */
const FADE_OUT = 0.25;

/**
 * Starts the tone and returns a stop function. Safe to call the stopper more
 * than once. Must be called from a user gesture (the call button) or the
 * browser's autoplay policy leaves the context suspended.
 */
export function startConnectingTone(): () => void {
  let ctx: AudioContext;
  try {
    ctx = new AudioContext();
  } catch {
    return () => {}; // no Web Audio — the call still works, just silently
  }

  const gain = ctx.createGain();
  gain.gain.value = 0;

  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = LOWPASS_HZ;
  // No resonance peak: Q above ~1 would put back the edge the filter removes.
  filter.Q.value = 0.7;

  const oscillators = TONES_HZ.map((hz) => {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = hz;
    osc.connect(gain);
    osc.start();
    return osc;
  });
  gain.connect(filter).connect(ctx.destination);

  // Per-tone level, so two summed oscillators are not twice as loud as one.
  const target = LEVEL / TONES_HZ.length;
  const now = ctx.currentTime;
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(target, now + FADE_IN);

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    try {
      const t = ctx.currentTime;
      gain.gain.cancelScheduledValues(t);
      // From wherever the swell currently is, not from the target — otherwise
      // stopping during the fade-in jumps up before coming down.
      gain.gain.setValueAtTime(gain.gain.value, t);
      gain.gain.linearRampToValueAtTime(0, t + FADE_OUT);
      for (const osc of oscillators) osc.stop(t + FADE_OUT + 0.05);
      setTimeout(() => void ctx.close().catch(() => {}), (FADE_OUT + 0.2) * 1000);
    } catch {
      void ctx.close().catch(() => {});
    }
  };
}
