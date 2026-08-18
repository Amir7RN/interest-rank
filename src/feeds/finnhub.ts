import type { Bar } from '../types.ts';
import type { Feed, FeedOptions, FeedStatus } from './types.ts';

interface Trade {
  s: string;
  p: number;
  v: number;
  t: number;
}

/**
 * Finnhub trade stream, aggregated to 1-second bars in the browser.
 *
 * The free tier subscribes symbol by symbol (no wildcard), so the cross-section
 * is only as wide as the watchlist you give it. Fine for a focused board, wrong
 * for "rank the whole market" — for that you want a full-SIP aggregate feed.
 */
export class FinnhubFeed implements Feed {
  readonly id = 'finnhub';
  readonly name = 'Finnhub (trades, per-symbol)';
  readonly needsKey = true;

  private ws: WebSocket | null = null;
  private stopped = false;
  private retry = 0;
  private msgs = 0;
  private acc = new Map<string, Bar>();
  private timer: number | null = null;

  private opts: FeedOptions;

  constructor(opts: FeedOptions) {
    this.opts = opts;
  }

  start(onBars: (bars: Bar[]) => void, onStatus: (s: FeedStatus) => void): void {
    this.stopped = false;
    const connect = () => {
      if (this.stopped) return;
      onStatus({ state: 'connecting', detail: 'ws.finnhub.io' });
      const ws = new WebSocket(`wss://ws.finnhub.io?token=${encodeURIComponent(this.opts.apiKey)}`);
      this.ws = ws;

      ws.onopen = () => {
        this.retry = 0;
        for (const s of this.opts.symbols) ws.send(JSON.stringify({ type: 'subscribe', symbol: s }));
        onStatus({ state: 'live', detail: `${this.opts.symbols.length} symbols` });
      };

      ws.onmessage = (ev) => {
        let msg: { type: string; data?: Trade[] };
        try {
          msg = JSON.parse(ev.data as string);
        } catch {
          return;
        }
        if (msg.type !== 'trade' || !msg.data) return;
        for (const tr of msg.data) {
          this.msgs++;
          const cur = this.acc.get(tr.s);
          if (!cur) {
            this.acc.set(tr.s, {
              sym: tr.s, t: tr.t, o: tr.p, h: tr.p, l: tr.p, c: tr.p, v: tr.v, n: 1, q: 0,
            });
          } else {
            cur.h = Math.max(cur.h, tr.p);
            cur.l = Math.min(cur.l, tr.p);
            cur.c = tr.p;
            cur.v += tr.v;
            cur.n += 1;
            cur.t = tr.t;
          }
        }
      };

      ws.onerror = () => onStatus({ state: 'error', detail: 'websocket error' });
      ws.onclose = () => {
        if (this.stopped) {
          onStatus({ state: 'stopped' });
          return;
        }
        const wait = Math.min(30000, 1000 * 2 ** this.retry++);
        onStatus({ state: 'connecting', detail: `reconnect in ${Math.round(wait / 1000)}s` });
        setTimeout(connect, wait);
      };
    };

    this.timer = setInterval(() => {
      if (this.acc.size) {
        onBars([...this.acc.values()]);
        this.acc.clear();
      }
      onStatus({ state: this.ws?.readyState === WebSocket.OPEN ? 'live' : 'connecting', msgs: this.msgs });
      this.msgs = 0;
    }, 1000) as unknown as number;

    connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    if (this.ws?.readyState === WebSocket.OPEN) {
      for (const s of this.opts.symbols) this.ws.send(JSON.stringify({ type: 'unsubscribe', symbol: s }));
    }
    this.ws?.close();
    this.ws = null;
  }
}
