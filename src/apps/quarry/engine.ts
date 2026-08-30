import type * as duckdb from '@duckdb/duckdb-wasm';
import { formatOf, registerStatement, splitStatements, statementKind, type SourceFormat } from './sql';

/**
 * The database itself.
 *
 * DuckDB is compiled to WebAssembly and served from this site rather than from
 * a content delivery network. A CDN would keep the repository smaller, but a
 * script from someone else's domain would run with full access to whatever you
 * loaded into it, and that is the one thing this site promises never happens.
 *
 * It weighs about thirty four megabytes, so it is fetched the first time you
 * open the page and not before. Nothing else on the site pays for it.
 */

export const ENGINE_BYTES = 34_242_586;

export class EngineError extends Error {}

export type Column = { name: string; type: string };

export type QueryResult = {
  columns: Column[];
  rows: unknown[][];
  /** How many rows the query produced, which can exceed the rows returned. */
  total: number;
  truncated: boolean;
  elapsed: number;
  statement: string;
};

export type TableInfo = { name: string; columns: Column[]; rows: number | null; bytes?: number };

/** Whether this browser can run the build being served. */
export function canRun(): boolean {
  if (typeof WebAssembly === 'undefined') return false;
  try {
    // A minimal module using the exception handling opcode. If the browser
    // cannot validate it, the engine will not start and it is better to say so
    // than to download thirty four megabytes and fail.
    return WebAssembly.validate(
      new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 8, 1, 6, 0, 6, 64, 25, 11, 11]),
    );
  } catch {
    return false;
  }
}

let instance: Promise<Engine> | null = null;

/** One database per page. Starting a second would double the memory for nothing. */
export function engine(onProgress?: (stage: string) => void): Promise<Engine> {
  if (!instance) instance = Engine.start(onProgress);
  return instance;
}

/**
 * Whether the engine is already running, without starting it.
 *
 * An agent tool can start the database on a page whose own controls have not
 * been touched, and the page needs to notice so it can show the workspace
 * rather than the button offering to download thirty four megabytes.
 */
export function engineStarted(): boolean {
  return instance !== null;
}

export class Engine {
  private constructor(
    private readonly db: duckdb.AsyncDuckDB,
    private connection: duckdb.AsyncDuckDBConnection,
    private readonly worker: Worker,
  ) {}

  static async start(onProgress?: (stage: string) => void): Promise<Engine> {
    if (!canRun()) {
      throw new EngineError('This browser cannot run the WebAssembly build this needs. Chrome, Edge, Firefox, and Safari have all supported it since 2021.');
    }

    onProgress?.('Fetching the engine');
    const duckdbModule = await import('@duckdb/duckdb-wasm');

    // Self-hosted, so both files come from this origin.
    const bundle = {
      mainModule: '/duckdb/duckdb-eh.wasm',
      mainWorker: '/duckdb/duckdb-browser-eh.worker.js',
    };

    onProgress?.('Starting the database');
    const worker = new Worker(bundle.mainWorker);
    const logger = new duckdbModule.VoidLogger();
    const db = new duckdbModule.AsyncDuckDB(logger, worker);
    await db.instantiate(bundle.mainModule);

    const connection = await db.connect();
    return new Engine(db, connection, worker);
  }

  /** Loads a file into the virtual filesystem and makes a view over it. */
  async addFile(name: string, bytes: Uint8Array, table: string): Promise<TableInfo> {
    const format = formatOf(name);
    if (format === 'unknown') {
      throw new EngineError(`${name} is not a format this can read. Try CSV, JSON, Parquet, or Arrow.`);
    }

    // registerFileBuffer transfers the buffer to the worker, which detaches it
    // and leaves length at zero here. Anything worth knowing about it has to be
    // read first.
    const size = bytes.length;
    await this.db.registerFileBuffer(name, bytes);

    const statement = registerStatement(table, name, format);
    if (statement) {
      try {
        await this.connection.query(statement);
      } catch (error) {
        // Drop the file again so a failed load does not leave rubbish behind.
        await this.db.dropFile(name).catch(() => {});
        throw new EngineError(describe(error, `${name} could not be read`));
      }
    }

    const info = await this.describeTable(table);
    return { ...info, bytes: size };
  }

  async describeTable(table: string): Promise<TableInfo> {
    const columns = await this.query(`DESCRIBE ${quote(table)};`);
    const info: Column[] = columns.rows.map((row) => ({
      name: String(row[0] ?? ''),
      type: String(row[1] ?? ''),
    }));

    let rows: number | null = null;
    try {
      const count = await this.query(`SELECT count(*) FROM ${quote(table)};`);
      const value = count.rows[0]?.[0];
      rows = typeof value === 'bigint' ? Number(value) : typeof value === 'number' ? value : null;
    } catch {
      // A view over a broken file can describe but not count. That is worth
      // showing rather than treating as a failure.
      rows = null;
    }

    return { name: table, columns: info, rows };
  }

  async tables(): Promise<TableInfo[]> {
    const listed = await this.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' ORDER BY table_name;",
    );
    const names = listed.rows.map((row) => String(row[0]));
    const infos: TableInfo[] = [];
    for (const name of names) {
      try {
        infos.push(await this.describeTable(name));
      } catch {
        infos.push({ name, columns: [], rows: null });
      }
    }
    return infos;
  }

  /**
   * Runs one statement. Rows past the limit are counted but not returned, so a
   * SELECT over ten million rows does not try to build ten million table cells.
   */
  async query(sql: string, limit = 5000): Promise<QueryResult> {
    const started = performance.now();
    let table: import('apache-arrow').Table;
    try {
      table = await this.connection.query(sql);
    } catch (error) {
      throw new EngineError(describe(error, 'The query failed'));
    }
    const elapsed = performance.now() - started;

    const columns: Column[] = table.schema.fields.map((field) => ({
      name: field.name,
      type: String(field.type),
    }));

    const total = table.numRows;
    const rows: unknown[][] = [];
    const wanted = Math.min(total, limit);
    for (let index = 0; index < wanted; index += 1) {
      const row = table.get(index);
      rows.push(columns.map((column) => row?.[column.name] ?? null));
    }

    return { columns, rows, total, truncated: total > wanted, elapsed, statement: sql };
  }

  /** Runs a whole script, returning the result of the last statement that had one. */
  async runScript(script: string, limit = 5000): Promise<{ results: QueryResult[]; commands: number }> {
    const statements = splitStatements(script);
    if (statements.length === 0) throw new EngineError('There is nothing to run.');

    const results: QueryResult[] = [];
    let commands = 0;

    for (const statement of statements) {
      const kind = statementKind(statement);
      if (kind === 'empty') continue;
      const result = await this.query(statement, limit);
      if (kind === 'query') results.push(result);
      else commands += 1;
    }

    return { results, commands };
  }

  /** Exports a query straight to Parquet, without the rows passing through JavaScript. */
  async toParquet(sql: string): Promise<Uint8Array> {
    const path = `export_${Date.now()}.parquet`;
    try {
      await this.connection.query(`COPY (${stripTrailingSemicolon(sql)}) TO '${path}' (FORMAT PARQUET);`);
      const bytes = await this.db.copyFileToBuffer(path);
      return bytes;
    } catch (error) {
      throw new EngineError(describe(error, 'The export failed'));
    } finally {
      await this.db.dropFile(path).catch(() => {});
    }
  }

  async dropTable(table: string, file: string | null): Promise<void> {
    await this.connection.query(`DROP VIEW IF EXISTS ${quote(table)};`).catch(() => {});
    await this.connection.query(`DROP TABLE IF EXISTS ${quote(table)};`).catch(() => {});
    if (file) await this.db.dropFile(file).catch(() => {});
  }

  /** Throws everything away and starts a fresh connection. */
  async reset(): Promise<void> {
    await this.connection.close().catch(() => {});
    await this.db.reset().catch(() => {});
    this.connection = await this.db.connect();
  }

  async close(): Promise<void> {
    await this.connection.close().catch(() => {});
    await this.db.terminate().catch(() => {});
    this.worker.terminate();
    instance = null;
  }
}

function quote(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function stripTrailingSemicolon(sql: string): string {
  return sql.trim().replace(/;+\s*$/, '');
}

/** DuckDB's messages are good. This keeps them, and adds context when they are not. */
function describe(error: unknown, prefix: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const cleaned = message.replace(/^Error:\s*/, '').trim();
  return cleaned ? cleaned : `${prefix}.`;
}

export const SAMPLE_CSV = `city,day,driver,fare,distance_km,tip
Bristol,2026-01-04,Ada,18.40,7.2,2.00
Bristol,2026-01-05,Ada,12.10,4.1,1.50
Bristol,2026-01-06,Grace,26.75,11.8,4.00
Bristol,2026-01-07,Grace,9.60,3.0,0.00
Bristol,2026-01-08,Ada,31.20,14.4,5.00
Leeds,2026-01-04,Alan,22.80,9.6,3.00
Leeds,2026-01-05,Alan,15.35,6.0,1.00
Leeds,2026-01-06,Katherine,41.90,19.2,6.50
Leeds,2026-01-07,Katherine,7.25,2.2,0.00
Leeds,2026-01-08,Alan,28.05,12.9,4.25
Cardiff,2026-01-04,Joan,11.70,4.4,1.25
Cardiff,2026-01-05,Joan,33.60,15.1,5.50
Cardiff,2026-01-06,Edsger,19.85,8.3,2.75
Cardiff,2026-01-07,Edsger,24.40,10.7,3.00
Cardiff,2026-01-08,Joan,16.15,6.6,2.00
Glasgow,2026-01-04,Barbara,29.90,13.5,4.50
Glasgow,2026-01-05,Barbara,13.05,5.1,1.75
Glasgow,2026-01-06,Tim,37.45,17.0,6.00
Glasgow,2026-01-07,Tim,8.80,2.8,0.50
Glasgow,2026-01-08,Barbara,21.60,9.1,3.25
`;
