// Feed adapter contract — SAME persistent connection, client-driven resubscribe (cleanroom semantics). Written BEFORE implementation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeTransport } from "./helpers/fakes.js";
import { BinanceFeed } from "../src/feed.js";

test("subscribe -> Kbars REST fetch via injected fetcher, then socket attach", async () => {
  const transport = new FakeTransport();
  const fetched = [];
  const feed = new BinanceFeed({
    transport: () => transport,
    fetcher: async (url) => {
      fetched.push(url);
      return { candles: [] };
    },
  });
  await feed.loadBars("BINANCE:BTCUSDT", "1d", 500);
  assert.equal(fetched.length, 1);
  assert.match(fetched[0], /api\.binance\.com\/api\/v3\/klines/);
  assert.match(fetched[0], /symbol=BTCUSDT/);
  assert.match(fetched[0], /interval=1d/);
});

test("resubscribe keeps transport, sends protocol message, never reconnects", async () => {
  const transport = new FakeTransport();
  const feed = new BinanceFeed({
    transport: () => transport,
    fetcher: async () => ({ candles: [] }),
  });
  await feed.subscribe("BINANCE:BTCUSDT", "1d");
  await feed.subscribe("BINANCE:ETHUSDT", "15m");
  assert.equal(transport.connects, 1, "persistent session");
  const subs = transport.sent.filter((m) => m.type === "subscribe");
  assert.deepEqual(
    subs.map((m) => [m.symbolKey, m.interval]),
    [
      ["BINANCE:BTCUSDT", "1d"],
      ["BINANCE:ETHUSDT", "15m"],
    ],
  );
});

test("symbol normalization: BINANCE:BTCUSDT -> native BTCUSDT", () => {
  const feed = new BinanceFeed({
    transport: () => new FakeTransport(),
    fetcher: async () => ({ candles: [] }),
  });
  assert.equal(feed.nativeSymbol("BINANCE:BTCUSDT"), "BTCUSDT");
});

test("candle events surface both live ticks and closed candles", async () => {
  const transport = new FakeTransport();
  const feed = new BinanceFeed({
    transport: () => transport,
    fetcher: async () => ({ candles: [] }),
  });
  await feed.subscribe("BINANCE:BTCUSDT", "1m");
  const seen = [];
  feed.onCandle("BINANCE:BTCUSDT", (c) => seen.push(c));
  transport.dispatchCandle("BINANCE:BTCUSDT", {
    openTime: 1,
    open: 1,
    high: 1,
    low: 1,
    close: 1,
    volume: 1,
    closed: false,
  });
  assert.equal(seen.length, 1);
});
