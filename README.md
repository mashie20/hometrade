# hometrade — local-first trading terminal (cleanroom build)

Original code, branding, and design. Public-domain charting concepts only; market
data comes from free, keyless, publicly documented exchange endpoints. No
third-party proprietary wire formats, assets, or names are used.

**v0.3.0 — fully functional app:** email accounts (Supabase Auth + Postgres with
owner-scoped RLS), a real broker order ticket (Alpaca; PAPER default), typed
confirmation on every order, positions/orders/account panels on live ticks.

**Live static demo (sample data):** <https://mashie20.github.io/hometrade/>
(GitHub Pages serves no API, so the UI runs in clearly-labelled `DEMO` mode with
deterministic synthetic candles. Auth/trading are hidden there on purpose.)
All real fetching happens in the local server below.

## 1-step commands

```bash
# tests (zero external npm deps; node:test)
npm test            # or: node --test tests/*.test.js

# run the terminal (real data, local-first)
npm start           # http://127.0.0.1:4444 — badge turns LIVE on the stream

# run the agent MCP server (stdio JSON-RPC)
npm run mcp
```

Data source is selectable via `HOMETRADE_SOURCE`:

- `COINBASE` (default; public Exchange `products/…/candles` + `ticker` channel)
- `BINANCE`  (public `api/v3/klines` + combined stream; geo-restricted in some regions)

```bash
HOMETRADE_SOURCE=BINANCE npm start   # optional
```

## Accounts & real orders (v0.3.0)

**Backend: Supabase** (`https://edbiogqsytkhbmohacqa.supabase.co`). Auth is
Supabase email+password; trading book tables (`profiles`, `accounts`, `orders`,
`positions`) plus `watchlists`/`alerts`/`annotations` live in Postgres with
**row-level security**: every policy is owner-scoped (`auth.uid() = user_id`)
with `WITH CHECK` on writes, `anon` has zero grants, and the browser never sees
any key besides the publishable one.

- `POST /api/auth/register|login`, `POST /api/auth/logout`, `GET /api/auth/me`
  — the access+refresh tokens ride an **HttpOnly** cookie; the server rotates
  them transparently near expiry (the browser-side JS never touches tokens).
- Every user-scoped API call forwards the **user's own access token** to
  PostgREST, so the database itself enforces ownership — the server holds no
  secret key and never bypasses RLS.

**Broker: Alpaca** (real market data, real order lifecycle, no money at risk in
paper mode). Keys live **only on the machine** (`HOMETRADE_ALPACA_KEY` /
`HOMETRADE_ALPACA_SECRET` env, or `data/keys.json` saved from the ACCOUNT
panel — gitignored, never in the image or the repo):

```bash
# free paper keys: alpaca.markets (Account -> API keys)
export HOMETRADE_ALPACA_KEY=AKXXXXXXXX
export HOMETRADE_ALPACA_SECRET=XXXXXXXX
npm start
# or paste them in the ACCOUNT panel after signing in
```

- Base URLs: `paper` → `paper-api.alpaca.markets`, `live` → `api.alpaca.markets`
  (only settable with a typed `LIVE FUNDS` acknowledgment; **LIVE is real money
  and ships locked behind keys you supply**).
- **Every order needs an exact typed confirmation line** (HR-01 gate), e.g.
  `CONFIRM BUY 5 YAHOO:AAPL MKT` / `CONFIRM LIVE SELL 2.5 YAHOO:MSFT LIMIT 521.30`
  — the server recomputes it, compares timing-safely, and rejects mismatches
  before the broker sees anything.
- Order flow: ticket → confirmation → `orders` row in Postgres (`pending_new`,
  with the confirmation snapshot) → Alpaca (`client_order_id` = our order id) →
  broker fills reconciled back into `orders`/`positions` rows → position
  symbols join the live quote poller so PnL ticks with the market.
- Rejected orders keep the broker's error verbatim on the row and the toast.
- The MCP surface gained `broker_status` + `broker_account` (READ-ONLY on
  purpose: agents can see the book, but placing orders stays behind the UI's
  typed gate).

## Live dashboard & the whole market

- **Crypto (real-time):** Coinbase public `ticker` websocket streams trades;
  server aggregates into candles and pushes SSE `tick` events to every page.
- **US equities (near-real-time):** every symbol in the Nasdaq Trader SymDir
  universe (`nasdaqlisted.txt` + `otherlisted.txt`, **~13k listed names** cached
  24h in `data/universe.json`) is loadable as `YAHOO:<TICKER>` through the
  keyless public chart endpoint. A server-side poller paces upstream calls
  (main symbol ≈ every 3s, one rotating watch row per tick) and pushes SSE
  `market_tick` events — badges: `LIVE` (websocket) vs `POLL` (few-second
  cadence). Equities quotes are as fresh as a keyless public feed can be;
  nothing here is investment advice and there is no order routing.
- **Search:** type a ticker (e.g. `AAPL`, `SPY`, or `MSFT`) — bare USDT/USD
  quotes route to Coinbase, everything else to the equities universe;
  `/api/symbols?query=AAP` returns ranked matches across the whole market.
- **Strategy Lab (paper-only):** `POST /api/lab` runs a rule against the loaded
  series through our HR-07 kill-list harness — closed-bar signals with
  next-open fills + slippage, 70/30 train/holdout evaluated exactly once,
  parameter-plateau neighbors on train data, capacity vs observed bar volume,
  and an honest `PASS`/`KILL` verdict with failing hurdle IDs. The UI card
  labels it research-only.

## Architecture

```text
static/           UI: canvas chart (chart.js), terminal behaviors (app.js),
                  auth + order ticket + account panels, demo-data.js, original CSS
src/
  time.js         interval catalog + UTC bucketing rules (minutes to 1M)
  aggregation.js  OHLCV bucketing invariants
  indicators.js   SMA/EMA/RSI(Wilder)/MACD/Bollinger (public-domain math)
  store.js        local-first JSONL bar cache + JSON repositories (atomic writes)
  exchanges.js    symbol catalog & normalization (EXCHANGE:TICKER)
  feed.js         persistent feed session; client-driven subscribe/resubscribe
  live.js         source adapters (Coinbase/Binance transports, REST fetchers)
  session.js      Load & Render chain state machine (serialized view loads)
  view.js         pure viewport math (layout, price/time mapping)
  alerts.js       price-cross alert engine (fire once, explicit re-arm)
  books.js        annotations + watchlists
  supabase.js     Supabase REST client: auth + PostgREST with the user's bearer
  broker.js       Alpaca adapter: paper/live bases, order payloads, mapping
  server.js       localhost HTTP terminal (API + SSE) on 127.0.0.1:4444
  mcp_server.js   agent surface (MCP stdio JSON-RPC 2.0)
tests/            TDD-first node:test suites + perf gates
```

## Agent surface (MCP)

Tools: `load_symbol`, `get_bars`, `add_alert`, `list_alerts`, `delete_alert`,
`rearm_alert`, `annotate`, `query_annotations`, `save_watchlist`, `get_watchlists`,
`broker_status`, `broker_account`.

Point any MCP client (e.g., OpenCode) at:

```json
{ "command": "node", "args": ["<abs path>/hometrade/src/mcp_server.js"] }
```

Agents share state with the local UI: an alert armed by an agent appears in the
browser panel and fires to both surfaces (SSE toast / MCP output).

## Local-first notes

- Bar caches: `data/bars/EXCHANGE/TICKER/INTERVAL.jsonl` (append-only, atomic write)
- State: `data/alerts.json`, `data/annotations.json`, `data/watchlists.json`
- Secrets: `data/keys.json` (Alpaca) is machine-local and gitignored; Supabase
  user data lives in the hosted Postgres (owner-scoped RLS), everything else
  stays on disk
- Offline: previously loaded symbols/intervals render from cache; new ones need network
- Quote mapping: Coinbase spot products are USD-quoted; `COINBASE:TICKERUSDT`
  keys map to `TICKER-USD` natively, `1M` is rejected (exchange granularity policy)

## Run in Docker

```bash
docker build -t hometrade:0.3.0 .
docker run -d --name hometrade --restart unless-stopped \
  -p 8890:8890 \
  -v "$(pwd)/data:/app/data" \
  hometrade:0.3.0
# terminal: http://127.0.0.1:8890
# broker keys (optional): -e HOMETRADE_ALPACA_KEY=… -e HOMETRADE_ALPACA_SECRET=…
```

The image binds `0.0.0.0` inside the container (`HOMETRADE_HOST=0.0.0.0`); native
runs default to loopback (`127.0.0.1`) — set `HOMETRADE_HOST` to change. Bar caches
persist in the mounted `data` volume (local-first, survives container restarts).

## Deploying the static demo (GitHub Pages)

`static/` is self-contained (relative asset paths, no server calls required).
Publish it from a branch whose root is `static/`; the UI auto-falls back to
demo mode when `/api/*` is unavailable.

Legal: cleanroom REA session gates — observe-only behavior patterns; nothing
protected was copied. This repo contains no third-party assets.
