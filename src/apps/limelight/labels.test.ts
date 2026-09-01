import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The buttons, read out of the page itself.
 *
 * Written as a test rather than a review note because the failure it guards is
 * one that creeps back: a new control gets called "Delete" or "Save" because
 * the panel around it makes the object obvious to whoever is writing it, and
 * then reads as a bare verb to everybody else. Three separate buttons said only
 * "Delete" at once, on three different panels.
 */
const page = readFileSync(
  new URL('../../pages/limelight.astro', import.meta.url), 'utf8',
);

type Button = { id: string; label: string; title: string | null; aria: string | null };

function buttons(): Button[] {
  const out: Button[] = [];
  const pattern = /<button\b([^>]*)>([\s\S]*?)<\/button>/g;
  for (const match of page.matchAll(pattern)) {
    const attributes = match[1];
    const id = /id="([^"]+)"/.exec(attributes)?.[1];
    if (!id?.startsWith('ll-')) continue;
    out.push({
      id,
      label: match[2].replace(/<[^>]*>/g, '').trim(),
      title: /title="([^"]*)"/.exec(attributes)?.[1] ?? null,
      aria: /aria-label="([^"]*)"/.exec(attributes)?.[1] ?? null,
    });
  }
  return out;
}

/** Verbs that say nothing about what they act on. */
const BARE = [
  'delete', 'remove', 'remove it', 'clear', 'save', 'done', 'add', 'add it',
  'add it here', 'reset', 'discard', 'cancel', 'ok', 'apply', 'go', 'for',
];

describe('the buttons on the page', () => {
  it('finds them all, so a passing run means something', () => {
    expect(buttons().length).toBeGreaterThan(40);
  });

  it('never leaves a button as a bare verb', () => {
    const bare = buttons().filter((button) => BARE.includes(button.label.toLowerCase()));
    expect(bare.map((button) => `${button.id}: ${button.label}`)).toEqual([]);
  });

  it('gives a glyph-only button words for people who cannot see it', () => {
    for (const button of buttons()) {
      // A label made of symbols is no label at all to a screen reader.
      if (/[a-z]/i.test(button.label)) continue;
      expect(button.aria, `${button.id} has no aria-label`).toBeTruthy();
      expect(button.title, `${button.id} has no tooltip`).toBeTruthy();
    }
  });

  it('does not put the same glyph on two transport buttons', () => {
    const transport = ['ll-to-start', 'll-step-back', 'll-play', 'll-step-fwd', 'll-to-end'];
    const glyphs = buttons().filter((button) => transport.includes(button.id))
      .map((button) => button.label);
    expect(glyphs.length).toBe(transport.length);
    expect(new Set(glyphs).size).toBe(transport.length);
  });

  it('names the key on the transport tooltips, since that is where people look', () => {
    const wanted: Record<string, string> = {
      'll-to-start': 'Home', 'll-step-back': '←', 'll-step-fwd': '→', 'll-to-end': 'End',
    };
    for (const button of buttons()) {
      const key = wanted[button.id];
      if (key) expect(button.title).toContain(key);
    }
  });
});

describe('the wording', () => {
  // The house style has no em dashes in it. One slipped into the help sheet
  // through an escape, which is exactly where reading the copy would not
  // have caught it.
  const sources = ['../../pages/limelight.astro', './help.ts', './ui.ts'];

  it('has no em dashes, written or escaped', () => {
    for (const path of sources) {
      const text = readFileSync(new URL(path, import.meta.url), 'utf8');
      expect(text, `${path} contains an em dash`).not.toMatch(/—|\\u2014|&mdash;|&#8212;/);
    }
  });
});
