import { useEffect, useRef } from "react";
import { BrowserMultiFormatReader, IScannerControls, Result } from "@zxing/browser";

type Props = {
  deviceId?: string | null;         // puede venir null
  onResult: (text: string) => void; // callback con el texto del QR
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
        // Si deviceId es null, pasamos undefined
        const devId = deviceId || undefined;

        controlsRef.current = await readerRef.current!.decodeFromVideoDevice(
          devId,
          videoRef.current!,
          (result: Result | undefined, err) => {
            if (result) onResult(result.getText());
            // errores de decodificación por frame se ignoran
            else if (err && onError) onError(err);
          }
        );
      } catch (e) {
        if (onError) onError(e);
      }
    }

    if (videoRef.current) start();

    return () => {
      // Detener de forma correcta
      controlsRef.current?.stop();
      controlsRef.current = null;
    };
    // Reiniciar si cambia la cámara
  }, [deviceId, onResult, onError]);

  return <video ref={videoRef} className={className} muted playsInline />;
}
