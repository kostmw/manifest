/**
 * Chooses the synthetic eval set: a fixed, stratified sample of physical MTG
 * printings from the Scryfall bulk file. The choice depends only on card ids
 * and the seed, so the same bulk file always gives the same set.
 */
import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { readJsonLines, type ScryfallCard } from '../../scripts/games/mtg';

export interface EvalCard {
  id: string;
  /** Full name, the way the name dictionary spells it. */
  name: string;
  set: string;
  number: string;
  lang: string;
  layout: string;
  frame: string;
  image: string;
  stratum: string;
  tags: string[];
}

interface BulkCard extends ScryfallCard {
  frame?: string;
  frame_effects?: string[];
  border_color?: string;
  full_art?: boolean;
  image_status?: string;
}

const SPECIAL_EFFECTS = ['showcase', 'extendedart', 'fullart', 'inverted', 'etched', 'shatteredglass'];
const OTHER_LAYOUTS = ['adventure', 'split', 'flip', 'saga', 'class', 'mutate', 'leveler', 'prototype', 'case'];

const isBasicLand = (card: BulkCard) => (card.type_line ?? '').startsWith('Basic Land');
const hasEffect = (card: BulkCard, effects: readonly string[]) =>
  (card.frame_effects ?? []).some((effect) => effects.includes(effect));
const isSpecialTreatment = (card: BulkCard) =>
  card.border_color === 'borderless' || card.full_art === true || hasEffect(card, SPECIAL_EFFECTS);

interface Stratum {
  id: string;
  count: number;
  tags: string[];
  test: (card: BulkCard) => boolean;
}

/** A card falls into the first stratum it matches. */
export const STRATA: readonly Stratum[] = [
  {
    id: 'modern',
    count: 150,
    tags: ['modern'],
    test: (card) =>
      card.frame === '2015' &&
      card.layout === 'normal' &&
      card.lang === 'en' &&
      card.border_color === 'black' &&
      !isSpecialTreatment(card) &&
      !isBasicLand(card),
  },
  {
    id: 'frame-2003',
    count: 30,
    tags: ['frame-2003'],
    test: (card) => card.frame === '2003' && card.layout === 'normal' && card.lang === 'en' && !isBasicLand(card),
  },
  {
    id: 'old-frame',
    count: 30,
    tags: ['old-frame'],
    test: (card) =>
      (card.frame === '1993' || card.frame === '1997') &&
      card.layout === 'normal' &&
      card.lang === 'en' &&
      !isBasicLand(card),
  },
  {
    id: 'showcase',
    count: 30,
    tags: ['showcase'],
    test: (card) => card.layout === 'normal' && card.lang === 'en' && isSpecialTreatment(card) && !isBasicLand(card),
  },
  {
    id: 'dfc',
    count: 20,
    tags: ['dfc'],
    test: (card) => (card.layout === 'transform' || card.layout === 'modal_dfc') && card.lang === 'en',
  },
  { id: 'basic-land', count: 15, tags: ['basic-land'], test: (card) => isBasicLand(card) && card.lang === 'en' },
  {
    id: 'other-layout',
    count: 20,
    tags: ['other-layout'],
    test: (card) => OTHER_LAYOUTS.includes(card.layout) && card.lang === 'en',
  },
  { id: 'token', count: 10, tags: ['token'], test: (card) => card.layout === 'token' && card.lang === 'en' },
  {
    id: 'non-english',
    count: 15,
    tags: ['non-english'],
    test: (card) => card.lang !== 'en' && card.layout === 'normal',
  },
];

/** FNV-1a of the seed and id: a stable, well-spread sort key. */
export function sampleKey(seed: string, id: string): number {
  let hash = 0x811c9dc5;
  const text = `${seed}:${id}`;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function frontImage(card: ScryfallCard): string | undefined {
  return card.image_uris?.normal ?? card.card_faces?.[0]?.image_uris?.normal;
}

/** A physical card of normal size with a real scan. */
function isScannable(card: BulkCard): boolean {
  if (card.digital || (card as { oversized?: boolean }).oversized) return false;
  if (card.image_status === 'missing' || card.image_status === 'placeholder') return false;
  return Boolean(frontImage(card));
}

export function classify(card: BulkCard): Stratum | null {
  if (!isScannable(card)) return null;
  return STRATA.find((stratum) => stratum.test(card)) ?? null;
}

export async function selectEvalCards(bulkFile: string, seed = 'manifest-eval-1'): Promise<EvalCard[]> {
  const pools = new Map<string, { key: number; card: EvalCard }[]>();
  const input = createReadStream(bulkFile);
  const stream = bulkFile.endsWith('.gz') ? input.pipe(createGunzip()) : input;

  for await (const card of readJsonLines<BulkCard>(stream)) {
    const stratum = classify(card);
    if (!stratum) continue;
    const pool = pools.get(stratum.id) ?? [];
    pool.push({
      key: sampleKey(seed, card.id),
      card: {
        id: card.id,
        name: card.name,
        set: card.set,
        number: card.collector_number,
        lang: card.lang,
        layout: card.layout,
        frame: card.frame ?? '',
        image: frontImage(card)!,
        stratum: stratum.id,
        tags: stratum.tags,
      },
    });
    // Only the lowest keys can be chosen, so the pool never needs to hold everything.
    if (pool.length > stratum.count * 4) {
      pool.sort((a, b) => a.key - b.key);
      pool.length = stratum.count;
    }
    pools.set(stratum.id, pool);
  }

  return STRATA.flatMap((stratum) =>
    (pools.get(stratum.id) ?? [])
      .sort((a, b) => a.key - b.key)
      .slice(0, stratum.count)
      .map((entry) => entry.card),
  );
}

export interface PhoneCard extends EvalCard {
  /** Rendered with a foil sheen. */
  foil: boolean;
}

/** How many of each standard stratum the `phone` set reuses (the first ones, so it is a fixed subset). */
const PHONE_STRATA: Record<string, number> = { modern: 60, showcase: 30, token: 10, 'basic-land': 15 };
const STAR_TREK_SETS = ['trk', 'trc', 'ttrk', 'ttrc'];

/**
 * The `phone` set's cards: a fixed subset of the eval cards, plus the kinds
 * the owner's first phone tests failed on: Star Trek planets (a translucent
 * title bar over busy art), the borderless Dominion Saboteur (light text on
 * stained-glass art, scanned as a foil) and Star Trek tokens.
 */
export async function selectPhoneCards(bulkFile: string): Promise<PhoneCard[]> {
  const chosen: PhoneCard[] = [];
  for (const card of await selectEvalCards(bulkFile)) {
    const taken = chosen.filter((c) => c.stratum === card.stratum).length;
    if (taken >= (PHONE_STRATA[card.stratum] ?? 0)) continue;
    // A third of the special treatments as foils: they are the cards most often printed foil.
    chosen.push({ ...card, foil: card.stratum === 'showcase' && sampleKey('foil', card.id) % 3 === 0 });
  }

  const input = createReadStream(bulkFile);
  const stream = bulkFile.endsWith('.gz') ? input.pipe(createGunzip()) : input;
  const tokens = new Set<string>();
  for await (const card of readJsonLines<BulkCard>(stream)) {
    if (!STAR_TREK_SETS.includes(card.set) || !isScannable(card)) continue;
    const typeLine = card.type_line ?? '';
    const isToken = card.layout === 'token';
    let tags: string[] | null = null;
    if (isToken) {
      if (tokens.has(card.name)) continue;
      tokens.add(card.name);
      tags = ['star-trek', 'token'];
    } else if (typeLine.includes('Planet')) {
      tags = ['star-trek', 'planet'];
    } else if (card.name === 'Dominion Saboteur') {
      tags = ['star-trek', card.border_color === 'borderless' ? 'borderless' : 'modern'];
    }
    if (!tags) continue;
    chosen.push({
      id: card.id,
      name: card.name,
      set: card.set,
      number: card.collector_number,
      lang: card.lang,
      layout: card.layout,
      frame: card.frame ?? '',
      image: frontImage(card)!,
      stratum: 'star-trek',
      tags,
      foil: card.border_color === 'borderless',
    });
  }
  return chosen;
}
