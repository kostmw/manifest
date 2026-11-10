/**
 * What recognition needs from the card index, on top of the name list: the
 * printings of a name with their fingerprints, every fingerprint (to search
 * without a name), and the collector-number index. The same code runs in the
 * recognition worker (files fetched and cached by indexClient) and in the Node
 * eval (files read from disk), through IndexSource.
 */
import { CollectorIndex, type CollectorIndexFile } from './collectorIndex';
import { decodeHashShard, type HashShard } from './hashShard';
import { printingShardIndex } from './shard';
import type { GameIndex, IndexFile, NameDictionary, Printing } from './types';

export interface IndexSource {
  gameIndex(): Promise<GameIndex>;
  json<T>(file: IndexFile): Promise<T>;
  bytes(file: IndexFile): Promise<Uint8Array>;
}

export interface CatalogPrinting {
  printing: Printing;
  /** Null when the index has no fingerprints, or none for this printing. */
  fingerprint: Uint32Array | null;
}

/** Every fingerprint in the index, shard by shard, for searching without a name. */
export interface FingerprintTable {
  rowWords: number;
  shards: { shard: number; words: Uint32Array; rows: number }[];
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Newest first, the printing someone is most likely holding. */
export function sortPrintings(printings: readonly Printing[]): Printing[] {
  return [...printings].sort(
    (a, b) =>
      (b.released ?? '').localeCompare(a.released ?? '') ||
      collator.compare(a.set, b.set) ||
      collator.compare(a.number, b.number),
  );
}

/** Printings shards are big (about 0.7 MB of JSON), so only the last few used are kept. */
const SHARDS_KEPT = 8;

export class Catalog {
  private readonly printingShards = new Map<number, Promise<Printing[]>>();
  private readonly hashShards = new Map<number, Promise<HashShard | null>>();
  private collectorsPromise: Promise<CollectorIndex | null> | null = null;
  private tablePromise: Promise<FingerprintTable | null> | null = null;

  constructor(
    private readonly source: IndexSource,
    /** The fingerprint algorithm this build of the app computes; an index built with another is ignored. */
    private readonly fingerprintVersion: number,
  ) {}

  /** Whether the index has fingerprints this app can compare against. */
  async hasFingerprints(): Promise<boolean> {
    const index = await this.source.gameIndex();
    return Boolean(index.hashes && index.fingerprint?.version === this.fingerprintVersion && index.hashes.length === index.shards.length);
  }

  private printingShard(shard: number): Promise<Printing[]> {
    let found = this.printingShards.get(shard);
    if (found) {
      // Most recently used goes last.
      this.printingShards.delete(shard);
      this.printingShards.set(shard, found);
      return found;
    }
    found = this.source.gameIndex().then((index) => {
      const file = index.shards[shard];
      if (!file) throw new Error(`The card index has no shard ${shard}`);
      return this.source.json<Printing[]>(file);
    });
    found.catch(() => this.printingShards.delete(shard));
    this.printingShards.set(shard, found);
    while (this.printingShards.size > SHARDS_KEPT) this.printingShards.delete(this.printingShards.keys().next().value!);
    return found;
  }

  private hashShard(shard: number): Promise<HashShard | null> {
    let found = this.hashShards.get(shard);
    if (found) return found;
    found = (async () => {
      if (!(await this.hasFingerprints())) return null;
      const index = await this.source.gameIndex();
      const decoded = decodeHashShard(await this.source.bytes(index.hashes![shard]!));
      // A hash shard built against another version of the printings would point at the wrong cards.
      if (decoded.printingsSha !== index.shards[shard]!.sha256.slice(0, 16) || decoded.version !== this.fingerprintVersion) return null;
      return decoded;
    })();
    found.catch(() => this.hashShards.delete(shard));
    this.hashShards.set(shard, found);
    return found;
  }

  private async shardOf(name: string): Promise<number> {
    const index = await this.source.gameIndex();
    const shard = printingShardIndex(name, index.shards.length);
    if (!index.shards[shard]) throw new Error(`The card index is missing shard ${shard}`);
    return shard;
  }

  /** The printings of a card name, newest first, each with its fingerprint when there is one. */
  async printings(name: string): Promise<CatalogPrinting[]> {
    const shard = await this.shardOf(name);
    const [printings, hashes] = await Promise.all([this.printingShard(shard), this.hashShard(shard).catch(() => null)]);
    const found: CatalogPrinting[] = [];
    printings.forEach((printing, row) => {
      if (printing.name !== name) return;
      found.push({ printing, fingerprint: hashes ? rowOf(hashes, row) : null });
    });
    const order = new Map(sortPrintings(found.map((entry) => entry.printing)).map((printing, i) => [printing.id, i]));
    return found.sort((a, b) => order.get(a.printing.id)! - order.get(b.printing.id)!);
  }

  /** One printing of a global search hit. */
  async printingAt(shard: number, row: number): Promise<CatalogPrinting | null> {
    const [printings, hashes] = await Promise.all([this.printingShard(shard), this.hashShard(shard).catch(() => null)]);
    const printing = printings[row];
    return printing ? { printing, fingerprint: hashes ? rowOf(hashes, row) : null } : null;
  }

  /** Every fingerprint (about 1.8 MB for MTG), loaded once. Null when the index has none. */
  fingerprintTable(): Promise<FingerprintTable | null> {
    this.tablePromise ??= (async () => {
      if (!(await this.hasFingerprints())) return null;
      const index = await this.source.gameIndex();
      const shards = await Promise.all(index.shards.map((_, shard) => this.hashShard(shard)));
      if (shards.some((shard) => !shard)) return null;
      return {
        rowWords: shards[0]!.rowBytes / 4,
        shards: shards.map((decoded, shard) => ({ shard, words: decoded!.words, rows: decoded!.rows })),
      };
    })();
    this.tablePromise.catch(() => {
      this.tablePromise = null;
    });
    return this.tablePromise;
  }

  /** Null for an index built before collector lookups existed. */
  collectors(names: NameDictionary): Promise<CollectorIndex | null> {
    this.collectorsPromise ??= (async () => {
      const index = await this.source.gameIndex();
      if (!index.collectors) return null;
      return new CollectorIndex(await this.source.json<CollectorIndexFile>(index.collectors), names.names);
    })();
    this.collectorsPromise.catch(() => {
      this.collectorsPromise = null;
    });
    return this.collectorsPromise;
  }
}

function rowOf(shard: HashShard, row: number): Uint32Array | null {
  const words = shard.rowBytes / 4;
  const slice = shard.words.subarray(row * words, (row + 1) * words);
  return slice.some((word) => word !== 0) ? slice : null;
}
