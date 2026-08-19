import { SipAggregateFeed } from './sip.ts';
import type { FeedOptions } from './types.ts';

/** Polygon.io real-time full-SIP 1-second aggregates. See `sip.ts`. */
export class PolygonFeed extends SipAggregateFeed {
  constructor(opts: FeedOptions) {
    super('polygon', 'Polygon (SIP 1s aggregates)', 'wss://socket.polygon.io/stocks', opts);
  }
}
