// V-AGG — Time aggregation contract. Tests written BEFORE implementation (TDD).
import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregate } from "../src/aggregation.js";

const m = (min, ms = 0, y = 2026, mo = 9, d = 1) =>
  Date.UTC(
    y,
    mo,
    d,
    Math.min(Math.floor(min / 60), 23),
    Math.floor(min % 60),
    0,
    0,
  ) + ms;

function bar(t, o, h, l, c, v) {
  return { openTime: t, open: o, high: h, low: l, close: c, volume: v };
}

const oneMinuteSeries = [];
for (let i = 0; i < 30; i++) {
  const t = m(60 * 10 + i); // 10:00:00 -> 10:29:00 UTC
  oneMinuteSeries.push(
    bar(t, 100 + i, 100 + i + 0.5, 100 + i - 0.5, 100 + i + 0.3, 2),
  );
}

test("1m -> 15m buckets 30 minutes into 2 candles", () => {
  const out = aggregate(oneMinuteSeries, "15m");
  assert.equal(out.length, 2);
  assert.equal(out[0].openTime, m(600));
  assert.equal(out[1].openTime, m(615));
  // OHLCV invariants
  assert.equal(out[0].open, 100);
  assert.equal(out[0].close, 100 + 14 + 0.3);
  assert.equal(
    out[0].high,
    Math.max(...oneMinuteSeries.slice(0, 15).map((c) => c.high)),
  );
  assert.equal(
    out[0].low,
    Math.min(...oneMinuteSeries.slice(0, 15).map((c) => c.low)),
  );
  assert.equal(
    out[0].volume,
    oneMinuteSeries.slice(0, 15).reduce((s, c) => s + c.volume, 0),
  );
});

test("1m -> 1h aligns to UTC hour boundary", () => {
  const out = aggregate(oneMinuteSeries, "1h");
  assert.equal(out.length, 1);
  assert.equal(out[0].openTime, m(600));
});

test("1m -> 1d aligns to UTC midnight", () => {
  const twoDays = [
    bar(m(60 * 23, 0, 2026, 9, 1) - 60000, 1, 2, 0.5, 1.5, 1), // 22:59 prev day
    bar(m(0, 0, 2026, 9, 2), 2, 3, 1, 2.5, 2), // 00:00
    bar(m(60 * 5, 0, 2026, 9, 2), 2.5, 4, 2, 3.9, 3), // 05:00
  ];
  const out = aggregate(twoDays, "1d");
  assert.equal(out.length, 2);
  assert.equal(out[0].openTime, m(0, 0, 2026, 9, 1));
  assert.equal(out[1].openTime, m(0, 0, 2026, 9, 2));
  assert.equal(out[0].close, 1.5);
  assert.equal(out[1].high, 4);
});

test("1m -> 1w buckets align to Monday 00:00 UTC", () => {
  // 2026-10-05 is a Monday (UTC). Build candles Mon..Sat
  const sat = Date.UTC(2026, 9, 10, 10, 0);
  const sunday = Date.UTC(2026, 9, 11, 10, 0); // still previous Monday's week in UTC convention
  const out = aggregate(
    [bar(sat, 1, 1, 1, 1, 1), bar(sunday, 2, 2, 2, 2, 2)],
    "1w",
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].openTime, Date.UTC(2026, 9, 5));
  assert.equal(out[0].volume, 3);
});

test("1m -> 1M buckets by calendar month (UTC)", () => {
  const out = aggregate(
    [
      bar(Date.UTC(2026, 0, 31, 22), 1, 1, 1, 1, 1),
      bar(Date.UTC(2026, 1, 1, 0), 2, 2, 2, 2, 2),
      bar(Date.UTC(2026, 1, 20, 5), 3, 3, 3, 3, 3),
    ],
    "1M",
  );
  assert.equal(out.length, 2);
  assert.equal(out[0].openTime, Date.UTC(2026, 0, 1));
  assert.equal(out[1].openTime, Date.UTC(2026, 1, 1));
});

test("3d anchor: epoch-anchored 3-day blocks", () => {
  // epoch day 0 = 1970-01-01 (Thursday). Oct 2026 days-since-epoch D; bucket = D - (D mod 3)
  const probes = [
    Date.UTC(2026, 9, 1),
    Date.UTC(2026, 9, 2),
    Date.UTC(2026, 9, 3),
    Date.UTC(2026, 9, 4),
  ];
  const out = aggregate(
    probes.map((t, i) => bar(t, i, i, i, i, i)),
    "3d",
  );
  assert.equal(new Set(out.map((c) => c.openTime)).size, out.length);
  for (const c of out) {
    const d = Math.floor(c.openTime / 86400000);
    assert.equal(d % 3, 0);
  }
});

test("aggregation is ascending, non-mutating, and out-of-order input is tolerated", () => {
  const shuffled = [
    oneMinuteSeries[21],
    oneMinuteSeries[3],
    oneMinuteSeries[15],
    oneMinuteSeries[11],
  ];
  const before = JSON.stringify(shuffled);
  const out = aggregate(shuffled, "5m");
  assert.equal(
    before,
    JSON.stringify([
      oneMinuteSeries[21],
      oneMinuteSeries[3],
      oneMinuteSeries[15],
      oneMinuteSeries[11],
    ]),
  );
  assert.equal(out.length, 4);
  for (let i = 1; i < out.length; i++)
    assert.ok(out[i].openTime > out[i - 1].openTime);
});

test("5m -> 15m (base interval larger than 1m)", () => {
  const out = aggregate(
    [
      bar(Date.UTC(2026, 9, 1, 10, 0), 1, 2, 0.5, 1.2, 1),
      bar(Date.UTC(2026, 9, 1, 10, 5), 1.2, 3, 1, 2.2, 1),
      bar(Date.UTC(2026, 9, 1, 10, 10), 2.2, 4, 2, 3.3, 1),
    ],
    "15m",
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].openTime, Date.UTC(2026, 9, 1, 10, 0));
  assert.equal(out[0].high, 4);
  assert.equal(out[0].low, 0.5);
});
