import { NextRequest, NextResponse } from "next/server";
import { retrieve } from "@/lib/retrieval";

export const runtime = "nodejs";

/**
 * RAG retrieval (hybrid semantic + lexical, RRF-fused). Used by the voice
 * agent during a call and directly for debugging retrieval quality.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    query?: string;
    document_id?: string | null;
    top_k?: number;
  };

  const query = (body.query ?? "").trim();
  if (!query) {
    return NextResponse.json({ error: "Missing `query`." }, { status: 400 });
  }

  // Coerce before clamping: Math.min/max propagate NaN, which reached the SQL
  // LIMIT and collapsed the result set.
  const k = Number(body.top_k);
  const topK = Number.isFinite(k) ? Math.min(Math.max(Math.trunc(k), 1), 20) : 8;

  try {
    const results = await retrieve(query, body.document_id ?? null, topK);
    return NextResponse.json({ query, results });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
