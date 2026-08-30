import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  errorResult, fileResult, modelContext, readBoolean, readEnum, readNumber, readString,
  readStringArray, registerTools, requireString, textResult, truncate, type McpTool,
} from './webmcp';

function stubContext(registerTool: (tool: unknown) => unknown) {
  Object.defineProperty(globalThis, 'navigator', {
    value: { registerTool },
    writable: true,
    configurable: true,
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, 'navigator', { value: undefined, writable: true, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: undefined, writable: true, configurable: true });
});

const tool = (name: string, execute: McpTool['execute']): McpTool => ({
  name,
  description: 'A tool.',
  inputSchema: { type: 'object' },
  execute,
});

describe('modelContext', () => {
  /** Puts a registry in one of the four shapes the proposal has taken. */
  function place(where: 'navigator.modelContext' | 'document.modelContext' | 'navigator' | 'document') {
    const registry = { registerTool: () => {} };
    const value = where.endsWith('.modelContext') ? { modelContext: registry } : registry;
    const target = where.startsWith('navigator') ? 'navigator' : 'document';
    Object.defineProperty(globalThis, target, { value, writable: true, configurable: true });
    return registry;
  }

  it('finds nothing when the browser does not offer it', () => {
    expect(modelContext()).toBeNull();
  });

  it('finds it wherever the proposal has put it', () => {
    for (const where of ['navigator.modelContext', 'document.modelContext', 'navigator', 'document'] as const) {
      Object.defineProperty(globalThis, 'navigator', { value: undefined, writable: true, configurable: true });
      Object.defineProperty(globalThis, 'document', { value: undefined, writable: true, configurable: true });
      const registry = place(where);
      expect(modelContext(), where).toBe(registry);
    }
  });

  it('prefers document.modelContext, the current standards-shaped entry point', () => {
    const onNavigator = { registerTool: () => {} };
    Object.defineProperty(globalThis, 'navigator', { value: { modelContext: onNavigator }, writable: true, configurable: true });
    Object.defineProperty(globalThis, 'document', { value: { modelContext: { registerTool: () => {} } }, writable: true, configurable: true });
    expect(modelContext()).not.toBe(onNavigator);
    expect(modelContext()).toBe((globalThis.document as unknown as { modelContext: unknown }).modelContext);
  });

  it('ignores a modelContext that carries no registerTool', () => {
    Object.defineProperty(globalThis, 'navigator', { value: { modelContext: {} }, writable: true, configurable: true });
    expect(modelContext()).toBeNull();
  });

  it('registers through document.modelContext', () => {
    const seen: string[] = [];
    Object.defineProperty(globalThis, 'document', {
      value: { modelContext: { registerTool: (entry: { name: string }) => seen.push(entry.name) } },
      writable: true, configurable: true,
    });
    expect(registerTools([tool('a', () => textResult('x'))])).toBe(1);
    expect(seen).toEqual(['a']);
  });
});

describe('registerTools', () => {
  it('does nothing without a context, rather than throwing', () => {
    expect(registerTools([tool('a', () => textResult('x'))])).toBe(0);
  });

  it('registers every tool and reports the count', () => {
    const seen: string[] = [];
    stubContext((entry) => { seen.push((entry as { name: string }).name); });
    expect(registerTools([tool('a', () => textResult('x')), tool('b', () => textResult('y'))])).toBe(2);
    expect(seen).toEqual(['a', 'b']);
  });

  it('carries on when one registration fails', () => {
    stubContext((entry) => {
      if ((entry as { name: string }).name === 'bad') throw new Error('taken');
    });
    expect(registerTools([tool('bad', () => textResult('x')), tool('good', () => textResult('y'))])).toBe(1);
  });

  it('turns a thrown error into a described one rather than losing it', async () => {
    let captured: { execute: (input: Record<string, unknown>) => Promise<unknown> } | null = null;
    stubContext((entry) => { captured = entry as typeof captured; });
    registerTools([tool('boom', () => { throw new Error('the file was not readable'); })]);

    const result = await captured!.execute({}) as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toBe('the file was not readable');
  });

  it('passes an empty object when the caller sends nothing', async () => {
    const spy = vi.fn(() => textResult('ok'));
    let captured: { execute: (input?: Record<string, unknown>) => Promise<unknown> } | null = null;
    stubContext((entry) => { captured = entry as typeof captured; });
    registerTools([tool('t', spy)]);
    await captured!.execute();
    expect(spy).toHaveBeenCalledWith({});
  });

  it('awaits an async tool', async () => {
    let captured: { execute: (input: Record<string, unknown>) => Promise<unknown> } | null = null;
    stubContext((entry) => { captured = entry as typeof captured; });
    registerTools([tool('t', async () => textResult('later'))]);
    const result = await captured!.execute({}) as { content: { text: string }[] };
    expect(result.content[0].text).toBe('later');
  });
});

describe('results', () => {
  it('passes a string straight through', () => {
    expect(textResult('hello').content[0].text).toBe('hello');
  });

  it('formats an object as readable JSON', () => {
    expect(JSON.parse(textResult({ a: 1 }).content[0].text)).toEqual({ a: 1 });
  });

  it('survives a bigint, which JSON alone would throw on', () => {
    expect(() => textResult({ big: 1n })).not.toThrow();
    expect(JSON.parse(textResult({ big: 1n }).content[0].text).big).toBe('1');
  });

  it('describes bytes rather than dumping them', () => {
    expect(JSON.parse(textResult({ data: new Uint8Array(500) }).content[0].text).data).toBe('<500 bytes>');
  });

  it('marks an error result as one', () => {
    const result = errorResult('no such thing', { available: ['a'] });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({ error: 'no such thing', available: ['a'] });
  });

  it('wraps a file as a data URI with its size stated', () => {
    const result = fileResult('a.txt', new TextEncoder().encode('hi'), 'text/plain', { note: 'small' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.filename).toBe('a.txt');
    expect(parsed.bytes).toBe(2);
    expect(parsed.dataUri).toBe('data:text/plain;base64,aGk=');
    expect(parsed.note).toBe('small');
  });

  it('encodes a file too large for a naive base64 call', () => {
    const parsed = JSON.parse(fileResult('big.bin', new Uint8Array(200_000), 'application/octet-stream').content[0].text);
    expect(parsed.dataUri.length).toBeGreaterThan(200_000);
  });
});

describe('input helpers', () => {
  it('reads strings, with a fallback', () => {
    expect(readString({ a: 'x' }, 'a')).toBe('x');
    expect(readString({}, 'a', 'fallback')).toBe('fallback');
    expect(readString({ a: 5 }, 'a', 'fallback')).toBe('fallback');
  });

  it('insists on a required string', () => {
    expect(requireString({ a: 'x' }, 'a')).toBe('x');
    expect(() => requireString({}, 'a')).toThrow(/"a" is required/);
    expect(() => requireString({ a: '  ' }, 'a')).toThrow(/required/);
  });

  it('reads numbers, including ones sent as strings', () => {
    expect(readNumber({ a: 5 }, 'a', 0)).toBe(5);
    expect(readNumber({ a: '5.5' }, 'a', 0)).toBe(5.5);
    expect(readNumber({ a: 'nope' }, 'a', 7)).toBe(7);
    expect(readNumber({ a: NaN }, 'a', 7)).toBe(7);
    expect(readNumber({}, 'a', 7)).toBe(7);
  });

  it('reads booleans, including ones sent as strings', () => {
    expect(readBoolean({ a: true }, 'a')).toBe(true);
    expect(readBoolean({ a: 'true' }, 'a')).toBe(true);
    expect(readBoolean({ a: 'false' }, 'a', true)).toBe(false);
    expect(readBoolean({}, 'a', true)).toBe(true);
  });

  it('reads an enum, refusing anything outside it', () => {
    expect(readEnum({ a: 'csv' }, 'a', ['csv', 'json'] as const, 'json')).toBe('csv');
    expect(readEnum({ a: 'xml' }, 'a', ['csv', 'json'] as const, 'json')).toBe('json');
  });

  it('reads a string array from a list or a comma separated string', () => {
    expect(readStringArray({ a: ['x', 'y'] }, 'a')).toEqual(['x', 'y']);
    expect(readStringArray({ a: 'x, y' }, 'a')).toEqual(['x', 'y']);
    expect(readStringArray({ a: ['x', 5] }, 'a')).toEqual(['x']);
    expect(readStringArray({}, 'a')).toEqual([]);
  });
});

describe('truncate', () => {
  it('reports the full total even when it trims', () => {
    const result = truncate([1, 2, 3, 4, 5], 2);
    expect(result.items).toEqual([1, 2]);
    expect(result.total).toBe(5);
    expect(result.truncated).toBe(true);
  });

  it('says so when nothing was trimmed', () => {
    expect(truncate([1, 2], 10).truncated).toBe(false);
  });
});

describe('registering late', () => {
  it('registers as soon as the context appears, rather than giving up', async () => {
    vi.useFakeTimers();
    try {
      // No registry at all when the page loads, which is what an extension
      // that injects one a moment later looks like.
      expect(registerTools([tool('late', () => textResult('x'))])).toBe(0);

      const seen: string[] = [];
      Object.defineProperty(globalThis, 'navigator', {
        value: { modelContext: { registerTool: (entry: { name: string }) => seen.push(entry.name) } },
        writable: true, configurable: true,
      });

      await vi.advanceTimersByTimeAsync(400);
      expect(seen).toEqual(['late']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops watching rather than polling for ever', async () => {
    vi.useFakeTimers();
    try {
      registerTools([tool('never', () => textResult('x'))]);
      await vi.advanceTimersByTimeAsync(30_000);

      const seen: string[] = [];
      Object.defineProperty(globalThis, 'navigator', {
        value: { modelContext: { registerTool: (entry: { name: string }) => seen.push(entry.name) } },
        writable: true, configurable: true,
      });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(seen).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('registers immediately when the context is already there', () => {
    const seen: string[] = [];
    Object.defineProperty(globalThis, 'navigator', {
      value: { modelContext: { registerTool: (entry: { name: string }) => seen.push(entry.name) } },
      writable: true, configurable: true,
    });
    expect(registerTools([tool('now', () => textResult('x'))])).toBe(1);
    expect(seen).toEqual(['now']);
  });
});
