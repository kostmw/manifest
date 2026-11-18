/**
 * The printings shard count is the index builder's choice (games/mtg.ts): the
 * app reads it from the manifest. These build the same cards at the old count
 * (64) and the new one (256) and read both with the app's own code, the
 * catalog recognition uses and the index client search uses, so that a phone
 * still running an older version of the app reads a new index unchanged.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Catalog } from '../app/src/games/catalog';
import type { NameDictionary } from '../app/src/games/types';
import { fileIndexSource } from '../tests/eval/indexSource';
import { mtgIndexBuilder } from './games/mtg';
import { writeGameIndex, writeManifest } from './writeIndex';

const SAMPLE = 'tests/fixtures/scryfall-sample.jsonl';
const FINGERPRINT_VERSION = 1;
const dirs: Record<number, string> = {};
let names: string[] = [];

beforeAll(async () => {
  for (const count of [64, 256]) {
    const dir = await mkdtemp(join(tmpdir(), `manifest-shards-${count}-`));
    const data = await mtgIndexBuilder.buildIndex({ sourceFile: SAMPLE, cacheDir: dir });
    // A made-up fingerprint per printing, so that rows can be checked to line up.
    const byId = new Map(data.printings.map((printing, i) => [printing.id, new Uint8Array(16).fill(i + 1)]));
    const index = await writeGameIndex('mtg', data, count, dir, { version: FINGERPRINT_VERSION, rowBytes: 16, imageSize: 'small', byId });
    await writeManifest(dir, { mtg: index }, '2026-11-18T00:00:00.000Z');
    dirs[count] = dir;
    names = data.names.names;
  }
});

afterAll(async () => {
  await Promise.all(Object.values(dirs).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('the app reads a 256-shard index as it read 64', () => {
  it('has the shard count in the manifest, one fingerprint shard per printings shard', async () => {
    const manifest = JSON.parse(await readFile(join(dirs[256]!, 'manifest.json'), 'utf8'));
    expect(manifest.games.mtg.shards).toHaveLength(256);
    expect(manifest.games.mtg.hashes).toHaveLength(256);
    expect(manifest.games.mtg.shards[200].file).toBe('printings.mtg.200.json');
  });

  it('gives recognition the same printings and fingerprints (catalog.ts)', async () => {
    const read = async (count: number) => {
      const catalog = new Catalog(fileIndexSource(dirs[count]!, 'mtg'), FINGERPRINT_VERSION);
      expect(await catalog.hasFingerprints()).toBe(true);
      const byName: Record<string, string[]> = {};
      for (const name of names) {
        byName[name] = (await catalog.printings(name)).map(({ printing, fingerprint }) => `${printing.id}:${fingerprint?.[0] ?? 'none'}`);
      }
      // Every fingerprint in the table points at the printing it belongs to.
      const table = (await catalog.fingerprintTable())!;
      const rows: string[] = [];
      for (const { shard, rows: count } of table.shards) {
        for (let row = 0; row < count; row++) {
          const hit = (await catalog.printingAt(shard, row))!;
          rows.push(`${hit.printing.id}:${hit.fingerprint?.[0] ?? 'none'}`);
        }
      }
      return { byName, rows: rows.sort() };
    };
    const [old, next] = [await read(64), await read(256)];
    expect(next.byName).toEqual(old.byName);
    expect(next.rows).toEqual(old.rows);
    expect(Object.values(next.byName).every((printings) => printings.length > 0)).toBe(true);
  });

  it('gives search the same names and printings (indexClient.ts)', async () => {
    const read = async (count: number) => {
      // The client as it runs in the browser, fetching from the site: here, from the build's folder.
      vi.resetModules();
      vi.stubGlobal('fetch', async (url: string) => {
        const file = new URL(url, 'https://site.test').pathname.split('/data/').pop()!;
        return new Response(await readFile(join(dirs[count]!, file)));
      });
      const client = await import('../app/src/games/indexClient');
      const dictionary: NameDictionary = await client.loadNameDictionary('mtg');
      const printings: Record<string, string[]> = {};
      for (const name of dictionary.names) printings[name] = (await client.loadPrintings('mtg', name)).map((printing) => printing.id);
      vi.unstubAllGlobals();
      return { dictionary, printings };
    };
    const [old, next] = [await read(64), await read(256)];
    expect(next.dictionary).toEqual(old.dictionary);
    expect(next.printings).toEqual(old.printings);
  });
});
