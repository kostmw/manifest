/** The HTML failure gallery: one self-contained page next to the crops it shows. */
import { isCorrect, isTop1, type EvalOutcome, type Metrics } from './metrics';

export interface GalleryItem {
  outcome: EvalOutcome;
  /** Paths relative to the report, when the images were saved. */
  frame?: string;
  card?: string;
  title?: string;
  collectorCrops?: string[];
  /** The title reading's name candidates. */
  candidates: { name: string; similarity: number }[];
  /** Printing candidates, best first, with their signal scores. */
  printings?: { id: string; label: string; score: number; hashDistance: number | null; collector: string | null; sources: string[] }[];
  /** Set and number of the labelled printing. */
  expectedPrinting?: string;
}

const escape = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const maybePercent = (value: number | null) => (value === null ? '–' : percent(value));

function metricsTable(rows: [string, Metrics][]): string {
  const head = [
    'Subset',
    'Cards',
    'Detected',
    'Located',
    'Top-1 name',
    'Top-5 name',
    'Top-1 printing',
    'Top-1 printing or twin',
    'Top-5 printing',
    'Auto-accepted',
    'Accept precision',
    'Wrong accepts (name)',
    'Review rate',
    'p50 / p95 ms',
  ];
  const body = rows
    .map(
      ([label, m]) =>
        `<tr><th>${escape(label)}</th><td>${m.cards}</td><td>${percent(m.detected)}</td><td>${maybePercent(m.located)}</td><td>${percent(m.top1Name)}</td>` +
        `<td>${percent(m.top5Name)}</td><td>${maybePercent(m.top1Printing)}</td><td>${maybePercent(m.top1PrintingOrTwin)}</td><td>${maybePercent(m.top5Printing)}</td>` +
        `<td>${percent(m.autoAccepted)}</td><td>${percent(m.autoAcceptPrecision)}</td>` +
        `<td>${m.wrongAutoAccepts} (${m.wrongNameAccepts})</td><td>${percent(m.reviewRate)}</td><td>${m.latencyP50.toFixed(0)} / ${m.latencyP95.toFixed(0)}</td></tr>`,
    )
    .join('\n');
  return `<table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>`;
}

function card(item: GalleryItem): string {
  const { outcome } = item;
  const wrongAccept = outcome.decision === 'accept' && !isCorrect(outcome);
  const images = [item.frame, item.card]
    .filter(Boolean)
    .map((src) => `<img src="${escape(src!)}" alt="" loading="lazy">`)
    .join('');
  const strips = [item.title, ...(item.collectorCrops ?? [])]
    .filter(Boolean)
    .map((src) => `<img src="${escape(src!)}" alt="" loading="lazy">`)
    .join('');
  const candidates = item.candidates
    .map((c) => `<li${c.name === outcome.expectedName ? ' class="hit"' : ''}>${escape(c.name)} <span>${c.similarity.toFixed(2)}</span></li>`)
    .join('');
  const printings = (item.printings ?? [])
    .map(
      (p) =>
        `<li${p.id === outcome.expectedId ? ' class="hit"' : ''}>${escape(p.label)} <span>score ${p.score.toFixed(2)}, hash ${p.hashDistance ?? '–'}, ` +
        `collector ${p.collector ?? '–'}, from ${escape(p.sources.join('+'))}</span></li>`,
    )
    .join('');
  return `<article class="${wrongAccept ? 'wrong-accept' : ''}">
  <div class="images">${images}</div>
  <div class="strips">${strips}</div>
  <dl>
    <dt>Expected</dt><dd>${escape(outcome.expectedName)}${item.expectedPrinting ? ` (${escape(item.expectedPrinting)})` : ''}</dd>
    <dt>Title read</dt><dd><code>${escape(outcome.ocrText || '—')}</code></dd>
    ${outcome.collectorText !== undefined ? `<dt>Collector</dt><dd><code>${escape(outcome.collectorText || '—')}</code> (number ${outcome.collectorNumber}, set ${outcome.collectorSet})</dd>` : ''}
    <dt>Decision</dt><dd>${outcome.decision}${wrongAccept ? ' <strong>(wrong auto-accept)</strong>' : ''}, confidence ${outcome.confidence.toFixed(2)}${outcome.nameConfidence !== undefined ? ` (name ${outcome.nameConfidence.toFixed(2)})` : ''}</dd>
    <dt>Quality</dt><dd>${outcome.detected ? (outcome.qualityIssues.join(', ') || 'ok') : 'no card found'}</dd>
    <dt>Tags</dt><dd>${escape(outcome.tags.join(', '))}</dd>
    <dt>File</dt><dd>${escape(outcome.file)}</dd>
  </dl>
  ${printings ? `<p class="label">Printings</p><ol>${printings}</ol>` : ''}
  <p class="label">Title candidates</p>
  <ol>${candidates || '<li>No candidates</li>'}</ol>
</article>`;
}

export function renderReport(input: {
  title: string;
  generatedAt: string;
  notes: string[];
  overall: [string, Metrics][];
  byTag: [string, Metrics][];
  failures: GalleryItem[];
}): string {
  const wrongName = input.failures.filter((item) => !isTop1(item.outcome));
  const wrongPrinting = input.failures.filter((item) => isTop1(item.outcome));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(input.title)}</title>
<style>
  :root { color-scheme: light dark; --bg: #fafafa; --fg: #18181b; --muted: #71717a; --card: #fff; --line: #e4e4e7; --bad: #b91c1c; --good: #15803d; }
  @media (prefers-color-scheme: dark) { :root { --bg: #18181b; --fg: #f4f4f5; --muted: #a1a1aa; --card: #27272a; --line: #3f3f46; --bad: #f87171; --good: #4ade80; } }
  body { margin: 0; padding: 16px; background: var(--bg); color: var(--fg); font: 14px/1.45 system-ui, sans-serif; }
  h1 { font-size: 20px; margin: 0 0 4px; } h2 { font-size: 16px; margin: 24px 0 8px; }
  p.meta, li.note { color: var(--muted); }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th, td { padding: 4px 10px; border-bottom: 1px solid var(--line); text-align: right; white-space: nowrap; }
  th:first-child, thead th { text-align: left; }
  .gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }
  article { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 10px; }
  article.wrong-accept { border-color: var(--bad); }
  .images { display: flex; gap: 6px; align-items: flex-start; flex-wrap: wrap; }
  .images img { max-height: 170px; max-width: 100%; border-radius: 4px; background: #000; }
  .strips { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
  .strips img { max-height: 40px; max-width: 100%; align-self: flex-start; background: #fff; border-radius: 2px; }
  p.label { margin: 6px 0 2px; color: var(--muted); font-size: 12px; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 8px; margin: 8px 0; }
  dt { color: var(--muted); } dd { margin: 0; overflow-wrap: anywhere; }
  ol { margin: 0; padding-left: 20px; } ol span { color: var(--muted); } li.hit { color: var(--good); font-weight: 600; }
</style>
</head>
<body>
<h1>${escape(input.title)}</h1>
<p class="meta">Generated ${escape(input.generatedAt)}</p>
<ul>${input.notes.map((note) => `<li class="note">${escape(note)}</li>`).join('')}</ul>
<h2>Overall</h2>
<div class="scroll">${metricsTable(input.overall)}</div>
<h2>By tag</h2>
<div class="scroll">${metricsTable(input.byTag)}</div>
<h2>Wrong name (${wrongName.length})</h2>
<div class="gallery">
${wrongName.map(card).join('\n')}
</div>
<h2>Right name, wrong printing (${wrongPrinting.length})</h2>
<div class="gallery">
${wrongPrinting.map(card).join('\n')}
</div>
</body>
</html>
`;
}
