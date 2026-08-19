# Local bars bridge

The board runs in a browser. A browser cannot fetch Robinhood directly — there is no CORS grant and
no anonymous access — so this small Node process sits on `127.0.0.1`, fetches bars, and serves them
to the page in one normalized shape.

No dependencies. No build step. Node 18+.

```
GET /bars?symbols=NVDA,AMD,SNDK   ->  { interval_sec, bars: [{sym,t,o,h,l,c,v}], note? }
GET /scan                         ->  { title, symbols: [...], rows: [...], note? }
GET /health                       ->  { ok, provider, ... }
```

---

## Start it (no credentials, works right now)

```bash
node bridge/robinhood-bridge.mjs
```

That runs the **snapshot** provider against `snapshot.sample.json` — four minutes of real Robinhood
15-second bars for NVDA, AMD, and SNDK, recorded 2026-08-17 15:52–15:56 ET. The bridge walks the
recording forward at wall-clock speed and loops it, so the board has a live-shaped feed to chew on
with nothing to sign into.

Then in the app: **Source → Robinhood (local bridge)**, watchlist `NVDA,AMD,SNDK`.

Options:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--file <path>` | `snapshot.sample.json` | Recording to replay |
| `--speed <n>` | `1` | Replay speed multiplier |
| `--loop false` | looping on | Stop at the end instead of restarting |
| `--port <n>` | `8787` | Listen port |

---

## Live Robinhood data

```bash
RH_TOKEN=... node bridge/robinhood-bridge.mjs --provider robinhood
```

**You supply `RH_TOKEN` yourself.** Get it from your own authenticated Robinhood web session — open
DevTools → Network on robinhood.com while logged in, and copy the `Authorization: Bearer …` value
off any API request. Paste it into your shell as an environment variable; do not commit it, and do
not paste it into a chat. `.gitignore` already excludes `bridge/.env`.

The token is short-lived. When it expires the bridge returns `502` with a message saying so —
re-copy it and restart.

### What this fetches

`GET /marketdata/historicals/?symbols=…&interval=15second&span=hour&bounds=regular` — that is the
only Robinhood endpoint in this file, and it is read-only market data. **There is no order path in
this bridge, and none should ever be added to it.** Keep trading and data on separate rails.

---

## What the data can and cannot support

The bridge is honest about its limits, and so is the board:

- **15 seconds is the finest interval Robinhood offers.** The feed adapter splits each bar into 15
  one-second slices so the engine's per-second baselines stay meaningful. The 15-second aggregate is
  real; the price path inside it is interpolated and no individual prints are visible.
- **No quote data**, so quote churn is not a usable signal — the app sets that weight to 0 when you
  select this feed.
- **No trade count**, so it is estimated from volume at a nominal 200-share average trade. Trade
  surge therefore tracks volume rather than measuring participation breadth independently.
- **10 symbols per Robinhood call**, so a wider watchlist is fanned out across sequential batches
  with `--batch-delay` (default 150 ms) between them. 200 symbols is 20 calls ≈ 3 s per refresh.
  `--max-symbols` (default 200) is the ceiling; raise it knowingly.
- This is a **watchlist board, not a market-wide ranking.** Cross-sectional percentile rank over your
  N names means the top one is "the busiest of your N" — genuinely useful, but not "the
  highest-interest stock in the market."

### How wide can it go?

Sequential and spaced on purpose: this is one person's brokerage account, not a data entitlement.

| Watchlist | Calls per refresh | Roughly |
| --- | --- | --- |
| 10 | 1 | instant |
| 50 | 5 | <1 s |
| 200 | 20 | ~3 s |
| 1,000 | 100 | ~15 s, and you are leaning on the API |
| ~8,000 (all US equities) | 800 | not reachable — needs a real SIP feed |

A 429 from Robinhood surfaces as a bridge error telling you to shrink the list or raise
`--batch-delay`. If you want the whole market ranked, that is what the $199 full-SIP tier buys; no
amount of batching gets a broker API there.

## The screener: `GET /scan`

Robinhood's screener answers a different question from this board. The screener says *which* names
are worth watching ("relative volume > 3, price > $5"); the board says *how they rank against each
other right now*, with a normalized composite and a robustness vote. So the screener feeds the
watchlist rather than competing with the score.

Concretely: type `*scan` in the app's watchlist box and the board takes its universe from the current
screener results, in the scanner's own order. `*scan:20` takes its top 20, and `*scan, SPY` keeps the
scanner's sort and appends SPY.

The screener is not part of the public market-data API this bridge already speaks, so results reach
it as a **file** rather than a live call:

```bash
node bridge/robinhood-bridge.mjs --scan-file scan.json
```

The file is re-read on every request, so regenerating it takes effect without restarting the bridge.
Expected shape — extra keys per row are passed through untouched, and `symbols` is derived from
`rows` in order:

```json
{
  "title": "Unusual volume",
  "generated_at": "2026-08-18T13:45:00Z",
  "rows": [
    { "symbol": "NVDA", "relative_volume": 4.2 },
    { "symbol": "AMD",  "relative_volume": 3.1 }
  ]
}
```

Anything that can reach the scanner can write that file: the Robinhood MCP server's `run_scan`, a
scheduled job, or a manual export from Legend. `scan-import.mjs` converts any of those into the shape
above:

```bash
node bridge/scan-import.mjs --in run-scan-result.json --limit 40
```

It accepts the MCP result envelope, a bare `{results: [...]}`, or a plain array; normalizes tickers;
turns the scanner's stringified cells back into numbers; and stamps `generated_at`. `/scan` reports
that stamp as an age and the app shows it in the status bar, because **a stale scan is the failure
mode here** — a screener run before the open is a list of yesterday's ideas, and nothing downstream
can tell.

### Relative volume needs a daily interval

Worth knowing, because it produces a scan that looks fine and is not. Robinhood's relative-volume
filter at `interval: 1m` degenerates outside regular hours: the column comes back equal to raw
`Volume` rather than a ratio, `> 2` passes for essentially everything, and sorting by it gives you
the largest-volume names — mega-caps and bond ETFs — dressed up as an unusual-activity screen. That
is exactly the failure the board's percentile normalization exists to avoid, so importing it would
poison the watchlist at the source.

Use `interval: 1d, length: 30`. The filter then resolves to
`dayVolume / volumeAvg(candlePeriod="1d", session="all")`, which is the ratio the name implies. The
tradeoff is honest: with the market closed `dayVolume` is ~0, so the scan correctly matches nothing
rather than confidently matching everything. Refresh it during regular hours.

Missing file, empty results, and malformed JSON are three different problems with three different
fixes, so they produce three different messages rather than one empty board.

## Security notes

- Binds `127.0.0.1` only — not reachable from other machines on your network.
- CORS is granted to `localhost` / `127.0.0.1` origins only.
- `RH_TOKEN` is read from the environment, never logged, never returned by `/health` (which reports
  only whether a token is present), and never written to disk.
- Read-only: `GET` requests only; every other method returns 405.
