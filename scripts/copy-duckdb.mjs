/**
 * Copies the DuckDB WebAssembly build out of node_modules and into public/.
 *
 * The engine is self-hosted rather than pulled from a CDN. A CDN would keep the
 * repository smaller, but a script served from someone else's domain runs with
 * full access to whatever gets loaded into the tool, and the whole point of
 * this site is that your data stays with you. Self-hosting removes both that
 * risk and the third party's view of who opened the page.
 *
 * It is copied at build time rather than committed, so the repository stays a
 * few megabytes instead of forty.
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SOURCE = join(ROOT, 'node_modules', '@duckdb', 'duckdb-wasm', 'dist');
const TARGET = join(ROOT, 'public', 'duckdb');

// Only the exception-handling build. Every browser released since the end of
// 2021 supports it, and carrying the older fallback would add another forty
// megabytes to the deploy for browsers nobody is using.
const FILES = ['duckdb-eh.wasm', 'duckdb-browser-eh.worker.js'];

if (!existsSync(SOURCE)) {
  console.error('DuckDB was not found in node_modules. Run npm install first.');
  process.exit(1);
}

mkdirSync(TARGET, { recursive: true });

let total = 0;
for (const file of FILES) {
  const from = join(SOURCE, file);
  const to = join(TARGET, file);
  if (!existsSync(from)) {
    console.error(`DuckDB is missing ${file}. The package layout may have changed.`);
    process.exit(1);
  }
  // Skip the copy when the file is already there and the same size, so a rebuild
  // does not rewrite thirty four megabytes for nothing.
  if (existsSync(to) && statSync(to).size === statSync(from).size) {
    total += statSync(to).size;
    continue;
  }
  copyFileSync(from, to);
  total += statSync(to).size;
}

console.log(`DuckDB ready in public/duckdb (${(total / 1024 / 1024).toFixed(1)} MB).`);
