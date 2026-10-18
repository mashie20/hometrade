// V1/V2/V3 + GM1..GM4 — the Load & Render chain (session state machine). Written BEFORE implementation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CandleSession } from "../src/session.js";
import { FakeFeed } from "./helpers/fakes.js";

const bar = (t, c) => ({
  openTime: t,
  open: c,
  high: c + 1,
  low: c - 1,
  close: c,
  volume: 2,
});
const bars = (t0, n, step = 15000) =>
  Array.from({ length: n }, (_, i) => bar(t0 + i * step, 100 + i * 0.25));

const EVENTS = [];
function sessionWithFake(fake) {
  const s = new CandleSession({
    store: fake.store,
    feed: fake.feed,
    fetcher: fake.fetcher,
  });
  for (const ev of [
    "render_data",
    "symbol_changed",
    "interval_changed",
    "cache_hit",
  ])
    s.on(ev, (d) => EVENTS.push({ ev, d }));
  return s;
}

test("concurrent loads on one session serialize (last view wins, no corruption)", async () => {
  const fake = FakeFeed({
    "COINBASE:BTCUSDT": bars(0, 20, 60000),
    "COINBASE:ETHUSDT": bars(0, 20, 60000),
  });
  const s = new CandleSession({
    store: fake.store,
    feed: fake.feed,
    fetcher: fake.fetcher,
  });
  const [a, b] = await Promise.all([
    s.load("COINBASE:BTCUSDT", "1m"),
    s.load("COINBASE:ETHUSDT", "15m"),
  ]);
  // deterministic last-write-wins: B resolves last, view bound to B
  assert.equal(s.viewState().symbol, "COINBASE:ETHUSDT");
  assert.equal(s.viewState().interval, "15m");
  assert.ok(a.series.length > 0 && b.series.length > 0);
});

test("GM1: load(BINANCE:BTCUSDT,1d) resolves -> fetch+merge -> render_data with header info", async () => {
  const fake = FakeFeed({ "BINANCE:BTCUSDT": bars(0, 96, 60000) });
  const s = sessionWithFake(fake);
  const r = await s.load("BINANCE:BTCUSDT", "1m");
  assert.equal(r.header.symbol, "BTCUSDT");
  assert.equal(r.header.exchange, "BINANCE");
  assert.equal(r.header.interval, "1m");
  assert.equal(r.series.length, 96);
  assert.equal(
    EVENTS.some((x) => x.ev === "render_data"),
    true,
  );
  assert.equal(fake.stats.connects, 1, "one persistent connection");
  assert.deepEqual(fake.stats.subscribed, [["BINANCE:BTCUSDT", "1m"]]);
});

test("GM2: switching symbol re-subscribes the SAME connection (no reconnect) and fetches new bars", async () => {
  const fake = FakeFeed({
    "BINANCE:BTCUSDT": bars(0, 96, 60000),
    "BINANCE:ETHUSDT": bars(0, 96, 60000).map((b) => ({
      ...b,
      close: b.close + 50,
    })),
  });
  const s = sessionWithFake(fake);
  await s.load("BINANCE:BTCUSDT", "1m");
  const r2 = await s.load("BINANCE:ETHUSDT", "1m");
  assert.equal(r2.header.symbol, "ETHUSDT");
  assert.equal(fake.stats.connects, 1, "no new connection");
  assert.deepEqual(
    fake.stats.resubscribed.some(
      (x) => x[0] === "BINANCE:ETHUSDT" && x[1] === "1m",
    ),
    true,
    "resubscribe sent",
  );
  assert.equal(
    r2.series.at(-1).close,
    100 + 95 * 0.25 + 50,
    "ETH bars fetched and rendered",
  );
  assert.equal(
    EVENTS.some((x) => x.ev === "symbol_changed"),
    true,
  );
});

test("GM3: interval switch re-subscribes and re-aggregates without reconnect", async () => {
  const fake = FakeFeed({ "BINANCE:BTCUSDT": bars(0, 90, 60000) }); // 90 x 1m
  const s = sessionWithFake(fake);
  await s.load("BINANCE:BTCUSDT", "1m");
  const r2 = await s.load("BINANCE:BTCUSDT", "15m");
  assert.equal(r2.series.length, 6, "90 minutes bucketed into 6 x 15m");
  assert.deepEqual(fake.stats.resubscribed.at(-1), ["BINANCE:BTCUSDT", "15m"]);
  assert.equal(
    EVENTS.some((x) => x.ev === "interval_changed"),
    true,
  );
});

test("GM4: viewState mirrors symbol+interval for URL replaceState", async () => {
  const fake = FakeFeed({ "BINANCE:BTCUSDT": bars(0, 4) });
  const s = sessionWithFake(fake);
  await s.load("BINANCE:BTCUSDT", "1m");
  assert.deepEqual(s.viewState(), {
    symbol: "BINANCE:BTCUSDT",
    interval: "1m",
  });
});

test("invalid symbol rejected with clear error (validation step of the chain)", async () => {
  const fake = FakeFeed({ "BINANCE:BTCUSDT": bars(0, 4) });
  const s = sessionWithFake(fake);
  await assert.rejects(
    () => s.load("NOSUCHEXCHANGE:TICKER", "1m"),
    /unknown exchange/i,
  );
  await assert.rejects(
    () => s.load("BINANCE:BTCUSDT", "7q"),
    /unknown interval/i,
  );
});

test("live closed candle updates tail without new fetch (stream stage of chain)", async () => {
  const fake = FakeFeed({ "BINANCE:BTCUSDT": bars(0, 10, 60000) });
  const s = sessionWithFake(fake);
  const r1 = await s.load("BINANCE:BTCUSDT", "1m");
  const before = r1.series.at(-1).close;
  fake.feed.emitCandle("BINANCE:BTCUSDT", {
    openTime: 10 * 60000, // next minute bucket after the 10 cached bars (0..9min)
    open: 100,
    high: 200,
    low: 90,
    close: 150,
    volume: 9,
    closed: true,
  });
  const r2 = s.currentRenderData();
  assert.equal(r2.series.length, 11, "closed live candle appends a new bucket");
  assert.equal(r2.series.at(-1).close, 150, "new tail from stream");
  assert.equal(r2.series.at(-2).close, before, "existing bars unchanged");
});
