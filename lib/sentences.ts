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
    // match[2] is "" only when the `$` alternative matched, i.e. the buffer ENDS
    // here mid-stream. A trailing "60." is almost certainly a decimal whose
    // fractional part hasn't arrived yet — shipping it now splits one figure
    // across two clips ("sixty" … "four hundred thirty-three"), and across two
    // TTS languages when only one half carries Devanagari. Wait for more text;
    // the end-of-stream flush sends it if the answer really did end there.
    if (match[2] === "" && /\d[.]$/.test(candidate)) break;
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
