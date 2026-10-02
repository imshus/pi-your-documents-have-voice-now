/**
 * Byte-exact conversation log, kept SERVER-side, so DeepSeek's prefix cache can
 * actually grow across a call.
 *
 * THE BUG THIS FIXES. DeepSeek caches on an exact token prefix. That means the
 * messages array on turn N must have turn N-1's array as a byte-for-byte
 * prefix. It did not:
 *
 *   turn 1 SENT     [system(PERSONA), user("total kitna?" + CONTEXT + DIRECTIVE)]
 *   turn 2 SENT     [system(PERSONA), user("total kitna?"), assistant(...), user(...)]
 *                                          ^^^^^^^^^^^^^^^ bare — differs
 *
 * The client stored the caller's bare utterance while the request carried the
 * composed string, so the arrays diverged at message index 1 on every call. The
 * cache therefore matched PERSONA and nothing else, pinned at ~1300 tokens
 * forever no matter how long the call ran — roughly a 30% hit rate on a ~4k
 * prompt, with the other ~70% re-processed and re-billed every single turn.
 *
 * Fixing it client-side would mean shipping the composed string (retrieved
 * chunks and all) back and forth. Instead the server keeps the exact array it
 * sent, and appends to it. The client only sends the new utterance.
 *
 * Turns are committed ONLY on successful completion. A barge-in or a failed
 * stream leaves the log untouched, which is also correct for caching: the next
 * turn still extends the last committed prefix, so the cache still hits.
 */

export type Turn = { role: "user" | "assistant"; content: string };

type Entry = {
  messages: Turn[];
  /**
   * The callers' BARE utterances, parallel to the user turns in `messages`.
   * Kept separately because `messages` holds the composed strings (utterance +
   * CONTEXT + directives) for byte-exact prefix caching — and folding THAT into
   * the next turn's retrieval query embedded ~3k tokens of chunk text and
   * dragged the trigram search arm from ~130ms to ~1.4s per turn.
   */
  bareUsers: string[];
  touchedAt: number;
};

const conversations = new Map<string, Entry>();

/** A call is minutes long; anything idle this long is over. */
const TTL_MS = 30 * 60 * 1000;
/** Hard ceilings so a leak or a flood cannot grow unbounded. */
const MAX_CONVERSATIONS = 500;
const MAX_TURNS = 60;

function sweep(now: number): void {
  for (const [id, entry] of conversations) {
    if (now - entry.touchedAt > TTL_MS) conversations.delete(id);
  }
  // Still too many (many concurrent calls): drop the least recently touched.
  if (conversations.size > MAX_CONVERSATIONS) {
    const byAge = [...conversations.entries()].sort(
      (a, b) => a[1].touchedAt - b[1].touchedAt
    );
    for (const [id] of byAge.slice(0, conversations.size - MAX_CONVERSATIONS)) {
      conversations.delete(id);
    }
  }
}

/** The exact messages already sent for this call, oldest first. */
export function history(callId: string | null | undefined): Turn[] {
  if (!callId) return [];
  const entry = conversations.get(callId);
  if (!entry) return [];
  entry.touchedAt = Date.now();
  return entry.messages;
}

/**
 * The caller's previous BARE utterance — for folding into the next turn's
 * retrieval query. Never the composed message: that would put the previous
 * turn's retrieved chunks into the embedding and the lexical search arms.
 */
export function lastBareUser(callId: string | null | undefined): string | null {
  if (!callId) return null;
  const entry = conversations.get(callId);
  if (!entry || entry.bareUsers.length === 0) return null;
  return entry.bareUsers[entry.bareUsers.length - 1];
}

/**
 * Commit one completed exchange. `userContent` MUST be the exact string that
 * was sent this turn — composed message + context + directive — or the prefix
 * breaks again on the next turn and this whole module is pointless.
 */
export function commitTurn(
  callId: string | null | undefined,
  userContent: string,
  assistantContent: string,
  bareUser: string
): void {
  if (!callId) return;
  const now = Date.now();
  const entry =
    conversations.get(callId) ?? { messages: [], bareUsers: [], touchedAt: now };
  entry.messages.push(
    { role: "user", content: userContent },
    { role: "assistant", content: assistantContent }
  );
  entry.bareUsers.push(bareUser);
  // Trimming from the front would shift every later token and break the very
  // prefix this module exists to preserve, so a call that somehow runs past the
  // ceiling stops growing its cacheable prefix rather than corrupting it.
  if (entry.messages.length > MAX_TURNS * 2) {
    entry.messages = entry.messages.slice(-MAX_TURNS * 2);
  }
  if (entry.bareUsers.length > MAX_TURNS) {
    entry.bareUsers = entry.bareUsers.slice(-MAX_TURNS);
  }
  entry.touchedAt = now;
  conversations.set(callId, entry);
  sweep(now);
}

/** Called when a call ends, so a long-running server does not accumulate. */
export function endConversation(callId: string | null | undefined): void {
  if (callId) conversations.delete(callId);
}
