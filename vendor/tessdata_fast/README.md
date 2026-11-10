Tesseract's fast English LSTM model, served by the app for title OCR (see `ocr/` in `vite.config.ts`).

- Source: `eng.traineddata` from [tesseract-ocr/tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast) at commit `923915d4ced2a7235221788285785a29c4a42d4a`, gzipped with `gzip -9 -n`.
- Uncompressed SHA-256: `7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2`.
- Licence: Apache-2.0, in `LICENSE` (from the same repository at `27cfc71a8874cce2483679eea010e391bb38c2ae`).
- Chosen over tesseract.js's default `4.0.0_best_int` model in M2: 1.97 MB gzipped against 2.95 MB, with the same title accuracy on the eval (see `CLAUDE.md`).
