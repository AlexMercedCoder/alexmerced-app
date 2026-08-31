import { describe, expect, it } from 'vitest';
import {
  alignToEdit, cuesAt, formatTime, parseCaptions, parseTime, reviveCues, sortCues, spansOf,
  splitCue, toSrt, toVtt, type Cue,
} from './captions';

let counter = 0;
const id = () => `c${counter++}`;
const cue = (start: number, end: number, text: string): Cue => ({ id: `c-${start}`, start, end, text });

describe('parseTime', () => {
  it('reads an SRT timestamp, which uses a comma', () => {
    expect(parseTime('00:01:02,500')).toBeCloseTo(62.5);
  });

  it('reads a VTT timestamp, which uses a dot', () => {
    expect(parseTime('00:01:02.500')).toBeCloseTo(62.5);
  });

  it('reads the short form VTT allows, with no hours', () => {
    expect(parseTime('01:02.250')).toBeCloseTo(62.25);
  });

  it('pads a short milliseconds field rather than misreading it', () => {
    // ".5" is half a second, not five milliseconds.
    expect(parseTime('00:00:01.5')).toBeCloseTo(1.5);
  });

  it('gives nothing back for something that is not a time', () => {
    expect(parseTime('hello')).toBeNull();
  });
});

describe('formatTime', () => {
  it('writes hours, minutes, seconds and milliseconds', () => {
    expect(formatTime(3723.456)).toBe('01:02:03.456');
  });

  it('uses a comma for SRT', () => {
    expect(formatTime(1.5, true)).toBe('00:00:01,500');
  });

  it('never writes a negative time', () => {
    expect(formatTime(-5)).toBe('00:00:00.000');
  });

  it('round trips against the parser', () => {
    for (const value of [0, 1.25, 62.5, 3723.456]) {
      expect(parseTime(formatTime(value))).toBeCloseTo(value, 2);
    }
  });
});

describe('parseCaptions', () => {
  const srt = `1
00:00:01,000 --> 00:00:03,000
Hello there

2
00:00:04,500 --> 00:00:06,000
Second line
across two rows`;

  it('reads SRT', () => {
    const cues = parseCaptions(srt, id);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toMatchObject({ start: 1, end: 3, text: 'Hello there' });
    expect(cues[1].text).toBe('Second line\nacross two rows');
  });

  it('reads VTT, header and all', () => {
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nOne\n\n00:00:03.000 --> 00:00:04.000\nTwo';
    expect(parseCaptions(vtt, id).map((c) => c.text)).toEqual(['One', 'Two']);
  });

  it('copes with carriage returns from a Windows file', () => {
    expect(parseCaptions(srt.replace(/\n/g, '\r\n'), id)).toHaveLength(2);
  });

  it('skips a malformed block rather than failing the file', () => {
    const broken = `1
not a timestamp
Nonsense

2
00:00:04,000 --> 00:00:05,000
Good one`;
    expect(parseCaptions(broken, id).map((c) => c.text)).toEqual(['Good one']);
  });

  it('skips a cue that ends before it starts', () => {
    expect(parseCaptions('1\n00:00:05,000 --> 00:00:02,000\nBackwards', id)).toEqual([]);
  });

  it('skips a cue with no words', () => {
    expect(parseCaptions('1\n00:00:01,000 --> 00:00:02,000\n', id)).toEqual([]);
  });

  it('gives nothing back for an empty file', () => {
    expect(parseCaptions('', id)).toEqual([]);
  });

  it('puts cues in time order even when the file is not', () => {
    const jumbled = '1\n00:00:05,000 --> 00:00:06,000\nLater\n\n2\n00:00:01,000 --> 00:00:02,000\nEarlier';
    expect(parseCaptions(jumbled, id).map((c) => c.text)).toEqual(['Earlier', 'Later']);
  });
});

describe('toSrt and toVtt', () => {
  const cues = [cue(1, 3, 'Hello'), cue(4, 5, 'There')];

  it('writes SRT that reads back the same', () => {
    expect(parseCaptions(toSrt(cues), id).map((c) => [c.start, c.end, c.text]))
      .toEqual([[1, 3, 'Hello'], [4, 5, 'There']]);
  });

  it('writes VTT that reads back the same', () => {
    expect(parseCaptions(toVtt(cues), id).map((c) => [c.start, c.end, c.text]))
      .toEqual([[1, 3, 'Hello'], [4, 5, 'There']]);
  });

  it('numbers SRT cues from one', () => {
    expect(toSrt(cues).startsWith('1\n')).toBe(true);
  });

  it('starts a VTT file with its header, which players require', () => {
    expect(toVtt(cues).startsWith('WEBVTT')).toBe(true);
  });
});

describe('cuesAt', () => {
  const cues = [cue(1, 3, 'One'), cue(2, 4, 'Overlapping'), cue(6, 7, 'Later')];

  it('finds what is showing', () => {
    expect(cuesAt(cues, 2.5).map((c) => c.text)).toEqual(['One', 'Overlapping']);
  });

  it('finds nothing in a gap', () => {
    expect(cuesAt(cues, 5)).toEqual([]);
  });
});

describe('spansOf', () => {
  const cues = [cue(1, 3, 'One'), cue(4, 6, 'Two'), cue(7, 8, 'Three')];

  it('turns chosen cues into spans, which is what makes deleting words a cut', () => {
    expect(spansOf(cues, ['c-1', 'c-7'])).toEqual([{ start: 1, end: 3 }, { start: 7, end: 8 }]);
  });

  it('ignores an id that is not there', () => {
    expect(spansOf(cues, ['ghost'])).toEqual([]);
  });
});

describe('alignToEdit', () => {
  // A cut from 3 to 5: everything after shifts back by two.
  const removed = (t: number) => t >= 3 && t < 5;
  const toEdited = (t: number) => (t <= 3 ? t : Math.max(3, t - 2));

  it('leaves a cue before the cut alone', () => {
    const out = alignToEdit([cue(1, 2, 'Before')], toEdited, removed);
    expect(out[0]).toMatchObject({ start: 1, end: 2 });
  });

  it('shifts a cue after the cut back', () => {
    const out = alignToEdit([cue(6, 8, 'After')], toEdited, removed);
    expect(out[0]).toMatchObject({ start: 4, end: 6 });
  });

  it('drops a cue entirely inside the cut', () => {
    expect(alignToEdit([cue(3.2, 4.8, 'Gone')], toEdited, removed)).toEqual([]);
  });

  it('keeps a cue that straddles the cut rather than losing the sentence', () => {
    const out = alignToEdit([cue(2, 6, 'Straddles')], toEdited, removed);
    expect(out).toHaveLength(1);
    expect(out[0].end).toBeGreaterThan(out[0].start);
  });

  it('drops a cue squeezed to nothing', () => {
    const squeeze = (t: number) => Math.min(t, 1);
    expect(alignToEdit([cue(1, 5, 'Flat')], squeeze, () => false)).toEqual([]);
  });
});

describe('splitCue', () => {
  it('cuts one in two', () => {
    const out = splitCue([cue(1, 5, 'Long one')], 'c-1', 3, id);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ start: 1, end: 3, text: 'Long one' });
    expect(out[1].start).toBe(3);
  });

  it('refuses a split too near an edge to be useful', () => {
    expect(splitCue([cue(1, 5, 'Long')], 'c-1', 1.05, id)).toHaveLength(1);
  });

  it('leaves an unknown id alone', () => {
    expect(splitCue([cue(1, 5, 'Long')], 'nope', 3, id)).toHaveLength(1);
  });
});

describe('reviveCues', () => {
  it('gives nothing back for nonsense', () => {
    expect(reviveCues(null, id)).toEqual([]);
    expect(reviveCues([{ start: 'x', end: 1, text: 'a' }], id)).toEqual([]);
  });

  it('drops one with no words', () => {
    expect(reviveCues([{ id: 'a', start: 1, end: 2, text: '   ' }], id)).toEqual([]);
  });

  it('gives one with no id a new one', () => {
    expect(reviveCues([{ start: 1, end: 2, text: 'Words' }], id)[0].id).toBeTruthy();
  });
});

describe('sortCues', () => {
  it('drops an empty cue and orders the rest', () => {
    const out = sortCues([cue(5, 6, 'Late'), cue(2, 2, 'Empty'), cue(1, 2, 'Early')]);
    expect(out.map((c) => c.text)).toEqual(['Early', 'Late']);
  });
});
