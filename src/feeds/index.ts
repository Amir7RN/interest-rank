import { FinnhubFeed } from './finnhub.ts';
import { PolygonFeed } from './polygon.ts';
import { SimFeed } from './sim.ts';
import type { Feed, FeedOptions } from './types.ts';

export const FEED_IDS = ['sim', 'polygon', 'finnhub'] as const;
export type FeedId = (typeof FEED_IDS)[number];

export const FEED_LABEL: Record<FeedId, string> = {
  sim: 'Simulator (no key)',
  polygon: 'Polygon / Massive (SIP 1s bars)',
  finnhub: 'Finnhub (trades, watchlist)',
};

export function createFeed(id: FeedId, opts: FeedOptions): Feed {
  switch (id) {
    case 'polygon':
      return new PolygonFeed(opts);
    case 'finnhub':
      return new FinnhubFeed(opts);
    default:
      return new SimFeed(opts);
  }
}

export type { Feed, FeedOptions, FeedStatus, FeedState } from './types.ts';
