"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Sidebar, SidebarDocumentsBadge } from "@/components/Sidebar";
import { WelcomeScreen } from "@/components/WelcomeScreen";
import { MessageBubble } from "@/components/MessageBubble";
import { ChatInput, type PendingFile } from "@/components/ChatInput";
import { SparkIcon } from "@/components/icons";
import type { Attachment, ChatMessage, DocumentSummary } from "@/lib/types";

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

type IngestResult = {
  file_name: string;
  ok: boolean;
  error?: string;
  chunks?: number;
  data?: {
    title: string;
    summary: string;
    account: { number: string | null; ifsc_or_routing: string | null; balance: string | null };
  };
};

export default function Home() {
  const router = useRouter();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);

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

  function resetChat() {
    setMessages([]);
  }

  function updateMessage(id: string, patch: Partial<ChatMessage>) {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  }

  async function ingestFiles(files: PendingFile[]) {
    const form = new FormData();
    files.forEach((f) => form.append("files", f.file, f.file.name));

    const pendingId = uid();
    setMessages((prev) => [...prev, { id: pendingId, role: "assistant", content: "", pending: true }]);

    try {
      const res = await fetch("/api/ingest", { method: "POST", body: form });
      const json = await res.json();

      if (!json.results) {
        updateMessage(pendingId, { content: json.error ?? `Ingest failed (${res.status}).`, pending: false });
        return;
      }

      const results = json.results as IngestResult[];
      const lines = results.map((r) => {
        if (!r.ok) return `**${r.file_name}**: failed — ${r.error ?? "unknown error"}`;
        const d = r.data;
        if (!d) return `**${r.file_name}**: processed, ${r.chunks ?? 0} chunks indexed.`;
        const bits = [
          d.account?.number && `account ${d.account.number}`,
          d.account?.ifsc_or_routing && `IFSC **${d.account.ifsc_or_routing}**`,
          d.account?.balance && `balance **${d.account.balance}**`,
        ].filter(Boolean);
        return `**${d.title || r.file_name}**: ${d.summary}${bits.length ? ` (${bits.join(", ")})` : ""}`;
      });

      updateMessage(pendingId, { content: lines.join("\n\n"), pending: false });
      loadDocuments();
    } catch (err) {
      updateMessage(pendingId, {
        content: err instanceof Error ? err.message : String(err),
        pending: false,
      });
    }
  }

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

    if (files.length > 0) {
      ingestFiles(files);
      return;
    }

    if (text) sendChatMessage(text);
  }

  function handleSuggestion(text: string) {
    if (text.toLowerCase().includes("voice call")) {
      router.push("/call");
      return;
    }
    handleSend(text, []);
  }

  return (
    <div className="flex h-dvh overflow-hidden bg-canvas">
      <Sidebar documents={documents} onNewChat={resetChat} open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-border-soft px-4 py-3 md:px-6">
          <button
            onClick={() => setSidebarOpen(true)}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-muted hover:bg-border-soft md:hidden"
            aria-label="Open menu"
          >
            <SparkIcon className="h-4 w-4" />
          </button>
          <p className="hidden text-[13px] font-medium text-ink-muted md:block">
            {messages.length === 0 ? "New conversation" : "Conversation"}
          </p>
          <SidebarDocumentsBadge count={documents.length} />
        </header>

        {messages.length === 0 ? (
          <WelcomeScreen onSuggestion={handleSuggestion} />
        ) : (
          <div className="flex-1 overflow-y-auto">
            <div className="mx-auto flex max-w-3xl flex-col gap-5 px-4 py-6 md:px-0">
              {messages.map((m) => (
                <MessageBubble key={m.id} message={m} />
              ))}
            </div>
          </div>
        )}

        <ChatInput onSend={handleSend} onStartCall={() => router.push("/call")} />
      </div>
    </div>
  );
}
