import { describe, expect, it } from 'vitest';
import { chunk, describeSize, formatBytes, formatPageRange, move, outputName, parsePageRange, rotateBy } from './model';

describe('parsePageRange', () => {
  it('reads everything for an empty range', () => {
    expect(parsePageRange('', 3)).toEqual([0, 1, 2]);
    expect(parsePageRange('all', 3)).toEqual([0, 1, 2]);
  });

  it('reads single pages, one-based', () => {
    expect(parsePageRange('1,3', 5)).toEqual([0, 2]);
  });

  it('reads a span', () => {
    expect(parsePageRange('2-4', 10)).toEqual([1, 2, 3]);
  });

  it('reads an open ended span', () => {
    expect(parsePageRange('3-', 5)).toEqual([2, 3, 4]);
    expect(parsePageRange('-2', 5)).toEqual([0, 1]);
  });

  it('handles a reversed span', () => {
    expect(parsePageRange('4-2', 10)).toEqual([1, 2, 3]);
  });

  it('drops pages beyond the document', () => {
    expect(parsePageRange('1, 99', 3)).toEqual([0]);
  });

  it('removes duplicates and sorts', () => {
    expect(parsePageRange('3,1,3,2', 5)).toEqual([0, 1, 2]);
  });

  it('ignores nonsense parts', () => {
    expect(parsePageRange('1, banana, 3', 5)).toEqual([0, 2]);
  });

  it('tolerates spaces', () => {
    expect(parsePageRange(' 1 - 2 , 4 ', 5)).toEqual([0, 1, 3]);
  });
});

describe('formatPageRange', () => {
  it('collapses runs', () => {
    expect(formatPageRange([0, 1, 2, 5])).toBe('1-3, 6');
  });

  it('lists singles', () => {
    expect(formatPageRange([0, 2, 4])).toBe('1, 3, 5');
  });

  it('returns empty for nothing', () => {
    expect(formatPageRange([])).toBe('');
  });

  it('round trips through parse', () => {
    const indexes = [0, 1, 2, 6, 8, 9];
    expect(parsePageRange(formatPageRange(indexes), 20)).toEqual(indexes);
  });
});

describe('move', () => {
  it('moves an item forward', () => {
    expect(move(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
  });

  it('moves an item backward', () => {
    expect(move(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
  });

  it('is a no-op for the same position', () => {
    const items = ['a', 'b'];
    expect(move(items, 1, 1)).toBe(items);
  });

  it('clamps a target past the end', () => {
    expect(move(['a', 'b'], 0, 99)).toEqual(['b', 'a']);
  });

  it('ignores an index that does not exist', () => {
    const items = ['a'];
    expect(move(items, 5, 0)).toBe(items);
  });
});

describe('rotateBy', () => {
  it('adds quarter turns', () => {
    expect(rotateBy(0, 90)).toBe(90);
    expect(rotateBy(270, 90)).toBe(0);
  });

  it('handles negative turns', () => {
    expect(rotateBy(0, -90)).toBe(270);
  });
});

describe('chunk', () => {
  it('splits into even groups', () => {
    expect(chunk([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]);
  });

  it('leaves a short final group', () => {
    expect(chunk([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
  });

  it('returns one group for a size of zero', () => {
    expect(chunk([1, 2], 0)).toEqual([[1, 2]]);
  });
});

describe('outputName', () => {
  it('does not double the extension', () => {
    expect(outputName('report.pdf', '-merged')).toBe('report-merged.pdf');
  });

  it('adds one when there is none', () => {
    expect(outputName('report', '')).toBe('report.pdf');
  });

  it('strips characters illegal in a filename', () => {
    expect(outputName('a/b:c.pdf', '')).toBe('a-b-c.pdf');
  });

  it('falls back when nothing usable is left', () => {
    expect(outputName('.pdf', '')).toBe('document.pdf');
  });
});

describe('describeSize', () => {
  it('recognises A4 and Letter', () => {
    expect(describeSize(595.28, 841.89)).toBe('A4');
    expect(describeSize(612, 792)).toBe('Letter');
  });

  it('recognises landscape', () => {
    expect(describeSize(841.89, 595.28)).toBe('A4 landscape');
  });

  it('falls back to millimetres', () => {
    expect(describeSize(300, 300)).toMatch(/mm$/);
  });
});

describe('formatBytes', () => {
  it('scales the unit', () => {
    expect(formatBytes(900)).toBe('900 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.00 MB');
  });
});
