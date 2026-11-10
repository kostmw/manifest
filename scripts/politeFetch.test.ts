import { afterEach, describe, expect, it, vi } from 'vitest';
import { PoliteFetcher } from './politeFetch';

afterEach(() => vi.unstubAllGlobals());

function respond(...steps: (number | 'hang')[]) {
  const calls: number[] = [];
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
    const step = steps[Math.min(calls.length, steps.length - 1)]!;
    calls.push(Date.now());
    if (step === 'hang') {
      return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    }
    return Promise.resolve(new Response(step === 200 ? new Uint8Array([1, 2, 3]) : null, { status: step, headers: { 'Retry-After': '0' } }));
  });
  return calls;
}

describe('PoliteFetcher', () => {
  it('returns the body, or null for an image that does not exist', async () => {
    respond(200);
    expect(Array.from((await new PoliteFetcher({ headers: {}, minGapMs: 0 }).bytes('x'))!)).toEqual([1, 2, 3]);
    respond(404);
    expect(await new PoliteFetcher({ headers: {}, minGapMs: 0 }).bytes('x')).toBeNull();
  });

  it('backs off and retries on 429, and gives up after the last attempt', async () => {
    vi.useFakeTimers();
    const calls = respond(429, 200);
    const fetched = new PoliteFetcher({ headers: {}, minGapMs: 0 }).bytes('x');
    await vi.runAllTimersAsync();
    expect(await fetched).not.toBeNull();
    expect(calls).toHaveLength(2);

    respond(503);
    const failing = new PoliteFetcher({ headers: {}, minGapMs: 0, maxAttempts: 2 }).bytes('x');
    const outcome = expect(failing).rejects.toThrow('HTTP 503');
    await vi.runAllTimersAsync();
    await outcome;
    vi.useRealTimers();
  });

  it('abandons a hung request and tries again', async () => {
    const calls = respond('hang', 200);
    const bytes = await new PoliteFetcher({ headers: {}, minGapMs: 0, timeoutMs: 20 }).bytes('x');
    expect(bytes).not.toBeNull();
    expect(calls).toHaveLength(2);
  }, 5000);
});
