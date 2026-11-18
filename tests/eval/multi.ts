/**
 * The multi-card eval: binder pages and table spreads (multiFixtures.ts) read
 * the way the app reads a photo, scored card by card.
 *
 *   npx tsx tests/eval/multi.ts --set binder           # 24 binder pages
 *   npx tsx tests/eval/multi.ts --set spread           # 20 table spreads
 *   … --mode single     # what "Scan a photo" did before M5: one card per photo (the baseline)
 *   … --mode cards      # recognizeCards: every card found (the default)
 *   … --limit 5 --regenerate --out <dir>
 *
 * Report in .cache/eval/multi-report-<set>/index.html: every photo with the
 * true outlines (green) and the ones read (amber, red when auto-added wrongly).
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Catalog } from '../../app/src/games/catalog';
import { mtg } from '../../app/src/games/mtg/adapter';
import type { NameDictionary } from '../../app/src/games/types';
import { FINGERPRINT_VERSION } from '../../app/src/recognize/fingerprint';
import { NameIndex } from '../../app/src/recognize/nameSearch';
import { recognizeCards, recognizeFrame, type RecognizeOptions } from '../../app/src/recognize/pipeline';
import { createTesseractEngine } from '../../app/src/recognize/tesseract';
import type { RgbaImage } from '../../app/src/vision/image';
import { readImage } from './imageIo';
import { fileIndexSource } from './indexSource';
import { MULTI_SETS, multiFixtures, type MultiSet } from './multiFixtures';
import { cardsByTag, multiMetrics, PARTIAL_BELOW, scorePhoto, type CardOutcome, type MultiRead, type PhotoScore } from './multiMetrics';
import { readFile } from 'node:fs/promises';

const { values } = parseArgs({
  options: {
    set: { type: 'string', default: 'binder' },
    mode: { type: 'string', default: 'cards' },
    limit: { type: 'string' },
    regenerate: { type: 'boolean', default: false },
    data: { type: 'string', default: 'data' },
    cache: { type: 'string', default: '.cache/eval' },
    out: { type: 'string' },
    'ocr-model': { type: 'string', default: 'vendor/tessdata_fast' },
  },
});
if (!(MULTI_SETS as readonly string[]).includes(values.set!)) throw new Error(`--set must be one of ${MULTI_SETS.join(', ')}`);
if (!['single', 'cards'].includes(values.mode!)) throw new Error('--mode must be single or cards');
const set = values.set as MultiSet;
const log = (message: string) => console.log(message);

let fixtures = await multiFixtures({ cacheDir: values.cache!, set, regenerate: values.regenerate!, log });
if (values.limit) fixtures = fixtures.slice(0, Number(values.limit));

const dataDir = values.data!;
const dictionary = JSON.parse(await readFile(join(dataDir, 'names.mtg.json'), 'utf8')) as NameDictionary;
const names = new NameIndex(dictionary);
names.shortlist('warm up', 1);
const modelDir = resolve(values['ocr-model']!);
const modelCache = resolve(values.cache!, 'tesseract', basename(modelDir));
await mkdir(modelCache, { recursive: true });
const ocr = await createTesseractEngine({ langPath: modelDir, cachePath: modelCache });
const catalog = new Catalog(fileIndexSource(dataDir, 'mtg'), FINGERPRINT_VERSION);
const options: RecognizeOptions = {
  regions: mtg.regions,
  names,
  ocr,
  printings: { game: mtg, catalog, collectors: await catalog.collectors(dictionary) },
  // As the app reads a photo (recognize.worker.ts's photo and importFile).
  readDespiteQuality: true,
  centerFallback: true,
  keepImages: true,
};

/** Every card read from the photo, as the mode reads it. */
async function readPhoto(frame: RgbaImage): Promise<MultiRead[]> {
  if (values.mode === 'cards') {
    const { cards } = await recognizeCards(frame, options);
    return cards
      .filter((card) => card.detection && card.names.length > 0)
      .map((card) => ({
        corners: card.detection!.corners,
        decision: card.decision,
        names: card.names,
        printingIds: card.printings.map((candidate) => candidate.printing.id),
        confidence: card.confidence,
      }));
  }
  const recognition = await recognizeFrame(frame, options);
  if (recognition.decision === 'no-card' || !recognition.detection) return [];
  return [
    {
      corners: recognition.detection.corners,
      decision: recognition.decision,
      names: recognition.names,
      printingIds: recognition.printings.map((candidate) => candidate.printing.id),
      confidence: recognition.confidence,
    },
  ];
}

const outDir = values.out ?? join(values.cache!, `multi-report-${set}`);
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

log(`Reading ${fixtures.length} ${set} photos (${values.mode})…`);
const photos: { file: string; path: string; tags: string[]; outcomes: CardOutcome[]; score: PhotoScore; ms: number; reads: MultiRead[]; frame: { width: number; height: number } }[] = [];
for (const fixture of fixtures) {
  const frame = await readImage(fixture.path);
  const started = performance.now();
  const reads = await readPhoto(frame);
  const ms = performance.now() - started;
  const score = scorePhoto(fixture.cards, reads);
  const outcomes = fixture.cards.map((card, i) => ({ photo: fixture.file, card, read: score.matched[i] ?? null }));
  photos.push({ file: fixture.file, path: fixture.path, tags: fixture.tags, outcomes, score, ms, reads, frame: { width: frame.width, height: frame.height } });
  const whole = fixture.cards.filter((card) => card.visible >= PARTIAL_BELOW).length;
  log(
    `  ${fixture.file}: ${reads.length} read, ${outcomes.filter((o) => o.read && o.card.visible >= PARTIAL_BELOW).length}/${whole} found, ` +
      `${outcomes.filter((o) => o.read?.printingIds[0] === o.card.id).length} right, merged ${score.merged}, split ${score.split}, phantom ${score.phantom}, wrong adds ${score.wrongAccepts}, ${Math.round(ms)} ms`,
  );
}

const metrics = multiMetrics(photos);
const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
log('');
log(`${set} (${values.mode}): ${metrics.photos} photos, ${metrics.cards} whole cards (+${metrics.partialCards} cut off below ${PARTIAL_BELOW * 100}%)`);
log(`  found ${percent(metrics.found)} · top-1 name ${percent(metrics.top1Name)} · top-1 printing ${percent(metrics.top1Printing)} · auto-added ${percent(metrics.autoAccepted)}`);
log(`  wrong auto-adds ${metrics.wrongAccepts} · partial cards auto-added ${metrics.partialAccepts} · merged ${metrics.merged} · split ${metrics.split} · phantom ${metrics.phantom} · duplicate ${metrics.duplicate}`);
log(`  per photo p50/p95 ${Math.round(metrics.msPerPhotoP50)}/${Math.round(metrics.msPerPhotoP95)} ms`);
const tagRows = cardsByTag(photos.flatMap((photo) => photo.outcomes.map((o) => ({ ...o, photoTags: photo.tags }))));
log('');
log(`${'tag'.padEnd(16)} ${'cards'.padStart(5)} ${'found'.padStart(7)} ${'name'.padStart(7)} ${'print'.padStart(7)} ${'added'.padStart(7)}`);
for (const [tag, row] of Object.entries(tagRows)) {
  log(`${tag.padEnd(16)} ${String(row.cards).padStart(5)} ${percent(row.found).padStart(7)} ${percent(row.top1Name).padStart(7)} ${percent(row.top1Printing).padStart(7)} ${percent(row.accepted).padStart(7)}`);
}

await writeFile(join(outDir, 'summary.json'), JSON.stringify({ set, mode: values.mode, metrics, tags: tagRows }, null, 1));

// The report: each photo with its outlines.
const escape = (text: string) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const points = (corners: { x: number; y: number }[]) => corners.map((p) => `${p.x.toFixed(0)},${p.y.toFixed(0)}`).join(' ');
const sections = photos.map((photo) => {
  const truth = photo.outcomes
    .map((o) => `<polygon points="${points(o.card.corners)}" fill="none" stroke="#34d399" stroke-width="6" stroke-dasharray="${o.card.visible < PARTIAL_BELOW ? '20 12' : ''}"/>`)
    .join('');
  const reads = photo.reads
    .map((read) => {
      const card = photo.outcomes.find((o) => o.read === read)?.card;
      const wrong = read.decision === 'accept' && (!card || read.printingIds[0] !== card.id);
      const color = wrong ? '#ef4444' : read.decision === 'accept' ? '#38bdf8' : '#fbbf24';
      const at = read.corners[0]!;
      return `<polygon points="${points(read.corners)}" fill="none" stroke="${color}" stroke-width="5"/><text x="${at.x + 10}" y="${at.y + 50}" fill="${color}" font-size="40">${escape(read.names[0] ?? '?')}</text>`;
    })
    .join('');
  const list = photo.outcomes
    .map((o) => `<li>${escape(o.card.name)} <small>${escape(o.card.tags.join(', '))} · ${(o.card.visible * 100).toFixed(0)}% in view</small>: ${o.read ? `${escape(o.read.names[0] ?? '?')} (${o.read.decision}, ${o.read.printingIds[0] === o.card.id ? 'right printing' : 'other printing'})` : '<b>not found</b>'}</li>`)
    .join('');
  return `<section><h2>${escape(photo.file)}</h2><p>${escape(photo.tags.join(', '))} · ${Math.round(photo.ms)} ms · merged ${photo.score.merged}, split ${photo.score.split}, phantom ${photo.score.phantom}, wrong adds ${photo.score.wrongAccepts}</p>
<svg viewBox="0 0 ${photo.frame.width} ${photo.frame.height}" style="max-width:640px;width:100%"><image href="${relative(outDir, photo.path)}" width="${photo.frame.width}" height="${photo.frame.height}"/>${truth}${reads}</svg><ul>${list}</ul></section>`;
});
await writeFile(
  join(outDir, 'index.html'),
  `<!doctype html><meta charset="utf-8"><title>Multi-card eval: ${set}</title><style>body{font:14px system-ui;margin:16px;background:#111;color:#ddd}small{color:#888}section{margin-bottom:32px}</style>
<h1>Multi-card eval: ${set} (${escape(values.mode!)})</h1><pre>${escape(JSON.stringify(metrics, null, 1))}</pre>${sections.join('\n')}`,
);
log(`\nReport: ${join(outDir, 'index.html')}`);
await ocr.dispose();
