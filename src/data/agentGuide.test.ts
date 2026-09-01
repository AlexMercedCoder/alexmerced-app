import { describe, expect, it } from 'vitest';
import { AGENT_TOOLS, buildSkill, GROUND_RULES, RECIPES, TRAPS } from './agentGuide';
import { apps } from './apps';

// Every app's tool factory, imported so the declared catalogue can be checked
// against what is actually registered. A guide that drifts from the tools is
// worse than no guide, because it sends an agent looking for something gone.
import { cadenceTools } from '../apps/cadence/mcp';
import { cutawayTools } from '../apps/cutaway/mcp';
import { decanterTools } from '../apps/decanter/mcp';
import { fablerTools } from '../apps/fabler/mcp';
import { foolscapTools } from '../apps/foolscap/mcp';
import { jotterbugTools } from '../apps/jotterbug/mcp';
import { lanewayTools } from '../apps/laneway/mcp';
import { limelightTools } from '../apps/limelight/mcp';
import { loupeTools } from '../apps/loupe/mcp';
import { ordinateTools } from '../apps/ordinate/mcp';
import { quarryTools } from '../apps/quarry/mcp';
import { quireTools } from '../apps/quire/mcp';
import { reckonerTools } from '../apps/reckoner/mcp';
import { rostrumTools } from '../apps/rostrum/mcp';
import { roteTools } from '../apps/rote/mcp';
import { siftTools } from '../apps/sift/mcp';
import { stintTools } from '../apps/stint/mcp';
import { tallyTools } from '../apps/tally/mcp';
import { tesseraTools } from '../apps/tessera/mcp';
import { warrenTools } from '../apps/warren/mcp';

const noop = () => {};

const REGISTERED: Record<string, { name: string; description: string; inputSchema: unknown }[]> = {
  cadence: cadenceTools(),
  cutaway: cutawayTools(),
  decanter: decanterTools(),
  fabler: fablerTools(),
  foolscap: foolscapTools(),
  jotterbug: jotterbugTools(noop),
  laneway: lanewayTools(noop),
  limelight: limelightTools(() => ({
    recording: null, points: [], interestSource: 'none',
    settings: {
      composition: {} as never, zoom: {} as never, frameRate: 30, showClicks: true, showCursor: true,
      tilt: { x: 0, y: 0, rotate: 0, depth: 0.35 },
      motion: { entrance: 'none' as const, exit: 'none' as const, seconds: 0.6 },
    },
    track: [], crop: { x: 0, y: 0, width: 1, height: 1 }, trim: { start: 0, end: 0 }, texts: [],
    zooms: [], cuts: [], loudness: null, looks: [], previewTime: 0, playing: false, clips: [],
  }), noop),
  loupe: loupeTools(),
  ordinate: ordinateTools(noop),
  quarry: quarryTools(() => [], noop),
  quire: quireTools(),
  reckoner: reckonerTools(),
  rostrum: rostrumTools(noop),
  rote: roteTools(noop),
  sift: siftTools(),
  stint: stintTools(noop),
  tally: tallyTools(noop),
  tessera: tesseraTools(),
  warren: warrenTools(noop),
};

describe('the declared catalogue matches the registered tools', () => {
  it('covers every app that has any', () => {
    expect([...AGENT_TOOLS.map((entry) => entry.slug)].sort())
      .toEqual(Object.keys(REGISTERED).sort());
  });

  it('lists exactly the tools each app registers, and no others', () => {
    for (const entry of AGENT_TOOLS) {
      const actual = REGISTERED[entry.slug].map((tool) => tool.name).sort();
      const declared = entry.tools.map((tool) => tool.name).sort();
      expect(declared, entry.slug).toEqual(actual);
    }
  });

  it('points at a page that exists in the app registry', () => {
    const slugs = new Set(apps.map((app) => app.slug));
    for (const entry of AGENT_TOOLS) {
      expect(slugs.has(entry.slug), entry.slug).toBe(true);
      expect(entry.page).toBe(`/${entry.slug}`);
    }
  });

  it('names every app in the registry that could carry tools', () => {
    // Only Reckoner's siblings are exempt: an app with no tools at all should
    // be a deliberate choice, so a new one shows up here until it is wired.
    const covered = new Set(AGENT_TOOLS.map((entry) => entry.slug));
    const missing = apps.map((app) => app.slug).filter((slug) => !covered.has(slug));
    expect(missing).toEqual([]);
  });
});

describe('every registered tool is usable', () => {
  it('has a name, a description worth reading, and a schema', () => {
    for (const [slug, tools] of Object.entries(REGISTERED)) {
      for (const tool of tools) {
        expect(tool.name, slug).toMatch(/^[a-z]+_[a-z_]+$/);
        expect(tool.name.startsWith(`${slug}_`), `${tool.name} should start with ${slug}_`).toBe(true);
        expect(tool.description.length, tool.name).toBeGreaterThan(60);
        expect(tool.inputSchema, tool.name).toHaveProperty('type', 'object');
      }
    }
  });

  it('never uses the same tool name twice across the whole site', () => {
    const names = Object.values(REGISTERED).flat().map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('marks every required argument as a declared property', () => {
    for (const tools of Object.values(REGISTERED)) {
      for (const tool of tools) {
        const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
        for (const name of schema.required ?? []) {
          expect(schema.properties, `${tool.name} requires "${name}"`).toHaveProperty(name);
        }
      }
    }
  });
});

describe('buildSkill', () => {
  it('writes a document with every section', () => {
    const skill = buildSkill();
    for (const heading of ['# Using alexmerced.app', '## Ground rules', '## Which page for which job', '## The tools', '## Recipes', '## Traps worth knowing', '## Habits']) {
      expect(skill).toContain(heading);
    }
  });

  it('names every tool the site has', () => {
    const skill = buildSkill();
    for (const tools of Object.values(REGISTERED)) {
      for (const tool of tools) expect(skill, tool.name).toContain(tool.name);
    }
  });

  it('narrows to the apps asked for', () => {
    const skill = buildSkill({ apps: ['quarry', 'ordinate'] });
    expect(skill).toContain('quarry_run_sql');
    expect(skill).toContain('ordinate_render_chart');
    expect(skill).not.toContain('rote_add_cards');
  });

  it('puts the most relevant page first for a stated task', () => {
    const skill = buildSkill({ task: 'query a csv with sql and chart the result' });
    const quarry = skill.indexOf('/quarry');
    const rote = skill.indexOf('/rote');
    expect(quarry).toBeGreaterThan(-1);
    expect(rote === -1 || quarry < rote).toBe(true);
  });

  it('says what it was written for', () => {
    expect(buildSkill({ task: 'making flashcards' })).toContain('making flashcards');
  });

  it('falls back to everything when a task matches nothing', () => {
    const skill = buildSkill({ task: 'zzzz qqqq' });
    expect(skill).toContain('quarry_run_sql');
    expect(skill).toContain('rote_add_cards');
  });

  it('carries the ground rules and traps verbatim', () => {
    const skill = buildSkill();
    for (const rule of GROUND_RULES) expect(skill).toContain(rule);
    for (const trap of TRAPS) expect(skill).toContain(trap);
  });

  it('numbers the steps of each recipe', () => {
    const skill = buildSkill({ apps: ['quarry'] });
    expect(skill).toMatch(/^1\. /m);
    expect(skill).toMatch(/^2\. /m);
  });

  it('is a reasonable size to hand to a model', () => {
    const whole = buildSkill();
    expect(whole.length).toBeGreaterThan(4000);
    expect(whole.length).toBeLessThan(24000);
    expect(buildSkill({ apps: ['reckoner'] }).length).toBeLessThan(whole.length);
  });
});

describe('the guide itself', () => {
  it('has a recipe for every step that names a real tool', () => {
    const names = new Set(Object.values(REGISTERED).flat().map((tool) => tool.name));
    for (const recipe of RECIPES) {
      for (const step of recipe.steps) {
        for (const mentioned of step.match(/\b[a-z]+_[a-z_]+\b/g) ?? []) {
          expect(names.has(mentioned), `${recipe.title} mentions ${mentioned}`).toBe(true);
        }
      }
    }
  });

  it('only sends people to pages that exist', () => {
    const pages = new Set(apps.map((app) => `/${app.slug}`));
    for (const recipe of RECIPES) {
      for (const step of recipe.steps) {
        for (const page of step.match(/\/[a-z]+/g) ?? []) {
          expect(pages.has(page), `${recipe.title} sends you to ${page}`).toBe(true);
        }
      }
    }
  });
});

describe('the site-wide tools', () => {
  it('registers the directory and the skill builder', async () => {
    const { siteTools } = await import('../lib/siteTools');
    expect(siteTools().map((tool) => tool.name)).toEqual([
      'list_apps', 'search_apps', 'get_app', 'get_agent_tools', 'build_skill', 'get_storage_policy',
    ]);
  });

  it('builds a skill through the tool, ordered for the task given', async () => {
    const { siteTools } = await import('../lib/siteTools');
    const tool = siteTools().find((entry) => entry.name === 'build_skill')!;
    const result = await tool.execute({ task: 'run sql over a csv' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.format).toBe('markdown');
    expect(parsed.skill).toContain('quarry_run_sql');
    expect(parsed.skill).toContain('run sql over a csv');
    // The task ordering has to actually happen, not just be promised: Quarry
    // must be the first page listed for a task about SQL.
    const firstPage = /^\| `(\/[a-z]+)` \|/m.exec(parsed.skill);
    expect(firstPage?.[1]).toBe('/quarry');
  });

  it('narrows the skill to the apps asked for', async () => {
    const { siteTools } = await import('../lib/siteTools');
    const tool = siteTools().find((entry) => entry.name === 'build_skill')!;
    const parsed = JSON.parse((await tool.execute({ apps: ['cadence', 'quire'] })).content[0].text);
    expect(parsed.skill).toContain('cadence_edit_audio');
    expect(parsed.skill).toContain('quire_merge_pdfs');
    // The tools index must hold only what was asked for. A ground rule may
    // still name another tool as an example of how pages work, which is fine.
    expect(parsed.skill).not.toContain('### Quarry');
    expect(parsed.skill).not.toContain('quarry_list_tables');
  });

  it('ignores an app it does not know rather than failing', async () => {
    const { siteTools } = await import('../lib/siteTools');
    const tool = siteTools().find((entry) => entry.name === 'build_skill')!;
    const parsed = JSON.parse((await tool.execute({ apps: ['nonsense'] })).content[0].text);
    expect(parsed.skill.length).toBeGreaterThan(1000);
  });

  it('reports the true total when listing the agent tools', async () => {
    const { siteTools } = await import('../lib/siteTools');
    const tool = siteTools().find((entry) => entry.name === 'get_agent_tools')!;
    const parsed = JSON.parse((await tool.execute({})).content[0].text);
    const declared = AGENT_TOOLS.reduce((sum, entry) => sum + entry.tools.length, 0);
    expect(parsed.totalTools).toBe(declared);
    expect(parsed.apps).toHaveLength(AGENT_TOOLS.length);
  });

  it('finds the right app from a plain description of a job', async () => {
    const { siteTools } = await import('../lib/siteTools');
    const search = siteTools().find((entry) => entry.name === 'search_apps')!;
    const hits = JSON.parse((await search.execute({ query: 'read a qr code' })).content[0].text);
    expect(hits[0].slug).toBe('tessera');
  });
});
