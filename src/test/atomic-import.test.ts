import { describe, expect, it, vi } from 'vitest';
import * as laneway from '../apps/laneway/store';
import * as rote from '../apps/rote/store';
import * as stint from '../apps/stint/store';

for (const [name, store, child] of [
  ['Laneway', laneway, 'cards'], ['Rote', rote, 'cards'], ['Stint', stint, 'entries'],
] as const) {
  describe(`${name} import rollback`, () => {
    for (const mode of ['merge', 'replace'] as const) {
      it(`preserves the entire workspace when ${mode} fails in the second collection`, async () => {
        await store.clearAll();
        await store.loadWorkspace();
        const before = await store.loadWorkspace();
        const exported = await store.buildExport();
        const data = exported.data as unknown as Record<string, { name: string }[]>;
        const parents = data.boards ?? data.decks ?? data.projects;
        parents[0].name = 'Changed by an import that must roll back';
        const original = IDBObjectStore.prototype.clear;
        const failure = vi.spyOn(IDBObjectStore.prototype, 'clear').mockImplementation(function (this: IDBObjectStore) {
          if (this.name === child) throw new DOMException('Disk full', 'QuotaExceededError');
          return original.call(this);
        });
        try {
          await expect(store.applyImport(JSON.stringify(exported), mode)).rejects.toThrow('Disk full');
        } finally { failure.mockRestore(); }
        expect(await store.loadWorkspace()).toEqual(before);
      });
    }
  });
}
