import { describe, expect, it } from 'vitest';
import { Catalog, type IndexSource } from '../games/catalog';
import { buildCollectorIndex, CollectorIndex } from '../games/collectorIndex';
import { encodeHashShard } from '../games/hashShard';
import { mtg, MTG_REGIONS } from '../games/mtg/adapter';
import type { GameIndex, IndexFile, Printing } from '../games/types';
import { orderCardCorners } from '../vision/geometry';
import { artCard, cardQuad, placeCard, scryfallSmall as small } from '../vision/testScene';
import { FINGERPRINT_BYTES, FINGERPRINT_VERSION, fingerprintCardImage } from './fingerprint';
import { identifyPrinting, placedMapping, placementFor } from './identify';
import { COLLECTOR_CHARACTERS, type OcrEngine } from './ocr';
import type { TitleMatch } from './titleMatch';

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

/** A one-shard index held in memory, with fingerprints. */
function memorySource(withFingerprints = true): IndexSource {
  const sorted = [...PRINTINGS].sort((a, b) => (a.printing.name < b.printing.name ? -1 : a.printing.name > b.printing.name ? 1 : a.printing.id < b.printing.id ? -1 : 1));
  const shardFile: IndexFile = { file: 'printings.mtg.00.json', bytes: 0, sha256: 'ab'.repeat(32) };
  const hashFile: IndexFile = { file: 'hashes.mtg.00.bin', bytes: 0, sha256: 'cd'.repeat(32) };
  const collectorsFile: IndexFile = { file: 'collectors.mtg.json', bytes: 0, sha256: 'ef'.repeat(32) };
  const index: GameIndex = {
    source: { name: 'test', updatedAt: 'now' },
    counts: { names: NAMES.length, printings: PRINTINGS.length },
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
    rows: sorted.map(({ art }) => fingerprintCardImage(small(ARTS.get(art)!), MTG_REGIONS)),
  });
  const files: Record<string, unknown> = {
    [shardFile.file]: sorted.map(({ printing }) => printing),
    [collectorsFile.file]: buildCollectorIndex(
      sorted.map(({ printing }) => printing),
      NAMES,
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
function fakeOcr(collector: string[]): OcrEngine {
  let next = 0;
  return {
    async readLine(_image, options) {
      if (options?.characters === COLLECTOR_CHARACTERS) return { text: collector[next++] ?? '', confidence: 80 };
      return { text: '', confidence: 0 };
    },
    async dispose() {},
  };
}

const sure = (name: string): TitleMatch => ({ candidates: [{ name, distance: 0, similarity: 1 }], confidence: 1, reading: name });
const junk: TitleMatch = { candidates: [], confidence: 0, reading: '' };

async function identify(art: number, options: { title: TitleMatch; collector?: string[]; fingerprints?: boolean; angle?: number }) {
  const corners = cardQuad({ x: 400, y: 520 }, 820, options.angle ?? 0.05);
  const frame = placeCard(ARTS.get(art)!, { width: 800, height: 1040 }, corners, [60, 80, 70]);
  const catalog = new Catalog(memorySource(options.fingerprints ?? true), FINGERPRINT_VERSION);
  const dictionary = { names: NAMES, faces: {} };
  return identifyPrinting({
    frame,
    // As detection reports them: the edge higher in the frame is taken as the top.
    corners: orderCardCorners(corners),
    orientationKnown: options.title.confidence > 0.5,
    title: options.title,
    game: mtg,
    catalog,
    collectors: await catalog.collectors(dictionary),
    ocr: fakeOcr(options.collector ?? []),
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
