// Source-adapter contract: exchange catalog + Coinbase public adapter (V-N, V1). Written BEFORE implementation.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveSymbol,
  supportedIntervals,
  sourceIntervalsFor,
} from "../src/exchanges.js";
import { buildKlinesUrl, normalizeSourceRows } from "../src/feed.js";
import { FakeWS } from "./helpers/fakes.js";

test("catalog: COINBASE public source supported; native ticker mapped to product id", () => {
  const info = resolveSymbol("COINBASE:BTCUSDT");
  assert.equal(info.exchange, "COINBASE");
  assert.equal(
    JSON.stringify(supportedIntervals("COINBASE")).includes("15m"),
    true,
  );
  // 1M (calendar month) unsupported by source granularity -> not advertised
  assert.equal(sourceIntervalsFor("COINBASE")["1M"], undefined);
});

test("coinbase klines URL: product id + epoch-seconds granularity", () => {
  const url = buildKlinesUrl("COINBASE:BTCUSDT", "15m", 300);
  assert.match(url, /api\.exchange\.coinbase\.com\/products\/BTC-USD\/candles/);
  assert.match(url, /granularity=900/);
});

test("binance URL builder unchanged (regression)", () => {
  const url = buildKlinesUrl("BINANCE:BTCUSDT", "1d", 500);
  assert.match(url, /api\.binance\.com\/api\/v3\/klines/);
  assert.match(url, /symbol=BTCUSDT/);
  assert.match(url, /interval=1d/);
});

test("unsupported interval for exchange is rejected with a clear error", async () => {
  const { fetchBars } = await import("../src/live.js");
  await assert.rejects(
    () => fetchBars("COINBASE:BTCUSDT", "1M", 100),
    /not supported by COINBASE/i,
  );
});

test("coinbase transport: subscribe -> public ticker channel; trades aggregate into interval candles", async () => {
  const { coinbaseTransport } = await import("../src/live.js");
  const ws = new FakeWS();
  const transport = coinbaseTransport(() => ws);
  await transport.connect();
  await transport.send({
    type: "subscribe",
    symbolKey: "COINBASE:BTCUSDT",
    interval: "15m",
    wasResubscribe: false,
  });
  const sent = JSON.parse(ws.sent[0]);
  assert.equal(sent.type, "subscribe");
  assert.deepEqual(sent.product_ids, ["BTC-USD"]);
  assert.ok(sent.channels.includes("ticker"));

  const seen = [];
  transport.on((symbolKey, candle) => seen.push({ symbolKey, candle }));
  // two trades inside the first bucket, then one in the next bucket -> prior closes
  const t0 = Math.floor(Date.UTC(2026, 9, 1, 10, 0) / 1000); // 10:00:00Z
  ws.dispatch({
    type: "match",
    product_id: "BTC-USD",
    price: "100.0",
    size: "2",
    time: new Date(t0 * 1000).toISOString(),
  });
  ws.dispatch({
    type: "match",
    product_id: "BTC-USD",
    price: "102.0",
    size: "1",
    time: new Date((t0 + 60) * 1000).toISOString(),
  });
  assert.equal(seen.length, 2, "in-flight updates emitted per trade");
  assert.equal(seen[0].candle.open, 100);
  assert.equal(seen[1].candle.high, 102);
  assert.equal(seen[1].candle.closed, false);
  ws.dispatch({
    type: "match",
    product_id: "BTC-USD",
    price: "103.0",
    size: "1",
    time: new Date((t0 + 950) * 1000).toISOString(),
  }); // next 15m bucket
  const closed = seen.filter((s) => s.candle.closed);
  assert.equal(closed.length, 1, "prior bucket closed on rollover");
  assert.equal(closed[0].candle.close, 102);
  assert.equal(closed[0].candle.volume, 3);
  assert.equal(closed[0].symbolKey, "COINBASE:BTCUSDT");
});
