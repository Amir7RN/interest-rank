#!/usr/bin/env node
/**
 * Measure a dip-buying rule instead of arguing about it.
 *
 * The rule: when a stock trades `drop`% below its session open, buy. Sell at
 * `target`% above the entry if it gets there, otherwise sell at the close.
 * That is the "it fell 5%, it'll bounce 5%" idea, stated precisely enough to
 * be checked.
 *
 * What this prints, and why each column is there:
 *
 *   n         Trades. An average over 20 trades is a rumour, not a result.
 *   win%      Share that made money. Deliberately NOT the headline: a rule can
 *             win 80% of the time and still lose, if the 20% are large enough.
 *   mean      Average return per trade, after costs.
 *   sd        Spread of outcomes. The reason a good-looking mean can be noise.
 *   t         mean / (sd/sqrt(n)). Below ~2, the edge is indistinguishable
 *             from luck no matter how pretty the mean looks.
 *   n@t=2     Trades you would need, at this mean and sd, before the result
 *             could be called real. Usually the most sobering number here.
 *   worst     Largest single loss. Compare it to `mean`: if one bad trade
 *             erases fifty good ones, the average is not the risk.
 *
 * Exits are optimistic by construction: a target counts as filled the moment a
 * bar's high touches it, with no slippage and no partial fills, and entry is at
 * the trigger bar's close. Real results will be worse than these, never better.
 *
 * Usage (needs the bridge running with --provider robinhood):
 *   node scripts/backtest.mjs
 *   node scripts/backtest.mjs --symbols SNDK,MU,AMD --span 3month --interval 5minute
 *   node scripts/backtest.mjs --costbps 10 --drops 3,5,7 --targets 1,2,3,5
 */

const args = parseArgs(process.argv.slice(2));
const BRIDGE = String(args.bridge ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const SYMBOLS = String(args.symbols ?? 'SNDK,MU,AMD,NVDA,INTC,MRVL,ON,SOFI,HOOD,SMCI');
const INTERVAL = String(args.interval ?? '5minute');
const SPAN = String(args.span ?? 'month');
const COST = Number(args.costbps ?? 10) / 10_000;
const DROPS = String(args.drops ?? '3,5').split(',').map(Number);
const TARGETS = String(args.targets ?? '1,2,3,5').split(',').map(Number);

let body;
if (args.file) {
  // Same payload shape as /history, so a saved pull can be re-measured without
  // hitting the API again — and so this file's arithmetic can be tested.
  const fs = await import('node:fs');
  body = JSON.parse(fs.readFileSync(String(args.file), 'utf8'));
} else {
  const res = await fetch(
    `${BRIDGE}/history?symbols=${encodeURIComponent(SYMBOLS)}&interval=${INTERVAL}&span=${SPAN}&bounds=regular`,
  );
  body = await res.json();
  if (!res.ok || body.error) {
    console.error(`bridge: ${body.error ?? res.status}`);
    console.error('start it with: node bridge/robinhood-bridge.mjs --provider robinhood');
    process.exit(1);
  }
}
console.log(body.note ?? '');

/** Group bars into (symbol, session) days, regular hours only. */
const sessions = [];
for (const [sym, bars] of Object.entries(body.bars ?? {})) {
  const byDay = new Map();
  for (const b of bars) {
    const et = new Date(b.t);
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(et);
    const get = (k) => parts.find((p) => p.type === k)?.value ?? '';
    const day = `${get('year')}-${get('month')}-${get('day')}`;
    const mins = Number(get('hour')) * 60 + Number(get('minute'));
    if (mins < 9 * 60 + 30 || mins >= 16 * 60) continue;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(b);
  }
  for (const [day, list] of byDay) {
    if (list.length > 5) sessions.push({ sym, day, bars: list });
  }
}
console.log(`${sessions.length} symbol-sessions across ${new Set(sessions.map((s) => s.sym)).size} symbols\n`);

const rows = [];
for (const drop of DROPS) {
  for (const target of TARGETS) {
    rows.push(evaluate(sessions, drop / 100, target / 100));
  }
}

const head = ['drop', 'target', 'n', 'win%', 'mean%', 'sd%', 't', 'n@t=2', 'worst%', '$/trade@1k'];
const widths = head.map((h) => h.length);
const table = rows.map((r) => [
  `-${(r.drop * 100).toFixed(0)}%`,
  `+${(r.target * 100).toFixed(0)}%`,
  String(r.n),
  r.n ? (100 * r.winRate).toFixed(0) : '—',
  r.n ? (100 * r.mean).toFixed(3) : '—',
  r.n ? (100 * r.sd).toFixed(2) : '—',
  r.n ? r.t.toFixed(2) : '—',
  r.needed === null ? '—' : String(r.needed),
  r.n ? (100 * r.worst).toFixed(2) : '—',
  r.n ? (1000 * r.mean).toFixed(2) : '—',
]);
for (const row of table) row.forEach((cell, i) => (widths[i] = Math.max(widths[i], cell.length)));
const line = (cells) => cells.map((c, i) => c.padStart(widths[i])).join('  ');
console.log(line(head));
console.log(widths.map((w) => '-'.repeat(w)).join('  '));
for (const row of table) console.log(line(row));

const best = rows.filter((r) => r.n > 0).sort((a, b) => b.t - a.t)[0];
console.log('');
if (!best) {
  console.log('No rule triggered. Widen --span, lower --drops, or add symbols.');
} else if (best.t < 2) {
  console.log(
    `Strongest result is t=${best.t.toFixed(2)} on ${best.n} trades — below 2, so it cannot be ` +
      `distinguished from luck. At this mean and spread you would need about ${best.needed} trades to tell.`,
  );
} else {
  console.log(
    `Strongest result is t=${best.t.toFixed(2)} on ${best.n} trades. That clears the usual bar, but it is ` +
      `one rule measured on one period with optimistic fills — re-run it on a different span before believing it.`,
  );
}
console.log('Fills here are optimistic: no slippage, no partial fills. Live results run worse.');

/** One (drop, target) rule over every session. */
function evaluate(sessions, drop, target) {
  const returns = [];
  for (const { bars } of sessions) {
    const open = bars[0].o;
    if (!(open > 0)) continue;
    const trigger = bars.findIndex((b) => b.c <= open * (1 - drop));
    if (trigger === -1) continue;
    const entry = bars[trigger].c;
    if (!(entry > 0)) continue;
    const after = bars.slice(trigger + 1);
    if (after.length === 0) continue;
    const hit = after.some((b) => b.h >= entry * (1 + target));
    const gross = hit ? target : after[after.length - 1].c / entry - 1;
    returns.push(gross - COST);
  }
  const n = returns.length;
  if (n === 0) return { drop, target, n: 0, winRate: 0, mean: 0, sd: 0, t: 0, needed: null, worst: 0 };
  const mean = returns.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(returns.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  const t = sd > 0 ? mean / (sd / Math.sqrt(n)) : 0;
  // Trades required for |t| = 2 at this mean and spread.
  const needed = mean !== 0 && sd > 0 ? Math.ceil((2 * sd / Math.abs(mean)) ** 2) : null;
  return {
    drop, target, n, mean, sd, t, needed,
    winRate: returns.filter((r) => r > 0).length / n,
    worst: Math.min(...returns),
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq !== -1) out[a.slice(2, eq)] = a.slice(eq + 1);
    else out[a.slice(2)] = argv[i + 1]?.startsWith('--') ? 'true' : (argv[++i] ?? 'true');
  }
  return out;
}
