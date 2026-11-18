import { describe, expect, it } from 'vitest';

import { CHECK_GAP_MS, CHECK_INTERVAL_MS, MIN_ATTEMPT_GAP_MS, RESUME_DELAY_MS, RETRY_GAP_MS, START_DELAY_MS, scheduleIndexUpdates } from './indexUpdates';

function fakes(outcomes: string[] = []) {
  const listeners = new Map<string, Set<() => void>>();
  const on = (type: string, listener: () => void) => void (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(listener);
  const off = (type: string, listener: () => void) => void listeners.get(type)?.delete(listener);
  const fire = async (type: string) => {
    listeners.get(type)?.forEach((listener) => listener());
    await Promise.resolve();
    await Promise.resolve();
  };
  const timeouts: { handler: () => void; ms: number; cleared?: boolean }[] = [];
  const intervals: { handler: () => void; ms: number }[] = [];
  const page = { visibilityState: 'visible' as DocumentVisibilityState, addEventListener: on, removeEventListener: off };
  const win = {
    addEventListener: on,
    removeEventListener: off,
    setTimeout: (handler: () => void, ms: number) => timeouts.push({ handler, ms }) - 1,
    clearTimeout: (id: unknown) => void (timeouts[id as number] && (timeouts[id as number]!.cleared = true)),
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

  it('looks for the new build when a thread was served a file from it, as soon as the last check is 30 s old', async () => {
    const f = fakes(['up-to-date', 'switched']);
    scheduleIndexUpdates(f.deps);
    f.timeouts[0]!.handler();
    await f.settle();
    await f.stale(); // only just checked: one is set for when the gap is over
    expect(f.checks()).toBe(1);
    const deferred = f.timeouts.at(-1)!;
    expect(deferred.ms).toBe(MIN_ATTEMPT_GAP_MS);
    f.advance(MIN_ATTEMPT_GAP_MS);
    deferred.handler();
    await f.settle();
    expect(f.checks()).toBe(2);
  });

  it('checks again straight after a check during which a thread was served a newer file', async () => {
    let release: (value: { kind: string }) => void = () => {};
    const f = fakes();
    let checks = 0;
    f.deps.check = () => (++checks === 1 ? new Promise((resolve) => (release = resolve)) : Promise.resolve({ kind: 'switched' }));
    scheduleIndexUpdates(f.deps);
    f.timeouts[0]!.handler();
    await f.settle();
    await f.stale(); // while the first is still running
    f.advance(MIN_ATTEMPT_GAP_MS);
    release({ kind: 'up-to-date' });
    await f.settle();
    await f.settle();
    expect(checks).toBe(2);
  });

  it('carries on a stopped download by itself a minute later', async () => {
    const f = fakes(['incomplete', 'up-to-date']);
    scheduleIndexUpdates(f.deps);
    f.timeouts[0]!.handler();
    await f.settle();
    const resume = f.timeouts.at(-1)!;
    expect(resume.ms).toBe(RESUME_DELAY_MS);
    f.advance(RESUME_DELAY_MS);
    resume.handler();
    await f.settle();
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
