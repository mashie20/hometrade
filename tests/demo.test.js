// Offline demo generator contract (GitHub Pages static mode). Original code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { demoSeries } from "../static/demo-data.js";

test("demo series: deterministic for same symbol@interval", () => {
  const a = demoSeries("COINBASE:BTCUSDT", "15m", 50);
  const b = demoSeries("COINBASE:BTCUSDT", "15m", 50);
  assert.deepEqual(a, b);
});

test("demo series: differs per symbol/interval", () => {
  const a = demoSeries("COINBASE:BTCUSDT", "1h", 30);
  const b = demoSeries("COINBASE:ETHUSDT", "1h", 30);
  assert.notDeepEqual(a, b);
});

test("demo series: count, ascending unique buckets, sane OHLC", () => {
  const s = demoSeries("DEMO:TEST", "1m", 100);
  assert.equal(s.length, 100);
  for (let i = 1; i < s.length; i++) {
    assert.ok(s[i].openTime > s[i - 1].openTime, "ascending");
  }
  for (const c of s) {
    assert.ok(c.high >= Math.max(c.open, c.close), "high >= max(o,c)");
    assert.ok(c.low <= Math.min(c.open, c.close), "low <= min(o,c)");
    assert.ok(c.low < c.high);
    assert.ok(c.volume >= 0);
  }
});
