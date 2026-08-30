import { createId } from '../../lib/id';

export const APP_ID = 'rostrum';
export const APP_VERSION = 1;

export const BLOCK_TYPES = [
  { id: 'title', label: 'Title', hint: 'The largest line on the slide' },
  { id: 'subtitle', label: 'Subtitle', hint: 'A line under the title' },
  { id: 'bullet', label: 'Bullet', hint: 'One point in a list' },
  { id: 'text', label: 'Text', hint: 'A paragraph' },
  { id: 'quote', label: 'Quote', hint: 'Set apart, larger' },
  { id: 'code', label: 'Code', hint: 'Monospaced, unformatted' },
  { id: 'image', label: 'Image', hint: 'A picture stored with the deck' },
  { id: 'divider', label: 'Divider', hint: 'A horizontal rule' },
] as const;

export type BlockType = (typeof BLOCK_TYPES)[number]['id'];

export type Block = {
  id: string;
  type: BlockType;
  text: string;
  /** For image blocks, the key of the stored blob. */
  imageId?: string;
};

export const LAYOUTS = [
  { id: 'title', label: 'Title slide', hint: 'Centred, for the opening' },
  { id: 'standard', label: 'Standard', hint: 'Heading at the top, content below' },
  { id: 'centered', label: 'Centred', hint: 'Everything in the middle' },
  { id: 'statement', label: 'Statement', hint: 'One large line, nothing else' },
  { id: 'two-column', label: 'Two columns', hint: 'Content split down the middle' },
] as const;

export type LayoutId = (typeof LAYOUTS)[number]['id'];

export type Slide = {
  id: string;
  layout: LayoutId;
  blocks: Block[];
  notes: string;
  /** Overrides the deck theme for this slide only. */
  background: string | null;
};

export const THEMES = [
  { id: 'ink', label: 'Ink', background: '#14161c', text: '#f5f6fa', accent: '#8fa2ff', mono: false },
  { id: 'paper', label: 'Paper', background: '#faf8f4', text: '#1a1a1a', accent: '#b4552d', mono: false },
  { id: 'slate', label: 'Slate', background: '#1e2a38', text: '#eef3f8', accent: '#5fd0c0', mono: false },
  { id: 'terminal', label: 'Terminal', background: '#0b1210', text: '#c8f7d4', accent: '#4ade80', mono: true },
  { id: 'blueprint', label: 'Blueprint', background: '#0f2a4a', text: '#e6f0fb', accent: '#f5c451', mono: false },
  { id: 'bright', label: 'Bright', background: '#ffffff', text: '#111111', accent: '#2f6f9f', mono: false },
] as const;

export type ThemeId = (typeof THEMES)[number]['id'];

export type Deck = {
  id: string;
  title: string;
  theme: ThemeId;
  ratio: '16:9' | '4:3';
  slides: Slide[];
  createdAt: string;
  updatedAt: string;
};

export function themeOf(deck: Deck) {
  return THEMES.find((theme) => theme.id === deck.theme) ?? THEMES[0];
}

export function createBlock(type: BlockType = 'bullet', text = ''): Block {
  return { id: createId('blk'), type, text };
}

export function createSlide(layout: LayoutId = 'standard'): Slide {
  const blocks = layout === 'title'
    ? [createBlock('title', 'Title'), createBlock('subtitle', 'Subtitle')]
    : layout === 'statement'
      ? [createBlock('title', 'One thing worth saying')]
      : [createBlock('title', 'Heading'), createBlock('bullet', 'First point')];

  return { id: createId('slide'), layout, blocks, notes: '', background: null };
}

export function createDeck(title = 'Untitled deck', now: Date = new Date()): Deck {
  const stamp = now.toISOString();
  return {
    id: createId('deck'),
    title,
    theme: 'ink',
    ratio: '16:9',
    slides: [createSlide('title')],
    createdAt: stamp,
    updatedAt: stamp,
  };
}

export function slideDimensions(ratio: Deck['ratio']): { width: number; height: number } {
  return ratio === '4:3' ? { width: 960, height: 720 } : { width: 960, height: 540 };
}

/** A short label for the slide list, taken from its first meaningful line. */
export function slideLabel(slide: Slide, index: number): string {
  const heading = slide.blocks.find((block) => block.type === 'title' || block.type === 'subtitle');
  const any = slide.blocks.find((block) => block.text.trim());
  const text = (heading?.text || any?.text || '').trim();
  return text ? text.slice(0, 40) : `Slide ${index + 1}`;
}

export function move<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= items.length) return items;
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(next.length, to)), 0, moved);
  return next;
}

// --------------------------------------------------------------------- markdown

/**
 * Reads a Markdown deck. Slides are separated by a rule, headings become
 * titles, list items become bullets, and anything after "Notes:" is speaker
 * notes rather than slide content.
 */
export function fromMarkdown(text: string, title = 'Imported deck'): Deck {
  const deck = createDeck(title);
  deck.slides = [];

  const chunks = text.split(/^\s*(?:---|\*\*\*|___)\s*$/m);

  for (const chunk of chunks) {
    const lines = chunk.split('\n');
    const slide = createSlide('standard');
    slide.blocks = [];

    let inCode = false;
    let codeText: string[] = [];
    let inNotes = false;

    for (const raw of lines) {
      const line = raw.trimEnd();

      if (line.trim().startsWith('```')) {
        if (inCode) { slide.blocks.push(createBlock('code', codeText.join('\n'))); codeText = []; inCode = false; }
        else inCode = true;
        continue;
      }
      if (inCode) { codeText.push(raw); continue; }

      if (/^\s*notes?\s*:/i.test(line)) { inNotes = true; slide.notes += line.replace(/^\s*notes?\s*:\s*/i, ''); continue; }
      if (inNotes) {
        if (!line.trim()) { inNotes = false; continue; }
        slide.notes += (slide.notes ? '\n' : '') + line.trim();
        continue;
      }

      if (!line.trim()) continue;

      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        slide.blocks.push(createBlock(heading[1].length === 1 ? 'title' : 'subtitle', heading[2].trim()));
        continue;
      }

      const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
      if (bullet) { slide.blocks.push(createBlock('bullet', bullet[1].trim())); continue; }

      const quote = /^\s*>\s?(.*)$/.exec(line);
      if (quote) { slide.blocks.push(createBlock('quote', quote[1].trim())); continue; }

      slide.blocks.push(createBlock('text', line.trim()));
    }

    if (inCode && codeText.length) slide.blocks.push(createBlock('code', codeText.join('\n')));
    if (!slide.blocks.length && !slide.notes.trim()) continue;

    // A slide that is only a title reads better centred.
    const headings = slide.blocks.filter((block) => block.type === 'title' || block.type === 'subtitle');
    if (headings.length === slide.blocks.length && slide.blocks.length <= 2) slide.layout = 'title';

    deck.slides.push(slide);
  }

  if (!deck.slides.length) deck.slides = [createSlide('title')];
  return deck;
}

export function toMarkdown(deck: Deck): string {
  const parts: string[] = [];

  for (const slide of deck.slides) {
    const lines: string[] = [];
    for (const block of slide.blocks) {
      switch (block.type) {
        case 'title': lines.push(`# ${block.text}`, ''); break;
        case 'subtitle': lines.push(`## ${block.text}`, ''); break;
        case 'bullet': lines.push(`- ${block.text}`); break;
        case 'quote': lines.push(`> ${block.text}`, ''); break;
        case 'code': lines.push('```', block.text, '```', ''); break;
        case 'divider': break;
        case 'image': lines.push(`![image](${block.imageId ?? ''})`, ''); break;
        default: lines.push(block.text, ''); break;
      }
    }
    if (slide.notes.trim()) lines.push('', `Notes: ${slide.notes.replace(/\n/g, '\n')}`);
    parts.push(lines.join('\n').trim());
  }

  return parts.join('\n\n---\n\n');
}

// --------------------------------------------------------------------- reviving

const KNOWN_BLOCKS = new Set<string>(BLOCK_TYPES.map((type) => type.id));
const KNOWN_LAYOUTS = new Set<string>(LAYOUTS.map((layout) => layout.id));
const KNOWN_THEMES = new Set<string>(THEMES.map((theme) => theme.id));

export function reviveBlock(value: unknown): Block | null {
  if (typeof value !== 'object' || value === null) return null;
  const block = value as Partial<Block>;
  if (typeof block.text !== 'string' && block.type !== 'divider' && block.type !== 'image') return null;
  return {
    id: typeof block.id === 'string' ? block.id : createId('blk'),
    type: KNOWN_BLOCKS.has(block.type as string) ? (block.type as BlockType) : 'text',
    text: typeof block.text === 'string' ? block.text : '',
    imageId: typeof block.imageId === 'string' ? block.imageId : undefined,
  };
}

export function reviveSlide(value: unknown): Slide | null {
  if (typeof value !== 'object' || value === null) return null;
  const slide = value as Partial<Slide>;
  const blocks = Array.isArray(slide.blocks)
    ? slide.blocks.map(reviveBlock).filter((block): block is Block => block !== null)
    : [];

  return {
    id: typeof slide.id === 'string' ? slide.id : createId('slide'),
    layout: KNOWN_LAYOUTS.has(slide.layout as string) ? (slide.layout as LayoutId) : 'standard',
    blocks: blocks.length ? blocks : [createBlock('title', '')],
    notes: typeof slide.notes === 'string' ? slide.notes : '',
    background: typeof slide.background === 'string' && /^#[0-9a-fA-F]{6}$/.test(slide.background) ? slide.background : null,
  };
}

export function reviveDeck(value: unknown): Deck | null {
  if (typeof value !== 'object' || value === null) return null;
  const deck = value as Partial<Deck>;
  if (typeof deck.id !== 'string') return null;

  const slides = Array.isArray(deck.slides)
    ? deck.slides.map(reviveSlide).filter((slide): slide is Slide => slide !== null)
    : [];
  const stamp = new Date().toISOString();

  return {
    id: deck.id,
    title: typeof deck.title === 'string' && deck.title.trim() ? deck.title : 'Untitled deck',
    theme: KNOWN_THEMES.has(deck.theme as string) ? (deck.theme as ThemeId) : 'ink',
    ratio: deck.ratio === '4:3' ? '4:3' : '16:9',
    slides: slides.length ? slides : [createSlide('title')],
    createdAt: typeof deck.createdAt === 'string' ? deck.createdAt : stamp,
    updatedAt: typeof deck.updatedAt === 'string' ? deck.updatedAt : stamp,
  };
}

export function starterDeck(now: Date = new Date()): Deck {
  const deck = createDeck('How Rostrum works', now);
  deck.slides = [
    {
      ...createSlide('title'),
      blocks: [createBlock('title', 'How Rostrum works'), createBlock('subtitle', 'A deck that lives in your browser')],
      notes: 'Open the presenter view from the bar above. It opens in a second window with these notes, a timer, and the next slide.',
    },
    {
      ...createSlide('standard'),
      blocks: [
        createBlock('title', 'Slides are made of blocks'),
        createBlock('bullet', 'Titles, subtitles, bullets, text, quotes and code'),
        createBlock('bullet', 'Pick a layout per slide, and a theme for the deck'),
        createBlock('bullet', 'Images are stored with the deck, not linked from elsewhere'),
      ],
      notes: 'The block model is the same idea as Warren, one shelf over.',
    },
    {
      ...createSlide('standard'),
      blocks: [
        createBlock('title', 'Getting text in and out'),
        createBlock('bullet', 'Import Markdown, with three dashes between slides'),
        createBlock('bullet', 'Export Markdown, a PDF, or one self-contained HTML file'),
        createBlock('bullet', 'A line beginning "Notes:" becomes speaker notes'),
      ],
      notes: 'The HTML export runs anywhere with no network, which is useful on a conference machine.',
    },
    {
      ...createSlide('statement'),
      blocks: [createBlock('title', 'Press F to present')],
      notes: 'Arrow keys move, Escape leaves, and P opens the presenter view.',
    },
  ];
  return deck;
}
