# Real export samples

Export formatters are checked against these files, so that column names and value
spellings come from what the sites actually produce rather than from memory.

All files are unmodified copies from public repositories:

| Files | Source | Licence |
|---|---|---|
| `*-real-export.csv`, `*-reference.csv` | [StepKie/MtgCsvHelper](https://github.com/StepKie/MtgCsvHelper/tree/e8488c7c982bf4663d62e184cf23e34ce11e7b34/MtgCsvHelper/Resources/SampleCsvs) | Apache-2.0, see `LICENSE-MtgCsvHelper.txt` |
| `manabox-2026-export.csv` | [BenRoe/listing-assistant-for-cardmarket](https://github.com/BenRoe/listing-assistant-for-cardmarket/tree/a15d72c9832bd9246d990bb9294e492c47f1592e/example-csv) | see `LICENSE-listing-assistant.txt` |
| `moxfield-style-text-handwritten.txt` | [eehap/edh-deck-analysis](https://github.com/eehap/edh-deck-analysis/tree/062988b8d8aa6ff9df920be636c025ee7690cca3/dev/fixtures) | see `LICENSE-edh-deck-analysis.txt` |

`archidekt-deck-export-excerpt.txt` holds four unmodified lines from Archidekt's own deck export, so
it is the evidence for the Archidekt deck list. They were copied on 2026-11-09 from the Export deck
dialog (Text, default options) of the public deck [archidekt.com/decks/1585124](https://archidekt.com/decks/1585124/baby_lasagna).
They were picked to show a foil, an etched foil, a double-faced card and a The List collector number. The other 109
lines weren't copied. The same visit showed what Archidekt's two importers accept:

- **Deck importer** (Import cards, in a deck): it takes pasted text such as `1 Mountain (DOM) 263`, or an
  uploaded file. Its file field is `accept=".txt"`, so a CSV can't go there. Pasted CSV lines are read as card names,
  and each one fails with "Could not find a card matching".
- **Collection importer** (`archidekt.com/collections/import`): it takes a CSV and needs a login. Archidekt's own
  [announcement](https://archidekt.com/news/5891613) says the Scryfall ID alone identifies a printing, or else the name
  plus set and collector number.

MtgCsvHelper's [site behaviour log](https://github.com/StepKie/MtgCsvHelper/blob/e8488c7c982bf4663d62e184cf23e34ce11e7b34/MtgCsvHelper/Resources/SampleCsvs/Tests/SITE_BEHAVIOR.md)
records what each site accepts on import. It is the source for the Deckbox and
Archidekt import notes in `app/src/games/mtg/exports.ts`.

`moxfield-style-text-handwritten.txt` is that project's hand-written parser test, not a site export. It is here for its
line shapes only. A real Moxfield deck export, [silvernova0/magic `deckexport.txt`](https://github.com/silvernova0/magic/blob/main/deckexport.txt),
confirms `*F*` and `*E*` and writes one flip card as `Budoka Gardener / Dokai, Weaver of Life`. That repository has no
licence, so it is linked rather than copied.

These samples show what the sites export. They don't prove that the sites accept
Manifest's files: that needs a logged-in import, tracked in CLAUDE.md under "Export formats".
