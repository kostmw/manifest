import { describe, expect, it } from 'vitest';
import type { TestLogFile, TestLogFileRead } from '../../app/src/session/testLog';
import { decodeJpeg, encodeJpeg } from './imageIo';
import { fixturesFromLog, labelsFromLog, padImage, tagsFor } from './testlogFixtures';

const SOL_RING = { id: 'cmm-410', name: 'Sol Ring', set: 'cmm', number: '410' };
const SOL_RING_C21 = { id: 'c21-263', name: 'Sol Ring', set: 'c21', number: '263' };

function card(): string {
  const width = 40;
  const height = 56;
  const data = new Uint8ClampedArray(width * height * 4).fill(200);
  return Buffer.from(encodeJpeg({ width, height, data }, 90)).toString('base64');
}

function read(id: string, extra: Partial<TestLogFileRead> = {}): TestLogFileRead {
  return {
    id,
    kind: 'read',
    at: '2026-11-13T09:00:00.000Z',
    source: 'live',
    build: '0.0.0+abc',
    userAgent: 'test',
    settings: { camera: 1080, flashlight: true, lockSets: [], foil: false, lang: 'en', condition: 'NM', sound: 'on' },
    frame: { width: 1080, height: 1920 },
    timings: {},
    quality: { brightness: 60, noise: 1, sharpness: 300, tilt: 3, glare: 0.02, cardWidth: 500, inFrame: true, issues: [], advice: [] },
    ocr: { title: '', collector: '' },
    trace: [],
    candidates: [{ ...SOL_RING_C21, score: 2, title: 0.9, art: 20, collector: null, sources: ['title'] }],
    nameConfidence: 0.9,
    confidence: 0.5,
    outcome: { kind: 'review', reason: 'unsure-printing' },
    crop: card(),
    ...extra,
  };
}

function log(reads: TestLogFileRead[], events: TestLogFile['events']): TestLogFile {
  return { format: 'manifest-testlog', version: 1, exportedAt: '2026-11-13T10:00:00Z', app: { build: 'x', userAgent: 'y' }, reads, events };
}

describe('test log → fixtures', () => {
  it('labels reads from accepted reviews and printing changes, and drops them on undo or discard, in order', () => {
    const labels = labelsFromLog(
      log([], [
        { id: '1', kind: 'event', at: '2026-11-13T09:01:00Z', type: 'review-accepted', readIds: ['a'], printing: SOL_RING_C21, via: 'candidate-1' },
        { id: '2', kind: 'event', at: '2026-11-13T09:05:00Z', type: 'printing-changed', readIds: ['a', 'b'], printing: SOL_RING },
        { id: '3', kind: 'event', at: '2026-11-13T09:02:00Z', type: 'review-accepted', readIds: ['c'], printing: SOL_RING },
        { id: '4', kind: 'event', at: '2026-11-13T09:03:00Z', type: 'undo', readIds: ['c'] },
        { id: '5', kind: 'event', at: '2026-11-13T09:04:00Z', type: 'review-discarded', readIds: ['d'] },
      ]),
    );
    expect(labels.get('a')).toEqual({ printing: SOL_RING, from: 'printing-changed' });
    expect(labels.get('b')?.printing.id).toBe('cmm-410');
    expect(labels.has('c')).toBe(false);
    expect(labels.has('d')).toBe(false);
  });

  it('makes a padded picture and a labels.json entry for each labelled read that has a picture', () => {
    const fixtures = fixturesFromLog(
      log([read('aaaaaaaa-1'), read('bbbbbbbb-2'), read('cccccccc-3', { crop: undefined })], [
        { id: '1', kind: 'event', at: '2026-11-13T09:01:00Z', type: 'review-accepted', readIds: ['aaaaaaaa-1', 'cccccccc-3'], printing: SOL_RING, via: 'printings' },
      ]),
    );
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0]!.file).toBe('testlog-2026-11-13-aaaaaaaa.jpg');
    expect(fixtures[0]!.label).toMatchObject({ game: 'mtg', id: 'cmm-410', name: 'Sol Ring' });
    expect(fixtures[0]!.label.tags).toEqual(['testlog', 'cropped', 'live', 'flashlight', '1080p', 'glare', 'low-light']);
    expect(fixtures[0]!.label.notes).toContain('read as Sol Ring (C21 263)');
    expect(fixtures[0]!.label.notes).toContain('review accepted via printings');
    const picture = decodeJpeg(fixtures[0]!.bytes);
    expect([picture.width, picture.height]).toEqual([52, 68]);
  });

  it('pads with a plain border and leaves the card in the middle', () => {
    const image = { width: 10, height: 14, data: new Uint8ClampedArray(10 * 14 * 4).fill(255) };
    const padded = padImage(image, 0.2);
    expect([padded.width, padded.height]).toEqual([14, 18]);
    expect(padded.data[0]).toBe(70);
    expect(padded.data[(2 * 14 + 2) * 4]).toBe(255);
  });

  it('tags only what the log measured', () => {
    expect(tagsFor(read('x', { settings: { camera: 720, flashlight: false, lockSets: [], foil: true, lang: 'en', condition: 'NM', sound: 'on' }, quality: null }))).toEqual([
      'testlog',
      'cropped',
      'live',
      'foil',
    ]);
  });
});
