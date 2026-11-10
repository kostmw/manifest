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
 *   npm run eval -- --names-only       # stop at the name, as M2 did (a baseline)
 *   npm run eval -- --set hires        # the sharper synthetic set (modern cards at 2× resolution)
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Catalog } from '../../app/src/games/catalog';
import { mtg } from '../../app/src/games/mtg/adapter';
import type { NameDictionary, Printing } from '../../app/src/games/types';
import { FINGERPRINT_VERSION } from '../../app/src/recognize/fingerprint';
import { NameIndex } from '../../app/src/recognize/nameSearch';
import { DEFAULT_DECISION, recognizeFrame } from '../../app/src/recognize/pipeline';
import { createTesseractEngine } from '../../app/src/recognize/tesseract';
import { grayToRgba, shrinkRgba } from '../../app/src/vision/image';
import { realScanFixtures, syntheticFixtures, type Fixture, type SyntheticVariant } from './fixtures';
import { readImage, writeJpeg } from './imageIo';
import { fileIndexSource } from './indexSource';
import {
  computeMetrics,
  formatMetricsRow,
  isCorrect,
  isGoalCondition,
  isPrintingTwin,
  METRICS_HEADER,
  metricsByTag,
  quadError,
  quantile,
  signalStats,
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
    'names-only': { type: 'boolean', default: false },
    set: { type: 'string', default: 'standard' },
    data: { type: 'string', default: 'data' },
    cache: { type: 'string', default: '.cache/eval' },
    out: { type: 'string', default: '.cache/eval/report' },
    // The model the app ships; see vendor/tessdata_fast/README.md.
    'ocr-model': { type: 'string', default: 'vendor/tessdata_fast' },
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
  if (values.set !== 'standard' && values.set !== 'hires') throw new Error('--set must be standard or hires');
  fixtures.push(
    ...(await syntheticFixtures({ cacheDir: values.cache!, regenerate: values.regenerate!, log, variant: values.set as SyntheticVariant })),
  );
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

const catalog = new Catalog(fileIndexSource(dataDir, 'mtg'), FINGERPRINT_VERSION);
const printingSources = values['names-only']
  ? undefined
  : { game: mtg, catalog, collectors: await catalog.collectors(dictionary) };
if (printingSources && !(await catalog.hasFingerprints())) log('Note: this index has no fingerprints, so printings are found by text alone.');

/** The labelled printing, for reports and per-signal scoring. */
async function expectedPrinting(fixture: Fixture): Promise<Printing | null> {
  if (!fixture.expectedId) return null;
  const printings = await catalog.printings(fixture.expectedName);
  return printings.find((entry) => entry.printing.id === fixture.expectedId)?.printing ?? null;
}

const outDir = values.out!;
await rm(outDir, { recursive: true, force: true });
await mkdir(join(outDir, 'img'), { recursive: true });

log(`Evaluating ${fixtures.length} photos…`);
const outcomes: EvalOutcome[] = [];
/** Milliseconds per stage, for every card that reached it. */
const stageTimes: Record<string, number[]> = {};
const failures: GalleryItem[] = [];
for (const [index, fixture] of fixtures.entries()) {
  const frame = await readImage(fixture.path);
  const result = await recognizeFrame(frame, {
    regions: mtg.regions,
    names,
    ocr,
    readDespiteQuality: true,
    keepImages: true,
    ...(printingSources ? { printings: printingSources } : {}),
  });
  const expected = printingSources ? await expectedPrinting(fixture) : null;
  const collectorFit = expected && result.collector ? mtg.matchCollector(result.collector, expected) : null;
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
    predicted: result.names,
    confidence: result.confidence,
    ocrText: result.title?.text ?? '',
    latencyMs: Object.values(result.timings).reduce((sum, ms) => sum + ms, 0),
    ...(printingSources && fixture.expectedId
      ? {
          expectedId: fixture.expectedId,
          predictedIds: result.printings.map((candidate) => candidate.printing.id),
          nameConfidence: result.nameConfidence,
          collectorText: result.collector?.text ?? '',
          collectorNumber: collectorFit?.number ?? 'unread',
          collectorSet: collectorFit?.set ?? 'unread',
          ...(expected ? { expectedLabel: `${expected.set} ${expected.number}` } : {}),
          predictedLabels: result.printings.map((c) => `${c.printing.set} ${c.printing.number} h${c.hashDistance ?? '-'} s${c.score.toFixed(2)}`),
          topIsTwin: Boolean(expected && result.printings[0] && isPrintingTwin(result.printings[0].printing, expected)),
        }
      : {}),
  };
  outcomes.push(outcome);
  for (const [stage, ms] of Object.entries(result.timings)) (stageTimes[stage] ??= []).push(ms);

  if (!isCorrect(outcome)) {
    const stem = `img/${String(index).padStart(4, '0')}`;
    const item: GalleryItem = {
      outcome,
      candidates: result.titleCandidates.map(({ name, similarity }) => ({ name, similarity })),
      printings: result.printings.map((candidate) => ({
        id: candidate.printing.id,
        label: `${candidate.printing.name} (${candidate.printing.set.toUpperCase()} ${candidate.printing.number})`,
        score: candidate.score,
        hashDistance: candidate.hashDistance,
        collector: candidate.collector ? `${candidate.collector.number}/${candidate.collector.set}` : null,
        sources: candidate.sources,
      })),
      ...(expected ? { expectedPrinting: `${expected.set.toUpperCase()} ${expected.number}` } : {}),
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
    item.collectorCrops = [];
    for (const [i, crop] of (result.collectorCrops ?? []).slice(0, 4).entries()) {
      await writeJpeg(join(outDir, `${stem}-collector${i}.jpg`), grayToRgba(crop), 90);
      item.collectorCrops.push(`${stem}-collector${i}.jpg`);
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

const sweep = thresholdSweep(outcomes, [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.93, 0.95, 0.97]);
console.log('\nthreshold  accepted  wrong  (wrong name)');
for (const row of sweep) {
  console.log(
    `${row.threshold.toFixed(2).padStart(9)} ${(row.acceptRate * 100).toFixed(1).padStart(8)}% ${String(row.wrong).padStart(6)} ${String(row.wrongName).padStart(6)}`,
  );
}
if (printingSources) {
  // For comparing with M2, which auto-accepted on the name alone.
  const nameSure = outcomes.filter((o) => o.qualityOk && (o.nameConfidence ?? 0) >= DEFAULT_DECISION.autoAccept);
  const wrongNames = nameSure.filter((o) => o.predicted[0] !== o.expectedName).length;
  console.log(
    `\nname sure (confidence ≥ ${DEFAULT_DECISION.autoAccept}, quality ok): ${((nameSure.length / outcomes.length) * 100).toFixed(1)}% of cards, ${wrongNames} with the wrong name`,
  );
}
console.log(
  `\nlatency by stage, p50/p95 ms (cards that reached it): ${Object.entries(stageTimes)
    .map(([stage, times]) => `${stage} ${quantile(times, 0.5).toFixed(0)}/${quantile(times, 0.95).toFixed(0)} (${times.length})`)
    .join(', ')}`,
);
const signals = signalStats(outcomes);
if (signals.cards > 0) {
  const pc = (value: number) => `${(value * 100).toFixed(1)}%`;
  console.log(
    `\ncollector line (${signals.cards} cards): something read ${pc(signals.collectorAnyRead)}, number right ${pc(signals.collectorNumberRight)}, ` +
      `set right ${pc(signals.collectorSetRight)} (+${pc(signals.collectorSetClose)} close), both right ${pc(signals.collectorBothRight)}`,
  );
}

const notes = [
  printingSources
    ? 'Auto-accepts are judged on the exact printing (Scryfall id). A card is in the gallery when its top printing is wrong.'
    : 'Names only (--names-only): printings were not identified, as in M2.',
  'Synthetic photos are rendered from the same Scryfall scans the index uses, so they are optimistic. Real scans are the ground truth.',
  `Auto-accept threshold ${DEFAULT_DECISION.autoAccept}. OCR model: ${values['ocr-model']}. Latency is measured in Node on this machine, not on a phone.`,
];
await writeFile(
  join(outDir, 'summary.json'),
  JSON.stringify(
    { generatedAt: new Date().toISOString(), overall: Object.fromEntries(overall), byTag: Object.fromEntries(byTag), sweep, signals, outcomes },
    null,
    1,
  ),
);
await writeFile(
  join(outDir, 'index.html'),
  renderReport({ title: 'Manifest recognition eval', generatedAt: new Date().toISOString(), notes, overall, byTag, failures }),
);
console.log(`\nReport: ${join(outDir, 'index.html')}`);
