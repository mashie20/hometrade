# hometrade — local-first autonomous charting terminal (cleanroom build)

Original code, branding, and design. Public-domain charting concepts only; market
data comes from free, keyless, publicly documented exchange endpoints. No
third-party proprietary wire formats, assets, or names are used.

**Live static demo (sample data):** <https://mashie20.github.io/hometrade/>
(GitHub Pages serves no API, so the UI runs in clearly-labelled `DEMO` mode with
deterministic synthetic candles. All real fetching happens in the local server
below.)

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

## Architecture

```text
static/           UI: canvas chart (chart.js), terminal behaviors (app.js),
                  demo-data.js (offline sample generator), original CSS
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
  server.js       localhost HTTP terminal (API + SSE) on 127.0.0.1:4444
  mcp_server.js   agent surface (MCP stdio JSON-RPC 2.0)
tests/            TDD-first node:test suites + perf gates
```

## Agent surface (MCP)

Tools: `load_symbol`, `get_bars`, `add_alert`, `list_alerts`, `delete_alert`,
`rearm_alert`, `annotate`, `query_annotations`, `save_watchlist`, `get_watchlists`.

Point any MCP client (e.g., OpenCode) at:

```json
{ "command": "node", "args": ["<abs path>/hometrade/src/mcp_server.js"] }
```

Agents share state with the local UI: an alert armed by an agent appears in the
browser panel and fires to both surfaces (SSE toast / MCP output).

## Local-first notes

- Bar caches: `data/bars/EXCHANGE/TICKER/INTERVAL.jsonl` (append-only, atomic write)
- State: `data/alerts.json`, `data/annotations.json`, `data/watchlists.json`
- Offline: previously loaded symbols/intervals render from cache; new ones need network
- Quote mapping: Coinbase spot products are USD-quoted; `COINBASE:TICKERUSDT`
  keys map to `TICKER-USD` natively, `1M` is rejected (exchange granularity policy)

## Deploying the static demo (GitHub Pages)

`static/` is self-contained (relative asset paths, no server calls required).
Publish it from a branch whose root is `static/`; the UI auto-falls back to
demo mode when `/api/*` is unavailable.

Legal: cleanroom REA session gates — observe-only behavior patterns; nothing
protected was copied. This repo contains no third-party assets.
