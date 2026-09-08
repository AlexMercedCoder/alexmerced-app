/** PDF ASCII85Decode, including zero runs and a partial final group. */
export function decodeAscii85(input: Uint8Array): Uint8Array {
  const text = new TextDecoder('ascii').decode(input).replace(/[\x00\t\n\f\r ]/g, '');
  const end = text.indexOf('~>');
  if (end < 0 || end !== text.length - 2) throw new Error('Invalid ASCII85 stream terminator.');
  const source = text.slice(0, end);
  const out: number[] = [];
  let group: number[] = [];
  const flush = (count: number) => {
    let value = 0;
    for (const digit of group) value = value * 85 + digit;
    if (value > 0xffffffff) throw new Error('ASCII85 group exceeds four bytes.');
    for (let index = 0; index < count; index++) out.push((value >>> (24 - index * 8)) & 255);
    group = [];
  };
  for (const char of source) {
    if (char === 'z') {
      if (group.length) throw new Error('ASCII85 zero run inside a group.');
      out.push(0, 0, 0, 0);
      continue;
    }
    const value = char.charCodeAt(0) - 33;
    if (value < 0 || value > 84) throw new Error('Invalid ASCII85 character.');
    group.push(value);
    if (group.length === 5) flush(4);
  }
  if (group.length === 1) throw new Error('Incomplete ASCII85 group.');
  if (group.length) {
    const count = group.length - 1;
    while (group.length < 5) group.push(84);
    flush(count);
  }
  return Uint8Array.from(out);
}
