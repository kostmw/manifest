/**
 * Live mode replayed from a phone's test log: the log's card pictures (the
 * app's own crops, glare and foil and all) are put back into camera frames in
 * the order they were read, and run through the same LiveScanner the worker
 * uses, with real detection, OCR and the card index. Each run of reads of one
 * card is one card lying there, so it should count once.
 *
 *   npx tsx tests/eval/live-replay.ts manifest-testlog-….json
 *   … --no-camera-events   # don't tell the scanner when the flashlight switched (as if the app missed it)
 *   … --seed 2             # another shake of the phone
 *   … --verbose            # every read's frames before it (as the test log's `live.frames`)
 *
 * The frames between pictures are made up, the same way every run (seeded):
 * the hand-held phone drifts and now and then jumps a tenth or more of the
 * card's diagonal, a frame blurs now and then so detection loses the card,
 * the picture blows out or darkens for a few frames where the flashlight
 * switched, and the box is empty for a moment between cards. Needs the index
 * (npm run index:build). Prints, for every card, how often it was counted.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Catalog } from '../../app/src/games/catalog';
import { mtg, MTG_REGIONS } from '../../app/src/games/mtg/adapter';
import type { NameDictionary } from '../../app/src/games/types';
import { FINGERPRINT_VERSION } from '../../app/src/recognize/fingerprint';
import { LiveScanner } from '../../app/src/recognize/liveScanner';
import { LiveSession } from '../../app/src/recognize/liveSession';
import { NameIndex } from '../../app/src/recognize/nameSearch';
import { createTesseractEngine } from '../../app/src/recognize/tesseract';
import { parseTestLog, type TestLogFileRead } from '../../app/src/session/testLog';
import { applyHomography, homography, type Point, type Quad } from '../../app/src/vision/geometry';
import { createRgba, type RgbaImage } from '../../app/src/vision/image';
import { cardQuad } from '../../app/src/vision/testScene';
import { decodeJpeg } from './imageIo';
import { fileIndexSource } from './indexSource';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'no-camera-events': { type: 'boolean', default: false },
    verbose: { type: 'boolean', default: false },
    seed: { type: 'string', default: '1' },
    data: { type: 'string', default: 'data' },
    cache: { type: 'string', default: '.cache/eval' },
    'ocr-model': { type: 'string', default: 'vendor/tessdata_fast' },
  },
});
const logPath = positionals[0];
if (!logPath) {
  console.error('Usage: npx tsx tests/eval/live-replay.ts <test log .json> [--no-camera-events] [--seed N]');
  process.exit(1);
}
if (!existsSync(join(values.data!, 'names.mtg.json'))) {
  console.error(`No card index at ${values.data}. Run npm run index:build first.`);
  process.exit(1);
}

/** The camera: a portrait 720p frame, the card about 400 pixels across, as in the owner's round-6 test. */
const FRAME = { width: 720, height: 1280 };
const CARD_HEIGHT = 560;
const FRAME_MS = 120;
const LOOK_FRAMES = 8;
const EMPTY_FRAMES = 6;
const FLASH_FRAMES = 4;
/** Chances per look and per frame. */
const JUMP_CHANCE = 0.5;
const BLUR_CHANCE = 0.15;
/** The red deck box the owner used as a chute, lit by the flashlight. */
const BOX = [118, 30, 34] as const;

let state = Number(values.seed) * 7919 + 13;
const random = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;

/** The card picture warped onto `corners` over the box, bilinearly, with a little camera noise. */
function frameOf(card: RgbaImage | null, corners: Quad | null, gain = 1): RgbaImage {
  const out = createRgba(FRAME.width, FRAME.height);
  const toCard = card && corners ? homography(corners, [{ x: 0, y: 0 }, { x: card.width, y: 0 }, { x: card.width, y: card.height }, { x: 0, y: card.height }] as Point[]) : null;
  for (let y = 0; y < FRAME.height; y++) {
    for (let x = 0; x < FRAME.width; x++) {
      const o = (y * FRAME.width + x) * 4;
      let rgb: [number, number, number] = [BOX[0], BOX[1], BOX[2]];
      if (toCard && card) {
        const p = applyHomography(toCard, x + 0.5, y + 0.5);
        const fx = p.x - 0.5;
        const fy = p.y - 0.5;
        if (fx >= 0 && fy >= 0 && fx < card.width - 1 && fy < card.height - 1) {
          const x0 = Math.floor(fx);
          const y0 = Math.floor(fy);
          const wx = fx - x0;
          const wy = fy - y0;
          rgb = [0, 1, 2].map((c) => {
            const at = (xx: number, yy: number) => card.data[(yy * card.width + xx) * 4 + c]!;
            return (at(x0, y0) * (1 - wx) + at(x0 + 1, y0) * wx) * (1 - wy) + (at(x0, y0 + 1) * (1 - wx) + at(x0 + 1, y0 + 1) * wx) * wy;
          }) as [number, number, number];
        }
      }
      const noise = (random() - 0.5) * 10;
      out.data[o] = rgb[0] * gain + noise;
      out.data[o + 1] = rgb[1] * gain + noise;
      out.data[o + 2] = rgb[2] * gain + noise;
      out.data[o + 3] = 255;
    }
  }
  return out;
}

/** A box blur of `radius` pixels, as when the camera refocuses or the phone shakes. */
function blurred(image: RgbaImage, radius: number): RgbaImage {
  const pass = (source: RgbaImage, dx: number, dy: number): RgbaImage => {
    const out = createRgba(source.width, source.height);
    for (let y = 0; y < source.height; y++) {
      for (let x = 0; x < source.width; x++) {
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (let k = -radius; k <= radius; k++) {
          const xx = x + k * dx;
          const yy = y + k * dy;
          if (xx < 0 || yy < 0 || xx >= source.width || yy >= source.height) continue;
          const s = (yy * source.width + xx) * 4;
          r += source.data[s]!;
          g += source.data[s + 1]!;
          b += source.data[s + 2]!;
          n += 1;
        }
        const o = (y * source.width + x) * 4;
        out.data[o] = r / n;
        out.data[o + 1] = g / n;
        out.data[o + 2] = b / n;
        out.data[o + 3] = 255;
      }
    }
    return out;
  };
  return pass(pass(image, 1, 0), 0, 1);
}

/** Runs of reads of one card: the pictures of one card lying there, in order. Reads without a name or picture are left out. */
function cardsOf(reads: TestLogFileRead[]): { name: string; reads: TestLogFileRead[] }[] {
  const cards: { name: string; reads: TestLogFileRead[] }[] = [];
  for (const read of reads) {
    const name = read.candidates[0]?.name;
    if (read.source !== 'live' || !read.crop || !name) continue;
    const last = cards[cards.length - 1];
    if (last && last.name === name) last.reads.push(read);
    else cards.push({ name, reads: [read] });
  }
  return cards;
}

const log = parseTestLog(await readFile(logPath, 'utf8'));
const cards = cardsOf(log.reads);
const dictionary = JSON.parse(await readFile(join(values.data!, 'names.mtg.json'), 'utf8')) as NameDictionary;
const names = new NameIndex(dictionary);
const modelDir = resolve(values['ocr-model']!);
const modelCache = resolve(values.cache!, 'tesseract', 'tessdata_fast');
await mkdir(modelCache, { recursive: true });
const ocr = await createTesseractEngine({ langPath: modelDir, cachePath: modelCache });
const catalog = new Catalog(fileIndexSource(values.data!, 'mtg'), FINGERPRINT_VERSION);
await catalog.fingerprintTable();
const context = { regions: MTG_REGIONS, names, ocr, printings: { game: mtg, catalog, collectors: await catalog.collectors(dictionary) } };

let now = 0;
const clock = () => now;
const scanner = new LiveScanner(new LiveSession(undefined, undefined, undefined, clock), clock);
const centre = { x: FRAME.width / 2, y: FRAME.height / 2 };
const diagonal = Math.hypot(CARD_HEIGHT, (CARD_HEIGHT * 488) / 680);
let flashlight: boolean | null = null;

interface Tally { counted: number; repeats: number; triggers: string[] }
async function show(card: RgbaImage | null, corners: Quad | null, tally: Tally | null, gain = 1, blur = 0): Promise<void> {
  let frame = frameOf(card, corners, gain);
  if (blur) frame = blurred(frame, blur);
  const seen = await scanner.frame(frame, context);
  now += FRAME_MS + (seen.read ? (seen.timings.total ?? 300) : 0);
  if (seen.read && tally) {
    if (seen.read.counted) tally.counted += 1;
    else tally.repeats += 1;
    tally.triggers.push(`${seen.read.trigger}${seen.read.counted ? '' : ' (same card)'}`);
    if (values.verbose) {
      const frames = seen.read.frames.map((f) => `${f.outline ? 'o' : '-'}${f.moved ?? ''}${f.probe !== null ? `p${f.probe}` : ''}${f.gone ? `g${f.gone}` : ''}${f.hold ? 'h' : ''}`);
      console.log(`    ${seen.read.trigger}${seen.read.counted ? ' COUNTED' : ' same'}: ${frames.join(' ')}`);
    }
  }
}

const results: { name: string; looks: number; tally: Tally }[] = [];
for (const card of cards) {
  const tally: Tally = { counted: 0, repeats: 0, triggers: [] };
  let base = { x: centre.x + (random() - 0.5) * 40, y: centre.y + (random() - 0.5) * 40 };
  for (const read of card.reads) {
    const picture = decodeJpeg(Uint8Array.from(Buffer.from(read.crop!, 'base64')));
    if (flashlight !== null && read.settings.flashlight !== flashlight) {
      // The flashlight switched: the app tells the scanner at the tap, and the picture blows out (on) or darkens (off).
      if (!values['no-camera-events']) scanner.cameraChanged();
      for (let i = 0; i < FLASH_FRAMES; i++) {
        await show(picture, cardQuad(base, CARD_HEIGHT, 0.02), tally, read.settings.flashlight ? 1.9 - i * 0.2 : 0.4 + i * 0.15, i === 0 ? 5 : 0);
      }
    }
    flashlight = read.settings.flashlight;
    if (random() < JUMP_CHANCE) {
      // The hand-held phone jumps: the card lands a tenth to a fifth of its diagonal away.
      const angle = random() * Math.PI * 2;
      const share = 0.08 + random() * 0.1;
      base = {
        x: Math.min(FRAME.width - 220, Math.max(220, base.x + Math.cos(angle) * share * diagonal)),
        y: Math.min(FRAME.height - 300, Math.max(300, base.y + Math.sin(angle) * share * diagonal)),
      };
    }
    for (let i = 0; i < LOOK_FRAMES; i++) {
      const drift = { x: base.x + (random() - 0.5) * 12, y: base.y + (random() - 0.5) * 12 };
      await show(picture, cardQuad(drift, CARD_HEIGHT, 0.02 + (random() - 0.5) * 0.01), tally, 1, random() < BLUR_CHANCE ? 6 : 0);
    }
  }
  results.push({ name: card.name, looks: card.reads.length, tally });
  // Taken away: the empty box for a moment before the next card.
  for (let i = 0; i < EMPTY_FRAMES; i++) await show(null, null, null);
}
await ocr.dispose();

console.log(`Live replay of ${logPath}: ${cards.length} cards, ${log.reads.length} reads in the log${values['no-camera-events'] ? ', no flashlight events' : ''}, seed ${values.seed}`);
for (const { name, looks, tally } of results) {
  const verdict = tally.counted === 1 ? 'ok' : tally.counted === 0 ? 'MISSED' : `COUNTED ${tally.counted}×`;
  console.log(`  ${verdict.padEnd(12)} ${name} (${looks} pictures): ${tally.triggers.join(', ') || 'never read'}`);
}
const extra = results.reduce((sum, { tally }) => sum + Math.max(0, tally.counted - 1), 0);
const missed = results.filter(({ tally }) => tally.counted === 0).length;
console.log(`Counted ${results.reduce((sum, { tally }) => sum + tally.counted, 0)} for ${results.length} cards: ${extra} extra, ${missed} missed.`);
