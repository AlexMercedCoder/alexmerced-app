import { describe, expect, it } from 'vitest';
import { chapterLines } from './chapters';

const clock = (seconds: number) => {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
};

describe('chapterLines', () => {
  it('writes a line per mark', () => {
    expect(chapterLines([
      { time: 0, label: 'Opening' },
      { time: 75, label: 'The demo' },
    ], clock)).toEqual(['0:00 Opening', '1:15 The demo']);
  });

  it('adds a first chapter when the recording did not start with a mark', () => {
    // A list whose first chapter is not at zero is rejected outright, so this
    // is the difference between a usable list and a silently ignored one.
    expect(chapterLines([{ time: 30, label: 'The demo' }], clock))
      .toEqual(['0:00 Start', '0:30 The demo']);
  });

  it('does not add one when a mark is already near the beginning', () => {
    expect(chapterLines([{ time: 0.2, label: 'Opening' }], clock)).toEqual(['0:00 Opening']);
  });

  it('keeps an empty name rather than dropping the chapter', () => {
    // A mark with no name is one somebody has not got to yet, not one they
    // wanted removed.
    expect(chapterLines([{ time: 0, label: '' }], clock)).toEqual(['0:00 ']);
  });

  it('has nothing to write without marks', () => {
    expect(chapterLines([], clock)).toEqual([]);
  });
});
