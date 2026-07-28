"use client";

import { useState } from "react";
import { Sidebar, SidebarDocumentsBadge } from "@/components/Sidebar";
import { WelcomeScreen } from "@/components/WelcomeScreen";
import { MessageBubble } from "@/components/MessageBubble";
import { ChatInput, type PendingFile } from "@/components/ChatInput";
import { CallOverlay } from "@/components/CallOverlay";
import { SparkIcon } from "@/components/icons";
import {
  generateAssistantReply,
  seedDocuments,
  type Attachment,
  type ChatMessage,
  type DocumentItem,
} from "@/lib/mock-data";

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

export default function Home() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [documents, setDocuments] = useState<DocumentItem[]>(seedDocuments);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [callOpen, setCallOpen] = useState(false);

  const hasDocuments = documents.some((d) => d.status === "indexed");

  function resetChat() {
    setMessages([]);
  }

  function pushAssistantReply(replyText: string) {
    const pendingId = uid();
    setMessages((prev) => [...prev, { id: pendingId, role: "assistant", content: "", pending: true }]);
    setTimeout(() => {
      setMessages((prev) =>
        prev.map((m) => (m.id === pendingId ? { ...m, content: replyText, pending: false } : m))
      );
    }, 700 + Math.random() * 500);
  }

  function handleSend(text: string, files: PendingFile[]) {
    const attachments: Attachment[] = files.map((f) => ({
      id: uid(),
      name: f.file.name,
      kind: f.kind,
      sizeLabel: formatSize(f.file.size),
    }));

    setMessages((prev) => [
      ...prev,
      { id: uid(), role: "user", content: text, attachments: attachments.length ? attachments : undefined },
    ]);

    if (files.length > 0) {
      const newDocs: DocumentItem[] = files.map((f, i) => ({
        id: uid(),
        name: f.file.name,
        kind: f.kind,
        status: "processing",
        uploadedLabel: "just now",
        holder: "Rohan Mehta",
        accountMasked: "•••• •••• " + String(1000 + Math.floor(Math.random() * 8999)).slice(-4),
        ifsc: "IDFB000" + (1000 + i),
        balance: "₹" + (10000 + Math.floor(Math.random() * 190000)).toLocaleString("en-IN") + ".00",
      }));
      setDocuments((prev) => [...newDocs, ...prev]);

      const pendingId = uid();
      setMessages((prev) => [...prev, { id: pendingId, role: "assistant", content: "", pending: true }]);

      setTimeout(() => {
        setDocuments((prev) =>
          prev.map((d) => (newDocs.some((nd) => nd.id === d.id) ? { ...d, status: "indexed" } : d))
        );
        const first = newDocs[0];
        const summary =
          `Processed **${first.name}**. Found account holder **${first.holder}**, ` +
          `account ${first.accountMasked}, IFSC **${first.ifsc}**, balance **${first.balance}**. ` +
          `Ask me anything about it.`;
        setMessages((prev) =>
          prev.map((m) => (m.id === pendingId ? { ...m, content: summary, pending: false } : m))
        );
      }, 1400);
      return;
    }

    if (text) {
      pushAssistantReply(generateAssistantReply(text, hasDocuments));
    }
  }

  function handleSuggestion(text: string) {
    if (text.toLowerCase().includes("voice call")) {
      setCallOpen(true);
      return;
    }
    handleSend(text, []);
  }

  function handleCallEnd(durationLabel: string, topic: string) {
    setCallOpen(false);
    setMessages((prev) => [
      ...prev,
      { id: uid(), role: "assistant", content: "", callSummary: { durationLabel, topic } },
    ]);
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
          <SidebarDocumentsBadge count={documents.filter((d) => d.status === "indexed").length} />
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

        <ChatInput onSend={handleSend} onStartCall={() => setCallOpen(true)} />
      </div>

      {callOpen && <CallOverlay onEnd={handleCallEnd} />}
    </div>
  );
}
