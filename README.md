# Interest Rank

A live board that ranks US equities by **attention**, recomputed every second, with a mean/median
window analysis and an ensemble majority vote that tells you whether a placement is real or an
artifact of the smoothing.

Everything runs in the browser: static site, no backend, deployable to GitHub Pages. It ships with a
built-in market simulator so it works with zero API keys, and swaps to a real feed when you paste a
key in.

---

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # 26 engine + tape tests
npm run build      # -> dist/
```

The board needs ~25 seconds of feed to warm the baselines before it publishes a ranking (the status
bar shows `ranked 0` until then).

## Put it on your own GitHub

```bash
git init
git add -A
git commit -m "Interest Rank: live cross-sectional attention board"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

Then in the repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**. The included
workflow (`.github/workflows/deploy.yml`) builds and publishes on every push to `main`, so the site
lands at `https://<you>.github.io/<repo>/`. `vite.config.ts` uses `base: './'`, so the subdirectory
path works without further configuration.

> **That Source setting is not optional, and getting it wrong looks like a bug in the app.** If Pages
> is left on *Deploy from a branch*, GitHub serves the repository root — including the unbuilt
> `index.html`, whose `<script src="/src/main.ts">` points at TypeScript that no browser can run. The
> page loads, renders nothing, and reports no error; `npm run dev` keeps working because Vite
> compiles that file on the fly. To tell the two apart, view source on the deployed page: the built
> one references `./assets/index-<hash>.js`, and anything still pointing at `/src/main.ts` is the raw
> branch being served.

---

## How the score works

### Step 1 — the signals

| Signal | Formula | What it captures |
| --- | --- | --- |
| Relative volume | `log1p(v / E[v \| time of day])` | volume vs. what is normal *for this minute* |
| Return z | `\|r\| / ATR` | unusual price move |
| Trade surge | `log1p(n / E[n])` | participation breadth |
| Quote churn | `log1p(q / E[q])` | order-book attention |
| Range expansion | `(H - L) / ATR` | volatility breakout |

### Step 2 — two-stage normalization

Raw volume is not comparable across tickers: AAPL trades 50M shares a day, a small cap trades 200k.
So each signal is first standardized **within** the ticker,

```
z_i(t) = (x_i(t) - mu_i(t)) / sigma_i(t)
```

and only then compared **across** tickers, as a percentile rank:

```
S_i(t) = sum_k  w_k * rank_pct( z_i^(k)(t) )
```

Percentile rank rather than raw z in the second stage is what makes the composite robust to fat
tails — one halted microcap printing z = 40 cannot swamp the blend.

The baselines are **time-of-day conditional**. Volume at 09:35 is ~10x volume at 13:00 for every
stock, so an unconditional baseline just ranks "whatever is open" every morning. Expected volume is
factored as `adv_i x shape(bucket) x mult_i(bucket)`: a market-wide intraday U curve (5-minute
buckets, learned slowly from the cross-sectional median), times a per-ticker residual learned across
sessions. A brand-new ticker inherits a sane curve immediately instead of needing 20 sessions of
history. See `src/engine/profile.ts`.

### Step 3 — incremental estimation

Nothing is recomputed from scratch. Every baseline is a time-decayed EWMA, O(1) per tick per ticker:

```
mu_t     = lambda*mu_{t-1}     + (1-lambda)*x_t
sigma2_t = lambda*sigma2_{t-1} + (1-lambda)*(x_t - mu_{t-1})^2
lambda   = exp(-dt / tau)
```

A first-order low-pass, with `tau` chosen per signal: short (~30 s) for surge detection, long
(~15 min, configurable) for the baseline. Using elapsed time rather than sample count keeps the time
constant honest when a ticker goes quiet. See `src/engine/ewma.ts`.

### Step 4 — stabilizing the ranking

Sorting a noisy score every second produces an unreadable, flickering list. Two fixes, both in
`src/engine/engine.ts`:

1. **Smooth the score, not the rank** — a second EWMA on `S_i(t)`, `tau ≈ 15 s`.
2. **Hysteresis on entry/exit** — a ticker enters the top N only above `theta_in` and leaves only
   below `theta_out < theta_in` (a Schmitt trigger). Rows held by hysteresis rather than by raw
   score are marked with `⟡`. The `churn` figure in the status bar is the mean `|Δrank|` per second;
   a regression test asserts it stays under 1.0 on pure noise.

### Step 5 — the ensemble (the "majority vote")

The published ordering comes from one estimator, which on its own says nothing about whether a
placement is real. Five deliberately different estimators of the same quantity are run in parallel —
instantaneous, fast EWMA, slow EWMA, window **mean**, window **median** — and the board reports:

- **Robust** — the share of members that independently place the ticker in the top N. 100% means
  every view of the data agrees; 40% means it is a smoothing artifact, and the column says so.
- **Fcst** — each member projects its own value forward by its own robust (Theil-Sen style) trend
  over the forecast horizon, re-ranks, and votes UP / HOLD / DOWN. The majority wins and the
  percentage is the size of that majority.
- **MAD** — median absolute deviation of the score over the window. Low MAD = stable placement.

See `src/engine/vote.ts`.

### Practical caveats (they are real, not boilerplate)

- **Halts and low-float names dominate any unfiltered attention score.** A $2 stock going from 10k
  to 5M shares has an RVOL z-score in the hundreds. The liquidity floor (default: price ≥ $5,
  ADV ≥ 500k shares) exists for this reason; raise it if the board fills with noise.
- **"Highest interest" is not tradeable.** By the time a name is #1 on an attention board the move
  has largely happened and the spread has widened. This is a monitoring and discovery tool.
- **Corporate actions** (splits, ticker changes) corrupt baselines silently unless you consume the
  vendor's adjustment feed. Nothing here does that yet.

---

## Data feeds

| Feed | Coverage | Key | Notes |
| --- | --- | --- | --- |
| **Simulator** | 800 synthetic symbols | none | 3-decade volume dispersion, intraday shape, injected attention events |
| **Massive replay** | watchlist, one request per symbol | free Basic key | a completed session's minute bars played back as a tape — real prints, yesterday |
| **Robinhood** | watchlist, 10 symbols per call | your own session token | 15-second OHLCV via the local bridge in `bridge/` — no subscription needed |
| **Massive** | full SIP, `A.*` 1-second aggregates | real-time plan | the right shape for this engine |
| **Polygon** | full SIP, `A.*` 1-second aggregates | real-time plan | same wire protocol as Massive, different host |
| **Finnhub** | per-symbol trades, aggregated locally | yes | no wildcard subscribe — watchlist only |

Keys are stored in `localStorage` in your browser and are never sent anywhere except to the vendor's
own WebSocket or REST endpoint.

To rank *all* US equities you need the consolidated SIP feed, not a single-exchange feed: IEX-only
feeds cover roughly 2–3% of volume, which badly distorts a volume-based ranking. Prefer the vendor's
**1-second aggregate** channel over raw trades — it cuts inbound message volume by ~1000x and is
exactly the engine's input unit.

Note the **non-professional vs. professional** distinction: it is an exchange licensing
classification and it is the single biggest cost driver. A personal internal tool generally stays in
the cheap tier; redistribution — publishing a page that shows the data to other people — moves you
into display-fee territory. Check your vendor's terms before making a Pages deployment public with a
real feed attached.

### Massive: which tier buys what

Massive is Polygon under the hood — same REST paths, same `wss://.../stocks` protocol, so the
**Massive** and **Polygon** entries above are one implementation (`src/feeds/sip.ts`) with two hosts.
The tiers are not interchangeable for this board, and the difference was checked against the live API
rather than read off a marketing page:

| Tier | Live socket | What the REST API returns | Drives this board? |
| --- | --- | --- | --- |
| Basic (free) | no | history through the **previous** session; today is `NOT_ENTITLED` | replay feed only |
| Starter / Developer | yes | 15-minute delayed | no — a 15-minute-old attention ranking is not a ranking of *now* |
| Advanced | yes | real-time full market | yes |

So the live **Massive** feed needs the real-time tier. Nothing in the code can work around that: a
delayed socket produces a correct-looking board that is confidently 15 minutes late, which is worse
than an obviously empty one.

Note also that an **MCP connection to Massive is not a key this app can use.** MCP authenticates a
desktop client over OAuth; this is a static site with no backend, so it needs a plain REST/socket key
created at massive.com and pasted into the API key box. The API sends permissive CORS headers, so the
browser can call it directly once it has one.

### Massive replay — real prints on the free tier

The free Basic tier withholds today's tape but includes **historical minute aggregates**, which is
enough to drive the engine off a real session. Pick **Massive replay**, paste a free key, and the
feed walks back from yesterday to the most recent date that actually returns bars (skipping weekends,
and skipping holidays for free by treating "no bars" as "try the day before"), downloads one
symbol-day per watchlist name, and plays it back on a loop.

Four things to know before reading that board:

- **One request per symbol.** Keep the watchlist short. The loader goes one at a time, backs off on
  429 and keeps the wider gap, and starts replaying as soon as the first symbol lands — later
  arrivals join at the current tape position rather than rewinding it.
- **Minute resolution.** Each engine step takes a slice of the minute, with volume and trade count
  prorated and price interpolated open-to-close. The minute aggregate is real; the path inside it is
  invented. The minute's true high and low are folded into whichever slice contains the middle of
  that minute, so a range expansion registers once instead of once per slice.
- **No quotes, but real trade counts.** Quote churn is auto-zeroed. Trade count comes from the
  aggregate's own `n`, so it is a measurement here rather than the volume/average-size estimate the
  live socket feeds have to use.
- **Speed rescales the time constants.** The engine steps once per wall-clock second regardless, so
  at speed S each step swallows S seconds of tape and a τ of N seconds covers N/S seconds of market
  time. The default is 10x — a full session in about 40 minutes. Divide the τ settings by the speed
  if you want them to mean what they mean live.

### Robinhood without a subscription

Your brokerage account already carries a real-time quote entitlement, so it can drive the board for a
watchlist at no extra cost. The browser cannot reach Robinhood directly (no CORS, no anonymous
access), so a small dependency-free Node process bridges it:

```bash
node bridge/robinhood-bridge.mjs        # replays real recorded bars, no login
```

Then pick **Robinhood (local bridge)** as the source. Full setup, including running it against your
own live session, is in [`bridge/README.md`](bridge/README.md). Three limits are worth knowing before
you read the board: the finest interval is **15 seconds** (split into 1-second slices, so the
aggregate is real but the path inside it is interpolated), there is **no quote data** (quote churn is
auto-zeroed), and Robinhood returns **10 symbols per call**. That makes this a watchlist board — #1
means "busiest of your ten", not "highest interest in the market". The bridge is read-only market
data; it has no order path and should never be given one.

### The Robinhood screener as the watchlist

Robinhood's screener and this board answer different questions, and it is worth being precise about
which. The screener is a **filter**: `relative volume > 3` is a threshold, evaluated per name, with
no cross-sectional normalization, no time-of-day baseline, no blend, and no notion of whether a
placement is stable. Its finest interval is one minute. This board is a **ranker**: five signals,
z-scored within each ticker against a time-of-day conditional baseline, percentile-ranked across the
cross-section, blended, smoothed, and put to an ensemble vote — recomputed every second.

So they compose rather than compete. The screener decides *which* names are worth the bar budget —
which matters, because every real feed here is per-symbol expensive — and the board ranks whatever it
hands over. Type `*scan` in the watchlist box:

| Token | Effect |
| --- | --- |
| `*scan` | every symbol the screener returned, in the scanner's own order |
| `*scan:20` | its top 20 |
| `*scan, SPY` | the scanner's list, then SPY appended |

`*scan` reads the bridge's `/scan` endpoint, so the bridge must be running — see
[`bridge/README.md`](bridge/README.md) for the file format and how results get there. The status bar
shows how old the scan is, because a screener run before the open is a list of yesterday's ideas and
the board itself cannot tell.

### Adding another feed

Implement `Feed` from `src/feeds/types.ts` (`start(onBars, onStatus)` / `stop()`), emit `Bar`
objects, and register it in `src/feeds/index.ts`. The engine only ever sees bars, so nothing else
changes.

---

## Architecture

```
WebSocket feed (SIP 1s aggregates), REST replay tape, or the simulator
   |  bars
main thread  ──postMessage──▶  Web Worker
                                 |
                                 |  per-ticker EWMA state (~1 KB/symbol)
                                 |  1 Hz scoring pass, vectorized over typed arrays
                                 |  shortlist -> window mean/median/MAD/slope
                                 |  ensemble vote + hysteresis
                                 ▼
main thread  ◀──snapshot──   top-N rows
   |
incremental table: keyed rows, changed text nodes only, FLIP reordering
```

The engine runs off the main thread so a slow pass can never stall the table or the socket. Window
statistics (median, MAD, robust slope) are the only super-linear work, so they run on a shortlist of
a few hundred candidates rather than the full universe — a ticker outside the shortlist cannot be in
the top N anyway. Measured compute is ~4 ms per pass at 800 symbols; the status bar shows it live.

| File | Role |
| --- | --- |
| `src/engine/ewma.ts` | time-decayed EWMA mean/variance/z |
| `src/engine/window.ts` | ring buffer: mean, median, MAD, Theil-Sen slope |
| `src/engine/profile.ts` | time-of-day volume profile |
| `src/engine/crosssection.ts` | percentile rank, top-K |
| `src/engine/ticker.ts` | per-symbol state |
| `src/engine/engine.ts` | the 1 Hz pass: signals → z → percentile → composite → vote → hysteresis |
| `src/engine/vote.ts` | ensemble robustness and forecast |
| `src/ui/table.ts` | incremental DOM, FLIP animation |

Every knob in the sidebar (time constants, window length, thresholds, weights, liquidity floors,
forecast horizon) is live and persisted to `localStorage`.

## Tests

`npm test` runs 26 tests covering the estimators (EWMA convergence, time-decay, z on a surge),
window statistics (median/MAD outlier resistance, slope), cross-sectional ranking (fat-tail bounding,
tie handling), the ensemble vote, the intraday profile, and three end-to-end engine properties: a
volume surge reaches #1, hysteresis keeps churn under 1 rank/second on pure noise, and the liquidity
floor excludes cheap or thin names.

The replay tape has its own suite (`test/tape.test.ts`): session dates walk backwards past weekends,
slicing a whole minute reproduces that minute, volume and trade count are conserved when a minute is
split, the high and low land in exactly one slice rather than every slice, gaps produce no bar rather
than a zero-volume one, and a stale cursor does not swallow the first minute when the tape loops.

## Disclaimer

Not investment advice. This is a monitoring tool that measures market attention; it does not predict
prices and it is not a trading signal.
