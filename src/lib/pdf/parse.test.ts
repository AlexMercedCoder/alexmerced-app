import { describe, expect, it } from 'vitest';
import { PdfDocument, rgb } from './write';
import { PdfFile, PdfReadError, assemble, isDict, isName, isStream } from './parse';

const decode = (bytes: Uint8Array) => {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return text;
};

/** Builds a real PDF with the writer, so the reader is tested against one. */
async function makePdf(pages: { text: string; size?: 'letter' | 'a4' }[]): Promise<Uint8Array> {
  const doc = new PdfDocument({ title: 'Fixture' });
  for (const page of pages) {
    doc.addPage(page.size ?? 'letter')
      .text(page.text, 72, 72, { size: 24 })
      .rect(20, 20, 100, 40, { fill: rgb(0.2, 0.4, 0.8) });
  }
  return doc.build();
}

describe('opening a file', () => {
  it('refuses something that is not a PDF', async () => {
    await expect(PdfFile.open(new TextEncoder().encode('hello'))).rejects.toThrow(/does not start like a PDF/);
  });

  it('reads the page count', async () => {
    const file = await PdfFile.open(await makePdf([{ text: 'one' }, { text: 'two' }, { text: 'three' }]));
    expect(file.pageCount).toBe(3);
  });

  it('reads page dimensions', async () => {
    const file = await PdfFile.open(await makePdf([{ text: 'a', size: 'letter' }, { text: 'b', size: 'a4' }]));
    expect(Math.round(file.pages[0].width)).toBe(612);
    expect(Math.round(file.pages[0].height)).toBe(792);
    expect(Math.round(file.pages[1].width)).toBe(595);
  });

  it('reports no rotation on a fresh document', async () => {
    const file = await PdfFile.open(await makePdf([{ text: 'a' }]));
    expect(file.pages[0].rotation).toBe(0);
  });

  it('refuses an encrypted file with a message a person can act on', async () => {
    const bytes = await makePdf([{ text: 'a' }]);
    // Splice an Encrypt entry into the trailer.
    const text = decode(bytes).replace('/Size', '/Encrypt 99 0 R /Size');
    const doctored = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i += 1) doctored[i] = text.charCodeAt(i) & 0xff;
    await expect(PdfFile.open(doctored)).rejects.toThrow(/encrypted/);
  });
});

describe('object access', () => {
  it('resolves indirect references', async () => {
    const file = await PdfFile.open(await makePdf([{ text: 'a' }]));
    const page = file.resolve(file.pages[0].ref);
    expect(isDict(page)).toBe(true);
    if (!isDict(page)) return;
    const type = page.get('Type') ?? null;
    expect(isName(type) && type.name).toBe('Page');
  });

  it('finds the content stream a page depends on', async () => {
    const file = await PdfFile.open(await makePdf([{ text: 'findable' }]));
    const deps = file.dependencies(file.pages[0].ref);
    expect(deps.size).toBeGreaterThan(1);

    let foundStream = false;
    for (const id of deps) if (isStream(file.getObject(id))) foundStream = true;
    expect(foundStream).toBe(true);
  });

  it('decodes an uncompressed stream back to its content', async () => {
    const file = await PdfFile.open(await makePdf([{ text: 'marker text' }]));
    let content = '';
    for (const id of file.dependencies(file.pages[0].ref)) {
      const value = file.getObject(id);
      if (isStream(value)) content += decode(await file.decodeStream(value));
    }
    expect(content).toContain('marker text');
  });
});

describe('assemble', () => {
  it('refuses an empty selection', async () => {
    await expect(assemble([])).rejects.toThrow(/at least one page/);
  });

  it('produces a file that opens again', async () => {
    const source = await PdfFile.open(await makePdf([{ text: 'a' }, { text: 'b' }]));
    const out = await assemble([{ file: source, pageIndex: 0 }, { file: source, pageIndex: 1 }]);
    const reopened = await PdfFile.open(out);
    expect(reopened.pageCount).toBe(2);
  });

  it('extracts a subset of pages', async () => {
    const source = await PdfFile.open(await makePdf([{ text: 'one' }, { text: 'two' }, { text: 'three' }]));
    const out = await assemble([{ file: source, pageIndex: 1 }]);
    const reopened = await PdfFile.open(out);
    expect(reopened.pageCount).toBe(1);

    let content = '';
    for (const id of reopened.dependencies(reopened.pages[0].ref)) {
      const value = reopened.getObject(id);
      if (isStream(value)) content += decode(await reopened.decodeStream(value));
    }
    expect(content).toContain('two');
    expect(content).not.toContain('one');
  });

  it('reorders pages', async () => {
    const source = await PdfFile.open(await makePdf([{ text: 'first' }, { text: 'second' }]));
    const out = await assemble([{ file: source, pageIndex: 1 }, { file: source, pageIndex: 0 }]);
    const reopened = await PdfFile.open(out);

    const contentOf = async (index: number) => {
      let content = '';
      for (const id of reopened.dependencies(reopened.pages[index].ref)) {
        const value = reopened.getObject(id);
        if (isStream(value)) content += decode(await reopened.decodeStream(value));
      }
      return content;
    };

    expect(await contentOf(0)).toContain('second');
    expect(await contentOf(1)).toContain('first');
  });

  it('merges pages from two different files', async () => {
    const a = await PdfFile.open(await makePdf([{ text: 'from A' }]));
    const b = await PdfFile.open(await makePdf([{ text: 'from B' }]));
    const out = await assemble([{ file: a, pageIndex: 0 }, { file: b, pageIndex: 0 }]);
    const reopened = await PdfFile.open(out);
    expect(reopened.pageCount).toBe(2);
  });

  it('keeps each merged page distinct rather than collapsing them', async () => {
    const a = await PdfFile.open(await makePdf([{ text: 'alpha' }]));
    const b = await PdfFile.open(await makePdf([{ text: 'bravo' }]));
    const out = await assemble([{ file: a, pageIndex: 0 }, { file: b, pageIndex: 0 }]);
    const reopened = await PdfFile.open(out);

    const texts: string[] = [];
    for (const page of reopened.pages) {
      let content = '';
      for (const id of reopened.dependencies(page.ref)) {
        const value = reopened.getObject(id);
        if (isStream(value)) content += decode(await reopened.decodeStream(value));
      }
      texts.push(content);
    }
    expect(texts[0]).toContain('alpha');
    expect(texts[1]).toContain('bravo');
  });

  it('applies a rotation', async () => {
    const source = await PdfFile.open(await makePdf([{ text: 'a' }]));
    const out = await assemble([{ file: source, pageIndex: 0, rotate: 90 }]);
    const reopened = await PdfFile.open(out);
    expect(reopened.pages[0].rotation).toBe(90);
  });

  it('normalises a rotation outside the usual range', async () => {
    const source = await PdfFile.open(await makePdf([{ text: 'a' }]));
    const reopened = await PdfFile.open(await assemble([{ file: source, pageIndex: 0, rotate: -90 }]));
    expect(reopened.pages[0].rotation).toBe(270);
  });

  it('duplicates a page when it is selected twice', async () => {
    const source = await PdfFile.open(await makePdf([{ text: 'twice' }]));
    const reopened = await PdfFile.open(await assemble([
      { file: source, pageIndex: 0 },
      { file: source, pageIndex: 0 },
    ]));
    expect(reopened.pageCount).toBe(2);
  });

  it('preserves the page size through a rebuild', async () => {
    const source = await PdfFile.open(await makePdf([{ text: 'a', size: 'a4' }]));
    const reopened = await PdfFile.open(await assemble([{ file: source, pageIndex: 0 }]));
    expect(Math.round(reopened.pages[0].width)).toBe(595);
    expect(Math.round(reopened.pages[0].height)).toBe(842);
  });

  it('writes a valid cross-reference table', async () => {
    const source = await PdfFile.open(await makePdf([{ text: 'a' }, { text: 'b' }]));
    const out = await assemble([{ file: source, pageIndex: 0 }, { file: source, pageIndex: 1 }]);
    const text = decode(out);

    const size = Number(/\/Size (\d+)/.exec(text)![1]);
    const rows = text.slice(text.indexOf('xref')).match(/^\d{10} \d{5} [nf] $/gm) ?? [];
    expect(rows).toHaveLength(size);

    const startxref = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(startxref, startxref + 4)).toBe('xref');
  });

  it('records each object at the offset the table claims', async () => {
    const source = await PdfFile.open(await makePdf([{ text: 'a' }, { text: 'b' }]));
    const out = await assemble([{ file: source, pageIndex: 0 }, { file: source, pageIndex: 1 }]);
    const text = decode(out);

    const rows = text.slice(text.indexOf('xref\n0 ')).match(/^(\d{10}) \d{5} n $/gm) ?? [];
    rows.forEach((row, index) => {
      const offset = Number(row.slice(0, 10));
      expect(text.slice(offset)).toMatch(new RegExp(`^${index + 1} 0 obj`));
    });
  });

  it('survives a round trip through several rebuilds', async () => {
    let bytes = await makePdf([{ text: 'one' }, { text: 'two' }, { text: 'three' }]);
    for (let pass = 0; pass < 3; pass += 1) {
      const file = await PdfFile.open(bytes);
      bytes = await assemble(file.pages.map((page) => ({ file, pageIndex: page.index })));
    }
    const final = await PdfFile.open(bytes);
    expect(final.pageCount).toBe(3);
  });

  it('reports a page index that is not in the file', async () => {
    const source = await PdfFile.open(await makePdf([{ text: 'a' }]));
    await expect(assemble([{ file: source, pageIndex: 9 }])).rejects.toThrow(PdfReadError);
  });
});
