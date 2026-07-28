import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, DOCUMENTS_BUCKET } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const full = req.nextUrl.searchParams.get("full") === "1";
  const columns = full
    ? "id, created_at, file_name, mime_type, doc_type, title, summary, data"
    : "id, created_at, file_name, mime_type, doc_type, title, summary";

  try {
    const { data, error } = await supabaseAdmin()
      .from("documents")
      .select(columns)
      .order("created_at", { ascending: false })
      .limit(200);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ documents: data ?? [] });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Missing ?id=" }, { status: 400 });
  }

  try {
    const db = supabaseAdmin();

    // Remove the stored original too — otherwise deleted documents leave
    // orphaned files in the bucket forever. Best-effort: a missing file must
    // not block deleting the record.
    const { data: doc } = await db
      .from("documents")
      .select("storage_path")
      .eq("id", id)
      .single();
    if (doc?.storage_path) {
      await db.storage.from(DOCUMENTS_BUCKET).remove([doc.storage_path]);
    }

    // doc_chunks cascades on delete.
    const { error } = await db.from("documents").delete().eq("id", id);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
