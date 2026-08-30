/**
 * Reckoner's expression engine.
 *
 * Tokenise, convert to postfix with the shunting-yard algorithm, then evaluate.
 * Doing it properly rather than leaning on eval means precedence, unary signs,
 * and error messages are all under our control, and nothing a visitor types can
 * execute as code.
 */

export type AngleMode = 'deg' | 'rad';

export type EvaluateOptions = {
  angleMode?: AngleMode;
  /** Values available as bare names, for example ans and the memory registers. */
  variables?: Record<string, number>;
};

export class CalculationError extends Error {
  constructor(message: string, readonly position?: number) {
    super(message);
    this.name = 'CalculationError';
  }
}

type TokenType = 'number' | 'name' | 'operator' | 'lparen' | 'rparen' | 'comma';

export type Token = {
  type: TokenType;
  value: string;
  position: number;
};

const OPERATOR_CHARS = new Set(['+', '-', '*', '/', '^', '%', '!', '×', '÷', '−']);

const NORMALISE: Record<string, string> = { '×': '*', '÷': '/', '−': '-', '–': '-' };

type OperatorSpec = {
  precedence: number;
  associativity: 'left' | 'right';
  arity: 1 | 2;
  /** Postfix unary operators bind to the value on their left. */
  postfix?: boolean;
};

const BINARY: Record<string, OperatorSpec> = {
  '+': { precedence: 1, associativity: 'left', arity: 2 },
  '-': { precedence: 1, associativity: 'left', arity: 2 },
  '*': { precedence: 2, associativity: 'left', arity: 2 },
  '/': { precedence: 2, associativity: 'left', arity: 2 },
  '%': { precedence: 2, associativity: 'left', arity: 2 },
  '^': { precedence: 4, associativity: 'right', arity: 2 },
};

const UNARY_MINUS = 'u-';
const UNARY_PLUS = 'u+';
const FACTORIAL = '!';

const UNARY: Record<string, OperatorSpec> = {
  [UNARY_MINUS]: { precedence: 3, associativity: 'right', arity: 1 },
  [UNARY_PLUS]: { precedence: 3, associativity: 'right', arity: 1 },
  [FACTORIAL]: { precedence: 5, associativity: 'left', arity: 1, postfix: true },
};

export const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  π: Math.PI,
  e: Math.E,
  tau: Math.PI * 2,
  phi: (1 + Math.sqrt(5)) / 2,
};

type FunctionSpec = {
  arity: number | 'variadic';
  apply: (args: number[], angleMode: AngleMode) => number;
  help: string;
};

const toRadians = (value: number, mode: AngleMode) => (mode === 'deg' ? (value * Math.PI) / 180 : value);
const fromRadians = (value: number, mode: AngleMode) => (mode === 'deg' ? (value * 180) / Math.PI : value);

function factorial(n: number): number {
  if (!Number.isInteger(n) || n < 0) {
    throw new CalculationError('Factorial needs a whole number that is zero or more.');
  }
  if (n > 170) throw new CalculationError('That factorial is larger than this calculator can represent.');
  let result = 1;
  for (let i = 2; i <= n; i += 1) result *= i;
  return result;
}

export const FUNCTIONS: Record<string, FunctionSpec> = {
  sin: { arity: 1, apply: ([x], m) => Math.sin(toRadians(x, m)), help: 'Sine' },
  cos: { arity: 1, apply: ([x], m) => Math.cos(toRadians(x, m)), help: 'Cosine' },
  tan: { arity: 1, apply: ([x], m) => Math.tan(toRadians(x, m)), help: 'Tangent' },
  asin: { arity: 1, apply: ([x], m) => fromRadians(Math.asin(x), m), help: 'Inverse sine' },
  acos: { arity: 1, apply: ([x], m) => fromRadians(Math.acos(x), m), help: 'Inverse cosine' },
  atan: { arity: 1, apply: ([x], m) => fromRadians(Math.atan(x), m), help: 'Inverse tangent' },
  atan2: { arity: 2, apply: ([y, x], m) => fromRadians(Math.atan2(y, x), m), help: 'Angle of the point (x, y)' },
  sinh: { arity: 1, apply: ([x]) => Math.sinh(x), help: 'Hyperbolic sine' },
  cosh: { arity: 1, apply: ([x]) => Math.cosh(x), help: 'Hyperbolic cosine' },
  tanh: { arity: 1, apply: ([x]) => Math.tanh(x), help: 'Hyperbolic tangent' },
  ln: { arity: 1, apply: ([x]) => Math.log(x), help: 'Natural logarithm' },
  log: { arity: 1, apply: ([x]) => Math.log10(x), help: 'Logarithm base 10' },
  log2: { arity: 1, apply: ([x]) => Math.log2(x), help: 'Logarithm base 2' },
  logb: { arity: 2, apply: ([x, b]) => Math.log(x) / Math.log(b), help: 'Logarithm of x in base b' },
  exp: { arity: 1, apply: ([x]) => Math.exp(x), help: 'e to the power of x' },
  sqrt: { arity: 1, apply: ([x]) => {
    if (x < 0) throw new CalculationError('Square root of a negative number is not a real number.');
    return Math.sqrt(x);
  }, help: 'Square root' },
  cbrt: { arity: 1, apply: ([x]) => Math.cbrt(x), help: 'Cube root' },
  root: { arity: 2, apply: ([x, n]) => (x < 0 && n % 2 === 1 ? -Math.pow(-x, 1 / n) : Math.pow(x, 1 / n)), help: 'The nth root of x' },
  abs: { arity: 1, apply: ([x]) => Math.abs(x), help: 'Absolute value' },
  sign: { arity: 1, apply: ([x]) => Math.sign(x), help: 'Sign: -1, 0, or 1' },
  round: { arity: 'variadic', apply: (args) => {
    const [x, places = 0] = args;
    const factor = 10 ** places;
    return Math.round(x * factor) / factor;
  }, help: 'Round, optionally to a number of decimal places' },
  floor: { arity: 1, apply: ([x]) => Math.floor(x), help: 'Round down' },
  ceil: { arity: 1, apply: ([x]) => Math.ceil(x), help: 'Round up' },
  trunc: { arity: 1, apply: ([x]) => Math.trunc(x), help: 'Drop the fractional part' },
  min: { arity: 'variadic', apply: (args) => Math.min(...args), help: 'Smallest of its arguments' },
  max: { arity: 'variadic', apply: (args) => Math.max(...args), help: 'Largest of its arguments' },
  sum: { arity: 'variadic', apply: (args) => args.reduce((a, b) => a + b, 0), help: 'Add every argument' },
  avg: { arity: 'variadic', apply: (args) => args.reduce((a, b) => a + b, 0) / args.length, help: 'Mean of its arguments' },
  median: { arity: 'variadic', apply: (args) => {
    const sorted = [...args].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }, help: 'Middle value of its arguments' },
  hypot: { arity: 'variadic', apply: (args) => Math.hypot(...args), help: 'Length of the vector' },
  gcd: { arity: 'variadic', apply: (args) => args.map((n) => Math.abs(Math.trunc(n))).reduce((a, b) => {
    let x = a; let y = b;
    while (y) { const t = y; y = x % y; x = t; }
    return x;
  }), help: 'Greatest common divisor' },
  lcm: { arity: 'variadic', apply: (args) => args.map((n) => Math.abs(Math.trunc(n))).reduce((a, b) => {
    if (a === 0 || b === 0) return 0;
    let x = a; let y = b;
    while (y) { const t = y; y = x % y; x = t; }
    return (a / x) * b;
  }), help: 'Least common multiple' },
  fact: { arity: 1, apply: ([x]) => factorial(x), help: 'Factorial' },
  pow: { arity: 2, apply: ([x, y]) => x ** y, help: 'x to the power of y' },
  mod: { arity: 2, apply: ([x, y]) => x % y, help: 'Remainder of x divided by y' },
  pct: { arity: 2, apply: ([part, whole]) => (part / whole) * 100, help: 'part as a percentage of whole' },
  pctof: { arity: 2, apply: ([percent, whole]) => (percent / 100) * whole, help: 'percent of whole' },
};

export const FUNCTION_NAMES = Object.keys(FUNCTIONS).sort();

/** Splits an expression into tokens. Throws on characters it cannot place. */
export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < input.length) {
    const char = input[index];

    if (/\s/.test(char)) { index += 1; continue; }

    // Thousands separators are convenience, not data.
    if (char === ',' ) {
      const previous = tokens[tokens.length - 1];
      const next = input[index + 1];
      if (previous?.type === 'number' && /\d/.test(next ?? '')) {
        // 1,234 style grouping: fold the digits into the preceding number.
        let digits = '';
        let cursor = index + 1;
        while (cursor < input.length && /\d/.test(input[cursor])) { digits += input[cursor]; cursor += 1; }
        if (digits.length === 3 && !/[.]/.test(previous.value)) {
          previous.value += digits;
          index = cursor;
          continue;
        }
      }
      tokens.push({ type: 'comma', value: ',', position: index });
      index += 1;
      continue;
    }

    if (/[0-9.]/.test(char)) {
      let raw = '';
      while (index < input.length && /[0-9.]/.test(input[index])) { raw += input[index]; index += 1; }
      // Scientific notation, for example 1.5e-3.
      if (/[eE]/.test(input[index] ?? '') && /[0-9+-]/.test(input[index + 1] ?? '')) {
        raw += input[index]; index += 1;
        if (/[+-]/.test(input[index])) { raw += input[index]; index += 1; }
        while (index < input.length && /[0-9]/.test(input[index])) { raw += input[index]; index += 1; }
      }
      if ((raw.match(/\./g) ?? []).length > 1) {
        throw new CalculationError(`"${raw}" has more than one decimal point.`, index);
      }
      tokens.push({ type: 'number', value: raw, position: index - raw.length });
      continue;
    }

    if (/[a-zA-Z_π]/.test(char)) {
      let raw = '';
      const start = index;
      while (index < input.length && /[a-zA-Z0-9_π]/.test(input[index])) { raw += input[index]; index += 1; }
      tokens.push({ type: 'name', value: raw, position: start });
      continue;
    }

    if (char === '(') { tokens.push({ type: 'lparen', value: '(', position: index }); index += 1; continue; }
    if (char === ')') { tokens.push({ type: 'rparen', value: ')', position: index }); index += 1; continue; }

    if (OPERATOR_CHARS.has(char)) {
      tokens.push({ type: 'operator', value: NORMALISE[char] ?? char, position: index });
      index += 1;
      continue;
    }

    throw new CalculationError(`I do not know what to do with "${char}".`, index);
  }

  return tokens;
}

/**
 * Inserts implied multiplication so 2(3+1), 3pi, and (1+2)(3+4) all work the
 * way people write them on paper.
 */
function withImplicitMultiplication(tokens: Token[]): Token[] {
  const output: Token[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const previous = tokens[i - 1];

    if (previous) {
      const previousEndsValue =
        previous.type === 'number' ||
        previous.type === 'rparen' ||
        (previous.type === 'name' && !(previous.value in FUNCTIONS)) ||
        (previous.type === 'operator' && previous.value === '!');

      const startsValue =
        token.type === 'number' || token.type === 'name' || token.type === 'lparen';

      if (previousEndsValue && startsValue) {
        output.push({ type: 'operator', value: '*', position: token.position });
      }
    }

    output.push(token);
  }

  return output;
}

type RpnItem =
  | { kind: 'value'; value: number }
  | { kind: 'operator'; op: string }
  | { kind: 'function'; name: string; argCount: number };

/** Shunting-yard: infix tokens in, postfix items out. */
export function toPostfix(tokens: Token[], variables: Record<string, number>): RpnItem[] {
  const output: RpnItem[] = [];
  const operators: ({ kind: 'op'; op: string } | { kind: 'fn'; name: string } | { kind: 'paren' })[] = [];
  const argCounts: number[] = [];
  const functionDepth: boolean[] = [];

  let expectValue = true;

  const popWhile = (test: (top: { op: string }) => boolean) => {
    while (operators.length) {
      const top = operators[operators.length - 1];
      if (top.kind !== 'op' || !test(top)) break;
      operators.pop();
      output.push({ kind: 'operator', op: top.op });
    }
  };

  for (const token of tokens) {
    if (token.type === 'number') {
      const value = Number(token.value);
      if (!Number.isFinite(value)) throw new CalculationError(`"${token.value}" is not a number I can read.`, token.position);
      output.push({ kind: 'value', value });
      expectValue = false;
      continue;
    }

    if (token.type === 'name') {
      const lower = token.value.toLowerCase();
      if (lower in FUNCTIONS) {
        operators.push({ kind: 'fn', name: lower });
        expectValue = true;
        continue;
      }
      if (token.value in CONSTANTS || lower in CONSTANTS) {
        output.push({ kind: 'value', value: CONSTANTS[token.value] ?? CONSTANTS[lower] });
        expectValue = false;
        continue;
      }
      if (token.value in variables || lower in variables) {
        output.push({ kind: 'value', value: variables[token.value] ?? variables[lower] });
        expectValue = false;
        continue;
      }
      throw new CalculationError(`I do not recognise "${token.value}".`, token.position);
    }

    if (token.type === 'operator') {
      if (token.value === '!') {
        if (expectValue) throw new CalculationError('A factorial needs a number in front of it.', token.position);
        popWhile((top) => (UNARY[top.op] ?? BINARY[top.op]).precedence >= UNARY[FACTORIAL].precedence);
        output.push({ kind: 'operator', op: FACTORIAL });
        expectValue = false;
        continue;
      }

      if (expectValue && (token.value === '-' || token.value === '+')) {
        operators.push({ kind: 'op', op: token.value === '-' ? UNARY_MINUS : UNARY_PLUS });
        continue;
      }

      if (expectValue) {
        throw new CalculationError(`"${token.value}" needs a number before it.`, token.position);
      }

      const spec = BINARY[token.value];
      if (!spec) throw new CalculationError(`"${token.value}" is not an operator I know.`, token.position);

      popWhile((top) => {
        const topSpec = UNARY[top.op] ?? BINARY[top.op];
        if (!topSpec) return false;
        return (
          topSpec.precedence > spec.precedence ||
          (topSpec.precedence === spec.precedence && spec.associativity === 'left')
        );
      });

      operators.push({ kind: 'op', op: token.value });
      expectValue = true;
      continue;
    }

    if (token.type === 'lparen') {
      const isFunctionCall = operators[operators.length - 1]?.kind === 'fn';
      operators.push({ kind: 'paren' });
      functionDepth.push(isFunctionCall);
      if (isFunctionCall) argCounts.push(1);
      expectValue = true;
      continue;
    }

    if (token.type === 'comma') {
      if (!functionDepth[functionDepth.length - 1]) {
        throw new CalculationError('A comma only belongs between the arguments of a function.', token.position);
      }
      popWhile(() => true);
      if (operators[operators.length - 1]?.kind !== 'paren') {
        throw new CalculationError('There is a comma outside any brackets.', token.position);
      }
      argCounts[argCounts.length - 1] += 1;
      expectValue = true;
      continue;
    }

    if (token.type === 'rparen') {
      popWhile(() => true);
      const top = operators.pop();
      if (!top || top.kind !== 'paren') {
        throw new CalculationError('There is a closing bracket with nothing to close.', token.position);
      }
      const wasFunctionCall = functionDepth.pop();
      if (wasFunctionCall) {
        const fn = operators.pop();
        if (!fn || fn.kind !== 'fn') throw new CalculationError('A function call is malformed.', token.position);
        output.push({ kind: 'function', name: fn.name, argCount: argCounts.pop() ?? 1 });
      }
      expectValue = false;
      continue;
    }
  }

  while (operators.length) {
    const top = operators.pop()!;
    if (top.kind === 'paren') throw new CalculationError('There is an opening bracket that never closes.');
    if (top.kind === 'fn') throw new CalculationError(`"${top.name}" is missing its brackets.`);
    output.push({ kind: 'operator', op: top.op });
  }

  return output;
}

function applyOperator(op: string, stack: number[]): void {
  if (op === FACTORIAL) {
    const value = stack.pop();
    if (value === undefined) throw new CalculationError('A factorial is missing its number.');
    stack.push(factorial(value));
    return;
  }

  if (op === UNARY_MINUS || op === UNARY_PLUS) {
    const value = stack.pop();
    if (value === undefined) throw new CalculationError('A sign is missing its number.');
    stack.push(op === UNARY_MINUS ? -value : value);
    return;
  }

  const right = stack.pop();
  const left = stack.pop();
  if (left === undefined || right === undefined) {
    throw new CalculationError(`"${op}" is missing one of its numbers.`);
  }

  switch (op) {
    case '+': stack.push(left + right); return;
    case '-': stack.push(left - right); return;
    case '*': stack.push(left * right); return;
    case '/':
      if (right === 0) throw new CalculationError('Division by zero.');
      stack.push(left / right); return;
    case '%':
      if (right === 0) throw new CalculationError('Cannot take a remainder with zero.');
      stack.push(left % right); return;
    case '^': stack.push(left ** right); return;
    default: throw new CalculationError(`"${op}" is not an operator I know.`);
  }
}

export function evaluatePostfix(items: RpnItem[], options: EvaluateOptions = {}): number {
  const angleMode = options.angleMode ?? 'rad';
  const stack: number[] = [];

  for (const item of items) {
    if (item.kind === 'value') { stack.push(item.value); continue; }
    if (item.kind === 'operator') { applyOperator(item.op, stack); continue; }

    const spec = FUNCTIONS[item.name];
    if (!spec) throw new CalculationError(`"${item.name}" is not a function I know.`);

    if (spec.arity !== 'variadic' && spec.arity !== item.argCount) {
      throw new CalculationError(
        `${item.name} takes ${spec.arity} ${spec.arity === 1 ? 'argument' : 'arguments'}, but got ${item.argCount}.`,
      );
    }

    const args = stack.splice(stack.length - item.argCount, item.argCount);
    if (args.length !== item.argCount) throw new CalculationError(`${item.name} is missing arguments.`);
    stack.push(spec.apply(args, angleMode));
  }

  if (stack.length === 0) throw new CalculationError('There is nothing to calculate.');
  if (stack.length > 1) throw new CalculationError('That looks like two expressions run together.');

  const result = stack[0];
  if (Number.isNaN(result)) throw new CalculationError('That does not have a numeric answer.');
  if (!Number.isFinite(result)) throw new CalculationError('The result is too large to represent.');
  return result;
}

/** The whole pipeline: text in, number out. */
export function evaluate(expression: string, options: EvaluateOptions = {}): number {
  const trimmed = expression.trim();
  if (!trimmed) throw new CalculationError('There is nothing to calculate.');
  const tokens = withImplicitMultiplication(tokenize(trimmed));
  return evaluatePostfix(toPostfix(tokens, options.variables ?? {}), options);
}

/** Formats a result for display without dropping precision people care about. */
export function formatNumber(value: number, precision = 12): string {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return value.toLocaleString('en-US');

  const magnitude = Math.abs(value);
  if (magnitude !== 0 && (magnitude < 1e-7 || magnitude >= 1e15)) {
    return value.toExponential(Math.min(precision, 15)).replace(/(\.\d*?)0+e/, '$1e').replace(/\.e/, 'e');
  }

  const rounded = Number(value.toPrecision(precision));
  const [whole, fraction] = String(rounded).split('.');
  const grouped = Number(whole).toLocaleString('en-US');
  return fraction ? `${grouped}.${fraction}` : grouped;
}

/** Checks bracket balance as the visitor types, for the live hint under the input. */
export function bracketBalance(expression: string): number {
  let depth = 0;
  for (const char of expression) {
    if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
  }
  return depth;
}
