/**
 * Interface preferences live in localStorage: which view was open, whether the
 * sidebar was collapsed, the last board looked at. Small, synchronous, and
 * cheap to lose. Actual content lives in IndexedDB.
 */
const memory = new Map<string, string>();

function backing(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  try {
    if (typeof localStorage !== 'undefined') {
      const probe = '__probe__';
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
      return localStorage;
    }
  } catch {
    /* private mode, or storage disabled */
  }
  return {
    getItem: (key: string) => (memory.has(key) ? memory.get(key)! : null),
    setItem: (key: string, value: string) => { memory.set(key, value); },
    removeItem: (key: string) => { memory.delete(key); },
  };
}

export function readPref<T>(key: string, fallback: T): T {
  try {
    const raw = backing().getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writePref<T>(key: string, value: T): void {
  try {
    backing().setItem(key, JSON.stringify(value));
  } catch {
    /* quota exceeded, or storage disabled. Preferences are not worth throwing over. */
  }
}

export function clearPref(key: string): void {
  try { backing().removeItem(key); } catch { /* nothing to do */ }
}
