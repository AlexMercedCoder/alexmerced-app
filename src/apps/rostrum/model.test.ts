import { describe, expect, it } from 'vitest';
import {
  BLOCK_TYPES, LAYOUTS, THEMES, createBlock, createDeck, createSlide, fromMarkdown, move,
  reviveBlock, reviveDeck, reviveSlide, slideDimensions, slideLabel, starterDeck, themeOf, toMarkdown,
} from './model';

const NOW = new Date('2026-06-15T12:00:00Z');

describe('deck basics', () => {
  it('starts with one slide', () => {
    expect(createDeck('x', NOW).slides).toHaveLength(1);
  });

  it('gives a title layout a title and a subtitle', () => {
    expect(createSlide('title').blocks.map((b) => b.type)).toEqual(['title', 'subtitle']);
  });

  it('gives a statement layout one line', () => {
    expect(createSlide('statement').blocks).toHaveLength(1);
  });

  it('resolves the theme, falling back when unknown', () => {
    expect(themeOf({ ...createDeck('x', NOW), theme: 'paper' }).background).toBe('#faf8f4');
    expect(themeOf({ ...createDeck('x', NOW), theme: 'nope' as 'ink' }).id).toBe('ink');
  });

  it('sizes slides by ratio', () => {
    expect(slideDimensions('16:9')).toEqual({ width: 960, height: 540 });
    expect(slideDimensions('4:3')).toEqual({ width: 960, height: 720 });
  });

  it('ships eight block types, five layouts and six themes', () => {
    expect(BLOCK_TYPES).toHaveLength(8);
    expect(LAYOUTS).toHaveLength(5);
    expect(THEMES).toHaveLength(6);
  });
});

describe('slideLabel', () => {
  it('prefers a heading', () => {
    const slide = { ...createSlide('standard'), blocks: [createBlock('bullet', 'a point'), createBlock('title', 'The heading')] };
    expect(slideLabel(slide, 0)).toBe('The heading');
  });

  it('falls back to any text', () => {
    const slide = { ...createSlide('standard'), blocks: [createBlock('text', 'just prose')] };
    expect(slideLabel(slide, 0)).toBe('just prose');
  });

  it('falls back to the position when empty', () => {
    const slide = { ...createSlide('standard'), blocks: [createBlock('text', '')] };
    expect(slideLabel(slide, 3)).toBe('Slide 4');
  });

  it('truncates a long heading', () => {
    const slide = { ...createSlide('standard'), blocks: [createBlock('title', 'x'.repeat(80))] };
    expect(slideLabel(slide, 0).length).toBeLessThanOrEqual(40);
  });
});

describe('move', () => {
  it('reorders', () => {
    expect(move([1, 2, 3], 0, 2)).toEqual([2, 3, 1]);
  });

  it('is a no-op for the same index', () => {
    const items = [1, 2];
    expect(move(items, 0, 0)).toBe(items);
  });
});

describe('fromMarkdown', () => {
  it('splits slides on a rule', () => {
    expect(fromMarkdown('# One\n\n---\n\n# Two').slides).toHaveLength(2);
  });

  it('turns a first level heading into a title', () => {
    const slide = fromMarkdown('# Hello').slides[0];
    expect(slide.blocks[0]).toMatchObject({ type: 'title', text: 'Hello' });
  });

  it('turns deeper headings into subtitles', () => {
    expect(fromMarkdown('## Sub').slides[0].blocks[0].type).toBe('subtitle');
  });

  it('turns list items into bullets', () => {
    const blocks = fromMarkdown('# T\n- one\n- two').slides[0].blocks;
    expect(blocks.filter((b) => b.type === 'bullet').map((b) => b.text)).toEqual(['one', 'two']);
  });

  it('accepts the several bullet markers', () => {
    const blocks = fromMarkdown('- a\n* b\n+ c').slides[0].blocks;
    expect(blocks).toHaveLength(3);
    expect(blocks.every((b) => b.type === 'bullet')).toBe(true);
  });

  it('reads a quote', () => {
    expect(fromMarkdown('> quoted').slides[0].blocks[0]).toMatchObject({ type: 'quote', text: 'quoted' });
  });

  it('reads a fenced code block, keeping its lines', () => {
    const block = fromMarkdown('```\nconst a = 1;\nconst b = 2;\n```').slides[0].blocks[0];
    expect(block.type).toBe('code');
    expect(block.text).toBe('const a = 1;\nconst b = 2;');
  });

  it('does not treat a rule inside code as a slide break', () => {
    expect(fromMarkdown('```\n---\n```').slides).toHaveLength(1);
  });

  it('takes everything after Notes: as speaker notes', () => {
    const slide = fromMarkdown('# T\n\nNotes: remember the thing\nand the other thing').slides[0];
    expect(slide.notes).toContain('remember the thing');
    expect(slide.notes).toContain('other thing');
    expect(slide.blocks.every((b) => !b.text.includes('remember'))).toBe(true);
  });

  it('treats a heading-only slide as a title layout', () => {
    expect(fromMarkdown('# Just a title').slides[0].layout).toBe('title');
  });

  it('treats a slide with content as standard', () => {
    expect(fromMarkdown('# T\n- a point').slides[0].layout).toBe('standard');
  });

  it('skips empty chunks', () => {
    expect(fromMarkdown('# One\n\n---\n\n\n\n---\n\n# Two').slides).toHaveLength(2);
  });

  it('always produces at least one slide', () => {
    expect(fromMarkdown('').slides).toHaveLength(1);
  });
});

describe('toMarkdown', () => {
  it('writes headings, bullets, quotes and code', () => {
    const deck = createDeck('x', NOW);
    deck.slides = [{
      ...createSlide('standard'),
      blocks: [
        createBlock('title', 'Heading'),
        createBlock('subtitle', 'Sub'),
        createBlock('bullet', 'a point'),
        createBlock('quote', 'quoted'),
        createBlock('code', 'const a = 1;'),
      ],
      notes: 'say this',
    }];

    const markdown = toMarkdown(deck);
    expect(markdown).toContain('# Heading');
    expect(markdown).toContain('## Sub');
    expect(markdown).toContain('- a point');
    expect(markdown).toContain('> quoted');
    expect(markdown).toContain('```');
    expect(markdown).toContain('Notes: say this');
  });

  it('separates slides with a rule', () => {
    const deck = createDeck('x', NOW);
    deck.slides = [createSlide('title'), createSlide('title')];
    expect(toMarkdown(deck).split('\n---\n')).toHaveLength(2);
  });

  it('round trips a deck through Markdown', () => {
    const original = starterDeck(NOW);
    const reimported = fromMarkdown(toMarkdown(original));

    expect(reimported.slides).toHaveLength(original.slides.length);
    original.slides.forEach((slide, index) => {
      const titles = slide.blocks.filter((b) => b.type === 'title').map((b) => b.text);
      const reTitles = reimported.slides[index].blocks.filter((b) => b.type === 'title').map((b) => b.text);
      expect(reTitles).toEqual(titles);

      const bullets = slide.blocks.filter((b) => b.type === 'bullet').map((b) => b.text);
      const reBullets = reimported.slides[index].blocks.filter((b) => b.type === 'bullet').map((b) => b.text);
      expect(reBullets).toEqual(bullets);
    });
  });

  it('carries notes through a round trip', () => {
    const original = starterDeck(NOW);
    const reimported = fromMarkdown(toMarkdown(original));
    expect(reimported.slides[0].notes).toContain('presenter view');
  });
});

describe('reviving imported decks', () => {
  it('rejects a deck with no id', () => {
    expect(reviveDeck({ title: 'x' })).toBeNull();
  });

  it('gives a deck with no slides one to start from', () => {
    expect(reviveDeck({ id: 'd', slides: [] })?.slides).toHaveLength(1);
  });

  it('falls back for an unknown theme, layout and block type', () => {
    const deck = reviveDeck({
      id: 'd', theme: 'neon',
      slides: [{ layout: 'diagonal', blocks: [{ type: 'hologram', text: 'x' }] }],
    });
    expect(deck?.theme).toBe('ink');
    expect(deck?.slides[0].layout).toBe('standard');
    expect(deck?.slides[0].blocks[0].type).toBe('text');
  });

  it('rejects a background that is not a hex colour', () => {
    expect(reviveSlide({ blocks: [], background: 'red' })?.background).toBeNull();
    expect(reviveSlide({ blocks: [], background: '#123456' })?.background).toBe('#123456');
  });

  it('keeps a divider block that has no text', () => {
    expect(reviveBlock({ type: 'divider' })?.type).toBe('divider');
  });

  it('normalises the ratio', () => {
    expect(reviveDeck({ id: 'd', ratio: 'square' })?.ratio).toBe('16:9');
    expect(reviveDeck({ id: 'd', ratio: '4:3' })?.ratio).toBe('4:3');
  });
});

describe('starterDeck', () => {
  it('gives a new visitor something with notes to present', () => {
    const deck = starterDeck(NOW);
    expect(deck.slides.length).toBeGreaterThan(3);
    expect(deck.slides.every((slide) => slide.blocks.length > 0)).toBe(true);
    expect(deck.slides.some((slide) => slide.notes.trim())).toBe(true);
  });
});
