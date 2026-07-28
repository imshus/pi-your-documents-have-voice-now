"use client";

import { useEffect, useRef, useState } from "react";
import { FileTextIcon, ImageIcon, MicIcon, PhoneIcon, PlusIcon, SendIcon, XIcon } from "./icons";

export interface PendingFile {
  file: File;
  kind: "pdf" | "image";
}

export function ChatInput({
  onSend,
  onStartCall,
}: {
  onSend: (text: string, files: PendingFile[]) => void;
  onStartCall: () => void;
}) {
  const [text, setText] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!textareaRef.current) return;
    textareaRef.current.style.height = "auto";
    textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 160)}px`;
  }, [text]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  function handleFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList).map((file) => ({
      file,
      kind: (file.type === "application/pdf" ? "pdf" : "image") as "pdf" | "image",
    }));
    setPendingFiles((prev) => [...prev, ...files]);
    setMenuOpen(false);
  }

  function removeFile(index: number) {
    setPendingFiles((prev) => prev.filter((_, i) => i !== index));
  }

  function handleSubmit() {
    if (!text.trim() && pendingFiles.length === 0) return;
    onSend(text.trim(), pendingFiles);
    setText("");
    setPendingFiles([]);
  }

  const canSend = text.trim().length > 0 || pendingFiles.length > 0;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-5 pt-2 md:px-0">
      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf,image/*"
        multiple
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
      />
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
      />

      <div className="rounded-2xl border border-border bg-surface shadow-lift">
        {pendingFiles.length > 0 && (
          <div className="flex flex-wrap gap-2 border-b border-border-soft px-4 pb-3 pt-3.5">
            {pendingFiles.map((pf, i) => (
              <div
                key={`${pf.file.name}-${i}`}
                className="flex items-center gap-2 rounded-lg border border-border bg-canvas px-2.5 py-1.5"
              >
                <div className="flex h-6 w-6 items-center justify-center rounded-md bg-accent-soft text-accent-strong">
                  {pf.kind === "pdf" ? <FileTextIcon className="h-3.5 w-3.5" /> : <ImageIcon className="h-3.5 w-3.5" />}
                </div>
                <span className="max-w-[140px] truncate text-[12.5px] font-medium text-ink">{pf.file.name}</span>
                <button
                  onClick={() => removeFile(i)}
                  className="text-ink-faint transition hover:text-ink"
                  aria-label="Remove attachment"
                >
                  <XIcon className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-end gap-2 px-3 py-2.5">
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setMenuOpen((v) => !v)}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-ink-muted transition hover:bg-border-soft hover:text-ink"
              aria-label="Add attachment"
            >
              <PlusIcon className="h-4.5 w-4.5" />
            </button>

            {menuOpen && (
              <div className="animate-fade-up absolute bottom-12 left-0 z-20 w-56 overflow-hidden rounded-xl border border-border bg-surface-raised py-1.5 shadow-lift">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-[13.5px] text-ink transition hover:bg-border-soft"
                >
                  <FileTextIcon className="h-4 w-4 text-ink-muted" />
                  Upload document
                </button>
                <button
                  onClick={() => cameraInputRef.current?.click()}
                  className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-[13.5px] text-ink transition hover:bg-border-soft"
                >
                  <ImageIcon className="h-4 w-4 text-ink-muted" />
                  Take a photo
                </button>
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    onStartCall();
                  }}
                  className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-[13.5px] text-ink transition hover:bg-border-soft"
                >
                  <PhoneIcon className="h-4 w-4 text-ink-muted" />
                  Start a voice call
                </button>
              </div>
            )}
          </div>

          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmit();
              }
            }}
            rows={1}
            placeholder="Message Pi…"
            className="max-h-40 flex-1 resize-none overflow-hidden bg-transparent py-1.5 text-[14.5px] text-ink placeholder:text-ink-faint focus:outline-none"
          />

          {canSend ? (
            <button
              onClick={handleSubmit}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-canvas transition hover:bg-accent-strong"
              aria-label="Send message"
            >
              <SendIcon className="h-4 w-4" />
            </button>
          ) : (
            <button
              onClick={onStartCall}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-ink-muted transition hover:bg-border-soft hover:text-ink"
              aria-label="Start voice call"
            >
              <MicIcon className="h-4.5 w-4.5" />
            </button>
          )}
        </div>
      </div>
      <p className="mt-2.5 text-center text-[11px] text-ink-faint">
        Pi reads only what you upload. It can make mistakes — verify important details.
      </p>
    </div>
  );
}
