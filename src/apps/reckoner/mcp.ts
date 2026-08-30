import {
  errorResult, readEnum, readNumber, requireString, textResult, type McpTool,
} from '../../lib/webmcp';
import { evaluate } from './engine';

/**
 * Reckoner's tools. The calculator's whole value to an agent is that it is a
 * real parser rather than a language runtime: an expression can be evaluated
 * without handing arbitrary code to eval.
 */
export function reckonerTools(): McpTool[] {
  return [
    {
      name: 'reckoner_evaluate',
      description:
        'Evaluate a mathematical expression exactly, using a real parser rather than eval. Handles precedence, parentheses, unary signs, powers, factorials, and around thirty functions (sin, cos, tan and their inverses, ln, log, sqrt, cbrt, abs, floor, ceil, round, min, max, gcd, and so on) plus the constants pi and e. Angles are radians unless you say otherwise.',
      inputSchema: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: 'For example "2 * (3 + 4)^2" or "sin(pi/6) + log(100)".' },
          angleMode: { type: 'string', enum: ['rad', 'deg'], description: 'How to read angles. Radians by default.' },
          precision: { type: 'number', description: 'Significant digits in the formatted answer, 1 to 15. Twelve by default.' },
        },
        required: ['expression'],
      },
      execute: (input) => {
        const expression = requireString(input, 'expression');
        const angleMode = readEnum(input, 'angleMode', ['rad', 'deg'] as const, 'rad');
        const precision = Math.max(1, Math.min(15, Math.round(readNumber(input, 'precision', 12))));

        try {
          const value = evaluate(expression, { angleMode });
          return textResult({
            expression,
            value,
            formatted: format(value, precision),
            angleMode,
          });
        } catch (error) {
          return errorResult(
            error instanceof Error ? error.message : 'That expression could not be evaluated.',
            { expression },
          );
        }
      },
    },
    {
      name: 'reckoner_evaluate_many',
      description:
        'Evaluate several expressions at once, each independently. Useful for working through a list of figures without a round trip per line. An expression that fails is reported in place rather than stopping the rest.',
      inputSchema: {
        type: 'object',
        properties: {
          expressions: {
            type: 'array',
            items: { type: 'string' },
            description: 'Up to 200 expressions.',
          },
          angleMode: { type: 'string', enum: ['rad', 'deg'] },
        },
        required: ['expressions'],
      },
      execute: (input) => {
        const raw = input.expressions;
        const list = (Array.isArray(raw) ? raw : String(raw ?? '').split('\n'))
          .filter((entry): entry is string => typeof entry === 'string')
          .map((entry) => entry.trim())
          .filter(Boolean)
          .slice(0, 200);

        if (list.length === 0) throw new Error('"expressions" must hold at least one expression.');
        const angleMode = readEnum(input, 'angleMode', ['rad', 'deg'] as const, 'rad');

        return textResult({
          angleMode,
          results: list.map((expression) => {
            try {
              const value = evaluate(expression, { angleMode });
              return { expression, value, formatted: format(value, 12) };
            } catch (error) {
              return { expression, error: error instanceof Error ? error.message : 'Could not evaluate.' };
            }
          }),
        });
      },
    },
  ];
}

/** Matches what the calculator itself shows, so the two never disagree. */
function format(value: number, precision: number): string {
  if (!Number.isFinite(value)) return Number.isNaN(value) ? 'not a number' : value > 0 ? 'infinity' : '-infinity';
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value);
  const fixed = Number(value.toPrecision(precision));
  return String(fixed);
}
