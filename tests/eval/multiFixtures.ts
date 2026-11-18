/**
 * The multi-card eval sets (see multiSynth.ts): which cards go on each binder
 * page and table spread, rendered once (deterministic) and cached in .cache.
 *
 * Cards come from Scryfall's `large` scans (672×936), at the resolution a
 * phone photo of a binder page has once the app scales it to 3000 pixels:
 * a card about 600 pixels across. Three pools:
 * - `special`: borderless and extended-art Star Trek and Doctor Who
 *   printings, the owner's hardest cards among them (The Holodeck TRK 346,
 *   the foil Dominion Saboteur TRK 345, Grand Nagus Zek TRK 458, Captain
 *   Pike TRK 468). Art that runs to the card's edge is what makes
 *   neighbouring cards merge.
 * - `modern`: the 150 modern cards of the `hires` set.
 * - `showcase`: the 30 special-treatment cards of the standard set.
 */
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createGunzip } from 'node:zlib';
import type { Point } from '../../app/src/vision/geometry';
import { readJsonLines, type ScryfallCard } from '../../scripts/games/mtg';
import { cachedImagePath, fetchImages } from './fetchImages';
import { latestBulkFile } from './fixtures';
import { encodeJpeg, readImage } from './imageIo';
import { binderParams, photoCorners, renderMulti, spreadParams, visibleShare, type MultiParams } from './multiSynth';
import { frontImage, sampleKey, selectEvalCards } from './selectCards';
import { createRng, seedFrom } from './synthesize';

export type MultiSet = 'binder' | 'spread';
export const MULTI_SETS = ['binder', 'spread'] as const;

export interface MultiCardLabel {
  id: string;
  name: string;
  tags: string[];
  corners: Point[];
  /** Share of the card inside the photo. */
  visible: number;
}

export interface MultiFixture {
  path: string;
  file: string;
  tags: string[];
  cards: MultiCardLabel[];
}

interface PoolCard {
  id: string;
  name: string;
  image: string;
  pool: 'special' | 'modern' | 'showcase';
  tags: string[];
  foil: boolean;
}

/** The owner's hardest cards, by set and number: on the first special pages, side by side. */
const OWNER_HARD = ['trk:346', 'trk:345', 'trk:458', 'trk:468'];
const SPECIAL_SETS: Record<string, string> = { trk: 'star-trek', trc: 'star-trek', who: 'doctor-who' };
const SPECIAL_COUNT = 48;
const BINDER_PAGES = 24;
const SPREADS = 20;
const IMAGE_DIR = 'scryfall-large';

interface BulkCard extends ScryfallCard {
  frame_effects?: string[];
  border_color?: string;
  image_status?: string;
}

const large = (url: string) => url.replace('/normal/', '/large/');

async function specialCards(bulk: string): Promise<PoolCard[]> {
  const found: { key: number; card: PoolCard }[] = [];
  const input = createReadStream(bulk);
  for await (const card of readJsonLines<BulkCard>(input.pipe(createGunzip()))) {
    const franchise = SPECIAL_SETS[card.set];
    if (!franchise || card.digital || card.lang !== 'en' || card.layout !== 'normal') continue;
    if (card.image_status === 'missing' || card.image_status === 'placeholder') continue;
    const borderless = card.border_color === 'borderless';
    const extended = (card.frame_effects ?? []).includes('extendedart');
    if (!borderless && !extended) continue;
    const image = frontImage(card);
    if (!image) continue;
    const hard = OWNER_HARD.indexOf(`${card.set}:${card.collector_number}`);
    found.push({
      // The owner's cards first, in their order; then a stable sample.
      key: hard >= 0 ? hard : 10 + sampleKey('manifest-multi-1', card.id),
      card: {
        id: card.id,
        name: card.name,
        image: large(image),
        pool: 'special',
        tags: [franchise, borderless ? 'borderless' : 'extended-art', ...(hard >= 0 ? ['owner-hard'] : [])],
        // The Saboteur the owner scanned is foil; a third of the rest too.
        foil: card.name === 'Dominion Saboteur' ? borderless : sampleKey('foil', card.id) % 3 === 0,
      },
    });
  }
  return found.sort((a, b) => a.key - b.key).slice(0, SPECIAL_COUNT).map((entry) => entry.card);
}

async function choosePools(bulk: string): Promise<{ special: PoolCard[]; modern: PoolCard[]; showcase: PoolCard[] }> {
  const evalCards = await selectEvalCards(bulk);
  const fromEval = (stratum: 'modern' | 'showcase'): PoolCard[] =>
    evalCards
      .filter((card) => card.stratum === stratum)
      .map((card) => ({ id: card.id, name: card.name, image: large(card.image), pool: stratum, tags: [...card.tags], foil: false }));
  return { special: await specialCards(bulk), modern: fromEval('modern'), showcase: fromEval('showcase') };
}

/** Takes cards from a pool in turn, starting over when it runs out. */
function cycler(pool: readonly PoolCard[]) {
  let next = 0;
  return () => pool[next++ % pool.length]!;
}

/**
 * The pages: a third all special (borderless and extended art side by side,
 * the owner's cards on the first two), a third mixed, a third ordinary.
 * Spreads alternate between mostly special and ordinary.
 */
function plan(set: MultiSet, pools: Awaited<ReturnType<typeof choosePools>>): { cards: PoolCard[]; empty: boolean[] }[] {
  const special = cycler(pools.special);
  const modern = cycler(pools.modern);
  const showcase = cycler(pools.showcase);
  const photos: { cards: PoolCard[]; empty: boolean[] }[] = [];
  const count = set === 'binder' ? BINDER_PAGES : SPREADS;
  for (let i = 0; i < count; i++) {
    const rng = createRng(seedFrom(`${set}-plan:${i}`));
    const size = set === 'binder' ? 9 : 4 + (i % 9);
    const kind = set === 'binder' ? (i < count / 3 ? 'special' : i < (2 * count) / 3 ? 'mixed' : 'ordinary') : i % 2 === 0 ? 'special' : 'ordinary';
    const cards = Array.from({ length: size }, (_, slot) => {
      if (kind === 'special') return special();
      if (kind === 'mixed') return slot % 2 === 0 ? special() : rng() < 0.7 ? modern() : showcase();
      return rng() < 0.8 ? modern() : showcase();
    });
    // Binders: an empty pocket or two on a third of the pages, never where the owner's cards go.
    const empty = cards.map(() => false);
    if (set === 'binder' && i > 1 && rng() < 0.35) {
      empty[Math.floor(rng() * 9)] = true;
      if (rng() < 0.4) empty[Math.floor(rng() * 9)] = true;
    }
    photos.push({ cards, empty });
  }
  return photos;
}

/** Builds a multi-card set once and reuses it from .cache afterwards. */
export async function multiFixtures(options: { cacheDir: string; set: MultiSet; regenerate: boolean; log: (m: string) => void }): Promise<MultiFixture[]> {
  const dir = join(options.cacheDir, `multi-${options.set}`);
  const labelsPath = join(dir, 'labels.json');
  if (!options.regenerate && existsSync(labelsPath)) {
    const labels = JSON.parse(await readFile(labelsPath, 'utf8')) as Record<string, { tags: string[]; cards: MultiCardLabel[] }>;
    return Object.entries(labels).map(([file, label]) => ({ path: join(dir, file), file: `multi-${options.set}/${file}`, tags: label.tags, cards: label.cards }));
  }

  const bulk = latestBulkFile();
  if (!bulk) throw new Error('No Scryfall bulk file in .cache/bulk. Run npm run index:build first.');
  options.log('Choosing cards…');
  const pools = await choosePools(bulk);
  const photos = plan(options.set, pools);
  const imageDir = join(options.cacheDir, IMAGE_DIR);
  const needed = [...new Map(photos.flatMap((photo) => photo.cards).map((card) => [card.id, card])).values()];
  await fetchImages(needed, imageDir, options.log);

  await mkdir(dir, { recursive: true });
  options.log(`Rendering ${photos.length} ${options.set} photos…`);
  const labels: Record<string, { tags: string[]; cards: MultiCardLabel[] }> = {};
  for (const [index, photo] of photos.entries()) {
    const images = await Promise.all(photo.cards.map((card) => readImage(cachedImagePath(imageDir, card.id))));
    const rng = createRng(seedFrom(`${options.set}:${index}`));
    const foils = new Set(photo.cards.flatMap((card, i) => (card.foil ? [i] : [])));
    const params: MultiParams =
      options.set === 'binder'
        ? binderParams(
            rng,
            photo.cards.map((_, i) => (photo.empty[i] ? null : i)),
            foils,
          )
        : spreadParams(
            rng,
            photo.cards.map((_, i) => i),
            foils,
          );
    const image = renderMulti(images, params, rng);
    const file = `${options.set}-${String(index + 1).padStart(2, '0')}.jpg`;
    await writeFile(join(dir, file), encodeJpeg(image, params.jpegQuality));
    const corners = photoCorners(params);
    labels[file] = {
      tags: ['synthetic', 'multi', options.set, ...params.conditions],
      cards: params.placements.map((placement, i) => {
        const card = photo.cards[placement.card]!;
        const visible = visibleShare(corners[i]!, params.frame);
        return {
          id: card.id,
          name: card.name,
          tags: [card.pool, ...card.tags, ...(placement.foil ? ['foil'] : []), ...(placement.sleeved ? ['sleeved'] : []), ...(visible < 0.999 ? ['cut-off'] : [])],
          corners: corners[i]!.map(({ x, y }) => ({ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 })),
          visible: Math.round(visible * 1000) / 1000,
        };
      }),
    };
    options.log(`  ${file}: ${params.placements.length} cards, ${params.conditions.join(', ')}`);
  }
  await writeFile(labelsPath, JSON.stringify(labels, null, 1));
  return multiFixtures({ ...options, regenerate: false });
}
