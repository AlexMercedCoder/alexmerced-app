# alexmerced.app

A shelf of small browser tools. Every one runs entirely on the visitor's own
machine, stores its data locally, and exports the whole dataset to a file on
request. There is no server, no account, and no analytics.

Live at **https://alexmerced.app**

## The apps

| App | What it is | Storage |
| --- | --- | --- |
| **Warren** | Nested pages built from blocks, with markdown shortcuts, a slash menu, search, trash, and Markdown export | IndexedDB + localStorage |
| **Laneway** | A kanban board for one person: WIP limits, checklists, due dates, labels, drag and drop, keyboard moves, archive | IndexedDB + localStorage |
| **Jotterbug** | Quick notes on a coloured board: pinning, labels, checklist mode, archive and trash, both reversible | IndexedDB + localStorage |
| **Tessera** | A QR generator with nine payload builders, a from-scratch encoder, and a saved library | IndexedDB + localStorage |
| **Reckoner** | An expression calculator with a tape, memory registers, and thirty functions | localStorage |

## Running it

```bash
npm install
npm run dev       # http://localhost:4321
npm test          # 333 tests
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

## Storage, and its limits

IndexedDB and localStorage are scoped to one browser on one device. Nothing
syncs, because nothing leaves. Clearing site data deletes it, and private
windows usually discard it on close. That is the trade the site makes in
exchange for never seeing your data, and it is why every app has an export
button.

## License

MIT for the code. See `LICENSE`.
