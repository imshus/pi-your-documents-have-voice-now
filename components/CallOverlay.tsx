"use client";

import { useEffect, useRef, useState } from "react";
import { MicIcon, PhoneOffIcon, SparkIcon } from "./icons";
import { getCallScript } from "@/lib/mock-data";

function formatDuration(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const barHeights = [40, 70, 100, 55, 85, 60, 95, 45];

export function CallOverlay({
  onEnd,
}: {
  onEnd: (durationLabel: string, topic: string) => void;
}) {
  const [seconds, setSeconds] = useState(0);
  const [lines, setLines] = useState<{ speaker: "agent" | "caller"; line: string }[]>([]);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const script = useRef(getCallScript());

  useEffect(() => {
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const timeouts: ReturnType<typeof setTimeout>[] = [];
    script.current.forEach((entry, i) => {
      const t = setTimeout(() => {
        setLines((prev) => [...prev, entry]);
      }, 900 + i * 1600);
      timeouts.push(t);
    });
    return () => timeouts.forEach(clearTimeout);
  }, []);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" });
  }, [lines]);

  return (
    <div className="animate-fade-up fixed inset-0 z-50 flex flex-col bg-canvas">
      <div className="flex items-center justify-between px-6 pt-6">
        <div className="flex items-center gap-2 text-ink-muted">
          <span className="h-2 w-2 rounded-full bg-ink" />
          <span className="text-[13px] font-medium">{formatDuration(seconds)}</span>
        </div>
        <p className="text-[13px] font-medium text-ink-faint">Voice call · Hindi/English</p>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center gap-8 px-6">
        <div className="relative flex h-32 w-32 items-center justify-center">
          <span className="animate-pulse-ring absolute h-24 w-24 rounded-full bg-accent/30" />
          <span className="absolute h-24 w-24 rounded-full bg-accent/10" />
          <div className="relative flex h-24 w-24 items-center justify-center rounded-full bg-accent text-canvas shadow-lift">
            <SparkIcon className="h-9 w-9" />
          </div>
        </div>

        <div className="text-center">
          <p className="text-[16px] font-semibold text-ink">Pi is listening</p>
          <p className="mt-1 text-[13px] text-ink-faint">Speak naturally — interrupt anytime</p>
        </div>

        <div className="flex h-10 items-end gap-1.5">
          {barHeights.map((h, i) => (
            <span
              key={i}
              className="animate-bar w-1.5 rounded-full bg-accent"
              style={{ height: `${h}%`, animationDelay: `${i * 90}ms` }}
            />
          ))}
        </div>

        <div
          ref={transcriptRef}
          className="flex w-full max-w-md flex-col gap-2.5 overflow-y-auto rounded-2xl border border-border bg-surface px-4 py-4 shadow-soft"
          style={{ maxHeight: "220px", minHeight: "80px" }}
        >
          {lines.length === 0 && (
            <p className="text-center text-[12.5px] italic text-ink-faint">Transcript will appear here…</p>
          )}
          {lines.map((l, i) => (
            <p key={i} className={`animate-fade-up text-[13px] leading-snug ${l.speaker === "agent" ? "text-ink" : "text-ink-muted"}`}>
              <span className="font-semibold">{l.speaker === "agent" ? "Pi: " : "You: "}</span>
              {l.line}
            </p>
          ))}
        </div>
      </div>

      <div className="flex flex-col items-center gap-3 pb-10">
        <button
          onClick={() => {
            const topic = lines.some((l) => l.line.toLowerCase().includes("balance"))
              ? "asked about account balance"
              : "general enquiry";
            onEnd(formatDuration(seconds), topic);
          }}
          className="flex h-14 w-14 items-center justify-center rounded-full bg-red-500 text-white shadow-lift transition hover:bg-red-600"
          aria-label="End call"
        >
          <PhoneOffIcon className="h-5 w-5" />
        </button>
        <p className="text-[12px] text-ink-faint">End call</p>
      </div>
    </div>
  );
}
