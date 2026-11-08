import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { printingShardFile, printingShardIndex } from '../app/src/games/shard';
import { MAX_ASSET_BYTES, type GameId, type GameIndex, type IndexFile, type IndexManifest } from '../app/src/games/types';
import type { BuiltGameData } from './games/types';

function comparePrintings(a: { name: string; id: string }, b: { name: string; id: string }): number {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

async function writeIndexFile(outDir: string, file: string, value: unknown): Promise<IndexFile> {
  const text = JSON.stringify(value);
  const bytes = Buffer.byteLength(text);
  if (bytes > MAX_ASSET_BYTES) {
    throw new Error(`${file} is ${bytes} bytes, over the ${MAX_ASSET_BYTES} byte limit. Raise the shard count.`);
  }
  await writeFile(join(outDir, file), text);
  return { file, bytes, sha256: createHash('sha256').update(text).digest('hex') };
}

/**
 * Output is deterministic: the same data produces identical files and hashes,
 * so the app only downloads the shards that really changed.
 */
export async function writeGameIndex(
  game: GameId,
  data: BuiltGameData,
  shardCount: number,
  outDir: string,
): Promise<GameIndex> {
  await mkdir(outDir, { recursive: true });
  for (const existing of await readdir(outDir)) {
    if (existing.startsWith(`printings.${game}.`) || existing === `names.${game}.json`) {
      await rm(join(outDir, existing));
    }
  }

  const buckets: BuiltGameData['printings'][] = Array.from({ length: shardCount }, () => []);
  for (const printing of data.printings) {
    buckets[printingShardIndex(printing.name, shardCount)]!.push(printing);
  }

  const shards = await Promise.all(
    buckets.map((bucket, shard) =>
      writeIndexFile(outDir, printingShardFile(game, shard), [...bucket].sort(comparePrintings)),
    ),
  );
  const names = await writeIndexFile(outDir, `names.${game}.json`, data.names);

  return {
    source: data.source,
    counts: { names: data.names.names.length, printings: data.printings.length },
    names,
    shards,
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
