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

function send(msg: ToWorker): void {
  worker.postMessage(msg);
}

worker.onmessage = (ev: MessageEvent<FromWorker>) => {
  const msg = ev.data;
  if (msg.type === 'ready') {
    send({ type: 'config', config: settings.config });
    startFeed(settings);
    return;
  }
  if (msg.type === 'snapshot') {
    lastSnap = msg.snapshot;
    lastSnap.stats.msgsPerSec = Math.round(feedMsgRate);
    table.render(lastSnap);
    renderStatus();
  }
};

function startFeed(s: AppSettings): void {
  feed?.stop();
  send({ type: 'reset' });
  const symbols = s.symbols
    .split(/[\s,]+/)
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean);
  feed = createFeed(s.feed, {
    apiKey: s.apiKey,
    symbols: symbols.length ? symbols : CORE_SYMBOLS.slice(0, 25),
    universe: s.universe,
  });
  feed.start(
    (bars) => send({ type: 'bars', bars }),
    (st) => {
      if (st.msgs !== undefined) feedMsgRate = st.msgs;
      feedState = { ...feedState, ...st };
      renderStatus();
    },
  );
}

function renderStatus(): void {
  const st = lastSnap?.stats;
  const dot = `<span class="dot ${feedState.state}"></span>`;
  statusEl.innerHTML = [
    `${dot}<b>${feedState.state}</b>${feedState.detail ? ` · ${feedState.detail}` : ''}`,
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
  if (restart) startFeed(s);
});

renderStatus();
