"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Sidebar, SidebarDocumentsBadge } from "@/components/Sidebar";
import { FileTextIcon, ImageIcon, PhoneIcon, PlusIcon, SparkIcon, XIcon } from "@/components/icons";
import type { DocumentSummary } from "@/lib/types";

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type PendingFile = { id: string; file: File };
type ResultStatus = { id: string; name: string; ok: boolean; error?: string };

type IngestResult = { file_name: string; ok: boolean; error?: string };

export default function Home() {
  const router = useRouter();
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<ResultStatus[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  const loadDocuments = useCallback(async () => {
    try {
      const res = await fetch("/api/documents");
      const json = await res.json();
      if (!json.error) setDocuments(json.documents as DocumentSummary[]);
    } catch {
      // Documents panel just stays empty — not fatal to the rest of the UI.
    }
  }, []);

  useEffect(() => {
    loadDocuments();
  }, [loadDocuments]);

  function addFiles(fileList: FileList | File[]) {
    const files = Array.from(fileList).map((file) => ({ id: uid(), file }));
    setPending((prev) => [...prev, ...files]);
  }

  function removeAt(id: string) {
    setPending((prev) => prev.filter((p) => p.id !== id));
  }

  async function upload() {
    if (pending.length === 0 || busy) return;
    setBusy(true);
    setResults([]);

    const form = new FormData();
    pending.forEach((p) => form.append("files", p.file, p.file.name));

    try {
      const res = await fetch("/api/ingest", { method: "POST", body: form });
      const json = await res.json();

      if (json.results) {
        const list = json.results as IngestResult[];
        setResults(list.map((r) => ({ id: uid(), name: r.file_name, ok: r.ok, error: r.error })));
        const failedNames = new Set(list.filter((r) => !r.ok).map((r) => r.file_name));
        setPending((prev) => prev.filter((p) => failedNames.has(p.file.name)));
        loadDocuments();
      } else {
        setResults([{ id: uid(), name: "Upload", ok: false, error: json.error ?? `Failed (${res.status}).` }]);
      }
    } catch (err) {
      setResults([{ id: uid(), name: "Upload", ok: false, error: err instanceof Error ? err.message : String(err) }]);
    } finally {
      setBusy(false);
    }
  }

<<<<<<< HEAD
  async function sendChatMessage(text: string) {
    const history = messages
      .filter((m) => m.content)
      .slice(-8)
      .map((m) => ({ role: m.role, content: m.content }));

    const pendingId = uid();
    setMessages((prev) => [...prev, { id: pendingId, role: "assistant", content: "", pending: true }]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, history, document_id: null }),
      });

      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        updateMessage(pendingId, { content: body.error ?? `Chat failed (${res.status}).`, pending: false });
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

      updateMessage(pendingId, { content: full.trim() || "…", pending: false });
    } catch (err) {
      updateMessage(pendingId, {
        content: err instanceof Error ? err.message : String(err),
        pending: false,
      });
    }
  }

  function handleSend(text: string, files: PendingFile[]) {
    const attachments: Attachment[] = files.map((f) => ({
      id: uid(),
      name: f.file.name,
      kind: f.kind,
      sizeLabel: formatSize(f.file.size),
    }));

    if (text || attachments.length) {
      setMessages((prev) => [
        ...prev,
        { id: uid(), role: "user", content: text, attachments: attachments.length ? attachments : undefined },
      ]);
    }

    // Sequence, don't drop: sending a file WITH a question used to `return`
    // after ingest and silently discard the question. Awaiting also means
    // retrieval sees the freshly indexed chunks.
    void (async () => {
      if (files.length > 0) await ingestFiles(files);
      if (text) await sendChatMessage(text);
    })();
  }

=======
>>>>>>> b9fbf4be1f889ad64122a4b91a76a4d6a6c6ca51
  return (
    <div className="flex h-dvh overflow-hidden bg-canvas">
      <Sidebar documents={documents} open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-border-soft px-4 py-3 md:px-6">
          <button
            onClick={() => setSidebarOpen(true)}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-muted hover:bg-border-soft md:hidden"
            aria-label="Open menu"
          >
            <SparkIcon className="h-4 w-4" />
          </button>
          <p className="hidden text-[13px] font-medium text-ink-muted md:block">Upload</p>
          <SidebarDocumentsBadge count={documents.length} />
        </header>

        <div className="flex flex-1 flex-col items-center justify-center gap-8 overflow-y-auto px-6 py-10">
          <div className="flex flex-col items-center text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent text-canvas shadow-lift">
              <SparkIcon className="h-6 w-6" />
            </div>
            <h1 className="mt-5 text-[26px] font-semibold tracking-tight text-ink">Your documents have voice now.</h1>
            <p className="mt-2 max-w-sm text-[14.5px] leading-relaxed text-ink-muted">
              Upload a statement, invoice, or spreadsheet, then talk to Pi about it.
            </p>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="application/pdf,image/*,.csv,.xls,.xlsx,.doc,.docx,.txt,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/csv,text/plain"
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) addFiles(e.target.files);
              e.target.value = "";
            }}
          />

          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
            }}
            className={`w-full max-w-md rounded-2xl border-2 border-dashed p-8 text-center transition ${
              dragging ? "border-ink bg-accent-soft" : "border-border bg-surface"
            }`}
          >
            <div className="flex items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                aria-label="Add files"
                className="flex h-14 w-14 items-center justify-center rounded-full bg-accent text-canvas transition hover:bg-accent-strong active:scale-95"
              >
                <PlusIcon className="h-6 w-6" />
              </button>
              <button
                type="button"
                onClick={() => cameraInputRef.current?.click()}
                aria-label="Use camera"
                className="flex h-14 w-14 items-center justify-center rounded-full border border-border text-ink-muted transition hover:border-ink-faint hover:text-ink active:scale-95"
              >
                <ImageIcon className="h-6 w-6" />
              </button>
            </div>
            <p className="mt-4 text-[13px] text-ink-muted">
              Click <span className="text-ink">+</span> to choose files, or drop them here.
            </p>
          </div>

          {pending.length > 0 && (
            <div className="w-full max-w-md space-y-3">
              <ul className="space-y-2">
                {pending.map((p) => (
                  <li
                    key={p.id}
                    className="flex items-center gap-2.5 rounded-xl border border-border bg-surface px-3 py-2.5 shadow-soft"
                  >
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent-strong">
                      <FileTextIcon className="h-3.5 w-3.5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium text-ink">{p.file.name}</p>
                      <p className="text-[11px] text-ink-faint">{formatSize(p.file.size)}</p>
                    </div>
                    <button
                      onClick={() => removeAt(p.id)}
                      disabled={busy}
                      className="text-ink-faint transition hover:text-ink disabled:opacity-40"
                      aria-label={`Remove ${p.file.name}`}
                    >
                      <XIcon className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
              <button
                onClick={upload}
                disabled={busy}
                className="w-full rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-canvas transition hover:bg-accent-strong disabled:opacity-50"
              >
                {busy ? "Reading documents…" : "Process & index"}
              </button>
            </div>
          )}

          {results.length > 0 && (
            <div className="w-full max-w-md space-y-2">
              {results.map((r) => (
                <div
                  key={r.id}
                  className={`rounded-xl border px-3.5 py-2.5 text-[13px] ${
                    r.ok ? "border-border bg-surface text-ink" : "border-red-900/40 bg-red-950/5 text-red-500"
                  }`}
                >
                  <span className="font-medium">{r.name}</span> — {r.ok ? "indexed" : r.error ?? "failed"}
                </div>
              ))}
            </div>
          )}

          <button
            onClick={() => router.push("/call")}
            className="flex items-center gap-2.5 rounded-full border border-border bg-surface px-5 py-3 text-sm font-medium text-ink shadow-soft transition hover:border-ink-faint"
          >
            <PhoneIcon className="h-4 w-4" />
            Start a voice call
          </button>
        </div>
      </div>
    </div>
  );
}
