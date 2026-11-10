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
