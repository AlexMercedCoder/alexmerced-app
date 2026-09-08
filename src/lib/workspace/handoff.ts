import { Collection, openDatabase } from '../idb';
import { toast } from '../toast';
const targets: Record<string, string> = { quarry: '#qy-file', quire: '#qr-file', loupe: '#lp-file', foolscap: '#fs-file', cutaway: '#cw-file', limelight: '#ll-file', cadence: '#cd-file', tessera: '#ts-file' };
type Packet = { id: string; target: string; files: { name: string; type: string; bytes: ArrayBuffer }[]; created: number };
async function collection() { return new Collection<Packet>(await openDatabase('workspace-transfers', 1, [{ name: 'files' }]), 'files'); }
export function compatible(file: Pick<File, 'name' | 'type'>): string[] {
  const name = file.name.toLowerCase();
  if (file.type.startsWith('image/')) return ['loupe', 'quire', 'foolscap', 'tessera'];
  if (file.type === 'application/pdf' || name.endsWith('.pdf')) return ['quire'];
  if (file.type.startsWith('video/') || /\.(mp4|webm|mov)$/.test(name)) return ['cutaway', 'limelight'];
  if (file.type.startsWith('audio/') || /\.(wav|mp3|ogg)$/.test(name)) return ['cadence'];
  if (/\.(csv|tsv|json|jsonl|ndjson|parquet|arrow)$/.test(name)) return ['quarry', ...(/\.(csv|tsv|json)$/.test(name) ? ['ordinate', 'decanter'] : [])];
  if (/\.(yaml|yml|toml|txt)$/.test(name)) return ['decanter'];
  return [];
}
export async function sendFiles(target: string, files: File[]): Promise<void> {
  if (!files.length) throw new Error('Choose a file first.');
  const store = await collection();
  for (const packet of await store.all()) if (Date.now() - packet.created > 86400000) await store.delete(packet.id);
  const id = crypto.randomUUID();
  const packed = await Promise.all(files.map(async file => ({ name: file.name, type: file.type, bytes: await file.arrayBuffer() })));
  await store.put({ id, target, files: packed, created: Date.now() });
  location.assign(`/${target}?transfer=${encodeURIComponent(id)}`);
}
export async function receiveFiles(app: string, accept: (files: File[]) => Promise<void>): Promise<void> {
  const id = new URL(location.href).searchParams.get('transfer'); if (!id) return;
  const store = await collection(); const packet = await store.get(id);
  if (!packet || packet.target !== app) return;
  try {
    await accept(packet.files.map(file => new File([file.bytes], file.name, { type: file.type }))); await store.delete(id);
    const url = new URL(location.href); url.searchParams.delete('transfer'); history.replaceState(null, '', url);
    toast('File received. Your original file is unchanged.', { kind: 'good' });
  } catch (error) { toast(error instanceof Error ? error.message : 'The file could not open. Reload to retry.', { kind: 'error' }); }
}
export async function receiveInput(app: string) {
  if (!targets[app]) return;
  await receiveFiles(app, async files => {
    const selector = app === 'quire' && files.every(f => f.type.startsWith('image/')) ? '#qr-image-file' : targets[app];
    const input = document.querySelector<HTMLInputElement>(selector);
    if (!input) throw new Error('The file picker is unavailable.');
    const transfer = new DataTransfer(); for (const file of files) transfer.items.add(file);
    input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
export function sendButton(root: HTMLElement, label: string, target: string, files: () => Promise<File[]>) {
  const button = document.createElement('button'); button.className = 'btn btn--sm'; button.textContent = label;
  button.onclick = async () => { button.disabled = true; try { await sendFiles(target, await files()); } catch (error) { toast(error instanceof Error ? error.message : 'Transfer failed.', { kind: 'error' }); } finally { button.disabled = false; } };
  root.prepend(button);
}
