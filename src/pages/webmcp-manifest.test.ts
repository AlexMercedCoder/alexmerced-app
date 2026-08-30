import { describe, expect, it } from 'vitest';
import { GET } from './.well-known/webmcp.json';

describe('WebMCP discovery manifest', () => {
  it('publishes the site catalog without pretending callbacks are remotely callable', async () => {
    const response = await GET({} as never);
    const manifest = await response.json();

    expect(response.headers.get('content-type')).toContain('application/json');
    expect(manifest.origin).toBe('https://alexmerced.app');
    expect(manifest.liveDiscoveryRequired).toBe(true);
    expect(manifest.discovery.tools.map((tool: { name: string }) => tool.name)).toContain('list_apps');
    expect(manifest.apps.length).toBeGreaterThan(10);
    expect(manifest.apps.find((app: { slug: string }) => app.slug === 'quarry').tools)
      .toContainEqual(expect.objectContaining({ name: 'quarry_run_sql' }));
  });
});
