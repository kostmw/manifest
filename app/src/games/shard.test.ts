import { describe, expect, it } from 'vitest';
import { printingShardFile, printingShardIndex } from './shard';

describe('printingShardIndex', () => {
  it('is pinned, because published shards depend on these exact values', () => {
    expect([
      printingShardIndex('Sol Ring', 64),
      printingShardIndex('Fire // Ice', 64),
      printingShardIndex("Lim-Dûl's Vault", 64),
    ]).toEqual([37, 14, 45]);
  });

  it('stays in range', () => {
    for (const name of ['', 'a', 'Plains', 'Æther', '🃏']) {
      const shard = printingShardIndex(name, 8);
      expect(shard).toBeGreaterThanOrEqual(0);
      expect(shard).toBeLessThan(8);
    }
  });
});

describe('printingShardFile', () => {
  it('pads the shard number so files sort in order', () => {
    expect(printingShardFile('mtg', 7)).toBe('printings.mtg.07.json');
    expect(printingShardFile('mtg', 63)).toBe('printings.mtg.63.json');
  });
});
