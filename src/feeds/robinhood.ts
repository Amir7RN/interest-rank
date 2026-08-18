import type { Bar } from '../types.ts';
import type { Feed, FeedOptions, FeedStatus } from './types.ts';

/**
 * Robinhood, via the local bridge in `bridge/`.
 *
 * Why a bridge: the browser cannot talk to Robinhood directly (no CORS, no
 * anonymous access), so a small localhost process fetches the bars and serves
 * them to this page. See `bridge/README.md` — the bridge holds whatever
 * credential it needs; this file never sees one.
 *
 * Two things to know about the data, because they change what the score means:
 *
 * 1. The finest interval available is **15 seconds**, not 1. A 15-second bar
 *    delivered as-is would make relative volume spike 15x on the tick it
 *    arrives and read zero in between, which is an artifact, not attention. So
 *    each bar is split into 15 one-second slices, released one per second, with
 *    volume spread evenly and price interpolated across the slice. Sub-bar
 *    shape is synthetic: the 15-second aggregate is real, the path inside it is
 *    not, and nothing here can see individual prints.
 * 2. **Trade count and quote count are not in the feed.** Trade count is
 *    estimated from volume at a nominal average trade size; quote count is
 *    zero. Set the quote-churn weight to 0 when using this feed — otherwise
 *    every ticker ties on a signal none of them have.
 */

/** Fallback slice count when the bridge does not report its bar interval. */
const DEFAULT_SLICES = 15;
const NOMINAL_TRADE_SIZE = 200;

interface BridgeBar {
  sym: string;
  /** bar start, ISO 8601 */
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface BridgeResponse {
  interval_sec: number;
  bars: BridgeBar[];
  /** bridge-side note surfaced in the status line (e.g. "market closed, replaying") */
  note?: string;
}

export class RobinhoodFeed implements Feed {
  readonly id = 'robinhood';
  readonly name = 'Robinhood (via local bridge)';
  readonly needsKey = false;

  private opts: FeedOptions;
  private pollTimer: number | null = null;
  private tickTimer: number | null = null;
  private stopped = false;
  /** symbol -> most recent bar timestamp already queued, so polls can overlap */
  private lastSeen = new Map<string, string>();
  /** symbol -> undelivered one-second slices, oldest first */
  private queues = new Map<string, Bar[]>();
  private msgs = 0;
  private note = '';

  constructor(opts: FeedOptions) {
    this.opts = opts;
  }

  start(onBars: (bars: Bar[]) => void, onStatus: (s: FeedStatus) => void): void {
    this.stopped = false;
    const base = (this.opts.bridgeUrl || 'http://127.0.0.1:8787').replace(/\/+$/, '');
    const symbols = this.opts.symbols.slice(0, 200);

    const poll = async () => {
      if (this.stopped) return;
      const url = `${base}/bars?symbols=${encodeURIComponent(symbols.join(','))}`;
      try {
        const res = await fetch(url, { headers: { accept: 'application/json' } });
        if (!res.ok) {
          onStatus({ state: 'error', detail: `bridge ${res.status} ${res.statusText}` });
          return;
        }
        const payload = (await res.json()) as BridgeResponse;
        this.note = payload.note ?? '';
        const slices = Math.max(1, Math.round(payload.interval_sec || DEFAULT_SLICES));
        let queued = 0;
        for (const bar of payload.bars ?? []) {
          if (this.lastSeen.get(bar.sym) === bar.t) continue; // already have it
          const prev = this.lastSeen.get(bar.sym);
          if (prev && bar.t <= prev) continue; // out-of-order or replayed
          this.lastSeen.set(bar.sym, bar.t);
          this.enqueue(bar, slices);
          queued++;
        }
        onStatus({
          state: 'live',
          detail: `${symbols.length} symbols · ${queued} new bars${this.note ? ` · ${this.note}` : ''}`,
        });
      } catch (err) {
        onStatus({
          state: 'error',
          detail: `bridge unreachable at ${base} — is it running?`,
        });
        void err;
      }
    };

    // Release one slice per symbol per second, matching the engine's cadence.
    const tick = () => {
      const out: Bar[] = [];
      for (const [sym, queue] of this.queues) {
        const next = queue.shift();
        if (next) {
          out.push({ ...next, t: Date.now() });
          this.msgs++;
        }
        if (queue.length === 0) this.queues.delete(sym);
      }
      if (out.length) onBars(out);
      onStatus({ state: 'live', msgs: this.msgs });
      this.msgs = 0;
    };

    onStatus({ state: 'connecting', detail: `bridge ${base}` });
    void poll();
    this.pollTimer = setInterval(poll, 5000) as unknown as number;
    this.tickTimer = setInterval(tick, 1000) as unknown as number;
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    if (this.tickTimer !== null) clearInterval(this.tickTimer);
    this.pollTimer = null;
    this.tickTimer = null;
    this.queues.clear();
    this.lastSeen.clear();
  }

  /** Split one aggregate bar into per-second slices and queue them. */
  private enqueue(bar: BridgeBar, slices: number): void {
    const queue = this.queues.get(bar.sym) ?? [];
    // A backlog means the bridge is ahead of the release clock — drop the
    // oldest so the board tracks the present rather than falling further behind.
    while (queue.length > slices * 3) queue.shift();

    const vol = Math.max(0, bar.v) / slices;
    const trades = Math.max(1, Math.round(vol / NOMINAL_TRADE_SIZE));
    const mid = Math.floor(slices / 2);
    for (let i = 0; i < slices; i++) {
      const a = bar.o + ((bar.c - bar.o) * i) / slices;
      const b = bar.o + ((bar.c - bar.o) * (i + 1)) / slices;
      // The real high and low happened somewhere inside the bar; put them in
      // the middle slice so range expansion still registers once, not 15 times.
      const hi = i === mid ? bar.h : Math.max(a, b);
      const lo = i === mid ? bar.l : Math.min(a, b);
      queue.push({
        sym: bar.sym,
        t: 0, // stamped at release
        o: a,
        h: hi,
        l: lo,
        c: b,
        v: vol,
        n: trades,
        q: 0, // not available from this source
      });
    }
    this.queues.set(bar.sym, queue);
  }
}
