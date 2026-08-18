import { SIGNAL_KEYS, SIGNAL_LABEL, type RankRow, type Snapshot } from '../types.ts';
import { sparkPath } from './sparkline.ts';

interface RowEls {
  tr: HTMLTableRowElement;
  rank: HTMLElement;
  delta: HTMLElement;
  sym: HTMLElement;
  price: HTMLElement;
  chg: HTMLElement;
  score: HTMLElement;
  bar: HTMLElement;
  spark: SVGPathElement;
  mean: HTMLElement;
  median: HTMLElement;
  mad: HTMLElement;
  rvol: HTMLElement;
  robust: HTMLElement;
  robustBar: HTMLElement;
  pred: HTMLElement;
  parts: HTMLElement;
  lastPrice: number;
}

const SPARK_W = 68;
const SPARK_H = 18;

/**
 * Incremental table. Rows are keyed by symbol and reused across snapshots:
 * only the text nodes whose values changed are touched, and reordering is a
 * FLIP animation rather than a re-render. Rebuilding 20 rows a second is
 * affordable but it kills text selection and makes the board feel like it is
 * flickering; keeping node identity fixes both.
 */
export class RankTable {
  private rows = new Map<string, RowEls>();
  private tbody: HTMLTableSectionElement;
  private empty: HTMLElement | null = null;
  private feedProblem: string | null = null;

  private root: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
    this.root.innerHTML = `
      <table class="board">
        <thead>
          <tr>
            <th class="num">#</th>
            <th class="num"></th>
            <th>Symbol</th>
            <th class="num">Last</th>
            <th class="num">Chg</th>
            <th class="num" title="Smoothed cross-sectional composite, 0-1">Score</th>
            <th title="Smoothed score over the window">Trend</th>
            <th class="num" title="Mean score over the window">Mean</th>
            <th class="num" title="Median score over the window">Med</th>
            <th class="num" title="Median absolute deviation of the score — low means the placement is stable">MAD</th>
            <th class="num" title="Volume vs. time-of-day expectation">RVOL</th>
            <th class="num" title="Share of ensemble members that also place this ticker in the top N">Robust</th>
            <th class="num" title="Majority vote of the ensemble on rank direction over the forecast horizon">Fcst</th>
            <th title="Percentile rank per signal">Signals</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
      <div class="empty-state" hidden></div>`;
    this.tbody = this.root.querySelector('tbody')!;
    this.empty = this.root.querySelector('.empty-state');
  }

  /**
   * An empty board is ambiguous — warming up, misconfigured, and disconnected
   * all look the same. Say which one it is, and what to do about it.
   */
  private renderEmptyState(snap: Snapshot): void {
    const el = this.empty;
    if (!el) return;
    if (snap.rows.length > 0) {
      el.hidden = true;
      return;
    }
    const s = snap.stats;
    let title: string;
    let detail: string;

    if (this.feedProblem) {
      title = 'No data reaching the board';
      detail = this.feedProblem;
    } else if (s.universe === 0) {
      title = 'Waiting for the first bars';
      detail =
        'The feed is connected but has not delivered any data yet. Outside market hours most feeds are silent — the simulator source works any time.';
    } else if (s.warming > 0) {
      title = 'Warming up baselines';
      detail =
        `${s.warming} of ${s.universe} tickers are still filling their per-ticker baselines. ` +
        `Each needs about ${s.warmupNeeded} seconds of data before it can be scored — ranking a ticker ` +
        `against a baseline it has not established yet would be noise, not attention.`;
    } else if (s.filtered > 0 && s.active === 0) {
      title = 'Every ticker is filtered out';
      detail =
        `${s.filtered} tickers have data but fall below the liquidity floors. Lower "Min price" or ` +
        `"Min ADV" under Estimator, or add more liquid symbols to the watchlist.`;
    } else {
      title = 'Nothing above the entry threshold';
      detail =
        `${s.active} tickers are eligible but none clear the entry threshold. Lower "Enter θ" under ` +
        `Estimator to admit quieter names.`;
    }
    el.innerHTML = `<b>${title}</b><span>${detail}</span>`;
    el.hidden = false;
  }

  /** Feed-level trouble, shown in the empty state — the table cannot infer it. */
  setFeedProblem(message: string | null): void {
    this.feedProblem = message;
  }

  render(snap: Snapshot): void {
    this.renderEmptyState(snap);
    const seen = new Set<string>();
    // FLIP: record positions before the DOM moves
    const before = new Map<string, number>();
    for (const [sym, els] of this.rows) before.set(sym, els.tr.getBoundingClientRect().top);

    let prevNode: HTMLTableRowElement | null = null;
    for (const row of snap.rows) {
      seen.add(row.sym);
      let els = this.rows.get(row.sym);
      if (!els) {
        els = this.createRow(row);
        this.rows.set(row.sym, els);
      }
      this.updateRow(els, row);

      const anchor: ChildNode | null = prevNode ? prevNode.nextSibling : this.tbody.firstChild;
      if (els.tr !== anchor) this.tbody.insertBefore(els.tr, anchor);
      prevNode = els.tr;
    }

    for (const [sym, els] of this.rows) {
      if (!seen.has(sym)) {
        els.tr.remove();
        this.rows.delete(sym);
      }
    }

    for (const [sym, els] of this.rows) {
      const y0 = before.get(sym);
      if (y0 === undefined) {
        els.tr.animate([{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], {
          duration: 220,
          easing: 'ease-out',
        });
        continue;
      }
      const dy = y0 - els.tr.getBoundingClientRect().top;
      if (Math.abs(dy) > 0.5) {
        els.tr.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], {
          duration: 260,
          easing: 'cubic-bezier(.2,.8,.2,1)',
        });
      }
    }
  }

  private createRow(row: RankRow): RowEls {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="num rank"></td>
      <td class="num delta"></td>
      <td class="sym"></td>
      <td class="num price"></td>
      <td class="num chg"></td>
      <td class="num score-cell"><span class="score"></span><span class="scorebar"><i></i></span></td>
      <td class="sparkcell"><svg width="${SPARK_W}" height="${SPARK_H}" viewBox="0 0 ${SPARK_W} ${SPARK_H}"><path fill="none" stroke="currentColor" stroke-width="1.4"/></svg></td>
      <td class="num mean"></td>
      <td class="num median"></td>
      <td class="num mad"></td>
      <td class="num rvol"></td>
      <td class="num robust"><span class="robustbar"><i></i></span><span class="robustval"></span></td>
      <td class="num pred"></td>
      <td class="parts"></td>`;
    tr.dataset.sym = row.sym;
    const q = <T extends Element>(s: string) => tr.querySelector(s) as unknown as T;
    return {
      tr,
      rank: q('.rank'),
      delta: q('.delta'),
      sym: q('.sym'),
      price: q('.price'),
      chg: q('.chg'),
      score: q('.score'),
      bar: q('.scorebar i'),
      spark: q<SVGPathElement>('path'),
      mean: q('.mean'),
      median: q('.median'),
      mad: q('.mad'),
      rvol: q('.rvol'),
      robust: q('.robustval'),
      robustBar: q('.robustbar i'),
      pred: q('.pred'),
      parts: q('.parts'),
      lastPrice: row.price,
    };
  }

  private updateRow(e: RowEls, r: RankRow): void {
    set(e.rank, String(r.rank));
    const d = r.prevRank === null ? null : r.prevRank - r.rank;
    set(e.delta, d === null ? 'new' : d === 0 ? '·' : d > 0 ? `▲${d}` : `▼${-d}`);
    const dir = d === null ? 'is-new' : d > 0 ? 'up' : d < 0 ? 'down' : 'flat';
    e.delta.className = `num delta ${dir}`;

    if (e.sym.textContent !== r.sym) {
      e.sym.textContent = r.sym;
      e.tr.dataset.sym = r.sym;
    }
    e.sym.className = `sym${r.held ? ' held' : ''}`;
    e.sym.title = r.held ? 'held in the list by hysteresis — score is below the entry threshold' : '';

    set(e.price, r.price.toFixed(2));
    if (r.price !== e.lastPrice) {
      flash(e.price, r.price > e.lastPrice);
      e.lastPrice = r.price;
    }
    set(e.chg, `${r.chg >= 0 ? '+' : ''}${(r.chg * 100).toFixed(2)}%`);
    e.chg.className = `num chg ${r.chg >= 0 ? 'up' : 'down'}`;

    set(e.score, r.score.toFixed(3));
    e.bar.style.width = `${Math.round(Math.min(1, Math.max(0, r.score)) * 100)}%`;
    e.spark.setAttribute('d', sparkPath(r.spark, SPARK_W, SPARK_H));
    e.spark.parentElement!.classList.toggle('rising', r.slope > 0);

    set(e.mean, r.mean.toFixed(3));
    set(e.median, r.median.toFixed(3));
    set(e.mad, r.mad.toFixed(3));
    set(e.rvol, r.rvol >= 100 ? `${Math.round(r.rvol)}x` : `${r.rvol.toFixed(1)}x`);

    const robustPct = Math.round(r.robust * 100);
    set(e.robust, `${robustPct}%`);
    e.robustBar.style.width = `${robustPct}%`;
    e.robustBar.className = robustPct >= 80 ? 'strong' : robustPct >= 50 ? 'ok' : 'weak';

    set(e.pred, `${r.pred} ${Math.round(r.predConf * 100)}%`);
    e.pred.className = `num pred ${r.pred.toLowerCase()}`;

    // signal breakdown as a stacked micro-bar; title carries the numbers
    let html = '';
    let title = '';
    for (const k of SIGNAL_KEYS) {
      const p = Math.round(r.parts[k] * 100);
      html += `<i class="sig-${k}" style="height:${Math.max(4, p)}%" ></i>`;
      title += `${SIGNAL_LABEL[k]}: ${p}%\n`;
    }
    if (e.parts.dataset.sig !== title) {
      e.parts.innerHTML = html;
      e.parts.title = title.trim();
      e.parts.dataset.sig = title;
    }
  }
}

function set(el: HTMLElement, v: string): void {
  if (el.textContent !== v) el.textContent = v;
}

function flash(el: HTMLElement, up: boolean): void {
  el.classList.remove('flash-up', 'flash-down');
  // force reflow so re-adding the class restarts the animation
  void el.offsetWidth;
  el.classList.add(up ? 'flash-up' : 'flash-down');
}
