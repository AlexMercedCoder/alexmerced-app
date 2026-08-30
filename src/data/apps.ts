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
