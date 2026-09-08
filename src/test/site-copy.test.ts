import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
const root = new URL('../', import.meta.url).pathname;
function files(dir: string): string[] { return readdirSync(dir).flatMap(name => { const path = join(dir, name); return statSync(path).isDirectory() ? files(path) : /\.(astro|ts)$/.test(path) && !path.endsWith('.test.ts') ? [path] : []; }); }
it('keeps shipped copy free of em dashes and stock promotional phrases', () => {
  const forbidden = /\u2014|&mdash;|&#8212;|\\u2014|seamlessly|unleash the power|unlock your potential|game.changing|in today.s fast.paced|delve into/i;
  for (const file of files(root)) expect(readFileSync(file, 'utf8'), file).not.toMatch(forbidden);
});
