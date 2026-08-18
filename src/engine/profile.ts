/**
 * Time-of-day conditional baselines.
 *
 * Volume at 9:35 is ~10x volume at 13:00 for essentially every stock, so an
 * unconditional baseline just re-discovers "the market is open" every morning.
 * Expected volume is factored as
 *
 *   E[v_i(t)] = adv_i(per-second) * shape(bucket(t)) * mult_i(bucket(t))
 *
 * where `shape` is the market-wide intraday U (analytic seed, then learned),
 * `adv_i` is a slow per-ticker EWMA of per-second volume, and `mult_i` is a
 * per-ticker multiplicative residual learned across days. Factoring this way
 * means a brand-new ticker inherits a sane curve immediately instead of
 * needing 20 sessions of history before it ranks correctly.
 */

/** minutes since 09:30 ET, one bucket per 5 minutes, 08:00-20:00 covered */
export const BUCKET_MIN = 5;
export const BUCKET_COUNT = (12 * 60) / BUCKET_MIN; // 08:00 -> 20:00 ET
const DAY_START_MIN = 8 * 60;

/** Bucket index for an epoch-ms timestamp, using US/Eastern wall clock. */
export function bucketOf(t: number): number {
  const et = etMinutes(t);
  const b = Math.floor((et - DAY_START_MIN) / BUCKET_MIN);
  return Math.min(BUCKET_COUNT - 1, Math.max(0, b));
}

let fmt: Intl.DateTimeFormat | null = null;
/** Minutes past midnight in US/Eastern. Handles DST via Intl, no tz table. */
export function etMinutes(t: number): number {
  fmt ??= new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(t));
  let h = 0;
  let m = 0;
  for (const p of parts) {
    if (p.type === 'hour') h = Number(p.value) % 24;
    else if (p.type === 'minute') m = Number(p.value);
  }
  return h * 60 + m;
}

/**
 * Analytic seed for the intraday volume shape: a U with an open spike, a
 * midday trough, and a closing-auction ramp, normalized to mean 1 over the
 * regular session. Pre/post buckets get a small constant.
 */
export function seedShape(): Float64Array {
  const s = new Float64Array(BUCKET_COUNT);
  for (let b = 0; b < BUCKET_COUNT; b++) {
    const minute = DAY_START_MIN + b * BUCKET_MIN; // ET minutes
    if (minute < 9 * 60 + 30 || minute >= 16 * 60) {
      s[b] = 0.04; // extended hours
      continue;
    }
    const x = (minute - (9 * 60 + 30)) / 390; // 0..1 through the session
    const open = 3.2 * Math.exp(-x / 0.06);
    const close = 1.9 * Math.exp(-(1 - x) / 0.07);
    s[b] = 0.55 + open + close;
  }
  // normalize over regular session buckets
  let sum = 0;
  let n = 0;
  for (let b = 0; b < BUCKET_COUNT; b++) {
    const minute = DAY_START_MIN + b * BUCKET_MIN;
    if (minute >= 9 * 60 + 30 && minute < 16 * 60) {
      sum += s[b];
      n++;
    }
  }
  const mean = sum / n;
  for (let b = 0; b < BUCKET_COUNT; b++) s[b] /= mean;
  return s;
}

/** Learning rate for the per-ticker residual, ~ 1/20 sessions worth of buckets. */
const MULT_ALPHA = 0.02;
const SHAPE_ALPHA = 0.002;

export class ProfileStore {
  readonly shape = seedShape();
  private mult = new Map<string, Float32Array>();

  /** Multiplicative baseline factor for a ticker at time `t`. */
  factor(sym: string, bucket: number): number {
    const m = this.mult.get(sym);
    return this.shape[bucket] * (m ? m[bucket] : 1);
  }

  /**
   * Learn from an observation: `ratio` is observed / (adv * factor). Values
   * persistently above 1 in a bucket mean this ticker is systematically busier
   * then than the market shape predicts (e.g. it trades the open harder).
   */
  observe(sym: string, bucket: number, ratio: number): void {
    if (!Number.isFinite(ratio) || ratio <= 0) return;
    const clipped = Math.min(4, Math.max(0.25, ratio));
    let m = this.mult.get(sym);
    if (!m) {
      m = new Float32Array(BUCKET_COUNT).fill(1);
      this.mult.set(sym, m);
    }
    m[bucket] = (1 - MULT_ALPHA) * m[bucket] + MULT_ALPHA * clipped;
  }

  /**
   * Nudge the market-wide shape toward the cross-sectional median residual.
   * Called once per bucket with the median of `ratio` across all tickers, so
   * half days and holiday sessions do not read as market-wide "interest".
   * Deliberately separate from `observe` — folding per-ticker residuals into
   * the shared shape would double-count them.
   */
  observeMarket(bucket: number, medianRatio: number): void {
    if (!Number.isFinite(medianRatio) || medianRatio <= 0) return;
    const clipped = Math.min(3, Math.max(0.33, medianRatio));
    this.shape[bucket] = (1 - SHAPE_ALPHA) * this.shape[bucket] + SHAPE_ALPHA * this.shape[bucket] * clipped;
  }

  /** Serializable form for IndexedDB persistence across sessions. */
  dump(): { shape: number[]; mult: Record<string, number[]> } {
    const mult: Record<string, number[]> = {};
    for (const [k, v] of this.mult) mult[k] = Array.from(v);
    return { shape: Array.from(this.shape), mult };
  }

  load(data: { shape: number[]; mult: Record<string, number[]> }): void {
    if (data.shape?.length === BUCKET_COUNT) this.shape.set(data.shape);
    for (const [k, v] of Object.entries(data.mult ?? {})) {
      if (v.length === BUCKET_COUNT) this.mult.set(k, Float32Array.from(v));
    }
  }
}
