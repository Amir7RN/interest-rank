import type { Bar } from '../types.ts';

export type FeedState = 'idle' | 'connecting' | 'live' | 'error' | 'stopped';

export interface FeedStatus {
  state: FeedState;
  detail?: string;
  /** raw messages consumed since the last status, for the rate display */
  msgs?: number;
}

export interface Feed {
  readonly id: string;
  readonly name: string;
  /** true when the feed needs an API key */
  readonly needsKey: boolean;
  start(onBars: (bars: Bar[]) => void, onStatus: (s: FeedStatus) => void): void;
  stop(): void;
}

export interface FeedOptions {
  apiKey: string;
  /** symbol subset, used by feeds that cannot subscribe to the whole tape */
  symbols: string[];
  /** simulated universe size */
  universe: number;
}
