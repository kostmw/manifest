import { useEffect, useRef } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { removeOldOcrCopies } from './ocrStorage';
import { BUTTON_SECONDARY } from './styles';
import { watchForUpdates } from './updates';

declare const __OCR_DIR__: string;
declare const __OCR_PRECACHED__: string[];
/** Old OCR copies are tidied away this long after start-up, out of the way of the first scan. */
const OCR_CLEANUP_DELAY_MS = 10_000;

/**
 * "Update ready": shown when a new version of the app has been downloaded and
 * is waiting. It never reloads by itself, so a scan in progress is never cut
 * off; batches are saved as they change, so reloading loses none. It sits in
 * the page under the tabs, never over a bottom bar (the Review tab's "Add N
 * cards" was right under it), and Reload is a plain button.
 */
export function UpdateBanner() {
  const stop = useRef<(() => void) | null>(null);
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, registration) {
      if (!registration) return;
      stop.current = watchForUpdates(registration);
      // Once a service worker is active, its precache is complete: remove the OCR copies it replaces.
      void navigator.serviceWorker.ready.then(() => {
        setTimeout(() => void removeOldOcrCopies(__OCR_DIR__, __OCR_PRECACHED__), OCR_CLEANUP_DELAY_MS);
      });
    },
  });
  useEffect(() => () => stop.current?.(), []);

  if (!needRefresh) return null;
  return (
    <div role="status" className="flex flex-wrap items-center gap-2 rounded-xl bg-zinc-800 p-3 text-sm">
      <p className="min-w-0 flex-1">Update ready. Reload any time: your cards are saved.</p>
      <button type="button" onClick={() => void updateServiceWorker(true)} className={`${BUTTON_SECONDARY} bg-zinc-700`}>
        Reload
      </button>
      <button type="button" onClick={() => setNeedRefresh(false)} className={`${BUTTON_SECONDARY} bg-zinc-700`}>
        Later
      </button>
    </div>
  );
}
