import { AGENT_TOOLS, buildSkill } from '../data/agentGuide';
import { apps, CATEGORIES } from '../data/apps';
import { readStringArray, readString, registerTools, textResult, type McpTool } from './webmcp';

/**
 * The tools every page carries.
 *
 * These describe the site rather than doing any of its work: what each app is
 * for, which page to open for a given job, how storage behaves, and a skill
 * document an agent can save so it does not have to work all of that out again.
 *
 * This is a real module rather than an inline script so it can use the guide
 * builder directly. An inline script would have had to carry a copy of the
 * ranking logic, and a copy is a thing that goes stale.
 */

const catalog = apps.map((app) => ({
  slug: app.slug,
  name: app.name,
  category: app.category,
  tagline: app.tagline,
  description: app.description,
  features: app.features,
  storage: app.storage,
  keywords: app.keywords,
  url: `https://alexmerced.app/${app.slug}`,
}));

const categories = CATEGORIES.map((category) => ({
  id: category.id,
  label: category.label,
  blurb: category.blurb,
}));

const storagePolicy = {
  summary:
    'Every app runs entirely in the visitor’s browser. Records go in IndexedDB, interface preferences in localStorage. Nothing is uploaded, there is no account, and there is no analytics or third-party code.',
  consequences: [
    'Data is scoped to one browser on one device and does not sync.',
    'Private windows usually discard everything on close.',
    'Clearing site data deletes it, and it cannot be recovered by anyone.',
    'Nobody, the author included, can see what a visitor writes.',
  ],
  portability:
    'Every app exports its whole dataset as JSON using one shared envelope, and imports it back with a merge or replace choice. Merging keeps whichever copy was edited most recently.',
  offline:
    'The site installs as a progressive web app and works with no network at all after the first visit. Quarry is the exception: its database engine is fetched on demand and is not held offline.',
};

export function siteTools(): McpTool[] {
  const slugs = AGENT_TOOLS.map((entry) => entry.slug);

  return [
    {
      name: 'list_apps',
      description:
        'List every tool on alexmerced.app, with what it does, its features, where it stores data, and its URL. Categories are: write (notes), plan (tasks and time), data (format, query and chart tools), make (files: images, PDFs, audio, video, decks, QR codes), and count (calculator and regex).',
      inputSchema: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            enum: categories.map((entry) => entry.id),
            description: 'Optional category filter. Omit to list everything.',
          },
        },
      },
      execute: (input) => {
        const category = readString(input, 'category');
        return textResult({
          categories,
          apps: category ? catalog.filter((app) => app.category === category) : catalog,
        });
      },
    },
    {
      name: 'search_apps',
      description:
        'Find the tool on alexmerced.app that does a particular job. Searches names, taglines, descriptions, features and keywords. Try terms like "resize an image", "merge PDFs", "run sql on a csv", "make a chart", "read a qr code", "trim audio", "scan a document", "record my screen", "kanban", or "flashcards".',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'What you are trying to do.' } },
        required: ['query'],
      },
      execute: (input) => {
        const terms = readString(input, 'query').toLowerCase().trim().split(/\s+/).filter(Boolean);
        if (!terms.length) return textResult([]);

        const scored = catalog
          .map((app) => {
            const haystack = [app.name, app.tagline, app.description, app.features.join(' '), app.keywords.join(' ')]
              .join(' ')
              .toLowerCase();
            return { app, score: terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0) };
          })
          .filter((entry) => entry.score > 0)
          .sort((a, b) => b.score - a.score)
          .map((entry) => entry.app);

        return textResult(scored);
      },
    },
    {
      name: 'get_app',
      description: 'Get the full description of one tool on alexmerced.app by its slug.',
      inputSchema: {
        type: 'object',
        properties: { slug: { type: 'string', description: 'For example warren, quarry, tessera.' } },
        required: ['slug'],
      },
      execute: (input) => {
        const slug = readString(input, 'slug');
        const app = catalog.find((entry) => entry.slug === slug);
        return textResult(app ?? { error: `No app with slug "${slug}".`, available: catalog.map((entry) => entry.slug) });
      },
    },
    {
      name: 'get_agent_tools',
      description:
        'List what an agent can actually do on each page, as opposed to what each app is for. Every app page registers its own tools when it loads, so opening a page is what makes its capabilities callable: running SQL, rendering a chart, reading a QR code, editing audio, straightening a scanned page, adding a card to a board. Call this to find out which page to open for a given job.',
      inputSchema: {
        type: 'object',
        properties: { slug: { type: 'string', enum: slugs, description: 'Optional. Just this app’s tools.' } },
      },
      execute: (input) => {
        const slug = readString(input, 'slug');
        const chosen = slug ? AGENT_TOOLS.filter((entry) => entry.slug === slug) : AGENT_TOOLS;
        return textResult({
          note:
            'These become callable once the page is open. Everything runs in this browser against this browser’s own storage; none of it reaches a network.',
          totalTools: AGENT_TOOLS.reduce((sum, entry) => sum + entry.tools.length, 0),
          apps: chosen.map((entry) => ({
            slug: entry.slug,
            app: entry.app,
            url: `https://alexmerced.app${entry.page}`,
            purpose: entry.purpose,
            tools: entry.tools.map((tool) => `${tool.name}: ${tool.summary}`),
          })),
        });
      },
    },
    {
      name: 'build_skill',
      description:
        'Write a ready-to-save skill document for using alexmerced.app well: which page to open for which job, the tools each page carries, worked step-by-step recipes, and the traps that would otherwise be learned the hard way. Save the result as a skill file or a set of standing instructions and none of it has to be worked out again. Give a task to have the pages and recipes ordered around it, or name apps to narrow it to those.',
      inputSchema: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description:
              'What you are trying to do, in your own words. For example "query a CSV and chart the result", or "turn photographs of receipts into one PDF".',
          },
          apps: {
            type: 'array',
            items: { type: 'string', enum: slugs },
            description: 'Narrow the document to these apps. Omit for the whole guide.',
          },
        },
      },
      execute: (input) => {
        const task = readString(input, 'task');
        const wanted = readStringArray(input, 'apps').filter((slug) => slugs.includes(slug));
        const skill = buildSkill({ task, apps: wanted });

        return textResult({
          format: 'markdown',
          scope: wanted.length ? wanted.join(', ') : task ? `everything, ordered for: ${task}` : 'everything',
          bytes: skill.length,
          note: 'Save this as a skill file. It is written to stay useful without this page open.',
          skill,
        });
      },
    },
    {
      name: 'get_storage_policy',
      description:
        'Explain how alexmerced.app stores data, what that means for the visitor, and how data can be moved off the device. Use this before telling anyone their data is stored in the cloud, because it is not.',
      inputSchema: { type: 'object', properties: {} },
      execute: () => textResult(storagePolicy),
    },
  ];
}

export function registerSiteTools(): number {
  return registerTools(siteTools());
}
