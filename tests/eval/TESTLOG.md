# Test log (the app's "debug log")

A phone test can be recorded as one file instead of screenshots. The app calls it the **debug log**; the code and this format call it the test log. On the Scan tab, open **Debugging** (collapsed, under the Sound setting):

1. Turn on **Record a debug log**. **Include card pictures** (on by default) keeps a small picture of each card.
2. Scan as usual: live, or photos. Resolve reviews, use Undo, change printings: those are logged too.
3. **Share debug log** (Save to Files, AirDrop, Mail…) or **Download debug log**. **Clear debug log** empties it.

The log stays in the browser's IndexedDB until it is shared. No network calls are made. It keeps the last 300 scans, with their follow-ups.

Files are named `manifest-debuglog-YYYYMMDD-HHMM.json`; logs saved before round 6 are `manifest-testlog-…`. The format inside is the same either way, and the scripts below take any file name.

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
| `trigger` | `fresh` (the first card, or the first after the card read last was gone), `different` (it looked unlike the card read last), `camera` (a check after the flashlight switched), `again` (Read again) or `copy` (with "Count a copy put straight on top" on: the card settled again, moved, after a hand covered it). `again` and `copy` reads always count. `fresh` reads count too, except a card read afresh just after the card read last seemed only moved (forgotten while outlines kept being found), naming the same card. The others count only when the read finds another card. |
| `distance` | For `different` and `camera`: fingerprint distance (of 128 bits) from the card read last. |
| `frames` | Up to 24 frames before the read, oldest first: `ms` since the frame before, `outline` (detection found one), `moved` (how far it was from where the card read last lay, as a share of its diagonal), `probe` (fingerprint distance from the card read last to what lay where it was, when that was looked at), `gone` (frames in a row so far without the card read last: 3 make it gone) and `hold` (the camera was settling after the flashlight switched). Builds after round 9 add `phase` (`empty`, `settling`, `reading`, `read`), `steady` (steady frames so far: a card is read, or checked for a new card on top, once it has been steady for 2), `far` (the check for a new card on top: fingerprint distance from the steady card in view to the closest look of the card read last; over 24 on two checks in a row reads it; null when not checked), `light` (the frame's mean brightness, 0–255) and `issues` (what the quality gate found wrong with the card in view, which keeps it from being read). Builds after round 10 add `away`: the fingerprint distance from the card read last to an outline found far from where it lay, when one was (`probe` is then the distance at its old spot). |

`trace` values:

| Value | Meaning |
|---|---|
| `title:rendering-N` | The title read best from rendering 1 (binarized), 2 (contrast-stretched grey) or 3 (strict threshold), or from rescue reading 4 (the line cleaned of rules and border) or 5 (the cleaned line from the wider band), or 6 (the line from the wider band, read whenever the first readings were unsure: it keeps a first letter the usual band cut off). |
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
| `collector:agrees` | The collector line (number and set, or the number alone when only one printing of the name has it) agrees with the title's name, and vouches for it. |
| `art-tie-break` | Names that read nearly alike were told apart by the artwork. |
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
| `cutoff` | For quick confirm (`via: "bulk"`, `bulk-rejected`): the name confidence from which reviews looked right (0.8). |
| `ms`, `frames` | For `quiet`: milliseconds since the last read, and the frames since it (or since the quiet spell before), as in a read's `live.frames`. For `gone`: the frames that led to it. |
| `summary` | For a long `quiet` stretch (after five spells in a row): `frames`, `outline` (frames with one), `steadyMax`, `phases` and `issues` (frame counts) and `light` (lowest and highest) over all its frames. |
| `picture` | For `quiet` (builds after round 10), when detection found an outline on fewer than half its frames and pictures are included: the camera frame, 180 pixels wide, as a base64 JPEG, to see why it found no card. |
| `card`, `moved` | For `gone`: the card forgotten (its name, or its best printing's id), and whether outlines kept being found while it went (it seemed moved, not taken away). |

The types:

- `review-accepted`: a review resolved as `printing`. This is the ground truth. `via` is `candidate-N` (its rank), `printings` (all printings of a name), `search`, `bulk` (quick confirm: added with the other "looks right" rows by "Add N cards", with its `cutoff`), or `bulk-ticked` (a "needs a look" row the user ticked, added in the same group; no `cutoff`), plus `, all similar` for "Use … for all".
- `bulk-rejected` (quick confirm): a "looks right" guess (`printing`) the user marked wrong when adding the rest, with the `cutoff`: a labelled negative. The review waits on, under "needs a look".
- `bulk-undone` (quick confirm): a group added by "Add N cards" taken back with its Undo; `readIds` are all of them, and their labels are dropped like an `undo`'s.
- `review-discarded`
- `undo`: a thumbnail's Undo.
- `printing-changed`: a batch row's printing changed from `from` to `printing`. This is the ground truth for every read that went into the row; the row keeps its last 20.
- `flashlight`: the flashlight was switched on or off (`on`). It is about no read, so `readIds` is empty.
- `copy-added`: **+1** on the newest thumbnail added one more copy of that card (an identical copy put straight on top isn't counted by itself). `readIds` is the scan it copies.
- `quiet` (builds after round 9): live mode went 2 seconds without reading anything. `frames` show why: no outline (the card isn't found), outlines that never settle, `issues` from the quality gate, or `far` at most 24 (the card looked like the card read last). Reported every 2 seconds, 5 times in a row; then, until the next read, every 30 seconds with only the last 24 frames and a `summary` of all of them (builds before round 10 stopped after 5). About no read, so `readIds` is empty.
- `gone` (builds after round 10): live mode forgot the card read last (it wasn't seen where it lay for 3 frames in a row), with `card`, `moved` and `frames`. About no read.
- `replaced` (builds after round 10): a live re-read of the card already counted was much surer than the read it was counted as (it named a card that read didn't, cleared the bar to be added, or was 0.3 more confident), so it stood in for it. `readIds` is [the read replaced, the new read]. The replaced read's review was removed, and the new read was filed like any read.

## From a log to eval fixtures

```
npx tsx tests/eval/testlog-to-fixtures.ts manifest-debuglog-20261113-0915.json
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
