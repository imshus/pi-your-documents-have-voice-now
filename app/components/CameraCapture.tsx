"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Props = {
  onCapture: (file: File) => void;
  onClose: () => void;
};

/**
 * Live camera view for photographing a document. Prefers the rear camera on
 * phones and falls back to whatever the device offers. Stays open after a shot
 * so several pages can be captured in a row.
 */
export default function CameraCapture({ onCapture, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shots, setShots] = useState(0);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError("This browser does not expose a camera. Use the + button instead.");
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
      } catch (err) {
        setError(
          err instanceof Error
            ? `Camera unavailable: ${err.message}`
            : "Camera unavailable."
        );
      }
    })();

    return () => {
      cancelled = true;
      stop();
    };
  }, [stop]);

  // Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function close() {
    stop();
    onClose();
  }

  function shoot() {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0);

    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        onCapture(new File([blob], `capture-${stamp}.jpg`, { type: "image/jpeg" }));
        setShots((n) => n + 1);
      },
      "image/jpeg",
      0.92
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/95 p-4">
      <div className="flex items-center justify-between text-sm text-neutral-300">
        <span>
          Camera{shots > 0 && ` — ${shots} captured`}
        </span>
        <button onClick={close} className="rounded-lg px-3 py-1 hover:bg-neutral-800">
          Done
        </button>
      </div>

      <div className="flex flex-1 items-center justify-center">
        {error ? (
          <p className="max-w-sm text-center text-sm text-red-300">{error}</p>
        ) : (
          <video
            ref={videoRef}
            playsInline
            muted
            className="max-h-full max-w-full rounded-xl"
          />
        )}
      </div>

      <div className="flex justify-center pb-4 pt-3">
        <button
          onClick={shoot}
          disabled={!!error}
          aria-label="Capture photo"
          className="h-16 w-16 rounded-full border-4 border-white bg-white/20 transition active:scale-95 disabled:opacity-30"
        />
      </div>
    </div>
  );
}
