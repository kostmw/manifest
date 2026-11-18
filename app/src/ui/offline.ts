/**
 * Ready offline: everything scanning and search need is on the device, the
 * whole card index (one build, games/indexBuilds.ts) and the OCR engine. This
 * downloads what is missing in the background, keeps it up to date with the
 * nightly index (games/indexUpdates.ts says when), and holds the state the
 * app shows (OfflineStatus.tsx).
 */
import { useSyncExternalStore } from 'react';
import { checkForIndexUpdate, offlineIndexState, onBuildChange, onStaleBuild } from '../games/indexClient';
import { scheduleIndexUpdates, withUpdateLock } from '../games/indexUpdates';
import type { UpdateProgress } from '../games/indexBuilds';
import { cacheOcrFiles, missingOcrFiles } from './ocrReady';

export interface OfflineStatus {
  /** No Cache Storage here (a private window, or not served over https): nothing can be kept offline. */
  unavailable: boolean;
  /** When the card index in use was built (ISO). Null before the first one. */
  buildDate: string | null;
  /** Everything scanning and search need is on the device. Null until looked at. */
  ready: boolean | null;
  /** A download under way: the first full one, or a newer build while the current one stays in use. */
  download: { percent: number; updating: boolean; buildDate: string } | null;
  /** The last download stopped for want of space on the device. */
  noRoom: boolean;
  /** The browser has promised not to clear this site's storage to free space (navigator.storage.persist). */
  persisted: boolean | null;
}

let status: OfflineStatus = { unavailable: false, buildDate: null, ready: null, download: null, noRoom: false, persisted: null };
const listeners = new Set<() => void>();

function update(patch: Partial<OfflineStatus>): void {
  status = { ...status, ...patch };
  listeners.forEach((listener) => listener());
}

export function useOfflineStatus(): OfflineStatus {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => status,
  );
}

/** Works out from the caches alone whether the app would work offline now. */
async function lookAtDevice(): Promise<void> {
  const index = await offlineIndexState().catch(() => null);
  if (!index) {
    update({ unavailable: true, ready: false });
    return;
  }
  const ocrMissing = await missingOcrFiles().catch(() => ['?']);
  update({ buildDate: index.build?.buildDate ?? null, ready: Boolean(index.build) && index.missing === 0 && ocrMissing.length === 0 });
}

let persistAsked = false;

/** Asks the browser to keep the card data when the device runs low on space. Safari decides by its own rules (a home-screen app is one). */
async function askToPersist(): Promise<void> {
  if (persistAsked) return;
  persistAsked = true;
  try {
    const kept = (await navigator.storage?.persisted?.()) || (await navigator.storage?.persist?.());
    update({ persisted: Boolean(kept) });
  } catch {
    // Not supported: storage stays best-effort.
  }
}

/** Between two files of a background download: a turn for everything else on the main thread. */
const yieldToApp = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function onProgress(progress: UpdateProgress): void {
  const finished = progress.done >= progress.total;
  if (!progress.updating && !finished) void askToPersist();
  update({
    download: finished ? null : { percent: Math.floor((100 * progress.bytes) / Math.max(1, progress.totalBytes)), updating: progress.updating, buildDate: progress.buildDate },
  });
}

/** One check: the OCR files, then the card index; then what the device now has. */
async function check(): Promise<{ kind: string }> {
  await lookAtDevice();
  if (status.unavailable) return { kind: 'unavailable' };
  const outcome = await withUpdateLock(async () => {
    let ocrCached = true;
    if (navigator.onLine) ocrCached = await cacheOcrFiles(await missingOcrFiles());
    const result = await checkForIndexUpdate({ onProgress, pause: yieldToApp });
    // The index is all here but the OCR files couldn't be cached yet (no service worker in control): try again soon.
    if (!ocrCached && (result.kind === 'installed' || result.kind === 'up-to-date' || result.kind === 'switched')) return { kind: 'incomplete' };
    return result;
  });
  update({ download: null, noRoom: outcome.kind === 'storage' });
  await lookAtDevice();
  return outcome;
}

/** Starts the background downloads and checks. Main thread only. */
export function startOfflineUpdates(): () => void {
  void lookAtDevice();
  void navigator.storage?.persisted?.().then((kept) => update({ persisted: kept }), () => {});
  const stopBuildChanges = onBuildChange((manifest) => update({ buildDate: manifest.buildDate }));
  const stopChecks = scheduleIndexUpdates({
    check,
    onStale: onStaleBuild,
    page: document,
    win: window as unknown as Parameters<typeof scheduleIndexUpdates>[0]['win'],
    now: Date.now,
  });
  return () => {
    stopBuildChanges();
    stopChecks();
  };
}
