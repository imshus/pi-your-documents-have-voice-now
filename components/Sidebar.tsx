"use client";

import { CheckIcon, DocumentsIcon, FileTextIcon, ImageIcon, PlusIcon, SparkIcon } from "./icons";
import type { DocumentSummary } from "@/lib/types";

function relativeTime(iso: string) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function Sidebar({
  documents,
  onNewChat,
  open,
  onClose,
}: {
  documents: DocumentSummary[];
  onNewChat: () => void;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/30 backdrop-blur-[1px] md:hidden"
          onClick={onClose}
        />
      )}
      <aside
        className={`fixed z-40 flex h-full w-72 shrink-0 flex-col border-r border-border bg-surface transition-transform md:static md:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center gap-2 px-5 pb-2 pt-6">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-canvas">
            <SparkIcon className="h-4 w-4" />
          </div>
          <span className="text-[15px] font-semibold tracking-tight text-ink">Pi</span>
        </div>

        <div className="px-3 pt-4">
          <button
            onClick={onNewChat}
            className="flex w-full items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2.5 text-sm font-medium text-ink shadow-soft transition hover:border-accent/40 hover:bg-accent-soft"
          >
            <PlusIcon className="h-4 w-4" />
            New chat
          </button>
        </div>

        <div className="mt-6 flex-1 overflow-y-auto px-3">
          <p className="px-2 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">Documents</p>
          <div className="mt-2 flex flex-col gap-1">
            {documents.length === 0 && (
              <p className="px-2 py-2 text-xs text-ink-faint">No documents indexed yet.</p>
            )}
            {documents.map((doc) => (
              <div
                key={doc.id}
                className="flex items-center gap-2.5 rounded-lg px-2 py-2 text-sm text-ink-muted transition hover:bg-border-soft"
              >
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent-strong">
                  {doc.mime_type?.startsWith("image/") ? (
                    <ImageIcon className="h-3.5 w-3.5" />
                  ) : (
                    <FileTextIcon className="h-3.5 w-3.5" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium text-ink">{doc.title ?? doc.file_name}</p>
                  <p className="truncate text-[11px] text-ink-faint">{relativeTime(doc.created_at)}</p>
                </div>
                <CheckIcon className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
              </div>
            ))}
          </div>
        </div>
      </aside>
    </>
  );
}

export function SidebarDocumentsBadge({ count }: { count: number }) {
  return (
    <span className="flex items-center gap-1 rounded-full border border-border bg-surface px-2.5 py-1 text-[11px] font-medium text-ink-muted">
      <DocumentsIcon className="h-3 w-3" />
      {count} indexed
    </span>
  );
}
