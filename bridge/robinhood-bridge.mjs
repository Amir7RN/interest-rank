#!/usr/bin/env node
/**
 * Local bars bridge for Interest Rank.
 *
 * The board runs in a browser, and a browser cannot fetch Robinhood directly:
 * there is no CORS grant and no anonymous access. This process sits on
 * localhost, fetches bars from whichever provider you configure, and serves
 * them to the page in one normalized shape.
 *
 *   GET /bars?symbols=NVDA,AMD,SNDK   ->  {interval_sec, bars: [...], note?}
 *   GET /scan                         ->  {title, symbols: [...], rows: [...], note?}
 *   GET /health                       ->  {ok, provider, symbols, ...}
 *
 * Deliberate constraints:
 *   - binds 127.0.0.1 only, so nothing off this machine can reach it
 *   - serves market data and nothing else: there is no order path here, and
 *     none should ever be added to this file
 *   - reads credentials from the environment, never from a committed file
 *
 * Providers:
 *   snapshot (default)  Serve bars from a JSON file. No credentials. Use for
 *                       replaying a recorded session or driving the board when
 *                       the market is closed.
 *   robinhood           Fetch live bars from Robinhood using a session token
 *                       you supply yourself via RH_TOKEN. See README.md.
 *
 * Usage:
 *   node robinhood-bridge.mjs                       # snapshot provider, sample file
 *   node robinhood-bridge.mjs --file my-session.json
 *   RH_TOKEN=... node robinhood-bridge.mjs --provider robinhood
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const args = parseArgs(process.argv.slice(2));
const PORT = Number(args.port ?? process.env.BRIDGE_PORT ?? 8787);
const PROVIDER = String(args.provider ?? process.env.BRIDGE_PROVIDER ?? 'snapshot');
const INTERVAL_SEC = Number(args.interval ?? 15);
const SNAPSHOT_FILE = path.resolve(HERE, String(args.file ?? 'snapshot.sample.json'));
/** Scanner results, written by whatever runs the Robinhood screener. See /scan below. */
const SCAN_FILE = path.resolve(HERE, String(args['scan-file'] ?? 'scan.json'));
/** Replay speed for the snapshot provider: 1 = wall-clock. */
const SPEED = Number(args.speed ?? 1);
const LOOP = args.loop !== 'false';
/** Symbol ceiling and inter-batch spacing for the Robinhood provider. */
const MAX_SYMBOLS = Number(args['max-symbols'] ?? 200);
const BATCH_DELAY_MS = Number(args['batch-delay'] ?? 150);

/* ------------------------------------------------------------------ *
 * Provider: snapshot
 * ------------------------------------------------------------------ */

let snapshot = null;
let replayStart = 0;
let firstBarMs = 0;
/** length of the recording, used to advance timestamps on each loop */
let spanMs = 0;
let loops = 0;

function loadSnapshot() {
  const raw = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
  const bars = (raw.bars ?? []).slice().sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  if (bars.length === 0) throw new Error(`no bars in ${SNAPSHOT_FILE}`);
  snapshot = { ...raw, bars };
  firstBarMs = Date.parse(bars[0].t);
  spanMs = Date.parse(bars[bars.length - 1].t) - firstBarMs + INTERVAL_SEC * 1000;
  replayStart = Date.now();
  const symbols = new Set(bars.map((b) => b.sym));
  console.log(
    `[snapshot] ${bars.length} bars, ${symbols.size} symbols, ` +
      `${new Date(firstBarMs).toISOString()} -> ${bars[bars.length - 1].t}`,
  );
}

/**
 * Return the bars whose timestamp has "arrived" since the last poll, walking
 * the recording forward at `SPEED` x wall-clock. Each poll returns only what is
 * newly due, so the page sees a live-shaped trickle rather than the whole file.
 */
let replayCursor = 0;
function snapshotBars(symbols) {
  const elapsed = (Date.now() - replayStart) * SPEED;
  const now = firstBarMs + elapsed;
  const out = [];
  while (replayCursor < snapshot.bars.length) {
    const bar = snapshot.bars[replayCursor];
    if (Date.parse(bar.t) > now) break;
    replayCursor++;
    if (!symbols.length || symbols.includes(bar.sym)) {
      // Advance timestamps by one recording-length per loop. Consumers dedupe
      // on (symbol, timestamp), so replaying the original timestamps would look
      // like bars they have already seen and the feed would go silent forever
      // after the first pass.
      out.push(loops === 0 ? bar : { ...bar, t: shiftTime(bar.t, loops * spanMs) });
    }
  }
  if (replayCursor >= snapshot.bars.length && LOOP) {
    replayCursor = 0;
    replayStart = Date.now();
    loops++;
  }
  return out;
}

function shiftTime(iso, deltaMs) {
  return new Date(Date.parse(iso) + deltaMs).toISOString();
}

/* ------------------------------------------------------------------ *
 * Provider: robinhood
 * ------------------------------------------------------------------ */

const RH_HISTORICALS = 'https://api.robinhood.com/marketdata/historicals/';

/**
 * Fetch 15-second bars for up to 10 symbols.
 *
 * RH_TOKEN must be a Robinhood session bearer token that you obtain yourself —
 * see README.md. It is read from the environment and never logged, echoed on
 * /health, or written to disk by this process.
 */
async function fetchBatch(symbols, token) {
  const url =
    `${RH_HISTORICALS}?symbols=${encodeURIComponent(symbols.join(','))}` +
    `&interval=15second&span=hour&bounds=regular`;

  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error('Robinhood rejected the token (401/403) — it likely expired; refresh RH_TOKEN');
  }
  if (res.status === 429) {
    throw new Error('Robinhood rate-limited the bridge (429) — reduce the watchlist or raise --batch-delay');
  }
  if (!res.ok) throw new Error(`Robinhood responded ${res.status}`);

  const body = await res.json();
  const out = [];
  for (const result of body.results ?? []) {
    const sym = result.symbol;
    for (const b of result.historicals ?? []) {
      out.push({
        sym,
        t: b.begins_at,
        o: Number(b.open_price),
        h: Number(b.high_price),
        l: Number(b.low_price),
        c: Number(b.close_price),
        v: Number(b.volume),
      });
    }
  }
  return out;
}

/**
 * Robinhood accepts 10 symbols per call, so a wider watchlist is fanned out
 * across sequential batches with a delay between them. Sequential and spaced
 * on purpose: this is one person's account hitting a broker's API, not a market
 * data entitlement, and hammering it in parallel is how you get rate-limited.
 *
 * That sets a practical ceiling. At the default 150 ms spacing, 200 symbols is
 * 20 calls ≈ 3 s per refresh — comfortable. Several thousand is not reachable
 * this way and should not be attempted; that needs a real SIP feed.
 */
async function robinhoodBars(symbols) {
  const token = process.env.RH_TOKEN;
  if (!token) throw new Error('RH_TOKEN is not set — see bridge/README.md');

  const wanted = symbols.slice(0, MAX_SYMBOLS);
  const out = [];
  for (let i = 0; i < wanted.length; i += 10) {
    const batch = wanted.slice(i, i + 10);
    out.push(...(await fetchBatch(batch, token)));
    if (i + 10 < wanted.length) await sleep(BATCH_DELAY_MS);
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Only hand back bars newer than the newest one already delivered per symbol. */
const delivered = new Map();
function onlyNew(bars) {
  const out = [];
  for (const bar of bars) {
    const seen = delivered.get(bar.sym);
    if (seen && bar.t <= seen) continue;
    delivered.set(bar.sym, bar.t);
    out.push(bar);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Scanner results
 * ------------------------------------------------------------------ */

/**
 * Robinhood's screener ("Legend scanner") picks *which* names are worth
 * watching; this board ranks them once they are picked. The two answer
 * different questions, so the scanner feeds the watchlist rather than replacing
 * the score.
 *
 * The screener is not on the public market-data API this bridge already speaks,
 * so results arrive here as a file rather than a live call. Anything that can
 * reach the scanner writes it — the Robinhood MCP server's `run_scan`, a
 * scheduled job, or an export from Legend — and this endpoint serves whatever
 * is currently on disk, re-read per request so a regenerated file takes effect
 * without a restart.
 *
 * Expected shape (extra keys are passed through untouched):
 *
 *   {
 *     "title": "Unusual volume",
 *     "generated_at": "2026-08-18T13:45:00Z",
 *     "rows": [ { "symbol": "NVDA", "relative_volume": 4.2 }, ... ]
 *   }
 *
 * `symbols` is derived from `rows` in order, so the scanner's own sort is what
 * the page receives.
 */
function readScan() {
  if (!fs.existsSync(SCAN_FILE)) {
    return {
      title: null,
      symbols: [],
      rows: [],
      note: `no scan file at ${path.basename(SCAN_FILE)} — generate one, or pass --scan-file`,
    };
  }
  const raw = JSON.parse(fs.readFileSync(SCAN_FILE, 'utf8'));
  const rows = Array.isArray(raw.rows) ? raw.rows : [];
  const symbols = [];
  for (const row of rows) {
    const sym = String(row.symbol ?? row.sym ?? '').trim().toUpperCase();
    if (sym && !symbols.includes(sym)) symbols.push(sym);
  }
  const age = raw.generated_at ? describeAge(Date.parse(raw.generated_at)) : null;
  return {
    title: raw.title ?? null,
    generated_at: raw.generated_at ?? null,
    symbols,
    rows,
    // Staleness is the whole risk with a file-backed scan, so it is stated
    // rather than left for the reader to work out from a timestamp.
    note: `${symbols.length} symbols${raw.title ? ` from "${raw.title}"` : ''}${age ? `, ${age}` : ''}`,
  };
}

function describeAge(ms) {
  if (!Number.isFinite(ms)) return null;
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return 'just generated';
  if (mins < 60) return `${mins} min old`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h old`;
  return `${Math.round(hours / 24)}d old`;
}

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

let lastError = null;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  // The page is served from localhost (Vite dev server or preview), so allow
  // any localhost origin and nothing else.
  const origin = req.headers.origin ?? '';
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    res.setHeader('access-control-allow-origin', origin);
  }
  res.setHeader('vary', 'origin');
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }
  if (req.method !== 'GET') {
    return json(res, 405, { error: 'only GET is supported' });
  }

  if (url.pathname === '/health') {
    return json(res, 200, {
      ok: true,
      provider: PROVIDER,
      interval_sec: INTERVAL_SEC,
      snapshot_file: PROVIDER === 'snapshot' ? path.basename(SNAPSHOT_FILE) : undefined,
      token_present: PROVIDER === 'robinhood' ? Boolean(process.env.RH_TOKEN) : undefined,
      scan_file: path.basename(SCAN_FILE),
      scan_present: fs.existsSync(SCAN_FILE),
      last_error: lastError,
    });
  }

  if (url.pathname === '/scan') {
    try {
      return json(res, 200, readScan());
    } catch (err) {
      const message = `could not read ${path.basename(SCAN_FILE)}: ${err.message ?? err}`;
      console.error('[scan]', message);
      return json(res, 502, { error: message, symbols: [], rows: [] });
    }
  }

  if (url.pathname === '/bars') {
    const symbols = (url.searchParams.get('symbols') ?? '')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    try {
      let bars;
      let note;
      if (PROVIDER === 'robinhood') {
        bars = onlyNew(await robinhoodBars(symbols));
        const batches = Math.ceil(Math.min(symbols.length, MAX_SYMBOLS) / 10);
        note = `${Math.min(symbols.length, MAX_SYMBOLS)} symbols in ${batches} batches`;
        if (symbols.length > MAX_SYMBOLS) {
          note += ` (watchlist truncated from ${symbols.length}; raise --max-symbols to lift it)`;
        }
      } else {
        bars = snapshotBars(symbols);
        note = `replaying ${path.basename(SNAPSHOT_FILE)}${SPEED !== 1 ? ` at ${SPEED}x` : ''}`;
      }
      lastError = null;
      return json(res, 200, { interval_sec: INTERVAL_SEC, bars, note });
    } catch (err) {
      lastError = String(err.message ?? err);
      console.error('[bars]', lastError);
      return json(res, 502, { error: lastError, interval_sec: INTERVAL_SEC, bars: [] });
    }
  }

  return json(res, 404, { error: 'not found' });
});

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq !== -1) out[arg.slice(2, eq)] = arg.slice(eq + 1);
    else out[arg.slice(2)] = argv[i + 1]?.startsWith('--') ? 'true' : (argv[++i] ?? 'true');
  }
  return out;
}

if (PROVIDER === 'snapshot') loadSnapshot();
if (PROVIDER === 'robinhood' && !process.env.RH_TOKEN) {
  console.warn('[warn] provider=robinhood but RH_TOKEN is unset — /bars will return 502');
}

// A port collision is the most likely startup failure — usually a bridge left
// running in another terminal. Say that, instead of dumping a stack trace.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use — a bridge is probably still running.\n`);
    console.error('Either use the one that is already up (check it with):');
    console.error(`  curl http://127.0.0.1:${PORT}/health\n`);
    console.error('or start this one on a different port, and set the same URL as "Bridge URL" in the app:');
    console.error(`  node bridge/robinhood-bridge.mjs --port ${PORT + 1}\n`);
    console.error('To stop the existing one:');
    console.error(
      process.platform === 'win32'
        ? `  powershell -c "Stop-Process -Id (Get-NetTCPConnection -LocalPort ${PORT} -State Listen).OwningProcess -Force"\n`
        : `  kill $(lsof -ti tcp:${PORT})\n`,
    );
    process.exit(1);
  }
  console.error(`bridge failed to start: ${err.message}`);
  process.exit(1);
});

// 127.0.0.1 only: not reachable from another machine on the network.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`bridge listening on http://127.0.0.1:${PORT}  (provider: ${PROVIDER})`);
  console.log(`  GET /bars?symbols=NVDA,AMD   GET /scan   GET /health`);
  console.log(`  scan file: ${path.basename(SCAN_FILE)}${fs.existsSync(SCAN_FILE) ? '' : ' (not present yet)'}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('\nbridge stopped');
    server.close(() => process.exit(0));
    // Don't hang on a client holding the connection open.
    setTimeout(() => process.exit(0), 500).unref();
  });
}
