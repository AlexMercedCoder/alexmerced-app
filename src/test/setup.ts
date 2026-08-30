// Gives the Node test environment a working IndexedDB so the persistence
// layer can be exercised the same way it runs in a browser.
import 'fake-indexeddb/auto';

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() { return this.map.size; }
  clear() { this.map.clear(); }
  getItem(key: string) { return this.map.has(key) ? this.map.get(key)! : null; }
  key(index: number) { return [...this.map.keys()][index] ?? null; }
  removeItem(key: string) { this.map.delete(key); }
  setItem(key: string, value: string) { this.map.set(key, String(value)); }
}

if (typeof globalThis.localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', { value: new MemoryStorage(), writable: true });
}

/**
 * Neither Node nor jsdom carries ImageData, because both lack a canvas. The
 * real thing is a plain value object, so a faithful stand-in is a few lines and
 * lets the pixel code be tested without a browser.
 */
if (typeof globalThis.ImageData === 'undefined') {
  class MemoryImageData {
    readonly data: Uint8ClampedArray;
    readonly width: number;
    readonly height: number;
    readonly colorSpace = 'srgb';

    constructor(first: number | Uint8ClampedArray, second: number, third?: number) {
      if (typeof first === 'number') {
        this.width = first;
        this.height = second;
        this.data = new Uint8ClampedArray(first * second * 4);
      } else {
        this.data = first;
        this.width = second;
        this.height = third ?? first.length / 4 / second;
      }
      if (!Number.isInteger(this.width) || !Number.isInteger(this.height) || this.width < 1 || this.height < 1) {
        throw new RangeError('ImageData needs positive whole dimensions.');
      }
    }
  }
  Object.defineProperty(globalThis, 'ImageData', { value: MemoryImageData, writable: true });
}
