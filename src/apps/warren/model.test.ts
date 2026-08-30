import { describe, expect, it } from 'vitest';
import {
  BLOCK_TYPES,
  MAX_INDENT,
  ancestorsOf,
  breakCycles,
  buildTree,
  canMoveUnder,
  childrenOf,
  createBlock,
  createPage,
  descendantsOf,
  indentBlock,
  isList,
  livePages,
  movePage,
  orderedNumber,
  reorderPage,
  reparentOrphans,
  restorePage,
  revivePage,
  search,
  shortcutFor,
  starterPages,
  toMarkdown,
  trashPage,
  trashedRoots,
  typeAfterEnter,
  wordCount,
  type Block,
  type Page,
} from './model';

const NOW = new Date('2026-06-15T12:00:00Z');

function tree() {
  const root = createPage(null, 'Root', NOW);
  const childA = { ...createPage(root.id, 'Child A', NOW), rank: 1 };
  const childB = { ...createPage(root.id, 'Child B', NOW), rank: 2 };
  const grandchild = { ...createPage(childA.id, 'Grandchild', NOW), rank: 1 };
  const other = { ...createPage(null, 'Other root', NOW), rank: 2 };
  return { root, childA, childB, grandchild, other, pages: [root, childA, childB, grandchild, other] };
}

describe('the page tree', () => {
  it('lists children in rank order', () => {
    const { root, pages } = tree();
    expect(childrenOf(pages, root.id).map((p) => p.title)).toEqual(['Child A', 'Child B']);
  });

  it('lists top-level pages under a null parent', () => {
    const { pages } = tree();
    expect(childrenOf(pages, null).map((p) => p.title)).toEqual(['Root', 'Other root']);
  });

  it('builds a nested tree with depths', () => {
    const { pages } = tree();
    const nodes = buildTree(pages);
    expect(nodes).toHaveLength(2);
    expect(nodes[0].depth).toBe(0);
    expect(nodes[0].children[0].depth).toBe(1);
    expect(nodes[0].children[0].children[0].page.title).toBe('Grandchild');
  });

  it('walks ancestors for breadcrumbs', () => {
    const { grandchild, pages } = tree();
    expect(ancestorsOf(pages, grandchild.id).map((p) => p.title)).toEqual(['Root', 'Child A', 'Grandchild']);
  });

  it('does not hang on a cycle when walking ancestors', () => {
    const a = createPage(null, 'A', NOW);
    const b = { ...createPage(a.id, 'B', NOW) };
    const cyclic = [{ ...a, parentId: b.id }, b];
    expect(ancestorsOf(cyclic, b.id).length).toBeLessThanOrEqual(2);
  });

  it('collects every descendant', () => {
    const { root, pages } = tree();
    expect(descendantsOf(pages, root.id).map((p) => p.title).sort())
      .toEqual(['Child A', 'Child B', 'Grandchild']);
  });
});

describe('moving pages', () => {
  it('allows a move to an unrelated page', () => {
    const { childA, other, pages } = tree();
    expect(canMoveUnder(pages, childA.id, other.id)).toBe(true);
  });

  it('refuses to move a page under itself', () => {
    const { root, pages } = tree();
    expect(canMoveUnder(pages, root.id, root.id)).toBe(false);
  });

  it('refuses to move a page under its own descendant', () => {
    const { root, grandchild, pages } = tree();
    expect(canMoveUnder(pages, root.id, grandchild.id)).toBe(false);
    expect(movePage(pages, root.id, grandchild.id, NOW)).toBe(pages);
  });

  it('always allows a move to the top level', () => {
    const { grandchild, pages } = tree();
    const moved = movePage(pages, grandchild.id, null, NOW);
    expect(moved.find((p) => p.id === grandchild.id)?.parentId).toBeNull();
  });

  it('reorders among siblings', () => {
    const { root, childB, pages } = tree();
    const moved = reorderPage(pages, childB.id, 'up', NOW);
    expect(childrenOf(moved, root.id).map((p) => p.title)).toEqual(['Child B', 'Child A']);
  });

  it('will not reorder past the ends', () => {
    const { childA, childB, pages } = tree();
    expect(reorderPage(pages, childA.id, 'up', NOW)).toBe(pages);
    expect(reorderPage(pages, childB.id, 'down', NOW)).toBe(pages);
  });
});

describe('trash', () => {
  it('takes the whole branch when a parent is trashed', () => {
    const { root, pages } = tree();
    const trashed = trashPage(pages, root.id, NOW);
    expect(livePages(trashed).map((p) => p.title)).toEqual(['Other root']);
  });

  it('restores the whole branch', () => {
    const { root, pages } = tree();
    const restored = restorePage(trashPage(pages, root.id, NOW), root.id, NOW);
    expect(livePages(restored)).toHaveLength(5);
  });

  it('lists only the top of each trashed branch', () => {
    const { root, pages } = tree();
    const trashed = trashPage(pages, root.id, NOW);
    expect(trashedRoots(trashed).map((p) => p.title)).toEqual(['Root']);
  });

  it('brings an orphan back to the top level when its parent is still binned', () => {
    const { root, childA, pages } = tree();
    const trashed = trashPage(pages, root.id, NOW);
    const restored = restorePage(trashed, childA.id, NOW);
    const revived = restored.find((p) => p.id === childA.id);
    expect(revived?.trashedAt).toBeNull();
    expect(revived?.parentId).toBeNull();
  });

  it('does not re-stamp pages already in the trash', () => {
    const { root, childA, pages } = tree();
    const first = trashPage(pages, childA.id, NOW);
    const later = new Date('2026-08-01T00:00:00Z');
    const second = trashPage(first, root.id, later);
    expect(second.find((p) => p.id === childA.id)?.trashedAt).toBe(NOW.toISOString());
  });
});

describe('markdown shortcuts', () => {
  it('recognises every documented prefix', () => {
    expect(shortcutFor('# Title')).toEqual({ type: 'heading1', rest: 'Title' });
    expect(shortcutFor('## Sub')).toEqual({ type: 'heading2', rest: 'Sub' });
    expect(shortcutFor('### Small')).toEqual({ type: 'heading3', rest: 'Small' });
    expect(shortcutFor('- point')).toEqual({ type: 'bulleted', rest: 'point' });
    expect(shortcutFor('* point')).toEqual({ type: 'bulleted', rest: 'point' });
    expect(shortcutFor('1. step')).toEqual({ type: 'numbered', rest: 'step' });
    expect(shortcutFor('3) step')).toEqual({ type: 'numbered', rest: 'step' });
    expect(shortcutFor('[] task')).toEqual({ type: 'todo', rest: 'task' });
    expect(shortcutFor('[x] done')).toEqual({ type: 'todo', rest: 'done' });
    expect(shortcutFor('> quoted')).toEqual({ type: 'quote', rest: 'quoted' });
    expect(shortcutFor('! notice')).toEqual({ type: 'callout', rest: 'notice' });
    expect(shortcutFor('```')).toEqual({ type: 'code', rest: '' });
    expect(shortcutFor('---')).toEqual({ type: 'divider', rest: '' });
  });

  it('leaves ordinary text alone', () => {
    expect(shortcutFor('Hello')).toBeNull();
    expect(shortcutFor('#nospace')).toBeNull();
    expect(shortcutFor('')).toBeNull();
  });

  it('matches the longest heading prefix first', () => {
    expect(shortcutFor('### x')?.type).toBe('heading3');
  });
});

describe('blocks', () => {
  it('knows which types are lists', () => {
    expect(isList('bulleted')).toBe(true);
    expect(isList('todo')).toBe(true);
    expect(isList('paragraph')).toBe(false);
  });

  it('continues a list on Enter and drops back to a paragraph otherwise', () => {
    expect(typeAfterEnter('bulleted')).toBe('bulleted');
    expect(typeAfterEnter('heading1')).toBe('paragraph');
    expect(typeAfterEnter('quote')).toBe('paragraph');
  });

  it('indents only list blocks, within bounds', () => {
    const list = [{ ...createBlock('bulleted'), id: 'a' }];
    expect(indentBlock(list, 'a', 1)[0].indent).toBe(1);
    expect(indentBlock(list, 'a', -1)[0].indent).toBe(0);

    let deep: Block[] = list;
    for (let i = 0; i < 10; i += 1) deep = indentBlock(deep, 'a', 1);
    expect(deep[0].indent).toBe(MAX_INDENT);

    const paragraph = [{ ...createBlock('paragraph'), id: 'p' }];
    expect(indentBlock(paragraph, 'p', 1)[0].indent).toBe(0);
  });

  it('numbers an ordered run and restarts after other content', () => {
    const blocks: Block[] = [
      { ...createBlock('numbered'), text: 'one' },
      { ...createBlock('numbered'), text: 'two' },
      { ...createBlock('paragraph'), text: 'break' },
      { ...createBlock('numbered'), text: 'restart' },
    ];
    expect(orderedNumber(blocks, 0)).toBe(1);
    expect(orderedNumber(blocks, 1)).toBe(2);
    expect(orderedNumber(blocks, 3)).toBe(1);
  });

  it('ships eleven block types with distinct ids', () => {
    expect(BLOCK_TYPES).toHaveLength(11);
    expect(new Set(BLOCK_TYPES.map((t) => t.id)).size).toBe(11);
  });
});

describe('search', () => {
  const pages: Page[] = [
    { ...createPage(null, 'Grocery list', NOW), blocks: [{ ...createBlock('bulleted'), text: 'oat milk and coffee' }] },
    { ...createPage(null, 'Reading', NOW), blocks: [{ ...createBlock('paragraph'), text: 'A book about coffee history' }] },
    { ...createPage(null, 'Binned', NOW), trashedAt: NOW.toISOString(), blocks: [{ ...createBlock('paragraph'), text: 'coffee' }] },
  ];

  it('returns nothing for an empty query', () => {
    expect(search(pages, '   ')).toEqual([]);
  });

  it('matches titles and marks them as such', () => {
    const hits = search(pages, 'grocery');
    expect(hits).toHaveLength(1);
    expect(hits[0].where).toBe('title');
  });

  it('matches body text with a snippet', () => {
    const hits = search(pages, 'oat milk');
    expect(hits[0].where).toBe('body');
    expect(hits[0].snippet).toContain('oat milk');
  });

  it('requires every word', () => {
    expect(search(pages, 'coffee history')).toHaveLength(1);
    expect(search(pages, 'coffee bicycle')).toHaveLength(0);
  });

  it('skips pages in the trash', () => {
    expect(search(pages, 'coffee').every((hit) => hit.page.title !== 'Binned')).toBe(true);
  });

  it('is case insensitive', () => {
    expect(search(pages, 'GROCERY')).toHaveLength(1);
  });
});

describe('wordCount', () => {
  it('counts words across blocks and ignores dividers', () => {
    const page = { ...createPage(null, 'x', NOW), blocks: [
      { ...createBlock('paragraph'), text: 'one two three' },
      { ...createBlock('divider'), text: 'ignored text' },
      { ...createBlock('bulleted'), text: 'four' },
    ] };
    expect(wordCount(page)).toBe(4);
  });

  it('returns zero for an empty page', () => {
    expect(wordCount(createPage(null, 'x', NOW))).toBe(0);
  });
});

describe('markdown export', () => {
  it('renders every block type', () => {
    const page = { ...createPage(null, 'Doc', NOW), icon: '📘', blocks: [
      { ...createBlock('paragraph'), text: 'Intro line' },
      { ...createBlock('heading1'), text: 'Big' },
      { ...createBlock('bulleted'), text: 'a point' },
      { ...createBlock('numbered'), text: 'first step' },
      { ...createBlock('todo'), text: 'do it', checked: true },
      { ...createBlock('todo'), text: 'not yet' },
      { ...createBlock('quote'), text: 'quoted' },
      { ...createBlock('callout'), text: 'notice me' },
      { ...createBlock('divider'), text: '' },
      { ...createBlock('code'), text: 'const x = 1;' },
    ] };

    const markdown = toMarkdown(page);
    expect(markdown).toContain('# 📘 Doc');
    expect(markdown).toContain('## Big');
    expect(markdown).toContain('- a point');
    expect(markdown).toContain('1. first step');
    expect(markdown).toContain('- [x] do it');
    expect(markdown).toContain('- [ ] not yet');
    expect(markdown).toContain('> quoted');
    expect(markdown).toContain('> **Note:** notice me');
    expect(markdown).toContain('---');
    expect(markdown).toContain('```');
    expect(markdown).toContain('const x = 1;');
  });

  it('indents nested list items', () => {
    const page = { ...createPage(null, 'Doc', NOW), blocks: [
      { ...createBlock('bulleted'), text: 'top' },
      { ...createBlock('bulleted'), text: 'nested', indent: 1 },
    ] };
    expect(toMarkdown(page)).toContain('  - nested');
  });

  it('includes child pages as deeper headings', () => {
    const { root, pages } = tree();
    const markdown = toMarkdown(root, pages);
    expect(markdown).toContain('# Root');
    expect(markdown).toContain('## Child A');
    expect(markdown).toContain('### Grandchild');
  });

  it('does not leave long runs of blank lines', () => {
    const page = { ...createPage(null, 'Doc', NOW), blocks: [
      { ...createBlock('paragraph'), text: 'a' },
      { ...createBlock('paragraph'), text: '' },
      { ...createBlock('paragraph'), text: 'b' },
    ] };
    expect(toMarkdown(page)).not.toMatch(/\n{3,}/);
  });
});

describe('reviving imported pages', () => {
  it('rejects a record with no id', () => {
    expect(revivePage({ title: 'x' })).toBeNull();
    expect(revivePage(null)).toBeNull();
  });

  it('gives a page with no blocks one to type into', () => {
    expect(revivePage({ id: 'p' })?.blocks).toHaveLength(1);
  });

  it('falls back to a paragraph for an unknown block type', () => {
    const page = revivePage({ id: 'p', blocks: [{ type: 'hologram', text: 'x' }] });
    expect(page?.blocks[0].type).toBe('paragraph');
  });

  it('clamps a nonsense indent', () => {
    const page = revivePage({ id: 'p', blocks: [{ type: 'bulleted', text: 'x', indent: 99 }] });
    expect(page?.blocks[0].indent).toBe(MAX_INDENT);
  });

  it('drops a parent that is not in the file', () => {
    const pages = reparentOrphans([{ ...createPage(null, 'A', NOW), id: 'a', parentId: 'missing' }]);
    expect(pages[0].parentId).toBeNull();
  });

  it('breaks a parent cycle', () => {
    const a = { ...createPage(null, 'A', NOW), id: 'a', parentId: 'b' };
    const b = { ...createPage(null, 'B', NOW), id: 'b', parentId: 'a' };
    const fixed = breakCycles([a, b]);
    expect(fixed.filter((page) => page.parentId === null).length).toBeGreaterThan(0);
  });

  it('leaves a healthy tree alone', () => {
    const { pages } = tree();
    expect(breakCycles(pages).map((p) => p.parentId)).toEqual(pages.map((p) => p.parentId));
  });
});

describe('starterPages', () => {
  it('gives a new visitor a page with a child', () => {
    const pages = starterPages(NOW);
    expect(pages.length).toBeGreaterThanOrEqual(2);
    expect(childrenOf(pages, null)).toHaveLength(1);
    expect(childrenOf(pages, pages[0].id)).toHaveLength(1);
  });
});
