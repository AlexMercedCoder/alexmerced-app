import { errorResult, readBoolean, readEnum, readNumber, readString, readStringArray, requireString, textResult, type McpTool } from '../../lib/webmcp';
import { columnKind, parseInput, suggestFields } from './data';
import { defaultSpec, PALETTES, renderChart, type ChartType } from './render';

const TYPES: readonly ChartType[] = ['bar', 'groupedBar', 'stackedBar', 'line', 'area', 'scatter', 'pie', 'doughnut'];

/**
 * Ordinate's tools. A chart is one of the few things an agent genuinely cannot
 * produce on its own: describing a bar chart in words is not a bar chart. This
 * returns real SVG that can be pasted into a document or a page.
 */
export function ordinateTools(): McpTool[] {
  return [
    {
      name: 'ordinate_render_chart',
      description:
        'Turn data into a chart and return it as standalone SVG markup, with every colour and coordinate written into the file so it opens anywhere. Reads CSV, tab separated text, or JSON (an array of objects, an array of arrays, or a bare list of numbers). If you do not name the columns it will pick sensible ones.',
      inputSchema: {
        type: 'object',
        properties: {
          data: { type: 'string', description: 'CSV, TSV, or JSON.' },
          type: { type: 'string', enum: [...TYPES], description: 'Chart type. "line" by default.' },
          labelColumn: { type: 'string', description: 'Column to take labels from. Omit to choose automatically.' },
          valueColumns: { type: 'array', items: { type: 'string' }, description: 'Columns to plot. Omit to choose automatically.' },
          title: { type: 'string' },
          subtitle: { type: 'string' },
          xLabel: { type: 'string' },
          yLabel: { type: 'string' },
          palette: { type: 'string', enum: Object.keys(PALETTES), description: 'Colour set.' },
          width: { type: 'number', description: '240 to 2400. 860 by default.' },
          height: { type: 'number', description: '240 to 2400. 500 by default.' },
          showValues: { type: 'boolean', description: 'Print the value on each mark.' },
          showLegend: { type: 'boolean' },
          showGrid: { type: 'boolean' },
          smooth: { type: 'boolean', description: 'Curve the line instead of joining points straight.' },
          horizontal: { type: 'boolean', description: 'Lay bars along the other axis.' },
        },
        required: ['data'],
      },
      execute: (input) => {
        const table = parseInput(requireString(input, 'data'));
        if (table.rows.length === 0) return errorResult('No rows could be read from that data.');

        const suggested = suggestFields(table);
        const named = readString(input, 'labelColumn');
        const labelField = named
          ? table.columns.indexOf(named)
          : suggested.label;

        if (named && labelField === -1) {
          return errorResult(`There is no column called "${named}".`, { columns: table.columns });
        }

        const wanted = readStringArray(input, 'valueColumns');
        let series = suggested.series;
        if (wanted.length) {
          const missing = wanted.filter((name) => !table.columns.includes(name));
          if (missing.length) return errorResult(`No column called ${missing.map((name) => `"${name}"`).join(', ')}.`, { columns: table.columns });
          series = wanted.map((name) => table.columns.indexOf(name));
        }
        if (series.length === 0) return errorResult('No numeric column was found to plot.', { columns: table.columns });

        const clampSize = (key: 'width' | 'height', fallback: number) =>
          Math.max(240, Math.min(2400, Math.round(readNumber(input, key, fallback))));

        const base = defaultSpec();
        const spec = {
          ...base,
          type: readEnum(input, 'type', TYPES, 'line'),
          title: readString(input, 'title'),
          subtitle: readString(input, 'subtitle'),
          xLabel: readString(input, 'xLabel'),
          yLabel: readString(input, 'yLabel'),
          labelField,
          series: readEnum(input, 'type', TYPES, 'line') === 'pie' || readEnum(input, 'type', TYPES, 'line') === 'doughnut'
            ? series.slice(0, 1)
            : series,
          palette: readEnum(input, 'palette', Object.keys(PALETTES) as [string, ...string[]], 'studio'),
          width: clampSize('width', base.width),
          height: clampSize('height', base.height),
          showLegend: readBoolean(input, 'showLegend', true),
          showGrid: readBoolean(input, 'showGrid', true),
          showValues: readBoolean(input, 'showValues', false),
          smooth: readBoolean(input, 'smooth', false),
          horizontal: readBoolean(input, 'horizontal', false),
        };

        const result = renderChart(table, spec);
        return textResult({
          svg: result.svg,
          warning: result.warning,
          rows: table.rows.length,
          labelColumn: labelField === -1 ? '(row numbers)' : table.columns[labelField],
          valueColumns: series.map((index) => table.columns[index]),
        });
      },
    },
    {
      name: 'ordinate_describe_data',
      description:
        'Read CSV, TSV or JSON and report its columns, which of them are numeric, how many rows there are, and which chart would suit it. Use this before rendering when you are not sure what is in the data.',
      inputSchema: {
        type: 'object',
        properties: { data: { type: 'string' } },
        required: ['data'],
      },
      execute: (input) => {
        const table = parseInput(requireString(input, 'data'));
        const suggested = suggestFields(table);
        return textResult({
          rows: table.rows.length,
          columns: table.columns.map((name, index) => ({ name, kind: columnKind(table, index) })),
          suggestion: {
            labelColumn: suggested.label === -1 ? null : table.columns[suggested.label],
            valueColumns: suggested.series.map((index) => table.columns[index]),
            chartType: suggested.series.length > 1 ? 'line' : 'bar',
          },
          firstRows: table.rows.slice(0, 5),
        });
      },
    },
  ];
}
