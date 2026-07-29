"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import DocTable from "../components/DocTable";
import type { ExtractedDocument } from "@/lib/supabase";

type DocRow = {
  id: string;
  created_at: string;
  file_name: string;
  doc_type: string | null;
  title: string | null;
  summary: string | null;
  data: ExtractedDocument;
};

export default function DocumentsPage() {
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null); // else a transient failure pins the banner forever
    try {
      const res = await fetch("/api/documents?full=1");
      const json = await res.json();
      if (json.error) setError(json.error);
      else setDocs(json.documents as DocRow[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function remove(id: string) {
    if (!confirm("Delete this document and its indexed chunks?")) return;
    // A failed delete used to be swallowed: the row stayed, the user saw
    // nothing, and the agent kept answering from a document they thought gone.
    try {
      const res = await fetch(`/api/documents?id=${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? `Delete failed (${res.status}).`);
        return;
      }
      setError(null);
      setDocs((prev) => prev.filter((d) => d.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Indexed documents</h1>
          <p className="mt-1 text-sm text-neutral-400">
            Everything the voice agent can currently read from.
          </p>
        </div>
        <button
          onClick={load}
          className="rounded-lg border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 hover:border-neutral-500"
        >
          Refresh
        </button>
      </div>

      {error && (
        <p className="rounded-lg border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">
          {error}
        </p>
      )}

      {loading && <p className="text-sm text-neutral-500">Loading…</p>}

      {!loading && !error && docs.length === 0 && (
        <p className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-6 text-sm text-neutral-400">
          Nothing indexed yet.{" "}
          <Link href="/" className="text-emerald-400 hover:underline">
            Upload a document
          </Link>{" "}
          to get started.
        </p>
      )}

      <ul className="space-y-3">
        {docs.map((d) => (
          <li
            key={d.id}
            className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-4"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="truncate font-medium">{d.title ?? d.file_name}</p>
                <p className="mt-0.5 text-xs text-neutral-500">
                  {d.doc_type ?? "unknown"} · {d.file_name} ·{" "}
                  {new Date(d.created_at).toLocaleString()}
                </p>
                <p className="mt-2 text-sm text-neutral-300">{d.summary}</p>
              </div>
              <button
                onClick={() => remove(d.id)}
                className="flex shrink-0 items-center gap-1.5 rounded-lg border border-red-900/60 bg-red-950/30 px-3 py-1.5 text-xs font-medium text-red-300 transition hover:border-red-700 hover:bg-red-950/60 hover:text-red-200"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3.5 w-3.5">
                  <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
                </svg>
                Delete
              </button>
            </div>

            {d.data.tables.map((t, i) => (
              <DocTable
                key={i}
                name={t.name}
                columns={t.columns}
                rows={t.rows}
                defaultOpen={i === 0}
              />
            ))}

            <button
              onClick={() => setOpen(open === d.id ? null : d.id)}
              className="mt-3 text-xs text-neutral-400 hover:text-neutral-200"
            >
              {open === d.id ? "Hide JSON" : "View JSON"}
            </button>

            {open === d.id && (
              <pre className="mt-2 max-h-96 overflow-auto rounded-lg bg-neutral-950 p-3 text-[11px] leading-relaxed text-neutral-300">
                {JSON.stringify(d.data, null, 2)}
              </pre>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
