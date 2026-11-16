import { describe, expect, it, vi } from 'vitest';
import { MTG_REGIONS } from '../games/mtg/adapter';
import type { Quad } from '../vision/geometry';
import { createRgba, type RgbaImage } from '../vision/image';
import { artCard, cardQuad, emptyBoxFloor, placeCard } from '../vision/testScene';
import type { Printing } from '../games/types';
import type { PrintingCandidate } from './identify';
import { cardSignature, emptySpot, identityOf, isBlank, LiveScanner, muchSurer, pieceOf, presenceSignature } from './liveScanner';
import { LiveSession, signatureDistance } from './liveSession';
import { NameIndex } from './nameSearch';
import type { OcrEngine } from './ocr';
import type { Recognition } from './pipeline';

/**
 * These tests run the real pipeline (detection, OCR, fingerprints) on many
 * frames: a few seconds each on a slow CI runner, against vitest's 5 s default
 * (deploy run 43921141435: 4.2 s for one that takes 2.2 s on a Mac). All get
 * room to spare; the slowest set their own.
 */
vi.setConfig({ testTimeout: 30_000 });

const names = new NameIndex({ names: ['Sol Ring', 'Soaring', 'Lightning Bolt', 'Lightning Helix'], faces: {} });
const FRAME = { width: 720, height: 960 };
const BACKGROUND: [number, number, number] = [110, 40, 45];
const card = artCard(7);
const where = (dx = 0, dy = 0): Quad => cardQuad({ x: 360 + dx, y: 480 + dy }, 600, 0.03);
const frameWith = (corners: Quad | null): RgbaImage =>
  corners ? placeCard(card, FRAME, corners, BACKGROUND) : (() => {
    const empty = createRgba(FRAME.width, FRAME.height);
    for (let i = 0; i < empty.data.length; i += 4) empty.data.set([...BACKGROUND, 255], i);
    return empty;
  })();

/** Reads "Sol Ring" every time, and counts the calls. */
function fakeOcr(): OcrEngine & { calls: number } {
  const engine = {
    calls: 0,
    async readLine() {
      engine.calls += 1;
      return { text: 'Sol Ring', confidence: 90 };
    },
    async dispose() {},
  };
  return engine;
}

describe('presenceSignature', () => {
  it('finds a card a hand-held phone has moved off its spot, where its plain fingerprint does not', () => {
    const read = cardSignature(frameWith(where()), where(), MTG_REGIONS)!;
    // The phone moved: the card now lies 8% of its height lower and a little to the side.
    const moved = frameWith(where(25, 48));
    expect(signatureDistance(cardSignature(moved, where(), MTG_REGIONS)!, read)).toBeGreaterThan(24);
    expect(signatureDistance(presenceSignature(moved, where(), MTG_REGIONS)!, read)).toBeLessThanOrEqual(12);
    // An empty spot looks like nothing it has.
    expect(signatureDistance(presenceSignature(frameWith(null), where(), MTG_REGIONS)!, read)).toBeGreaterThan(44);
  });

  it('says nothing about a spot the camera has blown out or blacked out while it re-exposes', () => {
    const lit = (image: RgbaImage, gain: number): RgbaImage => ({ ...image, data: image.data.map((value, i) => (i % 4 === 3 ? value : value * gain)) });
    expect(presenceSignature(lit(frameWith(where()), 3), where(), MTG_REGIONS)).toBeNull();
    expect(presenceSignature(lit(frameWith(where()), 0.08), where(), MTG_REGIONS)).toBeNull();
    // A little brighter or darker is still a picture.
    expect(presenceSignature(lit(frameWith(where()), 1.3), where(), MTG_REGIONS)).not.toBeNull();
    expect(presenceSignature(lit(frameWith(null), 1.3), where(), MTG_REGIONS)).not.toBeNull();
  });
});

describe('LiveScanner', () => {
  const context = (ocr: OcrEngine) => ({ regions: MTG_REGIONS, names, ocr });

  it('reads a card once while it lies there and the phone moves, and again after it was taken away', async () => {
    const ocr = fakeOcr();
    const scanner = new LiveScanner(new LiveSession());
    const counted: boolean[] = [];
    const show = async (corners: Quad | null, frames: number) => {
      for (let i = 0; i < frames; i++) {
        const seen = await scanner.frame(frameWith(corners), context(ocr));
        if (seen.read) counted.push(seen.read.counted);
      }
    };
    await show(where(), 4);
    expect(counted).toEqual([true]);
    // The phone moves about over the card, by more than a tenth of its diagonal: never counted again.
    await show(where(60, 100), 3);
    await show(where(-90, 30), 3);
    await show(where(), 3);
    expect(counted).toEqual([true]);
    // Taken away, and the same card (or an identical copy) put back: counted.
    await show(null, 4);
    await show(where(5, 0), 3);
    expect(counted).toEqual([true, true]);
  });

  it('drops a frame that comes while another is being read, so reads never overlap', async () => {
    const ocr = fakeOcr();
    const scanner = new LiveScanner(new LiveSession({ frames: 1, tolerance: 0.02 }));
    const first = scanner.frame(frameWith(where()), context(ocr));
    expect(scanner.busy).toBe(true);
    const second = await scanner.frame(frameWith(where()), context(ocr));
    expect(second).toMatchObject({ busy: true, read: null });
    expect((await first).read).toMatchObject({ counted: true, trigger: 'fresh', gaveUp: false });
    expect(scanner.busy).toBe(false);
    expect(ocr.calls).toBe(1);
  });

  it('keeps the frames before a read, and why it was read, for the test log', async () => {
    const scanner = new LiveScanner(new LiveSession());
    const ocr = fakeOcr();
    await scanner.frame(frameWith(null), context(ocr));
    await scanner.frame(frameWith(where()), context(ocr));
    const seen = await scanner.frame(frameWith(where()), context(ocr));
    expect(seen.read?.trigger).toBe('fresh');
    expect(seen.read?.frames.map((frame) => frame.outline)).toEqual([false, true, true]);
  });
});

describe('LiveScanner and things that are no card (round 7)', () => {
  const context = (ocr: OcrEngine) => ({ regions: MTG_REGIONS, names, ocr });
  const BOX: [number, number, number] = [70, 15, 20];
  const floorFrame = () => placeCard(emptyBoxFloor(), FRAME, where(), BOX);

  it('takes the floor of an empty box for no card, and a real card for one', () => {
    expect(isBlank(emptyBoxFloor())).toBe(true);
    expect(isBlank(artCard(7))).toBe(false);
  });

  it('sees the empty box where a card lay, and not a card, a hand or a blown-out picture there (round 11)', () => {
    const box = frameWith(null);
    expect(emptySpot(box, where(), MTG_REGIONS)).toBe(true);
    // Brighter in the middle (the flashlight), the same colour: still the box.
    const lit = placeCard(createRgba(1, 1), FRAME, where(), BACKGROUND);
    for (let i = 0; i < lit.data.length; i += 4) {
      const x = (i / 4) % FRAME.width;
      const y = Math.floor(i / 4 / FRAME.width);
      const gain = 1 + 0.5 * Math.exp(-((x - 360) ** 2 + (y - 480) ** 2) / 200 ** 2);
      lit.data.set([BACKGROUND[0] * gain, BACKGROUND[1] * gain, BACKGROUND[2] * gain, 255], i);
    }
    expect(emptySpot(lit, where(), MTG_REGIONS)).toBe(true);
    expect(emptySpot(frameWith(where()), where(), MTG_REGIONS)).toBe(false);
    const hand = placeCard(createRgba(1, 1), FRAME, where(), BACKGROUND);
    for (let i = 0; i < hand.data.length; i += 4) {
      const x = (i / 4) % FRAME.width;
      const y = Math.floor(i / 4 / FRAME.width);
      if (x > 100 && x < 620 && y > 120 && y < 840) hand.data.set([215, 170, 140, 255], i);
    }
    expect(emptySpot(hand, where(), MTG_REGIONS)).toBe(false);
    const white = frameWith(null);
    white.data.fill(255);
    expect(emptySpot(white, where(), MTG_REGIONS)).toBeNull();
  });

  it('never reads, counts or files the floor of an empty box, and still counts a card put there', async () => {
    const ocr = fakeOcr();
    const scanner = new LiveScanner(new LiveSession());
    const seen = [];
    for (let i = 0; i < 6; i++) seen.push(await scanner.frame(floorFrame(), context(ocr)));
    // Detection finds the floor's outline, but it holds nothing: live mode shows no card there.
    expect(seen.every((frame) => frame.corners === null && frame.phase === 'empty')).toBe(true);
    expect(seen.some((frame) => frame.dismissed)).toBe(true);
    expect(seen.every((frame) => frame.read === null)).toBe(true);
    expect(ocr.calls).toBe(0);
    // A card dropped into the box, where the floor was.
    const counted: boolean[] = [];
    for (let i = 0; i < 6; i++) {
      const frame = await scanner.frame(placeCard(card, FRAME, where(), BOX), context(ocr));
      if (frame.read) counted.push(frame.read.counted);
    }
    expect(counted).toEqual([true]);
  });
});

describe("pieceOf (round 11: junk reads of a card's text box)", () => {
  it("takes a text or art box inside a card's outline for a piece of it, and a card of the same size on top for no piece", () => {
    const outline = where();
    // The text box, read sideways as a card: its middle in the lower half, about a quarter of the area.
    const textBox = cardQuad({ x: 360, y: 640 }, 260, Math.PI / 2 + 0.03);
    expect(pieceOf(textBox, outline)).toBe(true);
    expect(pieceOf(where(10, 6), outline)).toBe(false);
    expect(pieceOf(cardQuad({ x: 60, y: 480 }, 200), outline)).toBe(false);
  });
});

describe('LiveScanner quiet spells (round 9: cards left unread left no trace in the log)', () => {
  it('reports 2 s without a read, with what each frame saw, a few times in a row at most, and afresh after a read', async () => {
    let now = 0;
    const scanner = new LiveScanner(new LiveSession(), () => now);
    const ocr = fakeOcr();
    const context = { regions: MTG_REGIONS, names, ocr };
    const spells: NonNullable<Awaited<ReturnType<LiveScanner['frame']>>['quiet']>[] = [];
    const show = async (corners: Quad | null, frames: number) => {
      for (let i = 0; i < frames; i++) {
        const seen = await scanner.frame(frameWith(corners), context);
        if (seen.quiet) spells.push(seen.quiet);
        now += 120;
      }
    };
    // Read on the second steady frame, then left lying for 12 s: a spell every 2 s, five at most.
    await show(where(), 100);
    expect(ocr.calls).toBeGreaterThan(0);
    expect(spells).toHaveLength(5);
    expect(spells[0]!.ms).toBe(2040);
    expect(spells[1]!.ms).toBe(4080);
    const frame = spells[0]!.frames.at(-1)!;
    // The card read last, steady, checked for a new card on top: the same look (distance 0).
    expect(frame).toMatchObject({ outline: true, phase: 'read', far: 0 });
    expect(frame.steady).toBeGreaterThan(2);
    expect(frame.light).toBeGreaterThan(40);
    expect(spells[0]!.frames.length).toBe(17);
    // Taken away and put back: read again, so the spells start afresh.
    await show(null, 4);
    await show(where(), 30);
    expect(spells).toHaveLength(6);
    expect(spells[5]!.ms).toBeLessThan(2500);
    expect(spells[5]!.frames.every((entry) => entry.phase === 'read')).toBe(true);
  }, 60_000);

  it('starts a quiet spell afresh after the frames stopped for a while (the camera was off)', async () => {
    let now = 0;
    const scanner = new LiveScanner(new LiveSession(), () => now);
    const context = { regions: MTG_REGIONS, names, ocr: fakeOcr() };
    const quiet = [];
    for (let i = 0; i < 10; i++) {
      if ((await scanner.frame(frameWith(null), context)).quiet) quiet.push(i);
      now += i === 4 ? 60_000 : 120;
    }
    expect(quiet).toEqual([]);
  });
});

describe('identityOf (round 9: a card put on top under the flashlight)', () => {
  const printing = (name: string, set: string, number: string): Printing => ({ id: `${set}-${number}`, name, set, setName: set.toUpperCase(), number, finishes: ['foil'], lang: 'en' });
  const candidate = (p: Printing, hashDistance: number | null, collector: PrintingCandidate['collector'] = null): PrintingCandidate => ({
    printing: p,
    score: 1,
    title: 0,
    hashDistance,
    collector,
    sources: collector ? ['collector'] : ['hash'],
  });
  const recognition = (over: Partial<Recognition>): Recognition => ({
    decision: 'review',
    detection: null,
    quality: null,
    title: null,
    names: [],
    titleCandidates: [],
    printings: [],
    nameConfidence: 0,
    confidence: 0,
    collector: null,
    timings: {},
    guessedOutline: false,
    outsideLock: false,
    trace: [],
    ...over,
  });
  const PLAINS = printing('Plains', 'trk', '307');
  const EXACT = { number: 'exact', set: 'exact', score: 1.6 } as const;
  const reading = (looseNumbers = false) => ({ numbers: ['307'], sets: ['TRK'], text: 'L0307 / TRK', ...(looseNumbers ? { looseNumbers } : {}) });
  // Round 9, read #20: no title, the collector line "L0307 / TRK…" looked up, the art 48 bits off under the hotspot.
  const plainsUnderTheHotspot = recognition({ names: ['Plains'], printings: [candidate(PLAINS, 48, EXACT)], collector: reading() });

  it('names the card its collector line read cleanly, though the read was unsure of the name', () => {
    expect(identityOf(plainsUnderTheHotspot)).toEqual({ name: 'Plains', printingId: null, guess: 'trk-307' });
    // Loose digits, or the number alone, aren't enough.
    expect(identityOf(recognition({ printings: [candidate(PLAINS, 48, EXACT)], collector: reading(true) })).name).toBeNull();
    expect(identityOf(recognition({ printings: [candidate(PLAINS, 48, { number: 'exact', set: 'unread', score: 1 })], collector: reading() })).name).toBeNull();
  });

  it('names the card whose artwork matches the best guess, but not one guessed from far-off artwork', () => {
    expect(identityOf(recognition({ printings: [candidate(PLAINS, 22)] })).name).toBe('Plains');
    expect(identityOf(recognition({ printings: [candidate(PLAINS, 48)] }))).toEqual({ name: null, printingId: null, guess: 'trk-307' });
  });

  it('counts a Plains put on Gray and Adira, though under the hotspot the two looked alike (34 bits)', () => {
    const session = new LiveSession({ frames: 1, tolerance: 0.02 });
    const corners = where();
    const grayAndAdira = Uint32Array.of(0x12345678, 0x9abcdef0, 0x0f0f0f0f, 0x33333333);
    const plains = Uint32Array.from(grayAndAdira);
    for (let i = 0; i < 34; i++) plains[i >> 5]! ^= 1 << (i & 31);
    session.next(corners);
    const gray = recognition({ decision: 'accept', names: ['Gray and Adira, Forever Joined'], nameConfidence: 0.96, confidence: 0.96, printings: [candidate(printing('Gray and Adira, Forever Joined', 'trk', '238'), 28)] });
    expect(session.settle(grayAndAdira, corners, identityOf(gray))).toBe(true);
    // The Plains is put on top: it looks different on two checks, and is read.
    session.next(corners);
    expect(session.changed(plains)).toBe(false);
    expect(session.changed(plains)).toBe(true);
    expect(session.settle(plains, corners, identityOf(plainsUnderTheHotspot))).toBe(true);
    // A read of it that names nothing, as alike again, is still the Plains: not counted.
    session.next(corners);
    session.changed(grayAndAdira);
    expect(session.changed(grayAndAdira)).toBe(true);
    expect(session.settle(grayAndAdira, corners, identityOf(recognition({ printings: [candidate(PLAINS, 50)] })))).toBe(false);
  });
});

describe('round 10: a much surer re-read, cards forgotten, long quiet stretches', () => {
  it('lets a re-read stand in for a read it was counted as only when much surer (#143 → #144: a foil Constable Odo)', () => {
    // A junk read of the card (Sage's Reverie, 0.29 sure of the name) counted; the re-read names Constable Odo at 0.90.
    expect(muchSurer({ nameConfidence: 0.29, confidence: 0.05, accepted: false }, { nameConfidence: 0.9, confidence: 0.9, accepted: true })).toBe(true);
    // Named, though not sure enough to add.
    expect(muchSurer({ nameConfidence: 0.29, confidence: 0.05, accepted: false }, { nameConfidence: 0.85, confidence: 0.85, accepted: false })).toBe(true);
    // A little surer, or a card already added: no.
    expect(muchSurer({ nameConfidence: 0.8, confidence: 0.6, accepted: false }, { nameConfidence: 0.85, confidence: 0.7, accepted: false })).toBe(false);
    expect(muchSurer({ nameConfidence: 0.95, confidence: 0.95, accepted: true }, { nameConfidence: 1, confidence: 1, accepted: true })).toBe(false);
  });

  it('reports the card read last forgotten, with the frames that led to it', async () => {
    let now = 0;
    const scanner = new LiveScanner(new LiveSession(), () => now);
    const context = { regions: MTG_REGIONS, names, ocr: fakeOcr() };
    const gone = [];
    for (const corners of [where(), where(), where(), null, null, null, null]) {
      const seen = await scanner.frame(frameWith(corners), context);
      if (seen.gone) gone.push(seen.gone);
      now += 120;
    }
    expect(gone).toHaveLength(1);
    expect(gone[0]).toMatchObject({ card: 'Sol Ring', moved: false });
    expect(gone[0]!.frames.at(-1)).toMatchObject({ outline: false, gone: 3 });
  });

  it('keeps reporting a long quiet stretch, in sum every 30 s, after the first five spells', async () => {
    let now = 0;
    const scanner = new LiveScanner(new LiveSession(), () => now);
    const context = { regions: MTG_REGIONS, names, ocr: fakeOcr() };
    const spells: NonNullable<Awaited<ReturnType<LiveScanner['frame']>>['quiet']>[] = [];
    // An empty box, one frame a second, for 45 s.
    for (let i = 0; i < 46; i++) {
      const seen = await scanner.frame(frameWith(null), context);
      if (seen.quiet) spells.push(seen.quiet);
      now += 1000;
    }
    expect(spells).toHaveLength(6);
    expect(spells.slice(0, 5).every((spell) => spell.summary === undefined)).toBe(true);
    expect(spells[5]!.summary).toMatchObject({ frames: 30, outline: 0, phases: { empty: 30 } });
  }, 30_000);
});
