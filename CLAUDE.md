# Manifest — free, browser-based TCG card scanner

> Working name: **Manifest** (an MTG keyword *and* the word for a list of what's in a shipment).
> Tagline: *Scan a stack, get a list.*

## Commands

Node comes from `.nvmrc`. One package at the repo root; Vite's root is `app/`.

| Command | What it does |
|---|---|
| `npm run dev` | Dev server |
| `npm run check` | Typecheck, unit tests, production build |
| `npm run e2e` | Playwright against a production build, with a fake camera and a 25-card index. `live.spec.ts` feeds the fake camera a generated video of fake cards (`--use-file-for-fake-video-capture`, written to `.cache/e2e-live/`) to test live scanning end to end |
| `npm run index:build` | Downloads Scryfall bulk data and writes the index to `data/`. Add `-- --source file.jsonl --out dir` to use a local file. Fingerprints need every card's `small` image: they are cached in `.cache/fingerprints/` with each image's version, so only new or changed cards are downloaded (the first build fetches ~110k images, about 1.5 hours at 20/s). `--fingerprints cache-only` never downloads (it still uses images in `--images dir`), `--fingerprints none` leaves them out (the e2e build does), `--images dir` keeps the downloaded images |
| `npm run eval` | Recognition eval on the owner's real scans and a synthetic set (needs `index:build` first; the first run downloads ~320 Scryfall images to `.cache/eval/`). Report in `.cache/eval/report/index.html`. Flags: `--only real\|synthetic`, `--tag dfc`, `--limit 50`, `--regenerate`, `--names-only` (stop at the name, as M2 did: the baseline for printing work), `--set hires` (the 150 modern cards rendered from Scryfall's `large` scans at twice the resolution, closer to a full-size phone photo; downloads 150 more images), `--set phone` (152 cards, each rendered plain, viewed 30–55° off straight-on, and in dim light, at live-camera size: how people actually hold a phone; includes the Star Trek planets, borderless foil and tokens from the owner's first phone test), `--set phone-1080` (the same scenes at 1920×1080), `--set phone-flash` (the same 152 cards once each with a flashlight hotspot on the art, in a red deck box, soft close-up focus: the owner's M4 setup), `--set phone-redbox` (the same cards in a red box whose light tints them red, 60% with a flashlight hotspot), `--detect-size 480` (detect on a smaller copy than 640), `--lock true-set` (each card scanned into a batch locked to its own set) and `--lock other-set` (to a set it isn't from: nothing may be auto-accepted) |

`npx tsx tests/eval/testlog-to-fixtures.ts <log.json>` turns a phone's test log into real-scan fixtures (`--dry-run`, `--out dir`; see `tests/eval/TESTLOG.md`).

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
| Card detection / warp | Plain TypeScript in `vision/` (Canny at several thresholds → edge components → hull → line-fitted corners → homography). **Changed in M2:** OpenCV.js is ~3.75 MB gzipped for the half-dozen operations needed, and pure functions are easier to test and run unchanged in the Node eval. Revisit only if the eval shows detection needs it. **M3:** outlines tilted 15–70° are judged with the perspective taken out (`vision/perspective.ts`: true shape and tilt from the four corners and a phone camera's field of view), so a phone held at a steep angle still finds the card |
| OCR | Tesseract.js 7 (LSTM) with Tesseract's **fast** English model, vendored in `vendor/tessdata_fast/` (Apache-2.0; source commit in its README), on **tightly cropped, binarized** regions only (title line, collector line), behind `recognize/ocr.ts`'s `OcrEngine` so it can be swapped for PaddleOCR/ONNX later. Self-hosted under `ocr/<versions>-<model>/` (never a CDN), about 3 MB gzipped, fetched the first time the scanner opens and cached for offline use |
| Visual fingerprint | Two 64-bit DCT pHashes per printing, of the art box and of the whole card, at the scale of Scryfall's `small` images (`recognize/fingerprint.ts`; the index builder runs the same code). **M3:** no embeddings yet; MobileCLIP-S0 re-ranking stays optional, for when the eval shows hashes aren't enough |
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
- Use **bulk data** (`/bulk-data`) for indexes, never per-card API calls at scale. The listing now offers gzipped JSONL (`jsonl_download_uri`). The index uses `default_cards` (English, or the printed language when there is no English) and leaves out `digital` cards, which can't be scanned. Non-English printings will need `all_cards`: not done in M3 (the collector line's language code is parsed, but not yet used). Send a descriptive `User-Agent` and `Accept` header. Respect the documented rate limits (50–100 ms between API calls; `/cards/*` search-style endpoints are capped lower). Never ignore HTTP 429.
- Scryfall requires that software adds value and doesn't just repackage their data. Show "Card data © Scryfall" attribution in the app.
- Card images for building hashes come from Scryfall's image CDN, downloaded by CI **incrementally** (cache by Scryfall ID; only fetch new or changed cards). **Never commit raw images to git.** Implemented in M3: `scripts/fingerprints.ts` fetches `small` images through `scripts/politeFetch.ts` (requests start ≥ 50 ms apart, 6 in flight, 429/5xx pause everything and honour Retry-After). `build-index.yml` keeps `.cache/fingerprints` in the Actions cache; the deploy's fallback build uses that cache without downloading.
- At runtime, thumbnails may be loaded from Scryfall image URLs for the review UI.

**Pokémon: pokemontcg.io (or TCGdex for non-English)**
- A free API key raises the limit to 20,000 requests/day. The key lives only in GitHub Actions secrets and is **never shipped to the client**.

**Yu-Gi-Oh!: YGOPRODeck**
- The rate limit is 20 requests/second, and going over it means a **1-hour block**. Images must be downloaded and re-hosted, not hotlinked. Build indexes offline only.

**Game adapter interface:** each game implements `buildIndex()`, `nameDictionary`, `regions` (title box, collector box, art box in canonical coordinates), `parseCollectorLine()`, and `formatExportLine()`. MTG ships first. Don't let MTG-specific assumptions leak into shared code.

The adapter is split in two. `buildIndex()` is in `scripts/games/`, because it needs Node and must stay out of the client bundle. The rest is in `app/src/games/adapter.ts`, and the generic index client serves `nameDictionary` for every game. `regions` joined the client interface in M2 (`CardRegions`: canonical `size`, printed `border` width as a share of card width, a `title` search band with line height and expected centre, and `collector` and `art` boxes). M3 added `parseCollectorLine(lines)` (OCR text of the collector line's rows → `CollectorReading`: numbers, set codes, language, set size, and whether the numbers are only loose guesses), `matchCollector(reading, printing)` (how a reading fits a printing, knowing how promos and The List print another set's code), `printingPrior(printing)` (a small tie-breaker against promos and List reprints), a `collector` search band (`CollectorRegion`: box, line height, max lines), and `outlines` (where a detected outline may really lie on the card: the frame line on a dark mat, a sleeve's edge). M4 added `defaultFinish(printing, foil)` (the finish a scanned card is added with) and `isFoil(finish)`. Recognition reads printings through the game-generic `games/catalog.ts` (`Catalog` over an `IndexSource`: fetch + Cache Storage in the worker, files on disk in the eval).

**Legal:** footer notice that this is unofficial fan content and not affiliated with Wizards of the Coast, The Pokémon Company, or Konami, plus data-source attributions.

## Index artifacts (generated by `scripts/`, published with the site)

- `names.<game>.json`: unique card names, each DFC face mapped to its full name (`faces`), and names printed on a card in place of its own mapped to it (`aliases`: Scryfall `flavor_name` and `printed_name`, e.g. Universes Beyond and Godzilla-series cards, renamed Secret Lairs, and non-English printings that have no English one). Manual search and OCR both use all three.
- `printings.<game>.<shard>.json`: id, name, set, collector number, finishes, language, image URL, and the minimal fields needed for exports.
- `hashes.<game>.<shard>.bin`: one 16-byte fingerprint per printing, **row for row in the order of the printings shard of the same number**, so no ids are stored (`games/hashShard.ts`). A 20-byte header holds the fingerprint version and the first 8 bytes of that printings shard's sha256, so a mismatched pair is ignored rather than misread. A row of zeros is a printing without an image. About 1.8 MB for all of MTG; a name lookup needs one ~27 KB shard, a title-less search all of them (loaded in the background when the scanner starts). The manifest's `fingerprint` field names the algorithm version; an app with another version ignores the hashes and recognizes by text alone.
- `collectors.<game>.json`: set code → printed collector number (digits, no leading zeros) → index into `names`, for cards from 2014-07 on (older cards print no set code). About 0.84 MB, 0.32 MB gzipped. Lets a collector line name a card on its own.
- `sets.<game>.json` (M4): every set's code, name, earliest release date and printing count, newest first (`games/sets.ts`), for locking a batch to sets by name. About 88 KB, 14 KB gzipped. An index without it makes the app ask for typed set codes.
- `manifest.json`: versions, shard list, byte sizes, build date. The app checks it and downloads only changed shards.
- Sharding keeps each file ≤ 20 MB, and the build fails rather than exceed it. Lazy-load and cache.
- Printings are sharded by a hash of the card name (`games/shard.ts`), so choosing a name downloads one shard of about 0.7 MB, or about 0.1 MB gzipped. Changing the hash needs a manifest schema bump.
- Builds are deterministic. File names stay the same, and the app requests `?v=<sha256>` from the manifest, so unchanged shards stay cached.
- `build-index.yml` publishes the index as a workflow artifact each night and then starts `deploy.yml`, which downloads it. If there is no artifact, the deploy builds the index itself. A deploy can't go out without card data.

## Accuracy, testing, and the eval harness (non-negotiable)

- `tests/fixtures/real-scans/` holds labeled real photos supplied by the owner. Labels live in `labels.json` (filename → game, Scryfall/printing id, foil, and sleeved/lighting notes); the format is in that folder's README. A phone test's log (see Status → M4 → Test log) adds the scans the owner corrected there as padded card crops, tagged `testlog` and `cropped`: they test recognition, not detection.
- Until there are real scans, the eval also runs a **synthetic set**: 320 printings sampled (stratified, deterministic) from the bulk file, their Scryfall `normal` images composited onto procedural backgrounds with perspective, rotation (incl. upside-down and sideways), lighting, glare, sleeve sheen, blur, noise and JPEG compression (`tests/eval/synthesize.ts`). Images are cached in `.cache/eval/`, never committed. Synthetic numbers are optimistic (the source images are the index's own scans); real scans decide. The `phone` set (`--set phone`) re-renders a subset with a real 3D tilt (pinhole camera, phone field of view), dim light (dark, or brightened and noisy as a phone camera does it) and foil sheen.
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
- **M3: done (2026-11-09).** Exact printing from photos and the live camera: the Scan tab shows the best printing with its reasons ("collector number and set match, artwork matches") and up to four more, each with Add buttons; every printing of any candidate name is one tap away.
  - **Pipeline** (`recognize/identify.ts`, after M2's title stage, same code in the worker and the eval): (1) fingerprint the card from the frame under three registration guesses: the detected outline, the frame line on a dark mat, a sleeve's edge (`regions.outlines`, measured on the eval), turned over too when the title couldn't say which way up; (2) load the printings of the title's names (only the top one when the title is ≥ 0.9 sure) with their fingerprints; (3) when the title is unsure or no printing's art matches, search all ~111k fingerprints (~14 ms) and add the nearest names; (4) warp the collector band straight from the frame at 4× (`recognize/collectorCrop.ts`), find the bottom two text lines, binarize, blank everything after the first wide gap, OCR with a collector character set, re-read a number line digits-only if no number came out, parse (`games/mtg/collector.ts`); (5) look set + number up in `collectors.mtg.json` to name a card on its own; (6) score every printing: 2 × title similarity + 1.5 × hash evidence (sigmoid of distance, about 1 for ≤ 12 of 128 bits, -0.3 for clearly different art) + 1.2 × collector match (+1 number, +0.6 set, negative when contradicted; loose digit guesses count half) + a -0.1 prior for promos and The List. A collector match gets no credit for a printing whose art clearly contradicts it when another printing's art matches.
  - **Confidence and decision:** confidence = name confidence × printing confidence. Name: title confidence, collector set + number (0.9, only when that printing's art doesn't contradict it), unambiguous art match (0.85), combined as independent. Printing: softmax among the name's printings over hash distance and collector evidence, so look-alike printings split the share and only the collector line can settle them. Auto-accept stays at **0.9** and is now judged on the **exact printing**; the sweep shows 0 wrong down to 0.8 and 3 wrong at 0.75. `Recognition`/`ScanResult` carry `names`, `printings` (per-signal scores), `nameConfidence`, `confidence`, `collector`.
  - **Eval (2026-11-09, full fingerprint index, fast OCR model, Node on an M-series Mac).** Standard synthetic set, all 320: top-1 name **91.9%** (M2 80.3%), top-5 name 92.8%, top-1 printing **74.1%**, top-1 printing or its promo/List twin 86.3%, top-5 printing 91.3%, auto-accepted 38.8% with **0 wrong** (exact printing), p50/p95 205/420 ms. Goal subset (modern, clean, 91): name 98.9%, printing 72.5%, printing-or-twin 93.4%, top-5 printing 96.7%, auto-accepted 44.0%, 0 wrong. Name confidence ≥ 0.9 on 71.9% of cards with 0 wrong names (M2 auto-accepted 59.1% on the name). High-resolution set (`--set hires`: the 150 modern cards from `large` scans at 2×): name 95.3%, printing 74.7%, printing-or-twin 90.7%, top-5 printing 94.7%, auto-accepted 42.7%, 0 wrong. By tag, standard set, top-1 printing: token 100%, frame-2003 86.7%, dfc 85%, clean 77.3%, old-frame 73.3%, showcase 73.3%, modern 72%, upside-down 71.4%, other-layout 70%, sleeved 67.3%, basic-land 66.7%, glare 66.7%, dark-background 63%, low-light 60.9%, blur 55.6%, non-English 53.3%. Collector line, standard / hires: number read right 44% / 61%, set right 32% / 54% (+13% look-alike), both 20% / 41%. Latency by stage (p50/p95 ms): detect 59/88, title OCR 31/208, fingerprints 5/9, global search 14/23 (half the cards), collector 50/147. `--names-only` reproduces M2's numbers exactly, as the baseline. **Synthetic numbers again: real scans decide.** The art hash is optimistic here (the photos are rendered from the index's own scans) and the collector line pessimistic (its text is resampled from 7-pixel originals).
  - **Where printing errors come from** (high-res set, 39 errors in 150): 26 are promo/List twins (`ltr` 166 vs `pltr` 166s, `war` 137 vs `plst` WAR-137: same art and collector text, told apart only by a prerelease stamp, a foil ★ that OCR can't separate from •, or The List's symbol), 8 wrong names, 7 other printings. Twins are kept out of auto-accept and shown side by side. The synthetic set samples printings uniformly, so promos are far commoner in it than in a real collection.
  - **Known gaps for M4 and later:** (1) twins, above; detecting the stamp or the ★ would need its own detector. (2) Same-art reprints in different sets need the collector line, which reads on well under half of standard-set cards; whether real photos do better is the first thing to check once the owner's scans exist. (3) Cards detected wrongly (art box or text box taken for the card: 9 of 318 detections, ~3%) have no usable fingerprint; when the title doesn't read either, the other outline is now identified too (see the phone-test fixes). (4) Pre-2003 cards have no collector number, so printing rests on the art (and the card hash's border colour). (5) Non-English: the collector line's language is parsed but unused; `all_cards` isn't indexed. (6) Live mode still uses 1280×720 frames by default; `?camera=1080` (remembered) switches to 1080p for phone tests, which helps the collector line at some cost per frame. (7) Latency is Node on desktop; the collector line roughly doubled per-card time. (8) Loading the full fingerprint table (1.8 MB) starts when the scanner opens; a title-less card scanned before it arrives waits for it.
  - **Data:** the scanner now downloads `collectors.mtg.json` (0.32 MB gzipped) at start and the 64 hash shards (1.8 MB, incompressible) in the background, all cached for offline use like the other index files. No new client dependencies. The first CI index build downloads ~110k images (about 1.5 hours); later ones only new or changed cards.
  - **Phone-test fixes (2026-11-10).** The owner's first iPhone test (live site, M2 code) passed unsleeved, upside-down, sleeved, foil, a brown table and a basic land in good light, and said "no card" to a photo of feet. It failed in dim light, on a token, on Star Trek planet cards (translucent title bar over busy art) and on the borderless foil Dominion Saboteur (`trk` 345); tilting the phone back made OCR fail; live mode sat on "Reading…" forever on cards it couldn't read; it felt a little slow. Fixed in PR #2:
    - **Steep tilt:** detection judged an outline's width:height against 63:88 as it appeared, so beyond ~40° a card was rejected (and at 30–35° outscored by its own art box). Outlines tilted 15–70° are now judged with the perspective taken out (`vision/perspective.ts`, Zhang & He); below 15° the outline is used as before, so flat cards detect exactly as they did. Detections carry `tilt`; the quality gate advises "Hold the phone flatter" above 35° (advice, not a refusal), and live mode shows it in place of "blurry", which a stretched far edge otherwise triggers.
    - **Title from the frame:** when the photo holds ≥ 1.25× the rectified card's detail along the title band (full-size photos, 1080p), the title is warped straight from the frame, as the collector line already was.
    - **Outline fallback:** when the chosen outline's name confidence is < 0.5, the other outline that was read is identified too and the more confident result kept (a card-shaped patch of background around the card, with an unreadable title, read as "Couldn't read" before even though the art matched).
    - **Artwork veto:** when every printing of the top name has artwork > 48 of 128 bits away (unrelated cards average ~64; true matches under glare stay ≤ 36), name and printing confidence are capped at 0.5. Found on `phone-1080`: OCR read a real name ("Penance") out of a tilted Forest's texture and auto-accepted it.
    - **Live mode:** `LiveSession` reports a phase (`empty`, `settling`, `reading`, `read`); a read that throws or finds nothing is retried on the next steady frames and given up after 3, with "Couldn't read this card", a hint from the quality gate's advice, Try again and Search by name. A card already read says "Take it away to scan the next one" with a Read again button, instead of "Reading…". Results below 0.5 name confidence say "Couldn't read this card" and show the guesses (the right name is among them about 1 time in 4).
    - **Dim light:** `too-dark` (mean luma < 35) did fire on genuinely dark frames (38 of 51 dark scenes), but phones brighten dim scenes into grainy, normal-looking frames that passed. The gate now measures noise (Immerkær) and advises more light when luma < 70, or noise > 1.8 with luma < 90 (61% of brightened-dim scenes, 11% of normal ones; shown only as a hint).
    - **Flashlight:** a Flashlight button in live mode wherever the track reports `torch` (Chrome on Android; Safari on iOS 17.4+). iOS 18's `getSettings()` reports the torch off while it is on (WebKit bug 280970), so the button shows the state asked for.
    - **Debug readout:** `?debug=1` (remembered; `?debug=0` clears it) shows per-frame `capture · pixels · detect · total · wall` ms, fps, tilt, light, noise and sharpness in live mode, and per-stage timings and confidences under each result.
    - **Eval, before → after** (0 wrong auto-accepts in every set at 0.9; the sweep shows 1 wrong at 0.8–0.85 on `phone`, so the threshold stays). `phone` (456 photos): name 72.6% → 85.1%, printing 59.6% → 71.3%, top-5 printing 71.5% → 83.8%, auto-accepted 30.0% → 36.2%. By scene, name: plain 94.1% → 93.4%, tilt 30–42° 78.7% → 80.0%, **tilt 42–55° 5.2% → 79.2%** (detected 42.9% → 88.3%), dim 82.2% → 82.2%. By kind, name: Star Trek 72.1% → 86.5%, planets 73.3% → 86.7%, tokens 67.8% → 84.4%, foil 55.6% → 74.1%. `phone-1080`: name 73.2% → 85.7%, printing 61.4% → 72.4%. Standard: name 91.9% → 92.2%, printing 74.1% → 74.4%, auto-accepted 38.8% → 39.1%, goal subset unchanged. Hires: name 95.3% → 96.7%, printing 74.7% → 75.3%. Latency p50/p95 (Node, M-series Mac): standard 209/427 → 213/474 ms, phone 194/432 → 194/426 ms.
    - **Still failing on the phone set:** dark-bordered tokens on dark mats (not detected, as in M2), very dark frames, and the borderless Saboteur on a busy patterned background (its art runs to the edge, so the card's outline merges with the background; it reads on a plain one). 1080p frames from the phone set are upscaled from 488-pixel scans, so they understate a real 1080p camera; `--set hires` (collector number read 44% → 61% at 2×) is the better guide. Which token the owner tried is unknown.
  - **Follow-up fixes (2026-11-11, PR #3).** PR #2 was merged and the index rebuilt with fingerprints. The owner's second iPhone test passed: several Star Trek cards and a planet, a basic land (right art), the borderless foil Dominion Saboteur, on a plain background too, a sleeved card, a promo (right code), tokens, and the flashlight. Four fixes followed:
    - **Borderless card among other cards:** The Holodeck (TRK 346, art to the edge), photographed with other cards touching it, gave "No card found" (`tests/fixtures/real-scans/holodeck-trk-346-on-table.jpg`, labelled in `labels.json`; the photo is gitignored). Photos (`centerFallback`, also on in the eval) now look for the card the photo is centred on when no outline is found, or the one found yields a name confidence < 0.5:
      - `vision/centerCard.ts` makes card-sized rectangles from the long edges either side of the middle, allowing for a slightly off-straight view.
      - `identify.nearestArt` ranks them by the closest fingerprint in the whole index, all sampled from one canvas of the frame in one pass (~115 ms for 48 in Node). The best one is refined once over the found edges.
      - The guess is kept only at name confidence ≥ 0.5, never auto-accepted, and noted in the result ("The card's edges weren't clear…").
      - "No card found" now explains what to change.
    - **Stacked cards in live mode:** the session counted a new card only after the frame emptied, which stacking never does.
      - `LiveSession` now keeps the read card's fingerprint and outline. A steady card whose fingerprint differs by > 24 of 128 bits is a new card.
      - An identical copy counts once "Scan next card" has armed the session (`arm()`) and the view was disturbed since (the card left view, or its outline moved > 10% of its diagonal). So two copies count as two, and a card left lying, or nudged, counts once.
      - A copy put down exactly in place while the result panel was open (no frames processed) is not noticed. A different card is.
    - **Updates:** the service worker moved from `autoUpdate` to `prompt`.
      - `ui/updates.ts` checks for a new version when the app comes back into view (`visibilitychange`, `pageshow`: iOS resumes home-screen apps without reloading) and hourly. `ui/UpdateBanner.tsx` offers Reload and never reloads on its own.
      - Batches are written to IndexedDB as they change, so reloading loses only an unsaved scan result on screen.
      - Installs from before this need one full close (swipe the app away) to pick it up.
    - **Timings inside the app:** a "Testing" section at the bottom of the Scan tab switches "Show timings" and "Sharper camera (1080p)", the same remembered settings as `?debug=1` and `?camera=1080` (iOS home-screen apps share neither Safari's storage nor its address bar).
    - **Eval, before → after** (0 wrong auto-accepts in every set; sweeps unchanged, so 0.9 stays):
      - **Holodeck photo:** "Quag Feast" at 0.18 → The Holodeck TRK 346 at 0.96 (review).
      - **`phone`:** name 85.1% → 87.7%, printing 71.3% → 72.6%, top-5 printing 83.8% → 86.2%, auto-accepted 36.2% → 36.2%. By scene, name: plain 93.4% → 96.1%, dim 82.2% → 86.8%, tilt 42–55° 79.2% → 79.2%; special treatments 68.9% → 76.7%, Star Trek 86.5% → 88.3%.
      - **`phone-1080`:** name 85.7% → 87.9%, printing 72.4% → 73.5%.
      - **Standard and hires:** unchanged (name 92.2% / 96.7%, printing 74.4% / 75.3%).
      - **Latency:** the fallback costs a few hundred ms on the cards it runs for. p50/p95: phone 194/426 → 215/556 ms, standard 213/474 → 206/491 ms.
    - **Dropped:** a tighter check on perspective-corrected shapes (within 12% of 63:88) lost a sixth of the steep-tilt detections, and the centre search is what fixed the Holodeck.

- **M4: built (2026-11-12, PR #5, not yet merged or phone-tested).** Continuous mass scanning: the camera keeps watching, confident cards go straight into the batch and the rest wait in a review queue.
  - **Intake** (`session/intake.ts`, used by live mode and photos): a read with exact-printing confidence ≥ 0.9, quality OK, and a printing in the batch's locked sets is added at once, with the finish the batch asks for (`GameAdapter.defaultFinish`: nonfoil, or foil/etched when "All foil" is on or the printing only comes that way). Everything else, unreadable cards included, goes to the review queue (`reviews` table, Dexie v2) with its crop (JPEG bytes), candidates, reason and the batch settings at scan time. Nothing is dropped.
  - **Live mode** (`capture/Scanner.tsx`): no result screen. A big counter (cards in the batch + waiting for review), the last 5 cards as thumbnails with one-tap Undo (`capture/recentScans.ts`, in memory), a green or amber flash over the camera, "Wrong? Read this card again", and a screen wake lock while the camera runs (`capture/useWakeLock.ts`).
  - **Counting copies** (`recognize/liveSession.ts`): a different card (fingerprint > 24 of 128 bits away) counts as soon as it is steady. An identical copy counts once the card was gone or moved > 10% of its diagonal for ≥ 2 frames in a row (`DISTURBED_FRAMES`) and then settles. A card that leaves for ≥ 3 frames is forgotten. A card left lying, nudged, or missed by detection for one frame counts once. The PR #3 "Scan next card" arm is gone, along with its gap (a copy put down while the result screen was open).
  - **Sound and haptics** (`ui/feedback.ts`): one high beep when added, two lower notes for review. Web Audio, unlocked by the Start camera tap or any tap on the scanner (a touch counts on pointerup, not pointerdown). iOS: no `navigator.vibrate`, and the switch-checkbox haptic trick needs a real tap since WebKit bug 285120 (Jan 2025), so an iPhone gets sound and the flash only; Android also vibrates. The silent switch mutes Web Audio unless "Sound: on, even in silent mode" sets `navigator.audioSession.type = 'playback'` (pauses music).
  - **Batch settings on the Scan tab** (`capture/ScanSettings.tsx`): Sets (lock), All foil, Language, Condition. New index file `sets.<game>.json` (every set's code, name, date, printing count; 88 KB, 14 KB gzipped) for choosing sets by name; an index without it falls back to typed codes.
  - **Set lock in recognition** (`identify.ts`, `lockSets` on `PrintingSources`): a name's printings outside the locked sets are dropped when it has one inside them; a name with none is ranked 0.3 lower and flagged `outsideLock` (never auto-accepted, reviewed with "This card isn't from the locked sets"). Within the locked sets, a collector number alone names the card when the set code didn't read. Off by default.
  - **Review tab** (`review/ReviewQueue.tsx`, `review/ReviewCard.tsx`): the crop beside the chosen candidate's image, candidates ranked below with why each was picked, other name guesses when the name is unsure, all printings of a name, search by name (`search/PrintingPicker.tsx`), foil and quantity. Keys: 1–5, Enter, X, F, +/−, S, ←/→. "Use <set number> for all N <name>" accepts every waiting review whose best guess is that name. A photo that needs review shows the same card on the Scan tab.
  - **Batch tab:** "Change printing" on every row (all printings of the name, or another card by name; keeps the finish when it can, merges with a matching row), "Merge another batch into this one", and full JSON backup and restore (`session/backup.ts`: every batch, its cards and its waiting reviews with crops as base64; a batch that still exists is restored as a copy named "… (restored)", nothing is overwritten). Download or Web Share.
  - **Eval** (`--lock true-set` locks each card's batch to its own set, `--lock other-set` to one it isn't from). Default numbers are unchanged card for card (standard: 0 of 320, phone: 0 of 456 cards differ from main). Standard, locked to the true set: name 92.2% → 93.4%, printing 74.4% → 91.6%, printing-or-twin 86.6% → 92.2%, top-5 printing 91.3% → 94.4%, auto-accepted 39.1% → 65.6%, 0 wrong (sweep: 0 wrong down to 0.8). Goal subset: printing 72.5% → 96.7%, auto-accepted 44.0% → 83.5%. Locked to another set: 0% auto-accepted (as designed), name 92.2% → 91.9%. Phone, locked to the true set: name 87.7% → 88.2%, printing 72.6% → 84.6%, printing-or-twin 78.5% → 85.1%, auto-accepted 36.2% → 51.5%, 0 wrong.
  - **Tests:** `tests/e2e/live.spec.ts` plays a generated video of fake cards through Chromium's fake camera (`--use-file-for-fake-video-capture`, `tests/e2e/liveVideo.ts`): a card left lying counts once, an identical copy after it was taken away counts, a different card put on top counts. Typecheck, 337 unit tests and 46 e2e tests pass on Linux in Docker (`mcr.microsoft.com/playwright:v1.65.0-noble`, Node 26), the steps of deploy.yml's verify job; that run caught a race a Mac run hid (the foil switch only showed the saved value). Packing the repo with macOS `tar` needs `COPYFILE_DISABLE=1 --no-xattrs`, or `._*.test.ts` files break vitest.
  - **Not done / unknown:** (1) throughput on a phone: not measured yet; the debug readout now shows the last read's stage timings and cards/min. (2) "Apply to all similar" matches on the best-guess name only. (3) Batch items keep no crop, so changing a printing from the Batch tab shows the candidates' images, not the user's scan. (4) The recent strip lives in memory: a reload empties it (the cards stay saved).
  - **Follow-up fixes (2026-11-12, PR #6, not yet merged or phone-tested).** PR #5 was merged and the index rebuilt with `sets.mtg.json`. The owner's first iPhone test of M4 used a red deck box as a chute, with the flashlight on, mostly Star Trek cards including foils. It passed beeps, flash and counter, stacked different cards, identical copies, a face-down card to review, Undo, the Review tab, Change printing, merge, and backup/restore. Four fixes followed:
    - **A card left lying was counted again and again** (a foil about 10 times in 30 s). Cause, measured: with a flashlight hotspot, the same card's live fingerprint moves from frame to frame past the 24-bit "different card" threshold (hotspot shifted 15 px: p90 26 bits; strong foil shimmer: p90 44; different cards ~52). Detection losing the card for ≥ 3 frames also forgot it. Now (`liveSession.ts`):
      - A different look must persist for 2 checks (`DIFFERENT_CHECKS`).
      - The re-read must then find a different card (`sameCard`): a different name; both reads sure of different printings; or art more than 44 bits away (`SAME_CARD_DISTANCE`). Otherwise nothing is counted, and that look is kept as another look of the card (up to 12).
      - When detection loses the card or its outline jumps, the spot where it lay is fingerprinted (`SignatureProbe`). If the card still looks the same there, it hasn't gone.
      - Identical copies still count after a real disturbance (the spot looks different for ≥ 2 frames).
      - Live mode reads after 2 steady frames (`LIVE_STABILITY`). The debug readout counts "same card read again, not counted".
      - `tests/e2e/live-glare.spec.ts` (a fake foil under a hotspot, with shimmer bands and blurred frames, then a different card on top) fails on PR #5's live code and passes now.
    - **Flashlight glare** (`vision/glare.ts`):
      - It finds a compact, roughly round, blown-out blob inside the card's border (not a light text box or a streak) and paints it and its halo over from the surroundings.
      - With a hotspot, the de-glared card is matched as extra queries (cards without one keep exactly their old queries). The live signature carries both looks, compared as their closest pair.
      - A medium hotspot's distance to the index drops from a median of 18 to 12; a very large one blows out too much art to recover.
      - The quality gate gives `hotspot` advice at ≥ 0.8% of the card. Live mode then says "Glare from the flashlight: turn it off, or light the cards from the side" while a card settles; it is not a refusal.
    - **Speed** (the first iPhone numbers were 30 cards/min; a read took 372 ms, of which hash-search 171 and collector 88; per frame, detect 79 ms; cards waited on "Hold still: blurry" at sharpness 41):
      - The global fingerprint search is one allocation-free loop with an exact early exit: same hits; Node 7.5 → 2.5 ms, no-JIT 277 → 136 ms. Under throttled Chromium that stage is mostly loading the hits' printings shards, so the search is now skipped for a sure title (≥ 0.9) whose art is within 24 bits (`SURE_TITLE_ART`, was 16).
      - The collector OCR is skipped when a sure title's art settles the printing (best ≤ 18 bits with ≥ 0.97 of the printing evidence: `ART_SETTLES`). A de-glared query's collector crop is no longer read twice.
      - The blur gate (`minSharpness`) went 60 → 30: down to 20, cards held back only for blur that would be auto-accepted were all right on every set.
      - Live frames are watched at 480 px (`LIVE_DETECT_SIZE`; 37% cheaper, finds cards at least as often). Reads still detect at 640: reading from the 480 outline improved the phone set (name 87.7% → 90.4%) but auto-accepted one wrong promo twin on the standard set.
      - Expected on the phone: per frame about 79 → 55 ms, and many reads without the search or the collector line. Not measured on a phone yet.
    - **Sound:** once, after the first card, where the silent switch matters (Safari's Audio Session API), a tip offers "Beep even in silent mode".
    - **Eval, before → after** (0 wrong auto-accepts in every set; each speed change alone changed 0 cards):
      - `phone-flash` (152, new): name 83.6% → 85.5%, printing 63.2% → 67.1%, printing-or-twin 67.8% → 73.0%, top-5 printing 80.9% → 83.6%, auto-accepted 21.1% → 27.6%. The global search ran on 148 → 94 cards.
      - `phone`: name and printing unchanged (87.7% / 72.6%), auto-accepted 36.2% → 36.4%. The collector line was skipped on 89 of 456 cards, and the global search ran on 247 → 212.
      - Standard: unchanged (92.2% / 74.4%), auto-accepted 39.1% → 39.7%, collector skipped on 52 of 320.
      - Sweeps unchanged (`phone` 1 wrong at 0.8–0.85), so 0.9 stays.
      - Node p50/p95: flash 222/709 → 218/707, phone 229/582 → 214/587, standard 219/516 → 204/519.
      - Throttled Chromium (4×), per frame: detect 36–43 → 26–30 ms.
    - **Tests:** 349 unit, 47 e2e, passing on Linux in Docker as deploy.yml's verify job runs them.
  - **Round 5 fixes (2026-11-12, PR #8, merged, not yet phone-tested).** The owner's fifth iPhone test (red deck box as a chute, flashlight on, 1080p, Star Trek cards, no set lock) added 15 cards and sent 30 to review. Clearly legible titles read as nothing ("Swamp"), "2" ("Orion") or "fulcan" ("Vulcan").
    - **Cause, from the review crops in the screenshots:**
      - The title line held non-letters: the title bar's outline above and below the name, the top of the art as a band (Orion), and the card's border at one end when the outline was a little off (Swamp).
      - The band's left edge clipped the first letter: "Jrion", "'ulcan".
      - "The title outside the frame" was the preview: a 3:4 box hid the top and bottom of the portrait 1080p frame, which the scanner saw whole.
    - **Rescue readings for a poorly read title** (`titleCrop.ts`, `pipeline.readTitle`). Only after the usual three renderings read < 0.85:
      - the cleaned line (`cleanLine`): rule rows near the strip's top and bottom, or thin ones anywhere, are erased, along with what is left of them and tall border blobs at the ends. Letters joined to a rule keep their rows, and blurred letters run together through the middle stay;
      - then the cleaned line from a wider band (MTG `title.wide`, x 10–478 of 488).
      - They count only when sure: ≥ 0.75, or ≥ 0.9 for a name under 5 letters.
      - Making the cleaned or wide line the first reading cost the standard set about 2 points of names. Blurred titles found by their art lost to short junk ("we" → Web, "- Tee" → Tek), which also fixed orientation wrongly.
    - **Live preview** (`capture/CameraPreview.tsx`): the camera's whole picture in its own shape, up to 58vh. The cut-off hint says "Move the phone back: the whole card must be in view."
    - **Dropped:**
      - brightest-channel grey under a colour cast (mixed on the owner's crops);
      - extending the collector band past the card's bottom edge for outlines that stop short of a dark bottom border. It was better on standard but worse on phone, where the band picks up background texture below the card. Vulcan's cut collector line stays unfixed.
    - **Eval, before → after** (0 wrong auto-accepts everywhere, no card lost its auto-accept; sweeps as before, so 0.9 stays):
      - `phone-redbox` (152, new): name 92.8% → 94.7%, printing 78.9% → 80.9%, auto-accepted 46.1% → 47.4%.
      - `phone-flash`: name 85.5% → 88.8%, printing 67.1% → 69.7%, auto-accepted 27.6% → 28.9%.
      - `phone`: name 87.7% → 87.9%, auto-accepted 36.4% → 37.7%.
      - Standard: name 92.2% → 92.8%, printing 74.4% → 75.0%, auto-accepted 39.7% → 40.3%.
      - Latency: p95 rose (standard 522 → 647 ms) from the rescue OCR on poorly read titles.
      - The synthetic red light is milder than the owner's box.
    - **Open:** Guidance Failure was counted three times in a row while dedupe caught 5 re-reads; whether these were 3 real copies is unknown.
  - **Test log (2026-11-13, PR #9, not yet merged or phone-tested).** iPhone QA went through screenshots, and the backup holds only waiting reviews. Now the scanner can record a test log and share it as one file.
    - **Where:** Scan → Sound and testing (`capture/TestLogPanel.tsx`).
      - "Record a test log": off by default, remembered, with the line "It stays on this phone until you share it". Nothing is sent anywhere.
      - "Include card pictures": on by default; each card as a 244×340 JPEG, about 10 KB.
      - A count of logged scans; Share (Web Share) / Download / Clear.
    - **Reads** (`session/testLog.ts`, `session/testLogRecord.ts`): one per live or photo scan.
      - Build (`__BUILD__`: package version + commit), user agent and settings (camera, flashlight, set lock, foil, language, condition, sound).
      - Frame size, per-stage timings and quality (light, noise, sharpness, tilt, glare, card width, in frame, issues, advice).
      - The raw title and collector OCR, the trace, the top 5 candidates with per-signal scores, and the confidences.
      - The outcome: added, review with its reason, or same card not counted with why (`LiveSession.lastSameCard`, `FrameOutcome.repeat`).
    - **Trace:** `Recognition.trace` records the paths recognition took. It is bookkeeping only: the standard eval gave the same result on all 320 cards.
      - `title:rendering-N` (1–3, or the rescue readings 4–5), `title:from-frame`, `title:upside-down`;
      - `outline:N`, `outline:fallback`, `center-guess`, `orientation-unknown`;
      - `deglared`, `hash-search`, `collector:skipped`/`digits`/`lookup`, `lock:number-lookup`, `lock:outside`, `gave-up`.
    - **Follow-up events**, linked by a scan id that travels with the card (`ReviewItem.scanId`, `BatchItem.scanIds`, kept through merges):
      - a review accepted as a printing (the ground truth), with how it was found (`via`: candidate rank, all printings, search, all similar);
      - a review discarded;
      - a thumbnail's Undo;
      - Change printing in the Batch tab (the ground truth for every read in the row).
    - **Storage and format:** a ring buffer of the last 300 reads in Dexie v3 table `testlog`. File format `manifest-testlog` version 1, documented in `tests/eval/TESTLOG.md`. `tests/eval/testlog-to-fixtures.ts` turns labelled reads into real-scan fixtures; a later Undo or discard removes a label.
    - **Tests:** 363 unit and 48 e2e, passing on Linux in Docker as deploy.yml's verify job runs them. The new e2e records a log, scans, undoes, resolves a review, downloads the file, checks it and clears it.

## Working agreements for Claude Code

- Work milestone by milestone. At the start of each milestone, post a short plan; at the end, summarize what works, what doesn't, and the eval numbers.
- Keep the main thread free: CV/OCR/ML only in workers. Profile on a throttled mobile CPU in DevTools.
- Ask before adding any client dependency larger than ~1 MB gzipped, or any paid or keyed service.
- No secrets in the client bundle. No card images in git.
- Prefer small, pure, tested functions in `recognize/` and `export/`.
- When unsure about an external format (CSV headers, import syntax), find or ask for a real sample instead of guessing, and put it in `tests/fixtures/formats/`.
- Update this file when an architectural decision changes.
