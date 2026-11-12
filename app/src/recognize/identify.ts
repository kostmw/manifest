/**
 * Stage 3, exact printing: combines the title's name candidates (signal A),
 * the collector line (B) and the art and card fingerprints (C) into ranked
 * printings with a confidence. When the title is unsure, the fingerprints are
 * searched across every printing and the collector line is looked up on its
 * own, so a card whose title can't be read can still be found.
 */
import type { CardRegions, CollectorMatch, CollectorReading, GameAdapter } from '../games/adapter';
import type { Catalog, CatalogPrinting } from '../games/catalog';
import type { CollectorIndex } from '../games/collectorIndex';
import type { Printing } from '../games/types';
import type { Quad } from '../vision/geometry';
import type { GrayImage, RgbaImage } from '../vision/image';
import { cropCollectorLines } from './collectorCrop';
import {
  canvasFromFrame,
  cornersMapping,
  distanceAt,
  fingerprintAt,
  toWords,
  type CardMapping,
  type CardPlacement,
} from './fingerprint';
import { COLLECTOR_CHARACTERS, COLLECTOR_NUMBER_CHARACTERS, type OcrEngine } from './ocr';
import type { TitleMatch } from './titleMatch';

export type Signal = 'title' | 'hash' | 'collector';

export interface PrintingCandidate {
  printing: Printing;
  /** What ranks the candidates. */
  score: number;
  /** Title similarity of this printing's name, 0 when the title didn't suggest it. */
  title: number;
  /** Art + card hash distance (0–128) at the best registration; null without a fingerprint. */
  hashDistance: number | null;
  /** How the collector line fits; null when none was read. */
  collector: CollectorMatch | null;
  /** The signals that put this name forward. */
  sources: Signal[];
}

export interface PrintingIdentification {
  /** Best first, at most five. */
  candidates: PrintingCandidate[];
  /** 0–1, that the top candidate is the right printing: nameConfidence × printingConfidence. */
  confidence: number;
  /** 0–1, that the top candidate's name is right. */
  nameConfidence: number;
  /** 0–1, that the top candidate is the right printing of its name. */
  printingConfidence: number;
  collector: CollectorReading | null;
  /** Which outline the card was registered with ('card', or one of the regions' outlines). */
  outline: string;
  /** True when the fingerprints say the card is the other way up from what the title reading assumed. */
  turned: boolean;
  /** The collector line crops that were read, when keepImages is set. */
  collectorCrops?: GrayImage[];
  /** With a set lock: the top candidate's name has no printing in the locked sets. */
  outsideLock: boolean;
}

export interface IdentifyInput {
  frame: RgbaImage;
  /** In reading order, upright as far as the title reading could tell. */
  corners: Quad;
  /** Whether the title read well enough to trust which way up the card is. */
  orientationKnown: boolean;
  title: TitleMatch;
  game: Pick<GameAdapter, 'regions' | 'parseCollectorLine' | 'matchCollector' | 'printingPrior'>;
  catalog: Catalog;
  collectors: CollectorIndex | null;
  ocr: OcrEngine;
  /**
   * The batch is locked to these sets (the data source's codes): a name's
   * printings from other sets are left out whenever it has one in them, and a
   * name with none in them ranks a little lower and is flagged `outsideLock`.
   */
  lockSets?: readonly string[];
  keepImages?: boolean;
  lap?: (stage: string) => void;
}

/** Card units around the card kept for fingerprinting, enough for the widest outline guess. */
const CANVAS_MARGIN = 56;
/** A title match this confident is taken as the name, unless the artwork disagrees. */
const SURE_TITLE = 0.9;
/** Global fingerprint hits kept for a closer look. */
const GLOBAL_HITS = 12;
/** Farther than this (of 128 bits), a fingerprint is a different card. */
const GLOBAL_MAX_DISTANCE = 26;
/** This close, the artwork is a match. */
const ART_MATCH = 14;
/**
 * Farther than this, the artwork is another card outright: unrelated
 * fingerprints differ by about 64 of 128 bits, while a true match under glare
 * or a misplaced outline stays under about 40.
 */
const ART_CONTRADICTS = 48;
/** The most a name, or a printing, can be trusted when every printing of it has plainly other artwork. */
const CONTRADICTED_CAP = 0.5;
const TOP = 5;
/**
 * Score taken off a name with no printing in the batch's locked sets: enough
 * to settle a near tie in favour of a card from those sets, not to bury a card
 * that plainly is something else (it is shown, flagged, for review).
 */
const OUTSIDE_LOCK_PENALTY = 0.3;
/** A collector number names at most this many cards across the locked sets before it is ignored. */
const LOCKED_NUMBER_NAMES = 3;

/** The real card's place in the detected outline's own coordinates, given where that outline lies on the card. */
export function placementFor(outline: { x: number; y: number; width: number; height: number }, size: { width: number; height: number }): CardPlacement {
  const kx = size.width / outline.width;
  const ky = size.height / outline.height;
  return [-outline.x * kx, -outline.y * ky, (size.width - outline.x) * kx, (size.height - outline.y) * ky];
}

/** `mapping` (detected outline → frame) preceded by the card → outline step of a placement. */
export function placedMapping(mapping: CardMapping, placement: CardPlacement, size: { width: number; height: number }): CardMapping {
  const kx = (placement[2] - placement[0]) / size.width;
  const ky = (placement[3] - placement[1]) / size.height;
  const m = mapping;
  return [
    m[0] * kx,
    m[1] * ky,
    m[0] * placement[0] + m[1] * placement[1] + m[2],
    m[3] * kx,
    m[4] * ky,
    m[3] * placement[0] + m[4] * placement[1] + m[5],
    m[6] * kx,
    m[7] * ky,
    m[6] * placement[0] + m[7] * placement[1] + m[8],
  ];
}

const turnCorners = (corners: Quad): Quad => [corners[2], corners[3], corners[0], corners[1]];

interface Query {
  words: Uint32Array;
  turned: boolean;
  outline: string;
  mapping: CardMapping;
  placement: CardPlacement;
}

/** The card's fingerprint under each registration guess (the outline, the frame line, a sleeve), and turned over unless the way up is known. */
function fingerprintQueries(
  frame: RgbaImage,
  corners: Quad,
  regions: CardRegions,
  orientationKnown: boolean,
  hasFingerprints: boolean,
  outlineOnly = false,
): Query[] {
  const size = regions.size;
  const placements = [
    { id: 'card', placement: [0, 0, size.width, size.height] as CardPlacement },
    ...(outlineOnly ? [] : regions.outlines.map((outline) => ({ id: outline.id, placement: placementFor(outline.box, size) }))),
  ];
  const queries: Query[] = [];
  for (const turned of orientationKnown ? [false] : [false, true]) {
    const mapping = cornersMapping(turned ? turnCorners(corners) : corners, size);
    if (!mapping) continue;
    const canvas = hasFingerprints ? canvasFromFrame(frame, mapping, size, CANVAS_MARGIN) : null;
    for (const { id, placement } of placements) {
      queries.push({
        words: canvas ? toWords(fingerprintAt(canvas, regions, placement)) : new Uint32Array(0),
        turned,
        outline: id,
        mapping,
        placement,
      });
    }
  }
  return queries;
}

/** Set bits in a 32-bit word, inlined by hand for the table scan below. */
const bits = (v: number): number => {
  v -= (v >>> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24);
};

/** An axis-aligned rectangle in frame pixels: [x0, y0, x1, y1]. */
export type FrameBox = readonly [number, number, number, number];

/**
 * How closely the artwork inside each upright rectangle matches anything in
 * the index: the smallest fingerprint distance (of 128 bits), either way up,
 * in one pass over the fingerprint table. Null without fingerprints. For
 * choosing among guesses at where a card is: the right guess matches some
 * printing far better than the wrong ones match any. Every rectangle is
 * sampled from one canvas of the whole frame (and one turned over), so dozens
 * cost little more than one.
 */
export async function nearestArt(frame: RgbaImage, boxes: readonly FrameBox[], regions: CardRegions, catalog: Catalog): Promise<number[] | null> {
  if (!(await catalog.hasFingerprints())) return null;
  const table = await catalog.fingerprintTable();
  if (!table) return null;
  const { width: w, height: h } = frame;
  const whole = { width: w, height: h };
  const corner = (x: number, y: number) => ({ x: x - 0.5, y: y - 0.5 });
  const upright = cornersMapping([corner(0, 0), corner(w, 0), corner(w, h), corner(0, h)], whole);
  const turned = cornersMapping([corner(w, h), corner(0, h), corner(0, 0), corner(w, 0)], whole);
  if (!upright || !turned) return null;
  const canvases = [canvasFromFrame(frame, upright, whole, 0), canvasFromFrame(frame, turned, whole, 0)] as const;

  // Each box's fingerprint, upright then turned over: 4 words each.
  const count = boxes.length * 2;
  const query = new Uint32Array(count * 4);
  boxes.forEach(([x0, y0, x1, y1], q) => {
    query.set(toWords(fingerprintAt(canvases[0], regions, [x0, y0, x1, y1])), q * 8);
    query.set(toWords(fingerprintAt(canvases[1], regions, [w - x1, h - y1, w - x0, h - y0])), q * 8 + 4);
  });
  const best = new Float64Array(count).fill(Number.POSITIVE_INFINITY);
  for (const { words, rows } of table.shards) {
    for (let row = 0; row < rows; row++) {
      const o = row * table.rowWords;
      const w0 = words[o]!;
      const w1 = words[o + 1]!;
      const w2 = words[o + 2]!;
      const w3 = words[o + 3]!;
      if ((w0 | w1 | w2 | w3) === 0) continue;
      for (let k = 0; k < count; k++) {
        const b = k * 4;
        const d = bits(query[b]! ^ w0) + bits(query[b + 1]! ^ w1) + bits(query[b + 2]! ^ w2) + bits(query[b + 3]! ^ w3);
        if (d < best[k]!) best[k] = d;
      }
    }
  }
  return boxes.map((_, q) => Math.min(best[q * 2]!, best[q * 2 + 1]!));
}

function minDistance(queries: readonly Query[], table: Uint32Array, row: number): { distance: number; query: Query } {
  let best = Number.POSITIVE_INFINITY;
  let which = queries[0]!;
  for (const query of queries) {
    const d = distanceAt(query.words, table, row);
    const sum = d.art + d.card;
    if (sum < best) {
      best = sum;
      which = query;
    }
  }
  return { distance: best, query: which };
}

/**
 * Hash distance (of 128 bits) → evidence, from about 1 down to -0.3. True
 * matches sit under about 12 and unrelated cards around 30; in between, a few
 * bits either way are noise, so the curve is flat at both ends and steep in
 * the middle. Art that clearly doesn't match counts against a printing, so a
 * junk title reading can't outvote a good fingerprint. No fingerprint is 0.
 */
export function hashEvidence(distance: number | null): number {
  if (distance === null) return 0;
  // A small linear part still prefers the closer of two near-identical scans.
  return 1.2 / (1 + Math.exp((distance - 15) / 2.5)) - 0.3 + 0.1 * Math.max(0, 1 - distance / 26);
}

const WEIGHTS = { title: 2, hash: 1.5, collector: 1.2 };

/** Softmax share of the first of `scores`. */
function share(scores: readonly number[], index: number): number {
  const max = Math.max(...scores);
  const total = scores.reduce((sum, score) => sum + Math.exp(score - max), 0);
  return Math.exp(scores[index]! - max) / total;
}

export async function identifyPrinting(input: IdentifyInput): Promise<PrintingIdentification> {
  const { frame, game, catalog, title } = input;
  const locked = (input.lockSets ?? []).filter(Boolean).map((set) => set.toLowerCase());
  const lock = locked.length > 0 ? new Set(locked) : null;
  const { regions } = game;
  const size = regions.size;
  const lap = input.lap ?? (() => {});

  // Fingerprints of the card under each registration guess (and turned over, if unsure).
  const hasFingerprints = await catalog.hasFingerprints();
  const queries = fingerprintQueries(frame, input.corners, regions, input.orientationKnown, hasFingerprints);
  lap('fingerprint');

  // The candidate pool: printings of every name any signal puts forward.
  const pool = new Map<string, { entries: CatalogPrinting[]; sources: Set<Signal> }>();
  const addNames = async (names: readonly string[], source: Signal) => {
    const fresh = names.filter((name) => !pool.has(name));
    const loaded = await Promise.all(fresh.map((name) => catalog.printings(name).catch(() => [] as CatalogPrinting[])));
    fresh.forEach((name, i) => pool.set(name, { entries: loaded[i]!, sources: new Set() }));
    for (const name of names) pool.get(name)!.sources.add(source);
  };
  const titleSimilarity = new Map(title.candidates.map((candidate) => [candidate.name, candidate.similarity]));
  // A sure title needs only its own printings; each other name could cost a shard download.
  const titleNames = title.candidates.map((candidate) => candidate.name);
  await addNames(title.confidence >= SURE_TITLE ? titleNames.slice(0, 1) : titleNames, 'title');

  const distances = new Map<string, { distance: number; query: Query }>();
  const measure = () => {
    if (!hasFingerprints) return;
    for (const { entries } of pool.values()) {
      for (const { printing, fingerprint } of entries) {
        if (fingerprint && !distances.has(printing.id)) distances.set(printing.id, minDistance(queries, fingerprint, 0));
      }
    }
  };
  measure();

  // No confident title, or nothing that looks like it: search every fingerprint.
  const bestTitleDistance = Math.min(...[...distances.values()].map((d) => d.distance), Number.POSITIVE_INFINITY);
  if (hasFingerprints && (title.confidence < SURE_TITLE || bestTitleDistance > 16)) {
    const table = await catalog.fingerprintTable();
    if (table) {
      const hits: { shard: number; row: number; distance: number }[] = [];
      let worst = Number.POSITIVE_INFINITY;
      for (const { shard, words, rows } of table.shards) {
        for (let row = 0; row < rows; row++) {
          const o = row * table.rowWords;
          if ((words[o]! | words[o + 1]! | words[o + 2]! | words[o + 3]!) === 0) continue;
          const { distance } = minDistance(queries, words, row);
          if (hits.length < GLOBAL_HITS || distance < worst) {
            hits.push({ shard, row, distance });
            hits.sort((a, b) => a.distance - b.distance);
            if (hits.length > GLOBAL_HITS) hits.pop();
            worst = hits[hits.length - 1]!.distance;
          }
        }
      }
      // Only hits that could be the card: near the best, and not hopelessly far from a match.
      const best = hits[0]?.distance ?? Number.POSITIVE_INFINITY;
      const close = hits.filter((hit) => hit.distance <= Math.min(GLOBAL_MAX_DISTANCE, Math.max(18, best + 4)));
      const found = await Promise.all(close.map((hit) => catalog.printingAt(hit.shard, hit.row)));
      await addNames([...new Set(found.filter((entry) => entry !== null).map((entry) => entry!.printing.name))], 'hash');
      measure();
    }
    lap('hash-search');
  }

  // Register the collector line the way the best-fitting fingerprint did.
  const ranked = [...pool.entries()].flatMap(([name, { entries }]) =>
    entries.map((entry) => ({
      name,
      entry,
      score: WEIGHTS.title * (titleSimilarity.get(name) ?? 0) + WEIGHTS.hash * hashEvidence(distances.get(entry.printing.id)?.distance ?? null),
    })),
  );
  ranked.sort((a, b) => b.score - a.score);
  const leader = ranked[0] ? distances.get(ranked[0].entry.printing.id)?.query : undefined;
  const firstQuery = leader ?? queries[0]!;
  const tries = [firstQuery];
  const identity = queries.find((query) => query.turned === firstQuery.turned && query.outline === 'card');
  if (identity && identity !== firstQuery) tries.push(identity);

  let collector: CollectorReading | null = null;
  let used = firstQuery;
  const crops: GrayImage[] = [];
  for (const query of tries) {
    const lines = cropCollectorLines(frame, placedMapping(query.mapping, query.placement, size), regions.collector);
    const texts: string[] = [];
    for (const line of lines) {
      texts.push((await input.ocr.readLine(line.image, { characters: COLLECTOR_CHARACTERS })).text);
      if (input.keepImages) crops.push(line.image);
    }
    let reading = game.parseCollectorLine(texts);
    // The line above the set code is the number line. If no number came out of it, read it
    // again with digits only, which stops OCR turning a 5 into an S or a 0 into a D.
    const setLine = texts.findIndex((text) => game.parseCollectorLine([text])?.sets.length);
    if (setLine > 0 && !reading?.numbers.length) {
      const digits = (await input.ocr.readLine(lines[setLine - 1]!.image, { characters: COLLECTOR_NUMBER_CHARACTERS })).text;
      const again = game.parseCollectorLine([...texts, digits]);
      if (again?.numbers.length) {
        reading = again;
        texts.push(digits);
      }
    }
    if (reading && (!collector || reading.numbers.length + reading.sets.length > collector.numbers.length + collector.sets.length)) {
      collector = reading;
      used = query;
    }
    if (collector?.numbers.length && collector.sets.length) break;
  }
  lap('collector');

  // A collector line that names a card on its own (set and number both read).
  if (collector && input.collectors && collector.numbers.length && collector.sets.length) {
    const knownSets = input.collectors.sets();
    const names = new Set<string>();
    // Exact set codes first; a look-alike only when nothing matches exactly.
    for (const wanted of ['exact', 'close'] as const) {
      for (const code of collector.sets) {
        for (const set of knownSets) {
          if (game.matchCollector({ ...collector, numbers: [], sets: [code] }, { set, number: '' }).set !== wanted) continue;
          for (const number of collector.numbers) for (const name of input.collectors.lookup(set, number)) names.add(name);
        }
      }
      if (names.size > 0) break;
    }
    if (names.size > 0 && names.size <= 3) {
      await addNames([...names], 'collector');
      measure();
    }
  }
  // Locked to a few sets, the number alone can name the card when the set code didn't read.
  if (collector && input.collectors && lock && collector.numbers.length && !collector.looseNumbers) {
    const names = new Set<string>();
    for (const set of lock) for (const number of collector.numbers.slice(0, 2)) for (const name of input.collectors.lookup(set, number)) names.add(name);
    if (names.size > 0 && names.size <= LOCKED_NUMBER_NAMES) {
      await addNames([...names], 'collector');
      measure();
    }
  }

  // Score every printing in the pool. When the artwork clearly matches some printing, a
  // printing whose art plainly doesn't gets no credit from the collector line: a misread number
  // can name another card entirely. (With a bad outline nothing matches, and the collector line
  // is all there is.)
  const artSettled = Math.min(...[...distances.values()].map((d) => d.distance), Number.POSITIVE_INFINITY) <= ART_MATCH;
  const contradicted = (distance: number | null) => artSettled && distance !== null && distance > GLOBAL_MAX_DISTANCE;
  const scored: PrintingCandidate[] = [];
  const outsideNames = new Set<string>();
  for (const [name, { entries: all, sources }] of pool) {
    // With a set lock, only the name's printings from the locked sets compete, when it has any.
    const locked = lock ? all.filter((entry) => lock.has(entry.printing.set)) : all;
    if (lock && locked.length === 0 && all.length > 0) outsideNames.add(name);
    const entries = locked.length > 0 ? locked : all;
    const penalty = outsideNames.has(name) ? OUTSIDE_LOCK_PENALTY : 0;
    for (const { printing } of entries) {
      const hashDistance = distances.get(printing.id)?.distance ?? null;
      const read = collector ? game.matchCollector(collector, printing) : null;
      const match = read && contradicted(hashDistance) ? { ...read, score: Math.min(0, read.score) } : read;
      const titleScore = titleSimilarity.get(name) ?? 0;
      scored.push({
        printing,
        score:
          WEIGHTS.title * titleScore +
          WEIGHTS.hash * hashEvidence(hashDistance) +
          WEIGHTS.collector * (match?.score ?? 0) +
          game.printingPrior(printing) -
          penalty,
        title: titleScore,
        hashDistance,
        collector: match,
        sources: [...sources],
      });
    }
  }
  scored.sort((a, b) => b.score - a.score || (b.printing.released ?? '').localeCompare(a.printing.released ?? ''));
  const top = scored[0];
  if (!top) {
    return { candidates: [], confidence: 0, nameConfidence: 0, printingConfidence: 0, collector, outline: used.outline, turned: used.turned, outsideLock: false };
  }

  // How sure the name is: each signal on its own, combined as if independent.
  const topName = top.printing.name;
  const sameName = scored.filter((candidate) => candidate.printing.name === topName);
  const fromTitle = title.candidates[0]?.name === topName ? title.confidence : 0;
  // A collector reading only vouches for a name when that printing's art doesn't plainly
  // contradict it, even when nothing else matches either: a misread number can name another card
  // entirely, and a card found by its collector line alone goes to review unless its art agrees.
  const plausible = sameName.filter((c) => c.hashDistance === null || c.hashDistance <= GLOBAL_MAX_DISTANCE);
  const bestMatch = plausible.reduce<CollectorMatch | null>((best, c) => (c.collector && (!best || c.collector.score > best.score) ? c.collector : best), null);
  const fromCollector =
    collector?.looseNumbers
      ? 0
      : bestMatch?.number === 'exact' && bestMatch.set === 'exact'
      ? 0.9
      : bestMatch?.number === 'exact' && bestMatch.set === 'close'
        ? 0.75
        : 0;
  const nameDistance = Math.min(...sameName.map((c) => c.hashDistance ?? Number.POSITIVE_INFINITY));
  const otherDistance = Math.min(...scored.filter((c) => c.printing.name !== topName).map((c) => c.hashDistance ?? Number.POSITIVE_INFINITY));
  const fromHash =
    nameDistance <= 12 && otherDistance - nameDistance >= 10 ? 0.85 : nameDistance <= 16 && otherDistance - nameDistance >= 6 ? 0.5 : 0;
  // Every printing of the name has plainly other artwork: whatever the title or collector line
  // said (OCR can make a real name out of texture), this card is not accepted unseen.
  const otherArt = sameName.every((c) => c.hashDistance !== null && c.hashDistance > ART_CONTRADICTS);
  const cap = otherArt ? CONTRADICTED_CAP : 1;
  const nameConfidence = Math.min(cap, 1 - (1 - fromTitle) * (1 - fromCollector) * (1 - fromHash));

  // Which printing of that name: fingerprints and collector line only. Printings that look
  // the same split the share between them, so only the collector line can settle those.
  const evidence = sameName.map((c) => -(c.hashDistance ?? 24) / 3 + 3 * (c.collector?.score ?? 0));
  const printingConfidence = Math.min(cap, sameName.length === 1 ? 1 : share(evidence, 0));

  return {
    candidates: scored.slice(0, TOP),
    confidence: nameConfidence * printingConfidence,
    nameConfidence,
    printingConfidence,
    collector,
    outline: used.outline,
    turned: used.turned,
    outsideLock: outsideNames.has(topName),
    ...(input.keepImages ? { collectorCrops: crops } : {}),
  };
}
