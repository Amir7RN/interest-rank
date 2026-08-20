/**
 * Per-ticker price history, at two resolutions.
 *
 * The board wants "change over the last 3 seconds" and "change over the last
 * hour" from the same structure, and those have very different storage costs at
 * one sample per second. Keeping an hour at full resolution would be 3,600
 * floats per ticker; keeping four hours would be 14,400, and at a few thousand
 * tickers that is hundreds of megabytes for data nobody reads at that
 * precision.
 *
 * So: one second of resolution for the recent past, one minute for the longer
 * past. A 3-second change needs exact samples and gets them; a 3-hour change
 * does not care about the second it lands on.
 *
 * `changeOver` returns null rather than a number when the history does not
 * reach back far enough. That distinction matters — a board that has been open
 * for two minutes cannot know an hourly change, and reporting 0% or the
 * since-start move would be inventing one.
 */

/** Seconds of 1-second-resolution history. */
export const FAST_SPAN_SEC = 300;
/**
 * Seconds between mid-resolution samples, and how many are kept.
 *
 * 15 seconds is deliberate: it matches the coarsest native bar interval any
 * feed here delivers. Feeds that split coarse bars into 1-second slices
 * interpolate the path between them, so a regime statistic fitted to the fine
 * ring would measure the interpolation and report near-perfect trending on
 * every ticker. Sampling at the native interval avoids inventing that structure.
 */
export const MID_STEP_SEC = 15;
export const MID_CAP = 240; // one hour
/** Seconds between coarse samples. */
export const SLOW_STEP_SEC = 60;
/** Number of coarse samples kept — 240 minutes = 4 hours. */
export const SLOW_CAP = 240;
/** Longest lookback this structure can answer from the live tape. */
export const TAPE_MAX_SEC = SLOW_STEP_SEC * SLOW_CAP;

/** Fixed-capacity ring of numbers, addressed by how far back you want to look. */
class Ring {
  private buf: Float64Array;
  private pushes = 0;

  constructor(capacity: number) {
    this.buf = new Float64Array(capacity);
  }

  push(value: number): void {
    this.buf[this.pushes % this.buf.length] = value;
    this.pushes++;
  }

  /** The value `back` samples ago (0 is the newest), or null if not retained. */
  at(back: number): number | null {
    const held = Math.min(this.pushes, this.buf.length);
    if (back < 0 || back >= held) return null;
    const idx = (this.pushes - 1 - back) % this.buf.length;
    return this.buf[idx];
  }

  /** How many samples are currently retained. */
  get held(): number {
    return Math.min(this.pushes, this.buf.length);
  }

  /** Retained samples, oldest first. */
  toArray(): Float64Array {
    const held = this.held;
    const out = new Float64Array(held);
    for (let i = 0; i < held; i++) out[i] = this.at(held - 1 - i) as number;
    return out;
  }
}

export class PriceHistory {
  private fast = new Ring(FAST_SPAN_SEC);
  private mid = new Ring(MID_CAP);
  private slow = new Ring(SLOW_CAP);
  private steps = 0;

  /** Record one price. Call once per engine step (nominally 1 Hz). */
  push(price: number): void {
    if (!(price > 0)) return;
    this.fast.push(price);
    if (this.steps % MID_STEP_SEC === 0) this.mid.push(price);
    // The first step seeds the coarse ring too, so a lookback slightly longer
    // than the fine ring has something to compare against immediately.
    if (this.steps % SLOW_STEP_SEC === 0) this.slow.push(price);
    this.steps++;
  }

  /**
   * Prices at the native bar interval, oldest first — the series regime
   * statistics must be fitted to. See `MID_STEP_SEC` for why not the fine ring.
   */
  midSeries(): Float64Array {
    return this.mid.toArray();
  }

  /** Mid-resolution samples held, for "still collecting" reporting. */
  get midCount(): number {
    return this.mid.held;
  }

  /** Latest recorded price, or null before anything has been recorded. */
  get last(): number | null {
    return this.fast.at(0);
  }

  /**
   * Fractional change over `seconds`, or null when history does not reach that
   * far back. Lookbacks within the fine window are exact; longer ones snap to
   * the nearest minute.
   */
  changeOver(seconds: number): number | null {
    const now = this.fast.at(0);
    if (now === null || now <= 0) return null;

    const then =
      seconds <= FAST_SPAN_SEC
        ? this.fast.at(Math.round(seconds))
        : this.slow.at(Math.round(seconds / SLOW_STEP_SEC));

    if (then === null || then <= 0) return null;
    return now / then - 1;
  }

  /** Seconds of history actually retained, for "still filling" reporting. */
  get spanSec(): number {
    const coarse = this.slow.held > 1 ? (this.slow.held - 1) * SLOW_STEP_SEC : 0;
    return Math.max(this.fast.held > 0 ? this.fast.held - 1 : 0, coarse);
  }
}
