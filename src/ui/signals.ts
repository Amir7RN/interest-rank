import type { SignalPanels, SignalRow, Snapshot } from '../types.ts';

/**
 * The two displacement panels.
 *
 * Left: stretched below its own trailing mean. Right: stretched above it. Both
 * restricted to names whose recent behaviour is statistically distinguishable
 * from a random walk on the mean-reverting side, whose reversion is fast enough
 * to resolve inside a session, and whose expected move clears assumed costs.
 *
 * They are labelled by what they measure rather than by what someone might do
 * about it. A panel headed "BUY" asserts something this data cannot support;
 * "stretched below, in a reverting regime" asserts exactly what was computed,
 * and leaves the decision where it belongs.
 */
export class SignalBoard {
  private root: HTMLElement;
  private downBody: HTMLElement;
  private upBody: HTMLElement;
  private meta: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
    this.root.innerHTML = `
      <div class="sig-meta" data-meta></div>
      <div class="sig-cols">
        ${panelMarkup('down', 'Stretched below', 'Trading under its own trailing mean, in a regime that has been pulling back toward it')}
        ${panelMarkup('up', 'Stretched above', 'Trading over its own trailing mean, in a regime that has been pulling back toward it')}
      </div>`;
    this.downBody = this.root.querySelector('[data-body="down"]')!;
    this.upBody = this.root.querySelector('[data-body="up"]')!;
    this.meta = this.root.querySelector('[data-meta]')!;
  }

  render(snap: Snapshot): void {
    const s = snap.signals;
    this.meta.innerHTML = metaLine(s);
    this.fill(this.downBody, s.down, s, 'down');
    this.fill(this.upBody, s.up, s, 'up');
  }

  private fill(body: HTMLElement, rows: SignalRow[], s: SignalPanels, side: 'down' | 'up'): void {
    if (rows.length === 0) {
      body.innerHTML = `<tr class="sig-empty"><td colspan="6">${emptyReason(s, side)}</td></tr>`;
      return;
    }
    body.innerHTML = rows
      .map(
        (r) => `
        <tr>
          <td class="sym">${r.sym}</td>
          <td class="num">${r.price.toFixed(2)}</td>
          <td class="num ${r.z < 0 ? 'down' : 'up'}" title="displacement from its trailing mean, in this ticker's own sigma">${r.z >= 0 ? '+' : ''}${r.z.toFixed(1)}σ</td>
          <td class="num" title="variance ratio ${r.vr.toFixed(2)} · Lo-MacKinlay z ${r.vrZ.toFixed(1)} · ${r.n} bars">${r.vr.toFixed(2)}</td>
          <td class="num" title="time for half the deviation to decay, at the fitted rate">${fmtHalfLife(r.halfLifeSec)}</td>
          <td class="num ${r.netEdge > 0 ? 'up' : ''}" title="expected move ${(r.expectedMove * 100).toFixed(2)}% less ${(s.costFraction * 100).toFixed(2)}% costs">${(r.netEdge * 100).toFixed(2)}%</td>
        </tr>`,
      )
      .join('');
  }
}

function panelMarkup(side: 'down' | 'up', title: string, subtitle: string): string {
  return `
    <section class="sig-panel">
      <h2>${title}</h2>
      <p class="sig-sub">${subtitle}</p>
      <table class="sig-table">
        <thead>
          <tr>
            <th>Symbol</th>
            <th class="num">Last</th>
            <th class="num" title="Displacement from the trailing mean, in the ticker's own sigma">Disp</th>
            <th class="num" title="Variance ratio. Below 1 means moves get partly taken back; 1 is a random walk.">VR</th>
            <th class="num" title="Half-life of the deviation at the fitted rate">Half-life</th>
            <th class="num" title="Expected move if the deviation halves, less assumed round-trip cost">Edge</th>
          </tr>
        </thead>
        <tbody data-body="${side}"></tbody>
      </table>
    </section>`;
}

function metaLine(s: SignalPanels): string {
  if (s.evaluated === 0) {
    return `<span class="warn">Collecting history — a regime needs about 10 minutes of bars per ticker before it can be fitted at all.</span>`;
  }
  const noise = s.falseLabels;
  return [
    `${s.evaluated} fitted`,
    `${s.reverting} reverting`,
    // The single most important number here: how much of that count is nothing.
    `<span class="warn" title="Screening this many names, a universe of pure random walks would produce about this many 'reverting' labels by chance alone">~${noise.toFixed(1)} expected by chance</span>`,
    `costs ${(s.costFraction * 100).toFixed(2)}% round trip`,
  ].join('<span class="sep">·</span>');
}

function emptyReason(s: SignalPanels, side: 'down' | 'up'): string {
  if (s.evaluated === 0) return 'Collecting price history…';
  if (s.reverting === 0) {
    return `None of the ${s.evaluated} names fitted are mean-reverting right now. That is the ordinary result — equity returns are close to a random walk at most horizons.`;
  }
  return `No ${side === 'down' ? 'oversold' : 'overbought'} name currently clears costs. A displacement that cannot pay the spread is not an opportunity.`;
}

function fmtHalfLife(sec: number | null): string {
  if (sec === null) return '—';
  if (sec < 90) return `${Math.round(sec)}s`;
  if (sec < 5400) return `${Math.round(sec / 60)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
}
