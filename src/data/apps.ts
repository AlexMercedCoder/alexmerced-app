export type AppEntry = {
  slug: string;
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
    slug: 'fabler',
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
    slug: 'reckoner',
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

export function getApp(slug: string): AppEntry {
  const app = appsBySlug.get(slug);
  if (!app) throw new Error(`No app registered with slug "${slug}"`);
  return app;
}
