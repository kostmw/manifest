import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildCollectorIndex } from '../app/src/games/collectorIndex';
import { encodeHashShard } from '../app/src/games/hashShard';
import { buildSetList } from '../app/src/games/sets';
import { hashShardFile, printingShardFile, printingShardIndex } from '../app/src/games/shard';
import { MAX_ASSET_BYTES, type GameId, type GameIndex, type IndexFile, type IndexManifest } from '../app/src/games/types';
import type { BuiltGameData } from './games/types';

/** Visual fingerprints to publish with the index, keyed by printing id. */
export interface FingerprintData {
  version: number;
  rowBytes: number;
  imageSize: string;
  byId: ReadonlyMap<string, Uint8Array>;
}

function comparePrintings(a: { name: string; id: string }, b: { name: string; id: string }): number {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

async function writeIndexBytes(outDir: string, file: string, content: string | Uint8Array): Promise<IndexFile> {
  const bytes = typeof content === 'string' ? Buffer.byteLength(content) : content.byteLength;
  if (bytes > MAX_ASSET_BYTES) {
    throw new Error(`${file} is ${bytes} bytes, over the ${MAX_ASSET_BYTES} byte limit. Raise the shard count.`);
  }
  await writeFile(join(outDir, file), content);
  return { file, bytes, sha256: createHash('sha256').update(content).digest('hex') };
}

const writeIndexFile = (outDir: string, file: string, value: unknown) => writeIndexBytes(outDir, file, JSON.stringify(value));

/** Cards from before Magic 2015 print no set code, so a collector line can't name them. */
const COLLECTOR_LINES_SINCE = '2014-07-01';

/**
 * Output is deterministic: the same data produces identical files and hashes,
 * so the app only downloads the shards that really changed.
 */
export async function writeGameIndex(
  game: GameId,
  data: BuiltGameData,
  shardCount: number,
  outDir: string,
  fingerprints?: FingerprintData,
): Promise<GameIndex> {
  await mkdir(outDir, { recursive: true });
  for (const existing of await readdir(outDir)) {
    if (
      existing.startsWith(`printings.${game}.`) ||
      existing.startsWith(`hashes.${game}.`) ||
      existing === `names.${game}.json` ||
      existing === `collectors.${game}.json` ||
      existing === `sets.${game}.json`
    ) {
      await rm(join(outDir, existing));
    }
  }

  const buckets: BuiltGameData['printings'][] = Array.from({ length: shardCount }, () => []);
  for (const printing of data.printings) {
    buckets[printingShardIndex(printing.name, shardCount)]!.push(printing);
  }

  const sorted = buckets.map((bucket) => [...bucket].sort(comparePrintings));
  const shards = await Promise.all(sorted.map((bucket, shard) => writeIndexFile(outDir, printingShardFile(game, shard), bucket)));
  const names = await writeIndexFile(outDir, `names.${game}.json`, data.names);
  const collectors = await writeIndexFile(
    outDir,
    `collectors.${game}.json`,
    buildCollectorIndex(data.printings, data.names.names, COLLECTOR_LINES_SINCE),
  );

  const sets = await writeIndexFile(outDir, `sets.${game}.json`, buildSetList(data.printings));

  // Row i of a hash shard is printing i of the printings shard written above.
  const hashes = fingerprints
    ? await Promise.all(
        sorted.map((bucket, shard) =>
          writeIndexBytes(
            outDir,
            hashShardFile(game, shard),
            encodeHashShard({
              version: fingerprints.version,
              rowBytes: fingerprints.rowBytes,
              printingsSha256: shards[shard]!.sha256,
              rows: bucket.map((printing) => fingerprints.byId.get(printing.id) ?? null),
            }),
          ),
        ),
      )
    : undefined;

  return {
    source: data.source,
    counts: { names: data.names.names.length, printings: data.printings.length },
    names,
    shards,
    collectors,
    sets,
    ...(hashes && fingerprints
      ? { hashes, fingerprint: { version: fingerprints.version, rowBytes: fingerprints.rowBytes, imageSize: fingerprints.imageSize } }
      : {}),
  };
}

/** Merges into any existing manifest, so that building one game keeps the others. */
export async function writeManifest(
  outDir: string,
  games: Partial<Record<GameId, GameIndex>>,
  buildDate: string,
): Promise<IndexManifest> {
  let existing: Partial<Record<GameId, GameIndex>> = {};
  try {
    existing = (JSON.parse(await readFile(join(outDir, 'manifest.json'), 'utf8')) as IndexManifest).games;
  } catch {
    // First build: there is nothing to merge.
  }
  const manifest: IndexManifest = { schema: 1, buildDate, games: { ...existing, ...games } };
  await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}
