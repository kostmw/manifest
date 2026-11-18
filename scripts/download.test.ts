import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkStatus, downloadToFile, fetchJson, HttpStatusError, withRetries } from './download';

const noWait = { sleep: async () => undefined, log: () => undefined };

describe('withRetries', () => {
  it('tries again after a network error, waiting longer each time', async () => {
    const waits: number[] = [];
    let calls = 0;
    const result = await withRetries(
      'x',
      async () => {
        calls += 1;
        if (calls < 3) throw new TypeError('terminated');
        return 'done';
      },
      { ...noWait, sleep: async (ms) => void waits.push(ms) },
    );
    expect(result).toBe('done');
    expect(calls).toBe(3);
    expect(waits).toEqual([10_000, 20_000]);
  });

  it('honours Retry-After on 429 and 503', async () => {
    const waits: number[] = [];
    let calls = 0;
    await withRetries(
      'x',
      async () => {
        calls += 1;
        if (calls === 1) throw new HttpStatusError('u', 429, 60_000);
        if (calls === 2) throw new HttpStatusError('u', 503, 0);
        return 'done';
      },
      { ...noWait, sleep: async (ms) => void waits.push(ms) },
    );
    expect(waits).toEqual([60_000, 0]);
  });

  it('fails at once on an HTTP error that another try will not fix', async () => {
    let calls = 0;
    const failing = withRetries(
      'x',
      async () => {
        calls += 1;
        throw new HttpStatusError('u', 404);
      },
      noWait,
    );
    await expect(failing).rejects.toThrow('u: HTTP 404');
    expect(calls).toBe(1);
  });

  it('gives up after the last attempt with the last error', async () => {
    let calls = 0;
    const failing = withRetries(
      'x',
      async () => {
        calls += 1;
        throw new Error(`attempt ${calls}`);
      },
      { ...noWait, maxAttempts: 3 },
    );
    await expect(failing).rejects.toThrow('attempt 3');
    expect(calls).toBe(3);
  });
});

describe('checkStatus', () => {
  it('passes an OK response through and turns others into HttpStatusError', async () => {
    const ok = new Response('{}', { status: 200 });
    expect(await checkStatus('u', ok)).toBe(ok);
    const limited = checkStatus('u', new Response('slow down', { status: 429, headers: { 'Retry-After': '2' } }));
    await expect(limited).rejects.toMatchObject({ status: 429, retryAfterMs: 2000 });
    const broken = checkStatus('u', new Response(null, { status: 500 }));
    await expect(broken).rejects.toMatchObject({ status: 500, retryAfterMs: undefined });
  });
});

describe('downloads over a real connection', () => {
  let server: Server;
  let base: string;
  let dir: string;
  let handler: (count: number, res: import('node:http').ServerResponse) => void;
  let requests = 0;

  beforeEach(async () => {
    requests = 0;
    dir = await mkdtemp(join(tmpdir(), 'manifest-download-'));
    server = createServer((_req, res) => handler(++requests, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  const body = 'x'.repeat(50_000);

  it('downloads the whole file again when the first body is cut short', async () => {
    handler = (count, res) => {
      res.writeHead(200, { 'Content-Length': String(body.length) });
      if (count === 1) {
        // What Scryfall's CDN did: part of the body, then the connection goes.
        res.write(body.slice(0, 1000), () => res.socket?.destroy());
        return;
      }
      res.end(body);
    };
    const path = join(dir, 'bulk.jsonl.gz');
    await downloadToFile(`${base}/bulk`, path, { headers: {}, ...noWait });
    expect(requests).toBe(2);
    expect(await readFile(path, 'utf8')).toBe(body);
    expect(existsSync(`${path}.partial`)).toBe(false);
  });

  it('leaves neither the file nor a partial one when every attempt fails', async () => {
    handler = (_count, res) => {
      res.writeHead(200, { 'Content-Length': String(body.length) });
      res.write(body.slice(0, 1000), () => res.socket?.destroy());
    };
    const path = join(dir, 'bulk.jsonl.gz');
    await expect(downloadToFile(`${base}/bulk`, path, { headers: {}, ...noWait, maxAttempts: 2 })).rejects.toThrow();
    expect(requests).toBe(2);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.partial`)).toBe(false);
  });

  it('fetches JSON after a server error', async () => {
    handler = (count, res) => {
      if (count === 1) {
        res.writeHead(502).end('bad gateway');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [1, 2] }));
    };
    expect(await fetchJson<{ data: number[] }>(`${base}/bulk-data`, { headers: {}, ...noWait })).toEqual({ data: [1, 2] });
    expect(requests).toBe(2);
  });
});
