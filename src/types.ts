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

/** A lookback the board can rank by. */
export interface Horizon {
  id: string;
  label: string;
  seconds: number;
}

/**
 * Sort horizons, shortest first.
 *
 * Everything up to 3h is answered from the live tape this session has actually
 * seen. A day or more cannot be — the page has not been open that long — so
 * those are filled from daily closes fetched through the bridge, and read as
 * null until they arrive. See `PriceHistory` and the bridge's `/dailies`.
 */
export const HORIZONS: Horizon[] = [
  { id: '3s', label: '3 seconds', seconds: 3 },
  { id: '10s', label: '10 seconds', seconds: 10 },
  { id: '30s', label: '30 seconds', seconds: 30 },
  { id: '1m', label: '1 minute', seconds: 60 },
  { id: '5m', label: '5 minutes', seconds: 300 },
  { id: '10m', label: '10 minutes', seconds: 600 },
  { id: '30m', label: '30 minutes', seconds: 1800 },
  { id: '1h', label: '1 hour', seconds: 3600 },
  { id: '3h', label: '3 hours', seconds: 10800 },
  { id: '1d', label: '1 day', seconds: 86_400 },
  { id: '1w', label: '1 week', seconds: 604_800 },
  { id: '1mo', label: '1 month', seconds: 2_592_000 },
];

export function horizonById(id: string): Horizon {
  return HORIZONS.find((h) => h.id === id) ?? HORIZONS[3];
}

/** How the published list is ordered. */
export type SortBy = 'score' | 'change' | 'absChange';

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
  /** what the published ordering is sorted by */
  sortBy: SortBy;
  /** id from HORIZONS — the lookback the change columns and change sorts use */
  sortHorizon: string;
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
  sortBy: 'score',
  sortHorizon: '1m',
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
  /**
   * Change over the selected sort horizon, or null when it cannot be known
   * yet — the tape has not run that long, or the daily closes have not
   * arrived. Null is displayed, never silently rendered as 0%.
   */
  chgSel: number | null;
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
  /** long-horizon changes by symbol, keyed by horizon id — sourced off-tape */
  | { type: 'longChanges'; horizon: string; changes: Record<string, number> }
  | { type: 'reset' };

export type FromWorker =
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'ready' };
