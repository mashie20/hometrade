// Whole-market access: Yahoo keyless equities adapter, Nasdaq SymDir universe,
// staggered poller. Written BEFORE implementation (TDD).
import { test } from "node:test";
import assert from "node:assert/strict";

test("YAHOO catalog: whole-market polling source with monthly prefixes mapped", async () => {
  const { resolveSymbol, exchangeSupportsInterval } =
    await import("../src/exchanges.js");
  const info = resolveSymbol("YAHOO:AAPL");
  assert.equal(info.exchange, "YAHOO");
  assert.equal(info.native, "AAPL");
  assert.equal(exchangeSupportsInterval("YAHOO", "1M"), true);
  assert.equal(exchangeSupportsInterval("YAHOO", "1w"), true);
});

test("YAHOO klines URL: chart endpoint + interval/range mapping", async () => {
  const { buildKlinesUrl } = await import("../src/feed.js");
  const u1 = buildKlinesUrl("YAHOO:AAPL", "1m", 300);
  assert.match(u1, /query[12]\.finance\.yahoo\.com\/v8\/finance\/chart\/AAPL/);
  assert.match(u1, /interval=1m/);
  assert.match(u1, /range=1d/);
  const u2 = buildKlinesUrl("YAHOO:MSFT", "1w", 300);
  assert.match(u2, /interval=1wk/);
  const u3 = buildKlinesUrl("YAHOO:NVDA", "1M", 300);
  assert.match(u3, /interval=1mo/);
});

test("YAHOO source rejected for COINBASE-style granularity regression intact", async () => {
  const { buildKlinesUrl } = await import("../src/feed.js");
  const u = buildKlinesUrl("COINBASE:BTCUSDT", "15m", 300);
  assert.match(u, /api\.exchange\.coinbase\.com\/products\/BTC-USD/);
});

test("normalize YAHOO chart doc: canonical ascending candles, null bars dropped", async () => {
  const { normalizeSourceRows } = await import("../src/feed.js");
  const url = "https://query1.finance.yahoo.com/v8/finance/chart/AAPL";
  const doc = {
    chart: {
      result: [
        {
          meta: { regularMarketPrice: 343.46 },
          timestamp: [1792180700, 1792180760, 1792180820, 1792180880],
          indicators: {
            quote: [
              {
                open: [340, 341, 342, null],
                high: [341, 342, 344, null],
                low: [339, 340, 341, null],
                close: [340.5, 341.5, 343.46, null],
                volume: [1000, 2000, 3000, null],
              },
            ],
          },
        },
      ],
    },
  };
  const bars = normalizeSourceRows(url, doc);
  assert.equal(bars.length, 3, "trailing null bar dropped");
  assert.deepEqual(
    bars.map((b) => b.openTime),
    [1792180700000, 1792180760000, 1792180820000],
    "ascending ms timestamps",
  );
  assert.equal(bars[2].close, 343.46);
  assert.equal(bars[0].high, 341);
});

test("SymDir universe: test issues filtered, ETFs kept, duplicates collapsed", async () => {
  const { parseSymDir } = await import("../src/market.js");
  const text = [
    "Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares",
    "AAPL|Apple Inc. - Common Stock|N|N|S|100|N|N",
    "TESTT|Test Issue Only Wild LLC|N|Y|A|100|N|N",
    "SPY|SPDR S&P 500 ETF Trust|N|N|A|100|Y|N",
    "ZZZZ|Zorro Zombies Ltd - ADS|X|N|D|100|N|N",
    "AAPL|Apple Inc. - Common Stock|N|N|S|100|N|N",
  ].join("\n");
  const rows = parseSymDir(text, "NASDAQ");
  assert.equal(rows.length, 3, "test issue + duplicate removed");
  assert.deepEqual(
    rows.filter((r) => r.symbol === "AAPL").map((r) => r.exchange),
    ["NASDAQ"],
  );
  const spy = rows.find((r) => r.symbol === "SPY");
  assert.ok(spy && spy.etf === true);
});

test("universe search: symbol prefix beats name substring; result cap", async () => {
  const { searchUniverse } = await import("../src/market.js");
  const universe = [
    { symbol: "AAPL", name: "Apple Inc.", exchange: "NASDAQ" },
    { symbol: "AAPT", name: "Alpha Achromatic Photon", exchange: "NASDAQ" },
    { symbol: "RAPT", name: "Wrap Technologies", exchange: "NASDAQ" },
  ];
  const hits = searchUniverse("AP", universe, 2);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].symbol, "AAPL", "prefix match ranks first");
  assert.equal(hits[0].key, "YAHOO:AAPL", "returned keys are loadable symbols");
});

test("poller: round-robin pump emits ticks, tolerates fetch errors, respects unsubscribes", async () => {
  const { createPoller } = await import("../src/market.js");
  const seen = [];
  const p = createPoller({
    fetchLast: async (key) => {
      if (key === "YAHOO:BAD") throw new Error("upstream down");
      return { price: 123.45, prevClose: 120, openTime: 1792180820000 };
    },
  });
  p.onTick((key, t) => seen.push({ key, t }));
  p.subscribe("YAHOO:AAPL");
  p.subscribe("YAHOO:BAD");
  p.subscribe("YAHOO:AAPL"); // duplicate subscribe ignored
  assert.deepEqual(p.list(), ["YAHOO:AAPL", "YAHOO:BAD"]);
  await p.pump();
  assert.deepEqual(
    seen.map((s) => s.key),
    ["YAHOO:AAPL"], // BAD errored; AAPL reported; no duplicate for dup-subscribe
  );
  assert.equal(seen[0].t.price, 123.45);
  p.unsubscribe("YAHOO:AAPL");
  seen.length = 0;
  await p.pump();
  assert.deepEqual(seen, [], "unsubscribed symbols must not be polled/emit");
});
