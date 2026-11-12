import Dexie, { type Table } from 'dexie';
import type { Batch, BatchItem, ReviewItem } from './types';

class ManifestDb extends Dexie {
  batches!: Table<Batch, string>;
  items!: Table<BatchItem, string>;
  reviews!: Table<ReviewItem, string>;

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
  }
}

export const db = new ManifestDb();
