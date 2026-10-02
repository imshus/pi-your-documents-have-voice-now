import { NextRequest, NextResponse } from "next/server";
import { warmUp } from "@/lib/warmup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Called fire-and-forget when a call starts. Opens the server's TLS pools to
 * every upstream AND primes the answering model's prompt cache, so the first
 * real turn skips both cold handshakes (~60-300ms each) and cold-prefix
 * latency. The client sends the document it will ask about so full mode primes
 * the SAME scoped prefix the first turn uses.
 */
export async function POST(req: NextRequest) {
  const { document_id } = (await req.json().catch(() => ({}))) as {
    document_id?: string | null;
  };
  const r = await warmUp(typeof document_id === "string" ? document_id : null);
  return NextResponse.json({ ok: true, ...r });
}
