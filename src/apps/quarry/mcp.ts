import { errorResult, readEnum, readNumber, requireString, textResult, truncate, type McpTool } from '../../lib/webmcp';
import { engine, type Engine } from './engine';
import { displayValue, tableNameFrom, toCsv, toJson, toMarkdown, uniqueTableName } from './sql';

/**
 * Quarry's tools, which are the most useful on the site to an agent: a real
 * SQL engine over data the agent supplies, with no server and no upload.
 *
 * Starting the engine costs a thirty four megabyte download, so nothing here
 * touches it until a tool is actually called.
 */
export function quarryTools(getLoaded: () => string[], onChanged: () => void): McpTool[] {
  const ready = (): Promise<Engine> => engine();

  return [
    {
      name: 'quarry_load_data',
      description:
        'Load CSV, TSV, JSON, or newline-delimited JSON into the database so it can be queried. Give the text and a name; the name becomes the table. Returns the columns and their types. The data stays in this browser.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'A name for the table, or a filename to derive one from.' },
          text: { type: 'string', description: 'The data itself.' },
          format: { type: 'string', enum: ['csv', 'json', 'ndjson'], description: 'Guessed from the name when omitted.' },
        },
        required: ['name', 'text'],
      },
      execute: async (input) => {
        const rawName = requireString(input, 'name');
        const text = requireString(input, 'text');
        const format = readEnum(input, 'format', ['csv', 'json', 'ndjson'] as const,
          /\.(json|jsonl|ndjson)$/i.test(rawName) ? 'json' : 'csv');

        const extension = format === 'csv' ? 'csv' : format === 'ndjson' ? 'ndjson' : 'json';
        const filename = /\.[a-z]+$/i.test(rawName) ? rawName : `${rawName}.${extension}`;
        const table = uniqueTableName(tableNameFrom(rawName), getLoaded());

        const database = await ready();
        const info = await database.addFile(filename, new TextEncoder().encode(text), table);
        onChanged();

        return textResult({
          table: info.name,
          rows: info.rows,
          columns: info.columns,
          note: 'Query it by that table name. It is held in memory and goes when the tab closes.',
        });
      },
    },
    {
      name: 'quarry_run_sql',
      description:
        'Run SQL against the loaded tables and get the rows back. This is DuckDB, so joins, window functions, common table expressions, aggregates, JSON functions, and the rest of the language all work. Several statements separated by semicolons are allowed; the last one that returns rows is what comes back.',
      inputSchema: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'The query.' },
          limit: { type: 'number', description: 'Rows to return, 1 to 5000. 200 by default. The true row count is always reported.' },
          format: { type: 'string', enum: ['rows', 'csv', 'json', 'markdown'], description: 'How to shape the answer. "rows" by default.' },
        },
        required: ['sql'],
      },
      execute: async (input) => {
        const sql = requireString(input, 'sql');
        const limit = Math.max(1, Math.min(5000, Math.round(readNumber(input, 'limit', 200))));
        const format = readEnum(input, 'format', ['rows', 'csv', 'json', 'markdown'] as const, 'rows');

        const database = await ready();
        const { results, commands } = await database.runScript(sql, limit);
        onChanged();

        const last = results.at(-1);
        if (!last) {
          return textResult({ statementsRun: commands, rows: 0, note: 'Nothing was returned. That statement changes state rather than producing rows.' });
        }

        const names = last.columns.map((column) => column.name);
        const trimmed = truncate(last.rows, limit);

        const shaped =
          format === 'csv' ? { csv: toCsv(names, trimmed.items) }
          : format === 'json' ? { json: toJson(names, trimmed.items) }
          : format === 'markdown' ? { markdown: toMarkdown(names, trimmed.items) }
          : { rows: trimmed.items.map((row) => Object.fromEntries(names.map((name, index) => [name, displayValue(row[index])]))) };

        return textResult({
          columns: last.columns,
          totalRows: last.total,
          returnedRows: trimmed.items.length,
          truncated: last.truncated || trimmed.truncated,
          elapsedMs: Math.round(last.elapsed),
          statementsRun: commands,
          ...shaped,
        });
      },
    },
    {
      name: 'quarry_list_tables',
      description:
        'List the tables currently loaded, with their columns, types and row counts. Use this before writing a query so the column names are right.',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => {
        const database = await ready();
        const tables = await database.tables();
        if (tables.length === 0) {
          return textResult({ tables: [], note: 'Nothing is loaded. Use quarry_load_data first.' });
        }
        return textResult({ tables });
      },
    },
    {
      name: 'quarry_export_parquet',
      description:
        'Run a query and return the whole result as a Parquet file, written by the engine rather than reassembled in JavaScript. Returns a data URI. Use this when the result is meant to be kept or handed to another tool rather than read.',
      inputSchema: {
        type: 'object',
        properties: { sql: { type: 'string' } },
        required: ['sql'],
      },
      execute: async (input) => {
        const sql = requireString(input, 'sql');
        const database = await ready();
        try {
          const bytes = await database.toParquet(sql);
          return textResult({
            filename: 'result.parquet',
            bytes: bytes.length,
            dataUri: `data:application/vnd.apache.parquet;base64,${base64(bytes)}`,
          });
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : 'The export failed.');
        }
      },
    },
  ];
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}
