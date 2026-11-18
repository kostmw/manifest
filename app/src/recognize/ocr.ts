import type { GrayImage } from '../vision/image';

export interface OcrLine {
  text: string;
  /** The engine's own confidence, 0–100. */
  confidence: number;
}

/**
 * One line of text in, text out. Recognition depends only on this, so the
 * engine (Tesseract today) can be swapped for another without touching the
 * pipeline.
 */
export interface OcrOptions {
  /** Characters the line may contain. Defaults to TITLE_CHARACTERS. */
  characters?: string;
}

export interface OcrEngine {
  readLine(image: GrayImage, options?: OcrOptions): Promise<OcrLine>;
  dispose(): Promise<void>;
}

/** Characters that appear in card titles. Restricting OCR to them stops it inventing symbols. */
export const TITLE_CHARACTERS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ',-.:!?&" + 'ÆæÀÁÂÄÉÈÊËÍÎÏÓÔÖÚÛÜÑàáâäéèêëíîïóôöúûüñ’';

/**
 * Characters on collector lines: set codes, numbers, rarity letters and the
 * separators between them. Lower case is allowed for the copyright line that
 * carries the number on 2003–2014 frames.
 */
export const COLLECTOR_CHARACTERS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz/-.•*&';

/** A collector number line read again when the first read found no number: digits, the slash and rarity letters only. */
export const COLLECTOR_NUMBER_CHARACTERS = '0123456789/CURMSTLP';

/**
 * An engine that reads one line at a time, in the order asked. A Tesseract
 * read is a whitelist change and then a recognize: two reads at once (live
 * mode and a bulk import, both in the recognition worker) would otherwise
 * interleave, and one would be read with the other's characters.
 */
export function oneLineAtATime(engine: OcrEngine): OcrEngine {
  let queue: Promise<unknown> = Promise.resolve();
  return {
    readLine(image, options) {
      const read = queue.then(() => engine.readLine(image, options));
      queue = read.catch(() => undefined);
      return read;
    },
    dispose: () => engine.dispose(),
  };
}
