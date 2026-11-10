/**
 * The Tesseract.js engine behind OcrEngine. The same code runs in the browser
 * (inside the recognition worker, which starts Tesseract's own worker) and in
 * Node for the eval; only the file locations differ. Nothing is fetched from a
 * CDN: every path must point at files this site serves itself.
 */
import { createWorker, OEM, PSM } from 'tesseract.js';
import { encodePgm } from '../vision/image';
import { TITLE_CHARACTERS, type OcrEngine } from './ocr';

export interface TesseractPaths {
  /** Directory holding eng.traineddata.gz. */
  langPath: string;
  /** Tesseract core script; its .wasm is loaded from the same directory. Browser only. */
  corePath?: string;
  /** Tesseract.js worker script. Browser only. */
  workerPath?: string;
  /**
   * Where the unpacked language data is cached: a directory in Node (else the
   * working directory), a key prefix in the browser's IndexedDB. Tesseract keys
   * the cache by this alone, not by `langPath`, so it must name the model.
   */
  cachePath?: string;
}

export async function createTesseractEngine(paths: TesseractPaths): Promise<OcrEngine> {
  const worker = await createWorker(
    'eng',
    OEM.LSTM_ONLY,
    {
      langPath: paths.langPath,
      gzip: true,
      ...(paths.corePath ? { corePath: paths.corePath } : {}),
      ...(paths.workerPath ? { workerPath: paths.workerPath, workerBlobURL: false } : {}),
      ...(paths.cachePath ? { cachePath: paths.cachePath } : {}),
    },
    // Card names are mostly invented words, so English word lists only get in the way.
    { load_system_dawg: '0', load_freq_dawg: '0' },
  );
  await worker.setParameters({
    tessedit_pageseg_mode: PSM.SINGLE_LINE,
    tessedit_char_whitelist: TITLE_CHARACTERS,
    preserve_interword_spaces: '1',
  });

  return {
    async readLine(image) {
      // Raw bytes work in both builds; the type definitions only admit Node's Buffer.
      const { data } = await worker.recognize(encodePgm(image) as unknown as Buffer);
      return { text: data.text.replace(/\s+/g, ' ').trim(), confidence: data.confidence };
    },
    async dispose() {
      await worker.terminate();
    },
  };
}
