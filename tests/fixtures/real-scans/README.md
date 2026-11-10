Labeled photos supplied by the owner go here, with labels in `labels.json`. The photos are gitignored; the labels stay in git.

`npm run eval` reads every photo listed in `labels.json` that is present, runs the same recognition pipeline as the app, and reports the results under a separate "real scans" row and a `real` tag. Real photos are the ground truth: the synthetic set the eval also runs is rendered from Scryfall's own scans and is optimistic.

```json
{
  "IMG_0412.jpg": { "game": "mtg", "id": "<Scryfall card id>", "tags": ["sleeved"], "notes": "desk lamp, slight glare" },
  "IMG_0413.jpg": { "game": "mtg", "id": "<Scryfall card id>", "foil": true, "tags": ["low-light"] }
}
```

- `id` is the Scryfall id of the exact printing (from the card's page on scryfall.com: the UUID in the image or API link). The eval looks the name up in the built index, so run `npm run index:build` first. `name` may be given instead of looking it up.
- `tags` are free-form, but reuse the eval's hard-case tags where they apply so results line up: `sleeved`, `foil`, `glare`, `low-light`, `blur`, `dark-background`, `upside-down`, `dfc`, `basic-land`, `old-frame`, `frame-2003`, `showcase`, `token`, `non-english`, `modern`, `clean` (well lit, unsleeved, in focus).
- JPEG and PNG only. Convert HEIC first (on a Mac: `sips -s format jpeg IMG.HEIC --out IMG.jpg`).
