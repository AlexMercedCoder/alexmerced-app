import type { APIRoute } from 'astro';
import { AGENT_TOOLS } from '../../data/agentGuide';
import { apps } from '../../data/apps';
import { siteTools } from '../../lib/siteTools';

const ORIGIN = 'https://alexmerced.app';

/**
 * Static discovery for agents that have not opened a browser page yet.
 *
 * WebMCP's live registry remains authoritative: callbacks only exist in the
 * page that registered them.  This manifest is deliberately descriptive so a
 * harness can route a task to the right page before starting that browser.
 */
export const GET: APIRoute = async () => {
  const appDetails = new Map(apps.map((app) => [app.slug, app]));
  const body = {
    schemaVersion: '1.0',
    name: 'alexmerced.app',
    origin: ORIGIN,
    protocol: 'WebMCP',
    liveDiscoveryRequired: true,
    storage: {
      location: 'browser-local',
      persistentProfileRecommended: true,
      note: 'Tools run in the active page against that browser profile’s IndexedDB and localStorage.',
    },
    discovery: {
      page: `${ORIGIN}/`,
      tools: siteTools().map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    },
    apps: AGENT_TOOLS.map((entry) => {
      const details = appDetails.get(entry.slug);
      return {
        slug: entry.slug,
        name: entry.app,
        url: `${ORIGIN}${entry.page}`,
        purpose: entry.purpose,
        storage: details?.storage ?? 'none',
        tools: entry.tools,
      };
    }),
  };

  return new Response(JSON.stringify(body, null, 2) + '\n', {
    headers: {
      'Cache-Control': 'public, max-age=300',
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
};
