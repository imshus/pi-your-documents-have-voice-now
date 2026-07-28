import { NextRequest, NextResponse } from "next/server";
import { speak } from "@/lib/sarvam";

export const runtime = "nodejs";

function streamOut(upstream: Response): Response {
  return new Response(upstream.body, {
    headers: {
      // Sarvam's stream endpoint labels the body application/octet-stream, which
      // the browser's <audio> element refuses to decode — so the progressive
      // attempt in SpeechQueue.playOne fails and re-fetches via the blob path,
      // doubling every TTS request. We always request mp3 (output_audio_codec),
      // so force the correct type and the streaming element plays on first try.
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-store",
    },
  });
}

/**
 * GET streams audio for `?text=` — an <audio src> pointing here starts playing
 * on the first synthesized chunk, which is the whole point of the streaming
 * transport. The browser begins buffering the moment the element is created,
 * so synthesis overlaps with whatever is still being spoken.
 */
export async function GET(req: NextRequest) {
  const text = (req.nextUrl.searchParams.get("text") ?? "").trim();
  if (!text) {
    return NextResponse.json({ error: "Missing `text`." }, { status: 400 });
  }

  try {
    return streamOut(await speak(text));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}

/** POST variant for scripted checks (verify.mjs). Same stream out. */
export async function POST(req: NextRequest) {
  const { text } = (await req.json().catch(() => ({}))) as { text?: string };
  if (!text?.trim()) {
    return NextResponse.json({ error: "Missing `text`." }, { status: 400 });
  }

  try {
    return streamOut(await speak(text.trim()));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
