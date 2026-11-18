import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  candidateUrl,
  downloadFile,
  fileUrl,
  IndexFileMismatch,
  manifestUrl,
  readActive,
  missingFiles,
  readCached,
  staleEntries,
  updateBuild,
  type IndexStore,
} from './indexBuilds';
import type { GameIndex, IndexFile, IndexManifest } from './types';

const BASE = 'https://site.test/manifest/data/';

/** Cache Storage in memory: keys are absolute URLs, as the real one returns them. */
class FakeStore implements IndexStore {
  readonly entries = new Map<string, { body: Uint8Array; headers: [string, string][] }>();
  /** The device is out of space: index files can't be cached. */
  full = false;
  async match(url: string) {
    const entry = this.entries.get(new URL(url, BASE).href);
    return entry ? new Response(entry.body as Uint8Array<ArrayBuffer>, { headers: entry.headers }) : undefined;
  }
  async put(url: string, response: Response) {
    if (this.full && !url.includes('manifest.json')) throw new DOMException('Quota exceeded', 'QuotaExceededError');
    this.entries.set(new URL(url, BASE).href, { body: new Uint8Array(await response.arrayBuffer()), headers: [...response.headers] });
  }
  async delete(url: string) {
    return this.entries.delete(new URL(url, BASE).href);
  }
  async keys() {
    return [...this.entries.keys()];
  }
  /** File names cached, with their versions. */
  files(): string[] {
    return [...this.entries.keys()].map((url) => url.slice(BASE.length)).filter((key) => !key.startsWith('manifest.json')).sort();
  }
}

/** GitHub Pages: serves whatever build is deployed, whatever `?v=` the request carries. */
class FakeServer {
  files = new Map<string, Uint8Array>();
  manifest: IndexManifest | null = null;
  requests: string[] = [];
  down = false;
  failing = new Set<string>();
  /** Requests to fail before one succeeds, by file. */
  flaky = new Map<string, number>();
  priorities: (string | undefined)[] = [];

  deploy(build: Build) {
    this.manifest = build.manifest;
    this.files = new Map(build.contents);
  }

  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const name = new URL(url, BASE).pathname.split('/').pop()!;
    this.requests.push(name);
    if (name !== 'manifest.json') this.priorities.push((init as { priority?: string } | undefined)?.priority);
    if (this.down || this.failing.has(name)) throw new TypeError('Failed to fetch');
    const flaky = this.flaky.get(name) ?? 0;
    if (flaky > 0) {
      this.flaky.set(name, flaky - 1);
      throw new TypeError('Failed to fetch');
    }
    if (name === 'manifest.json') return this.manifest ? Response.json(this.manifest) : new Response('', { status: 404 });
    const body = this.files.get(name);
    return body ? new Response(body as Uint8Array<ArrayBuffer>) : new Response('', { status: 404 });
  };

  downloads(): string[] {
    return this.requests.filter((name) => name !== 'manifest.json').sort();
  }
}

interface Build {
  manifest: IndexManifest;
  contents: Map<string, Uint8Array>;
}

/** A build of `shards` printings shards; `changes` gives files whose content differs from the base build. */
function build(date: string, shards = 4, changes: Record<string, string> = {}, schema = 1): Build {
  const contents = new Map<string, Uint8Array>();
  const entry = (file: string): IndexFile => {
    const body = new TextEncoder().encode(changes[file] ?? `${file} v1`);
    contents.set(file, body);
    return { file, bytes: body.byteLength, sha256: createHash('sha256').update(body).digest('hex') };
  };
  const pad = (i: number) => String(i).padStart(2, '0');
  const game: GameIndex = {
    source: { name: 'test', updatedAt: date },
    counts: { names: 1, printings: 1 },
    names: entry('names.mtg.json'),
    collectors: entry('collectors.mtg.json'),
    sets: entry('sets.mtg.json'),
    shards: Array.from({ length: shards }, (_, i) => entry(`printings.mtg.${pad(i)}.json`)),
    hashes: Array.from({ length: shards }, (_, i) => entry(`hashes.mtg.${pad(i)}.bin`)),
  };
  return { manifest: { schema: schema as 1, buildDate: date, games: { mtg: game } }, contents };
}

const A = build('2026-11-17');
// The next night: one printings shard and its fingerprints changed, and the files that list every name.
const B = build('2026-11-18', 4, {
  'printings.mtg.02.json': 'printings 02 v2',
  'hashes.mtg.02.bin': 'hashes 02 v2',
  'names.mtg.json': 'names v2',
  'collectors.mtg.json': 'collectors v2',
  'sets.mtg.json': 'sets v2',
});
const C = build('2026-11-19', 4, { 'printings.mtg.03.json': 'printings 03 v3', 'hashes.mtg.03.bin': 'hashes 03 v3', 'names.mtg.json': 'names v3' });

const game = (b: Build) => b.manifest.games.mtg!;
const v = (file: IndexFile) => `${file.file}?v=${file.sha256.slice(0, 16)}`;

function setup(deployed: Build = A) {
  const store = new FakeStore();
  const server = new FakeServer();
  server.deploy(deployed);
  const announced: string[] = [];
  const deps = { store, fetch: server.fetch, base: BASE, announce: (m: IndexManifest) => void announced.push(m.buildDate) };
  return { store, server, announced, deps };
}

/** The app on build A, all of it downloaded. */
async function onA() {
  const s = setup(A);
  expect((await updateBuild(s.deps)).kind).toBe('installed');
  s.server.requests = [];
  s.server.priorities = [];
  s.announced.length = 0;
  return s;
}

describe('downloadFile and readCached', () => {
  it('caches a file that matches its manifest entry, and reads it back without checking again', async () => {
    const { deps, store } = setup();
    const names = game(A).names;
    expect(new TextDecoder().decode(await downloadFile(deps, names))).toBe('names.mtg.json v1');
    expect(store.files()).toEqual([v(names)]);
    expect(new TextDecoder().decode((await readCached(store, BASE, names))!)).toBe('names.mtg.json v1');
  });

  it("refuses a file from another build, which is what GitHub Pages returns for an old version's URL", async () => {
    const { deps, store, server } = setup();
    server.deploy(B); // A's names URL now returns B's names.
    await expect(downloadFile(deps, game(A).names)).rejects.toBeInstanceOf(IndexFileMismatch);
    expect(store.files()).toEqual([]);
  });

  it('checks a file cached before hashes were recorded, once, and drops it if it is from another build', async () => {
    const { store } = setup();
    const names = game(A).names;
    const collectors = game(A).collectors!;
    // What earlier versions of the app cached: no hash header; one of them with the wrong content.
    await store.put(fileUrl(BASE, names), new Response('names.mtg.json v1'));
    await store.put(fileUrl(BASE, collectors), new Response('collectors v2'));
    expect(new TextDecoder().decode((await readCached(store, BASE, names))!)).toBe('names.mtg.json v1');
    expect((await store.match(fileUrl(BASE, names)))!.headers.get('X-Manifest-Sha256')).toBe(names.sha256);
    expect(await readCached(store, BASE, collectors)).toBeNull();
    expect(store.files()).toEqual([v(names)]);
  });
});

describe('missingFiles', () => {
  it("lists a build's files that aren't cached", async () => {
    const { store, deps } = setup();
    await downloadFile(deps, game(A).names);
    await downloadFile(deps, game(A).shards[1]!);
    const missing = (await missingFiles(store, BASE, A.manifest)).map((file) => file.file);
    expect(missing).toHaveLength(9);
    expect(missing).not.toContain('names.mtg.json');
    expect(missing).not.toContain('printings.mtg.01.json');
  });
});

describe('staleEntries', () => {
  it('finds files no kept build uses, and never the manifests', () => {
    const urls = [
      `${BASE}${v(game(A).shards[2]!)}`,
      `${BASE}${v(game(B).shards[2]!)}`,
      `${BASE}${v(game(A).shards[0]!)}`, // the same in both builds
      manifestUrl(BASE),
      candidateUrl(BASE),
    ];
    expect(staleEntries(urls, [B.manifest], BASE)).toEqual([urls[0]]);
    expect(staleEntries(urls, [A.manifest, B.manifest], BASE)).toEqual([]);
  });
});

describe('updateBuild', () => {
  it('makes the first build active straight away, then downloads all of it at low priority', async () => {
    const { deps, store, server, announced } = setup();
    const order: string[] = [];
    const outcome = await updateBuild({ ...deps, concurrency: 1, announce: (m) => order.push(`active ${m.buildDate}`), onProgress: ({ done }) => order.push(`file ${done}`) });
    expect(outcome).toMatchObject({ kind: 'installed', downloaded: 11 });
    expect(order[0]).toBe('active 2026-11-17'); // usable before its files are in
    expect((await readActive(store, BASE))!.buildDate).toBe('2026-11-17');
    expect(await missingFiles(store, BASE, A.manifest)).toEqual([]);
    // The scanner's files first, then the printings.
    expect(server.downloads()).toHaveLength(11);
    expect(server.requests.slice(1, 4)).toEqual(['names.mtg.json', 'collectors.mtg.json', 'sets.mtg.json']);
    expect(new Set(server.priorities)).toEqual(new Set(['low']));
    expect(announced).toEqual([]);
  });

  it("fills in the active build's files that went missing", async () => {
    const { deps, store, server } = await onA();
    await store.delete(fileUrl(BASE, game(A).shards[3]!));
    expect(await updateBuild(deps)).toMatchObject({ kind: 'up-to-date', downloaded: 1 });
    expect(server.downloads()).toEqual(['printings.mtg.03.json']);
  });

  it('downloads only what changed, switches when it is all in, and keeps the old files until the next update', async () => {
    const { deps, store, server, announced } = await onA();
    server.deploy(B);
    const outcome = await updateBuild(deps);
    expect(outcome).toMatchObject({ kind: 'switched', downloaded: 5 });
    expect(server.downloads()).toEqual(['collectors.mtg.json', 'hashes.mtg.02.bin', 'names.mtg.json', 'printings.mtg.02.json', 'sets.mtg.json']);
    expect((await readActive(store, BASE))!.buildDate).toBe('2026-11-18');
    expect(announced).toEqual(['2026-11-18']);
    // A part of the app still on A can carry on reading it.
    expect(store.files()).toContain(v(game(A).names));
    expect(await store.match(candidateUrl(BASE))).toBeUndefined();

    // The next update finds nothing new, and clears A's files out.
    server.requests = [];
    expect(await updateBuild(deps)).toMatchObject({ kind: 'up-to-date', downloaded: 0 });
    expect(server.downloads()).toEqual([]);
    expect(store.files()).not.toContain(v(game(A).names));
    expect(store.files()).toContain(v(game(B).names));
    expect(store.files()).toContain(v(game(A).shards[0]!)); // unchanged, so it is B's too
  });

  it('tries a dropped request again before counting the download as stopped', async () => {
    const { deps, server } = await onA();
    server.deploy(B);
    server.flaky.set('printings.mtg.02.json', 2);
    expect((await updateBuild(deps)).kind).toBe('switched');
    expect(server.requests.filter((name) => name === 'printings.mtg.02.json')).toHaveLength(3);
  });

  it("keeps the active build when the new one's files can't be downloaded, and carries on later from where it stopped", async () => {
    const { deps, store, server, announced } = await onA();
    server.deploy(B);
    server.failing = new Set(['printings.mtg.02.json']);
    expect((await updateBuild({ ...deps, concurrency: 1 })).kind).toBe('incomplete');
    expect((await readActive(store, BASE))!.buildDate).toBe('2026-11-17');
    expect(announced).toEqual([]);
    // A is all still there.
    expect(await missingFiles(store, BASE, A.manifest)).toEqual([]);

    server.failing.clear();
    server.requests = [];
    expect((await updateBuild(deps)).kind).toBe('switched');
    expect(server.downloads()).not.toContain('names.mtg.json'); // downloaded the first time
    expect(server.downloads()).toContain('printings.mtg.02.json');
  });

  it("keeps the active build, and caches nothing, when the server's files are from yet another build", async () => {
    const { deps, store, server } = await onA();
    server.deploy(B);
    server.files = new Map(C.contents); // a deploy of C half done: B's manifest, C's files
    expect(await updateBuild(deps)).toEqual({ kind: 'mismatch', file: expect.any(String) });
    expect((await readActive(store, BASE))!.buildDate).toBe('2026-11-17');
    expect(store.files().filter((key) => key.includes(game(C).names.sha256.slice(0, 16)))).toEqual([]);
  });

  it('moves on to a newer build that arrives mid-download, keeping the files they share', async () => {
    const { deps, store, server } = await onA();
    server.deploy(B);
    server.failing = new Set(['printings.mtg.02.json']);
    await updateBuild({ ...deps, concurrency: 1 });
    expect(await store.match(candidateUrl(BASE))).toBeDefined();
    const bSets = v(game(B).sets!);
    expect(store.files()).toContain(bSets);

    server.failing.clear();
    server.deploy(build('2026-11-19', 4, { 'sets.mtg.json': 'sets v2', 'names.mtg.json': 'names v3' }));
    server.requests = [];
    expect((await updateBuild(deps)).kind).toBe('switched');
    expect(server.downloads()).not.toContain('sets.mtg.json'); // B's, which C shares
    expect(store.files()).not.toContain(v(game(B).names)); // only B had it
    expect((await readActive(store, BASE))!.buildDate).toBe('2026-11-19');
  });

  it("doesn't start when there isn't room for the files, and stops when the device runs out of space", async () => {
    const { deps, store, server } = setup();
    expect(await updateBuild({ ...deps, estimate: async () => ({ usage: 1000, quota: 1010 }) })).toEqual({ kind: 'storage' });
    expect(server.downloads()).toEqual([]);
    expect((await readActive(store, BASE))!.buildDate).toBe('2026-11-17'); // still usable online

    store.full = true;
    expect(await updateBuild({ ...deps, concurrency: 1 })).toEqual({ kind: 'storage' });
    expect(server.downloads()).toHaveLength(1); // stopped at the first file that couldn't be cached
  });

  it("ignores a manifest this version of the app can't read", async () => {
    const { deps, store, server } = await onA();
    server.deploy(build('2026-11-18', 4, {}, 2));
    expect((await updateBuild(deps)).kind).toBe('unsupported');
    expect((await readActive(store, BASE))!.buildDate).toBe('2026-11-17');
  });

  it('changes nothing while offline', async () => {
    const { deps, store, server } = await onA();
    const before = store.files();
    server.deploy(B);
    server.down = true;
    expect((await updateBuild(deps)).kind).toBe('offline');
    expect(store.files()).toEqual(before);
    expect((await readActive(store, BASE))!.buildDate).toBe('2026-11-17');
  });

  it('downloads every printings shard it lacks when the shard count changes', async () => {
    const { deps, store, server } = await onA();
    const eight = build('2026-11-18', 8);
    server.deploy(eight);
    expect(await updateBuild(deps)).toMatchObject({ kind: 'switched' });
    expect(await missingFiles(store, BASE, eight.manifest)).toEqual([]);
    // 00 to 03 have the same content as A's, so only 04 to 07 were downloaded.
    expect(server.downloads().filter((name) => name.startsWith('printings'))).toEqual(['printings.mtg.04.json', 'printings.mtg.05.json', 'printings.mtg.06.json', 'printings.mtg.07.json']);
  });

  it('reports progress as files arrive, by bytes as cached', async () => {
    const { deps, server } = await onA();
    server.deploy(B);
    const seen: string[] = [];
    await updateBuild({ ...deps, concurrency: 1, onProgress: ({ done, total, bytes, totalBytes, updating, buildDate }) => seen.push(`${buildDate} ${updating} ${done}/${total} ${bytes <= totalBytes}`) });
    // 11 files; 6 unchanged and already cached.
    expect(seen).toEqual(['6/11', '7/11', '8/11', '9/11', '10/11', '11/11'].map((count) => `2026-11-18 true ${count} true`));
  });
});
