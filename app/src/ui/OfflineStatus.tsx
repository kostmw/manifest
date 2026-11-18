import { useSyncExternalStore } from 'react';
import { debugEnabled } from './debug';
import { useOfflineStatus } from './offline';
import { offlineLine, offlineNotice } from './offlineText';

function useOnline(): boolean {
  return useSyncExternalStore(
    (listener) => {
      window.addEventListener('online', listener);
      window.addEventListener('offline', listener);
      return () => {
        window.removeEventListener('online', listener);
        window.removeEventListener('offline', listener);
      };
    },
    () => navigator.onLine,
  );
}

/** The footer's line: which card data is in use and whether it works offline. */
export function OfflineLine() {
  const status = useOfflineStatus();
  const online = useOnline();
  const line = offlineLine(status, online, debugEnabled());
  return line ? (
    <p data-testid="offline-status" className="mb-1 text-zinc-400">
      {line}
    </p>
  ) : null;
}

/** In the page, under the update banner: the first download's progress, or that there is no room for it. */
export function OfflineNotice() {
  const notice = offlineNotice(useOfflineStatus());
  if (!notice) return null;
  return (
    <p role={notice.alert ? 'alert' : 'status'} className={`rounded-xl p-3 text-sm ${notice.alert ? 'bg-amber-950 text-amber-200' : 'bg-zinc-800 text-zinc-300'}`}>
      {notice.text}
    </p>
  );
}
