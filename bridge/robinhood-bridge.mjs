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
/** Replay speed for the snapshot provider: 1 = wall-clock. */
const SPEED = Number(args.speed ?? 1);
const LOOP = args.loop !== 'false';

/* ------------------------------------------------------------------ *
 * Provider: snapshot
 * ------------------------------------------------------------------ */

let snapshot = null;
let replayStart = 0;
let firstBarMs = 0;

function loadSnapshot() {
  const raw = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
  const bars = (raw.bars ?? []).slice().sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  if (bars.length === 0) throw new Error(`no bars in ${SNAPSHOT_FILE}`);
  snapshot = { ...raw, bars };
  firstBarMs = Date.parse(bars[0].t);
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
    if (!symbols.length || symbols.includes(bar.sym)) out.push(bar);
  }
  if (replayCursor >= snapshot.bars.length && LOOP) {
    replayCursor = 0;
    replayStart = Date.now();
  }
  return out;
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
async function robinhoodBars(symbols) {
  const token = process.env.RH_TOKEN;
  if (!token) throw new Error('RH_TOKEN is not set — see bridge/README.md');
  const batch = symbols.slice(0, 10);
  const url =
    `${RH_HISTORICALS}?symbols=${encodeURIComponent(batch.join(','))}` +
    `&interval=15second&span=hour&bounds=regular`;

  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error('Robinhood rejected the token (401/403) — it likely expired; refresh RH_TOKEN');
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
      last_error: lastError,
    });
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
        if (symbols.length > 10) note = 'Robinhood returns at most 10 symbols per call';
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

// 127.0.0.1 only: not reachable from another machine on the network.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`bridge listening on http://127.0.0.1:${PORT}  (provider: ${PROVIDER})`);
  console.log(`  GET /bars?symbols=NVDA,AMD   GET /health`);
});
