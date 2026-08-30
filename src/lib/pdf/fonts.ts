/**
 * Advance widths for the fourteen standard PDF fonts, in 1/1000 em units.
 *
 * Every PDF reader already has these fonts, so using them means nothing has to
 * be embedded. Having the real widths is what separates measured layout from
 * guessed layout: without them you cannot wrap, centre, or justify correctly.
 *
 * Values are the AFM widths from the Adobe Core 14 metrics, for character
 * codes 32 through 255 under WinAnsiEncoding.
 */

export type StandardFont =
  | 'Helvetica' | 'Helvetica-Bold' | 'Helvetica-Oblique' | 'Helvetica-BoldOblique'
  | 'Times-Roman' | 'Times-Bold' | 'Times-Italic' | 'Times-BoldItalic'
  | 'Courier' | 'Courier-Bold' | 'Courier-Oblique' | 'Courier-BoldOblique';

/** Widths for codes 32..255. Index 0 is the space character. */
const HELVETICA = [
  278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,
  556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,
  667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,
  556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584,350,
  556,350,222,556,333,1000,556,556,333,1000,667,333,1000,350,611,350,350,222,222,333,333,350,556,
  1000,333,1000,500,333,944,350,500,667,278,333,556,556,556,556,260,556,333,737,370,556,584,333,
  737,552,400,549,333,333,333,576,537,278,333,333,365,556,834,834,834,611,667,667,667,667,667,667,
  1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,
  667,611,556,556,556,556,556,556,889,500,556,556,556,556,278,278,278,278,556,556,556,556,556,556,
  556,549,611,556,556,556,556,500,556,500,
];

const HELVETICA_BOLD = [
  278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,
  556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,
  667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,
  611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584,350,
  556,350,278,556,500,1000,556,556,333,1000,667,333,1000,350,611,350,350,278,278,500,500,350,556,
  1000,333,1000,556,333,944,350,500,667,278,333,556,556,556,556,280,556,333,737,370,556,584,333,
  737,552,400,549,333,333,333,576,556,278,333,333,365,556,834,834,834,611,722,722,722,722,722,722,
  1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,
  667,611,556,556,556,556,556,556,889,556,556,556,556,556,278,278,278,278,611,611,611,611,611,611,
  611,549,611,611,611,611,611,556,611,556,
];

const TIMES_ROMAN = [
  250,333,408,500,500,833,778,180,333,333,500,564,250,333,250,278,500,500,500,500,500,500,500,500,
  500,500,278,278,564,564,564,444,921,722,667,667,722,611,556,722,722,333,389,722,611,889,722,722,
  556,722,667,556,611,722,722,944,722,722,611,333,278,333,469,500,333,444,500,444,500,444,333,500,
  500,278,278,500,278,778,500,500,500,500,333,389,278,500,500,722,500,500,444,480,200,480,541,350,
  500,350,333,500,444,1000,500,500,333,1000,556,333,889,350,611,350,350,333,333,444,444,350,500,
  1000,333,980,389,333,722,350,444,722,250,333,500,500,500,500,200,500,333,760,276,500,564,333,
  760,528,400,549,300,300,333,576,453,250,333,300,310,500,750,750,750,444,722,722,722,722,722,722,
  889,667,611,611,611,611,333,333,333,333,722,722,722,722,722,722,722,564,722,722,722,722,722,722,
  556,500,444,444,444,444,444,444,667,444,444,444,444,444,278,278,278,278,500,500,500,500,500,500,
  500,549,500,500,500,500,500,500,500,500,
];

const TIMES_BOLD = [
  250,333,555,500,500,1000,833,278,333,333,500,570,250,333,250,278,500,500,500,500,500,500,500,500,
  500,500,333,333,570,570,570,500,930,722,667,722,722,667,611,778,778,389,500,778,667,944,722,778,
  611,778,722,556,667,722,722,1000,722,722,667,333,278,333,581,500,333,500,556,444,556,444,333,500,
  556,278,333,556,278,833,556,500,556,556,444,389,333,556,500,722,500,500,444,394,220,394,520,350,
  500,350,333,500,500,1000,500,500,333,1000,556,333,1000,350,667,350,350,333,333,500,500,350,500,
  1000,333,1000,389,333,722,350,444,722,250,333,500,500,500,500,220,500,333,747,300,500,570,333,
  747,528,400,549,300,300,333,576,540,250,333,300,330,500,750,750,750,500,722,722,722,722,722,722,
  1000,722,667,667,667,667,389,389,389,389,722,722,778,778,778,778,778,570,778,722,722,722,722,722,
  611,556,500,500,500,500,500,500,722,444,444,444,444,444,278,278,278,278,500,556,500,500,500,500,
  500,549,500,556,556,556,556,500,556,500,
];

const COURIER = new Array(224).fill(600);

/** Italic and bold-italic share widths with their upright counterparts. */
export const FONT_WIDTHS: Record<StandardFont, number[]> = {
  'Helvetica': HELVETICA,
  'Helvetica-Oblique': HELVETICA,
  'Helvetica-Bold': HELVETICA_BOLD,
  'Helvetica-BoldOblique': HELVETICA_BOLD,
  'Times-Roman': TIMES_ROMAN,
  'Times-Italic': TIMES_ROMAN,
  'Times-Bold': TIMES_BOLD,
  'Times-BoldItalic': TIMES_BOLD,
  'Courier': COURIER,
  'Courier-Bold': COURIER,
  'Courier-Oblique': COURIER,
  'Courier-BoldOblique': COURIER,
};

/** Width of one character in 1/1000 em. Unknown codes fall back to the space. */
export function charWidth(font: StandardFont, code: number): number {
  const widths = FONT_WIDTHS[font];
  if (code < 32 || code > 255) return widths[0];
  return widths[code - 32] ?? widths[0];
}

/** Width of a string at a given size, in points. */
export function measureText(text: string, font: StandardFont, size: number): number {
  let total = 0;
  for (const character of text) total += charWidth(font, toWinAnsi(character));
  return (total * size) / 1000;
}

/**
 * Maps a character to its WinAnsiEncoding code. Characters outside the encoding
 * become a question mark, which is honest about the limitation rather than
 * producing a silently wrong glyph.
 */
export function toWinAnsi(character: string): number {
  const code = character.codePointAt(0) ?? 63;
  if (code >= 32 && code <= 126) return code;

  // The positions where WinAnsi differs from Latin-1.
  const special: Record<number, number> = {
    0x20ac: 128, 0x201a: 130, 0x0192: 131, 0x201e: 132, 0x2026: 133, 0x2020: 134,
    0x2021: 135, 0x02c6: 136, 0x2030: 137, 0x0160: 138, 0x2039: 139, 0x0152: 140,
    0x017d: 142, 0x2018: 145, 0x2019: 146, 0x201c: 147, 0x201d: 148, 0x2022: 149,
    0x2013: 150, 0x2014: 151, 0x02dc: 152, 0x2122: 153, 0x0161: 154, 0x203a: 155,
    0x0153: 156, 0x017e: 158, 0x0178: 159,
  };
  if (special[code] !== undefined) return special[code];
  if (code >= 160 && code <= 255) return code;
  return 63;
}

/** Encodes a string for a PDF literal string under WinAnsiEncoding. */
export function encodeWinAnsi(text: string): string {
  let out = '';
  for (const character of text) out += String.fromCharCode(toWinAnsi(character));
  return out;
}

/**
 * Greedy word wrap using real metrics. Words longer than the line are broken
 * rather than allowed to run off the page.
 */
export function wrapText(text: string, font: StandardFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];

  for (const paragraph of text.split('\n')) {
    if (!paragraph.trim()) { lines.push(''); continue; }

    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (measureText(candidate, font, size) <= maxWidth) { line = candidate; continue; }

      if (line) { lines.push(line); line = ''; }

      // A single word too wide for the measure gets broken across lines.
      if (measureText(word, font, size) > maxWidth) {
        let chunk = '';
        for (const character of word) {
          if (measureText(chunk + character, font, size) > maxWidth && chunk) {
            lines.push(chunk);
            chunk = character;
          } else {
            chunk += character;
          }
        }
        line = chunk;
      } else {
        line = word;
      }
    }
    lines.push(line);
  }

  return lines;
}
