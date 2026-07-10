// G5 — camera barcode scanner (ZXing). Reads the Code 128 lot stickers through
// the device camera — works on iPhone Safari + Android Chrome (the native
// BarcodeDetector API is Chrome/Android-only, so ZXing is the cross-device
// choice). Requires HTTPS (Previews/production are) and camera permission.
// The ZXing bundle is imported dynamically so it only loads when the camera
// is actually opened.
import { useEffect, useRef, useState } from 'react';

export default function CameraBarcodeScanner({ onResult, onClose }) {
  const videoRef = useRef(null);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(true);

  useEffect(() => {
    let controls = null;
    let active = true;

    (async () => {
      try {
        const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([
          import('@zxing/browser'),
          import('@zxing/library'),
        ]);
        const hints = new Map();
        // Lot stickers are Code 128; allow QR too in case labels ever carry one.
        hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.CODE_128, BarcodeFormat.QR_CODE]);
        const reader = new BrowserMultiFormatReader(hints);
        controls = await reader.decodeFromConstraints(
          { video: { facingMode: 'environment' } }, // back camera on phones
          videoRef.current,
          (result, err, c) => {
            if (result && active) {
              active = false;
              try { c.stop(); } catch { /* already stopped */ }
              onResult(result.getText());
            }
          }
        );
        if (active) setStarting(false);
      } catch (e) {
        if (!active) return;
        setStarting(false);
        if (e?.name === 'NotAllowedError') setError('Camera permission denied — allow camera access and try again.');
        else if (e?.name === 'NotFoundError') setError('No camera found on this device.');
        else setError('Could not start the camera.');
      }
    })();

    return () => {
      active = false;
      try { controls?.stop(); } catch { /* already stopped */ }
    };
  }, [onResult]);

  return (
    <div className="fixed inset-0 z-50 bg-black bg-opacity-80 flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md bg-white rounded-lg overflow-hidden">
        <div className="flex items-center justify-between p-3 border-b">
          <div className="font-semibold">Scan barcode</div>
          <button onClick={onClose} className="text-gray-600 hover:text-black px-2" aria-label="Close">✕</button>
        </div>
        {error ? (
          <div className="p-4 text-sm text-red-700">{error}</div>
        ) : (
          <>
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video ref={videoRef} className="w-full aspect-[4/3] bg-black object-cover" playsInline muted />
            <div className="p-3 text-xs text-gray-600">
              {starting ? 'Starting camera…' : 'Point the camera at the lot sticker barcode.'}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
