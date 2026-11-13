import Dexie, { type Table } from 'dexie';
import type { TestLogEntry } from './testLog';
import type { Batch, BatchItem, ReviewItem } from './types';

class ManifestDb extends Dexie {
  batches!: Table<Batch, string>;
  items!: Table<BatchItem, string>;
  reviews!: Table<ReviewItem, string>;
  testlog!: Table<TestLogEntry, string>;

  constructor() {
    super('manifest');
    this.version(1).stores({
      batches: 'id, createdAt',
      items: 'id, batchId, [batchId+mergeKey]',
    });
    // M4: scanned cards waiting for review.
    this.version(2).stores({
      reviews: 'id, batchId, createdAt',
    });
    // The test log (testLog.ts): reads and follow-up events.
    this.version(3).stores({
      testlog: 'id, at, kind',
    });
  }
}

export const db = new ManifestDb();
