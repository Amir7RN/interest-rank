import {
  asFeedId,
  DEFAULT_FEED,
  FEED_IDS,
  FEED_LABEL,
  FEEDS_NEEDING_KEY,
  FEEDS_USING_BRIDGE,
  FEEDS_WITHOUT_QUOTES,
  type FeedId,
} from '../feeds/index.ts';
import {
  DEFAULT_CONFIG,
  HORIZONS,
  SIGNAL_KEYS,
  SIGNAL_LABEL,
  type EngineConfig,
  type SignalKey,
  type SortBy,
} from '../types.ts';

export interface AppSettings {
  feed: FeedId;
  apiKey: string;
  symbols: string;
  bridgeUrl: string;
  /** Massive replay: seconds of tape per wall-clock second */
  replaySpeed: number;
  /** Massive replay: YYYY-MM-DD, empty for the latest session with data */
  replayDate: string;
  config: EngineConfig;
}

const KEY = 'interest-rank.settings.v1';

export function loadSettings(): AppSettings {
  const base: AppSettings = {
    feed: DEFAULT_FEED,
    apiKey: '',
    symbols: 'AAPL,MSFT,NVDA,AMD,TSLA,SNDK,MU,INTC,SPY,QQQ',
    bridgeUrl: 'http://127.0.0.1:8787',
    replaySpeed: 10,
    replayDate: '',
    config: { ...DEFAULT_CONFIG, weights: { ...DEFAULT_CONFIG.weights } },
  };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return base;
    const saved = JSON.parse(raw) as Partial<AppSettings>;
    return {
      ...base,
      ...saved,
      // A browser that used a since-removed feed (the old simulator, Finnhub,
      // Polygon) has that id in localStorage. Left alone it selects nothing and
      // the board sits dead with no explanation, so it falls back instead.
      feed: asFeedId(saved.feed),
      config: { ...base.config, ...(saved.config ?? {}), weights: { ...base.config.weights, ...(saved.config?.weights ?? {}) } },
    };
  } catch {
    return base;
  }
}

export function saveSettings(s: AppSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private mode / quota — settings just won't persist */
  }
}

/** Per-feed caveats worth seeing before reading the board. */
const FEED_HINT: Record<string, string> = {
  replay:
    "Real prints, yesterday. Massive's free Basic tier includes historical minute bars but not today's tape, so this downloads one completed session and plays it back — one request per symbol, so keep the watchlist short. Minute bars are sliced down to the step, so the aggregate is real and the path inside it is interpolated. No quotes, so quote churn is set to 0. At speed S a τ of N seconds covers N/S seconds of market time: divide the τ settings by the speed to keep them meaning what they mean live.",
  robinhood:
    '`npm run dev` starts the bridge alongside the page, so this works out of the box locally; on a deployed page you run the bridge yourself. Bars are 15-second, split into 1-second slices — the aggregate is real, the path inside it is interpolated. No quote data, so quote churn is set to 0. Max 10 symbols per Robinhood call.',
  massive:
    "Full-SIP 1-second aggregates from massive.com. Needs a real-time plan — the free tier has no socket and the delayed tiers stream 15-minute-old bars, which is not a ranking of now. Trade count is derived from average trade size; no quote channel.",
};

interface NumField {
  key: keyof EngineConfig;
  label: string;
  min: number;
  max: number;
  step: number;
  hint: string;
}

const FIELDS: NumField[] = [
  { key: 'tauFast', label: 'Surge τ (s)', min: 5, max: 300, step: 5, hint: 'EWMA time constant for surge detection' },
  { key: 'tauSlow', label: 'Baseline τ (s)', min: 60, max: 7200, step: 60, hint: 'Per-ticker baseline for the z-scores' },
  { key: 'tauSmooth', label: 'Score τ (s)', min: 1, max: 120, step: 1, hint: 'Smoothing of the composite before ranking' },
  { key: 'windowSec', label: 'Window (s)', min: 10, max: 600, step: 10, hint: 'Length of the mean/median analysis window' },
  { key: 'topN', label: 'Top N', min: 5, max: 100, step: 1, hint: 'Rows published' },
  { key: 'thetaIn', label: 'Enter θ', min: 0, max: 1, step: 0.01, hint: 'Score needed to enter the list' },
  { key: 'thetaOut', label: 'Exit θ', min: 0, max: 1, step: 0.01, hint: 'Score below which an incumbent is dropped' },
  { key: 'rankExit', label: 'Rank exit', min: 5, max: 300, step: 5, hint: 'Rank past which an incumbent loses its seat' },
  { key: 'horizonSec', label: 'Forecast (s)', min: 5, max: 300, step: 5, hint: 'Horizon for the ensemble forecast' },
  { key: 'minPrice', label: 'Min price ($)', min: 0, max: 100, step: 0.5, hint: 'Liquidity floor — keeps sub-$5 pumps out' },
  { key: 'minAdv', label: 'Min ADV (sh)', min: 0, max: 5_000_000, step: 50_000, hint: 'Average daily volume floor' },
  {
    key: 'costBps',
    label: 'Round-trip cost (bps)',
    min: 0,
    max: 200,
    step: 1,
    hint: 'Charged against every panel edge. Spread plus fees, there and back — a displacement that cannot pay it is not an opportunity.',
  },
  {
    key: 'regimeZ',
    label: 'Regime |z|',
    min: 1,
    max: 4,
    step: 0.1,
    hint: 'How far from a random walk a variance ratio must sit before the regime is called. Higher is stricter and yields fewer names picked out of noise.',
  },
  {
    key: 'maxHalfLifeMin',
    label: 'Max half-life (min)',
    min: 1,
    max: 390,
    step: 5,
    hint: 'Hide names whose reversion is too slow to resolve inside a session.',
  },
  { key: 'panelRows', label: 'Panel rows', min: 3, max: 25, step: 1, hint: 'Rows per displacement panel' },
];

export function mountControls(
  root: HTMLElement,
  settings: AppSettings,
  onChange: (s: AppSettings, restartFeed: boolean) => void,
): void {
  const feedOpts = FEED_IDS.map(
    (id) => `<option value="${id}" ${id === settings.feed ? 'selected' : ''}>${FEED_LABEL[id]}</option>`,
  ).join('');

  const numFields = FIELDS.map(
    (f) => `
    <label class="field" title="${f.hint}">
      <span>${f.label}</span>
      <input type="number" data-cfg="${f.key}" value="${settings.config[f.key]}"
             min="${f.min}" max="${f.max}" step="${f.step}">
    </label>`,
  ).join('');

  const weightFields = SIGNAL_KEYS.map(
    (k) => `
    <label class="field weight" title="Blend weight for ${SIGNAL_LABEL[k]}">
      <span>${SIGNAL_LABEL[k]}</span>
      <input type="range" data-w="${k}" min="0" max="1" step="0.01" value="${settings.config.weights[k]}">
      <output data-wout="${k}">${settings.config.weights[k].toFixed(2)}</output>
    </label>`,
  ).join('');

  const horizonOpts = HORIZONS.map(
    (h) =>
      `<option value="${h.id}" ${h.id === settings.config.sortHorizon ? 'selected' : ''}>${h.label}</option>`,
  ).join('');

  const SORT_LABEL: Record<SortBy, string> = {
    score: 'Attention score',
    change: 'Change — biggest gainers first',
    absChange: 'Change — biggest movers, either direction',
  };
  const sortOpts = (Object.keys(SORT_LABEL) as SortBy[])
    .map(
      (k) => `<option value="${k}" ${k === settings.config.sortBy ? 'selected' : ''}>${SORT_LABEL[k]}</option>`,
    )
    .join('');

  root.innerHTML = `
    <details class="panel" open>
      <summary>Sort</summary>
      <div class="grid">
        <label class="field wide" title="What the published ordering is sorted by."><span>Order by</span><select data-sortby>${sortOpts}</select></label>
        <label class="field wide" title="Lookback for the Δ column, and for the change sorts. Up to 3 hours comes from the tape this session has seen; a day or more comes from daily closes via the bridge."><span>Change over</span><select data-horizon>${horizonOpts}</select></label>
      </div>
      <p class="hint" data-sorthint></p>
    </details>
    <details class="panel">
      <summary>Feed</summary>
      <div class="grid">
        <label class="field"><span>Source</span><select data-feed>${feedOpts}</select></label>
        <label class="field" data-for="key"><span>API key</span><input type="password" data-key placeholder="stored in this browser only" value="${escapeAttr(settings.apiKey)}"></label>
        <label class="field wide" data-for="bridge" title="Local bars bridge for the Robinhood feed — see bridge/README.md"><span>Bridge URL</span><input type="text" data-bridge value="${escapeAttr(settings.bridgeUrl)}"></label>
        <label class="field" data-for="replay" title="Massive replay: seconds of tape consumed per wall-clock second. Raising it shortens every time constant in market time by the same factor."><span>Replay speed (x)</span><input type="number" data-speed min="1" max="60" step="1" value="${settings.replaySpeed}"></label>
        <label class="field" data-for="replay" title="Massive replay: session to play back. Leave empty to use the most recent session with data."><span>Replay date</span><input type="date" data-replaydate value="${escapeAttr(settings.replayDate)}"></label>
        <label class="field wide" title="Comma-separated tickers. *core is the built-in liquid US list (*core:50 for the first 50). *scan takes the current Robinhood screener results from the bridge, in the scanner's own order (*scan:20 for its top 20)."><span>Watchlist — <code>*core</code> built-in list, <code>*scan</code> Robinhood screener</span><input type="text" data-symbols value="${escapeAttr(settings.symbols)}"></label>
      </div>
      <button data-restart class="btn">Reconnect feed</button>
      <p class="hint" data-feedhint></p>
    </details>
    <details class="panel">
      <summary>Estimator</summary>
      <div class="grid">${numFields}</div>
    </details>
    <details class="panel">
      <summary>Signal weights</summary>
      <div class="grid weights">${weightFields}</div>
    </details>
    <details class="panel">
      <summary>How the score works</summary>
      <div class="prose">
        <p>Two-stage normalization. Each raw signal is first standardized <em>within</em> the
        ticker against a time-of-day conditional baseline, because 50M-share and 200k-share
        names are not comparable in raw units. The resulting z-scores are then converted to
        <em>percentile ranks across the cross-section</em>, which bounds every input to
        [0,&nbsp;1] so one 40-sigma microcap cannot swamp the blend.</p>
        <p>The published ordering uses the smoothed composite with a Schmitt trigger on
        membership (enter above θ<sub>in</sub>, leave below θ<sub>out</sub>), so rows do not
        chatter at the boundary. <strong>Robust</strong> is the share of five ensemble members
        — instantaneous, fast, slow, window mean, window median — that independently place the
        ticker in the top N. <strong>Fcst</strong> is their majority vote on rank direction over
        the forecast horizon.</p>
        <p class="warn">This is a monitoring and discovery tool, not a trading signal. By the
        time a name is #1 on an attention board, the move has largely happened and the spread
        has widened.</p>
      </div>
    </details>`;

  const emit = (restart: boolean) => {
    saveSettings(settings);
    onChange(settings, restart);
  };

  const sortHintEl = root.querySelector<HTMLElement>('[data-sorthint]')!;
  // One short line on screen, the full reasoning on hover. These caveats matter
  // but they are read once, and leaving them expanded pushed the board itself
  // off the page.
  const renderSortHint = () => {
    const h = HORIZONS.find((x) => x.id === settings.config.sortHorizon);
    const offTape = (h?.seconds ?? 0) > 4 * 3600;
    const short: string[] = [];
    const long: string[] = [];

    if (offTape) {
      short.push('daily closes, via bridge');
      long.push(
        'This lookback is longer than the live tape reaches, so it comes from daily closes through the bridge — Robinhood provider only, refreshed every few minutes.',
      );
    } else {
      short.push("from this session's tape");
      long.push(
        'Measured from the tape this session has seen; rows show an em dash until the board has been open that long.',
      );
    }
    if (settings.config.sortBy !== 'score') {
      short.push('thresholds bypassed');
      long.push(
        'Sorting by change bypasses the enter/exit thresholds, which are calibrated for the 0-1 score and mean nothing as a percentage, so expect a livelier list. Robust and Fcst still describe the attention score, not this ordering.',
      );
    }
    sortHintEl.textContent = short.join(' · ');
    sortHintEl.title = long.join(' ');
  };
  renderSortHint();

  root.querySelector<HTMLSelectElement>('[data-sortby]')!.addEventListener('change', (e) => {
    settings.config.sortBy = (e.target as HTMLSelectElement).value as SortBy;
    renderSortHint();
    emit(false);
  });
  root.querySelector<HTMLSelectElement>('[data-horizon]')!.addEventListener('change', (e) => {
    settings.config.sortHorizon = (e.target as HTMLSelectElement).value;
    renderSortHint();
    emit(false);
  });

  const hintEl = root.querySelector<HTMLElement>('[data-feedhint]')!;

  /**
   * Show only the settings the selected source actually reads. A key box on a
   * feed that has no key, or a replay date on a live socket, is a control that
   * silently does nothing — worse than absent, because it invites you to fill
   * it in and then wonder why nothing changed.
   */
  const applies: Record<string, (feed: FeedId) => boolean> = {
    key: (feed) => FEEDS_NEEDING_KEY.includes(feed),
    bridge: (feed) => FEEDS_USING_BRIDGE.includes(feed),
    replay: (feed) => feed === 'replay',
  };

  const renderFeedFields = () => {
    hintEl.textContent = FEED_HINT[settings.feed] ?? '';
    for (const el of root.querySelectorAll<HTMLElement>('[data-for]')) {
      const relevant = applies[el.dataset.for ?? '']?.(settings.feed) ?? true;
      el.hidden = !relevant;
    }
  };
  renderFeedFields();

  root.querySelector<HTMLSelectElement>('[data-feed]')!.addEventListener('change', (e) => {
    settings.feed = (e.target as HTMLSelectElement).value as FeedId;
    // Some sources carry no quote data, and there the quote-churn signal would
    // be a constant across every ticker — a tie that adds nothing but noise.
    if (FEEDS_WITHOUT_QUOTES.includes(settings.feed) && settings.config.weights.quotes > 0) {
      settings.config.weights.quotes = 0;
      const slider = root.querySelector<HTMLInputElement>('[data-w="quotes"]');
      const out = root.querySelector<HTMLOutputElement>('[data-wout="quotes"]');
      if (slider) slider.value = '0';
      if (out) out.value = '0.00';
    }
    renderFeedFields();
    emit(true);
  });
  root.querySelector<HTMLInputElement>('[data-key]')!.addEventListener('change', (e) => {
    settings.apiKey = (e.target as HTMLInputElement).value.trim();
    emit(true);
  });
  root.querySelector<HTMLInputElement>('[data-symbols]')!.addEventListener('change', (e) => {
    settings.symbols = (e.target as HTMLInputElement).value;
    emit(true);
  });
  root.querySelector<HTMLInputElement>('[data-bridge]')!.addEventListener('change', (e) => {
    settings.bridgeUrl = (e.target as HTMLInputElement).value.trim();
    emit(true);
  });
  root.querySelector<HTMLInputElement>('[data-speed]')!.addEventListener('change', (e) => {
    settings.replaySpeed = clampInt((e.target as HTMLInputElement).value, 1, 60, 10);
    emit(true);
  });
  root.querySelector<HTMLInputElement>('[data-replaydate]')!.addEventListener('change', (e) => {
    settings.replayDate = (e.target as HTMLInputElement).value.trim();
    emit(true);
  });
  root.querySelector<HTMLButtonElement>('[data-restart]')!.addEventListener('click', () => emit(true));

  root.querySelectorAll<HTMLInputElement>('[data-cfg]').forEach((input) => {
    input.addEventListener('change', () => {
      const key = input.dataset.cfg as keyof EngineConfig;
      const v = Number(input.value);
      if (Number.isFinite(v) && key !== 'weights') {
        (settings.config[key] as number) = v;
        emit(false);
      }
    });
  });

  root.querySelectorAll<HTMLInputElement>('[data-w]').forEach((input) => {
    input.addEventListener('input', () => {
      const k = input.dataset.w as SignalKey;
      settings.config.weights[k] = Number(input.value);
      const out = root.querySelector<HTMLOutputElement>(`[data-wout="${k}"]`);
      if (out) out.value = Number(input.value).toFixed(2);
      emit(false);
    });
  });
}

function clampInt(v: string, lo: number, hi: number, dflt: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
