import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every custom property a page reads is one somebody declared.
 *
 * CSS does not complain about `var(--nope)`. A background comes out
 * transparent, a colour falls back to whatever it inherited, and the page still
 * renders, just wrong. Six pages had been written against a set of names that
 * were never declared anywhere, and it went unnoticed until a modal dialog
 * came out see-through over the editor underneath it.
 *
 * Properties set from script are the exception, so they are listed here by
 * hand: if one of those is renamed, this list is where it has to be renamed too.
 */
const RUNTIME_SET = new Set(['--slide-accent', '--swatch', '--depth', '--indent', '--era']);

const src = fileURLToPath(new URL('..', import.meta.url));
const declared = (text: string) => new Set(text.match(/--[a-z0-9-]+(?=\s*:)/g) ?? []);

const global = readFileSync(join(src, 'styles/global.css'), 'utf8');
const base = declared(global);

const pages = readdirSync(join(src, 'pages'))
  .filter((name) => name.endsWith('.astro'))
  .map((name) => ({ name, text: readFileSync(join(src, 'pages', name), 'utf8') }));

describe('the custom properties the pages read', () => {
  it('finds the pages and the palette, so a pass means something', () => {
    expect(pages.length).toBeGreaterThan(10);
    expect(base.has('--text')).toBe(true);
  });

  it('the palette itself reads nothing undeclared', () => {
    // An alias pointing at a name that has since been renamed fails exactly
    // the same way, and would otherwise be invisible to the per-page checks.
    const missing = new Set<string>();
    for (const [, token, comma] of global.matchAll(/var\((--[a-z0-9-]+)\s*(,?)/g)) {
      if (!comma && !base.has(token)) missing.add(token);
    }
    expect([...missing]).toEqual([]);
  });

  it.each(pages.map((page) => page.name))('%s reads nothing undeclared', (name) => {
    const page = pages.find((entry) => entry.name === name)!;
    const known = new Set([...base, ...declared(page.text), ...RUNTIME_SET]);
    const missing = new Set<string>();
    // A var() with a fallback is fine: it says what to do when there is nothing.
    for (const [, token, comma] of page.text.matchAll(/var\((--[a-z0-9-]+)\s*(,?)/g)) {
      if (!comma && !known.has(token)) missing.add(token);
    }
    expect([...missing]).toEqual([]);
  });
});
