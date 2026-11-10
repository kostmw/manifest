/**
 * Polite downloading for the offline index builders: requests start at least
 * `minGapMs` apart, only a few are in flight at once, HTTP 429 and 5xx pause
 * everything (honouring Retry-After), and a descriptive User-Agent is sent.
 */

export interface PoliteFetchOptions {
  headers: Record<string, string>;
  /** Least time between the starts of two requests. */
  minGapMs?: number;
  concurrency?: number;
  maxAttempts?: number;
  /** Give up on one attempt after this long; it is retried like any other failure. */
  timeoutMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class PoliteFetcher {
  private nextStart = 0;
  private pausedUntil = 0;
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly minGapMs: number;
  private readonly concurrency: number;
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;

  constructor(private readonly options: PoliteFetchOptions) {
    this.minGapMs = options.minGapMs ?? 100;
    this.concurrency = options.concurrency ?? 4;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private async slot(): Promise<void> {
    if (this.active >= this.concurrency) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
  }

  private release(): void {
    this.active -= 1;
    this.waiting.shift()?.();
  }

  private async turn(): Promise<void> {
    for (;;) {
      const now = Date.now();
      const at = Math.max(this.nextStart, this.pausedUntil);
      if (at <= now) {
        this.nextStart = now + this.minGapMs;
        return;
      }
      await sleep(at - now);
    }
  }

  /** The body of a successful response, or null on 404 (an image Scryfall doesn't have). */
  async bytes(url: string): Promise<Uint8Array | null> {
    await this.slot();
    try {
      for (let attempt = 1; ; attempt++) {
        await this.turn();
        let response: Response;
        try {
          // A connection that hangs (a dropped network, a laptop gone to sleep) would otherwise stall the build.
          response = await fetch(url, { headers: this.options.headers, signal: AbortSignal.timeout(this.timeoutMs) });
        } catch (error) {
          if (attempt >= this.maxAttempts) throw error;
          await sleep(1000 * attempt);
          continue;
        }
        if (response.status === 404) return null;
        if (response.status === 429 || response.status >= 500) {
          if (attempt >= this.maxAttempts) throw new Error(`${url}: HTTP ${response.status}`);
          const retryAfter = Number(response.headers.get('Retry-After'));
          const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 3000 * attempt;
          // Everyone waits, not just this request.
          this.pausedUntil = Math.max(this.pausedUntil, Date.now() + wait);
          continue;
        }
        if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
        return new Uint8Array(await response.arrayBuffer());
      }
    } finally {
      this.release();
    }
  }
}
