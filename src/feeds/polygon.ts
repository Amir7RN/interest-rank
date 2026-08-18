import type { Bar } from '../types.ts';
import type { Feed, FeedOptions, FeedStatus } from './types.ts';

interface AggMsg {
  ev: string;
  sym: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  /** average trade size in the bar */
  z?: number;
  /** bar end, epoch ms */
  e?: number;
  s?: number;
  status?: string;
  message?: string;
}

/**
 * Polygon.io / Massive.com per-second aggregates over the full SIP tape.
 *
 * `A.*` is exactly the shape this engine wants: the vendor has already done
 * the 1-second bucketing, which cuts inbound message volume by ~1000x versus
 * raw trades and keeps the browser comfortable. Trade count is not in the
 * payload, so it is reconstructed as volume / average trade size.
 *
 * Requires a real-time plan with full-market aggregates. The IEX-only tier
 * covers ~2-3% of volume and will distort a volume-based ranking badly.
 */
export class PolygonFeed implements Feed {
  readonly id = 'polygon';
  readonly name = 'Polygon / Massive (SIP 1s aggregates)';
  readonly needsKey = true;

  private ws: WebSocket | null = null;
  private stopped = false;
  private retry = 0;
  private msgs = 0;
  private buf: Bar[] = [];
  private flushTimer: number | null = null;

  private opts: FeedOptions;

  constructor(opts: FeedOptions) {
    this.opts = opts;
  }

  start(onBars: (bars: Bar[]) => void, onStatus: (s: FeedStatus) => void): void {
    this.stopped = false;
    const connect = () => {
      if (this.stopped) return;
      onStatus({ state: 'connecting', detail: 'socket.polygon.io' });
      const ws = new WebSocket('wss://socket.polygon.io/stocks');
      this.ws = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ action: 'auth', params: this.opts.apiKey }));
      };

      ws.onmessage = (ev) => {
        let msgs: AggMsg[];
        try {
          msgs = JSON.parse(ev.data as string);
        } catch {
          return;
        }
        for (const m of msgs) {
          if (m.ev === 'status') {
            if (m.status === 'auth_success') {
              ws.send(JSON.stringify({ action: 'subscribe', params: 'A.*' }));
              this.retry = 0;
              onStatus({ state: 'live', detail: 'subscribed A.*' });
            } else if (m.status === 'auth_failed' || m.status === 'error') {
              onStatus({ state: 'error', detail: m.message ?? 'auth failed' });
              this.stopped = true;
              ws.close();
            }
            continue;
          }
          if (m.ev !== 'A') continue;
          this.msgs++;
          const avgSize = m.z && m.z > 0 ? m.z : 200;
          this.buf.push({
            sym: m.sym,
            t: m.e ?? Date.now(),
            o: m.o,
            h: m.h,
            l: m.l,
            c: m.c,
            v: m.v,
            n: Math.max(1, Math.round(m.v / avgSize)),
            q: 0, // quote channel not subscribed; the quote-churn weight can be zeroed
          });
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

    this.flushTimer = setInterval(() => {
      if (this.buf.length) {
        onBars(this.buf);
        this.buf = [];
      }
      onStatus({ state: this.ws?.readyState === WebSocket.OPEN ? 'live' : 'connecting', msgs: this.msgs });
      this.msgs = 0;
    }, 250) as unknown as number;

    connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.flushTimer !== null) clearInterval(this.flushTimer);
    this.flushTimer = null;
    this.ws?.close();
    this.ws = null;
  }
}
