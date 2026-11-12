import { useEffect, useRef } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { BUTTON_PRIMARY, BUTTON_SECONDARY } from './styles';
import { watchForUpdates } from './updates';

/**
 * "A new version is ready": shown when a new version of the app has been
 * downloaded and is waiting. It never reloads by itself, so a scan in progress
 * is never cut off; batches are saved as they change, so reloading loses none.
 */
export function UpdateBanner() {
  const stop = useRef<(() => void) | null>(null);
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, registration) {
      if (registration) stop.current = watchForUpdates(registration);
    },
  });
  useEffect(() => () => stop.current?.(), []);

  if (!needRefresh) return null;
  return (
    <div
      role="status"
      className="fixed inset-x-0 bottom-0 z-20 flex flex-wrap items-center gap-3 bg-zinc-800 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] text-sm shadow-lg"
    >
      <p className="flex-1">A new version of Manifest is ready.</p>
      <button type="button" onClick={() => void updateServiceWorker(true)} className={BUTTON_PRIMARY}>
        Reload
      </button>
      <button type="button" onClick={() => setNeedRefresh(false)} className={BUTTON_SECONDARY}>
        Later
      </button>
    </div>
  );
}
