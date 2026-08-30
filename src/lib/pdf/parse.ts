/**
 * A PDF reader, enough of one to move pages around.
 *
 * Rendering a PDF is an enormous job. Rearranging one is not: the file is a set
 * of numbered objects, and reordering pages means copying the objects a page
 * depends on into a new file and rewriting the page tree. Content streams never
 * have to be understood, only carried across intact.
 *
 * Handles classic cross-reference tables, the cross-reference streams
 * introduced in PDF 1.5, and object streams. Encrypted files are refused.
 */

export class PdfReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfReadError';
  }
}

export type PdfName = { name: string };
export type PdfRef = { ref: number; gen: number };
export type PdfDict = Map<string, PdfValue>;
export type PdfStream = { dict: PdfDict; raw: Uint8Array };
export type PdfValue =
  | null | boolean | number | string
  | PdfName | PdfRef | PdfValue[] | PdfDict | PdfStream;

export const isName = (value: PdfValue): value is PdfName =>
  typeof value === 'object' && value !== null && 'name' in value;
export const isRef = (value: PdfValue): value is PdfRef =>
  typeof value === 'object' && value !== null && 'ref' in value;
export const isDict = (value: PdfValue): value is PdfDict => value instanceof Map;
export const isStream = (value: PdfValue): value is PdfStream =>
  typeof value === 'object' && value !== null && 'dict' in value && 'raw' in value;

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

/** Reads one object at a time out of the byte stream. */
class Lexer {
  constructor(readonly bytes: Uint8Array, public pos = 0) {}

  private peek(): number { return this.bytes[this.pos]; }

  skipWhitespace(): void {
    while (this.pos < this.bytes.length) {
      const byte = this.peek();
      if (WHITESPACE.has(byte)) { this.pos += 1; continue; }
      // A percent starts a comment that runs to the end of the line.
      if (byte === 0x25) {
        while (this.pos < this.bytes.length && this.bytes[this.pos] !== 0x0a && this.bytes[this.pos] !== 0x0d) this.pos += 1;
        continue;
      }
      break;
    }
  }

  readToken(): string {
    this.skipWhitespace();
    const start = this.pos;
    while (this.pos < this.bytes.length && !WHITESPACE.has(this.peek()) && !DELIMITERS.has(this.peek())) this.pos += 1;
    if (this.pos === start) { this.pos += 1; return String.fromCharCode(this.bytes[start]); }
    return latin1(this.bytes.subarray(start, this.pos));
  }

  readValue(): PdfValue {
    this.skipWhitespace();
    if (this.pos >= this.bytes.length) return null;
    const byte = this.peek();

    if (byte === 0x2f) return this.readName();
    if (byte === 0x28) return this.readLiteralString();
    if (byte === 0x5b) return this.readArray();
    if (byte === 0x3c) {
      return this.bytes[this.pos + 1] === 0x3c ? this.readDictOrStream() : this.readHexString();
    }
    if (byte === 0x5d || byte === 0x3e) { this.pos += 1; return null; }

    const start = this.pos;
    const token = this.readToken();

    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'null') return null;

    if (/^[+-]?[\d.]+$/.test(token)) {
      // "12 0 R" is a reference; anything else is just a number.
      const save = this.pos;
      const second = this.readToken();
      if (/^\d+$/.test(second)) {
        const third = this.readToken();
        if (third === 'R') return { ref: Number(token), gen: Number(second) };
      }
      this.pos = save;
      return Number(token);
    }

    // An unexpected keyword: rewind one character so callers can see it.
    this.pos = start + token.length;
    return null;
  }

  readName(): PdfName {
    this.pos += 1;
    let out = '';
    while (this.pos < this.bytes.length && !WHITESPACE.has(this.peek()) && !DELIMITERS.has(this.peek())) {
      if (this.peek() === 0x23) {
        // A hash escape, as in /A#20B for "A B".
        out += String.fromCharCode(parseInt(latin1(this.bytes.subarray(this.pos + 1, this.pos + 3)), 16));
        this.pos += 3;
        continue;
      }
      out += String.fromCharCode(this.bytes[this.pos]);
      this.pos += 1;
    }
    return { name: out };
  }

  readLiteralString(): string {
    this.pos += 1;
    let depth = 1;
    let out = '';
    while (this.pos < this.bytes.length) {
      const byte = this.bytes[this.pos];
      if (byte === 0x5c) { out += String.fromCharCode(this.bytes[this.pos + 1]); this.pos += 2; continue; }
      if (byte === 0x28) depth += 1;
      if (byte === 0x29) { depth -= 1; if (depth === 0) { this.pos += 1; break; } }
      out += String.fromCharCode(byte);
      this.pos += 1;
    }
    return out;
  }

  readHexString(): string {
    this.pos += 1;
    let hex = '';
    while (this.pos < this.bytes.length && this.bytes[this.pos] !== 0x3e) {
      const character = String.fromCharCode(this.bytes[this.pos]);
      if (/[0-9a-fA-F]/.test(character)) hex += character;
      this.pos += 1;
    }
    this.pos += 1;
    if (hex.length % 2) hex += '0';
    let out = '';
    for (let i = 0; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    return out;
  }

  readArray(): PdfValue[] {
    this.pos += 1;
    const items: PdfValue[] = [];
    while (this.pos < this.bytes.length) {
      this.skipWhitespace();
      if (this.peek() === 0x5d) { this.pos += 1; break; }
      const before = this.pos;
      items.push(this.readValue());
      if (this.pos === before) { this.pos += 1; }
    }
    return items;
  }

  readDictOrStream(): PdfDict | PdfStream {
    this.pos += 2;
    const dict: PdfDict = new Map();

    while (this.pos < this.bytes.length) {
      this.skipWhitespace();
      if (this.peek() === 0x3e && this.bytes[this.pos + 1] === 0x3e) { this.pos += 2; break; }
      if (this.peek() !== 0x2f) { this.pos += 1; continue; }
      const key = this.readName().name;
      dict.set(key, this.readValue());
    }

    const save = this.pos;
    this.skipWhitespace();
    if (latin1(this.bytes.subarray(this.pos, this.pos + 6)) === 'stream') {
      this.pos += 6;
      if (this.bytes[this.pos] === 0x0d) this.pos += 1;
      if (this.bytes[this.pos] === 0x0a) this.pos += 1;
      const start = this.pos;
      return { dict, raw: new Uint8Array(0), _start: start } as unknown as PdfStream;
    }

    this.pos = save;
    return dict;
  }
}

function latin1(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new PdfReadError('This browser cannot decompress the streams in that PDF.');
  }
  // Try zlib framing first, then raw deflate, since both appear in the wild.
  for (const format of ['deflate', 'deflate-raw'] as const) {
    try {
      const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream(format));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch { /* try the next framing */ }
  }
  throw new PdfReadError('A compressed stream in that PDF could not be read.');
}

export type PdfPage = {
  index: number;
  ref: PdfRef;
  width: number;
  height: number;
  rotation: number;
};

export class PdfFile {
  private objects = new Map<number, PdfValue>();
  private trailer: PdfDict = new Map();
  readonly pages: PdfPage[] = [];

  private constructor(readonly bytes: Uint8Array) {}

  static async open(bytes: Uint8Array): Promise<PdfFile> {
    const file = new PdfFile(bytes);
    await file.load();
    return file;
  }

  get pageCount(): number { return this.pages.length; }

  resolve(value: PdfValue): PdfValue {
    let current = value;
    let guard = 0;
    while (isRef(current) && guard < 64) {
      current = this.objects.get(current.ref) ?? null;
      guard += 1;
    }
    return current;
  }

  getObject(ref: number): PdfValue {
    return this.objects.get(ref) ?? null;
  }

  private async load(): Promise<void> {
    const header = latin1(this.bytes.subarray(0, 1024));
    if (!header.includes('%PDF-')) throw new PdfReadError('That file does not start like a PDF.');

    // Rather than following the xref chain, which many real files get wrong,
    // scan for every "N G obj" and index what is actually there. It is more
    // robust against damaged or incrementally updated files.
    await this.scanObjects();
    await this.expandObjectStreams();
    this.findTrailer();

    if (this.trailer.has('Encrypt')) {
      throw new PdfReadError('That PDF is encrypted. Remove the password in the program that made it, then try again.');
    }

    this.collectPages();
    if (!this.pages.length) throw new PdfReadError('No pages could be found in that PDF.');
  }

  private async scanObjects(): Promise<void> {
    const text = latin1(this.bytes);
    const pattern = /(\d+)\s+(\d+)\s+obj\b/g;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text)) !== null) {
      const id = Number(match[1]);
      const lexer = new Lexer(this.bytes, match.index + match[0].length);
      let value: PdfValue;
      try { value = lexer.readValue(); } catch { continue; }

      if (value && typeof value === 'object' && '_start' in (value as object)) {
        const partial = value as unknown as { dict: PdfDict; _start: number };
        const length = this.streamLength(partial.dict, partial._start, text);
        const raw = this.bytes.subarray(partial._start, partial._start + length);
        this.objects.set(id, { dict: partial.dict, raw });
        continue;
      }

      this.objects.set(id, value);
    }
  }

  /** Length can be an indirect reference, so fall back to finding "endstream". */
  private streamLength(dict: PdfDict, start: number, text: string): number {
    const declared = dict.get('Length');
    if (typeof declared === 'number' && declared > 0 && start + declared <= this.bytes.length) {
      const after = text.slice(start + declared, start + declared + 20);
      if (/^\s*endstream/.test(after)) return declared;
    }
    const end = text.indexOf('endstream', start);
    if (end === -1) return Math.max(0, this.bytes.length - start);
    let length = end - start;
    // Trim the end of line that precedes the keyword.
    if (text[start + length - 1] === '\n') length -= 1;
    if (text[start + length - 1] === '\r') length -= 1;
    return Math.max(0, length);
  }

  /** PDF 1.5 packs many small objects into one compressed stream. */
  private async expandObjectStreams(): Promise<void> {
    for (const [, value] of [...this.objects]) {
      if (!isStream(value)) continue;
      const type = value.dict.get('Type') ?? null;
      if (!isName(type) || type.name !== 'ObjStm') continue;

      let data: Uint8Array;
      try { data = await this.decodeStream(value); } catch { continue; }

      const count = Number(this.resolve(value.dict.get('N') ?? 0));
      const first = Number(this.resolve(value.dict.get('First') ?? 0));
      const headerText = latin1(data.subarray(0, first));
      const numbers = headerText.trim().split(/\s+/).map(Number);

      for (let i = 0; i < count; i += 1) {
        const id = numbers[i * 2];
        const offset = numbers[i * 2 + 1];
        if (!Number.isFinite(id) || !Number.isFinite(offset)) continue;
        // An object already found in the file proper wins over the packed copy.
        if (this.objects.has(id) && !isStream(this.objects.get(id)!)) continue;
        try {
          const lexer = new Lexer(data, first + offset);
          this.objects.set(id, lexer.readValue());
        } catch { /* skip an object that will not parse */ }
      }
    }
  }

  async decodeStream(stream: PdfStream): Promise<Uint8Array> {
    const filter = this.resolve(stream.dict.get('Filter') ?? null);
    const filters = Array.isArray(filter) ? filter : filter ? [filter] : [];

    let data = stream.raw;
    for (const entry of filters) {
      const resolved = this.resolve(entry);
      if (!isName(resolved)) continue;
      if (resolved.name === 'FlateDecode') data = await inflate(data);
      else if (resolved.name === 'DCTDecode' || resolved.name === 'JPXDecode') return data;
      else throw new PdfReadError(`That PDF uses the ${resolved.name} filter, which this tool does not read.`);
    }
    return data;
  }

  private findTrailer(): void {
    const text = latin1(this.bytes);
    // The last trailer wins, since later ones supersede earlier updates.
    let index = text.lastIndexOf('trailer');
    while (index !== -1) {
      try {
        const lexer = new Lexer(this.bytes, index + 7);
        const dict = lexer.readValue();
        if (isDict(dict) && dict.has('Root')) { this.trailer = dict; return; }
      } catch { /* keep looking */ }
      index = text.lastIndexOf('trailer', index - 1);
    }

    // A cross-reference stream carries the trailer entries in its own dict.
    for (const [, value] of this.objects) {
      if (isStream(value)) {
        const type = value.dict.get('Type') ?? null;
        if (isName(type) && type.name === 'XRef' && value.dict.has('Root')) { this.trailer = value.dict; return; }
      }
    }

    // Last resort: find the catalog directly.
    for (const [id, value] of this.objects) {
      const dict = isStream(value) ? value.dict : value;
      if (isDict(dict)) {
        const type = dict.get('Type') ?? null;
        if (isName(type) && type.name === 'Catalog') {
          this.trailer = new Map([['Root', { ref: id, gen: 0 }]]);
          return;
        }
      }
    }
  }

  private collectPages(): void {
    const root = this.resolve(this.trailer.get('Root') ?? null);
    const path = new Set<number>();

    const inherited = ['Resources', 'MediaBox', 'CropBox', 'Rotate'];

    const walk = (nodeRef: PdfValue, from: Record<string, PdfValue>) => {
      const node = this.resolve(nodeRef);
      if (!isDict(node)) return;

      const passed = { ...from };
      for (const key of inherited) if (node.has(key)) passed[key] = node.get(key)!;

      const type = node.get('Type') ?? null;
      const kids = this.resolve(node.get('Kids') ?? null);

      if (Array.isArray(kids)) {
        for (const kid of kids) {
          // Only a node already on the current path is a cycle. The same page
          // appearing twice in a tree is legitimate and must be counted twice.
          if (isRef(kid)) {
            if (path.has(kid.ref)) continue;
            path.add(kid.ref);
            walk(kid, passed);
            path.delete(kid.ref);
            continue;
          }
          walk(kid, passed);
        }
        return;
      }

      if (isName(type) && type.name !== 'Page') return;

      const box = this.resolve(node.get('MediaBox') ?? passed.MediaBox ?? null);
      const numbers = Array.isArray(box) ? box.map((value) => Number(this.resolve(value))) : [0, 0, 612, 792];
      const rotate = Number(this.resolve(node.get('Rotate') ?? passed.Rotate ?? 0)) || 0;

      this.pages.push({
        index: this.pages.length,
        ref: isRef(nodeRef) ? nodeRef : { ref: -1, gen: 0 },
        width: Math.abs((numbers[2] ?? 612) - (numbers[0] ?? 0)),
        height: Math.abs((numbers[3] ?? 792) - (numbers[1] ?? 0)),
        rotation: ((rotate % 360) + 360) % 360,
      });

      // Inherited attributes are written onto the page so it can travel alone.
      for (const key of inherited) if (!node.has(key) && passed[key] !== undefined) node.set(key, passed[key]);
    };

    if (isDict(root)) walk(root.get('Pages') ?? null, {});

    // Some damaged files have no usable tree, so fall back to every page object.
    if (!this.pages.length) {
      for (const [id, value] of this.objects) {
        if (!isDict(value)) continue;
        const type = value.get('Type') ?? null;
        if (!isName(type) || type.name !== 'Page') continue;
        const box = this.resolve(value.get('MediaBox') ?? null);
        const numbers = Array.isArray(box) ? box.map((item) => Number(this.resolve(item))) : [0, 0, 612, 792];
        this.pages.push({
          index: this.pages.length,
          ref: { ref: id, gen: 0 },
          width: Math.abs((numbers[2] ?? 612) - (numbers[0] ?? 0)),
          height: Math.abs((numbers[3] ?? 792) - (numbers[1] ?? 0)),
          rotation: 0,
        });
      }
    }
  }

  /** Every object a page transitively depends on. */
  dependencies(pageRef: PdfRef): Set<number> {
    const found = new Set<number>();
    const queue: PdfValue[] = [this.getObject(pageRef.ref)];
    found.add(pageRef.ref);

    while (queue.length) {
      const value = queue.shift()!;
      const walk = (item: PdfValue) => {
        if (isRef(item)) {
          if (!found.has(item.ref)) { found.add(item.ref); queue.push(this.getObject(item.ref)); }
          return;
        }
        if (Array.isArray(item)) { for (const entry of item) walk(entry); return; }
        if (isStream(item)) { for (const [key, entry] of item.dict) { if (key !== 'Parent') walk(entry); } return; }
        if (isDict(item)) { for (const [key, entry] of item) { if (key !== 'Parent') walk(entry); } }
      };
      walk(value);
    }

    return found;
  }
}

// --------------------------------------------------------------------- writing

/** Serialises a value back into PDF syntax, remapping object numbers. */
function serialise(value: PdfValue, remap: Map<number, number>): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(Math.round(value * 10000) / 10000);
  if (typeof value === 'string') return `(${value.replace(/([\\()])/g, '\\$1')})`;
  if (isName(value)) return `/${value.name.replace(/[^\w.\-+]/g, (character) => `#${character.charCodeAt(0).toString(16).padStart(2, '0')}`)}`;
  if (isRef(value)) {
    const mapped = remap.get(value.ref);
    return mapped === undefined ? 'null' : `${mapped} 0 R`;
  }
  if (Array.isArray(value)) return `[${value.map((item) => serialise(item, remap)).join(' ')}]`;
  if (isStream(value)) return serialise(value.dict, remap);
  if (isDict(value)) {
    const parts: string[] = [];
    for (const [key, item] of value) parts.push(`/${key} ${serialise(item, remap)}`);
    return `<< ${parts.join(' ')} >>`;
  }
  return 'null';
}

export type PageSelection = { file: PdfFile; pageIndex: number; rotate?: number };

/**
 * Builds a new PDF from a list of pages, which may come from several files.
 * Objects each page depends on are copied and renumbered; nothing else is.
 */
export async function assemble(selection: PageSelection[]): Promise<Uint8Array> {
  if (!selection.length) throw new PdfReadError('Choose at least one page.');

  const chunks: (string | Uint8Array)[] = [];
  const offsets: number[] = [];
  let length = 0;

  const push = (value: string | Uint8Array) => {
    chunks.push(value);
    length += typeof value === 'string' ? value.length : value.length;
  };

  push('%PDF-1.7\n');
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const catalogId = 1;
  const pagesId = 2;
  let nextId = 3;

  // Each source file gets its own remapping, since object 5 in one file has
  // nothing to do with object 5 in another.
  const remaps = new Map<PdfFile, Map<number, number>>();
  const pageIds: number[] = [];
  const toWrite: { id: number; value: PdfValue; file: PdfFile }[] = [];
  const pageEntries: { id: number; file: PdfFile; source: number; rotate?: number }[] = [];

  for (const entry of selection) {
    const page = entry.file.pages[entry.pageIndex];
    if (!page) throw new PdfReadError('One of the chosen pages is not in its file.');

    let remap = remaps.get(entry.file);
    if (!remap) { remap = new Map(); remaps.set(entry.file, remap); }

    for (const id of entry.file.dependencies(page.ref)) {
      // The page object itself is written once per selection, below, so the
      // same page chosen twice becomes two pages rather than one shared one.
      if (id === page.ref.ref) continue;
      if (remap.has(id)) continue;
      const assigned = nextId++;
      remap.set(id, assigned);
      toWrite.push({ id: assigned, value: entry.file.getObject(id), file: entry.file });
    }

    const pageId = nextId++;
    pageEntries.push({ id: pageId, file: entry.file, source: page.ref.ref, rotate: entry.rotate });
    pageIds.push(pageId);
  }

  const startObject = (id: number) => { offsets[id] = length; push(`${id} 0 obj\n`); };
  const endObject = () => push('endobj\n');

  startObject(catalogId);
  push(`<< /Type /Catalog /Pages ${pagesId} 0 R >>\n`);
  endObject();

  startObject(pagesId);
  push(`<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>\n`);
  endObject();

  for (const { id, value, file } of toWrite) {
    const remap = remaps.get(file)!;
    startObject(id);

    if (isStream(value)) {
      const dict = new Map(value.dict);
      dict.set('Length', value.raw.length);
      push(`${serialise(dict, remap)}\nstream\n`);
      push(value.raw);
      push('\nendstream\n');
      endObject();
      continue;
    }

    push(`${serialise(value, remap)}\n`);
    endObject();
  }

  // One page object per selection, pointing at our page tree.
  for (const entry of pageEntries) {
    const remap = remaps.get(entry.file)!;
    const source = entry.file.getObject(entry.source);
    const dict: PdfDict = isDict(source) ? new Map(source) : new Map();

    dict.set('Type', { name: 'Page' });
    dict.delete('Parent');
    if (entry.rotate !== undefined) dict.set('Rotate', ((entry.rotate % 360) + 360) % 360);

    startObject(entry.id);
    const body = serialise(dict, remap).replace(/^<< /, `<< /Parent ${pagesId} 0 R `);
    push(`${body}\n`);
    endObject();
  }

  const count = nextId;
  const xrefOffset = length;
  push(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let id = 1; id < count; id += 1) {
    push(`${String(offsets[id] ?? 0).padStart(10, '0')} 00000 n \n`);
  }
  push(`trailer\n<< /Size ${count} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  let total = 0;
  for (const chunk of chunks) total += typeof chunk === 'string' ? chunk.length : chunk.length;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    if (typeof chunk === 'string') {
      for (let i = 0; i < chunk.length; i += 1) out[cursor + i] = chunk.charCodeAt(i) & 0xff;
      cursor += chunk.length;
    } else { out.set(chunk, cursor); cursor += chunk.length; }
  }
  return out;
}
