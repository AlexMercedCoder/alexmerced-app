import { beforeEach, describe, expect, it } from 'vitest';
import { createEnvelope } from '../../lib/portable';
import { APP_ID, APP_VERSION } from './data';
import { defaultSpec } from './render';
import {
  applyImport, buildExport, clearAll, createChart, deleteChart, loadCharts,
  reviveChart, reviveSpec, saveChart, sortCharts, type OrdinateExport, type SavedChart,
} from './store';

beforeEach(async () => {
  await clearAll();
  localStorage.clear();
});

describe('reviveSpec', () => {
  it('falls back to defaults for junk', () => {
    expect(reviveSpec(null)).toEqual(defaultSpec());
    expect(reviveSpec('nope')).toEqual(defaultSpec());
  });

  it('rejects a chart type it does not know', () => {
    expect(reviveSpec({ type: 'sunburst' }).type).toBe(defaultSpec().type);
  });

  it('keeps a chart type it does know', () => {
    expect(reviveSpec({ type: 'doughnut' }).type).toBe('doughnut');
  });

  it('rejects an unknown palette', () => {
    expect(reviveSpec({ palette: 'neon' }).palette).toBe('studio');
    expect(reviveSpec({ palette: 'ember' }).palette).toBe('ember');
  });

  it('clamps a silly canvas size instead of trying to draw it', () => {
    expect(reviveSpec({ width: 99999 }).width).toBe(2400);
    expect(reviveSpec({ width: 1 }).width).toBe(240);
    expect(reviveSpec({ height: NaN }).height).toBe(defaultSpec().height);
  });

  it('drops non-numeric entries from the series list', () => {
    expect(reviveSpec({ series: [1, 'two', null, 3] }).series).toEqual([1, 3]);
  });

  it('only accepts a background that looks like a hex colour', () => {
    expect(reviveSpec({ background: '#112233' }).background).toBe('#112233');
    expect(reviveSpec({ background: 'url(evil)' }).background).toBe('#ffffff');
  });
});

describe('reviveChart', () => {
  it('needs an id', () => {
    expect(reviveChart({ name: 'x' })).toBeNull();
    expect(reviveChart(null)).toBeNull();
  });

  it('names an unnamed chart', () => {
    expect(reviveChart({ id: 'a' })!.name).toBe('Untitled chart');
  });

  it('round trips through JSON unchanged', () => {
    const chart = createChart('Mine', 'a,b\n1,2', new Date('2026-01-01T00:00:00Z'));
    expect(reviveChart(JSON.parse(JSON.stringify(chart)))).toEqual(chart);
  });
});

describe('loadCharts', () => {
  it('seeds a worked example on first run', async () => {
    const list = await loadCharts();
    expect(list).toHaveLength(1);
    expect(list[0].source).toContain('Quarter');
    expect(list[0].spec.series.length).toBeGreaterThan(0);
  });

  it('does not seed again once something is stored', async () => {
    await loadCharts();
    expect(await loadCharts()).toHaveLength(1);
  });
});

describe('sortCharts', () => {
  it('puts the most recently edited first', () => {
    const older: SavedChart = { ...createChart('old'), id: 'a', updatedAt: '2026-01-01T00:00:00Z' };
    const newer: SavedChart = { ...createChart('new'), id: 'b', updatedAt: '2026-06-01T00:00:00Z' };
    expect(sortCharts([older, newer]).map((chart) => chart.id)).toEqual(['b', 'a']);
  });
});

describe('export and import', () => {
  it('exports everything with a count', async () => {
    await loadCharts();
    const envelope = await buildExport();
    expect(envelope.app).toBe(APP_ID);
    expect(envelope.counts).toEqual({ charts: 1 });
  });

  it('replaces on replace', async () => {
    await loadCharts();
    const chart = { ...createChart('Imported'), id: 'chart_x' };
    const text = JSON.stringify(createEnvelope<OrdinateExport>(APP_ID, APP_VERSION, { charts: [chart] }, {}));
    expect(await applyImport(text, 'replace')).toBe(1);
    expect((await loadCharts()).map((c) => c.id)).toEqual(['chart_x']);
  });

  it('keeps the newer side on merge', async () => {
    const mine: SavedChart = { ...createChart('Mine'), id: 'same', updatedAt: '2026-06-01T00:00:00Z' };
    await saveChart(mine);
    const theirs = { ...mine, name: 'Theirs', updatedAt: '2026-01-01T00:00:00Z' };
    const text = JSON.stringify(createEnvelope<OrdinateExport>(APP_ID, APP_VERSION, { charts: [theirs] }, {}));
    await applyImport(text, 'merge');
    expect((await loadCharts()).find((c) => c.id === 'same')!.name).toBe('Mine');
  });

  it('refuses an export from another app', async () => {
    const text = JSON.stringify(createEnvelope('tally', 1, { charts: [] }, {}));
    await expect(applyImport(text, 'merge')).rejects.toThrow();
  });

  it('refuses an export with nothing in it', async () => {
    const text = JSON.stringify(createEnvelope<OrdinateExport>(APP_ID, APP_VERSION, { charts: [] }, {}));
    await expect(applyImport(text, 'merge')).rejects.toThrow(/no readable charts/);
  });

  it('survives a full round trip with the spec intact', async () => {
    const chart = createChart('Round', 'a,b\n1,2');
    chart.spec = { ...chart.spec, type: 'stackedBar', series: [1], palette: 'tide', showValues: true };
    await saveChart(chart);
    const text = JSON.stringify(await buildExport());
    await clearAll();
    await applyImport(text, 'replace');
    const restored = (await loadCharts()).find((c) => c.id === chart.id)!;
    expect(restored.spec).toEqual(chart.spec);
  });
});

describe('deleteChart', () => {
  it('removes only the named chart', async () => {
    await saveChart({ ...createChart('a'), id: 'a' });
    await saveChart({ ...createChart('b'), id: 'b' });
    await deleteChart('a');
    expect((await loadCharts()).map((c) => c.id)).toEqual(['b']);
  });
});
