/**
 * Labelled reads from a test log (see TESTLOG.md) as real-scan fixtures: a
 * read is labelled when the user said what the card really is, by accepting
 * a review as a printing or changing a batch row's printing. An Undo or a
 * discard after that takes the label away. Pure, apart from JPEG coding.
 */
import type { TestLogEvent, TestLogFile, TestLogFileRead, TestLogPrinting } from '../../app/src/session/testLog';
import type { RgbaImage } from '../../app/src/vision/image';
import { decodeJpeg, encodeJpeg } from './imageIo';

export interface ReadLabel {
  printing: TestLogPrinting;
  /** The event that set it: `review-accepted` or `printing-changed`. */
  from: TestLogEvent['type'];
  via?: string;
}

/** What each read really was, as the user's follow-ups say, applied in order. */
export function labelsFromLog(log: Pick<TestLogFile, 'events'>): Map<string, ReadLabel> {
  const labels = new Map<string, ReadLabel>();
  const events = [...log.events].sort((a, b) => a.at.localeCompare(b.at));
  for (const event of events) {
    for (const id of event.readIds) {
      if ((event.type === 'review-accepted' || event.type === 'printing-changed') && event.printing) {
        labels.set(id, { printing: event.printing, from: event.type, ...(event.via ? { via: event.via } : {}) });
      } else if (event.type === 'undo' || event.type === 'review-discarded') {
        labels.delete(id);
      }
    }
  }
  return labels;
}

export interface FixtureLabel {
  game: 'mtg';
  id: string;
  name: string;
  tags: string[];
  notes: string;
}

export interface Fixture {
  file: string;
  /** The padded card picture, as JPEG. */
  bytes: Uint8Array;
  label: FixtureLabel;
}

/** Plain border added around the card picture, as a share of its width, so detection has an edge to find. */
const MARGIN = 0.15;
const BACKGROUND = [70, 70, 70] as const;

export function padImage(image: RgbaImage, margin = MARGIN): RgbaImage {
  const pad = Math.round(image.width * margin);
  const width = image.width + pad * 2;
  const height = image.height + pad * 2;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = BACKGROUND[0];
    data[i * 4 + 1] = BACKGROUND[1];
    data[i * 4 + 2] = BACKGROUND[2];
    data[i * 4 + 3] = 255;
  }
  for (let y = 0; y < image.height; y++) {
    data.set(image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4), ((y + pad) * width + pad) * 4);
  }
  return { width, height, data };
}

/** Hard-case tags the eval knows, from what the log measured. */
export function tagsFor(read: TestLogFileRead): string[] {
  const tags = ['testlog', 'cropped', read.source];
  if (read.settings.flashlight) tags.push('flashlight');
  if (read.settings.foil) tags.push('foil');
  if (read.settings.camera === 1080) tags.push('1080p');
  if (read.quality && read.quality.glare > 0) tags.push('glare');
  if (read.quality && read.quality.brightness < 70) tags.push('low-light');
  return tags;
}

function describe(read: TestLogFileRead, label: ReadLabel): string {
  const top = read.candidates[0];
  const guess = top ? `${top.name} (${top.set.toUpperCase()} ${top.number}) at ${read.confidence}` : 'nothing';
  const outcome = read.outcome.kind === 'review' ? `review (${read.outcome.reason})` : read.outcome.kind;
  const how = label.from === 'printing-changed' ? 'printing changed in the batch' : `review accepted${label.via ? ` via ${label.via}` : ''}`;
  return `Test log ${read.at.slice(0, 16)}, build ${read.build}, ${read.source}: read as ${guess}; ${outcome}; labelled by ${how}. The picture is the app's crop, padded.`;
}

/** The labelled reads that have a picture, as fixtures. */
export function fixturesFromLog(log: TestLogFile): Fixture[] {
  const labels = labelsFromLog(log);
  const fixtures: Fixture[] = [];
  for (const read of log.reads) {
    const label = labels.get(read.id);
    if (!label || !read.crop) continue;
    const picture = padImage(decodeJpeg(Uint8Array.from(Buffer.from(read.crop, 'base64'))));
    fixtures.push({
      file: `testlog-${read.at.slice(0, 10)}-${read.id.slice(0, 8)}.jpg`,
      bytes: encodeJpeg(picture, 92),
      label: { game: 'mtg', id: label.printing.id, name: label.printing.name, tags: tagsFor(read), notes: describe(read, label) },
    });
  }
  return fixtures;
}
