import { createFeed, type Feed, type FeedStatus } from './feeds/index.ts';
import { CORE_SYMBOLS } from './feeds/universe.ts';
import { mountControls, loadSettings, type AppSettings } from './ui/controls.ts';
import { SignalBoard } from './ui/signals.ts';
import { RankTable } from './ui/table.ts';
import { horizonById, type FromWorker, type Snapshot, type ToWorker } from './types.ts';
import './styles.css';

const settings = loadSettings();
const table = new RankTable(document.getElementById('board')!);
const signals = new SignalBoard(document.getElementById('signals')!);
const statusEl = document.getElementById('status')!;
const clockEl = document.getElementById('clock')!;

const worker = new Worker(new URL('./engine/worker.ts', import.meta.url), { type: 'module' });
let feed: Feed | null = null;
let feedMsgRate = 0;
let feedState: FeedStatus = { state: 'idle' };
let lastSnap: Snapshot | null = null;
/** the bridge's description of the active `*scan`, shown in the status bar */
let scanNote: string | null = null;
/** the bridge's description of the last long-horizon change fetch */
let changesNote: string | null = null;
/** symbols the active feed was started with, for the long-horizon fetch */
let activeSymbols: string[] = [];

/** Longest lookback the live tape can answer; must match PriceHistory. */
const TAPE_MAX_SEC = 4 * 3600;
/** Daily closes move once a day; this only needs to catch the roll. */
const LONG_CHANGE_POLL_MS = 5 * 60 * 1000;

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
    signals.render(lastSnap);
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
  activeSymbols = list.symbols.length ? list.symbols : CORE_SYMBOLS.slice(0, 25);
  void refreshLongChanges(s);

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

/**
 * Fetch changes for a lookback longer than the tape can reach.
 *
 * Only the bridge can answer these — they need daily closes, and the page has
 * only been open for minutes. Called on horizon change and on a slow timer;
 * silently does nothing for horizons the tape already covers.
 */
async function refreshLongChanges(s: AppSettings): Promise<void> {
  const horizon = horizonById(s.config.sortHorizon);
  if (horizon.seconds <= TAPE_MAX_SEC || activeSymbols.length === 0) {
    changesNote = null;
    return;
  }
  const base = (s.bridgeUrl || 'http://127.0.0.1:8787').replace(/\/+$/, '');
  const url =
    `${base}/changes?symbols=${encodeURIComponent(activeSymbols.join(','))}` +
    `&horizon=${encodeURIComponent(horizon.id)}`;
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    const body = (await res.json().catch(() => ({}))) as {
      changes?: Record<string, number>;
      note?: string;
      error?: string;
    };
    if (res.status === 404) {
      changesNote = `${horizon.label}: bridge predates /changes — restart it`;
      return;
    }
    if (!res.ok) {
      changesNote = `${horizon.label}: ${body.error ?? res.status}`;
      return;
    }
    changesNote = body.note ? `${horizon.label} · ${body.note}` : null;
    send({ type: 'longChanges', horizon: horizon.id, changes: body.changes ?? {} });
  } catch {
    changesNote = `${horizon.label}: bridge unreachable — long lookbacks need it`;
  }
  renderStatus();
}

function renderStatus(): void {
  const st = lastSnap?.stats;
  const dot = `<span class="dot ${feedState.state}"></span>`;
  statusEl.innerHTML = [
    `${dot}<b>${feedState.state}</b>${feedState.detail ? ` · ${feedState.detail}` : ''}`,
    scanNote ? `scan: ${scanNote}` : '',
    changesNote ?? '',
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
  setSelHeader(s.config.sortHorizon);
  if (restart) void startFeed(s);
  // Changing the horizon can move it across the tape/daily-closes boundary, so
  // re-resolve rather than waiting up to five minutes for the next poll.
  else void refreshLongChanges(s);
});

/** Label the Δ column with the horizon it is actually showing. */
function setSelHeader(horizonId: string): void {
  const th = document.querySelector<HTMLElement>('[data-selhead]');
  if (th) th.textContent = `Δ ${horizonById(horizonId).id}`;
}
setSelHeader(settings.config.sortHorizon);

setInterval(() => void refreshLongChanges(settings), LONG_CHANGE_POLL_MS);

renderStatus();
