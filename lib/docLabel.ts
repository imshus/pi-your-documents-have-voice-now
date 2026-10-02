/**
 * How a document is named in a picker.
 *
 * The date is not decoration. This corpus holds two packing lists that are
 * different VERSIONS of the same job — same item numbers, different rates — so
 * their titles are near-identical and the upload date is the only thing that
 * tells them apart. Without it the caller cannot tell which one they are
 * scoping to, and "item 5 ka amount" silently has two correct answers.
 */
export type DocLike = {
  file_name: string;
  title?: string | null;
  doc_type?: string | null;
  created_at?: string | null;
};

/** "12 Jul 2026, 4:03 pm" — short, unambiguous, local time. */
export function formatDocDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Picker label: the document's name plus when it was uploaded. */
export function docLabel(doc: DocLike): string {
  const name = doc.title?.trim() || doc.file_name;
  const when = formatDocDate(doc.created_at);
  return when ? `${name} — ${when}` : name;
}
