# Test log

A phone test can be recorded as one file instead of screenshots. On the Scan tab, open **Sound and testing**:

1. Turn on **Record a test log**. **Include card pictures** (on by default) keeps a small picture of each card.
2. Scan as usual: live, or photos. Resolve reviews, use Undo, change printings: those are logged too.
3. **Share test log** (Save to Files, AirDrop, Mail…) or **Download test log**. **Clear log** empties it.

The log stays in the browser's IndexedDB until it is shared. No network calls are made. It keeps the last 300 scans, with their follow-ups.

## Format: `manifest-testlog`, version 1

One JSON file (`app/src/session/testLog.ts` has the types):

```json
{
  "format": "manifest-testlog",
  "version": 1,
  "exportedAt": "2026-11-13T09:15:00.000Z",
  "app": { "build": "0.0.0+7cf547c", "userAgent": "…" },
  "reads": [ … ],
  "events": [ … ]
}
```

### Reads

Each read has these fields:

| Field | What it holds |
|---|---|
| `id` | What events refer to. |
| `at` | ISO time. |
| `source` | `live` or `photo`. |
| `build` | The app build (package version + commit). |
| `userAgent` | The browser. |
| `settings` | `camera` (720/1080), `flashlight`, `lockSets`, `foil`, `lang`, `condition`, `sound`. |
| `frame` | The frame or photo size. |
| `timings` | Milliseconds per stage, as the timings readout shows them. |
| `quality` | `brightness`, `noise`, `sharpness`, `tilt`, `glare` (share of the card covered by a light's reflection), `cardWidth`, `inFrame`, `issues`, `advice`. |
| `ocr` | `title` and `collector`: the raw OCR text. |
| `trace` | The paths recognition took (below). |
| `candidates` | The top 5 printings, each with `id`, `name`, `set`, `number`, `score`, and the per-signal values `title` (similarity), `art` (fingerprint distance of 128 bits, null without one), `collector` (`number`/`set` verdicts and `score`) and `sources`. |
| `nameConfidence`, `confidence` | 0–1. |
| `outcome` | `{ kind: "added", printingId, finish }`, `{ kind: "review", reason }`, or `{ kind: "same-card", why }`. The last is a live re-read of the card already counted (glare, foil shimmer, the flashlight), so nothing was counted. |
| `live` | Live reads only, from builds after round 6: why live mode read the card, and what it saw in the frames before (below). |
| `crop` | Optional: the upright card as a 244×340 JPEG, base64. |

`live` is for telling why a card was counted twice (see `app/src/recognize/liveSession.ts`):

| Field | What it holds |
|---|---|
| `trigger` | `fresh` (the first card, or the first after the card read last was gone), `different` (it looked unlike the card read last), `camera` (a check after the flashlight switched) or `again` (Read again). Only `fresh` and `again` reads always count; the others count only when the read finds another card. |
| `distance` | For `different` and `camera`: fingerprint distance (of 128 bits) from the card read last. |
| `frames` | Up to 24 frames before the read, oldest first: `ms` since the frame before, `outline` (detection found one), `moved` (how far it was from where the card read last lay, as a share of its diagonal), `probe` (fingerprint distance from the card read last to what lay where it was, when that was looked at), `gone` (frames in a row so far without the card read last: 3 make it gone) and `hold` (the camera was settling after the flashlight switched). |

`trace` values:

| Value | Meaning |
|---|---|
| `title:rendering-N` | The title read best from rendering 1 (binarized), 2 (contrast-stretched grey) or 3 (strict threshold), or from rescue reading 4 (the line cleaned of rules and border) or 5 (the cleaned line from the wider band). |
| `title:from-frame` | The title was cut straight from the full frame. |
| `title:upside-down` | The card was read upside down. |
| `outline:N` | A later detected outline was used. |
| `outline:fallback` | The other outline was identified because the first named nothing. |
| `center-guess` | The card was guessed from the middle of a photo. |
| `orientation-unknown` | The fingerprint was tried both ways up. |
| `deglared` | A flashlight hotspot was painted over for the fingerprint. |
| `hash-search` | All fingerprints were searched. |
| `collector:skipped` | The art settled the printing. |
| `collector:digits` | The number line was re-read as digits only. |
| `collector:lookup` | The collector line named the card. |
| `lock:number-lookup` | The number alone named the card within the locked sets. |
| `lock:outside` | The card isn't from the locked sets. |
| `gave-up` | Live mode stopped after 3 failed reads. |

### Events

Each event has these fields:

| Field | What it holds |
|---|---|
| `id` | The event's own id. |
| `at` | ISO time. |
| `type` | What happened (below). |
| `readIds` | The reads it is about. |
| `printing` | `{ id, name, set, number }`, when it names a printing. |
| `from` | The printing before, for a printing change. |
| `finish` | The finish chosen. |
| `qty` | The quantity chosen. |
| `via` | How the printing was found, for an accepted review. |

The types:

- `review-accepted`: a review resolved as `printing`. This is the ground truth. `via` is `candidate-N` (its rank), `printings` (all printings of a name) or `search`, plus `, all similar` for "Use … for all".
- `review-discarded`
- `undo`: a thumbnail's Undo.
- `printing-changed`: a batch row's printing changed from `from` to `printing`. This is the ground truth for every read that went into the row; the row keeps its last 20.
- `flashlight`: the flashlight was switched on or off (`on`). It is about no read, so `readIds` is empty.

## From a log to eval fixtures

```
npx tsx tests/eval/testlog-to-fixtures.ts manifest-testlog-20261113-0915.json
```

The script works like this:

- **Which reads count.** A read whose last label-giving event is `review-accepted` or `printing-changed` becomes a fixture. A later `undo` or `review-discarded` takes the label away.
- **The picture.** The read's picture goes into `tests/fixtures/real-scans/` (photos there are gitignored), padded with a plain grey border so detection has an edge to find.
- **The label.** Each fixture gets an entry in that folder's `labels.json`: the printing's id and name; the tags `testlog`, `cropped`, `live`/`photo`, and `flashlight`, `foil`, `1080p`, `glare`, `low-light` where they apply; and notes saying what the scanner read and how the user corrected it.

`--dry-run` lists what it would add. `--out dir` writes elsewhere.

These pictures are the app's own crops, not whole photos, so they don't test detection or framing. `npm run eval -- --only real` runs them with the owner's other photos.

## Replaying live mode

```
npx tsx tests/eval/live-replay.ts manifest-testlog-20261115-0359.json
```

This puts the log's card pictures back into camera frames, in the order they were read, and runs them through the scanner's live mode (the same `LiveScanner` the app's worker uses, with real detection, OCR and the card index). The frames in between are made up, the same way every run:
- the hand-held phone drifts, and now and then jumps by a tenth to a fifth of the card's diagonal;
- some frames blur, so detection loses the card;
- where the log's flashlight setting changes, the picture blows out or darkens for a few frames;
- the box is empty for a moment between cards.

Each run of reads with the same top name counts as one card lying there, so it should count once. It prints how often each was counted and why each read happened. `--no-camera-events` leaves out the app's flashlight notice; `--seed N` shakes the phone differently.
