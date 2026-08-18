/**
 * Fixed-capacity ring buffer of floats with O(1) push and an incremental sum,
 * plus on-demand median / MAD / robust slope.
 *
 * Median is O(k log k) in the window length, so the engine only asks for it on
 * the shortlist (a few hundred tickers), never on the whole universe.
 */
export class RollingWindow {
  private buf: Float64Array;
  private head = 0;
  private len = 0;
  private sum = 0;
  private scratch: Float64Array;

  capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.buf = new Float64Array(capacity);
    this.scratch = new Float64Array(capacity);
  }

  push(x: number): void {
    if (!Number.isFinite(x)) return;
    if (this.len === this.capacity) {
      this.sum -= this.buf[this.head];
      this.buf[this.head] = x;
      this.head = (this.head + 1) % this.capacity;
    } else {
      this.buf[(this.head + this.len) % this.capacity] = x;
      this.len++;
    }
    this.sum += x;
  }

  get size(): number {
    return this.len;
  }

  get mean(): number {
    return this.len ? this.sum / this.len : 0;
  }

  /** Newest value, or 0 when empty. */
  get last(): number {
    return this.len ? this.buf[(this.head + this.len - 1) % this.capacity] : 0;
  }

  /** Copy contents oldest-first into `out` (allocated if absent). */
  toArray(out?: Float64Array): Float64Array {
    const dst = out && out.length >= this.len ? out : new Float64Array(this.len);
    for (let i = 0; i < this.len; i++) dst[i] = this.buf[(this.head + i) % this.capacity];
    return dst;
  }

  /** Evenly spaced sample of at most `n` points, oldest first. For sparklines. */
  sample(n: number): number[] {
    if (this.len === 0) return [];
    const step = Math.max(1, Math.floor(this.len / n));
    const out: number[] = [];
    for (let i = this.len - 1; i >= 0; i -= step) out.push(this.buf[(this.head + i) % this.capacity]);
    return out.reverse();
  }

  median(): number {
    if (this.len === 0) return 0;
    const a = this.sortedCopy();
    return quantileSorted(a, this.len, 0.5);
  }

  quantile(p: number): number {
    if (this.len === 0) return 0;
    return quantileSorted(this.sortedCopy(), this.len, p);
  }

  /**
   * Median absolute deviation, scaled to be a consistent estimator of sigma
   * for Gaussian data (x1.4826). Robust dispersion — a single 40-sigma tick
   * does not move it, which is exactly the property we want for stability.
   */
  mad(): number {
    if (this.len < 3) return 0;
    const a = this.sortedCopy();
    const med = quantileSorted(a, this.len, 0.5);
    for (let i = 0; i < this.len; i++) a[i] = Math.abs(a[i] - med);
    a.subarray(0, this.len).sort();
    return 1.4826 * quantileSorted(a, this.len, 0.5);
  }

  /**
   * Robust trend, units per sample: median of pairwise slopes against a
   * lagged copy (a cheap Theil-Sen variant, O(k) instead of O(k^2)).
   */
  slopePerSample(lag = 5): number {
    if (this.len <= lag + 2) return 0;
    const m = this.len - lag;
    const s = this.scratch;
    for (let i = 0; i < m; i++) {
      const a = this.buf[(this.head + i) % this.capacity];
      const b = this.buf[(this.head + i + lag) % this.capacity];
      s[i] = (b - a) / lag;
    }
    s.subarray(0, m).sort();
    return quantileSorted(s, m, 0.5);
  }

  private sortedCopy(): Float64Array {
    const s = this.scratch;
    for (let i = 0; i < this.len; i++) s[i] = this.buf[(this.head + i) % this.capacity];
    s.subarray(0, this.len).sort();
    return s;
  }

  resize(capacity: number): void {
    if (capacity === this.capacity) return;
    const old = this.toArray();
    this.buf = new Float64Array(capacity);
    this.scratch = new Float64Array(capacity);
    this.capacity = capacity;
    this.head = 0;
    this.len = 0;
    this.sum = 0;
    const start = Math.max(0, old.length - capacity);
    for (let i = start; i < old.length; i++) this.push(old[i]);
  }
}

/** Linear-interpolated quantile of the first `n` entries of a sorted array. */
export function quantileSorted(sorted: ArrayLike<number>, n: number, p: number): number {
  if (n === 0) return 0;
  if (n === 1) return sorted[0];
  const idx = (n - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
