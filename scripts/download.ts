/**
 * Single downloads for the offline index builders (the bulk listing and the
 * bulk file itself), retried when the network lets them down: a dropped
 * connection, a body cut short, HTTP 5xx, or HTTP 429 (honouring Retry-After).
 * Other HTTP errors, such as 404, fail at once.
 *
 * Scryfall's CDN once cut the bulk file off 20 seconds in, and the nightly
 * build failed on that one download (2026-11-17).
 */
import { createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

export interface RetryOptions {
  maxAttempts?: number;
  /** The wait before the next attempt when the server gives no Retry-After. */
  backoffMs?: (attempt: number) => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

export interface DownloadOptions extends RetryOptions {
  headers: Record<string, string>;
  fetch?: typeof fetch;
}

/** A response that wasn't OK. Only 429 and 5xx are worth another try. */
export class HttpStatusError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(`${url}: HTTP ${status}`);
    this.name = 'HttpStatusError';
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isRetryable(error: unknown): boolean {
  if (error instanceof HttpStatusError) return error.status === 429 || error.status >= 500;
  // Network errors, bodies cut short, and anything else the transport throws.
  return true;
}

/** Runs `task` until it succeeds, retrying failures that might go away on their own. */
export async function withRetries<T>(label: string, task: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 4;
  const backoffMs = options.backoffMs ?? ((attempt: number) => 10_000 * attempt);
  const sleep = options.sleep ?? defaultSleep;
  const log = options.log ?? ((message: string) => console.warn(message));
  for (let attempt = 1; ; attempt++) {
    try {
      return await task();
    } catch (error) {
      if (!isRetryable(error) || attempt >= maxAttempts) throw error;
      const wait = error instanceof HttpStatusError && error.retryAfterMs !== undefined ? error.retryAfterMs : backoffMs(attempt);
      const reason = error instanceof Error ? error.message : String(error);
      log(`${label} failed (${reason}); trying again in ${Math.round(wait / 1000)} s (attempt ${attempt + 1} of ${maxAttempts})`);
      await sleep(wait);
    }
  }
}

/** Returns an OK response, or throws HttpStatusError after letting go of the body. */
export async function checkStatus(url: string, response: Response): Promise<Response> {
  if (response.ok) return response;
  await response.body?.cancel().catch(() => undefined);
  const header = response.headers.get('Retry-After');
  const seconds = header === null ? Number.NaN : Number(header);
  throw new HttpStatusError(url, response.status, Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined);
}

/** Fetches and parses a JSON document, with retries. */
export async function fetchJson<T>(url: string, options: DownloadOptions): Promise<T> {
  const fetchImpl = options.fetch ?? fetch;
  return withRetries(
    `Fetching ${url}`,
    async () => (await (await checkStatus(url, await fetchImpl(url, { headers: options.headers }))).json()) as T,
    options,
  );
}

/**
 * Downloads `url` to `path`, with retries. The body goes to `<path>.partial`,
 * renamed only once all of it has arrived, so a cut-off download never looks
 * finished; a download that fails for good leaves no partial file behind.
 */
export async function downloadToFile(url: string, path: string, options: DownloadOptions): Promise<void> {
  const fetchImpl = options.fetch ?? fetch;
  const partial = `${path}.partial`;
  try {
    await withRetries(
      `Downloading ${url}`,
      async () => {
        const response = await checkStatus(url, await fetchImpl(url, { headers: options.headers }));
        if (!response.body) throw new Error(`${url}: empty response`);
        // Each attempt starts the file afresh.
        await pipeline(Readable.fromWeb(response.body as NodeReadableStream), createWriteStream(partial));
      },
      options,
    );
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  await rename(partial, path);
}
