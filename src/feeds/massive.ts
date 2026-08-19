import { SipAggregateFeed } from './sip.ts';
import type { FeedOptions } from './types.ts';

/**
 * Massive.com real-time full-SIP 1-second aggregates.
 *
 * Same wire protocol as Polygon (Massive is built on it), different host. The
 * key goes in the "API key" box — it is a REST/socket key created at
 * massive.com, not the OAuth session an MCP client uses.
 *
 * Plan requirement, checked against the live API: the free Basic tier has no
 * socket at all and its REST data stops at the previous session; the delayed
 * tiers stream 15-minute-old bars, which is not a ranking of *now*. Only the
 * real-time tier makes this feed mean what the board says it means. For a
 * zero-cost option that still uses real prints, see `replay.ts`.
 */
export class MassiveFeed extends SipAggregateFeed {
  constructor(opts: FeedOptions) {
    super('massive', 'Massive (SIP 1s aggregates)', 'wss://socket.massive.com/stocks', opts);
  }
}
