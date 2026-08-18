/** Shared types across main thread, worker, and feeds. */

/** One-second aggregate bar for a single ticker. The engine's only input unit. */
export interface Bar {
  sym: string;
  /** epoch ms of bar end */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** share volume in the bar */
  v: number;
  /** trade count in the bar (estimate is fine) */
  n: number;
  /** quote/NBBO update count in the bar, 0 if the feed has no quotes */
  q: number;
}

export type SignalKey = 'rvol' | 'ret' | 'trades' | 'quotes' | 'range';

export const SIGNAL_KEYS: SignalKey[] = ['rvol', 'ret', 'trades', 'quotes', 'range'];

export const SIGNAL_LABEL: Record<SignalKey, string> = {
  rvol: 'Rel. volume',
  ret: 'Return z',
  trades: 'Trade surge',
  quotes: 'Quote churn',
  range: 'Range exp.',
};

export type Weights = Record<SignalKey, number>;

export interface EngineConfig {
  /** EWMA time constants, seconds */
  tauFast: number; // surge window
  tauSlow: number; // per-ticker baseline
  tauSmooth: number; // score smoothing
  /** rolling window length in seconds for mean/median stats */
  windowSec: number;
  topN: number;
  /** hysteresis: enter top list above this percentile-composite, leave below */
  thetaIn: number;
  thetaOut: number;
  /** rank hysteresis: incumbents keep their seat until they fall past this rank */
  rankExit: number;
  weights: Weights;
  /** liquidity floors — keeps $2 pump-and-dumps out of the top of the book */
  minPrice: number;
  minAdv: number;
  /** predictive horizon in seconds for the ensemble forecast */
  horizonSec: number;
}

export const DEFAULT_CONFIG: EngineConfig = {
  tauFast: 30,
  tauSlow: 900,
  tauSmooth: 15,
  windowSec: 60,
  topN: 20,
  thetaIn: 0.72,
  thetaOut: 0.6,
  rankExit: 35,
  weights: { rvol: 0.3, ret: 0.25, trades: 0.2, quotes: 0.1, range: 0.15 },
  minPrice: 5,
  minAdv: 500_000,
  horizonSec: 30,
};

export type Prediction = 'UP' | 'HOLD' | 'DOWN';

/** One row of the published ranking. */
export interface RankRow {
  sym: string;
  rank: number;
  /** previous rank, or null when the ticker just entered the list */
  prevRank: number | null;
  price: number;
  /** session return, fraction */
  chg: number;
  /** smoothed composite score, 0..1 */
  score: number;
  /** raw (unsmoothed) composite */
  raw: number;
  mean: number;
  median: number;
  /** median absolute deviation of the score over the window */
  mad: number;
  rvol: number;
  /** per-signal percentile ranks, for the detail row */
  parts: Record<SignalKey, number>;
  /** fraction of ensemble members that place this ticker in the top-N, 0..1 */
  robust: number;
  /** ensemble majority forecast of rank direction over horizonSec */
  pred: Prediction;
  /** fraction of ensemble members voting for `pred`, 0..1 */
  predConf: number;
  /** score trend, units of score per second */
  slope: number;
  /** recent smoothed score history for the sparkline, oldest first */
  spark: number[];
  /** true while the row is held by hysteresis rather than by raw score */
  held: boolean;
}

export interface Snapshot {
  t: number;
  rows: RankRow[];
  stats: {
    universe: number;
    active: number;
    barsPerSec: number;
    msgsPerSec: number;
    computeMs: number;
    /** rank churn: mean |Δrank| across the published list */
    churn: number;
    /** tickers receiving data but still filling their baselines */
    warming: number;
    /** warmed-up tickers excluded by the liquidity floors */
    filtered: number;
    /** baseline samples a ticker needs before it can rank */
    warmupNeeded: number;
  };
}

/* ---- worker protocol ---- */

export type ToWorker =
  | { type: 'config'; config: EngineConfig }
  | { type: 'bars'; bars: Bar[] }
  | { type: 'reset' };

export type FromWorker =
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'ready' };
