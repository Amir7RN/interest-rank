import { createFeed, type Feed, type FeedStatus } from './feeds/index.ts';
import { CORE_SYMBOLS } from './feeds/universe.ts';
import { mountControls, loadSettings, type AppSettings } from './ui/controls.ts';
import { RankTable } from './ui/table.ts';
import type { FromWorker, Snapshot, ToWorker } from './types.ts';
import './styles.css';

const settings = loadSettings();
const table = new RankTable(document.getElementById('board')!);
const statusEl = document.getElementById('status')!;
const clockEl = document.getElementById('clock')!;

const worker = new Worker(new URL('./engine/worker.ts', import.meta.url), { type: 'module' });
let feed: Feed | null = null;
let feedMsgRate = 0;
let feedState: FeedStatus = { state: 'idle' };
let lastSnap: Snapshot | null = null;
/** the bridge's description of the active `*scan`, shown in the status bar */
let scanNote: string | null = null;

function send(msg: ToWorker): void {
  worker.postMessage(msg);
}

worker.onmessage = (ev: MessageEvent<FromWorker>) => {
  const msg = ev.data;
  if (msg.type === 'ready') {
    send({ type: 'config', config: settings.config });
    void startFeed(settings);
    return;
  }
  if (msg.type === 'snapshot') {
    lastSnap = msg.snapshot;
    lastSnap.stats.msgsPerSec = Math.round(feedMsgRate);
    table.render(lastSnap);
    renderStatus();
  }
};

/** Result of expanding a watchlist, including anything worth telling the user. */
interface Watchlist {
  symbols: string[];
  /** non-null when a `*scan` token could not be resolved */
  problem: string | null;
  /** the bridge's description of the scan, for the status line */
  note: string | null;
}

/**
 * Expand a watchlist string.
 *
 * Plain tickers pass through. `*core` expands to the built-in liquid US list so
 * a wide cross-section doesn't mean typing 200 symbols by hand, and `*core:50`
 * takes the first 50. `*scan` pulls the current Robinhood screener results from
 * the bridge, in the scanner's own order — the screener decides *which* names
 * are worth watching and this board ranks them, which is the division of labour
 * the two tools are actually good at. `*scan:20` takes its top 20.
 *
 * Order is preserved and duplicates are dropped, so a `*scan, SPY` watchlist
 * keeps the scanner's sort and appends the extra.
 */
async function expandSymbols(raw: string, bridgeUrl: string): Promise<Watchlist> {
  const out: string[] = [];
  let problem: string | null = null;
  let note: string | null = null;

  for (const token of raw.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean)) {
    const core = /^\*core(?::(\d+))?$/i.exec(token);
    if (core) {
      out.push(...CORE_SYMBOLS.slice(0, Number(core[1] ?? 150)));
      continue;
    }
    const scan = /^\*scan(?::(\d+))?$/i.exec(token);
    if (scan) {
      const res = await fetchScan(bridgeUrl);
      if (res.problem) problem = res.problem;
      if (res.note) note = res.note;
      out.push(...res.symbols.slice(0, Number(scan[1] ?? res.symbols.length)));
      continue;
    }
    out.push(token.toUpperCase());
  }
  return { symbols: [...new Set(out)], problem, note };
}

interface ScanResponse {
  symbols?: string[];
  note?: string;
  error?: string;
}

/** Current screener results from the bridge's `/scan` endpoint. */
async function fetchScan(bridgeUrl: string): Promise<{ symbols: string[]; problem: string | null; note: string | null }> {
  const base = (bridgeUrl || 'http://127.0.0.1:8787').replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/scan`, { headers: { accept: 'application/json' } });
    const body = (await res.json().catch(() => ({}))) as ScanResponse;
    if (res.status === 404) {
      // A bridge started before /scan existed answers 404 here. That reads as
      // "the scan is broken" when the truth is "the process on this port is
      // older than the code you are running", which has a different fix.
      return {
        symbols: [],
        problem: `the bridge at ${base} predates \`/scan\` — restart it (Ctrl-C, then \`npm run dev\`)`,
        note: null,
      };
    }
    if (!res.ok) {
      return { symbols: [], problem: body.error ?? `bridge returned ${res.status} for /scan`, note: null };
    }
    const symbols = body.symbols ?? [];
    return {
      symbols,
      // An empty scan is not an error — it is a screener that matched nothing,
      // or one that has never been run. Those need different fixes, and the
      // bridge's note is what distinguishes them.
      problem: symbols.length ? null : body.note ?? 'the scan returned no symbols',
      note: body.note ?? null,
    };
  } catch {
    return {
      symbols: [],
      problem: `bridge unreachable at ${base} — \`*scan\` needs it running`,
      note: null,
    };
  }
}

/** What to actually do about a dead feed, appended to the feed's own message. */
const FEED_FIX: Partial<Record<string, string>> = {
  // `npm run dev` starts the bridge, so locally this should not happen; when it
  // does, the page is almost always a deployed build, where nothing running in
  // a browser can start a process on your machine.
  robinhood: ' — `npm run dev` starts it automatically; on a deployed page, run `npm run bridge` yourself',
  replay: ' — a free Basic key from massive.com is enough for this feed',
  massive: ' — this feed needs a real-time plan; try the replay feed for a free one',
};

/**
 * Guards against a slow watchlist resolving after a newer restart has been
 * requested — `*scan` makes startFeed asynchronous, and two clicks on
 * "Reconnect" must not leave two feeds running.
 */
let feedGeneration = 0;

async function startFeed(s: AppSettings): Promise<void> {
  const generation = ++feedGeneration;
  feed?.stop();
  feed = null;
  send({ type: 'reset' });

  const list = await expandSymbols(s.symbols, s.bridgeUrl);
  if (generation !== feedGeneration) return; // superseded while resolving

  scanNote = list.note;
  if (list.problem) table.setFeedProblem(list.problem);

  feed = createFeed(s.feed, {
    apiKey: s.apiKey,
    symbols: list.symbols.length ? list.symbols : CORE_SYMBOLS.slice(0, 25),
    bridgeUrl: s.bridgeUrl,
    replaySpeed: s.replaySpeed,
    replayDate: s.replayDate,
  });
  feed.start(
    (bars) => {
      if (generation === feedGeneration) send({ type: 'bars', bars });
    },
    (st) => {
      if (generation !== feedGeneration) return;
      if (st.msgs !== undefined) feedMsgRate = st.msgs;
      feedState = { ...feedState, ...st };
      table.setFeedProblem(
        feedState.state === 'error' || feedState.state === 'stopped'
          ? `${feedState.detail ?? 'the feed is not connected'}${FEED_FIX[s.feed] ?? ''}`
          : null,
      );
      renderStatus();
    },
  );
}

function renderStatus(): void {
  const st = lastSnap?.stats;
  const dot = `<span class="dot ${feedState.state}"></span>`;
  statusEl.innerHTML = [
    `${dot}<b>${feedState.state}</b>${feedState.detail ? ` · ${feedState.detail}` : ''}`,
    scanNote ? `scan: ${scanNote}` : '',
    st ? `universe ${st.universe}` : '',
    st ? `ranked ${st.active}` : '',
    st ? `${st.barsPerSec}/s bars` : '',
    `${Math.round(feedMsgRate)}/s msgs`,
    st ? `compute ${st.computeMs.toFixed(1)} ms` : '',
    st ? `churn ${st.churn.toFixed(2)}` : '',
  ]
    .filter(Boolean)
    .join('<span class="sep">·</span>');
}

setInterval(() => {
  clockEl.textContent = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false }) + ' ET';
}, 1000);

mountControls(document.getElementById('controls')!, settings, (s, restart) => {
  send({ type: 'config', config: s.config });
  if (restart) void startFeed(s);
});

renderStatus();
