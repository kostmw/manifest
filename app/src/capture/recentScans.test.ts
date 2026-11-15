import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { addCard, createBatch, getItems } from '../session/batches';
import { db } from '../session/db';
import { clearTestLog, setTestLogEnabled } from '../session/testLog';
import { copyRecent, pushRecent, undoRecent } from './recentScans';

const SOL_RING = { id: 'cmm-410', name: 'Sol Ring', set: 'cmm', setName: 'Commander Masters', number: '410', finishes: ['nonfoil'], lang: 'en' };

beforeEach(async () => {
  await clearTestLog();
  setTestLogEnabled(true);
});

describe('+1 on the card just added (round 7)', () => {
  it('adds one more to its batch row, shows the copy like any card, and undoes only the copy', async () => {
    const batch = await createBatch('Copies');
    const itemId = await addCard(batch, SOL_RING, { finish: 'nonfoil', scanId: 'scan-1' });
    const scanned = pushRecent({ batchId: batch.id, kind: 'added', source: 'live', name: 'Sol Ring', code: 'CMM 410', itemId, scanId: 'scan-1', card: null });

    const copy = await copyRecent(scanned);
    expect(copy).toMatchObject({ kind: 'added', itemId, name: 'Sol Ring' });
    expect(copy!.id).not.toBe(scanned.id);
    expect((await getItems(batch.id))[0]?.qty).toBe(2);

    await undoRecent(copy!);
    expect((await getItems(batch.id))[0]?.qty).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 20));
    const events = (await db.testlog.toArray()).filter((entry) => entry.kind === 'event');
    expect(events.map((event) => [event.kind === 'event' ? event.type : null, event.kind === 'event' ? event.readIds : null])).toEqual(
      expect.arrayContaining([
        ['copy-added', ['scan-1']],
        ['undo', ['scan-1']],
      ]),
    );
  });

  it('offers no copy of a card waiting for review', async () => {
    const batch = await createBatch('Reviews');
    const waiting = pushRecent({ batchId: batch.id, kind: 'review', source: 'live', name: null, code: null, reviewId: 'r1', card: null });
    expect(await copyRecent(waiting)).toBeNull();
  });
});
