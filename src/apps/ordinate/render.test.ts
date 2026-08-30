// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { parseDelimited, SAMPLE_DATA } from './data';
import { defaultSpec, PALETTES, renderChart, type ChartSpec, type ChartType } from './render';

const table = parseDelimited(SAMPLE_DATA);

function spec(overrides: Partial<ChartSpec> = {}): ChartSpec {
  return { ...defaultSpec(), labelField: 0, series: [1, 2, 3], ...overrides };
}

const TYPES: ChartType[] = ['bar', 'groupedBar', 'stackedBar', 'line', 'area', 'scatter', 'pie', 'doughnut'];

describe('renderChart', () => {
  it('produces well formed SVG for every chart type', () => {
    for (const type of TYPES) {
      const { svg } = renderChart(table, spec({ type }));
      expect(svg.startsWith('<svg'), type).toBe(true);
      expect(svg.endsWith('</svg>'), type).toBe(true);
      // A DOM parser is the honest check that the markup is valid.
      const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
      expect(parsed.querySelector('parsererror'), type).toBeNull();
    }
  });

  it('says so rather than drawing an empty frame when nothing is chosen', () => {
    const result = renderChart(table, spec({ series: [] }));
    expect(result.warning).toMatch(/at least one number column/);
    expect(result.svg).toContain('Nothing to plot yet');
  });

  it('handles an empty table', () => {
    const result = renderChart({ columns: [], rows: [] }, spec());
    expect(result.svg).toContain('<svg');
  });

  it('sets the viewBox from the requested size', () => {
    const { svg } = renderChart(table, spec({ width: 640, height: 360 }));
    expect(svg).toContain('viewBox="0 0 640 360"');
  });

  it('escapes markup in the title so a stray angle bracket cannot break the file', () => {
    const { svg } = renderChart(table, spec({ title: 'Sales <b>up</b> & away' }));
    expect(svg).toContain('Sales &lt;b&gt;up&lt;/b&gt; &amp; away');
    expect(new DOMParser().parseFromString(svg, 'image/svg+xml').querySelector('parsererror')).toBeNull();
  });

  it('escapes markup in the data labels too', () => {
    const risky = parseDelimited('name,value\n"<script>",5');
    const { svg } = renderChart(risky, spec({ labelField: 0, series: [1] }));
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
  });

  it('draws one bar per row per series', () => {
    const { svg } = renderChart(table, spec({ type: 'groupedBar' }));
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    // Six rows, three series, plus the background rectangle and legend swatches.
    const bars = [...doc.querySelectorAll('rect')].filter((rect) => rect.querySelector('title'));
    expect(bars).toHaveLength(18);
  });

  it('stacks bars so each row totals one column', () => {
    const { svg } = renderChart(table, spec({ type: 'stackedBar' }));
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const bars = [...doc.querySelectorAll('rect')].filter((rect) => rect.querySelector('title'));
    const xs = new Set(bars.map((rect) => rect.getAttribute('x')));
    expect(xs.size).toBe(6);
  });

  it('draws one path per series for a line chart', () => {
    const { svg } = renderChart(table, spec({ type: 'line' }));
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const lines = [...doc.querySelectorAll('path')].filter((path) => path.getAttribute('fill') === 'none');
    expect(lines).toHaveLength(3);
  });

  it('adds a filled shape under each line for an area chart', () => {
    const { svg } = renderChart(table, spec({ type: 'area' }));
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    expect([...doc.querySelectorAll('path[fill-opacity]')]).toHaveLength(3);
  });

  it('uses cubic segments when smoothing is on and none when it is off', () => {
    const smooth = renderChart(table, spec({ type: 'line', smooth: true })).svg;
    const straight = renderChart(table, spec({ type: 'line', smooth: false })).svg;
    expect(smooth).toContain('C');
    expect(/ d="M[^"]*C/.test(straight)).toBe(false);
  });

  it('draws one slice per row for a pie', () => {
    const { svg } = renderChart(table, spec({ type: 'pie', series: [1] }));
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    expect([...doc.querySelectorAll('path')]).toHaveLength(6);
  });

  it('leaves a hole in a doughnut', () => {
    const doughnut = renderChart(table, spec({ type: 'doughnut', series: [1] })).svg;
    const pie = renderChart(table, spec({ type: 'pie', series: [1] })).svg;
    expect(pie).toContain('M0 0');
    expect(doughnut).not.toContain('M0 0');
  });

  it('says so when a pie has nothing but zeroes', () => {
    const zeroes = parseDelimited('name,value\na,0\nb,0');
    const { svg } = renderChart(zeroes, spec({ type: 'pie', labelField: 0, series: [1] }));
    expect(svg).toContain('Every value is zero');
  });

  it('reports non-numeric cells rather than hiding them', () => {
    const messy = parseDelimited('name,value\na,1\nb,n/a\nc,3\nd,4\ne,5\nf,6');
    const result = renderChart(messy, spec({ labelField: 0, series: [1] }));
    expect(result.warning).toMatch(/not numbers/);
  });

  it('reports no warning for clean data', () => {
    expect(renderChart(table, spec()).warning).toBeNull();
  });

  it('honours the chosen palette', () => {
    const { svg } = renderChart(table, spec({ palette: 'ember', type: 'bar', series: [1] }));
    expect(svg).toContain(PALETTES.ember[0]);
  });

  it('falls back to the default palette for an unknown name', () => {
    const { svg } = renderChart(table, spec({ palette: 'nonsense', type: 'bar', series: [1] }));
    expect(svg).toContain(PALETTES.studio[0]);
  });

  it('draws a legend only when there is more than one series', () => {
    const many = renderChart(table, spec({ type: 'line' })).svg;
    const one = renderChart(table, spec({ type: 'line', series: [1] })).svg;
    expect(many).toContain('Cloud');
    expect(one).not.toContain('>Cloud<');
  });

  it('omits gridlines when they are turned off', () => {
    const off = renderChart(table, spec({ showGrid: false })).svg;
    expect(off.match(/stroke="#e5e7eb"/g)).toBeNull();
  });

  it('draws a darker zero line when the data crosses zero', () => {
    const crossing = parseDelimited('name,value\na,-40\nb,60');
    const { svg } = renderChart(crossing, spec({ type: 'line', labelField: 0, series: [1] }));
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const dark = [...doc.querySelectorAll('line')].filter((line) => line.getAttribute('stroke') === '#6b7280');
    expect(dark.length).toBeGreaterThanOrEqual(2);
  });

  it('lays a horizontal bar chart out along the other axis', () => {
    const vertical = renderChart(table, spec({ type: 'bar', series: [1], horizontal: false })).svg;
    const horizontal = renderChart(table, spec({ type: 'bar', series: [1], horizontal: true })).svg;
    expect(vertical).not.toBe(horizontal);
    const bars = [...new DOMParser().parseFromString(horizontal, 'image/svg+xml').querySelectorAll('rect')]
      .filter((rect) => rect.querySelector('title'));
    const ys = new Set(bars.map((rect) => rect.getAttribute('y')));
    expect(ys.size).toBe(6);
  });

  it('writes axis titles when they are given', () => {
    const { svg } = renderChart(table, spec({ xLabel: 'Quarter', yLabel: 'Revenue' }));
    expect(svg).toContain('>Quarter<');
    expect(svg).toContain('>Revenue<');
    expect(svg).toContain('rotate(-90');
  });

  it('gives every mark a hover title so the SVG explains itself', () => {
    const { svg } = renderChart(table, spec({ type: 'bar', series: [1] }));
    expect(svg).toContain('<title>Q1 2025 · Cloud: 412</title>');
  });

  it('survives a single row', () => {
    const one = parseDelimited('name,value\nonly,7');
    for (const type of TYPES) {
      const { svg } = renderChart(one, spec({ type, labelField: 0, series: [1] }));
      expect(new DOMParser().parseFromString(svg, 'image/svg+xml').querySelector('parsererror'), type).toBeNull();
    }
  });

  it('survives values that are all identical', () => {
    const flat = parseDelimited('name,value\na,5\nb,5\nc,5');
    const { svg } = renderChart(flat, spec({ type: 'line', labelField: 0, series: [1] }));
    expect(svg).not.toContain('NaN');
  });

  it('never emits NaN into the markup for any type', () => {
    for (const type of TYPES) {
      const { svg } = renderChart(table, spec({ type, showValues: true }));
      expect(svg.includes('NaN'), type).toBe(false);
    }
  });
});
