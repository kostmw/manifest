import { describe, expect, it } from 'vitest';
import { MIN_CHECK_GAP_MS, UPDATE_CHECK_INTERVAL_MS, watchForUpdates } from './updates';

function fakes() {
  const listeners = new Map<string, Set<() => void>>();
  const on = (type: string, listener: () => void) => void (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(listener);
  const off = (type: string, listener: () => void) => void listeners.get(type)?.delete(listener);
  const fire = (type: string) => listeners.get(type)?.forEach((listener) => listener());
  const page = { visibilityState: 'visible' as DocumentVisibilityState, addEventListener: on, removeEventListener: off };
  const timers: { handler: () => void; ms: number }[] = [];
  const win = {
    addEventListener: on,
    removeEventListener: off,
    setInterval: (handler: () => void, ms: number) => timers.push({ handler, ms }),
    clearInterval: () => timers.splice(0),
  };
  let clock = 1_000_000;
  let updates = 0;
  const registration = { update: async () => void (updates += 1) };
  return { page, win, fire, timers, registration, advance: (ms: number) => (clock += ms), now: () => clock, updates: () => updates };
}

describe('watchForUpdates', () => {
  it('checks when the app comes back into view, which is how iOS resumes a home-screen app', () => {
    const f = fakes();
    watchForUpdates(f.registration, f.page, f.win, f.now);
    f.page.visibilityState = 'hidden';
    f.fire('visibilitychange');
    expect(f.updates()).toBe(0);
    f.page.visibilityState = 'visible';
    f.fire('visibilitychange');
    expect(f.updates()).toBe(1);
    f.advance(MIN_CHECK_GAP_MS + 1);
    f.fire('pageshow');
    expect(f.updates()).toBe(2);
  });

  it("doesn't check again within half a minute", () => {
    const f = fakes();
    watchForUpdates(f.registration, f.page, f.win, f.now);
    f.fire('visibilitychange');
    f.fire('pageshow');
    expect(f.updates()).toBe(1);
  });

  it('checks every hour while open, and stops when asked', () => {
    const f = fakes();
    const stop = watchForUpdates(f.registration, f.page, f.win, f.now);
    expect(f.timers[0]?.ms).toBe(UPDATE_CHECK_INTERVAL_MS);
    f.timers[0]!.handler();
    expect(f.updates()).toBe(1);
    stop();
    f.advance(MIN_CHECK_GAP_MS + 1);
    f.fire('visibilitychange');
    expect(f.updates()).toBe(1);
    expect(f.timers).toHaveLength(0);
  });

  it('shrugs off a failed check (offline)', async () => {
    const f = fakes();
    watchForUpdates({ update: () => Promise.reject(new Error('offline')) }, f.page, f.win, f.now);
    expect(() => f.fire('visibilitychange')).not.toThrow();
  });
});
