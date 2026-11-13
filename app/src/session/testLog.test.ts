import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from './db';
import {
  addTestLogEvent,
  addTestLogRead,
  clearTestLog,
  createTestLogFile,
  logEvent,
  parseTestLog,
  setTestLogEnabled,
  testLogCount,
  testLogFileName,
  type TestLogRead,
} from './testLog';
import { buildTestLogRead, logOutcome } from './testLogRecord';

function read(id: string, at: string, crop?: ArrayBuffer): TestLogRead {
  return buildTestLogRead({
    id,
    at: new Date(at),
    source: 'live',
    scan: {
      names: ['Sol Ring'],
      printings: [
        {
          printing: { id: 'cmm-410', name: 'Sol Ring', set: 'cmm', setName: 'Commander Masters', number: '410', finishes: ['nonfoil'], lang: 'en' },
          score: 3.1234,
          title: 0.98,
          hashDistance: 9,
          collector: { number: 'exact', set: 'exact', score: 1.6 },
          sources: ['title', 'collector'],
        },
      ],
      nameConfidence: 0.97,
      confidence: 0.94,
      titleText: 'Sol Ring',
      collectorText: 'U 0410 / CMM • EN',
      advice: ['hotspot'],
      trace: ['title:rendering-1', 'deglared'],
      quality: { brightness: 120.4, noise: 0.42, sharpness: 512.6, tilt: 4.2, hotspot: 0.0213, cardWidth: 410.2, inFrame: true, issues: [] },
      frame: { width: 1280, height: 720 },
      card: null,
    },
    outcome: { kind: 'added', printingId: 'cmm-410', finish: 'nonfoil' },
    settings: { camera: 720, flashlight: true, lockSets: [], foil: false, lang: 'en', condition: 'NM', sound: 'on' },
    timings: { detect: 41.6, ocr: 30.2 },
    userAgent: 'test',
    crop: crop ?? null,
  });
}

beforeEach(async () => {
  await clearTestLog();
  setTestLogEnabled(false);
});

describe('test log', () => {
  it('records what a read saw and decided, rounded for reading', () => {
    const entry = read('a', '2026-11-13T09:00:00Z');
    expect(entry).toMatchObject({
      id: 'a',
      kind: 'read',
      source: 'live',
      settings: { camera: 720, flashlight: true },
      timings: { detect: 42, ocr: 30 },
      quality: { brightness: 120, sharpness: 513, glare: 0.021, inFrame: true, advice: ['hotspot'] },
      ocr: { title: 'Sol Ring', collector: 'U 0410 / CMM • EN' },
      trace: ['title:rendering-1', 'deglared'],
      candidates: [{ id: 'cmm-410', set: 'cmm', number: '410', score: 3.123, title: 0.98, art: 9, collector: { number: 'exact', set: 'exact', score: 1.6 } }],
      outcome: { kind: 'added', printingId: 'cmm-410' },
    });
    expect(entry.crop).toBeUndefined();
  });

  it('keeps only the newest reads, and drops follow-ups older than the oldest one kept', async () => {
    await addTestLogRead(read('a', '2026-11-13T09:00:00Z'), 2);
    await db.testlog.put({ id: 'e1', kind: 'event', at: '2026-11-13T09:00:01Z', type: 'undo', readIds: ['a'] });
    await addTestLogRead(read('b', '2026-11-13T09:00:02Z'), 2);
    await addTestLogRead(read('c', '2026-11-13T09:00:03Z'), 2);
    expect(await testLogCount()).toBe(2);
    expect((await db.testlog.toArray()).map((entry) => entry.id).sort()).toEqual(['b', 'c']);
  });

  it('writes one versioned file, pictures as base64, and reads it back', async () => {
    await addTestLogRead(read('a', '2026-11-13T09:00:00Z', new Uint8Array([255, 216, 255]).buffer));
    await addTestLogEvent({ type: 'review-accepted', readIds: ['a'], printing: { id: 'cmm-410', name: 'Sol Ring', set: 'cmm', number: '410' }, via: 'candidate-2' });
    const file = await createTestLogFile({ build: '0.0.0+abc', userAgent: 'test' }, new Date('2026-11-13T10:00:00Z'));
    expect(file).toMatchObject({ format: 'manifest-testlog', version: 1, exportedAt: '2026-11-13T10:00:00.000Z', app: { build: '0.0.0+abc' } });
    expect(file.reads).toHaveLength(1);
    expect(file.reads[0]!.crop).toBe('/9j/');
    expect(file.events[0]).toMatchObject({ type: 'review-accepted', readIds: ['a'], via: 'candidate-2' });
    expect(parseTestLog(JSON.stringify(file)).reads[0]!.id).toBe('a');
    expect(() => parseTestLog('{"format":"manifest-backup"}')).toThrow("isn't a Manifest test log");
    expect(() => parseTestLog('{"format":"manifest-testlog","version":2,"reads":[],"events":[]}')).toThrow('version 2');
    expect(testLogFileName(new Date('2026-11-13T09:05:00Z'))).toBe('manifest-testlog-20261113-0905.json');
  });

  it('records follow-ups only while the log is on, and only about known reads', async () => {
    logEvent({ type: 'undo', readIds: ['a'] });
    setTestLogEnabled(true);
    logEvent({ type: 'undo', readIds: [] });
    logEvent({ type: 'undo', readIds: ['a'] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await db.testlog.count()).toBe(1);
  });

  it('says why a re-read was the same card', () => {
    expect(logOutcome({ kind: 'same-card', why: 'same name (Sol Ring), printing unsure' })).toEqual({ kind: 'same-card', why: 'same name (Sol Ring), printing unsure' });
  });
});
