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
export interface OcrEngine {
  readLine(image: GrayImage): Promise<OcrLine>;
  dispose(): Promise<void>;
}

/** Characters that appear in card titles. Restricting OCR to them stops it inventing symbols. */
export const TITLE_CHARACTERS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ',-.:!?&" + 'ÆæÀÁÂÄÉÈÊËÍÎÏÓÔÖÚÛÜÑàáâäéèêëíîïóôöúûüñ’';
