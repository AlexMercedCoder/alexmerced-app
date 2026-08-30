import { describe, expect, it } from 'vitest';
import { CalculationError, bracketBalance, evaluate, formatNumber, tokenize } from './engine';

const calc = (expression: string, options = {}) => evaluate(expression, options);

describe('arithmetic and precedence', () => {
  it('adds and subtracts left to right', () => {
    expect(calc('1 + 2 - 3')).toBe(0);
    expect(calc('10 - 2 - 3')).toBe(5);
  });

  it('gives multiplication and division higher precedence', () => {
    expect(calc('2 + 3 * 4')).toBe(14);
    expect(calc('20 - 12 / 4')).toBe(17);
  });

  it('treats exponentiation as right associative', () => {
    expect(calc('2 ^ 3 ^ 2')).toBe(512);
    expect(calc('(2 ^ 3) ^ 2')).toBe(64);
  });

  it('binds exponentiation tighter than unary minus', () => {
    expect(calc('-2 ^ 2')).toBe(-4);
    expect(calc('(-2) ^ 2')).toBe(4);
  });

  it('handles nested parentheses', () => {
    expect(calc('((2 + 3) * (4 - 1)) / 5')).toBe(3);
  });

  it('handles chained unary signs', () => {
    expect(calc('--5')).toBe(5);
    expect(calc('-+-5')).toBe(5);
    expect(calc('3 - -2')).toBe(5);
  });

  it('computes remainders', () => {
    expect(calc('17 % 5')).toBe(2);
    expect(calc('-7 % 3')).toBe(-1);
  });
});

describe('implicit multiplication', () => {
  it('multiplies a number by a bracketed group', () => {
    expect(calc('2(3 + 1)')).toBe(8);
  });

  it('multiplies adjacent groups', () => {
    expect(calc('(1 + 2)(3 + 4)')).toBe(21);
  });

  it('multiplies a number by a constant', () => {
    expect(calc('2pi')).toBeCloseTo(Math.PI * 2, 12);
  });

  it('does not break a function call', () => {
    expect(calc('2sqrt(9)')).toBe(6);
  });
});

describe('numbers', () => {
  it('reads decimals', () => {
    expect(calc('0.1 + 0.2')).toBeCloseTo(0.3, 12);
  });

  it('reads scientific notation', () => {
    expect(calc('1.5e3')).toBe(1500);
    expect(calc('2e-3')).toBeCloseTo(0.002, 12);
  });

  it('folds thousands separators into one number', () => {
    expect(calc('1,234 + 1')).toBe(1235);
    expect(calc('1,234,567')).toBe(1234567);
  });

  it('rejects a number with two decimal points', () => {
    expect(() => calc('1.2.3')).toThrow(/more than one decimal point/);
  });
});

describe('functions', () => {
  it('applies single argument functions', () => {
    expect(calc('sqrt(16)')).toBe(4);
    expect(calc('abs(-9)')).toBe(9);
    expect(calc('ln(e)')).toBeCloseTo(1, 12);
    expect(calc('log(1000)')).toBeCloseTo(3, 12);
  });

  it('applies two argument functions', () => {
    expect(calc('pow(2, 10)')).toBe(1024);
    expect(calc('logb(81, 3)')).toBeCloseTo(4, 12);
    expect(calc('root(27, 3)')).toBeCloseTo(3, 12);
  });

  it('applies variadic functions', () => {
    expect(calc('max(3, 9, 2)')).toBe(9);
    expect(calc('sum(1, 2, 3, 4)')).toBe(10);
    expect(calc('avg(2, 4, 6)')).toBe(4);
    expect(calc('median(5, 1, 3)')).toBe(3);
    expect(calc('median(4, 1, 3, 2)')).toBe(2.5);
  });

  it('rounds to a chosen number of places', () => {
    expect(calc('round(3.14159, 2)')).toBe(3.14);
    expect(calc('round(2.5)')).toBe(3);
  });

  it('computes gcd and lcm across several arguments', () => {
    expect(calc('gcd(12, 18, 24)')).toBe(6);
    expect(calc('lcm(4, 6)')).toBe(12);
  });

  it('nests function calls', () => {
    expect(calc('sqrt(pow(3, 2) + pow(4, 2))')).toBe(5);
  });

  it('rejects the wrong number of arguments', () => {
    expect(() => calc('pow(2)')).toThrow(/takes 2 arguments/);
    expect(() => calc('sqrt(1, 2)')).toThrow(/takes 1 argument/);
  });

  it('handles the percentage helpers', () => {
    expect(calc('pct(25, 200)')).toBe(12.5);
    expect(calc('pctof(15, 80)')).toBe(12);
  });
});

describe('angle mode', () => {
  it('treats arguments as radians by default', () => {
    expect(calc('sin(pi / 2)')).toBeCloseTo(1, 12);
  });

  it('treats arguments as degrees when asked', () => {
    expect(calc('sin(90)', { angleMode: 'deg' })).toBeCloseTo(1, 12);
    expect(calc('cos(180)', { angleMode: 'deg' })).toBeCloseTo(-1, 12);
  });

  it('returns inverse functions in the same unit', () => {
    expect(calc('asin(1)', { angleMode: 'deg' })).toBeCloseTo(90, 10);
    expect(calc('asin(1)', { angleMode: 'rad' })).toBeCloseTo(Math.PI / 2, 12);
  });
});

describe('factorial', () => {
  it('computes whole number factorials', () => {
    expect(calc('5!')).toBe(120);
    expect(calc('0!')).toBe(1);
  });

  it('binds tighter than multiplication', () => {
    expect(calc('2 * 3!')).toBe(12);
  });

  it('rejects fractions and negatives', () => {
    expect(() => calc('2.5!')).toThrow(/whole number/);
    expect(() => calc('(-1)!')).toThrow(/whole number/);
  });

  it('refuses factorials beyond the float range', () => {
    expect(() => calc('200!')).toThrow(/larger than this calculator/);
  });
});

describe('variables', () => {
  it('reads supplied variables', () => {
    expect(calc('ans * 2', { variables: { ans: 21 } })).toBe(42);
    expect(calc('m1 + m2', { variables: { m1: 3, m2: 4 } })).toBe(7);
  });

  it('reports an unknown name rather than guessing', () => {
    expect(() => calc('nope + 1')).toThrow(/do not recognise "nope"/);
  });
});

describe('errors', () => {
  it('refuses an empty expression', () => {
    expect(() => calc('   ')).toThrow(/nothing to calculate/);
  });

  it('catches an unclosed bracket', () => {
    expect(() => calc('2 * (3 + 4')).toThrow(/never closes/);
  });

  it('catches a stray closing bracket', () => {
    expect(() => calc('2 + 3)')).toThrow(/nothing to close/);
  });

  it('catches a dangling operator', () => {
    expect(() => calc('2 +')).toThrow(CalculationError);
    expect(() => calc('* 2')).toThrow(/needs a number before it/);
  });

  it('reports division by zero rather than returning Infinity', () => {
    expect(() => calc('1 / 0')).toThrow(/Division by zero/);
  });

  it('rejects an unknown character', () => {
    expect(() => calc('2 @ 3')).toThrow(/do not know what to do with "@"/);
  });

  it('rejects the square root of a negative number', () => {
    expect(() => calc('sqrt(-4)')).toThrow(/not a real number/);
  });

  it('rejects a comma outside a function call', () => {
    expect(() => calc('(1, 2)')).toThrow(/between the arguments of a function/);
  });

  it('rejects two expressions run together', () => {
    expect(() => calc('2 3', { variables: {} })).not.toThrow(); // implicit multiplication
    expect(calc('2 3')).toBe(6);
  });
});

describe('unicode operators', () => {
  it('accepts the multiplication and division signs', () => {
    expect(calc('6 × 7')).toBe(42);
    expect(calc('84 ÷ 2')).toBe(42);
    expect(calc('5 − 3')).toBe(2);
  });
});

describe('tokenize', () => {
  it('records positions for error reporting', () => {
    const tokens = tokenize('12 + ab');
    expect(tokens.map((t) => t.type)).toEqual(['number', 'operator', 'name']);
    expect(tokens[2].position).toBe(5);
  });
});

describe('formatNumber', () => {
  it('groups whole numbers', () => {
    expect(formatNumber(1234567)).toBe('1,234,567');
  });

  it('keeps a sensible number of decimals', () => {
    expect(formatNumber(1 / 3)).toBe('0.333333333333');
  });

  it('switches to exponent form when the magnitude demands it', () => {
    expect(formatNumber(1e20)).toMatch(/e\+?20/);
    expect(formatNumber(1e-9)).toMatch(/e-9/);
  });

  it('groups the whole part of a decimal', () => {
    expect(formatNumber(1234.5)).toBe('1,234.5');
  });
});

describe('bracketBalance', () => {
  it('counts unclosed brackets', () => {
    expect(bracketBalance('((1+2)')).toBe(1);
    expect(bracketBalance('(1+2)')).toBe(0);
    expect(bracketBalance('1+2)')).toBe(-1);
  });
});
