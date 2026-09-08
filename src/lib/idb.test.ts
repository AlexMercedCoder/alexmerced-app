import { describe, expect, it } from 'vitest';
import { Collection, openDatabase } from './idb';

async function fixture() {
  const db = await openDatabase(`atomic-${crypto.randomUUID()}`, 1, [
    { name: 'parents' },
    { name: 'children', indexes: [{ name: 'label', keyPath: 'label', unique: true }] },
  ]);
  const parents = new Collection<{ id: string }>(db, 'parents');
  const children = new Collection<{ id: string; label: string }>(db, 'children');
  await parents.put({ id: 'old-parent' });
  await children.put({ id: 'old-child', label: 'old' });
  return { db, parents, children };
}

describe('atomic collection replacement', () => {
  it('rolls back both stores when a later request violates a unique index', async () => {
    const { db, parents, children } = await fixture();
    try {
      await expect(Collection.replaceTogether([
        { collection: parents, records: [{ id: 'new-parent' }] },
        { collection: children, records: [
          { id: 'a', label: 'duplicate' }, { id: 'b', label: 'duplicate' },
        ] as { id: string; label: string }[] },
      ])).rejects.toThrow();
      expect(await parents.all()).toEqual([{ id: 'old-parent' }]);
      expect(await children.all()).toEqual([{ id: 'old-child', label: 'old' }]);
    } finally { db.close(); }
  });

  it('rolls back queued changes when a record cannot be cloned', async () => {
    const { db, parents, children } = await fixture();
    try {
      await expect(Collection.replaceTogether([
        { collection: parents, records: [{ id: 'new-parent' }] },
        { collection: children, records: [{ id: 'bad', fn: () => {} }] as { id: string; fn: () => void }[] },
      ])).rejects.toThrow();
      expect(await parents.all()).toEqual([{ id: 'old-parent' }]);
      expect(await children.all()).toEqual([{ id: 'old-child', label: 'old' }]);
    } finally { db.close(); }
  });
});
