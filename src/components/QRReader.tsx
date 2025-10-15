import { BrowserMultiFormatReader } from "@zxing/browser";
import { useEffect, useRef } from "react";

export function QRReader({ onText }: { onText: (txt: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const reader = new BrowserMultiFormatReader();
    let cancelled = false;

    (async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      if (videoRef.current) videoRef.current.srcObject = stream;

      reader.decodeFromVideoDevice(null, videoRef.current!, (res) => {
        if (cancelled) return;
        const txt = res?.getText();
        if (txt) onText(txt);
      });
    })();

    return () => { cancelled = true; try { reader.reset(); } catch {} };
  }, [onText]);

  return <video ref={videoRef} autoPlay muted playsInline style={{ width: "100%", borderRadius: 8 }} />;
}
