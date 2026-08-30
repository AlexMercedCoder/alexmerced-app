# alexmerced.app

A shelf of small browser tools. Every one runs entirely on the visitor's own
machine, stores its data locally, and exports the whole dataset to a file on
request. There is no server, no account, and no analytics.

Live at **https://alexmerced.app**

## The apps

**Writing and notes**

| App | What it is |
| --- | --- |
| **Warren** | Nested pages built from blocks, with markdown shortcuts, a slash menu, search, trash, and Markdown export |
| **Jotterbug** | Quick notes on a coloured board: pinning, labels, checklist mode, archive and trash, both reversible |

**Planning and time**

| App | What it is |
| --- | --- |
| **Laneway** | A kanban board for one person: WIP limits, checklists, due dates, labels, drag and drop, keyboard moves, archive |
| **Stint** | A time tracker with projects, rates, billing rounding, day and week views, and CSV export |
| **Rote** | Spaced repetition on SM-2, with a fortnight forecast, retention stats, and CSV import and export |

**Data tools**

| App | What it is |
| --- | --- |
| **Decanter** | Convert between JSON, NDJSON, CSV, YAML and TOML; flatten, query by path, and generate SQL, Iceberg or JSON Schema |
| **Fabler** | Seeded sample data with foreign keys that keep referential integrity, out as JSON, CSV, SQL or DDL |

**Making files**

| App | What it is |
| --- | --- |
| **Tessera** | A QR generator with nine payload builders, a from-scratch encoder, and a saved library |
| **Loupe** | Resize, convert and compress images, reading EXIF first so you can see what re-encoding strips |
| **Quire** | Merge, split, reorder and rotate PDF pages, and turn images into pages |
| **Rostrum** | Slide decks with a presenter view, Markdown in and out, and PDF or standalone HTML export |

**Working things out**

| App | What it is |
| --- | --- |
| **Reckoner** | An expression calculator with a tape, memory registers, and thirty functions |
| **Sift** | A regex workbench with live highlighting, capture groups, replacement preview, and a plain English explainer |

## Running it

```bash
npm install
npm run dev       # http://localhost:4321
npm test          # 836 tests
npm run build     # writes dist/ and generates the service worker
npm run preview   # serve the built site, needed to exercise the PWA
```

## How it is built

Astro 5 with no UI framework. Each app is plain TypeScript split into three
parts, which is what makes it testable:

- **`model.ts`** is pure logic with no browser APIs: the page tree, card
  movement, note filtering, the QR encoder. This is where the test suite lives.
- **`store.ts`** wraps persistence and the export and import envelope.
- **`ui.ts`** owns the DOM.

Shared plumbing sits in `src/lib`: a promise wrapper over IndexedDB, a
localStorage helper that degrades to memory when storage is blocked, the export
format, toasts, and the PWA registration.

### Written from scratch, not pulled in

The site has no runtime dependencies at all. Where a library would normally be
reached for, the thing is implemented here and covered by tests:

- **A QR encoder** implementing ISO/IEC 18004 (`src/apps/tessera/qr.ts`).
- **A PDF writer** using the standard fourteen fonts with real AFM metrics, so
  text can be measured rather than guessed (`src/lib/pdf/write.ts`).
- **A PDF reader** that parses cross-reference tables, cross-reference streams
  and object streams, enough to move pages between files (`src/lib/pdf/parse.ts`).
- **Parsers for JSON, NDJSON, CSV, YAML and TOML** (`src/apps/decanter/formats.ts`).
- **SM-2 spaced repetition** (`src/apps/rote/model.ts`).
- **An EXIF reader** (`src/apps/loupe/exif.ts`), a **ZIP writer** with CRC-32
  (`src/lib/zip.ts`), and a **seeded PRNG** (`src/lib/random.ts`).

### The QR encoder

`src/apps/tessera/qr.ts` implements ISO/IEC 18004 from scratch rather than
pulling in a dependency: numeric, alphanumeric, and byte modes across all forty
versions and four error correction levels, Reed-Solomon over GF(2^8), and all
eight data masks scored by the four penalty rules.

Its tests do more than check that it runs. They verify all 160 version and level
capacities against the published table, confirm every Reed-Solomon syndrome is
zero (the defining property of a valid codeword), and read the finished matrix
back through a decoder to check that what comes out is what went in, under every
mask and across versions that exercise alignment patterns and version blocks.

### Export and import

Every app writes the same envelope:

```json
{
  "format": "alexmerced.app/export",
  "version": 1,
  "app": "warren",
  "appVersion": 1,
  "exportedAt": "2026-08-30T09:00:00.000Z",
  "counts": { "pages": 12 },
  "data": { "pages": [] }
}
```

Import validates the envelope before touching anything, refuses a file from a
different app, and offers merge or replace. Merging resolves conflicts by
keeping whichever copy was edited most recently. Records that arrive malformed
are repaired or dropped rather than allowed to corrupt the store: an orphaned
page is reparented, a parent cycle is broken, an unknown block type becomes a
paragraph.

### Progressive web app

The site installs to a phone or desktop and works with no network at all.

`scripts/build-sw.mjs` runs after `astro build`. It walks `dist/`, collects
every page and asset, and writes `dist/sw.js` with that precache list and a
version hashed from the content plus the worker's own source, so a deploy always
invalidates the previous cache. The worker precaches on install and then serves
cache-first while refreshing in the background.

One thing worth knowing if you adapt this: cache lookups pass
`{ ignoreVary: true }`. Servers commonly send `Vary: Origin` on JavaScript, and
module scripts are fetched in `cors` mode while `cache.addAll` stores them from
a `no-cors` request. Without `ignoreVary` the scripts never match the cache and
the site loads offline with no JavaScript at all.

## Known limits, stated plainly

- PDF text uses the standard fourteen fonts, which are Latin-1. CJK and emoji
  would need font embedding and subsetting.
- Quire refuses encrypted PDFs rather than mangling them, and does not render
  page thumbnails; preview goes through the browser's own PDF viewer.
- Decanter's YAML and TOML support is a documented subset. No anchors, aliases
  or tags in YAML.
- Everything is held in memory, so very large files will strain a phone.

## Storage, and its limits

IndexedDB and localStorage are scoped to one browser on one device. Nothing
syncs, because nothing leaves. Clearing site data deletes it, and private
windows usually discard it on close. That is the trade the site makes in
exchange for never seeing your data, and it is why every app has an export
button.

## License

MIT for the code. See `LICENSE`.
