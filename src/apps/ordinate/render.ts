import {
  columnLabels, columnValues, type Table,
} from './data';
import {
  extent, fixed, formatTick, includeZero, labelStride, linearScale, niceTicks,
  pieSlices, smoothPath, straightPath,
} from './scale';

export type ChartType = 'bar' | 'groupedBar' | 'stackedBar' | 'line' | 'area' | 'scatter' | 'pie' | 'doughnut';

export type ChartSpec = {
  type: ChartType;
  title: string;
  subtitle: string;
  xLabel: string;
  yLabel: string;
  labelField: number;
  series: number[];
  palette: string;
  width: number;
  height: number;
  showLegend: boolean;
  showGrid: boolean;
  showValues: boolean;
  smooth: boolean;
  horizontal: boolean;
  background: string;
};

export const PALETTES: Record<string, string[]> = {
  studio: ['#3b6ea5', '#c9803a', '#4f9d6b', '#a4527a', '#7a6a9c', '#b8994a'],
  ink: ['#1f2933', '#52606d', '#7b8794', '#9aa5b1', '#cbd2d9', '#e4e7eb'],
  orchard: ['#2f7d4f', '#8a9b1f', '#c9a227', '#c46a2f', '#9c3d2f', '#5d6b3a'],
  tide: ['#0d5c73', '#1b7f8c', '#3aa39a', '#6fbfa5', '#a5d6b0', '#2c3f5c'],
  ember: ['#8c2f39', '#bf4342', '#d97b45', '#e3a857', '#7a5c3e', '#4a3b3b'],
};

export function defaultSpec(): ChartSpec {
  return {
    type: 'line',
    title: '',
    subtitle: '',
    xLabel: '',
    yLabel: '',
    labelField: 0,
    series: [],
    palette: 'studio',
    width: 860,
    height: 500,
    showLegend: true,
    showGrid: true,
    showValues: false,
    smooth: false,
    horizontal: false,
    background: '#ffffff',
  };
}

const INK = '#1f2933';
const MUTED = '#6b7280';
const GRID = '#e5e7eb';

/** Rough advance width for the font stack, good enough to reserve gutters. */
function textWidth(text: string, size: number): number {
  return text.length * size * 0.55;
}

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (character) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!);
}

type Frame = { left: number; right: number; top: number; bottom: number; width: number; height: number };

export type RenderResult = { svg: string; warning: string | null };

/**
 * Draws the chart as a standalone SVG string. Everything is inline, so the file
 * that comes out opens anywhere without a stylesheet or a font download.
 */
export function renderChart(table: Table, spec: ChartSpec): RenderResult {
  const colours = PALETTES[spec.palette] ?? PALETTES.studio;
  const series = spec.series.filter((index) => index >= 0 && index < table.columns.length);

  if (table.rows.length === 0 || series.length === 0) {
    return { svg: placeholder(spec), warning: 'Choose at least one number column to plot.' };
  }

  const labels = columnLabels(table, spec.labelField);
  const data = series.map((index) => ({
    name: table.columns[index],
    values: columnValues(table, index).map((value) => (Number.isFinite(value) ? value : 0)),
    missing: columnValues(table, index).some((value) => !Number.isFinite(value)),
  }));

  const anyMissing = data.some((entry) => entry.missing);
  const warning = anyMissing ? 'Some cells were not numbers and were plotted as zero.' : null;

  const body =
    spec.type === 'pie' || spec.type === 'doughnut'
      ? renderPie(labels, data[0], spec, colours)
      : renderCartesian(labels, data, spec, colours);

  return { svg: wrap(body, spec), warning };
}

function wrap(body: string, spec: ChartSpec): string {
  const titleBlock = [
    spec.title ? `<title>${esc(spec.title)}</title>` : '',
    spec.subtitle ? `<desc>${esc(spec.subtitle)}</desc>` : '',
  ].join('');

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${spec.width} ${spec.height}" width="${spec.width}" height="${spec.height}" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Helvetica, Arial, sans-serif" role="img">`,
    titleBlock,
    `<rect width="${spec.width}" height="${spec.height}" fill="${spec.background}"/>`,
    body,
    '</svg>',
  ].join('');
}

function placeholder(spec: ChartSpec): string {
  return wrap(
    `<text x="${spec.width / 2}" y="${spec.height / 2}" text-anchor="middle" font-size="15" fill="${MUTED}">Nothing to plot yet</text>`,
    spec,
  );
}

function headings(spec: ChartSpec): { markup: string; height: number } {
  const parts: string[] = [];
  let top = 30;
  if (spec.title) {
    parts.push(`<text x="24" y="${top}" font-size="18" font-weight="600" fill="${INK}">${esc(spec.title)}</text>`);
    top += 22;
  }
  if (spec.subtitle) {
    parts.push(`<text x="24" y="${top}" font-size="12.5" fill="${MUTED}">${esc(spec.subtitle)}</text>`);
    top += 18;
  }
  return { markup: parts.join(''), height: spec.title || spec.subtitle ? top - 6 : 16 };
}

function legend(names: string[], colours: string[], spec: ChartSpec, y: number): string {
  if (!spec.showLegend || names.length < 2) return '';
  const parts: string[] = [];
  let x = 24;
  names.forEach((name, index) => {
    const width = 14 + textWidth(name, 12) + 18;
    if (x + width > spec.width - 20) return;
    parts.push(
      `<rect x="${fixed(x)}" y="${fixed(y - 8)}" width="10" height="10" rx="2" fill="${colours[index % colours.length]}"/>`,
      `<text x="${fixed(x + 15)}" y="${fixed(y)}" font-size="12" fill="${MUTED}">${esc(name)}</text>`,
    );
    x += width;
  });
  return parts.join('');
}

type Series = { name: string; values: number[]; missing: boolean };

function renderCartesian(labels: string[], data: Series[], spec: ChartSpec, colours: string[]): string {
  const head = headings(spec);
  const legendHeight = spec.showLegend && data.length > 1 ? 24 : 0;
  const legendY = head.height + 12;

  // Work out the value range first, since the y axis gutter depends on how wide
  // the tick labels turn out to be.
  const stacked = spec.type === 'stackedBar';
  const flat = stacked ? stackTotals(data) : data.flatMap((entry) => entry.values);
  let [low, high] = extent(flat);
  if (stacked) low = Math.min(0, low);
  if (spec.type === 'bar' || spec.type === 'groupedBar' || spec.type === 'stackedBar' || spec.type === 'area') {
    [low, high] = includeZero(low, high);
  }
  const ticks = niceTicks(low, high, 5);

  const tickLabels = ticks.values.map((value) => formatTick(value, ticks.step));
  const widestTick = Math.max(...tickLabels.map((text) => textWidth(text, 11)));

  const horizontal = spec.horizontal && spec.type !== 'scatter';
  const longestLabel = Math.max(...labels.map((text) => textWidth(text, 11)), 10);

  const frame: Frame = horizontal
    ? gutter(spec, head.height + legendHeight, Math.min(160, longestLabel + 16), 26)
    : gutter(spec, head.height + legendHeight, widestTick + (spec.yLabel ? 32 : 16), 34);

  const valueScale = horizontal
    ? linearScale(ticks.domain, [frame.left, frame.right])
    : linearScale(ticks.domain, [frame.bottom, frame.top]);

  const parts: string[] = [head.markup, legend(data.map((entry) => entry.name), colours, spec, legendY)];

  // ------------------------------------------------------------------ axes
  if (spec.showGrid) {
    for (const value of ticks.values) {
      const position = valueScale(value);
      parts.push(
        horizontal
          ? `<line x1="${fixed(position)}" y1="${fixed(frame.top)}" x2="${fixed(position)}" y2="${fixed(frame.bottom)}" stroke="${GRID}" stroke-width="1"/>`
          : `<line x1="${fixed(frame.left)}" y1="${fixed(position)}" x2="${fixed(frame.right)}" y2="${fixed(position)}" stroke="${GRID}" stroke-width="1"/>`,
      );
    }
  }

  ticks.values.forEach((value, index) => {
    const position = valueScale(value);
    parts.push(
      horizontal
        ? `<text x="${fixed(position)}" y="${fixed(frame.bottom + 16)}" font-size="11" fill="${MUTED}" text-anchor="middle">${esc(tickLabels[index])}</text>`
        : `<text x="${fixed(frame.left - 8)}" y="${fixed(position + 4)}" font-size="11" fill="${MUTED}" text-anchor="end">${esc(tickLabels[index])}</text>`,
    );
  });

  // The zero line is drawn darker, because it is the one readers measure from.
  if (ticks.domain[0] < 0 && ticks.domain[1] > 0) {
    const zero = valueScale(0);
    parts.push(
      horizontal
        ? `<line x1="${fixed(zero)}" y1="${fixed(frame.top)}" x2="${fixed(zero)}" y2="${fixed(frame.bottom)}" stroke="${MUTED}" stroke-width="1"/>`
        : `<line x1="${fixed(frame.left)}" y1="${fixed(zero)}" x2="${fixed(frame.right)}" y2="${fixed(zero)}" stroke="${MUTED}" stroke-width="1"/>`,
    );
  }

  parts.push(
    `<line x1="${fixed(frame.left)}" y1="${fixed(frame.bottom)}" x2="${fixed(frame.right)}" y2="${fixed(frame.bottom)}" stroke="${MUTED}" stroke-width="1"/>`,
  );

  // ------------------------------------------------------------------ marks
  const bandCount = labels.length;
  const band = (horizontal ? frame.height : frame.width) / Math.max(1, bandCount);
  const bandStart = horizontal ? frame.top : frame.left;
  const centre = (index: number) => bandStart + band * (index + 0.5);

  if (spec.type === 'scatter') {
    parts.push(renderScatter(labels, data, spec, colours, frame, valueScale));
  } else if (spec.type === 'line' || spec.type === 'area') {
    parts.push(renderLines(data, spec, colours, valueScale, centre, frame));
  } else {
    parts.push(renderBars(labels, data, spec, colours, valueScale, frame, band, bandStart, horizontal));
  }

  // ------------------------------------------------------------------ category labels
  const stride = horizontal
    ? Math.max(1, Math.ceil(bandCount / Math.max(1, Math.floor(frame.height / 18))))
    : labelStride(bandCount, frame.width, Math.max(...labels.map((text) => text.length)));

  labels.forEach((label, index) => {
    if (index % stride !== 0) return;
    const position = centre(index);
    parts.push(
      horizontal
        ? `<text x="${fixed(frame.left - 8)}" y="${fixed(position + 4)}" font-size="11" fill="${MUTED}" text-anchor="end">${esc(label)}</text>`
        : `<text x="${fixed(position)}" y="${fixed(frame.bottom + 17)}" font-size="11" fill="${MUTED}" text-anchor="middle">${esc(label)}</text>`,
    );
  });

  // ------------------------------------------------------------------ axis titles
  if (spec.xLabel) {
    parts.push(`<text x="${fixed((frame.left + frame.right) / 2)}" y="${fixed(spec.height - 8)}" font-size="12" fill="${MUTED}" text-anchor="middle">${esc(spec.xLabel)}</text>`);
  }
  if (spec.yLabel) {
    const y = (frame.top + frame.bottom) / 2;
    parts.push(`<text x="14" y="${fixed(y)}" font-size="12" fill="${MUTED}" text-anchor="middle" transform="rotate(-90 14 ${fixed(y)})">${esc(spec.yLabel)}</text>`);
  }

  return parts.join('');
}

function gutter(spec: ChartSpec, topOffset: number, left: number, bottom: number): Frame {
  const frame = {
    left: 24 + left,
    right: spec.width - 24,
    top: topOffset + 14,
    bottom: spec.height - bottom - (spec.xLabel ? 18 : 0),
    width: 0,
    height: 0,
  };
  frame.width = frame.right - frame.left;
  frame.height = frame.bottom - frame.top;
  return frame;
}

function stackTotals(data: Series[]): number[] {
  const length = Math.max(...data.map((entry) => entry.values.length));
  const totals: number[] = [];
  for (let index = 0; index < length; index += 1) {
    totals.push(data.reduce((sum, entry) => sum + Math.max(0, entry.values[index] ?? 0), 0));
  }
  return [0, ...totals];
}

function renderBars(
  labels: string[], data: Series[], spec: ChartSpec, colours: string[],
  scale: (value: number) => number, frame: Frame, band: number, bandStart: number, horizontal: boolean,
): string {
  const parts: string[] = [];
  const zero = scale(0);
  const stacked = spec.type === 'stackedBar';
  const groups = stacked ? 1 : data.length;
  const padding = Math.min(band * 0.25, 14);
  const slot = (band - padding) / groups;

  labels.forEach((label, row) => {
    let stackTop = 0;
    data.forEach((entry, seriesIndex) => {
      const value = entry.values[row] ?? 0;
      const colour = colours[seriesIndex % colours.length];

      let from: number;
      let to: number;
      if (stacked) {
        from = scale(stackTop);
        stackTop += Math.max(0, value);
        to = scale(stackTop);
      } else {
        from = zero;
        to = scale(value);
      }

      const thickness = Math.max(1, slot - 2);
      const offset = bandStart + band * row + padding / 2 + (stacked ? 0 : slot * seriesIndex);
      const length = Math.abs(to - from);
      if (length < 0.01 && value === 0) return;

      if (horizontal) {
        parts.push(`<rect x="${fixed(Math.min(from, to))}" y="${fixed(offset)}" width="${fixed(length)}" height="${fixed(stacked ? band - padding : thickness)}" fill="${colour}" rx="1.5"><title>${esc(`${label} · ${entry.name}: ${value}`)}</title></rect>`);
      } else {
        parts.push(`<rect x="${fixed(offset)}" y="${fixed(Math.min(from, to))}" width="${fixed(stacked ? band - padding : thickness)}" height="${fixed(length)}" fill="${colour}" rx="1.5"><title>${esc(`${label} · ${entry.name}: ${value}`)}</title></rect>`);
      }

      if (spec.showValues && !stacked) {
        const text = String(value);
        parts.push(
          horizontal
            ? `<text x="${fixed(Math.max(from, to) + 5)}" y="${fixed(offset + thickness / 2 + 4)}" font-size="10.5" fill="${MUTED}">${esc(text)}</text>`
            : `<text x="${fixed(offset + thickness / 2)}" y="${fixed(Math.min(from, to) - 5)}" font-size="10.5" fill="${MUTED}" text-anchor="middle">${esc(text)}</text>`,
        );
      }
    });
  });

  return parts.join('');
}

function renderLines(
  data: Series[], spec: ChartSpec, colours: string[],
  scale: (value: number) => number, centre: (index: number) => number, frame: Frame,
): string {
  const parts: string[] = [];
  const zero = Math.min(frame.bottom, Math.max(frame.top, scale(0)));

  data.forEach((entry, seriesIndex) => {
    const colour = colours[seriesIndex % colours.length];
    const points = entry.values.map((value, index) => [centre(index), scale(value)] as [number, number]);
    const path = spec.smooth ? smoothPath(points) : straightPath(points);

    if (spec.type === 'area' && points.length > 1) {
      const area = `${path} L${fixed(points.at(-1)![0])} ${fixed(zero)} L${fixed(points[0][0])} ${fixed(zero)} Z`;
      parts.push(`<path d="${area}" fill="${colour}" fill-opacity="0.16"/>`);
    }

    parts.push(`<path d="${path}" fill="none" stroke="${colour}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>`);

    // Dots only when they will not smother the line.
    if (points.length <= 60) {
      points.forEach(([x, y], index) => {
        parts.push(`<circle cx="${fixed(x)}" cy="${fixed(y)}" r="3" fill="${spec.background}" stroke="${colour}" stroke-width="2"><title>${esc(`${entry.name}: ${entry.values[index]}`)}</title></circle>`);
        if (spec.showValues) {
          parts.push(`<text x="${fixed(x)}" y="${fixed(y - 9)}" font-size="10.5" fill="${MUTED}" text-anchor="middle">${esc(String(entry.values[index]))}</text>`);
        }
      });
    }
  });

  return parts.join('');
}

function renderScatter(
  labels: string[], data: Series[], spec: ChartSpec, colours: string[],
  frame: Frame, yScale: (value: number) => number,
): string {
  // The first chosen column is the x axis, everything after it is plotted against it.
  const [xSeries, ...rest] = data;
  const plotted = rest.length ? rest : [xSeries];
  const xValues = rest.length ? xSeries.values : xSeries.values.map((_, index) => index);
  const xTicks = niceTicks(...extent(xValues), 5);
  const xScale = linearScale(xTicks.domain, [frame.left, frame.right]);

  const parts: string[] = [];
  xTicks.values.forEach((value) => {
    parts.push(`<text x="${fixed(xScale(value))}" y="${fixed(frame.bottom + 17)}" font-size="11" fill="${MUTED}" text-anchor="middle">${esc(formatTick(value, xTicks.step))}</text>`);
  });

  plotted.forEach((entry, seriesIndex) => {
    const colour = colours[(rest.length ? seriesIndex + 1 : 0) % colours.length];
    entry.values.forEach((value, index) => {
      const x = xScale(xValues[index] ?? 0);
      const y = yScale(value);
      parts.push(`<circle cx="${fixed(x)}" cy="${fixed(y)}" r="4.5" fill="${colour}" fill-opacity="0.75"><title>${esc(`${labels[index] ?? index}: ${xValues[index]}, ${value}`)}</title></circle>`);
    });
  });

  return parts.join('');
}

function renderPie(labels: string[], series: Series, spec: ChartSpec, colours: string[]): string {
  const head = headings(spec);
  const parts: string[] = [head.markup];

  const top = head.height + 10;
  const legendWidth = spec.showLegend ? Math.min(220, spec.width * 0.32) : 0;
  const plotWidth = spec.width - legendWidth - 40;
  const plotHeight = spec.height - top - 24;
  const radius = Math.max(20, Math.min(plotWidth, plotHeight) / 2 - 8);
  const cx = 24 + plotWidth / 2;
  const cy = top + plotHeight / 2;

  const slices = pieSlices(series.values, radius, spec.type === 'doughnut' ? radius * 0.58 : 0);
  if (slices.length === 0) {
    return `${head.markup}<text x="${spec.width / 2}" y="${spec.height / 2}" text-anchor="middle" font-size="14" fill="${MUTED}">Every value is zero</text>`;
  }

  parts.push(`<g transform="translate(${fixed(cx)} ${fixed(cy)})">`);
  slices.forEach((slice, index) => {
    const colour = colours[index % colours.length];
    parts.push(`<path d="${slice.path}" fill="${colour}" stroke="${spec.background}" stroke-width="1.5"><title>${esc(`${labels[index] ?? ''}: ${series.values[index]} (${(slice.fraction * 100).toFixed(1)}%)`)}</title></path>`);

    // Percentages go inside the slice, but only where there is room for them.
    if (spec.showValues && slice.fraction > 0.045) {
      const r = spec.type === 'doughnut' ? radius * 0.79 : radius * 0.65;
      const x = Math.cos(slice.midAngle) * r;
      const y = Math.sin(slice.midAngle) * r;
      parts.push(`<text x="${fixed(x)}" y="${fixed(y + 4)}" font-size="11.5" fill="#fff" text-anchor="middle" font-weight="600">${(slice.fraction * 100).toFixed(0)}%</text>`);
    }
  });
  parts.push('</g>');

  if (spec.showLegend) {
    const x = spec.width - legendWidth - 8;
    let y = top + 18;
    slices.forEach((slice, index) => {
      if (y > spec.height - 16) return;
      parts.push(
        `<rect x="${fixed(x)}" y="${fixed(y - 9)}" width="10" height="10" rx="2" fill="${colours[index % colours.length]}"/>`,
        `<text x="${fixed(x + 16)}" y="${fixed(y)}" font-size="11.5" fill="${MUTED}">${esc(truncate(labels[index] ?? '', 18))} ${(slice.fraction * 100).toFixed(1)}%</text>`,
      );
      y += 19;
    });
  }

  return parts.join('');
}

function truncate(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}
