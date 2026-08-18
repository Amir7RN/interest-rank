import { FEED_IDS, FEED_LABEL, type FeedId } from '../feeds/index.ts';
import { DEFAULT_CONFIG, SIGNAL_KEYS, SIGNAL_LABEL, type EngineConfig, type SignalKey } from '../types.ts';

export interface AppSettings {
  feed: FeedId;
  apiKey: string;
  symbols: string;
  universe: number;
  config: EngineConfig;
}

const KEY = 'interest-rank.settings.v1';

export function loadSettings(): AppSettings {
  const base: AppSettings = {
    feed: 'sim',
    apiKey: '',
    symbols: 'AAPL,MSFT,NVDA,AMD,TSLA,SNDK,MU,INTC,SPY,QQQ',
    universe: 800,
    config: { ...DEFAULT_CONFIG, weights: { ...DEFAULT_CONFIG.weights } },
  };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return base;
    const saved = JSON.parse(raw) as Partial<AppSettings>;
    return {
      ...base,
      ...saved,
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

  root.innerHTML = `
    <details class="panel" open>
      <summary>Feed</summary>
      <div class="grid">
        <label class="field"><span>Source</span><select data-feed>${feedOpts}</select></label>
        <label class="field"><span>API key</span><input type="password" data-key placeholder="stored in this browser only" value="${escapeAttr(settings.apiKey)}"></label>
        <label class="field"><span>Sim universe</span><input type="number" data-universe min="50" max="8000" step="50" value="${settings.universe}"></label>
        <label class="field wide"><span>Watchlist (Finnhub)</span><input type="text" data-symbols value="${escapeAttr(settings.symbols)}"></label>
      </div>
      <button data-restart class="btn">Reconnect feed</button>
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

  root.querySelector<HTMLSelectElement>('[data-feed]')!.addEventListener('change', (e) => {
    settings.feed = (e.target as HTMLSelectElement).value as FeedId;
    emit(true);
  });
  root.querySelector<HTMLInputElement>('[data-key]')!.addEventListener('change', (e) => {
    settings.apiKey = (e.target as HTMLInputElement).value.trim();
    emit(true);
  });
  root.querySelector<HTMLInputElement>('[data-universe]')!.addEventListener('change', (e) => {
    settings.universe = clampInt((e.target as HTMLInputElement).value, 50, 8000, 800);
    emit(true);
  });
  root.querySelector<HTMLInputElement>('[data-symbols]')!.addEventListener('change', (e) => {
    settings.symbols = (e.target as HTMLInputElement).value;
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
