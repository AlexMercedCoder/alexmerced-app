import { expect, it } from 'vitest';
import { decodeAscii85 } from './ascii85';
const read = (value: string) => decodeAscii85(new TextEncoder().encode(value));
it('decodes Adobe ASCII85 text, zero runs and partial groups', () => {
  expect(new TextDecoder().decode(read('87cURD_*#TDfTZ)+T~>'))).toBe('Hello, world!');
  expect([...read('z\n!!~>')]).toEqual([0, 0, 0, 0, 0]);
  expect([...read('~>')]).toEqual([]);
});
it.each(['!~>', '!z~>', 'uuuuu~>', 'v~>', '!!!!!', '!!!!!~>junk'])('refuses malformed ASCII85: %s', (value) => {
  expect(() => read(value)).toThrow(/ASCII85/);
});
