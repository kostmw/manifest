import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  candidateUrl,
  downloadFile,
  fileUrl,
  IndexFileMismatch,
  manifestUrl,
  readActive,
  readCached,
  requiredFiles,
  staleEntries,
  updateBuild,
  type IndexStore,
} from './indexBuilds';
import type { GameIndex, IndexFile, IndexManifest } from './types';

const BASE = 'https://site.test/manifest/data/';

/** Cache Storage in memory: keys are absolute URLs, as the real one returns them. */
class FakeStore implements IndexStore {
  readonly entries = new Map<string, { body: Uint8Array; headers: [string, string][] }>();
  async match(url: string) {
    const entry = this.entries.get(new URL(url, BASE).href);
    return entry ? new Response(entry.body as Uint8Array<ArrayBuffer>, { headers: entry.headers }) : undefined;
  }
  async put(url: string, response: Response) {
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

  deploy(build: Build) {
    this.manifest = build.manifest;
    this.files = new Map(build.contents);
  }

  fetch = async (url: string): Promise<Response> => {
    const name = new URL(url, BASE).pathname.split('/').pop()!;
    this.requests.push(name);
    if (this.down || this.failing.has(name)) throw new TypeError('Failed to fetch');
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

/** The app on build A, having used the scanner (names, collectors, sets, fingerprints) and opened shards 0 and 2. */
async function onA() {
  const s = setup(A);
  await updateBuild(s.deps);
  for (const file of [game(A).names, game(A).collectors!, game(A).sets!, ...game(A).hashes!, game(A).shards[0]!, game(A).shards[2]!]) {
    await downloadFile(s.deps, file);
  }
  s.server.requests = [];
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

describe('requiredFiles', () => {
  it('needs every file but the printings, and the printings shards the active build had cached', () => {
    const cached = new Set([`/manifest/data/${v(game(A).shards[1]!)}`]);
    const files = requiredFiles(A.manifest, B.manifest, cached, BASE).map((file) => file.file);
    expect(files).toEqual([
      'names.mtg.json',
      'collectors.mtg.json',
      'sets.mtg.json',
      'hashes.mtg.00.bin',
      'hashes.mtg.01.bin',
      'hashes.mtg.02.bin',
      'hashes.mtg.03.bin',
      'printings.mtg.01.json',
    ]);
  });

  it('needs every printings shard when the shard count changed, since shards no longer line up', () => {
    const files = requiredFiles(A.manifest, build('2026-11-18', 8).manifest, new Set(), BASE).filter((file) => file.file.startsWith('printings'));
    expect(files).toHaveLength(8);
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
  it('makes the first build active straight away, with nothing downloaded yet', async () => {
    const { deps, store, server, announced } = setup();
    expect((await updateBuild(deps)).kind).toBe('installed');
    expect((await readActive(store, BASE))!.buildDate).toBe('2026-11-17');
    expect(server.downloads()).toEqual([]);
    expect(announced).toEqual(['2026-11-17']);
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
    expect((await updateBuild(deps)).kind).toBe('up-to-date');
    expect(server.downloads()).toEqual([]);
    expect(store.files()).not.toContain(v(game(A).names));
    expect(store.files()).toContain(v(game(B).names));
    expect(store.files()).toContain(v(game(A).shards[0]!)); // unchanged, so it is B's too
  });

  it("keeps the active build when the new one's files can't be downloaded, and carries on later from where it stopped", async () => {
    const { deps, store, server, announced } = await onA();
    server.deploy(B);
    server.failing = new Set(['printings.mtg.02.json']);
    expect((await updateBuild({ ...deps, concurrency: 1 })).kind).toBe('incomplete');
    expect((await readActive(store, BASE))!.buildDate).toBe('2026-11-17');
    expect(announced).toEqual([]);
    // A's files are all still there.
    for (const file of [game(A).names, game(A).collectors!, game(A).shards[2]!]) expect(await readCached(store, BASE, file)).not.toBeNull();
    expect((await readActive(store, BASE))!.buildDate).toBe('2026-11-17');

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
    expect((await store.match(candidateUrl(BASE)))).toBeDefined();
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

  it('downloads every printings shard when the shard count changes', async () => {
    const { deps, store, server } = await onA();
    const eight = build('2026-11-18', 8);
    server.deploy(eight);
    expect(await updateBuild(deps)).toMatchObject({ kind: 'switched' });
    // All 8 cached; 00 and 02 have the same content as A's, so they weren't downloaded again.
    for (const shard of game(eight).shards) expect(store.files()).toContain(v(shard));
    expect(server.downloads().filter((name) => name.startsWith('printings'))).toHaveLength(6);
  });

  it('reports progress as files arrive', async () => {
    const { deps, server } = await onA();
    server.deploy(B);
    const seen: number[] = [];
    await updateBuild({ ...deps, concurrency: 1, onProgress: ({ done, total }) => seen.push(done * 100 + total) });
    // 9 files needed (names, collectors, sets, 4 hashes, shards 0 and 2); 4 already cached.
    expect(seen).toEqual([409, 509, 609, 709, 809, 909]);
  });
});
