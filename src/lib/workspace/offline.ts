import { runJob } from './jobs';
const ENGINE = ['/duckdb/duckdb-eh.wasm', '/duckdb/duckdb-browser-eh.worker.js'];
export async function readiness() {
  if (!('caches' in window)) return { core: 0, sql: false, models: 0 };
  const keys = await caches.keys(); let core = 0; let models = 0;
  for (const key of keys) {
    const requests = await (await caches.open(key)).keys();
    if (key.startsWith('alexmerced-app-')) core = Math.max(core, requests.filter(r => new URL(r.url).pathname.endsWith('/')).length);
    if (key === 'transformers-cache' || key === 'workspace-speech') models += requests.length;
  }
  return { core, sql: (await Promise.all(ENGINE.map(path => caches.match(path)))).every(Boolean), models };
}
export async function prepareSql() {
  await runJob('Download SQL engine', async (signal, progress) => {
    const cache = await caches.open('workspace-engines');
    for (const [index, url] of ENGINE.entries()) {
      progress(`Downloading file ${index + 1} of ${ENGINE.length}`);
      const response = await fetch(url, { signal }); if (!response.ok) throw new Error('The SQL download failed. Try again when connected.');
      // Read before committing so cancellation cannot leave a partial cache entry.
      const bytes = await response.arrayBuffer(); signal.throwIfAborted();
      await cache.put(url, new Response(bytes, { headers: response.headers }));
    }
  });
}
export async function removeSql() {
  for (const key of await caches.keys()) { const cache = await caches.open(key); for (const url of ENGINE) await cache.delete(url); }
}
export async function removeSpeech() { await caches.delete('workspace-speech'); await caches.delete('transformers-cache'); }
