import { NextRequest, NextResponse } from "next/server";
import { endConversation } from "@/lib/conversation";

export const runtime = "nodejs";

/**
 * Drops a finished call's server-side message log. Best-effort only — the log
 * expires on its own, so a missed beacon (tab closed mid-flight, offline) just
 * means the entry lingers until the sweep collects it.
 */
export async function POST(req: NextRequest) {
  const { call_id } = (await req.json().catch(() => ({}))) as {
    call_id?: string;
  };
  endConversation(typeof call_id === "string" ? call_id.slice(0, 64) : null);
  return NextResponse.json({ ok: true });
}
