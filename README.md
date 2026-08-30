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
| **Ordinate** | Paste CSV, TSV or JSON and get an SVG chart: eight types, five palettes, axis ticks on round numbers |
| **Quarry** | Real SQL over your own CSV, JSON and Parquet files, using DuckDB compiled to WebAssembly |

**Making files**

| App | What it is |
| --- | --- |
| **Tessera** | A QR generator and reader, both written from scratch: nine payload builders, and a scanner that corrects perspective and repairs damage |
| **Loupe** | Resize, convert and compress images, reading EXIF first so you can see what re-encoding strips |
| **Quire** | Merge, split, reorder and rotate PDF pages, and turn images into pages |
| **Rostrum** | Slide decks with a presenter view, Markdown in and out, and PDF or standalone HTML export |
| **Tally** | Invoices with a live PDF preview, per-line tax, and money held in whole cents so the arithmetic is exact |
| **Cadence** | Record from the microphone and edit: trim, cut, fade, normalise, resample, join with a crossfade |
| **Foolscap** | Photograph a document and get a straight PDF: edge detection, perspective correction, local thresholding |
| **Cutaway** | Trim, resize and convert video: WebM, animated GIF, or every frame as a PNG |
| **Limelight** | Record the screen and polish it: background, rounded corners, and a zoom that follows what is happening |

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

Every app but one is built from nothing but the platform. Where a library would
normally be reached for, the thing is implemented here and covered by tests:

- **A QR encoder** implementing ISO/IEC 18004 (`src/apps/tessera/qr.ts`).
- **A PDF writer** using the standard fourteen fonts with real AFM metrics, so
  text can be measured rather than guessed (`src/lib/pdf/write.ts`).
- **A PDF reader** that parses cross-reference tables, cross-reference streams
  and object streams, enough to move pages between files (`src/lib/pdf/parse.ts`).
- **Parsers for JSON, NDJSON, CSV, YAML and TOML** (`src/apps/decanter/formats.ts`).
- **SM-2 spaced repetition** (`src/apps/rote/model.ts`).
- **A QR decoder** with Berlekamp-Massey, Chien search and Forney over the same
  field, plus finder location and perspective correction from a photograph
  (`src/apps/tessera/decode.ts`, `src/apps/tessera/scan.ts`).
- **A RIFF/WAVE reader and writer** at 16, 24 and 32 bit float
  (`src/apps/cadence/wav.ts`). The browser will decode a WAV but will not write
  one.
- **Perspective correction by homography**, shared by the document scanner and
  the QR reader (`src/lib/homography.ts`).
- **A WebM muxer** (`src/lib/webm.ts`). WebCodecs encodes frames and hands them
  back bare; the browser offers no way to write a container around them.
- **An MP4 muxer** (`src/lib/mp4.ts`). WebM is the better container, but MP4 is
  what people send each other, so a tool that cannot write one will not get
  used. Boxes, sample tables, and the nested descriptors AAC needs.
- **An Opus track builder** (`src/lib/opus.ts`), shared by everything that has
  to put sound in a file.
- **A GIF encoder** (`src/lib/gif.ts`) with median-cut quantisation,
  Floyd-Steinberg dithering, and LZW.
- **An EXIF reader** (`src/apps/loupe/exif.ts`), a **ZIP writer** with CRC-32
  (`src/lib/zip.ts`), and a **seeded PRNG** (`src/lib/random.ts`).

### The one exception: Quarry

Quarry runs [DuckDB](https://duckdb.org) compiled to WebAssembly. Writing a
columnar SQL engine was not on the table, and pretending otherwise would have
meant a worse tool.

Two things follow from that, and both are deliberate:

- **It is served from this site, not from a CDN.** A script from someone else's
  domain would run with full access to whatever you loaded into it, which is the
  one thing this site promises never happens. `scripts/copy-duckdb.mjs` copies
  the engine out of `node_modules` at build time, so the repository stays small
  and the deploy self-hosts the file.
- **It is fetched only when you ask for it.** The engine is about 34 MB, which is
  roughly 8 MB compressed. Quarry shows the size and makes you press a button
  before any of it is downloaded, and `scripts/build-sw.mjs` keeps it out of the
  service worker precache so installing the app does not drag it along.

Only the exception-handling build is shipped. Every browser released since the
end of 2021 supports it, and carrying the older fallback would have added another
39 MB to the deploy for browsers nobody is running.

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

### For agents

Every page registers WebMCP tools when it loads, so an agent that has navigated
to a page can use what that page does rather than read a description of it.
Seventy-four tools across twenty apps: run SQL, render a chart, read a QR code
out of a photograph, merge PDFs, straighten a scan, trim audio, convert an
image, add a card to a board.

The site-wide tools are on every page (`src/lib/siteTools.ts`). One of them,
`build_skill`, writes a ready-to-save skill document: which page to open for
which job, worked recipes, and the traps. Give it a task and the pages and
recipes are ordered around it.

The catalogue that document is written from lives in `src/data/agentGuide.ts`,
and a test checks it against the tools that are actually registered. A guide
that has drifted is worse than no guide, because it sends an agent looking for
something that is gone.

### What a browser is not allowed to know

Limelight zooms in on whatever is happening. Where it gets that from depends on
what is being recorded, and the app says which it is using rather than implying
one and doing the other:

- **Recording this tab**, pointer events are available, so the zoom follows the
  cursor exactly and clicks leave a ripple.
- **Recording anything else**, no browser is told where the pointer is. The
  operating system draws the cursor into the captured frames and never reports
  the position. So the zoom follows where the picture changed between frames
  instead, which needs no cursor at all and works on a recording that was
  merely dropped in.

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
