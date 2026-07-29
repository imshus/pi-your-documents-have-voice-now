export type DocumentSummary = {
  id: string;
  created_at: string;
  file_name: string;
  mime_type: string | null;
  doc_type: string | null;
  title: string | null;
  summary: string | null;
};
