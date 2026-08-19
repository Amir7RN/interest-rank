#!/usr/bin/env node
/**
 * Convert a Robinhood scanner result into the `scan.json` the bridge serves.
 *
 * The screener is not on the public market-data API the bridge speaks, so scan
 * results arrive as a file. This script is the converter: point it at whatever
 * the scanner produced — an MCP `run_scan` result, or a Legend export — and it
 * writes the flat shape `GET /scan` expects.
 *
 * Regenerating is the whole point. The bridge re-reads the file per request, so
 * re-running this is enough to refresh the board's universe; nothing needs a
 * restart. Run it on a schedule if you want the watchlist to track the market
 * rather than the moment you last thought about it.
 *
 * Usage:
 *   node bridge/scan-import.mjs --in run-scan-result.json
 *   node bridge/scan-import.mjs --in result.json --out scan.json --limit 40
 *   cat result.json | node bridge/scan-import.mjs
 *
 * Accepted input shapes (the first one that matches wins):
 *   { data: { result: { scan_title, results: [{ ticker, columns: {...} }] } } }
 *   { scan_title, results: [...] }
 *   { rows: [{ symbol, ... }] }
 *   [ { ticker | symbol, ... } ]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const OUT = path.resolve(HERE, String(args.out ?? 'scan.json'));
const LIMIT = Number(args.limit ?? 0);

const raw = args.in
  ? fs.readFileSync(path.resolve(process.cwd(), String(args.in)), 'utf8')
  : fs.readFileSync(0, 'utf8');

let parsed;
try {
  parsed = JSON.parse(raw);
} catch (err) {
  fail(`input is not JSON: ${err.message}`);
}

const { title, rows } = normalize(parsed);
if (rows.length === 0) {
  fail('no rows found in the input — check that the scan actually returned results');
}

const limited = LIMIT > 0 ? rows.slice(0, LIMIT) : rows;
const payload = {
  title,
  // Stamped at conversion, not at read: the bridge reports this as an age, and
  // a stale scan is the failure mode that is otherwise invisible downstream.
  generated_at: new Date().toISOString(),
  rows: limited,
};

fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n');
console.log(
  `wrote ${path.relative(process.cwd(), OUT)}: ${limited.length} symbols` +
    `${LIMIT > 0 && rows.length > LIMIT ? ` (top ${LIMIT} of ${rows.length})` : ''}` +
    `${title ? ` from "${title}"` : ''}`,
);
console.log(`first few: ${limited.slice(0, 8).map((r) => r.symbol).join(', ')}`);

/** Flatten whichever shape came in into `{ title, rows: [{symbol, ...cols}] }`. */
function normalize(input) {
  const result = input?.data?.result ?? input;
  const list = Array.isArray(input)
    ? input
    : Array.isArray(result?.results)
      ? result.results
      : Array.isArray(result?.rows)
        ? result.rows
        : [];

  const rows = [];
  for (const item of list) {
    const symbol = String(item.ticker ?? item.symbol ?? item.sym ?? '').trim().toUpperCase();
    if (!symbol) continue;
    // Scanner cells arrive as strings, including values like "1.75e+06".
    // Numbers that survive the round trip are far easier to read and to sort.
    const cells = {};
    for (const [key, value] of Object.entries(item.columns ?? item)) {
      if (key === 'columns' || key === 'ticker' || key === 'symbol') continue;
      const num = typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
      cells[key] = Number.isFinite(num) ? num : value;
    }
    rows.push({ symbol, ...cells });
  }
  return { title: result?.scan_title ?? result?.title ?? null, rows };
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

function fail(message) {
  console.error(`scan-import: ${message}`);
  process.exit(1);
}
