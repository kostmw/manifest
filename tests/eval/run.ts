/**
 * The recognition eval: runs the same pipeline as the app on labelled photos
 * and reports accuracy, auto-accept precision, review rate and latency, by
 * hard-case tag, with an HTML failure gallery.
 *
 *   npm run eval                       # real scans (if any) + synthetic set
 *   npm run eval -- --only real        # just the owner's photos
 *   npm run eval -- --limit 50 --tag dfc
 *   npm run eval -- --regenerate       # rebuild the synthetic set
 *   npm run eval -- --ocr-model dir    # compare another eng.traineddata.gz
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { mtg } from '../../app/src/games/mtg/adapter';
import type { NameDictionary } from '../../app/src/games/types';
import { NameIndex } from '../../app/src/recognize/nameSearch';
import { DEFAULT_DECISION, recognizeFrame } from '../../app/src/recognize/pipeline';
import { createTesseractEngine } from '../../app/src/recognize/tesseract';
import { grayToRgba, shrinkRgba } from '../../app/src/vision/image';
import { realScanFixtures, syntheticFixtures, type Fixture } from './fixtures';
import { readImage, writeJpeg } from './imageIo';
import {
  computeMetrics,
  formatMetricsRow,
  isGoalCondition,
  isTop1,
  METRICS_HEADER,
  metricsByTag,
  quadError,
  thresholdSweep,
  type EvalOutcome,
  type Metrics,
} from './metrics';
import { renderReport, type GalleryItem } from './report';

const { values } = parseArgs({
  options: {
    only: { type: 'string', default: 'all' },
    limit: { type: 'string' },
    tag: { type: 'string' },
    regenerate: { type: 'boolean', default: false },
    data: { type: 'string', default: 'data' },
    cache: { type: 'string', default: '.cache/eval' },
    out: { type: 'string', default: '.cache/eval/report' },
    'ocr-model': { type: 'string', default: 'node_modules/@tesseract.js-data/eng/4.0.0_best_int' },
  },
});

const log = (message: string) => console.log(message);
const dataDir = values.data!;
const namesPath = join(dataDir, 'names.mtg.json');
if (!existsSync(namesPath)) {
  console.error(`No card index at ${dataDir}. Run npm run index:build first.`);
  process.exit(1);
}

let fixtures: Fixture[] = [];
if (values.only !== 'synthetic') fixtures.push(...(await realScanFixtures(dataDir)));
if (values.only !== 'real') {
  fixtures.push(...(await syntheticFixtures({ cacheDir: values.cache!, regenerate: values.regenerate!, log })));
}
if (values.tag) fixtures = fixtures.filter((fixture) => fixture.tags.includes(values.tag!));
if (values.limit) fixtures = fixtures.slice(0, Number(values.limit));
if (fixtures.length === 0) {
  console.error('No fixtures to evaluate.');
  process.exit(1);
}

const dictionary = JSON.parse(await readFile(namesPath, 'utf8')) as NameDictionary;
const names = new NameIndex(dictionary);
names.shortlist('warm up', 1);
// One unpacked cache per model, or Tesseract would reuse whichever model it saw first.
const modelDir = resolve(values['ocr-model']!);
const modelCache = resolve(values.cache!, 'tesseract', basename(modelDir));
await mkdir(modelCache, { recursive: true });
const ocr = await createTesseractEngine({ langPath: modelDir, cachePath: modelCache });

const outDir = values.out!;
await rm(outDir, { recursive: true, force: true });
await mkdir(join(outDir, 'img'), { recursive: true });

log(`Evaluating ${fixtures.length} photos…`);
const outcomes: EvalOutcome[] = [];
const failures: GalleryItem[] = [];
for (const [index, fixture] of fixtures.entries()) {
  const frame = await readImage(fixture.path);
  const result = await recognizeFrame(frame, {
    regions: mtg.regions,
    names,
    ocr,
    readDespiteQuality: true,
    keepImages: true,
  });
  const outcome: EvalOutcome = {
    file: fixture.file,
    expectedName: fixture.expectedName,
    tags: fixture.tags,
    detected: result.detection !== null,
    ...(fixture.corners
      ? {
          locatedCorrectly:
            result.detection !== null &&
            quadError(result.detection.corners, fixture.corners) <
              0.03 * Math.hypot(fixture.corners[1]!.x - fixture.corners[0]!.x, fixture.corners[1]!.y - fixture.corners[0]!.y),
        }
      : {}),
    qualityOk: result.quality?.ok ?? false,
    qualityIssues: result.quality?.issues ?? [],
    decision: result.decision,
    predicted: result.candidates.map((candidate) => candidate.name),
    confidence: result.confidence,
    ocrText: result.title?.text ?? '',
    latencyMs: Object.values(result.timings).reduce((sum, ms) => sum + ms, 0),
  };
  outcomes.push(outcome);

  if (!isTop1(outcome)) {
    const stem = `img/${String(index).padStart(4, '0')}`;
    const item: GalleryItem = {
      outcome,
      candidates: result.candidates.map(({ name, similarity }) => ({ name, similarity })),
    };
    const shrink = Math.max(1, Math.floor(Math.max(frame.width, frame.height) / 400));
    await writeJpeg(join(outDir, `${stem}-frame.jpg`), shrinkRgba(frame, shrink), 80);
    item.frame = `${stem}-frame.jpg`;
    if (result.card) {
      await writeJpeg(join(outDir, `${stem}-card.jpg`), shrinkRgba(result.card, 2), 85);
      item.card = `${stem}-card.jpg`;
    }
    if (result.title?.crop) {
      await writeJpeg(join(outDir, `${stem}-title.jpg`), grayToRgba(result.title.crop), 90);
      item.title = `${stem}-title.jpg`;
    }
    failures.push(item);
  }
  if ((index + 1) % 25 === 0) log(`  ${index + 1}/${fixtures.length}`);
}
await ocr.dispose();

const overall: [string, Metrics][] = [
  ['all', computeMetrics(outcomes)],
  ['goal: modern+clean', computeMetrics(outcomes.filter(isGoalCondition))],
];
const real = outcomes.filter((outcome) => outcome.tags.includes('real'));
if (real.length) overall.push(['real scans', computeMetrics(real)]);
const byTag = Object.entries(metricsByTag(outcomes));

console.log(`\n${METRICS_HEADER}`);
for (const [label, metrics] of overall) console.log(formatMetricsRow(label, metrics));
console.log('');
for (const [label, metrics] of byTag) console.log(formatMetricsRow(label, metrics));

const sweep = thresholdSweep(outcomes, [0.7, 0.75, 0.8, 0.85, 0.9, 0.93, 0.95, 0.97]);
console.log('\nthreshold  accepted  wrong');
for (const row of sweep) {
  console.log(`${row.threshold.toFixed(2).padStart(9)} ${(row.acceptRate * 100).toFixed(1).padStart(8)}% ${String(row.wrong).padStart(6)}`);
}

const notes = [
  'Top-1 printing accuracy is not measured yet: M2 identifies the name only; printings come with M3.',
  'Synthetic photos are rendered from the same Scryfall scans the index uses, so they are optimistic. Real scans are the ground truth.',
  `Auto-accept threshold ${DEFAULT_DECISION.autoAccept}. OCR model: ${values['ocr-model']}. Latency is measured in Node on this machine, not on a phone.`,
];
await writeFile(
  join(outDir, 'summary.json'),
  JSON.stringify(
    { generatedAt: new Date().toISOString(), overall: Object.fromEntries(overall), byTag: Object.fromEntries(byTag), sweep, outcomes },
    null,
    1,
  ),
);
await writeFile(
  join(outDir, 'index.html'),
  renderReport({ title: 'Manifest recognition eval', generatedAt: new Date().toISOString(), notes, overall, byTag, failures }),
);
console.log(`\nReport: ${join(outDir, 'index.html')}`);
