import type { Bar } from '../types.ts';
import { etDate, sessionCandidates, sliceBars, MINUTE_MS, type MinuteBar } from './tape.ts';
import type { Feed, FeedOptions, FeedStatus } from './types.ts';

const API = 'https://api.massive.com';
/** Session dates to try before giving up on finding one with data. */
const MAX_DATE_PROBES = 8;
/** Symbols beyond this are dropped — every one is a separate request. */
const MAX_SYMBOLS = 200;
/** Starting delay between symbol requests; raised on 429, never lowered. */
const BASE_REQ_GAP_MS = 250;
const MAX_REQ_GAP_MS = 15_000;

interface AggResponse {
  status?: string;
  message?: string;
  error?: string;
  resultsCount?: number;
  results?: { t: number; o: number; h: number; l: number; c: number; v: number; n?: number }[];
}

interface Tape {
  bars: MinuteBar[];
  cursor: number;
}

/**
 * Replays a past session's minute bars from Massive's REST API as a tape.
 *
 * Why this exists: the board wants real prints, and Massive's free Basic tier
 * has real prints — it just will not give you *today's*. Historical minute
 * aggregates through the previous session are included at no cost, so this feed
 * downloads one completed session and plays it back into the same engine the
 * live feeds drive. Compared to the simulator you get real volume profiles,
 * real correlated moves, and real news spikes; compared to the live feed you
 * get yesterday.
 *
 * Three things about the data, because they change what the score means:
 *
 * 1. **The finest interval on this tier is one minute.** Each engine step
 *    consumes a slice of that minute with volume prorated and price
 *    interpolated (see `tape.ts`). The minute aggregate is real; the path
 *    inside it is invented.
 * 2. **There are no quotes.** Quote churn is 0 for every ticker, so zero that
 *    weight or every name ties on a signal none of them have. Trade count *is*
 *    real here — it comes from the aggregate's `n` field, not an estimate.
 * 3. **Speed rescales the time constants.** At speed S each one-second engine
 *    step swallows S seconds of tape, so a 30-second τ covers 30/S seconds of
 *    market time. Divide the τ settings by S to keep them meaning what they
 *    mean on a live feed.
 */
export class ReplayFeed implements Feed {
  readonly id = 'replay';
  readonly name = 'Massive replay (historical minute bars)';
  readonly needsKey = true;

  private opts: FeedOptions;
  private stopped = false;
  private tickTimer: number | null = null;

  private tapes = new Map<string, Tape>();
  private date = '';
  private tapeNow = 0;
  private tapeStart = 0;
  private tapeEnd = 0;
  private loops = 0;
  private msgs = 0;

  private loaded = 0;
  private wanted = 0;
  private reqGap = BASE_REQ_GAP_MS;
  private problem = '';

  constructor(opts: FeedOptions) {
    this.opts = opts;
  }

  start(onBars: (bars: Bar[]) => void, onStatus: (s: FeedStatus) => void): void {
    this.stopped = false;
    if (!this.opts.apiKey) {
      onStatus({ state: 'error', detail: 'needs a massive.com API key (free Basic tier is enough)' });
      return;
    }

    const symbols = this.opts.symbols.slice(0, MAX_SYMBOLS);
    this.wanted = symbols.length;

    const speed = Math.max(1, Math.round(this.opts.replaySpeed || 1));

    const tick = () => {
      if (this.stopped || this.tapeEnd === 0) {
        onStatus({ state: 'connecting', detail: this.statusDetail(speed), msgs: 0 });
        return;
      }
      const from = this.tapeNow;
      const to = from + speed * 1000;
      const out: Bar[] = [];
      const stamp = Date.now();
      for (const [sym, tape] of this.tapes) {
        const { slice, cursor } = sliceBars(tape.bars, from, to, tape.cursor);
        tape.cursor = cursor;
        if (!slice) continue;
        this.msgs++;
        out.push({ sym, t: stamp, ...slice, q: 0 });
      }
      if (out.length) onBars(out);

      this.tapeNow = to;
      if (this.tapeNow >= this.tapeEnd) {
        // Loop rather than stop: an attention board that goes silent after one
        // session is less useful than one that keeps replaying it.
        this.tapeNow = this.tapeStart;
        this.loops++;
        for (const tape of this.tapes.values()) tape.cursor = 0;
      }
      onStatus({ state: 'live', detail: this.statusDetail(speed), msgs: this.msgs });
      this.msgs = 0;
    };

    onStatus({ state: 'connecting', detail: 'finding the last session with data' });
    this.tickTimer = setInterval(tick, 1000) as unknown as number;
    void this.load(symbols, onStatus);
  }

  stop(): void {
    this.stopped = true;
    if (this.tickTimer !== null) clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.tapes.clear();
    this.tapeNow = 0;
    this.tapeStart = 0;
    this.tapeEnd = 0;
  }

  private statusDetail(speed: number): string {
    if (this.problem) return this.problem;
    if (this.tapeEnd === 0) return `loading ${this.date || '…'} · ${this.loaded}/${this.wanted}`;
    const clock = new Date(this.tapeNow).toLocaleTimeString('en-US', {
      timeZone: 'America/New_York',
      hour12: false,
    });
    const loading = this.loaded < this.wanted ? ` · loading ${this.loaded}/${this.wanted}` : '';
    const lap = this.loops > 0 ? ` · lap ${this.loops + 1}` : '';
    return `${this.date} ${clock} ET · ${speed}x${loading}${lap}`;
  }

  /** Resolve the session date, then pull one symbol at a time into the tape. */
  private async load(symbols: string[], onStatus: (s: FeedStatus) => void): Promise<void> {
    const dates = this.opts.replayDate
      ? [this.opts.replayDate]
      : sessionCandidates(etDate(), MAX_DATE_PROBES);

    let pending = symbols;
    for (const date of dates) {
      if (this.stopped) return;
      this.date = date;
      onStatus({ state: 'connecting', detail: this.statusDetail(1) });
      const probe = await this.fetchTape(pending[0], date, onStatus);
      if (probe === 'fatal') return;
      if (probe === null || probe.length === 0) continue; // holiday, or before this tier's cutoff
      this.addTape(pending[0], probe);
      pending = pending.slice(1);
      break;
    }

    if (this.tapeEnd === 0) {
      this.problem = this.opts.replayDate
        ? `no bars for ${this.opts.replayDate} — market holiday, or outside your plan's history`
        : 'no session with data in the last 8 weekdays — check the API key and its plan';
      onStatus({ state: 'error', detail: this.problem });
      return;
    }

    for (const sym of pending) {
      if (this.stopped) return;
      await sleep(this.reqGap);
      const bars = await this.fetchTape(sym, this.date, onStatus);
      if (bars === 'fatal') return;
      if (bars && bars.length) this.addTape(sym, bars);
      else this.loaded++; // counted as done either way, so progress terminates
    }
  }

  private addTape(sym: string, bars: MinuteBar[]): void {
    this.tapes.set(sym, { bars, cursor: 0 });
    this.loaded++;
    const first = bars[0].t;
    const last = bars[bars.length - 1].t + MINUTE_MS;
    // A symbol arriving late joins at the current tape position; it only widens
    // the window, never rewinds a replay already in flight.
    this.tapeStart = this.tapeStart === 0 ? first : Math.min(this.tapeStart, first);
    this.tapeEnd = Math.max(this.tapeEnd, last);
    if (this.tapeNow === 0) this.tapeNow = this.tapeStart;
  }

  /**
   * One symbol-day of minute bars. Returns `null` when the session has no data
   * and `'fatal'` when the key or plan makes retrying pointless.
   */
  private async fetchTape(
    sym: string,
    date: string,
    onStatus: (s: FeedStatus) => void,
  ): Promise<MinuteBar[] | null | 'fatal'> {
    const url =
      `${API}/v2/aggs/ticker/${encodeURIComponent(sym)}/range/1/minute/${date}/${date}` +
      `?adjusted=true&sort=asc&limit=50000&apiKey=${encodeURIComponent(this.opts.apiKey)}`;

    for (let attempt = 0; attempt < 4; attempt++) {
      if (this.stopped) return 'fatal';
      let res: Response;
      try {
        res = await fetch(url, { headers: { accept: 'application/json' } });
      } catch {
        this.problem = 'network error reaching api.massive.com';
        onStatus({ state: 'error', detail: this.problem });
        return null;
      }

      if (res.status === 429) {
        // Back off and keep the wider gap: the tier's budget did not change.
        const retryAfter = Number(res.headers.get('retry-after'));
        this.reqGap = Math.min(MAX_REQ_GAP_MS, Math.max(this.reqGap * 2, BASE_REQ_GAP_MS));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : this.reqGap;
        onStatus({ state: 'connecting', detail: `rate limited · retrying ${sym} in ${Math.round(wait / 1000)}s` });
        await sleep(wait);
        continue;
      }

      const body = (await res.json().catch(() => ({}))) as AggResponse;
      if (res.status === 401 || res.status === 403) {
        this.problem =
          body.message ??
          `${res.status} from Massive — the key is wrong, or this date is outside your plan`;
        onStatus({ state: 'error', detail: this.problem });
        return 'fatal';
      }
      if (!res.ok) {
        onStatus({ state: 'error', detail: body.message ?? `${sym}: ${res.status} ${res.statusText}` });
        return null;
      }

      this.problem = '';
      const results = body.results ?? [];
      return results.map((r) => ({
        t: r.t,
        o: r.o,
        h: r.h,
        l: r.l,
        c: r.c,
        v: r.v,
        n: r.n ?? 1,
      }));
    }
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
