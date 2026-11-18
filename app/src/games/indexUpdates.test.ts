import { describe, expect, it, vi } from 'vitest';

// The scheduler alone: the real check (indexClient) needs a browser.
vi.mock('./indexClient', () => ({ checkForIndexUpdate: vi.fn(), onStaleBuild: vi.fn() }));
const { CHECK_GAP_MS, CHECK_INTERVAL_MS, MIN_ATTEMPT_GAP_MS, RETRY_GAP_MS, START_DELAY_MS, scheduleIndexUpdates } = await import('./indexUpdates');

function fakes(outcomes: string[] = []) {
  const listeners = new Map<string, Set<() => void>>();
  const on = (type: string, listener: () => void) => void (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(listener);
  const off = (type: string, listener: () => void) => void listeners.get(type)?.delete(listener);
  const fire = async (type: string) => {
    listeners.get(type)?.forEach((listener) => listener());
    await Promise.resolve();
    await Promise.resolve();
  };
  const timeouts: { handler: () => void; ms: number }[] = [];
  const intervals: { handler: () => void; ms: number }[] = [];
  const page = { visibilityState: 'visible' as DocumentVisibilityState, addEventListener: on, removeEventListener: off };
  const win = {
    addEventListener: on,
    removeEventListener: off,
    setTimeout: (handler: () => void, ms: number) => timeouts.push({ handler, ms }),
    clearTimeout: () => timeouts.splice(0),
    setInterval: (handler: () => void, ms: number) => intervals.push({ handler, ms }),
    clearInterval: () => intervals.splice(0),
  };
  let clock = 1_000_000;
  let checks = 0;
  let stale: (() => void) | null = null;
  const deps = {
    check: async () => ({ kind: outcomes[checks++] ?? 'up-to-date' }),
    onStale: (listener: () => void) => {
      stale = listener;
      return () => (stale = null);
    },
    page,
    win,
    now: () => clock,
  };
  const settle = async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  };
  return {
    deps,
    page,
    fire,
    settle,
    timeouts,
    intervals,
    advance: (ms: number) => (clock += ms),
    checks: () => checks,
    stale: async () => {
      stale?.();
      await settle();
    },
  };
}

describe('scheduleIndexUpdates', () => {
  it('checks a moment after start-up, then hourly', async () => {
    const f = fakes();
    scheduleIndexUpdates(f.deps);
    expect(f.timeouts).toEqual([{ handler: expect.any(Function), ms: START_DELAY_MS }]);
    expect(f.intervals[0]!.ms).toBe(CHECK_INTERVAL_MS);
    f.timeouts[0]!.handler();
    await f.settle();
    expect(f.checks()).toBe(1);
  });

  it("doesn't check again for a few hours after a check that reached the server", async () => {
    const f = fakes(['up-to-date']);
    scheduleIndexUpdates(f.deps);
    f.timeouts[0]!.handler();
    await f.settle();
    f.advance(CHECK_GAP_MS - 1000);
    await f.fire('visibilitychange');
    await f.fire('online');
    expect(f.checks()).toBe(1);
    f.advance(2000);
    await f.fire('visibilitychange');
    expect(f.checks()).toBe(2);
  });

  it('tries again when the app comes back into view or online after an offline check', async () => {
    const f = fakes(['offline', 'offline', 'switched']);
    scheduleIndexUpdates(f.deps);
    f.timeouts[0]!.handler();
    await f.settle();
    await f.fire('online'); // too soon after the last attempt
    expect(f.checks()).toBe(1);
    f.advance(MIN_ATTEMPT_GAP_MS);
    await f.fire('online');
    f.advance(MIN_ATTEMPT_GAP_MS);
    await f.fire('visibilitychange');
    expect(f.checks()).toBe(3);
  });

  it('retries a deploy half done after a few minutes', async () => {
    const f = fakes(['mismatch']);
    scheduleIndexUpdates(f.deps);
    f.timeouts[0]!.handler();
    await f.settle();
    f.advance(RETRY_GAP_MS - 1000);
    await f.fire('visibilitychange');
    expect(f.checks()).toBe(1);
    f.advance(2000);
    await f.fire('visibilitychange');
    expect(f.checks()).toBe(2);
  });

  it('looks for the new build as soon as a thread was served a file from it, however recent the last check', async () => {
    const f = fakes(['up-to-date', 'switched']);
    scheduleIndexUpdates(f.deps);
    f.timeouts[0]!.handler();
    await f.settle();
    await f.stale(); // only just checked
    expect(f.checks()).toBe(1);
    f.advance(MIN_ATTEMPT_GAP_MS);
    await f.stale();
    expect(f.checks()).toBe(2);
  });

  it('never checks while the app is out of view, nor where there is no Cache Storage', async () => {
    const f = fakes(['unavailable']);
    scheduleIndexUpdates(f.deps);
    f.page.visibilityState = 'hidden';
    f.timeouts[0]!.handler();
    await f.settle();
    expect(f.checks()).toBe(0);
    f.page.visibilityState = 'visible';
    await f.fire('visibilitychange');
    expect(f.checks()).toBe(1);
    f.advance(CHECK_GAP_MS * 10);
    await f.fire('visibilitychange');
    await f.stale();
    expect(f.checks()).toBe(1);
  });
});
