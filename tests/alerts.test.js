// V-AL — alerts engine contract. Tests written BEFORE implementation (TDD).
import { test } from "node:test";
import assert from "node:assert/strict";
import { AlertsEngine } from "../src/alerts.js";

function memoryRepo() {
  const state = { alerts: [] };
  return {
    read: async () => state.alerts,
    write: async (alerts) => {
      state.alerts = alerts;
    },
    snapshot: () => state.alerts,
  };
}
const candle = (c) => ({
  openTime: 0,
  open: c,
  high: c,
  low: c,
  close: c,
  volume: 1,
});

test("price crosses above -> fires once, persists fired state, toast emitted", async () => {
  const repo = memoryRepo();
  const toasts = [];
  const engine = new AlertsEngine(repo, { toast: (t) => toasts.push(t) });
  const rule = await engine.add({
    symbol: "BINANCE:BTCUSDT",
    interval: "15m",
    kind: "above",
    price: 105,
  });
  assert.equal(rule.armed, true);

  await engine.evaluate("BINANCE:BTCUSDT", candle(100)); // below -> no fire
  assert.equal(countFired(engine), 0);
  await engine.evaluate("BINANCE:BTCUSDT", candle(106)); // crosses -> fire
  assert.equal(countFired(engine), 1);
  await engine.evaluate("BINANCE:BTCUSDT", candle(107)); // still above -> no refire
  await engine.evaluate("BINANCE:BTCUSDT", candle(104)); // below -> no refire
  assert.equal(countFired(engine), 1);
  assert.equal(toasts.length, 1);
  const persisted = engine.list();
  assert.equal(persisted[0].armed, false, "fired state persisted");

  await engine.rearm(rule.id);
  await engine.evaluate("BINANCE:BTCUSDT", candle(110));
  assert.equal(
    engine.list()[0].firedCount,
    2,
    "explicit rearm -> refire increments the same rule's count",
  );
});

test("kind below fires on downward cross only", async () => {
  const engine = new AlertsEngine(memoryRepo());
  await engine.add({
    symbol: "BINANCE:ETHUSDT",
    interval: "1h",
    kind: "below",
    price: 50,
  });
  await engine.evaluate("BINANCE:ETHUSDT", candle(60));
  await engine.evaluate("BINANCE:ETHUSDT", candle(49));
  const fired = engine.list().filter((a) => !a.armed).length;
  assert.equal(fired, 1);
});

test("delete removes rule; symbols filter works", async () => {
  const engine = new AlertsEngine(memoryRepo());
  const a = await engine.add({
    symbol: "BINANCE:BTCUSDT",
    interval: "15m",
    kind: "above",
    price: 1,
  });
  await engine.add({
    symbol: "BINANCE:ETHUSDT",
    interval: "15m",
    kind: "above",
    price: 2,
  });
  await engine.delete(a.id);
  assert.equal(engine.list("BINANCE:BTCUSDT").length, 0);
  assert.equal(engine.list("BINANCE:ETHUSDT").length, 1);
});

function countFired(engine) {
  return engine.list().filter((a) => a.firedCount > 0).length;
}
