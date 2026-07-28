import { NextResponse } from "next/server";
import { warmUp } from "@/lib/warmup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Called fire-and-forget when a call starts (and on an interval by
 * instrumentation.ts). Opens the server's TLS pools to every upstream AND
 * primes the answering model's prompt cache, so the first real turn skips both
 * cold handshakes (~60-300ms each) and cold-prefix latency.
 */
export async function POST() {
  const r = await warmUp();
  return NextResponse.json({ ok: true, ...r });
}
