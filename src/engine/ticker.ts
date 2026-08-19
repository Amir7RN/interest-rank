import { Ewma } from './ewma.ts';
import { PriceHistory } from './pricehistory.ts';
import { RollingWindow } from './window.ts';
import { SIGNAL_KEYS, type SignalKey } from '../types.ts';

/** Per-ticker state. One of these per symbol, ~1 KB, so 8k symbols fits RAM easily. */
export class TickerState {
  price = 0;
  prevPrice = 0;
  sessionOpen = 0;
  lastBarT = 0;
  /** consecutive engine steps with no bar */
  stale = 0;

  /** per-second volume with the intraday shape divided out -> "ADV per second" */
  advPerSec: Ewma;
  tradesPerSec: Ewma;
  quotesPerSec: Ewma;
  /** average true range as a fraction of price, per second */
  atr: Ewma;

  /** within-ticker baselines for each raw signal, long tau */
  base: Record<SignalKey, Ewma>;
  /** short-tau smoothing of each within-ticker z, the "surge" view */
  fast: Record<SignalKey, Ewma>;
  /** latest cross-sectional percentile per signal (filled by the engine) */
  parts: Record<SignalKey, number> = { rvol: 0, ret: 0, trades: 0, quotes: 0, range: 0 };

  raw = 0;
  score = 0;
  /** latest observed volume / time-of-day expected volume */
  rvolNow = 0;
  scoreSmooth: Ewma;
  scoreSlow: Ewma;

  /** price at 1s/1min resolution, for the change-over-horizon sorts */
  readonly prices = new PriceHistory();

  /** allocated lazily, only for shortlisted tickers */
  win: RollingWindow | null = null;
  rawWin: RollingWindow | null = null;
  /** engine step at which this ticker last made the shortlist */
  lastShortlist = 0;

  readonly sym: string;

  constructor(
    sym: string,
    tauFast: number,
    tauSlow: number,
    tauSmooth: number,
  ) {
    this.sym = sym;
    this.advPerSec = new Ewma(tauSlow);
    this.tradesPerSec = new Ewma(tauSlow);
    this.quotesPerSec = new Ewma(tauSlow);
    this.atr = new Ewma(tauSlow);
    this.scoreSmooth = new Ewma(tauSmooth);
    this.scoreSlow = new Ewma(tauSmooth * 4);
    this.base = {} as Record<SignalKey, Ewma>;
    this.fast = {} as Record<SignalKey, Ewma>;
    for (const k of SIGNAL_KEYS) {
      this.base[k] = new Ewma(tauSlow);
      this.fast[k] = new Ewma(tauFast);
    }
  }

  retune(tauFast: number, tauSlow: number, tauSmooth: number): void {
    this.advPerSec.setTau(tauSlow);
    this.tradesPerSec.setTau(tauSlow);
    this.quotesPerSec.setTau(tauSlow);
    this.atr.setTau(tauSlow);
    this.scoreSmooth.setTau(tauSmooth);
    this.scoreSlow.setTau(tauSmooth * 4);
    for (const k of SIGNAL_KEYS) {
      this.base[k].setTau(tauSlow);
      this.fast[k].setTau(tauFast);
    }
  }

  ensureWindows(capacity: number): void {
    if (!this.win) {
      this.win = new RollingWindow(capacity);
      this.rawWin = new RollingWindow(capacity);
    } else if (this.win.capacity !== capacity) {
      this.win.resize(capacity);
      this.rawWin!.resize(capacity);
    }
  }

  dropWindows(): void {
    this.win = null;
    this.rawWin = null;
  }

  /** Approximate daily volume, for the liquidity floor. */
  get adv(): number {
    return this.advPerSec.mean * 23_400;
  }

  get chg(): number {
    return this.sessionOpen > 0 ? this.price / this.sessionOpen - 1 : 0;
  }
}
