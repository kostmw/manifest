import { describe, expect, it } from 'vitest';
import type { OfflineStatus } from './offline';
import { offlineLine, offlineNotice, shortDate } from './offlineText';

const base: OfflineStatus = { unavailable: false, buildDate: '2026-11-18T17:46:10.980Z', ready: true, download: null, noRoom: false, persisted: null };
const status = (patch: Partial<OfflineStatus>): OfflineStatus => ({ ...base, ...patch });

describe('offlineLine', () => {
  it('names the card data in use and whether it works offline', () => {
    expect(shortDate(base.buildDate!)).toBe('18 Nov');
    expect(offlineLine(base, true)).toBe('Card data 18 Nov · ready offline');
    expect(offlineLine(status({ ready: false }), true)).toBe('Card data 18 Nov · not ready offline yet');
    expect(offlineLine(status({ ready: false }), false)).toBe('Card data 18 Nov · not ready offline: connect to finish downloading');
  });

  it('shows the first download and a nightly update as they go', () => {
    expect(offlineLine(status({ ready: false, download: { percent: 43, updating: false, buildDate: base.buildDate! } }), true)).toBe(
      'Card data 18 Nov · downloading for offline use, 43%',
    );
    expect(offlineLine(status({ download: { percent: 61, updating: true, buildDate: '2026-11-19T17:40:00.000Z' } }), true)).toBe(
      'Card data 18 Nov · ready offline · updating to 19 Nov, 61%',
    );
  });

  it('says so where nothing can be kept, and says nothing before it knows', () => {
    expect(offlineLine(status({ unavailable: true }), true)).toMatch(/can't be kept offline/);
    expect(offlineLine(status({ buildDate: null, ready: null }), true)).toBeNull();
  });

  it('adds whether the storage is kept, in debug mode', () => {
    expect(offlineLine(status({ persisted: true }), true, true)).toBe('Card data 18 Nov · ready offline · storage kept');
    expect(offlineLine(status({ persisted: false }), true, true)).toBe('Card data 18 Nov · ready offline · storage may be cleared');
  });
});

describe('offlineNotice', () => {
  it('shows only the first download and a lack of space, not the nightly updates', () => {
    expect(offlineNotice(status({ download: { percent: 5, updating: false, buildDate: base.buildDate! } }))).toEqual({
      text: 'Downloading card data for offline use: 5%. You can scan meanwhile.',
      alert: false,
    });
    expect(offlineNotice(status({ download: { percent: 5, updating: true, buildDate: base.buildDate! } }))).toBeNull();
    expect(offlineNotice(status({ noRoom: true }))?.alert).toBe(true);
    expect(offlineNotice(base)).toBeNull();
  });
});
