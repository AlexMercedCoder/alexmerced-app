import { describe, expect, it } from 'vitest';
import {
  FLAGS,
  MAX_MATCHES,
  PATTERN_LIBRARY,
  applyReplacement,
  compile,
  createSavedPattern,
  explain,
  normaliseFlags,
  reviveSavedPattern,
  runPattern,
  segment,
  toggleFlag,
} from './model';

describe('flags', () => {
  it('keeps only known flags, once each, in order', () => {
    expect(normaliseFlags('gimq g')).toBe('gim');
    expect(normaliseFlags('ggg')).toBe('g');
    expect(normaliseFlags('')).toBe('');
  });

  it('toggles a flag on and off', () => {
    expect(toggleFlag('', 'g')).toBe('g');
    expect(toggleFlag('gi', 'i')).toBe('g');
  });

  it('offers the six flags a person actually uses', () => {
    expect(FLAGS.map((f) => f.id)).toEqual(['g', 'i', 'm', 's', 'u', 'y']);
  });
});

describe('compile', () => {
  it('asks for a pattern when there is none', () => {
    expect(compile('', 'g')).toBe('Type a pattern to start matching.');
  });

  it('returns a usable expression', () => {
    const result = compile('a+', 'gi');
    expect(result).toBeInstanceOf(RegExp);
    expect((result as RegExp).flags).toBe('gi');
  });

  it('returns a readable message for a syntax error', () => {
    const result = compile('(unclosed', 'g');
    expect(typeof result).toBe('string');
    expect(result as string).not.toContain('Invalid regular expression');
  });
});

describe('runPattern', () => {
  it('finds a single match without the global flag', () => {
    const outcome = runPattern('\\d+', '', 'a1 b22 c333');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.matches).toHaveLength(1);
    expect(outcome.matches[0].value).toBe('1');
  });

  it('finds every match with the global flag', () => {
    const outcome = runPattern('\\d+', 'g', 'a1 b22 c333');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.matches.map((m) => m.value)).toEqual(['1', '22', '333']);
  });

  it('reports the position of each match', () => {
    const outcome = runPattern('b', 'g', 'abcb');
    if (!outcome.ok) return;
    expect(outcome.matches.map((m) => [m.start, m.end])).toEqual([[1, 2], [3, 4]]);
  });

  it('captures numbered groups', () => {
    const outcome = runPattern('(\\w+)@(\\w+)', 'g', 'alex@example');
    if (!outcome.ok) return;
    expect(outcome.matches[0].groups.map((g) => g.value)).toEqual(['alex', 'example']);
  });

  it('names named groups', () => {
    const outcome = runPattern('(?<user>\\w+)@(?<host>\\w+)', 'g', 'alex@example');
    if (!outcome.ok) return;
    expect(outcome.matches[0].groups.map((g) => g.name)).toEqual(['user', 'host']);
  });

  it('reports an optional group that did not participate', () => {
    const outcome = runPattern('a(b)?c', 'g', 'ac');
    if (!outcome.ok) return;
    expect(outcome.matches[0].groups[0].value).toBeUndefined();
    expect(outcome.matches[0].groups[0].start).toBe(-1);
  });

  it('does not loop forever on a pattern that matches nothing', () => {
    const outcome = runPattern('a*', 'g', 'bbb');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.matches.length).toBeLessThanOrEqual(5);
  });

  it('stops at the match cap and says so', () => {
    const outcome = runPattern('a', 'g', 'a'.repeat(MAX_MATCHES + 500));
    if (!outcome.ok) return;
    expect(outcome.matches).toHaveLength(MAX_MATCHES);
    expect(outcome.truncated).toBe(true);
  });

  it('reports a bad pattern rather than throwing', () => {
    const outcome = runPattern('(', 'g', 'text');
    expect(outcome.ok).toBe(false);
  });

  it('honours the case insensitive flag', () => {
    expect(runPattern('ABC', 'gi', 'abc').ok && (runPattern('ABC', 'gi', 'abc') as { matches: unknown[] }).matches).toHaveLength(1);
    const sensitive = runPattern('ABC', 'g', 'abc');
    if (!sensitive.ok) return;
    expect(sensitive.matches).toHaveLength(0);
  });

  it('honours multiline', () => {
    const outcome = runPattern('^b', 'gm', 'a\nb\nc');
    if (!outcome.ok) return;
    expect(outcome.matches).toHaveLength(1);
  });
});

describe('applyReplacement', () => {
  it('substitutes with group references', () => {
    expect(applyReplacement('(\\w+)@(\\w+)', 'g', 'alex@example', '$2 at $1')).toBe('example at alex');
  });

  it('replaces every occurrence with the global flag', () => {
    expect(applyReplacement('a', 'g', 'banana', 'o')).toBe('bonono');
  });

  it('replaces only the first without it', () => {
    expect(applyReplacement('a', '', 'banana', 'o')).toBe('bonana');
  });

  it('reports a bad pattern', () => {
    expect(applyReplacement('(', 'g', 'x', 'y')).toHaveProperty('error');
  });
});

describe('segment', () => {
  it('returns the whole subject when nothing matches', () => {
    expect(segment('hello', [])).toEqual([{ text: 'hello', matchIndex: null }]);
  });

  it('returns nothing for empty input', () => {
    expect(segment('', [])).toEqual([]);
  });

  it('splits around a single match', () => {
    const outcome = runPattern('b', 'g', 'abc');
    if (!outcome.ok) return;
    expect(segment('abc', outcome.matches)).toEqual([
      { text: 'a', matchIndex: null },
      { text: 'b', matchIndex: 0 },
      { text: 'c', matchIndex: null },
    ]);
  });

  it('reassembles to exactly the original text', () => {
    const subject = 'one two three two one';
    const outcome = runPattern('two', 'g', subject);
    if (!outcome.ok) return;
    expect(segment(subject, outcome.matches).map((s) => s.text).join('')).toBe(subject);
  });

  it('handles a match at the very start and end', () => {
    const subject = 'aXa';
    const outcome = runPattern('a', 'g', subject);
    if (!outcome.ok) return;
    const segments = segment(subject, outcome.matches);
    expect(segments[0].matchIndex).toBe(0);
    expect(segments[segments.length - 1].matchIndex).toBe(1);
  });
});

describe('explain', () => {
  const meanings = (pattern: string) => explain(pattern).map((p) => p.meaning).join(' | ');

  it('describes character classes', () => {
    expect(meanings('\\d')).toContain('any digit');
    expect(meanings('\\w')).toContain('word character');
    expect(meanings('\\s')).toContain('whitespace');
  });

  it('describes quantifiers', () => {
    expect(meanings('a+')).toContain('one or more');
    expect(meanings('a*')).toContain('zero or more');
    expect(meanings('a?')).toContain('optional');
    expect(meanings('a{3}')).toContain('exactly 3');
    expect(meanings('a{2,5}')).toContain('between 2 and 5');
    expect(meanings('a{2,}')).toContain('at least 2');
  });

  it('notices lazy quantifiers', () => {
    expect(meanings('a+?')).toContain('as few as possible');
  });

  it('describes anchors and alternation', () => {
    expect(meanings('^')).toContain('start of the text');
    expect(meanings('$')).toContain('end of the text');
    expect(meanings('a|b')).toContain('either the part before');
  });

  it('describes the kinds of group', () => {
    expect(meanings('(a)')).toContain('capture group');
    expect(meanings('(?:a)')).toContain('not captured');
    expect(meanings('(?=a)')).toContain('look ahead');
    expect(meanings('(?!a)')).toContain('negative look ahead');
    expect(meanings('(?<=a)')).toContain('look behind');
    expect(meanings('(?<name>a)')).toContain('named "name"');
  });

  it('describes character sets, including negated ones', () => {
    expect(meanings('[abc]')).toContain('any one of');
    expect(meanings('[^abc]')).toContain('except');
  });

  it('describes a back reference', () => {
    expect(meanings('(\\w)\\1')).toContain('whatever group 1 matched');
  });

  it('produces something for every pattern in the library', () => {
    for (const entry of PATTERN_LIBRARY) {
      const parts = explain(entry.pattern);
      expect(parts.length).toBeGreaterThan(0);
      for (const part of parts) expect(part.meaning.length).toBeGreaterThan(0);
    }
  });

  it('returns nothing for an empty pattern', () => {
    expect(explain('')).toEqual([]);
  });
});

describe('the pattern library', () => {
  it('every entry compiles', () => {
    for (const entry of PATTERN_LIBRARY) {
      expect(compile(entry.pattern, entry.flags)).toBeInstanceOf(RegExp);
    }
  });

  it('every entry matches something in its own sample', () => {
    for (const entry of PATTERN_LIBRARY) {
      const outcome = runPattern(entry.pattern, entry.flags, entry.sample);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) continue;
      expect(outcome.matches.length, `${entry.name} found nothing in its sample`).toBeGreaterThan(0);
    }
  });

  it('the IPv4 pattern rejects octets above 255', () => {
    const entry = PATTERN_LIBRARY.find((e) => e.name === 'IPv4 address')!;
    const outcome = runPattern(entry.pattern, entry.flags, '999.1.1.1 and 8.8.8.8');
    if (!outcome.ok) return;
    expect(outcome.matches.map((m) => m.value)).toEqual(['8.8.8.8']);
  });

  it('the duplicate word pattern finds a repeat', () => {
    const entry = PATTERN_LIBRARY.find((e) => e.name === 'Duplicate word')!;
    const outcome = runPattern(entry.pattern, entry.flags, 'the the cat sat');
    if (!outcome.ok) return;
    expect(outcome.matches[0].value.toLowerCase()).toBe('the the');
  });

  it('every entry has a note explaining the catch', () => {
    for (const entry of PATTERN_LIBRARY) expect(entry.note.length).toBeGreaterThan(10);
  });
});

describe('saved patterns', () => {
  it('creates one with normalised flags', () => {
    const saved = createSavedPattern('Mine', 'a+', 'ggzi', 'aaa', '');
    expect(saved.flags).toBe('gi');
    expect(saved.name).toBe('Mine');
  });

  it('rejects a record with no pattern', () => {
    expect(reviveSavedPattern({ id: 'a' })).toBeNull();
    expect(reviveSavedPattern(null)).toBeNull();
  });

  it('fills in a missing name', () => {
    expect(reviveSavedPattern({ id: 'a', pattern: 'x' })?.name).toBe('Untitled pattern');
  });

  it('drops unknown flags on the way in', () => {
    expect(reviveSavedPattern({ id: 'a', pattern: 'x', flags: 'gzq' })?.flags).toBe('g');
  });
});
