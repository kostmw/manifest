# Manifest — free, browser-based TCG card scanner

> Working name: **Manifest** (an MTG keyword *and* the word for a list of what's in a shipment).
> Tagline: *Scan a stack, get a list.*

## Commands

Node comes from `.nvmrc`. One package at the repo root; Vite's root is `app/`.

| Command | What it does |
|---|---|
| `npm run dev` | Dev server |
| `npm run check` | Typecheck, unit tests, production build |
| `npm run e2e` | Playwright against a production build, with a fake camera |

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
| Card detection / warp | OpenCV.js (WASM), lazy-loaded |
| OCR | Tesseract.js on **tightly cropped, binarized** regions only (title line, collector line). Keep the OCR engine behind an interface so it can be swapped for PaddleOCR/ONNX later if accuracy needs it |
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
    games/           # game adapters: mtg/, pokemon/, yugioh/
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
| **ManaBox CSV**, **Deckbox CSV**, **Archidekt** | Same: verify each against a real export/import before marking done |

Export formatters are pure functions with snapshot tests.

## Data sources & rules

**MTG: Scryfall**
- Use **bulk data** (`/bulk-data`) for indexes, never per-card API calls at scale. Send a descriptive `User-Agent` and `Accept` header. Respect the documented rate limits (50–100 ms between API calls; `/cards/*` search-style endpoints are capped lower). Never ignore HTTP 429.
- Scryfall requires that software adds value and doesn't just repackage their data. Show "Card data © Scryfall" attribution in the app.
- Card images for building hashes come from Scryfall's image CDN, downloaded by CI **incrementally** (cache by Scryfall ID; only fetch new or changed cards). **Never commit raw images to git.**
- At runtime, thumbnails may be loaded from Scryfall image URLs for the review UI.

**Pokémon: pokemontcg.io (or TCGdex for non-English)**
- A free API key raises the limit to 20,000 requests/day. The key lives only in GitHub Actions secrets and is **never shipped to the client**.

**Yu-Gi-Oh!: YGOPRODeck**
- The rate limit is 20 requests/second, and going over it means a **1-hour block**. Images must be downloaded and re-hosted, not hotlinked. Build indexes offline only.

**Game adapter interface:** each game implements `buildIndex()`, `nameDictionary`, `regions` (title box, collector box, art box in canonical coordinates), `parseCollectorLine()`, and `formatExportLine()`. MTG ships first. Don't let MTG-specific assumptions leak into shared code.

**Legal:** footer notice that this is unofficial fan content and not affiliated with Wizards of the Coast, The Pokémon Company, or Konami, plus data-source attributions.

## Index artifacts (generated by `scripts/`, published with the site)

- `names.<game>.json`: unique card names (including each DFC face mapped to its full name).
- `printings.<game>.<shard>.json`: id, name, set, collector number, finishes, language, image URL, and the minimal fields needed for exports.
- `hashes.<game>.<shard>.bin`: compact binary perceptual hashes keyed to printing ids.
- `manifest.json`: versions, shard list, byte sizes, build date. The app checks it and downloads only changed shards.
- Sharding keeps each file ≤ 20 MB. Lazy-load and cache.

## Accuracy, testing, and the eval harness (non-negotiable)

- `tests/fixtures/real-scans/` holds labeled real photos supplied by the owner. Labels live in `labels.json` (filename → game, Scryfall/printing id, foil, and sleeved/lighting notes).
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

## Working agreements for Claude Code

- Work milestone by milestone. At the start of each milestone, post a short plan; at the end, summarize what works, what doesn't, and the eval numbers.
- Keep the main thread free: CV/OCR/ML only in workers. Profile on a throttled mobile CPU in DevTools.
- Ask before adding any client dependency larger than ~1 MB gzipped, or any paid or keyed service.
- No secrets in the client bundle. No card images in git.
- Prefer small, pure, tested functions in `recognize/` and `export/`.
- When unsure about an external format (CSV headers, import syntax), find or ask for a real sample instead of guessing, and put it in `tests/fixtures/formats/`.
- Update this file when an architectural decision changes.
