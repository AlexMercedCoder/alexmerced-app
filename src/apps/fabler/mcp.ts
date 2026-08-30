import { errorResult, readEnum, readNumber, readString, requireString, textResult, type McpTool } from '../../lib/webmcp';
import { FIELD_KINDS } from './generators';
import {
  createField, createTable, generate, OUTPUT_FORMATS, toCsv, toDdl, toJson, toSqlInserts,
  type Dataset, type Field, type FieldKind,
} from './model';

/**
 * Fabler's tools. Made-up data is something an agent is often asked for and is
 * bad at: invented rows drift, repeat, and quietly break referential integrity.
 * This generates it properly, from a seed, so the same request gives the same
 * answer twice.
 */
export function fablerTools(): McpTool[] {
  const kinds = FIELD_KINDS.map((entry) => entry.id);

  return [
    {
      name: 'fabler_list_field_kinds',
      description:
        'List every kind of field Fabler can generate, grouped by what they are for: names, contact details, addresses, companies, dates, numbers, identifiers, text, and keys. Read this before calling fabler_generate so the field kinds you ask for exist.',
      inputSchema: { type: 'object', properties: {} },
      execute: () => textResult({
        kinds: FIELD_KINDS.map((entry) => ({ id: entry.id, label: entry.label, group: entry.group })),
        formats: OUTPUT_FORMATS,
      }),
    },
    {
      name: 'fabler_generate',
      description:
        'Generate realistic sample data from a description of the tables you want, and return it as JSON, newline JSON, CSV, SQL inserts, or a CREATE TABLE. Foreign keys really point at rows that exist. The same seed always produces the same data, so a test fixture stays stable.',
      inputSchema: {
        type: 'object',
        properties: {
          tables: {
            type: 'array',
            description: 'One entry per table: {"name":"customers","rows":50,"fields":[{"name":"id","kind":"uuid"},{"name":"email","kind":"email"}]}. A field of kind "foreignKey" also takes "references" naming another table.',
            items: { type: 'object' },
          },
          rows: { type: 'number', description: 'Default row count for any table that does not give one. Twenty by default.' },
          seed: { type: 'string', description: 'Same seed, same data. Any string or number. "1" by default.' },
          format: { type: 'string', enum: [...OUTPUT_FORMATS], description: 'How to return it. JSON by default.' },
        },
        required: ['tables'],
      },
      execute: (input) => {
        const raw = input.tables;
        if (!Array.isArray(raw) || raw.length === 0) {
          throw new Error('"tables" must be a list with at least one table in it.');
        }

        const defaultRows = Math.max(1, Math.min(10000, Math.round(readNumber(input, 'rows', 20))));
        const seed = readString(input, 'seed') || String(Math.round(readNumber(input, 'seed', 1)));
        const format = readEnum(input, 'format', OUTPUT_FORMATS, 'json');

        const unknown: string[] = [];
        const tables = raw.map((entry, index) => {
          const spec = (entry ?? {}) as Record<string, unknown>;
          const name = typeof spec.name === 'string' && spec.name.trim() ? spec.name : `table_${index + 1}`;
          const table = createTable(name);
          table.rows = Math.max(1, Math.min(10000, Math.round(
            typeof spec.rows === 'number' && Number.isFinite(spec.rows) ? spec.rows : defaultRows,
          )));

          const fieldSpecs = Array.isArray(spec.fields) ? spec.fields : [];
          table.fields = fieldSpecs.map((fieldSpec, fieldIndex) => {
            const detail = (fieldSpec ?? {}) as Record<string, unknown>;
            const fieldName = typeof detail.name === 'string' && detail.name.trim() ? detail.name : `field_${fieldIndex + 1}`;
            const kind = typeof detail.kind === 'string' ? detail.kind : 'fullName';
            if (!kinds.includes(kind as FieldKind)) unknown.push(kind);
            const field: Field = createField(fieldName, (kinds.includes(kind as FieldKind) ? kind : 'fullName') as FieldKind);
            if (typeof detail.references === 'string') field.references = detail.references;
            if (typeof detail.nullRate === 'number') field.nullRate = Math.max(0, Math.min(1, detail.nullRate));
            return field;
          });

          if (table.fields.length === 0) {
            table.fields = [createField('id', 'uuid'), createField('name', 'fullName')];
          }
          return table;
        });

        if (unknown.length) {
          return errorResult(
            `These field kinds do not exist: ${[...new Set(unknown)].join(', ')}. Call fabler_list_field_kinds to see what does.`,
          );
        }

        // The seed is a string, so any value the caller sends becomes one.
        const dataset: Dataset = { tables, seed: String(seed) };
        const generated = generate(dataset);

        const output: Record<string, string> = {};
        for (const entry of generated) {
          output[entry.table.name] =
            format === 'csv' ? toCsv(entry.rows, entry.table.fields)
            : format === 'ndjson' ? entry.rows.map((row) => JSON.stringify(row)).join('\n')
            : format === 'sql' ? toSqlInserts(entry.rows, entry.table)
            : format === 'ddl' ? toDdl(entry.table)
            : toJson(entry.rows);
        }

        return textResult({
          seed: String(seed),
          format,
          counts: Object.fromEntries(generated.map((entry) => [entry.table.name, entry.rows.length])),
          data: output,
        });
      },
    },
  ];
}
