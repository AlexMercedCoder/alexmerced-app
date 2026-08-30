import { errorResult, readNumber, readString, requireString, textResult, truncate, type McpTool } from '../../lib/webmcp';
import { applyReplacement, compile, explain, normaliseFlags, runPattern } from './model';

/**
 * Sift's tools. A regular expression is easy to write and hard to be sure
 * about. These let an agent check one against real input, and read back what
 * each piece of it actually does, before putting it into someone's code.
 */
export function siftTools(): McpTool[] {
  return [
    {
      name: 'sift_test_regex',
      description:
        'Run a regular expression against some text and report every match, where it starts, and what each capture group caught, including named groups. Use this to check a pattern actually does what you think before recommending it.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'The expression, without the surrounding slashes.' },
          subject: { type: 'string', description: 'The text to search.' },
          flags: { type: 'string', description: 'Any of g, i, m, s, u, y. "g" is added when it is missing.' },
          limit: { type: 'number', description: 'How many matches to return. 50 by default.' },
        },
        required: ['pattern', 'subject'],
      },
      execute: (input) => {
        const pattern = requireString(input, 'pattern');
        const subject = readString(input, 'subject');
        const flags = normaliseFlags(readString(input, 'flags', 'g'));
        const limit = Math.max(1, Math.min(1000, Math.round(readNumber(input, 'limit', 50))));

        const compiled = compile(pattern, flags);
        if (typeof compiled === 'string') return errorResult(compiled, { pattern, flags });

        const outcome = runPattern(pattern, flags, subject);
        if (!outcome.ok) return errorResult(outcome.error, { pattern, flags });

        const trimmed = truncate(outcome.matches, limit);
        return textResult({
          pattern,
          flags,
          matchCount: outcome.matches.length,
          returned: trimmed.items.length,
          // The engine stops early on a very large number of matches, and the
          // caller needs to know that before drawing a conclusion from a count.
          engineTruncated: outcome.truncated,
          truncated: trimmed.truncated,
          elapsedMs: outcome.elapsedMs,
          matches: trimmed.items.map((match) => ({
            text: match.value,
            start: match.start,
            end: match.end,
            groups: match.groups.map((group) => ({
              index: group.index,
              name: group.name,
              // An optional group that did not participate has no value at all,
              // which is different from having matched an empty string.
              text: group.value ?? null,
              start: group.start,
              end: group.end,
            })),
          })),
        });
      },
    },
    {
      name: 'sift_replace',
      description:
        'Apply a regular expression replacement and return the result. The replacement string supports $1, $2 and $<name> for capture groups, and $& for the whole match.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          subject: { type: 'string' },
          replacement: { type: 'string', description: 'For example "$2, $1".' },
          flags: { type: 'string' },
        },
        required: ['pattern', 'subject', 'replacement'],
      },
      execute: (input) => {
        const pattern = requireString(input, 'pattern');
        const subject = readString(input, 'subject');
        const replacement = readString(input, 'replacement');
        const flags = normaliseFlags(readString(input, 'flags', 'g'));

        const result = applyReplacement(pattern, flags, subject, replacement);
        if (typeof result === 'object') return errorResult(result.error, { pattern, flags });
        return textResult({ pattern, flags, replacement, result, changed: result !== subject });
      },
    },
    {
      name: 'sift_explain_regex',
      description:
        'Break a regular expression into its pieces and say in plain English what each one does. Use it to check your reading of a pattern someone else wrote, or to justify one you are proposing.',
      inputSchema: {
        type: 'object',
        properties: { pattern: { type: 'string' } },
        required: ['pattern'],
      },
      execute: (input) => {
        const pattern = requireString(input, 'pattern');
        const parts = explain(pattern);
        if (parts.length === 0) return errorResult('There was nothing to explain in that pattern.', { pattern });
        return textResult({ pattern, parts });
      },
    },
  ];
}
