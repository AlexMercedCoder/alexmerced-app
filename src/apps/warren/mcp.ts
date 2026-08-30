import { nextRank } from '../../lib/id';
import { readBoolean, readNumber, readString, requireString, textResult, truncate, type McpTool } from '../../lib/webmcp';
import {
  ancestorsOf, blockPlainText, childrenOf, createBlock, createPage, livePages, shortcutFor,
  type Block, type BlockType, type Page,
} from './model';
import { loadPages, savePage } from './store';

/**
 * Warren's tools. A nested notebook is a good place for an agent to leave
 * something it has researched, so reading and writing are both offered, and
 * writing accepts Markdown because that is what an agent already produces.
 */
export function warrenTools(onChanged: () => void): McpTool[] {
  return [
    {
      name: 'warren_list_pages',
      description:
        'List the pages in this workspace as a tree, with their ids, titles, and how deep they sit. Call this first so you have the id of the page you want to read or write to.',
      inputSchema: {
        type: 'object',
        properties: {
          under: { type: 'string', description: 'Only the pages beneath this page id. The whole tree when omitted.' },
        },
      },
      execute: async (input) => {
        const pages = livePages(await loadPages());
        const under = readString(input, 'under') || null;

        const walk = (parentId: string | null, depth: number): unknown[] =>
          childrenOf(pages, parentId).map((page) => ({
            id: page.id,
            title: page.title || 'Untitled',
            depth,
            blocks: page.blocks.length,
            updatedAt: page.updatedAt,
            children: walk(page.id, depth + 1),
          }));

        return textResult({ pages: walk(under, 0), total: pages.length });
      },
    },
    {
      name: 'warren_read_page',
      description: 'Read one page as Markdown, with its title, where it sits in the tree, and its child pages.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      execute: async (input) => {
        const id = requireString(input, 'id');
        const pages = await loadPages();
        const page = pages.find((entry) => entry.id === id);
        if (!page) return textResult({ error: `No page with id "${id}".` });

        return textResult({
          id: page.id,
          title: page.title || 'Untitled',
          path: [...ancestorsOf(pages, page.id).map((entry) => entry.title || 'Untitled'), page.title || 'Untitled'].join(' / '),
          markdown: toMarkdown(page.blocks),
          children: childrenOf(livePages(pages), page.id).map((child) => ({ id: child.id, title: child.title || 'Untitled' })),
          updatedAt: page.updatedAt,
        });
      },
    },
    {
      name: 'warren_search',
      description: 'Search every page for text, and return the pages that match with the lines that matched.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' }, limit: { type: 'number' } },
        required: ['query'],
      },
      execute: async (input) => {
        const terms = requireString(input, 'query').toLowerCase().split(/\s+/).filter(Boolean);
        const limit = Math.max(1, Math.min(100, Math.round(readNumber(input, 'limit', 20))));
        const pages = livePages(await loadPages());

        const matches = pages
          .map((page) => {
            const lines = page.blocks.map(blockPlainText).filter(Boolean);
            const haystack = [page.title, ...lines].join('\n').toLowerCase();
            if (!terms.every((term) => haystack.includes(term))) return null;
            return {
              id: page.id,
              title: page.title || 'Untitled',
              hits: lines.filter((line) => terms.some((term) => line.toLowerCase().includes(term))).slice(0, 3),
            };
          })
          .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

        const trimmed = truncate(matches, limit);
        return textResult({ query: terms.join(' '), total: trimmed.total, pages: trimmed.items });
      },
    },
    {
      name: 'warren_create_page',
      description:
        'Add a page to this workspace, optionally under another page. The body is read as Markdown: headings, lists, to-do items, quotes, code fences and dividers all become the matching block. Saved to this browser straight away.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          markdown: { type: 'string', description: 'The body, as Markdown.' },
          parentId: { type: 'string', description: 'Nest it under this page. Top level when omitted.' },
        },
        required: ['title'],
      },
      execute: async (input) => {
        const title = requireString(input, 'title');
        const parentId = readString(input, 'parentId') || null;
        const pages = await loadPages();

        if (parentId && !pages.some((entry) => entry.id === parentId)) {
          return textResult({ error: `No page with id "${parentId}" to nest under.` });
        }

        const siblings = childrenOf(livePages(pages), parentId);
        const page = createPage(parentId, title);
        page.rank = nextRank(siblings);
        page.blocks = fromMarkdown(readString(input, 'markdown'));

        await savePage(page);
        onChanged();
        return textResult({ created: { id: page.id, title: page.title, blocks: page.blocks.length } });
      },
    },
    {
      name: 'warren_append_to_page',
      description:
        'Add Markdown to the end of a page that already exists, without disturbing what is there. Use this to keep adding to a running note.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          markdown: { type: 'string' },
          replace: { type: 'boolean', description: 'Replace the whole body instead of appending. False by default.' },
        },
        required: ['id', 'markdown'],
      },
      execute: async (input) => {
        const id = requireString(input, 'id');
        const markdown = requireString(input, 'markdown');
        const replace = readBoolean(input, 'replace', false);

        const pages = await loadPages();
        const page = pages.find((entry) => entry.id === id);
        if (!page) return textResult({ error: `No page with id "${id}".` });

        const added = fromMarkdown(markdown);
        const updated: Page = {
          ...page,
          blocks: replace ? added : [...page.blocks, ...added],
          updatedAt: new Date().toISOString(),
        };

        await savePage(updated);
        onChanged();
        return textResult({ id, blocksAdded: added.length, totalBlocks: updated.blocks.length, replaced: replace });
      },
    },
  ];
}

/** Blocks back to Markdown, which is the form an agent can read and rewrite. */
function toMarkdown(blocks: Block[]): string {
  const lines: string[] = [];
  let ordinal = 0;

  for (const block of blocks) {
    const indent = '  '.repeat(Math.max(0, block.indent ?? 0));
    const text = block.text ?? '';
    if (block.type !== 'numbered') ordinal = 0;

    switch (block.type) {
      case 'heading1': lines.push(`# ${text}`); break;
      case 'heading2': lines.push(`## ${text}`); break;
      case 'heading3': lines.push(`### ${text}`); break;
      case 'bulleted': lines.push(`${indent}- ${text}`); break;
      case 'numbered': ordinal += 1; lines.push(`${indent}${ordinal}. ${text}`); break;
      case 'todo': lines.push(`${indent}- [${block.checked ? 'x' : ' '}] ${text}`); break;
      case 'quote': lines.push(`> ${text}`); break;
      case 'callout': lines.push(`> **Note** ${text}`); break;
      case 'code': lines.push('```', text, '```'); break;
      case 'divider': lines.push('---'); break;
      default: lines.push(text);
    }
  }
  return lines.join('\n');
}

/** Markdown into blocks, reusing the same shortcuts the editor recognises. */
function fromMarkdown(markdown: string): Block[] {
  if (!markdown.trim()) return [];
  const blocks: Block[] = [];
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');

  let inCode = false;
  let codeLines: string[] = [];

  for (const raw of lines) {
    if (raw.trim().startsWith('```')) {
      if (inCode) {
        blocks.push(createBlock('code', codeLines.join('\n')));
        codeLines = [];
        inCode = false;
      } else {
        inCode = true;
      }
      continue;
    }
    if (inCode) { codeLines.push(raw); continue; }

    const indent = Math.min(3, Math.floor((raw.match(/^ */)?.[0].length ?? 0) / 2));
    const line = raw.trim();

    if (line === '') continue;
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) { blocks.push(createBlock('divider', '')); continue; }

    const todo = /^[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (todo) {
      const block = createBlock('todo', todo[2]);
      block.checked = todo[1].toLowerCase() === 'x';
      block.indent = indent;
      blocks.push(block);
      continue;
    }

    // The editor's own shortcut table handles headings, lists and quotes, so
    // the two ways of writing a page cannot drift apart.
    const shortcut = shortcutFor(`${line} `);
    if (shortcut) {
      const block = createBlock(shortcut.type as BlockType, shortcut.rest || line.replace(/^\S+\s*/, ''));
      block.indent = indent;
      blocks.push(block);
      continue;
    }

    const block = createBlock('paragraph', line);
    block.indent = indent;
    blocks.push(block);
  }

  if (inCode && codeLines.length) blocks.push(createBlock('code', codeLines.join('\n')));
  return blocks;
}
