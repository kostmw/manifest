import { describe, expect, it } from 'vitest';
import { emptyCounts, type ImportJob } from '../session/imports';
import type { ImportView } from './importQueue';
import { failureText, headline, nextStep, skippedText, tally, timeLeft } from './importText';

function view(job: Partial<ImportJob>, live = true): ImportView {
  return {
    job: { id: 'j', batchId: 'b', createdAt: '', updatedAt: '', state: 'running', total: 1000, ...emptyCounts(), ...job },
    live,
    current: null,
    pending: 0,
    last: null,
    perMinute: null,
    remainingMs: null,
    failures: [],
    skippedAtHand: 0,
    saveFailed: false,
  };
}

const counts = { photos: { added: 380, review: 30, failed: 3, skipped: 0 }, cards: { added: 380, review: 30 } };

describe('import wording', () => {
  it('says how far it has got', () => {
    expect(headline(view(counts))).toBe('Importing photos: 413 of 1,000 photos');
    expect(headline(view({ ...counts, state: 'paused' }))).toBe('Import paused: 413 of 1,000 photos');
    expect(headline(view({ ...counts, state: 'done', total: 413 }))).toBe('Import finished: 413 photos');
    expect(headline(view({ ...counts, state: 'cancelled' }))).toBe('Import cancelled: 413 of 1,000 photos read');
    expect(headline(view({ state: 'done', total: 1, photos: { added: 1, review: 0, failed: 0, skipped: 0 } }))).toBe('Import finished: 1 photo');
  });

  it('after a reload, says what finished and how to finish the rest', () => {
    const cut = view({ ...counts, state: 'running' }, false);
    expect(headline(cut)).toBe('Import stopped before it finished: 413 of 1,000 photos read');
    expect(nextStep(cut)).toMatch(/pick the same photos again: the ones already read are skipped/);
    // A finished one is just finished.
    expect(headline(view({ ...counts, state: 'done', total: 413 }, false))).toBe('Import finished: 413 photos');
  });

  it('tallies cards and photos, leaving out what is 0', () => {
    expect(tally(counts)).toBe('380 cards added · 30 to review · 3 without a card');
    expect(tally({ photos: { added: 1, review: 0, failed: 0, skipped: 12 }, cards: { added: 1, review: 0 } })).toBe('1 card added · 12 skipped');
    expect(tally({ photos: { added: 0, review: 1, failed: 0, skipped: 0 }, cards: { added: 6, review: 2, unread: 1 } })).toBe('6 cards added · 2 to review · 1 outline not read');
  });

  it('rounds the time left', () => {
    expect(timeLeft(null)).toBeNull();
    expect(timeLeft(20_000)).toBe('under a minute left');
    expect(timeLeft(12.4 * 60_000)).toBe('about 12 min left');
    expect(timeLeft(95 * 60_000)).toBe('about 1 h 35 min left');
  });

  it('says why a photo gave no card', () => {
    expect(failureText('no-card', 'a.jpg')).toBe('No card found');
    expect(failureText('unopenable', 'IMG_1.HEIC')).toMatch(/HEIC/);
    expect(failureText('unopenable', 'a.jpg')).toBe('This browser can’t open it');
    expect(skippedText(1)).toBe('1 photo was read into this batch before, so it was skipped.');
    expect(skippedText(1200)).toBe('1,200 photos were read into this batch before, so they were skipped.');
  });

  it('says what happened to a stopped import', () => {
    expect(nextStep(view({ state: 'stopped', why: 'batch-gone' }))).toMatch(/deleted or merged/);
    expect(nextStep(view({ state: 'done' }))).toBeNull();
  });
});
