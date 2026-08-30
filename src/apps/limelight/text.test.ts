import { describe, expect, it } from 'vitest';
import {
  addText, constrainText, defaultText, MIN_TEXT, opacityAt, removeText, reviveTexts,
  textsAt, updateText, wrapText, type TextBlock,
} from './text';

const block = (overrides: Partial<TextBlock> = {}): TextBlock => ({
  ...defaultText(0, 10),
  ...overrides,
});

describe('defaultText', () => {
  it('starts where it was asked to', () => {
    expect(defaultText(3, 10).start).toBe(3);
  });

  it('never starts past the end of the recording', () => {
    const text = defaultText(99, 5);
    expect(text.start).toBeLessThanOrEqual(5 - MIN_TEXT);
    expect(text.end).toBeLessThanOrEqual(5);
  });

  it('fits inside a recording shorter than a caption', () => {
    const text = defaultText(0, 1);
    expect(text.end).toBe(1);
  });

  it('gives each caption its own identity', () => {
    expect(defaultText(0, 10).id).not.toBe(defaultText(0, 10).id);
  });
});

describe('addText', () => {
  it('adds one', () => {
    expect(addText([], 1, 10)).toHaveLength(1);
  });

  it('lets captions overlap, because two things can be said at once', () => {
    const first = addText([], 1, 10);
    const both = addText(first, 1.2, 10);
    expect(both).toHaveLength(2);
    expect(both[0].end).toBeGreaterThan(both[1].start);
  });

  it('keeps them in time order', () => {
    let blocks = addText([], 5, 10);
    blocks = addText(blocks, 1, 10);
    blocks = addText(blocks, 3, 10);
    expect(blocks.map((entry) => entry.start)).toEqual([1, 3, 5]);
  });

  it('refuses to add to a recording with no length', () => {
    expect(addText([], 0, 0)).toHaveLength(0);
  });
});

describe('removeText and updateText', () => {
  it('removes the one named', () => {
    const blocks = addText(addText([], 1, 10), 5, 10);
    expect(removeText(blocks, blocks[0].id).map((entry) => entry.id)).toEqual([blocks[1].id]);
  });

  it('leaves the list alone when nothing matches', () => {
    const blocks = addText([], 1, 10);
    expect(removeText(blocks, 'nothing')).toHaveLength(1);
  });

  it('changes only what it was given', () => {
    const blocks = addText([], 1, 10);
    const after = updateText(blocks, blocks[0].id, { text: 'Hello', size: 0.1 });
    expect(after[0].text).toBe('Hello');
    expect(after[0].size).toBe(0.1);
    expect(after[0].start).toBe(blocks[0].start);
  });

  it('will not let an update change which caption this is', () => {
    const blocks = addText([], 1, 10);
    const after = updateText(blocks, blocks[0].id, { id: 'stolen' } as Partial<TextBlock>);
    expect(after[0].id).toBe(blocks[0].id);
  });
});

describe('constrainText', () => {
  it('pulls a caption that hangs off the end back inside', () => {
    const blocks = constrainText([block({ id: 'a', start: 9, end: 14 })], 'a', 10);
    expect(blocks[0].end).toBeLessThanOrEqual(10);
    expect(blocks[0].start).toBeGreaterThanOrEqual(0);
  });

  it('only touches the one named', () => {
    const one = block({ id: 'a', start: 0, end: 2 });
    const two = block({ id: 'b', start: 8, end: 99 });
    const after = constrainText([one, two], 'a', 10);
    expect(after.find((entry) => entry.id === 'b')!.end).toBe(99);
  });

  it('never shortens a caption below what can be read', () => {
    const after = constrainText([block({ id: 'a', start: 1, end: 1.01 })], 'a', 10);
    expect(after[0].end - after[0].start).toBeCloseTo(MIN_TEXT, 9);
  });

  it('keeps the list in time order', () => {
    const after = constrainText(
      [block({ id: 'a', start: 8, end: 9 }), block({ id: 'b', start: 1, end: 2 })], 'a', 10,
    );
    expect(after[0].id).toBe('b');
  });
});

describe('opacityAt', () => {
  const fading = block({ start: 2, end: 6, fade: 0.5 });

  it('is nothing before and after', () => {
    expect(opacityAt(fading, 1.9)).toBe(0);
    expect(opacityAt(fading, 6.1)).toBe(0);
  });

  it('is full in the middle', () => {
    expect(opacityAt(fading, 4)).toBe(1);
  });

  it('rises through the fade in', () => {
    expect(opacityAt(fading, 2.25)).toBeCloseTo(0.5, 6);
  });

  it('falls through the fade out', () => {
    expect(opacityAt(fading, 5.75)).toBeCloseTo(0.5, 6);
  });

  it('appears at once when there is no fade', () => {
    expect(opacityAt(block({ start: 2, end: 6, fade: 0 }), 2)).toBe(1);
  });

  it('caps a fade longer than the caption, so it still reaches full strength', () => {
    const brief = block({ start: 0, end: 1, fade: 10 });
    expect(opacityAt(brief, 0.5)).toBe(1);
  });
});

describe('textsAt', () => {
  it('reports only what is showing', () => {
    const blocks = [
      block({ id: 'a', start: 0, end: 2, fade: 0 }),
      block({ id: 'b', start: 5, end: 7, fade: 0 }),
    ];
    expect(textsAt(blocks, 1).map((entry) => entry.block.id)).toEqual(['a']);
    expect(textsAt(blocks, 3)).toEqual([]);
  });

  it('reports both when two overlap', () => {
    const blocks = [
      block({ id: 'a', start: 0, end: 4, fade: 0 }),
      block({ id: 'b', start: 2, end: 6, fade: 0 }),
    ];
    expect(textsAt(blocks, 3)).toHaveLength(2);
  });
});

describe('reviveTexts', () => {
  it('reads back what was stored', () => {
    const stored = [{ id: 'a', text: 'Hi', start: 1, end: 3, x: 0.2, y: 0.3, size: 0.08, colour: '#f00', plate: 0, align: 'left', fade: 0.1 }];
    expect(reviveTexts(stored)[0]).toEqual(stored[0]);
  });

  it('gives up on anything that is not a list', () => {
    for (const value of [null, undefined, 'text', 7, {}]) expect(reviveTexts(value)).toEqual([]);
  });

  it('skips entries with no words in them', () => {
    expect(reviveTexts([{ start: 1 }, { text: 'kept' }])).toHaveLength(1);
  });

  it('repairs a caption rather than discarding it', () => {
    const [text] = reviveTexts([{ text: 'Hi', x: 4, size: -1, align: 'sideways' }]);
    expect(text.x).toBe(1);
    expect(text.size).toBe(0.01);
    expect(text.align).toBe('centre');
  });

  it('never reads back a caption that ends before it starts', () => {
    const [text] = reviveTexts([{ text: 'Hi', start: 5, end: 1 }]);
    expect(text.end).toBeGreaterThan(text.start);
  });

  it('gives an unnamed caption a name', () => {
    expect(reviveTexts([{ text: 'Hi' }])[0].id).toMatch(/^txt/);
  });

  it('sorts what it reads', () => {
    const texts = reviveTexts([{ text: 'b', start: 5 }, { text: 'a', start: 1 }]);
    expect(texts.map((entry) => entry.text)).toEqual(['a', 'b']);
  });
});

describe('wrapText', () => {
  // A stand-in for a canvas: every character is ten wide.
  const measure = (line: string) => line.length * 10;

  it('leaves a short line alone', () => {
    expect(wrapText('one two', 1000, measure)).toEqual(['one two']);
  });

  it('breaks where the width runs out', () => {
    expect(wrapText('aaa bbb ccc', 70, measure)).toEqual(['aaa bbb', 'ccc']);
  });

  it('keeps line breaks that were typed', () => {
    expect(wrapText('one\ntwo', 1000, measure)).toEqual(['one', 'two']);
  });

  it('keeps a blank line that was typed', () => {
    expect(wrapText('one\n\ntwo', 1000, measure)).toEqual(['one', '', 'two']);
  });

  it('lets a single long word overflow rather than hyphenating a name', () => {
    expect(wrapText('Wolfeschlegelsteinhausen', 50, measure)).toEqual(['Wolfeschlegelsteinhausen']);
  });

  it('collapses the spacing it was given', () => {
    expect(wrapText('one    two', 1000, measure)).toEqual(['one two']);
  });

  it('returns one empty line for nothing at all', () => {
    expect(wrapText('', 100, measure)).toEqual(['']);
  });
});
