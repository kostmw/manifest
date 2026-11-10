# Manifest — free, browser-based TCG card scanner

> Working name: **Manifest** (an MTG keyword *and* the word for a list of what's in a shipment).
> Tagline: *Scan a stack, get a list.*

## Commands

Node comes from `.nvmrc`. One package at the repo root; Vite's root is `app/`.

| Command | What it does |
|---|---|
| `npm run dev` | Dev server |
| `npm run check` | Typecheck, unit tests, production build |
| `npm run e2e` | Playwright against a production build, with a fake camera and a 25-card index |
| `npm run index:build` | Downloads Scryfall bulk data and writes the index to `data/`. Add `-- --source file.jsonl --out dir` to use a local file |
| `npm run eval` | Recognition eval on the owner's real scans and a synthetic set (needs `index:build` first; the first run downloads ~320 Scryfall images to `.cache/eval/`). Report in `.cache/eval/report/index.html`. Flags: `--only real\|synthetic`, `--tag dfc`, `--limit 50`, `--regenerate` |

Set `MANIFEST_BASE` to build for a sub-path (GitHub Pages uses `/manifest/`; CI sets it).

## Mission

Build a free, privacy-respecting web app that scans physical trading cards with a phone or webcam (or from image files), identifies each card accurately, and outputs clean card lists as `.txt`, `.md`, or `.csv`. The lists are for pasting into AI chats and importing into sites like Moxfield, Archidekt, EDHREC, ManaBox, and Deckbox.

**Recognition quality is the product.** Every other feature exists to feed cards into the recognizer quickly and get its results out cleanly.

## Non-goals (for now)

- Not an inventory or collection manager: no prices, portfolio value, deck building, or trading.
- No user accounts, no backend server, and no paid APIs.
- No native app store builds. It's a PWA that can be installed with "Add to Home Screen."

## Hard constraints

1. **$0 to run.** It's a static site on GitHub Pages or Cloudflare Pages. Index files are built offline by scheduled GitHub Actions jobs, which are free for public repos.
2. **All recognition runs on the user's device**, in the browser (WASM/WebGPU/WebGL in Web Workers). Card images never leave the device.
3. **Works offline** once the game's index has been downloaded (Cache Storage / OPFS).
4. **Respect data-source terms** (see "Data sources & rules"). No hotlinking abuse, no rate-limit violations, and attribution is shown in the app.
5. **Keep each static asset ≤ 20 MB** so the site deploys on either Pages host. Shard large indexes.
6. HTTPS is required for camera access. Both Pages hosts provide it.

## Tech stack (default choices: change only with a stated reason)

| Concern | Choice |
|---|---|
| Build | Vite + TypeScript (strict) |
| UI | React + Tailwind (keep it simple and mobile-first) |
| PWA | `vite-plugin-pwa` (Workbox) |
| Workers | Web Workers + Comlink. **All** CV/OCR/ML runs off the main thread |
| Card detection / warp | Plain TypeScript in `vision/` (Canny at several thresholds → edge components → hull → line-fitted corners → homography). **Changed in M2:** OpenCV.js is ~3.75 MB gzipped for the half-dozen operations needed, and pure functions are easier to test and run unchanged in the Node eval. Revisit only if the eval shows detection needs it |
| OCR | Tesseract.js 7 (LSTM) with Tesseract's **fast** English model, vendored in `vendor/tessdata_fast/` (Apache-2.0; source commit in its README), on **tightly cropped, binarized** regions only (title line, collector line), behind `recognize/ocr.ts`'s `OcrEngine` so it can be swapped for PaddleOCR/ONNX later. Self-hosted under `ocr/<versions>-<model>/` (never a CDN), about 3 MB gzipped, fetched the first time the scanner opens and cached for offline use |
| Visual fingerprint | Perceptual hashes (pHash/dHash) on the art box; optional MobileCLIP-S0 embeddings via Transformers.js / onnxruntime-web (WebGPU with WASM fallback) for re-ranking |
| Fuzzy name match | SymSpell-style or trigram + Damerau-Levenshtein over the name dictionary |
| Storage | IndexedDB via Dexie (sessions/batches); Cache Storage/OPFS for index shards |
| Tests | Vitest (unit), Playwright (e2e), plus a custom recognition **eval harness** (see below) |
| Index build | Node/TS scripts in `scripts/`, run by GitHub Actions on a schedule (e.g., nightly) |

## Repository layout (target)

```
/app                 # the PWA (src/, public/)
  src/
    capture/         # camera, file import, frame stability
    vision/          # detect, rectify, quality gate (worker)
    recognize/       # OCR, hashing, embeddings, fusion (worker)
    games/           # game adapters: mtg/, pokemon/, yugioh/; index client
    search/          # manual search UI and name-search worker
    review/          # review queue UI
    session/         # batches, IndexedDB
    export/          # formatters (txt, md, csv variants)
/scripts             # offline index builders (Node)
/data                # generated index artifacts (gitignored; published by CI)
/tests
  fixtures/real-scans/   # labeled photos supplied by the owner
  eval/                  # eval harness + HTML failure report
/.github/workflows   # build-index.yml, deploy.yml
```

## Recognition pipeline (the core: spend most effort here)

### Stage 1: Detect and rectify
- Find card quadrilaterals (edges → contours → 4-point approximation with aspect ratio ≈ 63:88). Support **multiple cards per frame** (binder pages, table spreads).
- Perspective-warp each card to a canonical size (488×680, which matches Scryfall's `normal` images).
- Handle sleeves (inner border offset, glare), dark borders on dark backgrounds, and slight rotation. Detect upside-down cards and rotate 180°.

### Stage 2: Quality gate (reject before wasting compute)
- Blur score (variance of the Laplacian), glare/overexposure percentage, card fully in frame, minimum size.
- In live mode, wait for N consecutive stable frames before recognizing.
- If the gate fails, show a specific hint ("too much glare: tilt the card", "hold still").

### Stage 3: Identify (combine several independent signals)
Signals, each producing scored candidates:
- **A. Title OCR → name.** Crop the title bar, binarize, OCR with a restricted character set, then fuzzy-match against the name dictionary. Cheap, and works across reprints.
- **B. Collector line OCR → exact printing.** Modern MTG cards (roughly 2014 onward) print the set code + collector number at the bottom left. Parse it into (set, number) and look it up directly. This is the strongest single signal for the exact printing when it's legible.
- **C. Visual fingerprint → printing.** Hash the art box and compare against the precomputed index. Use it (a) to choose among printings once the name is known, and (b) as a **global fallback** when OCR fails (foreign-language cards, worn cards, full-art, old frames, showcase/borderless treatments).
- **D. (Optional) Embedding re-rank** with MobileCLIP when the top candidates are close.

**Fusion:** combine the signals into a single confidence score. If A is confident, restrict C/D to that name's printings (a small set, so it's fast and accurate). If B parses cleanly and agrees with A, accept immediately. Always keep the **top 5 candidates** with scores for the review UI.

### Stage 4: Decide
- Confidence ≥ the auto-accept threshold → add to the batch.
- Below the threshold → send to the **review queue** with the crop and candidates. Never silently drop a card.
- Thresholds are user-adjustable, with sensible defaults tuned by the eval harness.

### Stage 5: Dedupe in continuous mode
- Track the card currently in frame. A card that stays in view is counted **once**.
- Count a new card when the frame becomes empty or the fingerprint changes beyond a distance threshold.
- Two identical copies scanned back to back must count as two: require a frame-empty or card-removed event between them.

### Known hard cases (must have fixtures and tests)
Foils/glare · sleeved cards · double-faced cards (DFC/MDFC) · split, adventure, flip, and battle cards · basic lands (hundreds of printings with the same name) · borderless/showcase/full-art/extended-art · Secret Lair · tokens/emblems/art cards · non-English cards · pre-2014 frames (no collector line) · oversized cards · Pokémon reverse holos · Yu-Gi-Oh! rarity variants.

## Scanning modes (mass-scanning first)

1. **Live camera (primary).** Phone in a stand, cards slid under the camera one at a time.
   - Auto-capture on stable frame; beep + haptic on accept, a different tone for "needs review."
   - Large running counter, last 5 cards shown as thumbnails with one-tap undo.
   - Torch toggle, rear camera locked, capped resolution for speed.
   - Batch-level toggles: **lock to set(s)**, **everything is foil**, **language**, **condition**.
   - Target throughput: ≥ 1 card/second sustained on a mid-range phone.
2. **Multi-card photo.** One photo of a 3×3 binder page or a table spread, with all cards detected and identified.
3. **Bulk file import.** Drop in a folder of images (from a document scanner's auto-feeder, phone burst shots, etc.). Processed in a worker queue with progress, pause/resume, and a failures list. Must handle 1,000+ images without freezing the tab.
4. **Manual search fallback.** Autocomplete on name, then pick the printing.

## Review queue UX

- Side by side: the user's crop vs. the candidate image, with candidates ranked below.
- Keyboard and tap shortcuts: `1–5` pick a candidate, `Enter` accept, `X` discard, `F` toggle foil, `+/-` quantity, `S` search manually.
- "Apply to all similar" for repeated corrections (e.g., all basic lands → choose the set).

## Sessions and batches (light, not inventory)

- A batch has a name, an optional location tag ("Box 3 – Rares"), creation date, and settings.
- Stored in IndexedDB. Batches can be merged, renamed, and deleted.
- Full JSON backup/restore of all batches (so nothing is lost if the browser storage is cleared).

## Export formats

All exports aggregate duplicates (grouped by printing or by name, selectable). Each is available as copy to clipboard, download, and Web Share on mobile.

| Format | Example line / notes |
|---|---|
| **Plain list** (`.txt`) | `1 Sol Ring`: works almost everywhere, including EDHREC's card clipboard and AI chats. Use the front-face name for DFCs |
| **Detailed list** (`.txt`, Moxfield/Arena style) | `1 Sol Ring (CMM) 410`, with ` *F*` for foil and ` *E*` for etched foil |
| **Markdown for AI** (`.md`) | Title, batch metadata, totals (cards, unique), a table `Qty \| Name \| Set \| # \| Finish \| Lang`, then a fenced plain-list block ready to paste. Optional columns: type line, color identity, mana value (from the index; makes AI deck help much better) |
| **Moxfield collection CSV** | Verify column headers against a real Moxfield export before shipping |
| **ManaBox CSV**, **Deckbox CSV**, **Archidekt collection CSV** | Same: verify each against a real export/import before marking done |
| **Archidekt deck list** (`.txt`) | `1x Sol Ring (cmm) 410 *F*`, Archidekt's own deck text export: lowercase set, full `A // B` names, `*E*` for etched. Archidekt's deck importer takes only pasted text or a `.txt` upload, never a CSV. The CSV goes to its separate collection importer |

Export formatters are pure functions with snapshot tests.

**Verification status.** Column names and value spellings are tested against real exports in `tests/fixtures/formats/` (see its README). Nobody has yet imported Manifest's own files into these sites, because that needs logged-in accounts. Treat a format as done only once its box is ticked:

| Format | Matches real export | Imported into the site |
|---|---|---|
| Moxfield collection CSV | ✅ | ☐ |
| Detailed list into Moxfield | ✅ `*F*`/`*E*` markers. Front-face names for DFCs are unconfirmed: a real export wrote one flip card as `A / B` | ☐ |
| ManaBox CSV | ✅ the 18-column form seen in 2026 | ☐ |
| Deckbox CSV | ✅ the base 19 columns | ☐ |
| Archidekt collection CSV | ✅ | ☐ For Collection → Import only, with the columns set by hand (no preset for its own layout). The deck importer rejects it, which the first real test confirmed (2026-11-09) |
| Archidekt deck list | ✅ Archidekt's own deck text export | ✅ In Archidekt's sandbox importer (no login), 11 cards were all found: foil, etched, double-faced, split, adventure, token, The List. Archidekt's export of the result matched Manifest's lines exactly (2026-11-09) |

Known limits, all noted in the export UI: Deckbox has no etched finish, and its strict importer may reject some set names (token sets use Deckbox-only codes). Grouping a CSV by name leaves printing columns empty, and these sites' handling of that is unconfirmed.

## Data sources & rules

**MTG: Scryfall**
- Use **bulk data** (`/bulk-data`) for indexes, never per-card API calls at scale. The listing now offers gzipped JSONL (`jsonl_download_uri`). The index uses `default_cards` (English, or the printed language when there is no English) and leaves out `digital` cards, which can't be scanned. Non-English printings will need `all_cards` (M3). Send a descriptive `User-Agent` and `Accept` header. Respect the documented rate limits (50–100 ms between API calls; `/cards/*` search-style endpoints are capped lower). Never ignore HTTP 429.
- Scryfall requires that software adds value and doesn't just repackage their data. Show "Card data © Scryfall" attribution in the app.
- Card images for building hashes come from Scryfall's image CDN, downloaded by CI **incrementally** (cache by Scryfall ID; only fetch new or changed cards). **Never commit raw images to git.**
- At runtime, thumbnails may be loaded from Scryfall image URLs for the review UI.

**Pokémon: pokemontcg.io (or TCGdex for non-English)**
- A free API key raises the limit to 20,000 requests/day. The key lives only in GitHub Actions secrets and is **never shipped to the client**.

**Yu-Gi-Oh!: YGOPRODeck**
- The rate limit is 20 requests/second, and going over it means a **1-hour block**. Images must be downloaded and re-hosted, not hotlinked. Build indexes offline only.

**Game adapter interface:** each game implements `buildIndex()`, `nameDictionary`, `regions` (title box, collector box, art box in canonical coordinates), `parseCollectorLine()`, and `formatExportLine()`. MTG ships first. Don't let MTG-specific assumptions leak into shared code.

The adapter is split in two. `buildIndex()` is in `scripts/games/`, because it needs Node and must stay out of the client bundle. The rest is in `app/src/games/adapter.ts`, and the generic index client serves `nameDictionary` for every game. `regions` joined the client interface in M2 (`CardRegions`: canonical `size`, printed `border` width as a share of card width, a `title` search band with line height and expected centre, and `collector` and `art` boxes). `parseCollectorLine()` joins in M3.

**Legal:** footer notice that this is unofficial fan content and not affiliated with Wizards of the Coast, The Pokémon Company, or Konami, plus data-source attributions.

## Index artifacts (generated by `scripts/`, published with the site)

- `names.<game>.json`: unique card names, each DFC face mapped to its full name (`faces`), and names printed on a card in place of its own mapped to it (`aliases`: Scryfall `flavor_name` and `printed_name`, e.g. Universes Beyond and Godzilla-series cards, renamed Secret Lairs, and non-English printings that have no English one). Manual search and OCR both use all three.
- `printings.<game>.<shard>.json`: id, name, set, collector number, finishes, language, image URL, and the minimal fields needed for exports.
- `hashes.<game>.<shard>.bin`: compact binary perceptual hashes keyed to printing ids.
- `manifest.json`: versions, shard list, byte sizes, build date. The app checks it and downloads only changed shards.
- Sharding keeps each file ≤ 20 MB, and the build fails rather than exceed it. Lazy-load and cache.
- Printings are sharded by a hash of the card name (`games/shard.ts`), so choosing a name downloads one shard of about 0.7 MB, or about 0.1 MB gzipped. Changing the hash needs a manifest schema bump.
- Builds are deterministic. File names stay the same, and the app requests `?v=<sha256>` from the manifest, so unchanged shards stay cached.
- `build-index.yml` publishes the index as a workflow artifact each night and then starts `deploy.yml`, which downloads it. If there is no artifact, the deploy builds the index itself. A deploy can't go out without card data.

## Accuracy, testing, and the eval harness (non-negotiable)

- `tests/fixtures/real-scans/` holds labeled real photos supplied by the owner. Labels live in `labels.json` (filename → game, Scryfall/printing id, foil, and sleeved/lighting notes); the format is in that folder's README.
- Until there are real scans, the eval also runs a **synthetic set**: 320 printings sampled (stratified, deterministic) from the bulk file, their Scryfall `normal` images composited onto procedural backgrounds with perspective, rotation (incl. upside-down and sideways), lighting, glare, sleeve sheen, blur, noise and JPEG compression (`tests/eval/synthesize.ts`). Images are cached in `.cache/eval/`, never committed. Synthetic numbers are optimistic (the source images are the index's own scans); real scans decide.
- `npm run eval` runs the full pipeline on the fixtures and reports:
  - top-1 **name** accuracy, top-1 **printing** accuracy, and top-5 accuracy
  - auto-accept precision (how often an auto-accepted card is wrong; this must be very low)
  - review-queue rate and median/95th-percentile latency per card
  - an **HTML failure gallery** (crop, expected, predicted, signal scores)
- Results are broken down by hard-case tag (foil, sleeved, DFC, basic land, non-English, old frame).
- **Any change to recognition code must include before/after eval numbers in the commit or PR description.** Don't claim an accuracy improvement without them.
- Goals (well-lit, unsleeved, English, modern MTG): ≥ 98% top-1 name, ≥ 95% top-1 printing, ≤ 0.5% wrong auto-accepts, < 500 ms/card on a mid-range phone.

## Milestones

- **M0: Skeleton.** Vite/React/TS app, PWA shell, camera permission + live preview, deployed to Pages by CI.
- **M1: MTG data + output end to end.** Scryfall bulk → name dictionary + printings shards. Manual search adds cards to a batch, and every export format works. (Proves the output side before any CV.)
- **M2: Single-card recognition.** Detect, rectify, quality gate, title OCR → fuzzy name. Eval harness running.
- **M3: Exact printing.** Collector-line OCR + perceptual hash index + fusion + top-5 candidates.
- **M4: Mass scanning.** Continuous live mode with dedupe, audio/haptics, review queue, batches, JSON backup.
- **M5: Bulk import + multi-card photos.** Worker queue, 1,000+ images, binder-page detection.
- **M6: Hardening.** Offline mode, incremental index updates, threshold tuning from eval, accessibility, low-end device performance.
- **M7: Pokémon adapter.** **M8: Yu-Gi-Oh! adapter.**

## Status

- **M0, M1: done.** Verified again at the start of M2: build, unit and e2e tests, real index build, manual search → batch → every export format.
- **M2: done (2026-11-09).** Single-card recognition works from the Scan tab: live camera (auto-reads a card once it has been steady for 3 frames, and not again until it leaves) and single photos.
  - **Pipeline** (`app/src/recognize/pipeline.ts`, the same code in the worker and the eval): detect (`vision/detect.ts`) → rectify to 488×680 (`vision/rectify.ts`) → quality gate (`vision/quality.ts`: card size, in frame, Laplacian sharpness of the title band, glare share, brightness, each with a hint) → find the title line inside a search band and binarize it (`recognize/titleCrop.ts`) → Tesseract (single-line mode, title character whitelist, dictionaries off) → OCR-tolerant name match (`recognize/titleMatch.ts`: semi-global alignment where junk around the name costs 0.3/char and spaces 0.3; short readings also checked against every name of similar length; confidence = similarity × lead over the best *differently-spelt* name; names ≤ 3 letters capped below auto-accept). Poor readings retry with two other renderings (contrast-stretched grey, strict threshold), then upside down, then the next detected quad; a fallback only wins with confidence ≥ 0.5.
  - **Decide:** auto-accept at confidence ≥ 0.9 and quality OK, else review (top 5 names shown). In M2 the UI always lets the user confirm and pick the printing; M4 adds true auto-add. Live mode never reads a frame that fails the gate; photos are read anyway but never auto-accepted.
  - **Eval (synthetic set, fast model, 2026-11-09):** all 320: detected 99.4%, located correctly 79.4%, top-1 name 80.3%, top-5 80.6%, auto-accepted 59.1%, wrong auto-accepts 0 (100% precision), p50/p95 115/297 ms in Node on an M-series Mac. Goal subset (modern frame, clean): top-1 98.9%, auto-accepted 78.0%, 0 wrong. By tag (top-1): frame-2003 96.7%, dfc 90%, sleeved 81.8%, upside-down 80%, glare 78.6%, showcase 73.3%, dark-background 72.2%, token 70%, low-light 69.6%, basic-land 53.3%, old-frame 53.3%, non-English 46.7%, blur 25.9%. Threshold sweep: 0 wrong at ≥ 0.9, 1 wrong at 0.8–0.85, 4 at ≤ 0.75, so **keep auto-accept at 0.9**. No real scans yet: **these numbers are not the product's accuracy until the owner's photos confirm them.** Printing accuracy is M3.
  - **OCR model choice:** the standard `4.0.0_best_int` model (2.95 MB gzipped) scored the same on the eval (top-1 79.7%, top-5 81.3%, 0 wrong at 0.9, 1 wrong at ≤ 0.85) and was slower (p50/p95 127/391 ms), so M2 ships the fast one (1.97 MB). It isn't on npm, hence the vendored copy. To compare models: `npm run eval -- --ocr-model <dir with eng.traineddata.gz>`.
  - **Known gaps for M3 and later:** (1) black border on a dark mat: detection usually stops at the frame line, and the dark-border expansion only fixes ~1 in 5 (located 18.5%); title OCR copes via its search band, but the collector line and art hash in M3 need the real edge or their own search bands. (2) Sleeves: detection lands on the sleeve edge (located 63.6%); same caveat. (3) Old frames (white shadowed text on textured bars) and blur are the weakest OCR cases. (4) Non-English cards only match through `printed_name` aliases, and only Latin-script ones with English OCR; `all_cards` is M3. (5) Split, flip and battle cards whose title isn't across the top aren't handled. (6) Latency is Node-on-desktop; nobody has profiled a mid-range phone yet. (7) The live path is covered by unit tests and a no-card e2e only: Chromium's fake camera can't show a card.
  - **Dependencies added:** `tesseract.js` for the client: the engine plus the vendored fast English model, about 3 MB gzipped in all (1.06 MB WASM core, 1.97 MB model, 0.07 MB JS). That's over the 1 MB guideline because the engine alone is 1.06 MB gzipped and title OCR is the core of M2; it loads only when the scanner starts, is self-hosted and is cached for offline use. Approved by the owner on 2026-11-09, as was the switch to the fast model. `jpeg-js` + `pngjs` are dev-only, for the eval.

## Working agreements for Claude Code

- Work milestone by milestone. At the start of each milestone, post a short plan; at the end, summarize what works, what doesn't, and the eval numbers.
- Keep the main thread free: CV/OCR/ML only in workers. Profile on a throttled mobile CPU in DevTools.
- Ask before adding any client dependency larger than ~1 MB gzipped, or any paid or keyed service.
- No secrets in the client bundle. No card images in git.
- Prefer small, pure, tested functions in `recognize/` and `export/`.
- When unsure about an external format (CSV headers, import syntax), find or ask for a real sample instead of guessing, and put it in `tests/fixtures/formats/`.
- Update this file when an architectural decision changes.
