"use client";

/**
 * Text chatbot — completely separate surface from the voice call. Same
 * document-grounded backend (/api/chat), none of the voice machinery: no
 * Deepgram, no Sarvam, no turn state machine. This page plus this file are the
 * entire feature; nothing in the call path imports it and it imports nothing
 * from the call path.
 *
 * SAME ANSWERS AS VOICE, by construction: each chat session sends a call_id,
 * so the server builds history from its own byte-exact conversation log —
 * exactly the mechanism the voice call uses. Ask the same questions on either
 * surface and the model receives identical prompts. (The id is fresh per
 * session and per document, so parallel tabs and calls stay independent.)
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { docLabel } from "@/lib/docLabel";

type Doc = {
  id: string;
  file_name: string;
  doc_type: string | null;
  title: string | null;
  summary: string | null;
  created_at: string | null;
};

type Message = { id: string; role: "user" | "assistant"; content: string; pending?: boolean };

const uid = () => Math.random().toString(36).slice(2, 10);

export default function ChatPage() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [scope, setScope] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  /** Session id for the server conversation log — the voice call's mechanism. */
  const chatIdRef = useRef("");
  const endRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  function newSession() {
    // Tell the server to drop the old log (best-effort), then mint a fresh id.
    if (chatIdRef.current) {
      navigator.sendBeacon?.(
        "/api/chat/end",
        new Blob([JSON.stringify({ call_id: chatIdRef.current })], { type: "application/json" })
      );
    }
    chatIdRef.current =
      globalThis.crypto?.randomUUID?.() ?? `chat-${Date.now()}-${Math.random()}`;
  }

  useEffect(() => {
    newSession();
    fetch("/api/documents")
      .then((r) => r.json())
      .then((j) => {
        if (j.error) return;
        const list = j.documents as Doc[];
        setDocs(list);
        // Same single-document default as the call page, for the same reason:
        // two uploads can be versions of one job, and searching across both
        // gives one question two right answers.
        if (list.length > 0) setScope(list[0].id);
      })
      .catch(() => {});
    // Abort any in-flight stream and release the server-side log on unmount.
    return () => {
      abortRef.current?.abort();
      if (chatIdRef.current) {
        navigator.sendBeacon?.(
          "/api/chat/end",
          new Blob([JSON.stringify({ call_id: chatIdRef.current })], { type: "application/json" })
        );
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [messages]);

  function updateMessage(id: string, patch: Partial<Message>) {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  }

  async function send() {
    const text = input.trim();
    // A question with no document selected would search the WHOLE corpus —
    // and two uploads can be versions of one job, where "item 5 ka amount"
    // has two right answers. The voice call is pinned to one document; this
    // page enforces exactly the same rule.
    if (!text || busy || !scope) return;
    setError(null);
    setInput("");
    setBusy(true);

    setMessages((prev) => [...prev, { id: uid(), role: "user", content: text }]);
    const pendingId = uid();
    setMessages((prev) => [...prev, { id: pendingId, role: "assistant", content: "", pending: true }]);

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        signal: ac.signal,
        headers: { "Content-Type": "application/json" },
        // No client history: the call_id makes the server use its own
        // conversation log — the SAME history mechanism as the voice call, so
        // both surfaces build identical prompts for identical questions.
        body: JSON.stringify({ message: text, call_id: chatIdRef.current, document_id: scope }),
      });

      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        updateMessage(pendingId, {
          content: body.error ?? `Chat failed (${res.status}).`,
          pending: false,
        });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let full = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        full += decoder.decode(value, { stream: true });
        updateMessage(pendingId, { content: full, pending: true });
      }
      full += decoder.decode(); // flush any buffered multi-byte tail
      // The voice pipeline's end-of-call marker means nothing in text chat.
      updateMessage(pendingId, {
        content: full.replaceAll("[END_CALL]", "").trim() || "…",
        pending: false,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      updateMessage(pendingId, {
        content: err instanceof Error ? err.message : String(err),
        pending: false,
      });
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  return (
    <div className="mx-auto flex h-dvh max-w-3xl flex-col px-4 py-6">
      <header className="flex items-center justify-between pb-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">Chat with your documents</h1>
          <p className="mt-0.5 text-[13px] text-ink-muted">
            Text only — for the voice agent,{" "}
            <Link href="/call" className="underline underline-offset-2 hover:no-underline">
              call Pi
            </Link>
            .
          </p>
        </div>
        <Link href="/" className="text-[13px] text-ink-muted transition hover:text-ink">
          ← Upload
        </Link>
      </header>

      {docs.length > 0 && (
        <label className="block pb-3 text-sm">
          <span className="text-ink-muted">Answer from</span>
          <select
            value={scope}
            onChange={(e) => {
              // Switching documents starts a fresh conversation — same as
              // hanging up and calling about a different document. Old turns
              // were answered from the old document and would contaminate the
              // new scope's answers through history.
              setScope(e.target.value);
              setMessages([]);
              newSession();
            }}
            className="mt-1.5 w-full rounded-lg border border-border bg-surface px-3 py-2 text-ink shadow-soft"
          >
            {docs.map((d) => (
              <option key={d.id} value={d.id}>
                {docLabel(d)}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="flex-1 space-y-3 overflow-y-auto rounded-xl border border-border bg-surface p-4 shadow-soft">
        {messages.length === 0 && (
          <p className="text-sm text-ink-faint">
            {docs.length === 0 ? (
              <>
                No documents indexed yet — there is nothing to answer from.{" "}
                <Link href="/" className="underline underline-offset-2 hover:no-underline">
                  Upload one first
                </Link>
                .
              </>
            ) : (
              "Ask anything that is in the selected document — amounts, weights, bill numbers."
            )}
          </p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
            <div
              className={
                m.role === "user"
                  ? "max-w-[85%] rounded-2xl rounded-br-sm bg-accent px-3.5 py-2 text-sm text-canvas"
                  : "max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-bl-sm border border-border bg-canvas px-3.5 py-2 text-sm text-ink"
              }
            >
              {m.content || (m.pending ? "…" : "")}
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {error && <p className="pt-2 text-sm text-red-500">{error}</p>}

      <div className="flex items-end gap-2 pt-3">
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={2}
          placeholder="total kitna hua?  /  What is the bill number?"
          className="min-h-[44px] flex-1 resize-none overflow-y-auto rounded-xl border border-border bg-surface px-3.5 py-2.5 text-sm text-ink shadow-soft outline-none focus:border-ink-faint"
        />
        <button
          onClick={() => void send()}
          disabled={busy || !input.trim() || !scope}
          className="rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-canvas transition hover:bg-accent-strong active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
}
