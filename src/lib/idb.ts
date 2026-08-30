/**
 * A small promise wrapper over IndexedDB.
 *
 * Everything on alexmerced.app stores its data on the visitor's own machine.
 * IndexedDB holds the records; localStorage holds interface preferences. There
 * is no server, so this file is the whole storage layer.
 */

export type StoreSpec = {
  name: string;
  keyPath?: string;
  indexes?: { name: string; keyPath: string | string[]; unique?: boolean }[];
};

const wrap = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });

export function openDatabase(name: string, version: number, stores: StoreSpec[]): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);

    request.onupgradeneeded = () => {
      const db = request.result;
      for (const spec of stores) {
        const store = db.objectStoreNames.contains(spec.name)
          ? request.transaction!.objectStore(spec.name)
          : db.createObjectStore(spec.name, { keyPath: spec.keyPath ?? 'id' });

        for (const index of spec.indexes ?? []) {
          if (!store.indexNames.contains(index.name)) {
            store.createIndex(index.name, index.keyPath, { unique: index.unique ?? false });
          }
        }
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(`Could not open database "${name}"`));
    request.onblocked = () =>
      reject(new Error(`Database "${name}" is open in another tab and blocking an upgrade.`));
  });
}

function transact<T>(
  db: IDBDatabase,
  storeNames: string | string[],
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    let result: T;
    let settled = false;

    tx.oncomplete = () => { if (!settled) { settled = true; resolve(result); } };
    tx.onerror = () => { if (!settled) { settled = true; reject(tx.error ?? new Error('Transaction failed')); } };
    tx.onabort = () => { if (!settled) { settled = true; reject(tx.error ?? new Error('Transaction aborted')); } };

    Promise.resolve(work(tx))
      .then((value) => { result = value; })
      .catch((error) => {
        settled = true;
        try { tx.abort(); } catch { /* already finished */ }
        reject(error);
      });
  });
}

/** A typed handle on one object store. */
export class Collection<T extends { id: string }> {
  constructor(private db: IDBDatabase, private storeName: string) {}

  all(): Promise<T[]> {
    return transact(this.db, this.storeName, 'readonly', (tx) =>
      wrap<T[]>(tx.objectStore(this.storeName).getAll() as IDBRequest<T[]>),
    );
  }

  async get(id: string): Promise<T | undefined> {
    return transact(this.db, this.storeName, 'readonly', (tx) =>
      wrap<T | undefined>(tx.objectStore(this.storeName).get(id) as IDBRequest<T | undefined>),
    );
  }

  put(record: T): Promise<T> {
    return transact(this.db, this.storeName, 'readwrite', async (tx) => {
      await wrap(tx.objectStore(this.storeName).put(record));
      return record;
    });
  }

  putMany(records: T[]): Promise<number> {
    return transact(this.db, this.storeName, 'readwrite', async (tx) => {
      const store = tx.objectStore(this.storeName);
      for (const record of records) await wrap(store.put(record));
      return records.length;
    });
  }

  delete(id: string): Promise<void> {
    return transact(this.db, this.storeName, 'readwrite', async (tx) => {
      await wrap(tx.objectStore(this.storeName).delete(id));
    });
  }

  deleteMany(ids: string[]): Promise<number> {
    return transact(this.db, this.storeName, 'readwrite', async (tx) => {
      const store = tx.objectStore(this.storeName);
      for (const id of ids) await wrap(store.delete(id));
      return ids.length;
    });
  }

  clear(): Promise<void> {
    return transact(this.db, this.storeName, 'readwrite', async (tx) => {
      await wrap(tx.objectStore(this.storeName).clear());
    });
  }

  count(): Promise<number> {
    return transact(this.db, this.storeName, 'readonly', (tx) =>
      wrap<number>(tx.objectStore(this.storeName).count()),
    );
  }

  /** Replace the entire contents of the store in one transaction. */
  replaceAll(records: T[]): Promise<number> {
    return transact(this.db, this.storeName, 'readwrite', async (tx) => {
      const store = tx.objectStore(this.storeName);
      await wrap(store.clear());
      for (const record of records) await wrap(store.put(record));
      return records.length;
    });
  }
}

/** True when the browser can actually persist. Private modes sometimes cannot. */
export async function storageAvailable(): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return false;
  try {
    const db = await openDatabase('__alexmerced_probe__', 1, [{ name: 'probe' }]);
    db.close();
    indexedDB.deleteDatabase('__alexmerced_probe__');
    return true;
  } catch {
    return false;
  }
}
