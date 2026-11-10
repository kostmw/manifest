/** Where eval photos come from: the owner's real scans, and the synthetic set built from Scryfall images. */
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Printing } from '../../app/src/games/types';
import type { Point } from '../../app/src/vision/geometry';
import { cachedImagePath, fetchImages } from './fetchImages';
import { encodeJpeg, readImage } from './imageIo';
import { selectEvalCards } from './selectCards';
import { createRng, randomParams, renderSynthetic, seedFrom } from './synthesize';

export interface Fixture {
  path: string;
  /** Name relative to its set, for reports. */
  file: string;
  expectedName: string;
  expectedId?: string;
  tags: string[];
  /** Where the card really is in the photo, when known (synthetic photos). */
  corners?: Point[];
}

/** tests/fixtures/real-scans/labels.json: file name → label. Only `id` is required. */
export interface RealScanLabel {
  game: string;
  id: string;
  name?: string;
  foil?: boolean;
  tags?: string[];
  notes?: string;
}

const REAL_DIR = 'tests/fixtures/real-scans';

/** Looks printings up by id. The index shards by name, so this reads them all; fine for an eval. */
async function namesForIds(dataDir: string, ids: Set<string>): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (ids.size === 0) return found;
  for (const file of readdirSync(dataDir).filter((name) => name.startsWith('printings.mtg.'))) {
    const printings = JSON.parse(await readFile(join(dataDir, file), 'utf8')) as Printing[];
    for (const printing of printings) if (ids.has(printing.id)) found.set(printing.id, printing.name);
  }
  return found;
}

export async function realScanFixtures(dataDir: string): Promise<Fixture[]> {
  const labelsPath = join(REAL_DIR, 'labels.json');
  if (!existsSync(labelsPath)) return [];
  const labels = JSON.parse(await readFile(labelsPath, 'utf8')) as Record<string, RealScanLabel>;
  const entries = Object.entries(labels).filter(([file, label]) => label.game === 'mtg' && existsSync(join(REAL_DIR, file)));
  const names = await namesForIds(dataDir, new Set(entries.filter(([, l]) => !l.name).map(([, l]) => l.id)));
  return entries.flatMap(([file, label]) => {
    const expectedName = label.name ?? names.get(label.id);
    if (!expectedName) {
      console.warn(`real-scans/${file}: printing ${label.id} is not in the index, skipped`);
      return [];
    }
    const tags = ['real', ...(label.tags ?? [])];
    if (label.foil) tags.push('foil');
    return [{ path: join(REAL_DIR, file), file: `real/${file}`, expectedName, expectedId: label.id, tags }];
  });
}

interface SyntheticLabel {
  id: string;
  name: string;
  tags: string[];
  corners?: Point[];
}

export function latestBulkFile(cacheDir = '.cache/bulk'): string | null {
  if (!existsSync(cacheDir)) return null;
  const files = readdirSync(cacheDir).filter((name) => name.endsWith('.jsonl.gz')).sort();
  return files.length ? join(cacheDir, files.at(-1)!) : null;
}

/** Builds the synthetic set once (deterministic) and reuses it from .cache afterwards. */
export async function syntheticFixtures(options: { cacheDir: string; regenerate: boolean; log: (m: string) => void }): Promise<Fixture[]> {
  const dir = join(options.cacheDir, 'synthetic');
  const labelsPath = join(dir, 'labels.json');
  if (!options.regenerate && existsSync(labelsPath)) {
    const labels = JSON.parse(await readFile(labelsPath, 'utf8')) as Record<string, SyntheticLabel>;
    return Object.entries(labels).map(([file, label]) => ({
      path: join(dir, file),
      file: `synthetic/${file}`,
      expectedName: label.name,
      expectedId: label.id,
      tags: label.tags,
      ...(label.corners ? { corners: label.corners } : {}),
    }));
  }

  const bulk = latestBulkFile();
  if (!bulk) throw new Error('No Scryfall bulk file in .cache/bulk. Run npm run index:build first.');
  options.log('Choosing eval cards…');
  const cards = await selectEvalCards(bulk);
  const imageDir = join(options.cacheDir, 'scryfall');
  await fetchImages(cards, imageDir, options.log);

  await mkdir(dir, { recursive: true });
  options.log(`Rendering ${cards.length} synthetic photos…`);
  const labels: Record<string, SyntheticLabel> = {};
  for (const [index, card] of cards.entries()) {
    const source = await readImage(cachedImagePath(imageDir, card.id));
    const rng = createRng(seedFrom(card.id));
    const params = randomParams(rng, source.width / source.height);
    const { image, corners } = renderSynthetic(source, params, rng);
    // Saved at a phone-like JPEG quality, so compression artefacts are part of the test.
    const bytes = encodeJpeg(image, params.jpegQuality);
    const file = `${card.id}.jpg`;
    await writeFile(join(dir, file), bytes);
    labels[file] = {
      id: card.id,
      name: card.name,
      tags: ['synthetic', ...card.tags, ...params.conditions],
      corners: corners.map(({ x, y }) => ({ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 })),
    };
    if ((index + 1) % 50 === 0) options.log(`  ${index + 1}/${cards.length}`);
  }
  await writeFile(labelsPath, JSON.stringify(labels, null, 1));
  return syntheticFixtures({ ...options, regenerate: false });
}
