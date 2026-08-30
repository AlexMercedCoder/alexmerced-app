/**
 * A seeded pseudorandom generator.
 *
 * Reproducibility is the point: the same seed has to give the same rows every
 * time, or generated sample data is useless for a demo you want to repeat.
 */

/** Turns any string into a 32 bit seed. */
export function hashSeed(seed: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32: small, fast, and good enough for sample data. */
export class Rng {
  private state: number;

  constructor(seed: string | number = 'alexmerced') {
    this.state = (typeof seed === 'number' ? seed >>> 0 : hashSeed(seed)) || 1;
  }

  /** A float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** An integer in [min, max], inclusive at both ends. */
  int(min: number, max: number): number {
    if (max < min) return min;
    return min + Math.floor(this.next() * (max - min + 1));
  }

  float(min: number, max: number, decimals = 2): number {
    const value = min + this.next() * (max - min);
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
  }

  bool(trueChance = 0.5): boolean {
    return this.next() < trueChance;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }

  /** Picks without replacement, up to the size of the list. */
  sample<T>(items: readonly T[], count: number): T[] {
    const pool = [...items];
    const out: T[] = [];
    const wanted = Math.min(count, pool.length);
    for (let i = 0; i < wanted; i += 1) {
      out.push(pool.splice(Math.floor(this.next() * pool.length), 1)[0]);
    }
    return out;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.next() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  /** A date between two bounds, as an ISO string. */
  date(from: Date, to: Date): Date {
    return new Date(from.getTime() + this.next() * (to.getTime() - from.getTime()));
  }

  /** Weighted choice, for making generated data less uniformly flat. */
  weighted<T>(options: readonly { value: T; weight: number }[]): T {
    const total = options.reduce((sum, option) => sum + option.weight, 0);
    let roll = this.next() * total;
    for (const option of options) {
      roll -= option.weight;
      if (roll <= 0) return option.value;
    }
    return options[options.length - 1].value;
  }
}
