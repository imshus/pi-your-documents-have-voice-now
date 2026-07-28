"use client";

import { SparkIcon } from "./icons";
import { suggestionChips } from "@/lib/mock-data";

export function WelcomeScreen({ onSuggestion }: { onSuggestion: (text: string) => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent text-canvas shadow-lift">
        <SparkIcon className="h-6 w-6" />
      </div>
      <h1 className="mt-5 text-[26px] font-semibold tracking-tight text-ink">Your accounts, answered.</h1>
      <p className="mt-2 max-w-sm text-[14.5px] leading-relaxed text-ink-muted">
        Upload a statement or passbook, then ask Pi anything — by text or by voice.
      </p>

      <div className="mt-8 grid w-full max-w-md grid-cols-1 gap-2 sm:grid-cols-2">
        {suggestionChips.map((chip) => (
          <button
            key={chip}
            onClick={() => onSuggestion(chip)}
            className="rounded-xl border border-border bg-surface px-4 py-3 text-left text-[13.5px] text-ink-muted shadow-soft transition hover:border-accent/40 hover:bg-accent-soft hover:text-ink"
          >
            {chip}
          </button>
        ))}
      </div>
    </div>
  );
}
