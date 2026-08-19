import { MassiveFeed } from './massive.ts';
import { ReplayFeed } from './replay.ts';
import { RobinhoodFeed } from './robinhood.ts';
import type { Feed, FeedOptions } from './types.ts';

export const FEED_IDS = ['robinhood', 'replay', 'massive'] as const;
export type FeedId = (typeof FEED_IDS)[number];

export const DEFAULT_FEED: FeedId = 'robinhood';

export const FEED_LABEL: Record<FeedId, string> = {
  robinhood: 'Robinhood (live, via bridge)',
  replay: 'Massive replay (free tier, past session)',
  massive: 'Massive (SIP 1s bars, real-time plan)',
};

/** Feeds whose source carries no quote data — the quote-churn weight is dead there. */
export const FEEDS_WITHOUT_QUOTES: FeedId[] = ['robinhood', 'replay'];

/** Feeds that need an API key pasted in; the rest hide the field. */
export const FEEDS_NEEDING_KEY: FeedId[] = ['replay', 'massive'];

/** Feeds that talk to the local bridge rather than straight to a vendor. */
export const FEEDS_USING_BRIDGE: FeedId[] = ['robinhood'];

/** Narrow an arbitrary stored value to a feed we still ship. */
export function asFeedId(value: unknown): FeedId {
  return (FEED_IDS as readonly string[]).includes(value as string) ? (value as FeedId) : DEFAULT_FEED;
}

export function createFeed(id: FeedId, opts: FeedOptions): Feed {
  switch (id) {
    case 'replay':
      return new ReplayFeed(opts);
    case 'massive':
      return new MassiveFeed(opts);
    default:
      return new RobinhoodFeed(opts);
  }
}

export type { Feed, FeedOptions, FeedStatus, FeedState } from './types.ts';
