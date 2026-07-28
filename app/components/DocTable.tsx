"use client";

type Props = {
  name: string;
  columns: string[];
  rows: string[][];
  /** Expanded by default? Documents page opens the first table. */
  defaultOpen?: boolean;
};

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Renders one extracted table with real rows/columns + CSV download. */
export default function DocTable({ name, columns, rows, defaultOpen }: Props) {
  function downloadCsv() {
    const csv = [columns, ...rows]
      .map((r) => r.map((c) => csvEscape(c ?? "")).join(","))
      .join("\r\n");
    // BOM so Excel opens UTF-8 (Devanagari etc.) correctly.
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${name.replace(/[^\w\- ]+/g, "").trim() || "table"}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <details open={defaultOpen} className="mt-3 rounded-lg border border-neutral-800 bg-neutral-950/60">
      <summary className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-xs text-neutral-300 hover:text-neutral-100">
        <span>
          Table: <span className="font-medium">{name}</span> — {rows.length} rows ×{" "}
          {columns.length} columns
        </span>
        <button
          onClick={(e) => {
            e.preventDefault();
            downloadCsv();
          }}
          className="rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-300 transition hover:border-neutral-500 hover:text-white"
        >
          Download CSV
        </button>
      </summary>

      <div className="max-h-96 overflow-auto">
        <table className="w-full border-collapse text-[11px] leading-tight">
          <thead className="sticky top-0 bg-neutral-900">
            <tr>
              {columns.map((c, i) => (
                <th
                  key={i}
                  className="whitespace-nowrap border-b border-neutral-700 px-2 py-1.5 text-left font-medium text-neutral-300"
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri} className={ri % 2 ? "bg-neutral-900/40" : ""}>
                {columns.map((_, ci) => (
                  <td
                    key={ci}
                    className="whitespace-nowrap border-b border-neutral-800/60 px-2 py-1 text-neutral-400"
                  >
                    {row[ci] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
