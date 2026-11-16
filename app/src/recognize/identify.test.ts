import { describe, expect, it } from 'vitest';
import { Catalog, type IndexSource } from '../games/catalog';
import { buildCollectorIndex, CollectorIndex } from '../games/collectorIndex';
import { encodeHashShard } from '../games/hashShard';
import { mtg, MTG_REGIONS } from '../games/mtg/adapter';
import type { GameIndex, IndexFile, Printing } from '../games/types';
import { orderCardCorners } from '../vision/geometry';
import { artCard, cardQuad, placeCard, scryfallSmall as small } from '../vision/testScene';
import { FINGERPRINT_BYTES, FINGERPRINT_VERSION, fingerprintCardImage } from './fingerprint';
import type { CardDetection } from '../vision/detect';
import { identifyPrinting, placedMapping, placementFor } from './identify';
import { NameIndex } from './nameSearch';
import { recognizeFrame } from './pipeline';
import { COLLECTOR_CHARACTERS, type OcrEngine } from './ocr';
import type { TitleMatch } from './titleMatch';
import type { RgbaImage } from '../vision/image';

const printing = (name: string, set: string, number: string, released: string): Printing => ({
  id: `${set}-${number}`,
  name,
  set,
  setName: set.toUpperCase(),
  number,
  finishes: ['nonfoil', 'foil'],
  lang: 'en',
  released,
});

/** Sol Ring in two sets with the same art, and in a third with its own; Opt with other art. */
const PRINTINGS: { printing: Printing; art: number }[] = [
  { printing: printing('Opt', 'dom', '60', '2018-04-27'), art: 9 },
  { printing: printing('Sol Ring', 'c21', '263', '2021-04-23'), art: 1 },
  { printing: printing('Sol Ring', 'cmm', '410', '2023-08-04'), art: 2 },
  { printing: printing('Sol Ring', 'cmm', '703', '2023-08-04'), art: 2 },
];
const NAMES = ['Opt', 'Sol Ring'];
const ARTS = new Map(PRINTINGS.map(({ art }) => [art, artCard(art)]));

/** A one-shard index held in memory, with fingerprints, and any `extra` printings. */
function memorySource(withFingerprints = true, invertArt: (name: string) => boolean = () => false, extra: { printing: Printing; art: number }[] = []): IndexSource {
  const all = [...PRINTINGS, ...extra];
  const names = [...new Set([...NAMES, ...extra.map(({ printing }) => printing.name)])].sort();
  const sorted = [...all].sort((a, b) => (a.printing.name < b.printing.name ? -1 : a.printing.name > b.printing.name ? 1 : a.printing.id < b.printing.id ? -1 : 1));
  const shardFile: IndexFile = { file: 'printings.mtg.00.json', bytes: 0, sha256: 'ab'.repeat(32) };
  const hashFile: IndexFile = { file: 'hashes.mtg.00.bin', bytes: 0, sha256: 'cd'.repeat(32) };
  const collectorsFile: IndexFile = { file: 'collectors.mtg.json', bytes: 0, sha256: 'ef'.repeat(32) };
  const index: GameIndex = {
    source: { name: 'test', updatedAt: 'now' },
    counts: { names: names.length, printings: all.length },
    names: { file: 'names.mtg.json', bytes: 0, sha256: '00'.repeat(32) },
    shards: [shardFile],
    collectors: collectorsFile,
    ...(withFingerprints
      ? { hashes: [hashFile], fingerprint: { version: FINGERPRINT_VERSION, rowBytes: FINGERPRINT_BYTES, imageSize: 'small' } }
      : {}),
  };
  const hashes = encodeHashShard({
    version: FINGERPRINT_VERSION,
    rowBytes: FINGERPRINT_BYTES,
    printingsSha256: shardFile.sha256,
    rows: sorted.map(({ art, printing }) => {
      const row = fingerprintCardImage(small(ARTS.get(art) ?? artCard(art)), MTG_REGIONS);
      // Every bit flipped: artwork as unlike this card's as artwork can be.
      return invertArt(printing.name) ? row.map((byte) => 255 - byte) : row;
    }),
  });
  const files: Record<string, unknown> = {
    [shardFile.file]: sorted.map(({ printing }) => printing),
    [collectorsFile.file]: buildCollectorIndex(
      sorted.map(({ printing }) => printing),
      names,
      '2014-07-01',
    ),
  };
  return {
    gameIndex: async () => index,
    json: async (file) => files[file.file] as never,
    bytes: async () => hashes,
  };
}

/** Title reads come from `title`; collector-line reads from `collector`, in order. */
function fakeOcr(collector: string[], reads?: { collector: number }): OcrEngine {
  let next = 0;
  return {
    async readLine(_image, options) {
      if (options?.characters === COLLECTOR_CHARACTERS) {
        if (reads) reads.collector += 1;
        return { text: collector[next++] ?? '', confidence: 80 };
      }
      return { text: '', confidence: 0 };
    },
    async dispose() {},
  };
}

const sure = (name: string): TitleMatch => ({ candidates: [{ name, distance: 0, similarity: 1 }], confidence: 1, reading: name });
const junk: TitleMatch = { candidates: [], confidence: 0, reading: '' };

async function identify(
  art: number,
  options: {
    title: TitleMatch;
    collector?: string[];
    fingerprints?: boolean;
    angle?: number;
    invertArt?: (name: string) => boolean;
    lockSets?: string[];
    reads?: { collector: number };
    /** The card as photographed, when not the plain art (a flashlight's hotspot, say). */
    picture?: RgbaImage;
    extra?: { printing: Printing; art: number }[];
  },
) {
  const corners = cardQuad({ x: 400, y: 520 }, 820, options.angle ?? 0.05);
  const frame = placeCard(options.picture ?? ARTS.get(art)!, { width: 800, height: 1040 }, corners, [60, 80, 70]);
  const catalog = new Catalog(memorySource(options.fingerprints ?? true, options.invertArt, options.extra), FINGERPRINT_VERSION);
  const dictionary = { names: [...new Set([...NAMES, ...(options.extra ?? []).map(({ printing }) => printing.name)])].sort(), faces: {} };
  return identifyPrinting({
    frame,
    // As detection reports them: the edge higher in the frame is taken as the top.
    corners: orderCardCorners(corners),
    orientationKnown: options.title.confidence > 0.5,
    title: options.title,
    game: mtg,
    catalog,
    collectors: await catalog.collectors(dictionary),
    ocr: fakeOcr(options.collector ?? [], options.reads),
    ...(options.lockSets ? { lockSets: options.lockSets } : {}),
  });
}

describe('identifyPrinting', () => {
  it('picks the printing whose art matches, and is sure of it when no other printing looks alike', async () => {
    const result = await identify(1, { title: sure('Sol Ring') });
    expect(result.candidates[0]?.printing.id).toBe('c21-263');
    expect(result.candidates[0]?.hashDistance).toBeLessThanOrEqual(12);
    expect(result.printingConfidence).toBeGreaterThan(0.9);
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it("skips the collector line when a sure title's art already picks out one printing", async () => {
    const reads = { collector: 0 };
    const result = await identify(1, { title: sure('Sol Ring'), reads });
    expect(result.candidates[0]?.printing.id).toBe('c21-263');
    expect(reads.collector).toBe(0);
    expect(result.confidence).toBeGreaterThan(0.9);
    // Two printings with the same art: only the collector line can tell them apart, so it is read.
    const twins = { collector: 0 };
    await identify(2, { title: sure('Sol Ring'), reads: twins });
    expect(twins.collector).toBeGreaterThan(0);
  });

  it('leaves printings with the same art to the collector line, and is unsure without one', async () => {
    const unsure = await identify(2, { title: sure('Sol Ring') });
    expect(unsure.candidates.slice(0, 2).map((c) => c.printing.set)).toEqual(['cmm', 'cmm']);
    expect(unsure.printingConfidence).toBeLessThan(0.6);

    const read = await identify(2, { title: sure('Sol Ring'), collector: ['U0703', 'CMM•EN JOHN DOE'] });
    expect(read.candidates[0]?.printing.id).toBe('cmm-703');
    expect(read.collector).toMatchObject({ numbers: ['703'], sets: ['CMM'] });
    expect(read.confidence).toBeGreaterThan(0.9);
  });

  it('finds a card by its fingerprint alone when the title is unreadable', async () => {
    const result = await identify(9, { title: junk });
    expect(result.candidates[0]?.printing.name).toBe('Opt');
    expect(result.candidates[0]?.sources).toContain('hash');
  });

  it('finds a card by its collector line alone, with no fingerprints in the index', async () => {
    const result = await identify(1, { title: junk, fingerprints: false, collector: ['263/300 U', 'C21 • EN'] });
    expect(result.candidates[0]?.printing.id).toBe('c21-263');
    expect(result.candidates[0]?.sources).toEqual(['collector']);
    expect(result.nameConfidence).toBeGreaterThanOrEqual(0.9);
  });

  it("doesn't let a collector line vouch for a name whose art plainly isn't this card", async () => {
    // The photo is Opt; a misread collector line points at a Sol Ring printing.
    const result = await identify(9, { title: junk, collector: ['263/300 U', 'C21 • EN'] });
    expect(result.candidates[0]?.printing.name).toBe('Opt');
    const solRing = result.candidates.find((c) => c.printing.id === 'c21-263');
    expect(solRing?.collector).toMatchObject({ number: 'exact', set: 'exact' });
    expect(result.nameConfidence).toBeLessThan(0.9);
  });

  it('works out that the card is upside down when the title could not say', async () => {
    const result = await identify(9, { title: junk, angle: Math.PI + 0.05 });
    expect(result.candidates[0]?.printing.name).toBe('Opt');
    expect(result.turned).toBe(true);
  });
});

describe('identifyPrinting with the batch locked to sets', () => {
  it('settles printings with the same art when only one of them is in the locked sets', async () => {
    const unlocked = await identify(2, { title: sure('Sol Ring') });
    expect(unlocked.printingConfidence).toBeLessThan(0.6);
    // Another set entirely: only CMM's two printings are left, which still look alike.
    const cmm = await identify(2, { title: sure('Sol Ring'), lockSets: ['cmm'] });
    expect(cmm.candidates.every((c) => c.printing.set === 'cmm' || c.printing.name !== 'Sol Ring')).toBe(true);
    expect(cmm.outsideLock).toBe(false);
    // Locked to C21, only its printing competes.
    const c21 = await identify(1, { title: sure('Sol Ring'), lockSets: ['C21'] });
    expect(c21.candidates.filter((c) => c.printing.name === 'Sol Ring').map((c) => c.printing.id)).toEqual(['c21-263']);
    expect(c21.printingConfidence).toBe(1);
    expect(c21.outsideLock).toBe(false);
  });

  it('flags a card that has no printing in the locked sets, and keeps all its printings', async () => {
    const result = await identify(1, { title: sure('Sol Ring'), lockSets: ['dom'] });
    expect(result.candidates[0]?.printing.name).toBe('Sol Ring');
    expect(result.outsideLock).toBe(true);
    expect(result.candidates.filter((c) => c.printing.name === 'Sol Ring')).toHaveLength(3);
  });

  it("takes a locked set's tokens as from the locked set (round 9: Borg TTRK 20 under a TRK lock)", async () => {
    const tokens = [{ printing: printing('Borg', 'ttrk', '20', '2026-11-13'), art: 31 }, { printing: printing('Ghost of Illyria', 'trk', '20', '2026-11-13'), art: 32 }];
    const result = await identify(31, { title: sure('Borg'), lockSets: ['trk'], extra: tokens, picture: artCard(31) });
    expect(result.candidates[0]?.printing.id).toBe('ttrk-20');
    expect(result.outsideLock).toBe(false);
    // Another set's tokens are still outside it.
    expect((await identify(31, { title: sure('Borg'), lockSets: ['dom'], extra: tokens, picture: artCard(31) })).outsideLock).toBe(true);
  });

  it("ranks a locked set's card ahead of another set's unless that one's title reads clearly (round 10: Grim Physician THB over Photosynthetic Physician TRK)", async () => {
    const extra = [{ printing: printing('Grim Physician', 'thb', '100', '2020-01-24'), art: 41 }, { printing: printing('Photosynthetic Physician', 'trk', '210', '2026-11-13'), art: 42 }];
    const read = (grim: number): TitleMatch => ({
      candidates: [{ name: 'Grim Physician', distance: 1, similarity: grim }, { name: 'Photosynthetic Physician', distance: 9, similarity: 0.45 }],
      confidence: 0.3,
      reading: 'ie Physician 44',
    });
    const unclear = await identify(42, { title: read(0.72), fingerprints: false, lockSets: ['trk'], extra, picture: artCard(42) });
    expect(unclear.candidates[0]?.printing.id).toBe('trk-210');
    expect(unclear.outsideLock).toBe(false);
    // Read clearly, the card from another set still comes first, flagged for review.
    const clear = await identify(42, { title: read(0.92), fingerprints: false, lockSets: ['trk'], extra, picture: artCard(42) });
    expect(clear.candidates[0]?.printing.id).toBe('thb-100');
    expect(clear.outsideLock).toBe(true);
  });

  it('names a card by its collector number alone within the locked sets, when the set code is unreadable', async () => {
    const unlocked = await identify(1, { title: junk, fingerprints: false, collector: ['263/300 U', ''] });
    expect(unlocked.candidates).toEqual([]);
    const locked = await identify(1, { title: junk, fingerprints: false, collector: ['263/300 U', ''], lockSets: ['c21'] });
    expect(locked.candidates[0]?.printing.id).toBe('c21-263');
    expect(locked.candidates[0]?.sources).toEqual(['collector']);
  });
});

describe('placements', () => {
  it('turn an outline guess into where the card lies in the outline, and back into a mapping', () => {
    const size = MTG_REGIONS.size;
    expect(placementFor({ x: 0, y: 0, width: 488, height: 680 }, size)).toEqual([-0, -0, 488, 680]);
    const placement = placementFor({ x: 24, y: 22, width: 440, height: 613 }, size);
    expect(placement[0]).toBeCloseTo(-26.6, 1);
    const identity = placedMapping([1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 0, 488, 680], size);
    expect(identity).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const shifted = placedMapping([2, 0, 5, 0, 2, 7, 0, 0, 1], [-10, -20, 478, 660], size);
    // Card (0, 0) lands at outline (-10, -20), then at frame 2·(-10)+5, 2·(-20)+7.
    expect([shifted[2], shifted[5]]).toEqual([-15, -33]);
  });
});

describe('collector index lookups', () => {
  it('are built from the same printings the index ships', () => {
    const index = new CollectorIndex(buildCollectorIndex(PRINTINGS.map((p) => p.printing), NAMES, '2014-07-01'), NAMES);
    expect(index.lookup('CMM', '0410')).toEqual(['Sol Ring']);
  });
});

/** The card with a flashlight's hotspot painted on its art: its fingerprint drifts 30–40 bits away. */
function glared(seed: number): RgbaImage {
  const card = artCard(seed);
  for (let y = 80; y < 320; y++) {
    for (let x = 80; x < 320; x++) {
      if ((x - 200) ** 2 + (y - 200) ** 2 < 120 * 120) card.data.fill(255, (y * 488 + x) * 4, (y * 488 + x) * 4 + 3);
    }
  }
  return card;
}

/** A title read with some junk after the name: similar, and as sure, as `similarity`. */
const read = (similarity: number, name = 'Sol Ring'): TitleMatch => ({ candidates: [{ name, distance: 1, similarity }], confidence: similarity, reading: name });

describe('identifyPrinting when the title and the collector line agree (round 7)', () => {
  it('accepts a title and a clean collector line naming the same card, though glare puts its art 27–48 bits off', async () => {
    const result = await identify(2, { title: read(0.9), collector: ['U0703', 'CMM•EN JOHN DOE'], picture: glared(2) });
    const top = result.candidates[0]!;
    expect(top.printing.id).toBe('cmm-703');
    expect(top.hashDistance).toBeGreaterThan(26);
    expect(top.hashDistance).toBeLessThanOrEqual(48);
    expect(result.nameConfidence).toBeGreaterThan(0.95);
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('takes the number alone, the set unread, when only one printing of the title’s card has it', async () => {
    const result = await identify(2, { title: read(0.9), collector: ['V0703'], picture: glared(2) });
    expect(result.candidates[0]?.printing.id).toBe('cmm-703');
    expect(result.collector).toMatchObject({ numbers: ['703'] });
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('still lets no collector line vouch for blurred art on its own, with no title', async () => {
    const result = await identify(2, { title: junk, collector: ['U0703', 'CMM•EN JOHN DOE'], picture: glared(2) });
    expect(result.nameConfidence).toBeLessThan(0.9);
  });
});

describe('identifyPrinting when a garbled collector line names another card (round 8)', () => {
  it('doesn’t let it outvote a sure title when that card’s art is plainly not this one', async () => {
    // The photo is Sol Ring under glare; the collector line "names" Opt DOM 60, whose art is far off.
    const result = await identify(1, { title: sure('Sol Ring'), collector: ['C0060', 'DOM•EN JOHN DOE'], picture: glared(1) });
    expect(result.candidates[0]?.printing.name).toBe('Sol Ring');
    const opt = result.candidates.find((c) => c.printing.name === 'Opt');
    expect(opt?.collector?.score ?? 0).toBeLessThanOrEqual(0);
    expect(result.nameConfidence).toBeGreaterThanOrEqual(0.9);
  });

  it('still lets a collector line win when its card’s art agrees with the photo', async () => {
    const result = await identify(9, { title: sure('Sol Ring'), collector: ['C0060', 'DOM•EN JOHN DOE'] });
    expect(result.candidates[0]?.printing.id).toBe('dom-60');
  });
});

describe('identifyPrinting between names one letter apart (round 7: A Good Day to Die / to Pie)', () => {
  const lookalike = (art: number) => [{ printing: printing('Sol Rang', 'unf', '12', '2019-12-07'), art }];
  const title: TitleMatch = {
    candidates: [
      { name: 'Sol Ring', distance: 0.4, similarity: 0.95 },
      { name: 'Sol Rang', distance: 1.4, similarity: 0.88 },
    ],
    confidence: 0.95 * (0.5 + 0.5 * (0.07 / 0.2)),
    reading: 'sol ring',
  };

  it('lets the artwork settle the name when the look-alike’s art is plainly another card', async () => {
    const result = await identify(1, { title, picture: glared(1), extra: lookalike(7) });
    expect(result.candidates[0]?.printing.id).toBe('c21-263');
    expect(result.candidates[0]?.hashDistance).toBeLessThanOrEqual(36);
    expect(result.nameConfidence).toBeGreaterThanOrEqual(0.95);
  });

  it('leaves the name unsure when the look-alike’s art is as close', async () => {
    const result = await identify(1, { title, picture: glared(1), extra: lookalike(1) });
    expect(result.nameConfidence).toBeLessThan(0.9);
  });
});

describe('identifyPrinting when the artwork contradicts the text', () => {
  it("never trusts a sure title whose printings all have plainly other artwork (OCR can invent a real name)", async () => {
    // The title "read" Sol Ring perfectly, but every Sol Ring in the index has utterly different art.
    const result = await identify(1, { title: sure('Sol Ring'), invertArt: (name) => name === 'Sol Ring' });
    const top = result.candidates[0]!;
    expect(top.printing.name).toBe('Sol Ring');
    expect(top.hashDistance).toBeGreaterThan(48);
    expect(result.nameConfidence).toBeLessThanOrEqual(0.5);
    expect(result.confidence).toBeLessThanOrEqual(0.5);
  });

  it('trusts a title read almost whole when the collector line names the same card, whatever the art (round 11: foils under the flashlight)', async () => {
    // Every Sol Ring's art is plainly other (as a foil's under a hotspot can be), but its number and set read cleanly.
    const numbered = await identify(1, { title: sure('Sol Ring'), invertArt: (name) => name === 'Sol Ring', collector: ['U0703', 'CMM•EN JOHN DOE'] });
    expect(numbered.candidates[0]?.printing.id).toBe('cmm-703');
    expect(numbered.nameConfidence).toBeGreaterThan(0.95);
    // The set code alone, with the title read at 0.97 or more.
    const setOnly = await identify(1, { title: sure('Sol Ring'), invertArt: (name) => name === 'Sol Ring', collector: ['CMM•EN JOHN DOE'] });
    expect(setOnly.nameConfidence).toBeGreaterThan(0.9);
    // A title read less surely (0.93) with only the set code stays capped; so does a collector line with no title.
    const unsure = await identify(1, { title: read(0.93), invertArt: (name) => name === 'Sol Ring', collector: ['CMM•EN JOHN DOE'] });
    expect(unsure.nameConfidence).toBeLessThanOrEqual(0.5);
    const untitled = await identify(1, { title: junk, invertArt: (name) => name === 'Sol Ring', collector: ['U0703', 'CMM•EN JOHN DOE'] });
    expect(untitled.nameConfidence).toBeLessThan(0.9);
  });

  it('still trusts a sure title when the art is merely a poor match (glare, a misplaced outline)', async () => {
    const result = await identify(1, { title: sure('Sol Ring') });
    expect(result.candidates[0]?.printing.name).toBe('Sol Ring');
    expect(result.nameConfidence).toBeGreaterThan(0.9);
  });
});

describe('recognizeFrame with printings', () => {
  const detection = (corners: CardDetection['corners']): CardDetection => ({ corners, score: 1, edgeSupport: 1, aspect: 0.72, areaFraction: 0.3, tilt: 0 });

  it('finds the card by its artwork in the second outline when the first is background and no title reads', async () => {
    const card = orderCardCorners(cardQuad({ x: 400, y: 520 }, 600, 0.05));
    // A card-shaped patch of background around the card, which detection offers first.
    const patch = orderCardCorners(cardQuad({ x: 400, y: 520 }, 900, 0.05));
    const frame = placeCard(ARTS.get(1)!, { width: 800, height: 1040 }, card, [60, 80, 70]);
    const catalog = new Catalog(memorySource(), FINGERPRINT_VERSION);
    const dictionary = { names: NAMES, faces: {} };
    const result = await recognizeFrame(frame, {
      regions: MTG_REGIONS,
      names: new NameIndex(dictionary),
      ocr: fakeOcr([]),
      readDespiteQuality: true,
      detections: [detection(patch), detection(card)],
      printings: { game: mtg, catalog, collectors: await catalog.collectors(dictionary) },
    });
    expect(result.printings[0]?.printing.id).toBe('c21-263');
    expect(result.detection?.corners).toEqual(card);
    expect(result.nameConfidence).toBeGreaterThan(0.5);
  });

  it('finds a card with no outline by looking at the middle of the photo, without auto-accepting it', async () => {
    const card = orderCardCorners(cardQuad({ x: 400, y: 520 }, 700, 0));
    const frame = placeCard(ARTS.get(1)!, { width: 800, height: 1040 }, card, [60, 80, 70]);
    const catalog = new Catalog(memorySource(), FINGERPRINT_VERSION);
    const dictionary = { names: NAMES, faces: {} };
    const options = {
      regions: MTG_REGIONS,
      names: new NameIndex(dictionary),
      ocr: fakeOcr([]),
      readDespiteQuality: true,
      // As if detection had found no outline at all.
      detections: [],
      printings: { game: mtg, catalog, collectors: await catalog.collectors(dictionary) },
    };
    expect((await recognizeFrame(frame, options)).decision).toBe('no-card');
    const result = await recognizeFrame(frame, { ...options, centerFallback: true });
    expect(result.guessedOutline).toBe(true);
    expect(result.printings[0]?.printing.id).toBe('c21-263');
    expect(result.decision).toBe('review');
  });
});

describe("identifyPrinting with a collector number misread (round 11: a Doctor Who card's 5 read as 6 or 8)", () => {
  it("gives the title's printing whose number is a likely misreading of the one read the number as close", async () => {
    // CMM 410 and 703 share their art: "0708" (3 read as 8) names 703 among Sol Ring's printings.
    const result = await identify(2, { title: sure('Sol Ring'), collector: ['U0708'] });
    const top = result.candidates[0]!;
    expect(top.printing.id).toBe('cmm-703');
    expect(top.collector).toMatchObject({ number: 'close' });
    expect(result.candidates.find((c) => c.printing.id === 'cmm-410')?.collector?.number).toBe('conflict');
    // Put first, never auto-accepted on that alone.
    expect(result.printingConfidence).toBeLessThanOrEqual(0.85);
  });

  it('leaves the number alone when no printing is a likely misreading, or two equally are', async () => {
    // 390 is no likely misreading of 410, 703 or 263.
    const none = await identify(2, { title: sure('Sol Ring'), collector: ['U0390'] });
    expect(none.candidates.every((c) => c.collector?.number !== 'close')).toBe(true);
    // Without a sure title, nothing is guessed.
    const untitled = await identify(2, { title: junk, collector: ['U0708'] });
    expect(untitled.candidates.every((c) => c.collector?.number !== 'close')).toBe(true);
  });
});
