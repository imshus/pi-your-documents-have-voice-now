import { NextResponse } from "next/server";
import {
  grantDeepgramToken,
  buildListenUrl,
  DEEPGRAM_MODEL,
  SAMPLE_RATE,
  CHUNK_SAMPLES,
} from "@/lib/deepgram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Short-lived Deepgram credential + the socket config the browser should use. */
export async function POST() {
  try {
    const { access_token, expires_in } = await grantDeepgramToken();
    return NextResponse.json({
      access_token,
      expires_in,
      listen_url: buildListenUrl(),
      model: DEEPGRAM_MODEL,
      sample_rate: SAMPLE_RATE,
      chunk_samples: CHUNK_SAMPLES,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
