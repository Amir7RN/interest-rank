import { FinnhubFeed } from './finnhub.ts';
import { MassiveFeed } from './massive.ts';
import { PolygonFeed } from './polygon.ts';
import { ReplayFeed } from './replay.ts';
import { RobinhoodFeed } from './robinhood.ts';
import { SimFeed } from './sim.ts';
import type { Feed, FeedOptions } from './types.ts';

export const FEED_IDS = ['sim', 'replay', 'robinhood', 'massive', 'polygon', 'finnhub'] as const;
export type FeedId = (typeof FEED_IDS)[number];

export const FEED_LABEL: Record<FeedId, string> = {
  sim: 'Simulator (no key)',
  replay: 'Massive replay (free tier, past session)',
  robinhood: 'Robinhood (local bridge)',
  massive: 'Massive (SIP 1s bars, real-time plan)',
  polygon: 'Polygon (SIP 1s bars, real-time plan)',
  finnhub: 'Finnhub (trades, watchlist)',
};

/** Feeds whose source carries no quote data — the quote-churn weight is dead there. */
export const FEEDS_WITHOUT_QUOTES: FeedId[] = ['replay', 'robinhood'];

export function createFeed(id: FeedId, opts: FeedOptions): Feed {
  switch (id) {
    case 'replay':
      return new ReplayFeed(opts);
    case 'robinhood':
      return new RobinhoodFeed(opts);
    case 'massive':
      return new MassiveFeed(opts);
    case 'polygon':
      return new PolygonFeed(opts);
    case 'finnhub':
      return new FinnhubFeed(opts);
    default:
      return new SimFeed(opts);
  }
}

export type { Feed, FeedOptions, FeedStatus, FeedState } from './types.ts';
