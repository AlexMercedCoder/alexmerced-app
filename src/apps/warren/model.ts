import { createId, nextRank, rankBetween } from '../../lib/id';

export const APP_ID = 'warren';
export const APP_VERSION = 1;

export const BLOCK_TYPES = [
  { id: 'paragraph', label: 'Text', hint: 'Plain writing', shortcut: '' },
  { id: 'heading1', label: 'Heading 1', hint: 'Section title', shortcut: '# ' },
  { id: 'heading2', label: 'Heading 2', hint: 'Sub-section', shortcut: '## ' },
  { id: 'heading3', label: 'Heading 3', hint: 'Smaller heading', shortcut: '### ' },
  { id: 'bulleted', label: 'Bulleted list', hint: 'An unordered point', shortcut: '- ' },
  { id: 'numbered', label: 'Numbered list', hint: 'An ordered step', shortcut: '1. ' },
  { id: 'todo', label: 'To-do', hint: 'Something with a checkbox', shortcut: '[] ' },
  { id: 'quote', label: 'Quote', hint: 'Set apart from the rest', shortcut: '> ' },
  { id: 'callout', label: 'Callout', hint: 'Something worth noticing', shortcut: '! ' },
  { id: 'code', label: 'Code', hint: 'Monospaced, unformatted', shortcut: '```' },
  { id: 'divider', label: 'Divider', hint: 'A horizontal rule', shortcut: '---' },
] as const;

export type BlockType = (typeof BLOCK_TYPES)[number]['id'];

export type Block = {
  id: string;
  type: BlockType;
  text: string;
  /** Only meaningful for to-do blocks. */
  checked: boolean;
  /** Indent level for list blocks, zero to three. */
  indent: number;
};

export type Page = {
  id: string;
  parentId: string | null;
  title: string;
  icon: string;
  blocks: Block[];
  rank: number;
  collapsed: boolean;
  trashedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export const MAX_INDENT = 3;

export function createBlock(type: BlockType = 'paragraph', text = ''): Block {
  return { id: createId('blk'), type, text, checked: false, indent: 0 };
}

export function createPage(parentId: string | null, title = '', now: Date = new Date()): Page {
  const stamp = now.toISOString();
  return {
    id: createId('page'),
    parentId,
    title,
    icon: '',
    blocks: [createBlock()],
    rank: 1,
    collapsed: false,
    trashedAt: null,
    createdAt: stamp,
    updatedAt: stamp,
  };
}

export function touch(page: Page, changes: Partial<Page>, now: Date = new Date()): Page {
  return { ...page, ...changes, updatedAt: now.toISOString() };
}

// --------------------------------------------------------------------- the tree

export function livePages(pages: Page[]): Page[] {
  return pages.filter((page) => page.trashedAt === null);
}

export function childrenOf(pages: Page[], parentId: string | null): Page[] {
  return livePages(pages)
    .filter((page) => page.parentId === parentId)
    .sort((a, b) => a.rank - b.rank || a.createdAt.localeCompare(b.createdAt));
}

export type TreeNode = { page: Page; depth: number; children: TreeNode[] };

export function buildTree(pages: Page[], parentId: string | null = null, depth = 0): TreeNode[] {
  return childrenOf(pages, parentId).map((page) => ({
    page,
    depth,
    children: buildTree(pages, page.id, depth + 1),
  }));
}

/** The path from the root down to a page, used for breadcrumbs. */
export function ancestorsOf(pages: Page[], pageId: string): Page[] {
  const byId = new Map(pages.map((page) => [page.id, page]));
  const trail: Page[] = [];
  let current = byId.get(pageId);
  const seen = new Set<string>();

  while (current) {
    if (seen.has(current.id)) break; // a cycle in imported data would otherwise hang
    seen.add(current.id);
    trail.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return trail;
}

/** Every descendant of a page, deepest last. */
export function descendantsOf(pages: Page[], pageId: string): Page[] {
  const result: Page[] = [];
  const queue = [pageId];
  const seen = new Set<string>([pageId]);

  while (queue.length) {
    const current = queue.shift()!;
    for (const page of pages) {
      if (page.parentId === current && !seen.has(page.id)) {
        seen.add(page.id);
        result.push(page);
        queue.push(page.id);
      }
    }
  }
  return result;
}

/** Moving a page under its own descendant would orphan the branch. */
export function canMoveUnder(pages: Page[], pageId: string, newParentId: string | null): boolean {
  if (pageId === newParentId) return false;
  if (newParentId === null) return true;
  return !descendantsOf(pages, pageId).some((page) => page.id === newParentId);
}

export function movePage(pages: Page[], pageId: string, newParentId: string | null, now: Date = new Date()): Page[] {
  if (!canMoveUnder(pages, pageId, newParentId)) return pages;
  const siblings = childrenOf(pages, newParentId).filter((page) => page.id !== pageId);
  const rank = nextRank(siblings);
  return pages.map((page) =>
    page.id === pageId ? touch(page, { parentId: newParentId, rank }, now) : page,
  );
}

export function reorderPage(pages: Page[], pageId: string, direction: 'up' | 'down', now: Date = new Date()): Page[] {
  const page = pages.find((item) => item.id === pageId);
  if (!page) return pages;

  const siblings = childrenOf(pages, page.parentId);
  const index = siblings.findIndex((item) => item.id === pageId);
  const targetIndex = index + (direction === 'up' ? -1 : 1);
  if (index === -1 || targetIndex < 0 || targetIndex >= siblings.length) return pages;

  const before = targetIndex > 0 ? siblings[direction === 'up' ? targetIndex - 1 : targetIndex].rank : null;
  const after = direction === 'up'
    ? siblings[targetIndex].rank
    : (targetIndex + 1 < siblings.length ? siblings[targetIndex + 1].rank : null);

  return pages.map((item) => (item.id === pageId ? touch(item, { rank: rankBetween(before, after) }, now) : item));
}

/** Trashing a page takes its whole branch with it, so restore can bring it back. */
export function trashPage(pages: Page[], pageId: string, now: Date = new Date()): Page[] {
  const stamp = now.toISOString();
  const branch = new Set([pageId, ...descendantsOf(pages, pageId).map((page) => page.id)]);
  return pages.map((page) =>
    branch.has(page.id) && page.trashedAt === null ? { ...page, trashedAt: stamp, updatedAt: stamp } : page,
  );
}

export function restorePage(pages: Page[], pageId: string, now: Date = new Date()): Page[] {
  const stamp = now.toISOString();
  const branch = new Set([pageId, ...descendantsOf(pages, pageId).map((page) => page.id)]);
  const byId = new Map(pages.map((page) => [page.id, page]));

  return pages.map((page) => {
    if (!branch.has(page.id)) return page;
    // A page whose parent is still in the trash comes back to the top level.
    const parent = page.parentId ? byId.get(page.parentId) : null;
    const orphaned = page.id === pageId && parent?.trashedAt;
    return { ...page, trashedAt: null, parentId: orphaned ? null : page.parentId, updatedAt: stamp };
  });
}

export function trashedRoots(pages: Page[]): Page[] {
  const byId = new Map(pages.map((page) => [page.id, page]));
  return pages
    .filter((page) => page.trashedAt !== null)
    .filter((page) => {
      const parent = page.parentId ? byId.get(page.parentId) : null;
      return !parent || parent.trashedAt === null;
    })
    .sort((a, b) => (b.trashedAt ?? '').localeCompare(a.trashedAt ?? ''));
}

// --------------------------------------------------------------------- blocks

/** Turns a markdown-style prefix into a block type, as it is typed. */
export function shortcutFor(text: string): { type: BlockType; rest: string } | null {
  const table: [RegExp, BlockType][] = [
    [/^###\s/, 'heading3'],
    [/^##\s/, 'heading2'],
    [/^#\s/, 'heading1'],
    [/^[-*]\s/, 'bulleted'],
    [/^\d+[.)]\s/, 'numbered'],
    [/^\[[ xX]?\]\s/, 'todo'],
    [/^>\s/, 'quote'],
    [/^!\s/, 'callout'],
  ];

  for (const [pattern, type] of table) {
    const match = pattern.exec(text);
    if (match) return { type, rest: text.slice(match[0].length) };
  }

  if (text === '```') return { type: 'code', rest: '' };
  if (text === '---' || text === '***') return { type: 'divider', rest: '' };
  return null;
}

export const LIST_TYPES: BlockType[] = ['bulleted', 'numbered', 'todo'];

export function isList(type: BlockType): boolean {
  return LIST_TYPES.includes(type);
}

/** Enter inside a list continues the list; anywhere else starts a paragraph. */
export function typeAfterEnter(type: BlockType): BlockType {
  return isList(type) ? type : 'paragraph';
}

export function indentBlock(blocks: Block[], blockId: string, delta: number): Block[] {
  return blocks.map((block) => {
    if (block.id !== blockId) return block;
    if (!isList(block.type)) return block;
    return { ...block, indent: Math.max(0, Math.min(MAX_INDENT, block.indent + delta)) };
  });
}

/** The visible number for an ordered item, counting only its own run and level. */
export function orderedNumber(blocks: Block[], index: number): number {
  const block = blocks[index];
  if (block.type !== 'numbered') return 1;
  let count = 1;
  for (let i = index - 1; i >= 0; i -= 1) {
    const previous = blocks[i];
    if (previous.type === 'numbered' && previous.indent === block.indent) count += 1;
    else if (previous.indent < block.indent && isList(previous.type)) continue;
    else break;
  }
  return count;
}

export function blockPlainText(block: Block): string {
  return block.type === 'divider' ? '' : block.text;
}

// --------------------------------------------------------------------- search

export type SearchHit = {
  page: Page;
  /** Where the match was found. */
  where: 'title' | 'body';
  snippet: string;
};

export function search(pages: Page[], query: string, limit = 30): SearchHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const words = needle.split(/\s+/);
  const hits: SearchHit[] = [];

  for (const page of livePages(pages)) {
    const title = page.title.toLowerCase();
    if (words.every((word) => title.includes(word))) {
      hits.push({ page, where: 'title', snippet: page.title || 'Untitled' });
      continue;
    }

    const body = page.blocks.map(blockPlainText).join('\n');
    const haystack = body.toLowerCase();
    if (words.every((word) => haystack.includes(word))) {
      const at = haystack.indexOf(words[0]);
      const start = Math.max(0, at - 30);
      hits.push({
        page,
        where: 'body',
        snippet: `${start > 0 ? '…' : ''}${body.slice(start, at + 70).trim()}${at + 70 < body.length ? '…' : ''}`,
      });
    }
  }

  return hits.slice(0, limit);
}

export function wordCount(page: Page): number {
  const text = page.blocks.map(blockPlainText).join(' ').trim();
  return text ? text.split(/\s+/).length : 0;
}

// --------------------------------------------------------------------- markdown

export function toMarkdown(page: Page, pages: Page[] = [], depth = 0): string {
  const lines: string[] = [];
  const heading = '#'.repeat(Math.min(6, depth + 1));
  lines.push(`${heading} ${page.icon ? `${page.icon} ` : ''}${page.title || 'Untitled'}`, '');

  let inCode = false;
  for (let i = 0; i < page.blocks.length; i += 1) {
    const block = page.blocks[i];
    const pad = '  '.repeat(block.indent);

    if (block.type === 'code') {
      if (!inCode) { lines.push('```'); inCode = true; }
      lines.push(block.text);
      const next = page.blocks[i + 1];
      if (!next || next.type !== 'code') { lines.push('```', ''); inCode = false; }
      continue;
    }

    switch (block.type) {
      case 'heading1': lines.push(`${'#'.repeat(Math.min(6, depth + 2))} ${block.text}`, ''); break;
      case 'heading2': lines.push(`${'#'.repeat(Math.min(6, depth + 3))} ${block.text}`, ''); break;
      case 'heading3': lines.push(`${'#'.repeat(Math.min(6, depth + 4))} ${block.text}`, ''); break;
      case 'bulleted': lines.push(`${pad}- ${block.text}`); break;
      case 'numbered': lines.push(`${pad}${orderedNumber(page.blocks, i)}. ${block.text}`); break;
      case 'todo': lines.push(`${pad}- [${block.checked ? 'x' : ' '}] ${block.text}`); break;
      case 'quote': lines.push(`> ${block.text}`, ''); break;
      case 'callout': lines.push(`> **Note:** ${block.text}`, ''); break;
      case 'divider': lines.push('---', ''); break;
      default: if (block.text.trim()) lines.push(block.text, ''); break;
    }
  }

  const children = childrenOf(pages, page.id);
  for (const child of children) {
    lines.push('', toMarkdown(child, pages, depth + 1));
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// --------------------------------------------------------------------- reviving

export function reviveBlock(value: unknown): Block | null {
  if (typeof value !== 'object' || value === null) return null;
  const block = value as Partial<Block>;
  if (typeof block.text !== 'string') return null;
  const known = new Set(BLOCK_TYPES.map((type) => type.id));
  return {
    id: typeof block.id === 'string' ? block.id : createId('blk'),
    type: known.has(block.type as BlockType) ? (block.type as BlockType) : 'paragraph',
    text: block.text,
    checked: block.checked === true,
    indent: typeof block.indent === 'number' ? Math.max(0, Math.min(MAX_INDENT, Math.floor(block.indent))) : 0,
  };
}

export function revivePage(value: unknown): Page | null {
  if (typeof value !== 'object' || value === null) return null;
  const page = value as Partial<Page>;
  if (typeof page.id !== 'string') return null;
  const stamp = new Date().toISOString();

  const blocks = Array.isArray(page.blocks)
    ? page.blocks.map(reviveBlock).filter((block): block is Block => block !== null)
    : [];

  return {
    id: page.id,
    parentId: typeof page.parentId === 'string' ? page.parentId : null,
    title: typeof page.title === 'string' ? page.title : '',
    icon: typeof page.icon === 'string' ? page.icon.slice(0, 4) : '',
    blocks: blocks.length ? blocks : [createBlock()],
    rank: typeof page.rank === 'number' && Number.isFinite(page.rank) ? page.rank : 1,
    collapsed: page.collapsed === true,
    trashedAt: typeof page.trashedAt === 'string' ? page.trashedAt : null,
    createdAt: typeof page.createdAt === 'string' ? page.createdAt : stamp,
    updatedAt: typeof page.updatedAt === 'string' ? page.updatedAt : stamp,
  };
}

/** Repairs parents that point at pages which are not in the file. */
export function reparentOrphans(pages: Page[]): Page[] {
  const ids = new Set(pages.map((page) => page.id));
  return pages.map((page) =>
    page.parentId && !ids.has(page.parentId) ? { ...page, parentId: null } : page,
  );
}

/** Breaks any parent cycle an edited file might contain. */
export function breakCycles(pages: Page[]): Page[] {
  const byId = new Map(pages.map((page) => [page.id, page]));
  return pages.map((page) => {
    const seen = new Set<string>([page.id]);
    let current = page.parentId ? byId.get(page.parentId) : null;
    while (current) {
      if (seen.has(current.id)) return { ...page, parentId: null };
      seen.add(current.id);
      current = current.parentId ? byId.get(current.parentId) : null;
    }
    return page;
  });
}

/** The pages a brand new visitor sees. */
export function starterPages(now: Date = new Date()): Page[] {
  const home = createPage(null, 'Welcome to Warren', now);
  home.icon = '🐇';
  home.blocks = [
    { ...createBlock('paragraph'), text: 'Warren is a place to write things down and let them nest. Pages hold blocks, and pages hold other pages, as deep as you need.' },
    { ...createBlock('heading2'), text: 'Try this' },
    { ...createBlock('todo'), text: 'Type / on an empty line to change what a block is' },
    { ...createBlock('todo'), text: 'Start a line with # or - or [] and watch it convert as you type' },
    { ...createBlock('todo'), text: 'Press Tab on a list item to indent it' },
    { ...createBlock('todo'), text: 'Add a page inside this one from the sidebar' },
    { ...createBlock('divider'), text: '' },
    { ...createBlock('callout'), text: 'Everything is saved to this browser as you type. Nothing is sent anywhere. Use Export in the bar above to take a copy with you.' },
  ];

  const child = createPage(home.id, 'A nested page', now);
  child.icon = '📄';
  child.rank = 1;
  child.blocks = [
    { ...createBlock('paragraph'), text: 'This page lives inside the welcome page. There is no limit to how deep the nesting goes.' },
    { ...createBlock('quote'), text: 'Pages within pages, all the way down.' },
    { ...createBlock('code'), text: 'const warren = { pages: "nested", storage: "yours" };' },
  ];

  return [home, child];
}
