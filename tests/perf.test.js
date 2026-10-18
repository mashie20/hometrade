// V-PERF — soft performance gates (generous thresholds for CI variance). Written BEFORE implementation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregate } from "../src/aggregation.js";
import { computeView } from "../src/view.js";
import { performance } from "node:perf_hooks";

const oneMinute = Array.from({ length: 10_000 }, (_, i) => ({
  openTime: i * 60000,
  open: 100 + i * 0.01,
  high: 101 + i * 0.01,
  low: 99 + i * 0.01,
  close: 100.5 + i * 0.01,
  volume: 1 + (i % 3),
}));

test("aggregate 10k x 1m -> 15m under generous 400ms budget", () => {
  const t0 = performance.now();
  const out = aggregate(oneMinute, "15m");
  const ms = performance.now() - t0;
  assert.equal(out.length, Math.ceil(10_000 / 15));
  assert.ok(ms < 400, `aggregation took ${ms.toFixed(1)}ms (budget 400ms)`);
});

test("view layout math for 1000 candles under generous 80ms budget", () => {
  const series = Array.from({ length: 1000 }, (_, i) => ({
    openTime: i * 60000,
    open: 100 + i,
    high: 101 + i,
    low: 99 + i,
    close: 100.5 + i,
    volume: 1,
  }));
  const t0 = performance.now();
  const view = computeView(series, {
    width: 1440,
    height: 900,
    barsOnScreen: 1000,
    rightOffset: 0,
  });
  const ms = performance.now() - t0;
  assert.equal(view.candles.length, 1000);
  assert.ok(ms < 80, `view math took ${ms.toFixed(1)}ms (budget 80ms)`);
});

if (process.argv[1] && process.argv[1].endsWith("perf.test.js")) {
  console.log(
    "perf module self-run: measurements printed by the assertions above (if any failed).",
  );
}
