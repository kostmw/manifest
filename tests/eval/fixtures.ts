/** Where eval photos come from: the owner's real scans, and the synthetic set built from Scryfall images. */
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Printing } from '../../app/src/games/types';
import type { Point } from '../../app/src/vision/geometry';
import { cachedImagePath, fetchImages } from './fetchImages';
import { encodeJpeg, readImage } from './imageIo';
import { selectEvalCards, selectPhoneCards } from './selectCards';
import { createRng, phoneParams, randomParams, renderSynthetic, scaleParams, seedFrom, type PhoneScene, type SynthParams } from './synthesize';

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

/**
 * The synthetic sets. `standard` renders all 320 eval cards from Scryfall's
 * 488×680 `normal` scans into phone-sized frames (720×1280 and the like), the
 * set every milestone has been measured on. `hires` renders the 150 modern
 * cards from the 672×936 `large` scans into frames twice as big, closer to a
 * full-resolution phone photo: collector-line text is about twice as tall.
 * `phone` renders a subset of the eval cards plus the kinds the owner's
 * phone tests failed on (Star Trek planets, a borderless foil, tokens) three
 * ways each: plain, viewed at a steep tilt, and in dim light, at live-camera
 * size (1280×720). `phone-1080` is the same scenes at 1920×1080.
 * `phone-flash` renders the same cards once each with the flashlight on
 * inside a red deck box (see synthesize.ts's `flash` scene): a hotspot on the
 * art, as in the owner's M4 test.
 */
export type SyntheticVariant = 'standard' | 'hires' | 'phone' | 'phone-1080' | 'phone-flash';
export const SYNTHETIC_VARIANTS = ['standard', 'hires', 'phone', 'phone-1080', 'phone-flash'] as const;

const VARIANTS: Record<
  SyntheticVariant,
  { dir: string; imageDir: string; size: string; scale: number; strata: string[] | null; phone?: boolean; scenes?: readonly PhoneScene[] }
> = {
  standard: { dir: 'synthetic', imageDir: 'scryfall', size: 'normal', scale: 1, strata: null },
  hires: { dir: 'synthetic-hires', imageDir: 'scryfall-large', size: 'large', scale: 2, strata: ['modern'] },
  phone: { dir: 'synthetic-phone', imageDir: 'scryfall', size: 'normal', scale: 1, strata: null, phone: true },
  'phone-1080': { dir: 'synthetic-phone-1080', imageDir: 'scryfall', size: 'normal', scale: 1.5, strata: null, phone: true },
  'phone-flash': { dir: 'synthetic-phone-flash', imageDir: 'scryfall', size: 'normal', scale: 1, strata: null, phone: true, scenes: ['flash'] },
};

const PHONE_SCENES: readonly PhoneScene[] = ['plain', 'tilt', 'dim'];

/** Builds a synthetic set once (deterministic) and reuses it from .cache afterwards. */
export async function syntheticFixtures(options: {
  cacheDir: string;
  regenerate: boolean;
  log: (m: string) => void;
  variant?: SyntheticVariant;
}): Promise<Fixture[]> {
  const variant = VARIANTS[options.variant ?? 'standard'];
  const dir = join(options.cacheDir, variant.dir);
  const labelsPath = join(dir, 'labels.json');
  if (!options.regenerate && existsSync(labelsPath)) {
    const labels = JSON.parse(await readFile(labelsPath, 'utf8')) as Record<string, SyntheticLabel>;
    return Object.entries(labels).map(([file, label]) => ({
      path: join(dir, file),
      file: `${variant.dir}/${file}`,
      expectedName: label.name,
      expectedId: label.id,
      tags: label.tags,
      ...(label.corners ? { corners: label.corners } : {}),
    }));
  }

  const bulk = latestBulkFile();
  if (!bulk) throw new Error('No Scryfall bulk file in .cache/bulk. Run npm run index:build first.');
  options.log('Choosing eval cards…');
  const selected = variant.phone ? await selectPhoneCards(bulk) : (await selectEvalCards(bulk)).map((card) => ({ ...card, foil: false }));
  const cards = selected
    .filter((card) => !variant.strata || variant.strata.includes(card.stratum))
    .map((card) => ({ ...card, image: card.image.replace('/normal/', `/${variant.size}/`) }));
  const imageDir = join(options.cacheDir, variant.imageDir);
  await fetchImages(cards, imageDir, options.log);

  // One scene per card in the standard sets; plain, tilted and dim in the phone sets.
  type Job = { card: (typeof cards)[number]; file: string; seed: string; scene: PhoneScene | null };
  const jobs = cards.flatMap((card): Job[] =>
    variant.phone
      ? (variant.scenes ?? PHONE_SCENES).map((scene) => ({ card, file: `${card.id}-${scene}.jpg`, seed: `${card.id}:${scene}`, scene }))
      : [{ card, file: `${card.id}.jpg`, seed: card.id, scene: null }],
  );
  await mkdir(dir, { recursive: true });
  options.log(`Rendering ${jobs.length} synthetic photos…`);
  const labels: Record<string, SyntheticLabel> = {};
  for (const [index, { card, file, seed, scene }] of jobs.entries()) {
    const source = await readImage(cachedImagePath(imageDir, card.id));
    // The same seed in every variant of a set, so each card gets the same scene, only sharper.
    const rng = createRng(seedFrom(seed));
    const aspect = source.width / source.height;
    const scenery: SynthParams = scene ? phoneParams(rng, aspect, scene, card.foil) : randomParams(rng, aspect);
    const params = scaleParams(scenery, variant.scale);
    const { image, corners } = renderSynthetic(source, params, rng);
    // Saved at a phone-like JPEG quality, so compression artefacts are part of the test.
    const bytes = encodeJpeg(image, params.jpegQuality);
    await writeFile(join(dir, file), bytes);
    labels[file] = {
      id: card.id,
      name: card.name,
      tags: ['synthetic', ...(variant.phone ? ['phone'] : []), ...(variant.scale > 1 ? ['hires'] : []), ...card.tags, ...params.conditions],
      corners: corners.map(({ x, y }) => ({ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 })),
    };
    if ((index + 1) % 50 === 0) options.log(`  ${index + 1}/${jobs.length}`);
  }
  await writeFile(labelsPath, JSON.stringify(labels, null, 1));
  return syntheticFixtures({ ...options, regenerate: false });
}
