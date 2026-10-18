// V-IND — public-domain indicator math. Tests written BEFORE implementation (TDD).
import { test } from "node:test";
import assert from "node:assert/strict";
import { sma, ema, rsi, macd, bollinger } from "../src/indicators.js";

test("SMA(3) on arithmetic series", () => {
  const out = sma([1, 2, 3, 4, 5], 3);
  assert.deepEqual(out.slice(0, 2), [null, null]);
  assert.deepEqual(out.slice(2), [2, 3, 4]);
});

test("EMA(3) seeded by SMA", () => {
  const out = ema([1, 2, 3, 4, 5], 3);
  assert.deepEqual(out.slice(0, 2), [null, null]);
  assert.equal(out[2], 2);
  // alpha = 2/(n+1) = 0.5 -> ema = prev + 0.5 * (x - prev)
  assert.equal(out[3], 3);
  assert.equal(out[4], 4);
});

test("RSI Wilder: hand-computed fixture (n=3)", () => {
  // closes -> diffs: +1, -0.5, +1, -0.5, +1, -0.5, -2
  // seed (first n=3 diffs): avgGain=(1+0+1)/3=0.6666667, avgLoss=(0+0.5+0)/3=0.1666667,
  //   RS=4 -> RSI=100-100/(1+4)=80
  // step4 (d=-0.5): g=(2/3*2+0)/3=0.444444, l=(1/6*2+0.5)/3=0.277778 -> RS=1.6 -> 61.53846..
  // step5 (d=+1):   g=(0.444444*2+1)/3=0.629630, l=(0.277778*2+0)/3=0.185185 -> RSI=77.27273
  // step6 (d=-0.5): g=(0.629630*2)/3=0.419753, l=(0.185185*2+0.5)/3=0.290123 -> RSI=59.12780
  // step7 (d=-2):   g=(0.419753*2)/3=0.279835, l=(0.290123*2+2)/3=0.860082 -> RSI=24.54715 (hand: 24.547)
  const closes = [100, 101, 100.5, 101.5, 101, 102, 101.5, 99.5];
  const out = rsi(closes, 3);
  assert.equal(out.length, closes.length);
  assert.equal(out[0], null);
  const i0 = 3; // first RSI readable after the first n=3 changes (index 3)
  assert.equal(out[i0 - 1], null);
  const approx = (v, e, tol = 0.01) => Math.abs(v - e) < tol;
  assert.ok(approx(out[i0], 80), "seed RSI 80");
  assert.ok(approx(out[i0 + 1], 61.5385), "61.5385");
  assert.ok(approx(out[i0 + 2], 77.2727), "77.2727");
  assert.ok(approx(out[i0 + 3], 59.1278), "59.1278");
  assert.ok(approx(out[i0 + 4], 24.5472, 0.05), "24.5472");
});

test("RSI extremes: all-up -> 100, all-down -> 0", () => {
  const up = Array.from({ length: 20 }, (_, i) => i + 1);
  const down = Array.from({ length: 20 }, (_, i) => 20 - i);
  const rUp = rsi(up, 14);
  const rDown = rsi(down, 14);
  assert.equal(rUp[rUp.length - 1], 100);
  assert.equal(rDown[rDown.length - 1], 0);
});

test("RSI stays in [0,100] on random-ish fixture", () => {
  const closes = [
    5, 4, 6, 3, 7, 2, 8, 1, 9, 0, 10, 1, 9, 2, 8, 3, 7, 4, 6, 5, 6, 5,
  ];
  for (const v of rsi(closes, 14)) {
    if (v === null) continue;
    assert.ok(v >= 0 && v <= 100, "RSI within bounds");
  }
});

test("MACD: line = EMA12-EMA26, signal = EMA9(line); rising trend yields positive hist later", () => {
  const closes = Array.from({ length: 200 }, (_, i) => 100 + i * 0.5);
  const { macd: line, signal, hist } = macd(closes);
  assert.equal(line.length, closes.length);
  const last = closes.length - 1;
  assert.ok(line[last] > 0);
  assert.ok(signal[last] !== null);
  // hand-derived: ema_n of a ramp x_i = a+s*i sits s*(n-1)/2 BELOW x
  // -> e12 = x - 5.5s, e26 = x - 12.5s -> line = 7s = +3.5 exactly
  assert.ok(
    Math.abs(line[last] - 3.5) < 0.01,
    `line converged to 7s=+3.5, got ${line[last]}`,
  );
  // line itself settles CONSTANT at 3.5 -> signal ema of a constant -> same; hist -> 0
  assert.ok(
    Math.abs(hist[last]) < 0.05,
    `hist converged to 0, got ${hist[last]}`,
  );
});

test("Bollinger(20,2): constant series collapses bands; std window is correct", () => {
  const flat = Array(20).fill(5);
  const { upper, lower, basis } = bollinger([...flat, 5, 5], 20, 2);
  const last = flat.length + 2 - 1;
  assert.equal(basis[last], 5);
  assert.equal(upper[last], 5);
  assert.equal(lower[last], 5);
  const { upper: u2, lower: l2 } = bollinger([...flat, 6], 20, 2);
  assert.ok(u2[20] > 5 && l2[20] < 5);
  // window [5x19, 6]: mean 101/20 = 5.05; pop-var = (19*0.05^2 + 0.95^2)/20 = 0.0475 -> std = sqrt(0.0475)
  assert.ok(Math.abs(u2[20] - (5.05 + 2 * Math.sqrt(0.0475))) < 1e-6);
  assert.ok(Math.abs(l2[20] - (5.05 - 2 * Math.sqrt(0.0475))) < 1e-6);
});
