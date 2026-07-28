export type AttachmentKind = "pdf" | "image";

export interface Attachment {
  id: string;
  name: string;
  kind: AttachmentKind;
  sizeLabel: string;
}

export type MessageRole = "user" | "assistant";

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  attachments?: Attachment[];
  pending?: boolean;
  callSummary?: {
    durationLabel: string;
    topic: string;
  };
}

export type DocumentStatus = "processing" | "indexed";

export interface DocumentItem {
  id: string;
  name: string;
  kind: AttachmentKind;
  status: DocumentStatus;
  uploadedLabel: string;
  holder?: string;
  accountMasked?: string;
  ifsc?: string;
  balance?: string;
}

export const seedDocuments: DocumentItem[] = [
  {
    id: "doc-1",
    name: "HDFC_Savings_Statement.pdf",
    kind: "pdf",
    status: "indexed",
    uploadedLabel: "2 days ago",
    holder: "Rohan Mehta",
    accountMasked: "•••• •••• 4471",
    ifsc: "HDFC0001234",
    balance: "₹1,84,320.55",
  },
  {
    id: "doc-2",
    name: "ICICI_Passbook_Page3.jpg",
    kind: "image",
    status: "indexed",
    uploadedLabel: "5 days ago",
    holder: "Rohan Mehta",
    accountMasked: "•••• •••• 8890",
    ifsc: "ICIC0000512",
    balance: "₹42,110.00",
  },
];

export const suggestionChips: string[] = [
  "Upload a bank statement",
  "What's my savings account balance?",
  "Find my IFSC code",
  "Start a voice call",
];

const callScript: Array<{ speaker: "agent" | "caller"; line: string }> = [
  { speaker: "agent", line: "Namaste! Main Pi hoon. Aapke documents ke baare mein kuch bhi puch sakte hain." },
  { speaker: "caller", line: "Mera HDFC account ka balance kitna hai?" },
  { speaker: "agent", line: "Aapke HDFC savings account mein ₹1,84,320.55 hai, as of the last statement." },
  { speaker: "caller", line: "Aur IFSC code?" },
  { speaker: "agent", line: "IFSC code hai HDFC0001234, branch details bhi statement mein hain." },
];

export function getCallScript() {
  return callScript;
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function generateAssistantReply(userText: string, hasDocuments: boolean): string {
  const text = userText.toLowerCase();

  if (!hasDocuments) {
    return "Mujhe abhi tak koi document nahi mila. `+` icon se ek bank statement ya passbook upload kariye, phir main uske details ke baare mein bata sakta hoon.";
  }

  if (text.includes("balance")) {
    return "Aapke HDFC savings account (•••• 4471) mein **₹1,84,320.55** hai, aur ICICI account (•••• 8890) mein **₹42,110.00** — dono last uploaded statement ke hisaab se.";
  }

  if (text.includes("ifsc") || text.includes("branch")) {
    return "HDFC account ka IFSC hai **HDFC0001234**, aur ICICI account ka **ICIC0000512**.";
  }

  if (text.includes("holder") || text.includes("name")) {
    return "Dono accounts **Rohan Mehta** ke naam par registered hain.";
  }

  const fallbacks = [
    "Aapke uploaded documents ke hisaab se, yeh detail mujhe abhi visible nahi hai — thoda specific poochiye, jaise balance, IFSC, ya branch.",
    "Main sirf uploaded documents se answer deta hoon. Kya aap balance, account number, ya IFSC ke baare mein poochna chahenge?",
  ];
  return pick(fallbacks);
}
