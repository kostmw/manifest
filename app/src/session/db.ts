import Dexie, { type Table } from 'dexie';
import type { ImportFile, ImportJob } from './imports';
import type { TestLogEntry } from './testLog';
import type { Batch, BatchItem, ReviewItem } from './types';

class ManifestDb extends Dexie {
  batches!: Table<Batch, string>;
  items!: Table<BatchItem, string>;
  reviews!: Table<ReviewItem, string>;
  testlog!: Table<TestLogEntry, string>;
  imports!: Table<ImportJob, string>;
  importFiles!: Table<ImportFile, [string, string]>;

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
    // M5: bulk imports, and what became of each file, so a reload can say what finished.
    this.version(4).stores({
      imports: 'id, batchId, createdAt',
      importFiles: '[jobId+key], jobId, [batchId+key]',
    });
  }
}

export const db = new ManifestDb();
