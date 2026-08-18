import { FinnhubFeed } from './finnhub.ts';
import { PolygonFeed } from './polygon.ts';
import { RobinhoodFeed } from './robinhood.ts';
import { SimFeed } from './sim.ts';
import type { Feed, FeedOptions } from './types.ts';

export const FEED_IDS = ['sim', 'robinhood', 'polygon', 'finnhub'] as const;
export type FeedId = (typeof FEED_IDS)[number];

export const FEED_LABEL: Record<FeedId, string> = {
  sim: 'Simulator (no key)',
  robinhood: 'Robinhood (local bridge)',
  polygon: 'Polygon / Massive (SIP 1s bars)',
  finnhub: 'Finnhub (trades, watchlist)',
};

export function createFeed(id: FeedId, opts: FeedOptions): Feed {
  switch (id) {
    case 'robinhood':
      return new RobinhoodFeed(opts);
    case 'polygon':
      return new PolygonFeed(opts);
    case 'finnhub':
      return new FinnhubFeed(opts);
    default:
      return new SimFeed(opts);
  }
}

export type { Feed, FeedOptions, FeedStatus, FeedState } from './types.ts';
