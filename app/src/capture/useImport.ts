/** The app's one bulk import (see importQueue.ts), wired to the recognition worker and the batch. */
import { useEffect, useSyncExternalStore } from 'react';
import { loadedRecognizer } from '../recognize/useRecognizer';
import { db } from '../session/db';
import { intake } from '../session/intake';
import { testLogEnabled } from '../session/testLog';
import { logOutcome, recordRead } from '../session/testLogRecord';
import { cameraResolution } from '../ui/debug';
import { soundMode } from '../ui/feedback';
import { ImportRunner, type ImportView } from './importQueue';
import { holdScreenOn } from './useWakeLock';

let release: (() => void) | null = null;

export const imports = new ImportRunner({
  read: async (file, batch) => (await loadedRecognizer(batch.game)).importFile(file, { lockSets: batch.settings.lockSets ?? [] }),
  batch: (id) => db.batches.get(id),
  file: async (batch, scan, timings) => {
    const scanId = crypto.randomUUID();
    const outcome = await intake(batch, scan, 'file', scanId);
    if (testLogEnabled()) {
      void recordRead({
        id: scanId,
        source: 'file',
        scan,
        outcome: logOutcome(outcome),
        settings: {
          camera: cameraResolution(),
          flashlight: false,
          lockSets: batch.settings.lockSets ?? [],
          foil: batch.settings.foil === true,
          lang: batch.settings.defaultLang,
          condition: batch.settings.defaultCondition,
          sound: soundMode(),
        },
        timings,
        live: null,
      });
    }
    return outcome;
  },
  keepAwake: (on) => {
    if (on && !release) release = holdScreenOn();
    if (!on && release) {
      release();
      release = null;
    }
  },
  now: () => Date.now(),
});

/** The import running or last finished, and its summary until it is closed; null when there's none. */
export function useImport(): ImportView | null {
  useEffect(() => {
    void imports.restore();
  }, []);
  return useSyncExternalStore(imports.subscribe, imports.getSnapshot);
}
