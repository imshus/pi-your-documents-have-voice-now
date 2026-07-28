"use client";

import { SparkIcon } from "./icons";

export function WelcomeScreen() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent text-canvas shadow-lift">
        <SparkIcon className="h-6 w-6" />
      </div>
      <h1 className="mt-5 text-[26px] font-semibold tracking-tight text-ink">Your documents have voice now.</h1>
      <p className="mt-2 max-w-sm text-[14.5px] leading-relaxed text-ink-muted">
        Upload any document — statement, invoice, spreadsheet — then ask Pi anything, by text or by voice.
      </p>
    </div>
  );
}
