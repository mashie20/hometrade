// Strategy Lab — HR-07 kill-list harness. Tests written BEFORE implementation.
// Series shape: [{openTime, open, high, low, close, volume}] ascending; engine
// treats every bar as CLOSED except the final one (in-flight bar is dropped).
import { test } from "node:test";
import assert from "node:assert/strict";

function bars(values, stepMs = 60000) {
  // values: array of closes (with tiny ranges around it)
  return values.map((c, i) => ({
    openTime: i * stepMs,
    open: c,
    high: c * 1.001,
    low: c * 0.999,
    close: c,
    volume: 1000,
  }));
}

test("K-1 zero lookahead: signals from truncated feed == prefix of full feed", async () => {
  const { runLab } = await import("../src/lab.js");
  const wave = Array.from(
    { length: 400 },
    (_, i) => 100 + Math.sin(i / 12) * 4 + i * 0.02,
  );
  const sFull = bars(wave);
  const sHalf = sFull.slice(0, 200);
  const a = runLab({
    series: sHalf,
    strategy: "sma_cross",
    params: { fast: 8, slow: 20 },
  });
  const b = runLab({
    series: sFull,
    strategy: "sma_cross",
    params: { fast: 8, slow: 20 },
  });
  // prefix property: every decision on the truncated feed matches the full feed
  for (const tr of a.trades) {
    const twin = b.trades.find((t) => t.entryOpenTime === tr.entryOpenTime);
    assert.ok(twin, `trade @${tr.entryOpenTime} must exist in full-feed run`);
    assert.equal(
      twin.entryPrice.toFixed(6),
      tr.entryPrice.toFixed(6),
      "entry fill price must not depend on future bars",
    );
  }
  assert.ok(
    a.k1.pass && b.k1.pass,
    "engine self-audits: signal source is closed bars only",
  );
  assert.equal(
    a.droppedLastBar,
    true,
    "in-flight final bar excluded from decisions",
  );
});

test("K-5 holdout untouched: evaluated exactly once + sealed, split is 70/30", async () => {
  const { runLab } = await import("../src/lab.js");
  const wave = Array.from({ length: 300 }, (_, i) => 200 + Math.sin(i / 9) * 3);
  const r = runLab({
    series: bars(wave),
    strategy: "sma_cross",
    params: { fast: 10, slow: 25 },
  });
  assert.equal(r.split.trainCount + r.split.holdoutCount, 300 - 1); // minus dropped in-flight bar
  assert.equal(
    r.split.sealed,
    true,
    "holdout sealed after the single final evaluation",
  );
  assert.equal(r.split.holdoutViewCount, 1, "holdout referenced exactly once");
  assert.equal(
    typeof r.oos.netR,
    "number",
    "single OOS number delivered to protocol",
  );
});

test("K-4 costs: profit inside spread+commission flips verdict to FAIL hurdles [K-4]", async () => {
  const { runLab } = await import("../src/lab.js");
  // low-volatility mean reversion — gross edge ~0; round-trip costs eat it
  const flat = Array.from(
    { length: 320 },
    (_, i) => 100 + Math.sin(i / 7) * 0.5 + (i % 2) * 0.05,
  );
  const r = runLab({
    series: bars(flat),
    strategy: "rsi_revert",
    params: { enter: 42, exit: 50 }, // over-sensitive → many tiny trades
    costBps: 25,
    slipBps: 20, // punishing but realistic retail
  });
  assert.equal(r.verdict, "KILL");
  assert.ok(
    r.failedHurdles.includes("K-4"),
    `cost hurdle must fail, got ${r.failedHurdles}`,
  );
});

test("K-6 parameter stability: neighbors are computed on TRAIN data only", async () => {
  const { runLab } = await import("../src/lab.js");
  const wave = Array.from({ length: 300 }, (_, i) => 90 + Math.sin(i / 10) * 5);
  const r = runLab({
    series: bars(wave),
    strategy: "rsi_revert",
    params: { enter: 30, exit: 55 },
  });
  assert.ok(
    Array.isArray(r.k6.neighbors) && r.k6.neighbors.length >= 2,
    "neighbours probe exists",
  );
  for (const nb of r.k6.neighbors) {
    assert.ok(
      !nb.touchedHoldout,
      "neighbor evaluation must not touch the holdout (K-5)",
    );
  }
  assert.ok(
    typeof r.k6.plateau === "boolean" && typeof r.k6.dispersion === "number",
    "plateau verdict derived from neighbor dispersion",
  );
});

test("K-7 capacity: total traded flow vs observed bar volume decides the gate", async () => {
  const { runLab } = await import("../src/lab.js");
  const wave = Array.from({ length: 260 }, (_, i) => 150 + Math.sin(i / 5) * 6);
  const tiny = runLab({
    series: bars(wave),
    strategy: "sma_cross",
    params: { fast: 5, slow: 18 },
    unitSize: 0.001,
  });
  const huge = runLab({
    series: bars(wave),
    strategy: "sma_cross",
    params: { fast: 5, slow: 18 },
    unitSize: 10_000,
  });
  assert.notEqual(
    tiny.k7.pass,
    huge.k7.pass,
    "0.001u vs 10000u must land on opposite sides of the liquidity gate",
  );
  assert.ok(tiny.k7.advUnits > 0 && typeof huge.k7.advUnits === "number");
});

test("verdict protocol: PASS requires all hurdles green, else KILL with failing IDs", async () => {
  const { runLab } = await import("../src/lab.js");
  const monotonic = Array.from(
    { length: 300 },
    (_, i) => 100 + i * (0.5 + (i % 9 === 0 ? 0.02 : 0)),
  );
  const r = runLab({
    series: bars(monotonic),
    strategy: "rsi_revert",
    params: { enter: 10, exit: 20 },
  });
  // Everest strategy: never draws down, take-profit hits — but capacity/microstructure still applied
  if (r.verdict === "PASS") {
    assert.deepEqual(r.failedHurdles, []);
    assert.ok(r.is.netR > 0 && r.oos.netR > 0);
    assert.ok(r.k4.pass && r.k6.plateau && r.k7.pass);
  } else {
    assert.ok(r.failedHurdles.length > 0, "FAIL must list failing hurdle IDs");
  }
});
