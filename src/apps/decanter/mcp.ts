import {
  errorResult, readBoolean, readEnum, readString, requireString, textResult, type McpTool,
} from '../../lib/webmcp';
import { defaultCsvOptions, parse, write, type FormatId } from './formats';
import { describe, flatten, inferSchema, query, toIcebergSchema, toJsonSchema, toSqlDdl, unflatten } from './transform';

const FORMAT_IDS = ['json', 'ndjson', 'csv', 'yaml', 'toml'] as const;

/**
 * Decanter's tools. Every parser and writer here was written for this site, so
 * an agent gets a conversion that behaves the same way the page does, with no
 * network call and no dependency on whatever the calling environment has
 * installed.
 */
export function decanterTools(): McpTool[] {
  return [
    {
      name: 'decanter_convert',
      description:
        'Convert structured data between JSON, newline-delimited JSON, CSV, YAML and TOML. All five parsers and writers run in the browser. Give the text and say which format it is in and which format you want back.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The data to convert.' },
          from: { type: 'string', enum: [...FORMAT_IDS], description: 'The format the text is in.' },
          to: { type: 'string', enum: [...FORMAT_IDS], description: 'The format you want back.' },
          delimiter: { type: 'string', description: 'CSV delimiter, one character. A comma by default.' },
          header: { type: 'boolean', description: 'Whether CSV has a header row. True by default.' },
          inferTypes: { type: 'boolean', description: 'Whether to read CSV numbers and booleans as such. True by default.' },
        },
        required: ['text', 'from', 'to'],
      },
      execute: (input) => {
        const text = requireString(input, 'text');
        const from = readEnum(input, 'from', FORMAT_IDS, 'json') as FormatId;
        const to = readEnum(input, 'to', FORMAT_IDS, 'json') as FormatId;
        const csvOptions = {
          delimiter: (readString(input, 'delimiter', ',') || ',').slice(0, 1),
          header: readBoolean(input, 'header', true),
          inferTypes: readBoolean(input, 'inferTypes', true),
        };

        try {
          const value = parse(text, from, csvOptions);
          const output = write(value, to, csvOptions);
          const stats = describe(value, output);
          return textResult({ from, to, output, records: stats.records, fields: stats.fields });
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : 'That could not be converted.', { from, to });
        }
      },
    },
    {
      name: 'decanter_infer_schema',
      description:
        'Work out the shape of some data and emit it as a schema. Reads JSON, NDJSON, CSV, YAML or TOML, samples the records, and returns the fields with their types and how often each one appears, plus a SQL CREATE TABLE, an Apache Iceberg schema, or a JSON Schema.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          from: { type: 'string', enum: [...FORMAT_IDS] },
          as: {
            type: 'string',
            enum: ['fields', 'sql', 'iceberg', 'jsonschema'],
            description: 'What to return. "fields" gives the raw analysis.',
          },
          name: { type: 'string', description: 'Table or record name for the generated schema.' },
        },
        required: ['text', 'from'],
      },
      execute: (input) => {
        const text = requireString(input, 'text');
        const from = readEnum(input, 'from', FORMAT_IDS, 'json') as FormatId;
        const as = readEnum(input, 'as', ['fields', 'sql', 'iceberg', 'jsonschema'] as const, 'fields');
        const name = readString(input, 'name', 'my_table');

        try {
          const value = parse(text, from, defaultCsvOptions);
          const fields = inferSchema(value);
          if (as === 'sql') return textResult({ sql: toSqlDdl(fields, name) });
          if (as === 'iceberg') return textResult({ iceberg: toIcebergSchema(fields) });
          if (as === 'jsonschema') return textResult({ jsonSchema: toJsonSchema(fields, name) });
          return textResult({ fields });
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : 'That could not be analysed.');
        }
      },
    },
    {
      name: 'decanter_reshape',
      description:
        'Flatten nested data into single-level keys joined by a separator, put a flattened object back together, or pull values out by path. Paths use dots and brackets, and support a wildcard: "users[0].name", "items[*].price", "$.a.b".',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'JSON, unless "from" says otherwise.' },
          from: { type: 'string', enum: [...FORMAT_IDS] },
          operation: { type: 'string', enum: ['flatten', 'unflatten', 'query'] },
          path: { type: 'string', description: 'Required for query. For example "items[*].price".' },
          separator: { type: 'string', description: 'Key separator for flatten and unflatten. A dot by default.' },
        },
        required: ['text', 'operation'],
      },
      execute: (input) => {
        const text = requireString(input, 'text');
        const from = readEnum(input, 'from', FORMAT_IDS, 'json') as FormatId;
        const operation = readEnum(input, 'operation', ['flatten', 'unflatten', 'query'] as const, 'flatten');
        const separator = readString(input, 'separator', '.') || '.';

        try {
          const value = parse(text, from, defaultCsvOptions);
          if (operation === 'flatten') return textResult({ result: flatten(value, separator) });
          if (operation === 'unflatten') {
            if (typeof value !== 'object' || value === null || Array.isArray(value)) {
              return errorResult('Unflattening needs an object of flat keys.');
            }
            return textResult({ result: unflatten(value as Record<string, never>, separator) });
          }
          const path = requireString(input, 'path');
          const matches = query(value, path);
          return textResult({ path, matches, count: matches.length });
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : 'That could not be reshaped.');
        }
      },
    },
  ];
}
