import Dexie, { type Table } from 'dexie';
import type { Batch, BatchItem } from './types';

class ManifestDb extends Dexie {
  batches!: Table<Batch, string>;
  items!: Table<BatchItem, string>;

  constructor() {
    super('manifest');
    this.version(1).stores({
      batches: 'id, createdAt',
      items: 'id, batchId, [batchId+mergeKey]',
    });
  }
}

export const db = new ManifestDb();
