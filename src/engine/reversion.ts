/**
 * Regime and displacement statistics — "does this name revert, and is it
 * stretched right now?"
 *
 * These are two separate questions and conflating them is the usual way a
 * screen like this goes wrong:
 *
 *   1. **Regime.** Over the recent past, do this ticker's returns mean-revert,
 *      trend, or look like a random walk? Answered by a variance ratio, which
 *      is the robust cousin of the autocorrelation this module was asked for.
 *   2. **Displacement.** Where is the price *now* relative to its own trailing
 *      mean, in units of its own noise?
 *
 * Displacement alone is not a signal. A name far below its mean is a bargain if
 * it reverts and a falling knife if it trends, and those are the same number.
 * Only the pair means anything, which is why nothing here reports one without
 * the other.
 *
 * ## What the variance ratio does
 *
 * For a random walk, the variance of a q-period return is exactly q times the
 * variance of a 1-period return. So
 *
 *     VR(q) = Var[x_t - x_{t-q}] / (q * Var[x_t - x_{t-1}])
 *
 * is 1 under a random walk, below 1 when moves get partly taken back
 * (reversion), and above 1 when moves extend (trending). Lo & MacKinlay (1988)
 * give its distribution under the random-walk null, so "is this distinguishable
 * from noise" has an actual answer rather than a vibe.
 *
 * ## What this cannot do
 *
 * It describes the window it was given. It does not forecast. Equity returns
 * have autocorrelation close to zero at almost every horizon — that is one of
 * the most replicated results in finance — so the honest expectation is that
 * most names, most of the time, come back `random`, and that is a finding
 * rather than a failure of the estimator.
 */

export type Regime = 'reverting' | 'trending' | 'random';

export interface RegimeOptions {
  /** aggregation lag for the variance ratio, in bars */
  q?: number;
  /** span of the causal EMA that defines "the mean", in bars */
  emaSpan?: number;
  /** minimum bars required before anything is reported */
  minSamples?: number;
  /** |z| beyond which the regime is called rather than left as random */
  regimeZ?: number;
  /** seconds per bar, carried through so half-lives can be reported in time */
  barSec?: number;
}

export interface RegimeFit {
  /** price observations used */
  n: number;
  /** seconds per observation */
  barSec: number;
  /** variance ratio: <1 reverting, >1 trending, 1 random walk */
  vr: number;
  /** Lo-MacKinlay statistic, standard normal under the random-walk null */
  vrZ: number;
  /** AR(1) coefficient of deviations from the trailing mean */
  rho: number;
  /** bars for a deviation to decay by half; null when it does not decay */
  halfLifeBars: number | null;
  /** latest trailing mean of log price */
  meanLog: number;
  /** standard deviation of deviations from that mean, in log units */
  sdDev: number;
  regime: Regime;
}

export interface Displacement {
  /** deviation from the trailing mean, in log units (~fractional) */
  dev: number;
  /** the same, in units of this ticker's own deviation noise */
  z: number;
}

export interface Edge {
  /** signed fractional move expected if the deviation halves, toward the mean */
  expectedMove: number;
  /** that move's size less assumed round-trip cost; <= 0 means no edge */
  netEdge: number;
  /** which way the reversion would go */
  direction: 'up' | 'down' | 'flat';
}

const DEFAULTS: Required<RegimeOptions> = {
  q: 5,
  emaSpan: 20,
  minSamples: 40,
  regimeZ: 2,
  barSec: 15,
};

/**
 * Fit the regime over a series of prices, oldest first.
 *
 * The series must be sampled at or coarser than the feed's native bar interval.
 * Feeds that split coarse bars into finer slices interpolate the path between
 * them, and an autocorrelation fitted to interpolated points measures the
 * interpolation — it will report near-perfect trending on every ticker.
 *
 * Returns null when there is not enough history, rather than a fit built on
 * five points.
 */
export function fitRegime(prices: ArrayLike<number>, options: RegimeOptions = {}): RegimeFit | null {
  const opt = { ...DEFAULTS, ...options };
  const { q, emaSpan, minSamples, regimeZ, barSec } = opt;

  const x: number[] = [];
  for (let i = 0; i < prices.length; i++) {
    const p = prices[i];
    if (p > 0 && Number.isFinite(p)) x.push(Math.log(p));
  }
  const T = x.length;
  if (T < minSamples || q < 2) return null;

  const nR = T - 1; // number of one-bar returns
  // Overlapping q-period returns need room to overlap; too few and the variance
  // ratio is dominated by which points happen to land in the window.
  if (nR < q * 4) return null;

  /* ---- variance ratio ---- */
  const mu = (x[T - 1] - x[0]) / nR;

  let sum1 = 0;
  for (let t = 1; t < T; t++) {
    const e = x[t] - x[t - 1] - mu;
    sum1 += e * e;
  }
  const var1 = sum1 / (nR - 1);
  if (!(var1 > 0)) return null; // a flat line has no regime

  let sumq = 0;
  for (let t = q; t <= nR; t++) {
    const e = x[t] - x[t - q] - q * mu;
    sumq += e * e;
  }
  // Lo-MacKinlay's unbiased denominator for overlapping windows. Note the
  // leading q: this already scales the q-period variance down to a per-period
  // one, so the ratio below must NOT divide by q a second time.
  const m = q * (nR - q + 1) * (1 - q / nR);
  if (!(m > 0)) return null;
  const varq = sumq / m;

  const vr = varq / var1;
  // Lo-MacKinlay: sqrt(N)(VR - 1) -> N(0, 2(2q-1)(q-1)/(3q)), where N is the
  // number of one-period returns in the sample. Scaling by sqrt(N*q) instead
  // inflates the statistic by sqrt(q) and turns roughly a third of ordinary
  // random walks into confident "regimes" — the random-walk test below is what
  // pins this down.
  const variance = (2 * (2 * q - 1) * (q - 1)) / (3 * q);
  const vrZ = (Math.sqrt(nR) * (vr - 1)) / Math.sqrt(variance);

  /* ---- deviations from a causal trailing mean ---- */
  const alpha = 2 / (emaSpan + 1);
  let ema = x[0];
  const devs: number[] = [];
  for (let i = 1; i < T; i++) {
    // Deviation is measured against the mean as it stood *before* this
    // observation, so nothing here peeks at its own value.
    devs.push(x[i] - ema);
    ema = alpha * x[i] + (1 - alpha) * ema;
  }

  let num = 0;
  let den = 0;
  let sqSum = 0;
  for (let i = 1; i < devs.length; i++) {
    num += devs[i] * devs[i - 1];
    den += devs[i - 1] * devs[i - 1];
  }
  for (const d of devs) sqSum += d * d;

  const rho = den > 0 ? num / den : 0;
  const sdDev = Math.sqrt(sqSum / Math.max(1, devs.length));
  // A deviation decays by half in -ln2/ln(rho) bars, but only when it decays at
  // all: rho >= 1 is a deviation that persists or grows, which has no half-life.
  const halfLifeBars = rho > 0 && rho < 1 ? -Math.LN2 / Math.log(rho) : null;

  const regime: Regime = vrZ < -regimeZ ? 'reverting' : vrZ > regimeZ ? 'trending' : 'random';

  return { n: T, barSec, vr, vrZ, rho, halfLifeBars, meanLog: ema, sdDev, regime };
}

/** Where the current price sits relative to the fitted trailing mean. */
export function displacement(price: number, fit: RegimeFit): Displacement | null {
  if (!(price > 0) || !Number.isFinite(price)) return null;
  const dev = Math.log(price) - fit.meanLog;
  const z = fit.sdDev > 0 ? dev / fit.sdDev : 0;
  return { dev, z };
}

/**
 * What a reversion would be worth, net of costs.
 *
 * Assumes the deviation decays by half over one half-life — the definition of
 * the half-life, not an extra forecast. `costFraction` is the round-trip cost
 * as a fraction (10 bps = 0.001); it is subtracted because a signal that does
 * not clear the spread is not a trade, and this is the term most screens omit.
 */
export function edge(dev: number, costFraction: number): Edge {
  const expectedMove = -0.5 * dev;
  const netEdge = Math.abs(expectedMove) - Math.max(0, costFraction);
  const direction = expectedMove > 0 ? 'up' : expectedMove < 0 ? 'down' : 'flat';
  return { expectedMove, netEdge, direction };
}

/**
 * Expected number of regime labels a pure-noise universe would produce at this
 * threshold.
 *
 * Screen 80 names at |z| > 2 and roughly four come back labelled even if every
 * one is a random walk. The top of any such list is selected on noise, so the
 * count is displayed next to it rather than left for the reader to derive.
 */
export function expectedFalseLabels(universe: number, regimeZ: number): number {
  return universe * 2 * (1 - normalCdf(regimeZ));
}

/** Standard normal CDF, Abramowitz & Stegun 7.1.26 — plenty for a false-positive count. */
export function normalCdf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const a = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * a);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-a * a);
  return 0.5 * (1 + sign * y);
}
