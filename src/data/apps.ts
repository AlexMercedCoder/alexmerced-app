export type Category = 'write' | 'plan' | 'data' | 'make' | 'count';

export const CATEGORIES: { id: Category; label: string; blurb: string }[] = [
  { id: 'write', label: 'Writing and notes', blurb: 'Places to put words, from a passing thought to a nested workspace.' },
  { id: 'plan', label: 'Planning and time', blurb: 'What you are doing, what is left, and where the hours went.' },
  { id: 'data', label: 'Data tools', blurb: 'Reshape, generate and interrogate structured data without uploading it.' },
  { id: 'make', label: 'Making files', blurb: 'Produce something to hand over: an image, a PDF, a deck, a code.' },
  { id: 'count', label: 'Working things out', blurb: 'Numbers and patterns.' },
];

export type AppEntry = {
  slug: string;
  category: Category;
  name: string;
  tagline: string;
  description: string;
  /** The verb on the card. */
  action: string;
  theme: string;
  accent: string;
  accentSoft: string;
  storage: 'IndexedDB' | 'localStorage' | 'IndexedDB and localStorage' | 'none';
  features: string[];
  keywords: string[];
};

/**
 * The directory. Order here is the order on the home page.
 */
export const apps: AppEntry[] = [
  {
    slug: 'warren',
    category: 'write',
    name: 'Warren',
    tagline: 'Nested pages that go as deep as you do',
    description:
      'A writing workspace built out of blocks. Pages nest inside pages without a depth limit, blocks respond to markdown shortcuts as you type, and a slash menu turns any line into a heading, list, to-do, quote, callout, or code block.',
    action: 'Open Warren',
    theme: 'warren',
    accent: '#b4552d',
    accentSoft: '#f4e6dc',
    storage: 'IndexedDB and localStorage',
    features: [
      'Unlimited page nesting with a collapsible tree',
      'Ten block types with markdown shortcuts and a slash menu',
      'Full text search across every page',
      'Trash with restore, and Markdown or JSON export',
    ],
    keywords: ['notes app', 'nested pages', 'block editor', 'notion alternative', 'offline notes'],
  },
  {
    slug: 'laneway',
    category: 'plan',
    name: 'Laneway',
    tagline: 'A kanban board sized for one person',
    description:
      'Boards, columns, and cards, with the parts a solo project actually needs: work-in-progress limits that warn when a lane is overloaded, checklists that roll up into a progress bar, due dates that surface before they bite, and an archive so finished work leaves the board without leaving your history.',
    action: 'Open Laneway',
    theme: 'laneway',
    accent: '#2f6f9f',
    accentSoft: '#e2edf5',
    storage: 'IndexedDB and localStorage',
    features: [
      'Several boards, each with its own columns and labels',
      'Drag and drop, plus full keyboard card movement',
      'Work-in-progress limits, checklists, and due dates',
      'Filter by text, label, or due window, and archive finished cards',
    ],
    keywords: ['kanban board', 'personal project management', 'trello alternative', 'offline kanban'],
  },
  {
    slug: 'jotterbug',
    category: 'write',
    name: 'Jotterbug',
    tagline: 'Catch it before it gets away',
    description:
      'Quick notes on a coloured board. Type a thought, pin it, tag it, or flip it into a checklist. Search narrows as you type, pinned notes float to the top, and anything you delete waits in the trash long enough to change your mind.',
    action: 'Open Jotterbug',
    theme: 'jotterbug',
    accent: '#0f9b7e',
    accentSoft: '#dcf1eb',
    storage: 'IndexedDB and localStorage',
    features: [
      'Eight note colours, pinning, and freeform labels',
      'Flip any note between prose and a checklist',
      'Live search across titles, bodies, and checklist items',
      'Archive and trash, both reversible',
    ],
    keywords: ['quick notes', 'sticky notes', 'google keep alternative', 'offline notes app'],
  },
  {
    slug: 'tessera',
    category: 'make',
    name: 'Tessera',
    tagline: 'QR codes for anything you need to hand over',
    description:
      'A QR generator that knows the formats. Build a link, a wifi handshake, a contact card, an email, a text message, a calendar event, a phone number, or a map pin, then tune the error correction, colours, quiet zone, and size before saving it as PNG or SVG. Codes you keep are stored on your machine.',
    action: 'Open Tessera',
    theme: 'tessera',
    accent: '#6b4bc4',
    accentSoft: '#e8e3f7',
    storage: 'IndexedDB and localStorage',
    features: [
      'Nine payload builders including wifi, vCard, and calendar events',
      'A QR encoder written from scratch, versions 1 to 40',
      'Error correction, module colours, quiet zone, and scale controls',
      'PNG and SVG download, plus a saved library of your codes',
    ],
    keywords: ['qr code generator', 'wifi qr code', 'vcard qr', 'offline qr generator'],
  },
  {
    slug: 'rostrum',
    category: 'make',
    name: 'Rostrum',
    tagline: 'Build the deck, then stand behind it',
    description:
      'Slides made of blocks, with a presenter view in a second window carrying your notes, a timer and the next slide. Import from Markdown, export to Markdown, a PDF, or one self-contained HTML file that runs on any machine with no network at all.',
    action: 'Open Rostrum',
    theme: 'rostrum',
    accent: '#5b4bbd',
    accentSoft: '#e6e2f7',
    storage: 'IndexedDB and localStorage',
    features: [
      'Six themes, five layouts, and eight kinds of block',
      'Presenter view with speaker notes, a timer, and the next slide',
      'Markdown in and out, with three dashes between slides',
      'Export a PDF, or one HTML file that needs nothing else to run',
    ],
    keywords: ['presentation tool', 'slide deck', 'markdown slides', 'presenter view', 'offline slides'],
  },
  {
    slug: 'quire',
    category: 'make',
    name: 'Quire',
    tagline: 'Rearrange PDFs without handing them to anyone',
    description:
      'Merge, split, reorder, rotate and extract PDF pages entirely on your own machine. Every other tool that does this uploads your documents to a server first. This one parses the file, moves the objects, and writes a new one, all in the tab you are looking at.',
    action: 'Open Quire',
    theme: 'quire',
    accent: '#a03d55',
    accentSoft: '#f6e0e6',
    storage: 'none',
    features: [
      'Merge several files, reorder by dragging, rotate and delete pages',
      'Split into chunks of any size, delivered as a ZIP',
      'Turn images into PDF pages',
      'Preview through your browser\u2019s own viewer, so nothing extra loads',
    ],
    keywords: ['merge pdf', 'split pdf', 'rotate pdf', 'pdf editor', 'offline pdf tool'],
  },
  {
    slug: 'fabler',
    category: 'data',
    name: 'Fabler',
    tagline: 'Believable data, reproducible every time',
    description:
      'Describe a schema and get realistic rows out of it. Everything is generated from a seed, so the same schema produces the same data every run, and foreign keys draw only from ids that actually exist in the table they point at.',
    action: 'Open Fabler',
    theme: 'fabler',
    accent: '#2f7d4f',
    accentSoft: '#dcf0e4',
    storage: 'localStorage',
    features: [
      'Nearly forty field types, from names and addresses to IPs and timestamps',
      'Seeded generation, so a demo can be reproduced exactly',
      'Foreign keys across tables that keep referential integrity',
      'Output as JSON, NDJSON, CSV, SQL inserts, or a CREATE TABLE script',
    ],
    keywords: ['test data generator', 'mock data', 'fake data', 'sample data', 'seed database'],
  },
  {
    slug: 'decanter',
    category: 'data',
    name: 'Decanter',
    tagline: 'Pour data from one shape into another',
    description:
      'Convert between JSON, NDJSON, CSV, YAML and TOML, with every parser written from scratch so none of it leaves your machine. Then the parts that make it more than a converter: flatten and unflatten nesting, query by path, and generate a SQL, Iceberg or JSON Schema from whatever you pasted.',
    action: 'Open Decanter',
    theme: 'decanter',
    accent: '#8a5a2b',
    accentSoft: '#f2e7da',
    storage: 'localStorage',
    features: [
      'Five formats, converted in any direction, with the input format detected',
      'Flatten and unflatten nesting, and query with a JSONPath-style expression',
      'Schema inference reporting types, nullability and how often a field appears',
      'Generates SQL DDL, an Iceberg schema, or a JSON Schema',
    ],
    keywords: ['json to yaml', 'csv to json', 'toml converter', 'json schema generator', 'jsonpath'],
  },
  {
    slug: 'loupe',
    category: 'make',
    name: 'Loupe',
    tagline: 'Resize and convert without uploading anything',
    description:
      'Resize, crop, rotate, convert and compress images entirely on your own machine. It reads the EXIF metadata first and shows you what is in there, including the location tags, so you can see exactly what re-encoding strips out.',
    action: 'Open Loupe',
    theme: 'loupe',
    accent: '#4a6fa5',
    accentSoft: '#e3ebf5',
    storage: 'localStorage',
    features: [
      'Resize to fit, to an exact size, or by percentage',
      'Convert between JPEG, PNG and WebP with a quality control',
      'Reads EXIF and flags the tags that identify you or a place',
      'Batch process and save everything as one ZIP',
    ],
    keywords: ['image resizer', 'image converter', 'compress images', 'strip exif', 'offline image editor'],
  },
  {
    slug: 'stint',
    category: 'plan',
    name: 'Stint',
    tagline: 'Where the hours actually went',
    description:
      'A time tracker sized for one person. Run a timer or enter time after the fact, assign it to a project with a rate, and get totals by day, week and project. Rounding is applied when the number is reported, so the entry keeps what really happened.',
    action: 'Open Stint',
    theme: 'stint',
    accent: '#0d7a8c',
    accentSoft: '#daf0f3',
    storage: 'IndexedDB and localStorage',
    features: [
      'A running timer, or type a duration like 1:30 or 90m',
      'Projects with clients, colours and hourly rates',
      'Rounding to the nearest, up or down, in six or fifteen minute steps',
      'Day and week views, totals per project, and CSV export for invoicing',
    ],
    keywords: ['time tracker', 'timesheet', 'billable hours', 'freelance time tracking'],
  },
  {
    slug: 'rote',
    category: 'plan',
    name: 'Rote',
    tagline: 'Flashcards that know when to ask again',
    description:
      'Spaced repetition built on SM-2, the algorithm behind most flashcard software. Every answer adjusts the card\u2019s ease, which decides how fast its interval grows, so material you find hard comes back sooner and material you know gets out of your way.',
    action: 'Open Rote',
    theme: 'rote',
    accent: '#c2415c',
    accentSoft: '#f8e2e7',
    storage: 'IndexedDB and localStorage',
    features: [
      'SM-2 scheduling with ease, intervals, and lapse tracking',
      'Review by keyboard, with a fortnight forecast of what is coming',
      'Retention and average ease per deck',
      'CSV import and export, so a spreadsheet is enough to start',
    ],
    keywords: ['flashcards', 'spaced repetition', 'sm-2', 'anki alternative', 'study app'],
  },
  {
    slug: 'sift',
    category: 'count',
    name: 'Sift',
    tagline: 'Regular expressions, explained as you build them',
    description:
      'A regex workbench with live match highlighting, capture groups broken out one by one, a replacement preview, and a plain English explanation of what your pattern actually says. Matching runs in a worker, so a pattern that backtracks badly gets stopped rather than freezing the page.',
    action: 'Open Sift',
    theme: 'sift',
    accent: '#7a5195',
    accentSoft: '#ece4f2',
    storage: 'IndexedDB and localStorage',
    features: [
      'Live highlighting with numbered and named capture groups',
      'A replacement preview that shows the real result',
      'Plain English explanation of every piece of the pattern',
      'Ten worked example patterns, and your own saved library',
    ],
    keywords: ['regex tester', 'regular expression', 'regex explainer', 'regex builder'],
  },
  {
    slug: 'cadence',
    category: 'make',
    name: 'Cadence',
    tagline: 'Record and edit audio without uploading it',
    description:
      'Record from the microphone or drop in a file, then trim, cut, fade, normalise, reverse, resample, or join clips end to end with a crossfade. The WAV writer is part of the app, so what comes out is exact rather than whatever a server decided to give back.',
    action: 'Open Cadence',
    theme: 'cadence',
    accent: '#8c4a6b',
    accentSoft: '#f4e3ec',
    storage: 'IndexedDB and localStorage',
    features: [
      'Microphone recording, with the clip stored in this browser only',
      'Trim, cut, fade, normalise by peak or by average level, reverse, resample',
      'Join clips end to end with an equal power crossfade',
      'WAV out at 16, 24, or 32 bit float, written by the app itself',
    ],
    keywords: ['audio editor', 'voice recorder', 'trim audio', 'wav converter', 'browser audio editor'],
  },
  {
    slug: 'ordinate',
    category: 'data',
    name: 'Ordinate',
    tagline: 'Paste data, get a chart worth publishing',
    description:
      'Drop in CSV, tab separated text from a spreadsheet, or JSON, and get a chart back. Eight chart types, axis ticks that land on numbers people recognise, five palettes, and an SVG that opens anywhere because every colour and every coordinate is written into the file.',
    action: 'Open Ordinate',
    theme: 'ordinate',
    accent: '#1f5f8b',
    accentSoft: '#dfeaf3',
    storage: 'IndexedDB and localStorage',
    features: [
      'Bars, grouped and stacked bars, lines, areas, scatter, pie, and doughnut',
      'Reads CSV, TSV, pipe or semicolon separated text, and JSON',
      'Axis ticks chosen to land on round numbers, not on arbitrary fractions',
      'Download as SVG, or as PNG at up to four times the size',
    ],
    keywords: ['chart maker', 'csv to chart', 'graph generator', 'svg chart', 'online chart tool'],
  },
  {
    slug: 'tally',
    category: 'make',
    name: 'Tally',
    tagline: 'Invoices that never leave your machine',
    description:
      'Build an invoice and watch the finished PDF redraw beside you as you type. Money is held in whole cents so the arithmetic is exact, tax can differ line by line, discounts are shared across rates in proportion, and the sender details carry over to the next invoice you start.',
    action: 'Open Tally',
    theme: 'tally',
    accent: '#7a6a1f',
    accentSoft: '#f1ecd6',
    storage: 'IndexedDB and localStorage',
    features: [
      'A live PDF preview, drawn in the browser rather than on a server',
      'Per-line tax rates, with a tax summary that shows its working',
      'Percentage or fixed discounts, apportioned across rates before tax',
      'Duplicate an invoice, and export to PDF, CSV, or plain text',
    ],
    keywords: ['invoice generator', 'free invoice maker', 'invoice pdf', 'freelance invoice', 'offline invoicing'],
  },
  {
    slug: 'reckoner',
    category: 'count',
    name: 'Reckoner',
    tagline: 'A calculator that shows its working',
    description:
      'Type whole expressions rather than pressing one key at a time. Parentheses, powers, factorials, and thirty functions all parse properly, every result lands on a tape you can scroll back through and reuse, and four memory registers hold whatever you need to keep.',
    action: 'Open Reckoner',
    theme: 'reckoner',
    accent: '#c07a12',
    accentSoft: '#f7ecd8',
    storage: 'localStorage',
    features: [
      'A real expression parser: precedence, parentheses, unary signs',
      'Thirty functions, constants, degrees or radians',
      'A running tape you can click to reuse any earlier line',
      'Memory registers, ans, and full keyboard control',
    ],
    keywords: ['calculator', 'scientific calculator', 'expression calculator', 'calculator with history'],
  },
];

export const appsBySlug = new Map(apps.map((app) => [app.slug, app]));

export function appsByCategory(): { category: (typeof CATEGORIES)[number]; entries: AppEntry[] }[] {
  return CATEGORIES
    .map((category) => ({ category, entries: apps.filter((app) => app.category === category.id) }))
    .filter((group) => group.entries.length > 0);
}

export function getApp(slug: string): AppEntry {
  const app = appsBySlug.get(slug);
  if (!app) throw new Error(`No app registered with slug "${slug}"`);
  return app;
}
