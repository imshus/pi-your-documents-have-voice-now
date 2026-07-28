export type DocumentSummary = {
  id: string;
  created_at: string;
  file_name: string;
  mime_type: string | null;
  doc_type: string | null;
  title: string | null;
  summary: string | null;
};

export type AttachmentKind = "pdf" | "image" | "file";

export type Attachment = {
  id: string;
  name: string;
  kind: AttachmentKind;
  sizeLabel: string;
};

export type MessageRole = "user" | "assistant";

export type ChatMessage = {
  id: string;
  role: MessageRole;
  content: string;
  attachments?: Attachment[];
  pending?: boolean;
};
