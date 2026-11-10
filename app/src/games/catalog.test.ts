import { describe, expect, it } from 'vitest';
import { Catalog, type IndexSource } from './catalog';
import { encodeHashShard } from './hashShard';
import type { GameIndex, IndexFile, Printing } from './types';

const printing = (name: string, id: string, released: string): Printing => ({
  id,
  name,
  set: id,
  setName: id,
  number: '1',
  finishes: ['nonfoil'],
  lang: 'en',
  released,
});

const shard: IndexFile = { file: 'printings.mtg.00.json', bytes: 0, sha256: '12'.repeat(32) };
const hashes: IndexFile = { file: 'hashes.mtg.00.bin', bytes: 0, sha256: '34'.repeat(32) };
const printings = [printing('Opt', 'a', '2010-01-01'), printing('Opt', 'b', '2020-01-01'), printing('Plains', 'c', '2000-01-01')];

function source(options: { hashFor?: string; version?: number } = {}): IndexSource & { reads: number } {
  const index: GameIndex = {
    source: { name: 't', updatedAt: 't' },
    counts: { names: 2, printings: 3 },
    names: { file: 'names.mtg.json', bytes: 0, sha256: '' },
    shards: [shard],
    hashes: [hashes],
    fingerprint: { version: options.version ?? 1, rowBytes: 16, imageSize: 'small' },
  };
  const bin = encodeHashShard({
    version: options.version ?? 1,
    rowBytes: 16,
    printingsSha256: options.hashFor ?? shard.sha256,
    rows: [new Uint8Array(16).fill(1), null, new Uint8Array(16).fill(3)],
  });
  const result = {
    reads: 0,
    gameIndex: async () => index,
    json: async () => {
      result.reads++;
      return printings as never;
    },
    bytes: async () => bin,
  };
  return result;
}

describe('Catalog', () => {
  it('gives the printings of a name newest first, with their fingerprints', async () => {
    const catalog = new Catalog(source(), 1);
    const found = await catalog.printings('Opt');
    expect(found.map((entry) => entry.printing.id)).toEqual(['b', 'a']);
    expect(found[0]!.fingerprint).toBeNull(); // Row of zeros: no image.
    expect(found[1]!.fingerprint?.[0]).toBe(0x01010101);
  });

  it('reads each shard once', async () => {
    const files = source();
    const catalog = new Catalog(files, 1);
    await catalog.printings('Opt');
    await catalog.printings('Plains');
    expect(files.reads).toBe(1);
  });

  it('ignores fingerprints built for another version of the printings, or by another algorithm', async () => {
    const stale = new Catalog(source({ hashFor: 'ff'.repeat(32) }), 1);
    expect((await stale.printings('Opt'))[1]!.fingerprint).toBeNull();
    const other = new Catalog(source({ version: 2 }), 1);
    expect(await other.hasFingerprints()).toBe(false);
    expect(await other.fingerprintTable()).toBeNull();
  });

  it('serves every fingerprint for searching without a name', async () => {
    const table = await new Catalog(source(), 1).fingerprintTable();
    expect(table).toMatchObject({ rowWords: 4, shards: [{ shard: 0, rows: 3 }] });
    expect((await new Catalog(source(), 1).printingAt(0, 2))?.printing.name).toBe('Plains');
  });
});
