import { percentileRank, topK } from './crosssection.ts';
import { MID_STEP_SEC, TAPE_MAX_SEC } from './pricehistory.ts';
import { displacement, edge, expectedFalseLabels, fitRegime } from './reversion.ts';
import { bucketOf, ProfileStore } from './profile.ts';
import { TickerState } from './ticker.ts';
import { predLabel, tally, type Member } from './vote.ts';
import {
  DEFAULT_CONFIG,
  horizonById,
  SIGNAL_KEYS,
  type Bar,
  type EngineConfig,
  type RankRow,
  type SignalKey,
  type SignalPanels,
  type SignalRow,
  type Snapshot,
} from '../types.ts';

/** Shortlist size: the pool the ensemble and the window stats actually run on. */
const SHORTLIST_MULT = 8;
const SHORTLIST_MIN = 150;
/** Steps a ticker may sit outside the shortlist before its windows are freed. */
const WINDOW_TTL = 600;
/** Steps without a bar before a ticker drops out of the cross-section. */
const STALE_LIMIT = 300;
/** Baseline samples required before a ticker is allowed to rank. */
const WARMUP = 20;
/**
 * Steps between regime refits.
 *
 * The series a regime is fitted to only gains a sample every MID_STEP_SEC, so
 * refitting faster than that is arithmetic on unchanged data. Displacement is
 * still recomputed every step against the current price — the regime is slow,
 * where the price sits inside it is not.
 */
const REGIME_REFIT_STEPS = MID_STEP_SEC;

export class Engine {
  cfg: EngineConfig = { ...DEFAULT_CONFIG, weights: { ...DEFAULT_CONFIG.weights } };
  readonly profile = new ProfileStore();

  private states: TickerState[] = [];
  private index = new Map<string, number>();
  private pending = new Map<number, Bar>();
  private published = new Map<string, number>();
  /** off-tape changes for horizons longer than the tape can reach, by horizon id */
  private longChanges = new Map<string, Map<string, number>>();
  private stepNo = 0;
  private barsSeen = 0;
  private lastRateT = 0;
  private barRate = 0;

  /** per-signal within-ticker z (smoothed), then overwritten with percentiles */
  private z: Record<SignalKey, Float64Array<ArrayBuffer>> = blankSignals(0);
  private pct: Record<SignalKey, Float64Array<ArrayBuffer>> = blankSignals(0);
  private raw = new Float64Array(0);
  private scoreArr = new Float64Array(0);
  private slowArr = new Float64Array(0);
  private meanArr = new Float64Array(0);
  private medianArr = new Float64Array(0);
  /** one trend estimate per ensemble member: each member sees the series it
   *  actually ranks on, so their forecasts can legitimately disagree */
  private slopeArr = new Float64Array(0); // fast/smoothed score
  private slopeRawArr = new Float64Array(0);
  private slopeSlowArr = new Float64Array(0);
  private slopeMeanArr = new Float64Array(0);
  private slopeMedArr = new Float64Array(0);
  /** change over the selected horizon; NaN where it is not yet knowable */
  private chgArr = new Float64Array(0);
  /** whatever the list is currently ordered by — score, or a change */
  private sortArr = new Float64Array(0);
  private active = new Int32Array(0);
  private order = new Int32Array(0);

  configure(cfg: EngineConfig): void {
    const retune =
      cfg.tauFast !== this.cfg.tauFast ||
      cfg.tauSlow !== this.cfg.tauSlow ||
      cfg.tauSmooth !== this.cfg.tauSmooth;
    this.cfg = cfg;
    if (retune) {
      for (const s of this.states) s.retune(cfg.tauFast, cfg.tauSlow, cfg.tauSmooth);
    }
  }

  reset(): void {
    this.states = [];
    this.index.clear();
    this.pending.clear();
    this.published.clear();
    this.stepNo = 0;
    // Long-horizon changes describe the market, not this run, so they survive a
    // feed restart — refetching them costs a round trip per ten symbols.
  }

  /**
   * Build the two displacement panels.
   *
   * A name is a candidate only when three things hold at once, and dropping any
   * one of them is how this kind of screen starts lying:
   *
   *   1. Its regime is `reverting` — a variance ratio distinguishable from a
   *      random walk on the reverting side. Stretched-and-trending is a falling
   *      knife, and looks identical on displacement alone.
   *   2. Its reversion can resolve inside the session. A half-life of six hours
   *      is a real statistic and a useless day trade.
   *   3. The expected move clears assumed costs. Most displacements do not, and
   *      a screen that hides this is selecting for names too small to trade.
   */
  private buildPanels(act: Int32Array, nActive: number): SignalPanels {
    const cfg = this.cfg;
    const costFraction = Math.max(0, cfg.costBps) / 10_000;
    const panels = emptyPanels(costFraction);
    const maxHalfLifeSec = Math.max(1, cfg.maxHalfLifeMin) * 60;

    for (let a = 0; a < nActive; a++) {
      const i = act[a];
      const s = this.states[i];

      if (s.regime === null || this.stepNo - s.regimeAt >= REGIME_REFIT_STEPS) {
        s.regime = fitRegime(s.prices.midSeries(), {
          barSec: MID_STEP_SEC,
          regimeZ: cfg.regimeZ,
        });
        s.regimeAt = this.stepNo;
      }
      const fit = s.regime;
      if (!fit) continue; // still collecting history
      panels.evaluated++;
      if (fit.regime !== 'reverting') continue;
      panels.reverting++;

      if (fit.halfLifeBars === null) continue;
      const halfLifeSec = fit.halfLifeBars * fit.barSec;
      if (halfLifeSec > maxHalfLifeSec) continue;

      const disp = displacement(s.price, fit);
      if (!disp) continue;
      const e = edge(disp.dev, costFraction);
      if (e.netEdge <= 0) continue;

      const row: SignalRow = {
        sym: s.sym,
        price: s.price,
        z: disp.z,
        vr: fit.vr,
        vrZ: fit.vrZ,
        regime: fit.regime,
        halfLifeSec,
        expectedMove: e.expectedMove,
        netEdge: e.netEdge,
        n: fit.n,
      };
      (disp.dev < 0 ? panels.down : panels.up).push(row);
    }

    const byEdge = (x: SignalRow, y: SignalRow) => y.netEdge - x.netEdge;
    panels.down.sort(byEdge);
    panels.up.sort(byEdge);
    panels.down.length = Math.min(panels.down.length, cfg.panelRows);
    panels.up.length = Math.min(panels.up.length, cfg.panelRows);
    // How many of the `reverting` labels a universe of pure random walks would
    // have produced anyway. Shown beside the count, because the top of a list
    // selected from 80 names is exactly where noise collects.
    panels.falseLabels = expectedFalseLabels(panels.evaluated, cfg.regimeZ);
    return panels;
  }

  /** Supply changes for a horizon the live tape cannot reach back to. */
  setLongChanges(horizon: string, changes: Record<string, number>): void {
    this.longChanges.set(horizon, new Map(Object.entries(changes)));
  }

  /** Merge incoming bars into the pending bucket for the next step. */
  ingest(bars: Bar[]): void {
    for (const b of bars) {
      this.barsSeen++;
      const i = this.idxOf(b.sym);
      const cur = this.pending.get(i);
      if (!cur) {
        this.pending.set(i, { ...b });
      } else {
        cur.h = Math.max(cur.h, b.h);
        cur.l = Math.min(cur.l, b.l);
        cur.c = b.c;
        cur.v += b.v;
        cur.n += b.n;
        cur.q += b.q;
        cur.t = b.t;
      }
    }
  }

  private idxOf(sym: string): number {
    let i = this.index.get(sym);
    if (i === undefined) {
      i = this.states.length;
      this.index.set(sym, i);
      this.states.push(new TickerState(sym, this.cfg.tauFast, this.cfg.tauSlow, this.cfg.tauSmooth));
      this.grow(this.states.length);
    }
    return i;
  }

  private grow(n: number): void {
    if (this.raw.length >= n) return;
    const cap = Math.max(64, 1 << Math.ceil(Math.log2(n)));
    for (const k of SIGNAL_KEYS) {
      this.z[k] = grow(this.z[k], cap);
      this.pct[k] = grow(this.pct[k], cap);
    }
    this.raw = grow(this.raw, cap);
    this.scoreArr = grow(this.scoreArr, cap);
    this.slowArr = grow(this.slowArr, cap);
    this.meanArr = grow(this.meanArr, cap);
    this.medianArr = grow(this.medianArr, cap);
    this.slopeArr = grow(this.slopeArr, cap);
    this.slopeRawArr = grow(this.slopeRawArr, cap);
    this.slopeSlowArr = grow(this.slopeSlowArr, cap);
    this.slopeMeanArr = grow(this.slopeMeanArr, cap);
    this.slopeMedArr = grow(this.slopeMedArr, cap);
    this.chgArr = grow(this.chgArr, cap);
    this.sortArr = grow(this.sortArr, cap);
    this.active = new Int32Array(cap);
    this.order = new Int32Array(cap);
  }

  /** Advance one engine tick and publish a ranking snapshot. */
  step(t: number): Snapshot {
    const t0 = performance.now();
    this.stepNo++;
    const cfg = this.cfg;
    const bucket = bucketOf(t);
    const capacity = Math.max(8, Math.round(cfg.windowSec));

    /* ---- stage 1: per-ticker signals, within-ticker normalization ---- */
    let nActive = 0;
    let nWarming = 0;
    let nFiltered = 0;
    let marketRatioSum = 0;
    let marketRatioN = 0;

    for (let i = 0; i < this.states.length; i++) {
      const s = this.states[i];
      const bar = this.pending.get(i);
      const shape = this.profile.factor(s.sym, bucket);

      if (bar) {
        s.stale = 0;
        if (s.sessionOpen === 0) s.sessionOpen = bar.o || bar.c;
        s.prevPrice = s.price || bar.o || bar.c;
        s.price = bar.c;
        s.lastBarT = bar.t;
      } else {
        s.stale++;
      }

      const v = bar ? bar.v : 0;
      const nTrades = bar ? bar.n : 0;
      const nQuotes = bar ? bar.q : 0;
      const price = s.price || 1;
      const hl = bar ? Math.max(0, bar.h - bar.l) / price : 0;
      const ret = s.prevPrice > 0 ? s.price / s.prevPrice - 1 : 0;

      // Expected activity for this ticker at this time of day.
      const expVol = Math.max(s.advPerSec.mean * shape, 1e-6);
      const expTrades = Math.max(s.tradesPerSec.mean * shape, 1e-6);
      const expQuotes = Math.max(s.quotesPerSec.mean * shape, 1e-6);
      const atr = Math.max(s.atr.mean, 1e-6);

      if (v > 0 && s.advPerSec.count > WARMUP) {
        const ratio = v / expVol;
        this.profile.observe(s.sym, bucket, ratio);
        marketRatioSum += Math.min(4, ratio);
        marketRatioN++;
      }

      // log1p keeps a 50x volume spike from being 50x more important than a 2x
      // one while still ordering them correctly.
      s.rvolNow = v / expVol;
      const x: Record<SignalKey, number> = {
        rvol: Math.log1p(v / expVol),
        trades: Math.log1p(nTrades / expTrades),
        quotes: Math.log1p(nQuotes / expQuotes),
        ret: Math.abs(ret) / atr,
        range: hl / atr,
      };

      for (const k of SIGNAL_KEYS) {
        // z against the *prior* baseline, then fold the sample in — otherwise
        // the observation partly cancels itself and surges read smaller.
        const zk = s.base[k].z(x[k]);
        s.base[k].push(x[k], t);
        s.fast[k].push(zk, t);
        this.z[k][i] = s.fast[k].mean;
      }

      // One price sample per step per ticker, whether or not a bar arrived: the
      // change-over-horizon lookbacks index by step count, so a ticker that
      // goes quiet must still advance or its "3 seconds ago" would drift.
      s.prices.push(s.price);

      // baselines are stored shape-free so they stay comparable across the day
      s.advPerSec.push(v / Math.max(shape, 1e-3), t);
      s.tradesPerSec.push(nTrades / Math.max(shape, 1e-3), t);
      s.quotesPerSec.push(nQuotes / Math.max(shape, 1e-3), t);
      if (hl > 0) s.atr.push(hl, t);

      // Split the ineligible cases apart: "still warming up" and "excluded by
      // the liquidity floors" look identical on an empty board, and the fix
      // for one is waiting while the fix for the other is changing a setting.
      const fresh = s.stale < STALE_LIMIT;
      const warm = s.advPerSec.count >= WARMUP;
      const liquid = s.price >= cfg.minPrice && s.adv >= cfg.minAdv;
      if (fresh && warm && liquid) this.active[nActive++] = i;
      else if (fresh && !warm) nWarming++;
      else if (fresh && warm) nFiltered++;
    }

    if (marketRatioN > 30) this.profile.observeMarket(bucket, marketRatioSum / marketRatioN);
    this.pending.clear();

    /* ---- stage 2: cross-sectional percentile ranks ---- */
    const act = this.active.subarray(0, nActive);
    for (const k of SIGNAL_KEYS) {
      this.pct[k].fill(0, 0, this.states.length);
      percentileRank(this.z[k], this.active, nActive, this.pct[k], this.order);
    }

    let wSum = 0;
    for (const k of SIGNAL_KEYS) wSum += Math.max(0, cfg.weights[k]);
    if (wSum <= 0) wSum = 1;

    for (let a = 0; a < nActive; a++) {
      const i = act[a];
      let acc = 0;
      for (const k of SIGNAL_KEYS) acc += Math.max(0, cfg.weights[k]) * this.pct[k][i];
      const composite = acc / wSum;
      const s = this.states[i];
      s.raw = composite;
      s.scoreSmooth.push(composite, t);
      s.scoreSlow.push(composite, t);
      s.score = s.scoreSmooth.mean;
      this.raw[i] = composite;
      this.scoreArr[i] = s.score;
      this.slowArr[i] = s.scoreSlow.mean;
    }

    /* ---- stage 2b: change over the selected horizon, and the sort key ---- */
    const horizon = horizonById(cfg.sortHorizon);
    const offTape = horizon.seconds > TAPE_MAX_SEC;
    const supplied = offTape ? this.longChanges.get(horizon.id) : undefined;

    for (let a = 0; a < nActive; a++) {
      const i = act[a];
      const s = this.states[i];
      // A horizon past what the tape holds is answered from daily closes, if
      // they have been supplied; NaN marks "not knowable yet" all the way to
      // the row, so nothing downstream mistakes it for a flat 0%.
      const change = offTape ? supplied?.get(s.sym) ?? null : s.prices.changeOver(horizon.seconds);
      this.chgArr[i] = change === null ? NaN : change;
    }

    // Sorting by a change nobody can compute yet would order the board by
    // whichever tickers happen to have NaN. Tickers without a value sort last.
    const byChange = cfg.sortBy !== 'score';
    for (let a = 0; a < nActive; a++) {
      const i = act[a];
      if (!byChange) {
        this.sortArr[i] = this.scoreArr[i];
        continue;
      }
      const c = this.chgArr[i];
      this.sortArr[i] = Number.isNaN(c) ? -Infinity : cfg.sortBy === 'absChange' ? Math.abs(c) : c;
    }

    /* ---- stage 3: window stats on the shortlist ---- */
    const k = Math.max(SHORTLIST_MIN, cfg.topN * SHORTLIST_MULT);
    const shortlist = topK(this.sortArr, this.active, nActive, k);

    for (let a = 0; a < shortlist.length; a++) {
      const i = shortlist[a];
      const s = this.states[i];
      s.ensureWindows(capacity);
      s.win!.push(s.score);
      s.rawWin!.push(s.raw);
      s.lastShortlist = this.stepNo;
      this.meanArr[i] = s.win!.mean;
      this.medianArr[i] = s.win!.median();
      const lag = Math.min(8, Math.max(2, Math.floor(capacity / 8)));
      this.slopeArr[i] = s.win!.slopePerSample(lag);
      this.slopeRawArr[i] = s.rawWin!.slopePerSample(2);
      this.slopeSlowArr[i] = s.win!.slopePerSample(Math.min(capacity - 3, lag * 3));
      // a trailing mean moves at roughly half the rate of the series it averages
      this.slopeMeanArr[i] = this.slopeArr[i] * 0.5;
      this.slopeMedArr[i] = s.win!.slopePerSample(Math.min(capacity - 3, lag * 2)) * 0.5;
    }
    if (this.stepNo % 120 === 0) {
      for (const s of this.states) {
        if (s.win && this.stepNo - s.lastShortlist > WINDOW_TTL) s.dropWindows();
      }
    }

    /* ---- stage 4: ensemble vote ---- */
    const members: Member[] = [
      { name: 'instant', values: this.raw, slopes: this.slopeRawArr },
      { name: 'fast', values: this.scoreArr, slopes: this.slopeArr },
      { name: 'slow', values: this.slowArr, slopes: this.slopeSlowArr },
      { name: 'mean', values: this.meanArr, slopes: this.slopeMeanArr },
      { name: 'median', values: this.medianArr, slopes: this.slopeMedArr },
    ];
    const vote = tally(shortlist, this.states.length, members, cfg.topN, cfg.horizonSec);

    /* ---- stage 5: hysteresis on list membership ---- */
    const ranked = Array.from(shortlist).sort((a, b) => this.sortArr[b] - this.sortArr[a]);
    const chosen: number[] = [];
    const heldFlag = new Set<number>();

    // The Schmitt trigger is calibrated on a 0-1 composite; thetaIn = 0.72 means
    // nothing applied to a percentage change, where 0.72 would be a 72% move. So
    // a change sort takes the top N outright. It flickers more, and that is the
    // honest behaviour: the ordering really is that volatile at short horizons.
    if (byChange) {
      for (let r = 0; r < ranked.length && chosen.length < cfg.topN; r++) {
        // Stop at the first ticker with no value for this horizon: `ranked` is
        // descending, so everything after it is also unknown. Padding the list
        // with them would fill the board with blanks.
        if (this.sortArr[ranked[r]] === -Infinity) break;
        chosen.push(ranked[r]);
      }
    } else {
      for (let r = 0; r < ranked.length && chosen.length < cfg.topN; r++) {
        const i = ranked[r];
        const sym = this.states[i].sym;
        const sc = this.scoreArr[i];
        const incumbent = this.published.has(sym);
        if (incumbent) {
          // Schmitt trigger: an incumbent keeps its seat down to thetaOut, so the
          // list does not chatter for tickers sitting right on the threshold.
          if (sc >= cfg.thetaOut && r < cfg.rankExit) {
            chosen.push(i);
            if (sc < cfg.thetaIn) heldFlag.add(i);
          }
        } else if (sc >= cfg.thetaIn) {
          chosen.push(i);
        }
      }
      // If thresholds starve the list, fill the remaining slots by score so the
      // board is never mysteriously short.
      if (chosen.length < cfg.topN) {
        const taken = new Set(chosen);
        for (let r = 0; r < ranked.length && chosen.length < cfg.topN; r++) {
          const i = ranked[r];
          if (!taken.has(i)) {
            chosen.push(i);
            heldFlag.add(i);
          }
        }
      }
    }
    chosen.sort((a, b) => this.sortArr[b] - this.sortArr[a]);

    const signals = this.buildPanels(act, nActive);

    /* ---- stage 6: emit ---- */
    const rows: RankRow[] = [];
    let churnSum = 0;
    let churnN = 0;
    const nextPublished = new Map<string, number>();
    for (let r = 0; r < chosen.length; r++) {
      const i = chosen[r];
      const s = this.states[i];
      const prev = this.published.get(s.sym);
      const rank = r + 1;
      if (prev !== undefined) {
        churnSum += Math.abs(rank - prev);
        churnN++;
      }
      nextPublished.set(s.sym, rank);
      const parts = {} as Record<SignalKey, number>;
      for (const key of SIGNAL_KEYS) parts[key] = this.pct[key][i];
      rows.push({
        sym: s.sym,
        rank,
        prevRank: prev ?? null,
        price: s.price,
        chg: s.chg,
        chgSel: Number.isNaN(this.chgArr[i]) ? null : this.chgArr[i],
        score: this.scoreArr[i],
        raw: this.raw[i],
        mean: this.meanArr[i],
        median: this.medianArr[i],
        mad: s.win ? s.win.mad() : 0,
        rvol: s.rvolNow,
        parts,
        robust: vote.robust[i],
        pred: predLabel(vote.pred[i]),
        predConf: vote.predConf[i],
        slope: this.slopeArr[i],
        spark: s.win ? s.win.sample(24) : [],
        held: heldFlag.has(i),
      });
    }
    this.published = nextPublished;

    const now = t;
    if (this.lastRateT === 0) this.lastRateT = now;
    const dtRate = (now - this.lastRateT) / 1000;
    if (dtRate >= 1) {
      this.barRate = this.barsSeen / dtRate;
      this.barsSeen = 0;
      this.lastRateT = now;
    }

    return {
      t,
      rows,
      signals,
      stats: {
        universe: this.states.length,
        active: nActive,
        barsPerSec: Math.round(this.barRate),
        msgsPerSec: 0,
        computeMs: performance.now() - t0,
        churn: churnN ? churnSum / churnN : 0,
        warming: nWarming,
        filtered: nFiltered,
        warmupNeeded: WARMUP,
      },
    };
  }
}

function emptyPanels(costFraction: number): SignalPanels {
  return { down: [], up: [], evaluated: 0, reverting: 0, falseLabels: 0, costFraction };
}

function blankSignals(n: number): Record<SignalKey, Float64Array<ArrayBuffer>> {
  const o = {} as Record<SignalKey, Float64Array<ArrayBuffer>>;
  for (const k of SIGNAL_KEYS) o[k] = new Float64Array(n);
  return o;
}

function grow(a: Float64Array<ArrayBuffer>, n: number): Float64Array<ArrayBuffer> {
  const b = new Float64Array(n);
  b.set(a);
  return b;
}
