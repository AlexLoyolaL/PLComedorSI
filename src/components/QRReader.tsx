import { useEffect, useRef } from "react";
import { BrowserMultiFormatReader } from "@zxing/browser";
import type { IScannerControls } from "@zxing/browser";
import type { Result } from "@zxing/library";

type Props = {
  deviceId?: string | null;
  onResult: (text: string) => void;
  onError?: (err: unknown) => void;
  className?: string;
};

export default function QRReader({ deviceId, onResult, onError, className }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const readerRef = useRef<BrowserMultiFormatReader | null>(null);
  const controlsRef = useRef<IScannerControls | null>(null);

  useEffect(() => {
    readerRef.current = new BrowserMultiFormatReader();

    async function start() {
      try {
        const devId = deviceId || undefined; // null -> undefined
        controlsRef.current = await readerRef.current!.decodeFromVideoDevice(
          devId,
          videoRef.current!,
          (result: Result | undefined, err) => {
            if (result) onResult(result.getText());
            else if (err && onError) onError(err);
          }
        );
      } catch (e) {
        if (onError) onError(e);
      }
    }

    if (videoRef.current) start();

    return () => {
      controlsRef.current?.stop(); // detener correctamente
      controlsRef.current = null;
    };
  }, [deviceId, onResult, onError]);

  return <video ref={videoRef} className={className} muted playsInline />;
}
