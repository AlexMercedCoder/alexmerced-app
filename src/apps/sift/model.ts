import { createId } from '../../lib/id';

export const APP_ID = 'sift';
export const APP_VERSION = 1;

export const FLAGS = [
  { id: 'g', label: 'global', hint: 'Find every match, not just the first' },
  { id: 'i', label: 'ignore case', hint: 'Treat upper and lower case as the same' },
  { id: 'm', label: 'multiline', hint: '^ and $ match at every line break' },
  { id: 's', label: 'dot all', hint: '. also matches a newline' },
  { id: 'u', label: 'unicode', hint: 'Treat the pattern as unicode code points' },
  { id: 'y', label: 'sticky', hint: 'Match only from where the last one ended' },
] as const;

export type FlagId = (typeof FLAGS)[number]['id'];

export type SavedPattern = {
  id: string;
  name: string;
  pattern: string;
  flags: string;
  sample: string;
  replacement: string;
  createdAt: string;
  updatedAt: string;
};

export type MatchGroup = {
  index: number;
  name: string | null;
  value: string | undefined;
  start: number;
  end: number;
};

export type MatchResult = {
  value: string;
  start: number;
  end: number;
  groups: MatchGroup[];
};

/** Result of running a pattern, whether it worked or not. */
export type RunOutcome =
  | { ok: true; matches: MatchResult[]; truncated: boolean; elapsedMs: number }
  | { ok: false; error: string };

export const MAX_MATCHES = 2000;

export function normaliseFlags(flags: string): string {
  const allowed = new Set(FLAGS.map((flag) => flag.id as string));
  const seen = new Set<string>();
  let out = '';
  for (const flag of flags) {
    if (allowed.has(flag) && !seen.has(flag)) { seen.add(flag); out += flag; }
  }
  return out;
}

export function toggleFlag(flags: string, flag: FlagId): string {
  return flags.includes(flag)
    ? normaliseFlags(flags.replace(flag, ''))
    : normaliseFlags(flags + flag);
}

/** Compiles a pattern, turning a syntax error into something readable. */
export function compile(pattern: string, flags: string): RegExp | string {
  if (!pattern) return 'Type a pattern to start matching.';
  try {
    return new RegExp(pattern, normaliseFlags(flags));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/^Invalid regular expression: \/.*\/[a-z]*: /, '');
  }
}

/**
 * Runs a pattern against a subject.
 *
 * This is the pure part. The UI runs it inside a worker so a pattern that
 * backtracks catastrophically kills the worker rather than the page.
 */
export function runPattern(pattern: string, flags: string, subject: string): RunOutcome {
  const compiled = compile(pattern, flags);
  if (typeof compiled === 'string') return { ok: false, error: compiled };

  const started = Date.now();
  const matches: MatchResult[] = [];
  let truncated = false;

  try {
    if (!compiled.global && !compiled.sticky) {
      const match = compiled.exec(subject);
      if (match) matches.push(describeMatch(match));
    } else {
      const global = new RegExp(compiled.source, normaliseFlags(flags).includes('g') ? compiled.flags : `${compiled.flags}g`);
      let match: RegExpExecArray | null;
      while ((match = global.exec(subject)) !== null) {
        matches.push(describeMatch(match));
        // A pattern that can match nothing would otherwise never advance.
        if (match[0] === '') global.lastIndex += 1;
        if (matches.length >= MAX_MATCHES) { truncated = true; break; }
      }
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'That pattern could not be run.' };
  }

  return { ok: true, matches, truncated, elapsedMs: Date.now() - started };
}

function describeMatch(match: RegExpExecArray): MatchResult {
  const start = match.index;
  const groups: MatchGroup[] = [];
  const namesByValue = match.groups ?? {};

  for (let index = 1; index < match.length; index += 1) {
    const value = match[index];
    let name: string | null = null;
    for (const [key, groupValue] of Object.entries(namesByValue)) {
      if (groupValue === value && name === null) name = key;
    }
    // Group offsets are only approximate without the d flag, so they are
    // reported relative to the match and only when the text is actually found.
    const offset = value === undefined ? -1 : match[0].indexOf(value);
    groups.push({
      index,
      name,
      value,
      start: offset === -1 ? -1 : start + offset,
      end: offset === -1 ? -1 : start + offset + value.length,
    });
  }

  return { value: match[0], start, end: start + match[0].length, groups };
}

/** Applies the replacement, so the preview shows the real result. */
export function applyReplacement(pattern: string, flags: string, subject: string, replacement: string): string | { error: string } {
  const compiled = compile(pattern, flags);
  if (typeof compiled === 'string') return { error: compiled };
  try {
    return subject.replace(compiled, replacement);
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'That replacement could not be applied.' };
  }
}

// --------------------------------------------------------------------- explain

export type ExplainPart = { token: string; meaning: string };

const CLASS_MEANINGS: Record<string, string> = {
  '\\d': 'any digit, 0 to 9',
  '\\D': 'anything that is not a digit',
  '\\w': 'a word character: letter, digit, or underscore',
  '\\W': 'anything that is not a word character',
  '\\s': 'any whitespace',
  '\\S': 'anything that is not whitespace',
  '\\b': 'a word boundary',
  '\\B': 'a position that is not a word boundary',
  '\\n': 'a newline',
  '\\r': 'a carriage return',
  '\\t': 'a tab',
};

/**
 * Walks a pattern and describes each piece in plain language. Not a full
 * parser: it explains the constructs people actually get stuck on.
 */
export function explain(pattern: string): ExplainPart[] {
  const parts: ExplainPart[] = [];
  let i = 0;

  const quantifier = (): string | null => {
    const rest = pattern.slice(i);
    const match = /^(\*|\+|\?|\{\d+(?:,\d*)?\})(\?)?/.exec(rest);
    if (!match) return null;
    i += match[0].length;

    const lazy = match[2] ? ', as few as possible' : '';
    if (match[1] === '*') return `repeated zero or more times${lazy}`;
    if (match[1] === '+') return `repeated one or more times${lazy}`;
    if (match[1] === '?') return `optional${lazy}`;

    const inner = match[1].slice(1, -1);
    if (inner.endsWith(',')) return `repeated at least ${inner.slice(0, -1)} times${lazy}`;
    if (inner.includes(',')) {
      const [min, max] = inner.split(',');
      return `repeated between ${min} and ${max} times${lazy}`;
    }
    return `repeated exactly ${inner} times${lazy}`;
  };

  const push = (token: string, meaning: string) => {
    const quantified = quantifier();
    parts.push({ token: quantified ? token + pattern.slice(i - quantified.length) : token, meaning: quantified ? `${meaning}, ${quantified}` : meaning });
  };

  while (i < pattern.length) {
    const start = i;
    const character = pattern[i];

    if (character === '\\') {
      const pair = pattern.slice(i, i + 2);
      i += 2;
      if (CLASS_MEANINGS[pair]) {
        const meaning = CLASS_MEANINGS[pair];
        const q = quantifier();
        parts.push({ token: pattern.slice(start, i), meaning: q ? `${meaning}, ${q}` : meaning });
      } else if (/^\\\d$/.test(pair)) {
        const q = quantifier();
        parts.push({ token: pattern.slice(start, i), meaning: `whatever group ${pair[1]} matched${q ? `, ${q}` : ''}` });
      } else {
        const q = quantifier();
        parts.push({ token: pattern.slice(start, i), meaning: `a literal "${pair[1]}"${q ? `, ${q}` : ''}` });
      }
      continue;
    }

    if (character === '[') {
      let depth = 1;
      i += 1;
      if (pattern[i] === '^') i += 1;
      while (i < pattern.length && depth > 0) {
        if (pattern[i] === '\\') i += 2;
        else if (pattern[i] === ']') { depth -= 1; i += 1; }
        else i += 1;
      }
      const token = pattern.slice(start, i);
      const negated = token.startsWith('[^');
      const q = quantifier();
      parts.push({
        token: q ? pattern.slice(start, i) : token,
        meaning: `${negated ? 'any character except' : 'any one of'} ${token.slice(negated ? 2 : 1, -1) || 'nothing'}${q ? `, ${q}` : ''}`,
      });
      continue;
    }

    if (character === '(') {
      const ahead = pattern.slice(i);
      let meaning = 'the start of a capture group';
      let length = 1;
      const named = /^\(\?<([A-Za-z_$][\w$]*)>/.exec(ahead);
      if (named) { meaning = `the start of a group named "${named[1]}"`; length = named[0].length; }
      else if (ahead.startsWith('(?:')) { meaning = 'the start of a group that is not captured'; length = 3; }
      else if (ahead.startsWith('(?=')) { meaning = 'a look ahead: what follows must match, but is not consumed'; length = 3; }
      else if (ahead.startsWith('(?!')) { meaning = 'a negative look ahead: what follows must not match'; length = 3; }
      else if (ahead.startsWith('(?<=')) { meaning = 'a look behind: what precedes must match'; length = 4; }
      else if (ahead.startsWith('(?<!')) { meaning = 'a negative look behind: what precedes must not match'; length = 4; }
      i += length;
      parts.push({ token: pattern.slice(start, i), meaning });
      continue;
    }

    if (character === ')') {
      i += 1;
      const q = quantifier();
      parts.push({ token: pattern.slice(start, i), meaning: `the end of the group${q ? `, ${q}` : ''}` });
      continue;
    }

    if (character === '.') { i += 1; push('.', 'any character except a newline'); continue; }
    if (character === '^') { i += 1; parts.push({ token: '^', meaning: 'the start of the text, or of a line with the m flag' }); continue; }
    if (character === '$') { i += 1; parts.push({ token: '$', meaning: 'the end of the text, or of a line with the m flag' }); continue; }
    if (character === '|') { i += 1; parts.push({ token: '|', meaning: 'either the part before this or the part after' }); continue; }

    // A run of ordinary characters, stopping before anything a quantifier
    // would bind to on its own.
    let literal = '';
    while (i < pattern.length && !'\\[](){}.^$|*+?'.includes(pattern[i])) { literal += pattern[i]; i += 1; }
    if (literal.length > 1 && /[*+?{]/.test(pattern[i] ?? '')) {
      // The last character belongs to the quantifier that follows.
      i -= 1;
      literal = literal.slice(0, -1);
    }
    if (literal) {
      const trailing = pattern[i];
      if (trailing && '*+?{'.includes(trailing)) {
        const single = pattern[i - 1];
        parts.push({ token: literal, meaning: `the text "${literal}"` });
        i += 0;
        void single;
      } else {
        parts.push({ token: literal, meaning: `the text "${literal}"` });
      }
      continue;
    }

    // A quantifier with nothing before it in this walk.
    const q = quantifier();
    if (q) { parts.push({ token: pattern.slice(start, i), meaning: `the previous item ${q}` }); continue; }

    i += 1;
    parts.push({ token: character, meaning: `a literal "${character}"` });
  }

  return parts;
}

// --------------------------------------------------------------------- library

export const PATTERN_LIBRARY: { name: string; pattern: string; flags: string; sample: string; note: string }[] = [
  {
    name: 'Email address',
    pattern: "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}",
    flags: 'g',
    sample: 'Write to alex@example.com or support@sub.domain.co.uk, not to "nobody@".',
    note: 'Deliberately permissive. The only certain test of an address is sending to it.',
  },
  {
    name: 'URL',
    pattern: "https?://[^\\s<>\"']+",
    flags: 'g',
    sample: 'See https://alexmerced.app/sift and http://example.org/path?query=1 for details.',
    note: 'Stops at whitespace and quotes, which is what you want when pulling links out of prose.',
  },
  {
    name: 'IPv4 address',
    pattern: "\\b(?:(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)\\.){3}(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)\\b",
    flags: 'g',
    sample: 'Valid: 192.168.1.1, 8.8.8.8, 255.255.255.0. Not valid: 999.1.1.1 or 1.2.3.',
    note: 'Range checked, so it rejects octets above 255 rather than matching any four numbers.',
  },
  {
    name: 'ISO date',
    pattern: "\\b(\\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])\\b",
    flags: 'g',
    sample: 'Released 2026-08-30, revised 2026-12-01. Not a date: 2026-13-45.',
    note: 'Captures year, month and day separately so you can reformat with $1, $2 and $3.',
  },
  {
    name: 'Duplicate word',
    pattern: "\\b(\\w+)\\s+\\1\\b",
    flags: 'gi',
    sample: 'The the quick brown fox jumped over over the lazy dog.',
    note: 'Uses a back reference, so it finds a word repeated immediately after itself.',
  },
  {
    name: 'Trailing whitespace',
    pattern: "[ \\t]+$",
    flags: 'gm',
    sample: 'clean line\nline with trailing spaces   \nanother\t\n',
    note: 'Needs the multiline flag, or $ only matches the very end of the text.',
  },
  {
    name: 'Quoted string',
    pattern: "\"([^\"\\\\]|\\\\.)*\"",
    flags: 'g',
    sample: 'A "simple" one and a "tricky \\" escaped" one.',
    note: 'Handles escaped quotes inside the string, which the naive version gets wrong.',
  },
  {
    name: 'Semantic version',
    pattern: "\\bv?(\\d+)\\.(\\d+)\\.(\\d+)(?:-([0-9A-Za-z.-]+))?\\b",
    flags: 'g',
    sample: 'Shipping v1.4.2 and 2.0.0-rc.1 today, dropping 0.9.9.',
    note: 'Captures major, minor, patch and an optional prerelease tag.',
  },
  {
    name: 'CSV field, quoted or bare',
    pattern: "(\"[^\"]*(?:\"\"[^\"]*)*\"|[^,\\n]*)(,|$)",
    flags: 'gm',
    sample: 'name,note\nAlex,"has, a comma"\nSam,"says ""hi"""',
    note: 'Shows why hand-rolled CSV parsing goes wrong: the doubled quote case.',
  },
  {
    name: 'Hex colour',
    pattern: "#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\\b",
    flags: 'g',
    sample: 'Accent #b4552d, short form #fff, not a colour #12345.',
    note: 'Accepts both the three and six digit forms.',
  },
];

export function createSavedPattern(
  name: string,
  pattern: string,
  flags: string,
  sample: string,
  replacement: string,
  now: Date = new Date(),
): SavedPattern {
  const stamp = now.toISOString();
  return { id: createId('rx'), name, pattern, flags: normaliseFlags(flags), sample, replacement, createdAt: stamp, updatedAt: stamp };
}

export function reviveSavedPattern(value: unknown): SavedPattern | null {
  if (typeof value !== 'object' || value === null) return null;
  const saved = value as Partial<SavedPattern>;
  if (typeof saved.id !== 'string' || typeof saved.pattern !== 'string') return null;
  const stamp = new Date().toISOString();
  return {
    id: saved.id,
    name: typeof saved.name === 'string' && saved.name.trim() ? saved.name : 'Untitled pattern',
    pattern: saved.pattern,
    flags: normaliseFlags(typeof saved.flags === 'string' ? saved.flags : ''),
    sample: typeof saved.sample === 'string' ? saved.sample : '',
    replacement: typeof saved.replacement === 'string' ? saved.replacement : '',
    createdAt: typeof saved.createdAt === 'string' ? saved.createdAt : stamp,
    updatedAt: typeof saved.updatedAt === 'string' ? saved.updatedAt : stamp,
  };
}

/** Splits a subject into runs so the UI can highlight matches without HTML injection. */
export type Segment = { text: string; matchIndex: number | null };

export function segment(subject: string, matches: MatchResult[]): Segment[] {
  if (!matches.length) return subject ? [{ text: subject, matchIndex: null }] : [];

  const segments: Segment[] = [];
  let cursor = 0;

  matches.forEach((match, index) => {
    if (match.start < cursor) return; // overlapping, already covered
    if (match.start > cursor) segments.push({ text: subject.slice(cursor, match.start), matchIndex: null });
    segments.push({ text: subject.slice(match.start, match.end), matchIndex: index });
    cursor = match.end;
  });

  if (cursor < subject.length) segments.push({ text: subject.slice(cursor), matchIndex: null });
  return segments;
}
