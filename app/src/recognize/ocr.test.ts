import { describe, expect, it } from 'vitest';
import { createGray } from '../vision/image';
import { oneLineAtATime, type OcrEngine, type OcrOptions } from './ocr';

/** An engine like Tesseract's: a read sets the whitelist, waits, then recognizes with whatever is set by then. */
function whitelistEngine(log: string[]): OcrEngine {
  let whitelist = 'title';
  const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
  return {
    async readLine(_image, options?: OcrOptions) {
      const wanted = options?.characters ?? 'title';
      if (wanted !== whitelist) {
        await tick();
        whitelist = wanted;
      }
      await tick();
      log.push(`${wanted} read with ${whitelist}`);
      return { text: whitelist, confidence: 90 };
    },
    dispose: async () => {},
  };
}

describe('oneLineAtATime', () => {
  it('keeps two reads at once from mixing their characters', async () => {
    const image = createGray(4, 4);
    const raw: string[] = [];
    const bare = whitelistEngine(raw);
    await Promise.all([bare.readLine(image, { characters: 'collector' }), bare.readLine(image)]);
    // Without it, the title is read with the collector line's characters.
    expect(raw).toContain('title read with collector');

    const safe: string[] = [];
    const engine = oneLineAtATime(whitelistEngine(safe));
    const [collector, title] = await Promise.all([engine.readLine(image, { characters: 'collector' }), engine.readLine(image)]);
    expect(safe).toEqual(['collector read with collector', 'title read with title']);
    expect(collector.text).toBe('collector');
    expect(title.text).toBe('title');
  });

  it('carries on after a read that fails', async () => {
    let calls = 0;
    const engine = oneLineAtATime({
      readLine: async () => {
        calls++;
        if (calls === 1) throw new Error('bad line');
        return { text: 'ok', confidence: 90 };
      },
      dispose: async () => {},
    });
    const image = createGray(1, 1);
    await expect(engine.readLine(image)).rejects.toThrow('bad line');
    await expect(engine.readLine(image)).resolves.toEqual({ text: 'ok', confidence: 90 });
  });
});
