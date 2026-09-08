import { apps } from '../../data/apps';
import { backup, decode, encode, restore, validateArchive, type Archive } from './archive';
import { downloadFile } from '../portable';
import { compatible, sendFiles } from './handoff';
import { readiness, prepareSql, removeSql, removeSpeech } from './offline';
import { runJob } from './jobs';
import { startExample } from './examples';
export async function mountCenter() {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const selected = (id: string) => Array.from($(id).querySelectorAll<HTMLInputElement>('input:checked')).map(i => i.value);
  const report = (id: string, error: unknown) => { $(id).textContent = error instanceof Error ? error.message : String(error); };
  let archive: Archive | null = null;
  async function download(slugs: string[], recovery = false) {
    if (!slugs.length) throw new Error('Select at least one tool.');
    await runJob('Create backup', async (signal, progress) => {
      progress('Reading selected workspaces. Large recordings can take a while.');
      const data = await backup(slugs); signal.throwIfAborted(); progress('Preparing the backup file…');
      const text = JSON.stringify(await encode(data)); signal.throwIfAborted();
      downloadFile(`alexmerced-${recovery ? 'recovery' : 'backup'}-${new Date().toISOString().slice(0, 10)}.json`, text);
      if (!recovery) localStorage.setItem('workspace:lastBackup', new Date().toISOString());
      $('last-backup').textContent = `Last backup download requested: ${new Date().toLocaleString()}. Check your downloads folder.`;
    });
  }
  $('last-backup').textContent = localStorage.getItem('workspace:lastBackup') ? `Last backup download requested: ${new Date(localStorage.getItem('workspace:lastBackup')!).toLocaleString()}` : 'No workspace backup has been downloaded from this browser yet.';
  const estimate = await navigator.storage?.estimate?.().catch(() => null);
  $('storage-estimate').textContent = estimate ? `Estimated site storage: ${((estimate.usage ?? 0) / 1e6).toFixed(1)} MB used of ${((estimate.quota ?? 0) / 1e6).toFixed(0)} MB available to this site.` : 'This browser does not report a storage estimate.';
  $('storage-persist').onclick = async () => { try { report('backup-status', await navigator.storage?.persist?.() ? 'Storage protection granted. Keep backups too; clearing site data still removes your work.' : 'The browser did not grant storage protection. Download backups regularly.'); } catch (e) { report('backup-status', e); } };
  $('backup-download').onclick = async () => { try { await download(selected('backup-apps')); report('backup-status', 'Backup download requested. Check that the file arrived before clearing any data.'); } catch (e) { report('backup-status', e); } };
  $<HTMLInputElement>('backup-file').onchange = async event => {
    archive = null; $('backup-restore').hidden = $('backup-recovery').hidden = true; $('restore-preview').replaceChildren();
    const file = (event.target as HTMLInputElement).files?.[0]; if (!file) return;
    try {
      archive = validateArchive(decode(JSON.parse(await file.text())));
      for (const workspace of archive.workspaces) {
        const label = document.createElement('label'); label.className = 'launcher-row';
        const check = document.createElement('input'); check.type = 'checkbox'; check.value = workspace.app; check.checked = true;
        label.append(check, `${workspace.app}: ${Object.values(workspace.stores).reduce((n, rows) => n + rows.length, 0)} records, ${Object.keys(workspace.preferences).length} settings`); $('restore-preview').append(label);
      }
      $('backup-restore').hidden = $('backup-recovery').hidden = false;
      report('backup-status', 'Choose workspaces to replace. Download a recovery copy first. Each workspace restores separately; completed ones stay restored if a later one fails.');
    } catch (e) { report('backup-status', e); }
  };
  $('backup-recovery').onclick = async () => { try { await download(selected('restore-preview'), true); } catch (e) { report('backup-status', e); } };
  $('backup-restore').onclick = async () => {
    if (!archive || !selected('restore-preview').length || !confirm('Replace saved work for the selected tools? This removes their current records and settings.')) return;
    const button = $<HTMLButtonElement>('backup-restore'); button.disabled = true;
    const completed: string[] = [];
    try { await restore(archive, selected('restore-preview'), app => { completed.push(app); report('backup-status', `Restored: ${completed.join(', ')}`); }); report('backup-status', `Restore complete: ${completed.join(', ')}. Open those tools to check your work.`); }
    catch (e) { report('backup-status', `${e instanceof Error ? e.message : e}\nAlready restored: ${completed.join(', ') || 'none'}.`); }
    finally { button.disabled = false; }
  };
  async function checkOffline() {
    const status = await readiness();
    $('offline-core').textContent = status.core >= apps.length ? `Core tools cached (${status.core} pages).` : 'Core tools are not fully cached yet. Prepare them while connected.';
    $('offline-sql').textContent = `SQL engine: ${status.sql ? 'downloaded' : 'not downloaded'}.`;
    $('offline-model').textContent = status.models ? `Speech cache contains ${status.models} files. Preparing the chosen model verifies that it can load; a partial cache is not proof of offline readiness.` : 'No speech downloads found.';
  }
  $('offline-refresh').onclick = () => { void checkOffline().catch(e => report('offline-status', e)); };
  $('offline-core-download').onclick = async () => { try { await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; await checkOffline(); } catch (e) { report('offline-status', e); } };
  for (const [id, action] of [['offline-sql-download', prepareSql], ['offline-sql-remove', removeSql], ['offline-model-remove', removeSpeech]] as const) {
    $(id).onclick = async () => { const button = $<HTMLButtonElement>(id); button.disabled = true; try { await action(); await checkOffline(); report('offline-status', 'Done.'); } catch (e) { report('offline-status', e); } finally { button.disabled = false; } };
  }
  $('offline-model-download').onclick = async () => {
    const button = $<HTMLButtonElement>('offline-model-download'); button.disabled = true;
    try {
      await runJob('Prepare speech model', async (signal, progress) => {
        const worker = new Worker(new URL('./modelWorker.ts', import.meta.url), { type: 'module' });
        try {
          await new Promise<void>((resolve, reject) => {
            signal.addEventListener('abort', () => { worker.terminate(); reject(new Error('Download cancelled. You can prepare the model again to resume cached files.')); }, { once: true });
            worker.onerror = () => reject(new Error('The model worker failed. Check your connection and try a smaller model.'));
            worker.onmessage = ({ data }) => {
              if (data.error) reject(new Error(data.error));
              else if (data.done) resolve();
              else if (data.progress) { const p = data.progress; progress(`${p.stage}${p.ratio === null ? '' : ` ${Math.round(p.ratio * 100)}%`}`); }
            };
            worker.postMessage($<HTMLSelectElement>('offline-size').value);
          });
        } finally { worker.terminate(); }
      }); await checkOffline(); report('offline-status', 'The selected speech model loaded successfully. Test it with your browser offline before relying on it away from a connection.');
    } catch (e) { report('offline-status', e); } finally { button.disabled = false; }
  };
  function pick(file?: File) {
    $('inbox-actions').replaceChildren(); if (!file) return;
    const slugs = compatible(file); $('inbox-status').textContent = `${file.name}: ${slugs.length ? 'choose a tool below.' : 'no compatible tool found.'}`;
    for (const slug of slugs) { const button = document.createElement('button'); button.className = 'btn'; button.textContent = `Open in ${apps.find(a => a.slug === slug)!.name}`; button.onclick = async () => { try { await sendFiles(slug, [file]); } catch (e) { report('inbox-status', e); } }; $('inbox-actions').append(button); }
  }
  $<HTMLInputElement>('inbox-file').onchange = e => pick((e.target as HTMLInputElement).files?.[0]);
  $('workspace-drop').ondragover = e => e.preventDefault(); $('workspace-drop').ondrop = e => { e.preventDefault(); pick(e.dataTransfer?.files[0]); };
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-example]')) button.onclick = async () => { button.disabled = true; try { await startExample(button.dataset.example!); } catch (e) { report('example-status', e); } finally { button.disabled = false; } };
  await checkOffline().catch(e => report('offline-status', e));
}
