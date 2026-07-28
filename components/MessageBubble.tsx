"use client";

import { FileTextIcon, ImageIcon, PhoneIcon, SparkIcon } from "./icons";
import type { ChatMessage } from "@/lib/mock-data";

function renderContent(content: string) {
  const parts = content.split(/\*\*(.*?)\*\*/g);
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <strong key={i} className="font-semibold text-ink">
        {part}
      </strong>
    ) : (
      <span key={i}>{part}</span>
    )
  );
}

export function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";

  if (message.callSummary) {
    return (
      <div className="animate-fade-up flex justify-center py-1">
        <div className="flex items-center gap-2.5 rounded-full border border-border bg-surface px-4 py-2 text-[13px] text-ink-muted shadow-soft">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent-soft text-ink">
            <PhoneIcon className="h-3 w-3" />
          </span>
          Call ended · {message.callSummary.durationLabel} · {message.callSummary.topic}
        </div>
      </div>
    );
  }

  return (
    <div className={`animate-fade-up flex gap-3 ${isUser ? "flex-row-reverse" : ""}`}>
      {!isUser && (
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent text-canvas">
          <SparkIcon className="h-3.5 w-3.5" />
        </div>
      )}
      <div className={`flex max-w-[78%] flex-col gap-1.5 ${isUser ? "items-end" : "items-start"}`}>
        {message.attachments && message.attachments.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {message.attachments.map((att) => (
              <div
                key={att.id}
                className="flex items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 shadow-soft"
              >
                <div className="flex h-7 w-7 items-center justify-center rounded-md bg-accent-soft text-accent-strong">
                  {att.kind === "pdf" ? <FileTextIcon className="h-3.5 w-3.5" /> : <ImageIcon className="h-3.5 w-3.5" />}
                </div>
                <div className="leading-tight">
                  <p className="max-w-[160px] truncate text-[12.5px] font-medium text-ink">{att.name}</p>
                  <p className="text-[11px] text-ink-faint">{att.sizeLabel}</p>
                </div>
              </div>
            ))}
          </div>
        )}
        {message.content && (
          <div
            className={`rounded-2xl px-4 py-2.5 text-[14.5px] leading-relaxed ${
              isUser
                ? "rounded-tr-sm bg-accent text-canvas"
                : "rounded-tl-sm border border-border bg-surface text-ink shadow-soft"
            }`}
          >
            {message.pending ? (
              <span className="flex items-center gap-1 py-0.5">
                <span className="animate-dot h-1.5 w-1.5 rounded-full bg-current" style={{ animationDelay: "0ms" }} />
                <span className="animate-dot h-1.5 w-1.5 rounded-full bg-current" style={{ animationDelay: "150ms" }} />
                <span className="animate-dot h-1.5 w-1.5 rounded-full bg-current" style={{ animationDelay: "300ms" }} />
              </span>
            ) : (
              renderContent(message.content)
            )}
          </div>
        )}
      </div>
    </div>
  );
}
