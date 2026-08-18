# Local bars bridge

The board runs in a browser. A browser cannot fetch Robinhood directly — there is no CORS grant and
no anonymous access — so this small Node process sits on `127.0.0.1`, fetches bars, and serves them
to the page in one normalized shape.

No dependencies. No build step. Node 18+.

```
GET /bars?symbols=NVDA,AMD,SNDK   ->  { interval_sec, bars: [{sym,t,o,h,l,c,v}], note? }
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
- **10 symbols per Robinhood call.** A wider watchlist needs batched calls; the bridge currently
  sends the first 10 and says so in the `note` field.
- This is a **watchlist board, not a market-wide ranking.** Cross-sectional percentile rank over 10
  names means the top one is "the busiest of your ten" — which is a genuinely useful thing to watch,
  but it is not "the highest-interest stock in the market."

## Security notes

- Binds `127.0.0.1` only — not reachable from other machines on your network.
- CORS is granted to `localhost` / `127.0.0.1` origins only.
- `RH_TOKEN` is read from the environment, never logged, never returned by `/health` (which reports
  only whether a token is present), and never written to disk.
- Read-only: `GET` requests only; every other method returns 405.
