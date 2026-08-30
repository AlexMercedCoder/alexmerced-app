/**
 * Base64 for binary payloads that have to travel inside a JSON export.
 *
 * The obvious `String.fromCharCode(...bytes)` blows the argument limit on
 * anything larger than a few hundred kilobytes, so both directions work in
 * chunks.
 */

const CHUNK = 0x8000;

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Rough size of the base64 form, for warning before a large export. */
export function base64Size(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4;
}

export function formatBytes(count: number): string {
  if (count < 1024) return `${count} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = count / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
