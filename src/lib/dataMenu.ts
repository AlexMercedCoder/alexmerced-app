import { downloadFile, exportFilename, ImportError, pickTextFile, type ImportMode } from './portable';
import { toast } from './toast';

type DataMenuOptions = {
  app: string;
  buildExport: () => Promise<unknown> | unknown;
  applyImport: (text: string, mode: ImportMode) => Promise<string> | string;
  onImported: () => Promise<void> | void;
  /** Called when the visitor confirms they want everything gone. */
  onClearAll?: () => Promise<void> | void;
  clearWarning?: string;
};

/**
 * Wires the shared Export / Import / Clear controls that every app carries.
 * Keeping this in one place means the file format, the confirmations, and the
 * error messages stay identical across the shelf.
 */
export function wireDataMenu(root: ParentNode, options: DataMenuOptions): void {
  const exportButton = root.querySelector<HTMLButtonElement>('[data-action="export"]');
  const importButton = root.querySelector<HTMLButtonElement>('[data-action="import"]');
  const clearButton = root.querySelector<HTMLButtonElement>('[data-action="clear-all"]');
  const dialog = root.querySelector<HTMLDialogElement>('[data-role="import-dialog"]');

  exportButton?.addEventListener('click', async () => {
    try {
      const envelope = await options.buildExport();
      downloadFile(exportFilename(options.app), JSON.stringify(envelope, null, 2));
      toast('Exported to your downloads folder.', { kind: 'good' });
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Export failed.', { kind: 'error' });
    }
  });

  importButton?.addEventListener('click', async () => {
    const text = await pickTextFile();
    if (text === null) return;

    const runImport = async (mode: ImportMode) => {
      try {
        const summary = await options.applyImport(text, mode);
        await options.onImported();
        toast(summary, { kind: 'good' });
      } catch (error) {
        toast(
          error instanceof ImportError || error instanceof Error
            ? error.message
            : 'That file could not be imported.',
          { kind: 'error', duration: 8000 },
        );
      }
    };

    if (!dialog) {
      await runImport('merge');
      return;
    }

    dialog.returnValue = '';
    dialog.showModal();
    dialog.addEventListener(
      'close',
      async () => {
        if (dialog.returnValue === 'merge' || dialog.returnValue === 'replace') {
          await runImport(dialog.returnValue);
        }
      },
      { once: true },
    );
  });

  clearButton?.addEventListener('click', async () => {
    if (!options.onClearAll) return;
    const warning =
      options.clearWarning ??
      'This deletes everything this app has stored on this device. Export first if you want a copy. Continue?';
    if (!window.confirm(warning)) return;
    await options.onClearAll();
    await options.onImported();
    toast('Everything cleared.', { kind: 'good' });
  });
}

/** The markup for the merge-or-replace dialog, shared by every app. */
export const importDialogMarkup = `
<dialog class="sheet" data-role="import-dialog" aria-labelledby="import-dialog-title">
  <form method="dialog">
    <div class="sheet__head">
      <h2 id="import-dialog-title">Import this file</h2>
      <p>Merge keeps what is already here and adds the file on top. Replace throws away what is here first.</p>
    </div>
    <div class="sheet__foot">
      <button class="btn" value="cancel" type="submit">Cancel</button>
      <button class="btn" value="replace" type="submit">Replace everything</button>
      <button class="btn btn--primary" value="merge" type="submit">Merge</button>
    </div>
  </form>
</dialog>`;
