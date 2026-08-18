import type { Bar } from '../types.ts';
import type { Feed, FeedOptions, FeedStatus } from './types.ts';
import { synthUniverse } from './universe.ts';

/**
 * Synthetic tape. Not a toy: it reproduces the properties the ranking has to
 * survive — a 3-decade spread of typical volumes, a time-of-day shape, fat
 * tails, and sporadic "attention events" where one name's volume, trade count
 * and volatility jump together for 30-300 seconds. If the ranking works here
 * it will work on a real feed; the only thing the sim cannot test is vendor
 * latency.
 */
export class SimFeed implements Feed {
  readonly id = 'sim';
  readonly name = 'Simulator (no key)';
  readonly needsKey = false;

  private timer: number | null = null;
  private syms: string[];
  private price: Float64Array;
  private open: Float64Array;
  private advSec: Float64Array;
  private vol: Float64Array; // per-second sigma
  private event: Float64Array; // remaining seconds of an attention event
  private evMag: Float64Array;
  private rng: () => number;
  private msgs = 0;

  constructor(opts: FeedOptions) {
    const n = Math.max(50, opts.universe);
    this.syms = synthUniverse(n);
    this.rng = mulberry32(0xc0ffee);
    this.price = new Float64Array(n);
    this.open = new Float64Array(n);
    this.advSec = new Float64Array(n);
    this.vol = new Float64Array(n);
    this.event = new Float64Array(n);
    this.evMag = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      // log-uniform price 3..600 and per-second volume 5..8000 shares:
      // roughly the real dispersion across the tape
      this.price[i] = Math.exp(1.1 + this.rng() * 4.1);
      this.open[i] = this.price[i];
      this.advSec[i] = Math.exp(1.6 + this.rng() * 5.6);
      this.vol[i] = (0.4 + this.rng() * 2.2) * 1e-4;
    }
  }

  start(onBars: (bars: Bar[]) => void, onStatus: (s: FeedStatus) => void): void {
    onStatus({ state: 'live', detail: `${this.syms.length} synthetic symbols` });
    const tick = () => {
      const t = Date.now();
      const shape = intradayShape(t);
      const bars: Bar[] = [];
      for (let i = 0; i < this.syms.length; i++) {
        // start an attention event ~ once per 4000 symbol-seconds
        if (this.event[i] <= 0 && this.rng() < 0.00025) {
          this.event[i] = 30 + this.rng() * 270;
          this.evMag[i] = 3 + this.rng() * this.rng() * 60;
        }
        const inEvent = this.event[i] > 0;
        if (inEvent) this.event[i] -= 1;
        const mag = inEvent ? this.evMag[i] : 1;

        const sigma = this.vol[i] * Math.sqrt(shape) * (inEvent ? Math.sqrt(mag) : 1);
        const drift = inEvent ? (this.evMag[i] > 20 ? 1 : -1) * sigma * 0.6 : 0;
        const o = this.price[i];
        const r = drift + sigma * gauss(this.rng);
        const c = Math.max(0.5, o * (1 + r));
        const wick = Math.abs(sigma * gauss(this.rng)) * o;
        this.price[i] = c;

        const lambda = this.advSec[i] * shape * mag;
        const v = Math.max(0, Math.round(poisson(lambda, this.rng)));
        // trade count scales sublinearly with volume: bigger prints, not just more
        const trades = Math.max(0, Math.round(Math.pow(v, 0.72) * 0.25));
        const quotes = Math.round(trades * (3 + this.rng() * 6));
        bars.push({
          sym: this.syms[i],
          t,
          o,
          h: Math.max(o, c) + wick,
          l: Math.max(0.01, Math.min(o, c) - wick),
          c,
          v,
          n: trades,
          q: quotes,
        });
        this.msgs += trades;
      }
      onBars(bars);
      onStatus({ state: 'live', msgs: this.msgs });
      this.msgs = 0;
    };
    tick();
    this.timer = setInterval(tick, 1000) as unknown as number;
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Session open prices, so the sim can report a session change. */
  openOf(sym: string): number {
    const i = this.syms.indexOf(sym);
    return i < 0 ? 0 : this.open[i];
  }
}

/** U-shaped intraday activity multiplier, 0.05 outside regular hours. */
function intradayShape(t: number): number {
  const d = new Date(t);
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  // approximate ET as UTC-4/-5; the sim only needs the shape, not the exactness
  const et = (mins - 240 + 1440) % 1440;
  if (et < 570 || et >= 960) return 0.05;
  const x = (et - 570) / 390;
  return 0.55 + 3.2 * Math.exp(-x / 0.06) + 1.9 * Math.exp(-(1 - x) / 0.07);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rng: () => number): number {
  const u = Math.max(1e-12, rng());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** Poisson draw; normal approximation above 30 where it is indistinguishable. */
function poisson(lambda: number, rng: () => number): number {
  if (lambda > 30) return Math.max(0, lambda + Math.sqrt(lambda) * gauss(rng));
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng();
  } while (p > L);
  return k - 1;
}
