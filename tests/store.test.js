// V-STORE — local-first bar cache contract. Tests written BEFORE implementation (TDD).
import { test } from "node:test";
import assert from "node:assert/strict";
import { BarStore } from "../src/store.js";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bar = (t, c) => ({
  openTime: t,
  open: c,
  high: c + 1,
  low: c - 1,
  close: c,
  volume: 1,
});

test("merge dedupes by openTime and stays ascending", () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-store-"));
  try {
    const store = new BarStore(dir);
    const key = { exchange: "BINANCE", ticker: "TESTUSDT", interval: "15m" };
    store.merge(key, [bar(1000, 1), bar(900000, 2)]);
    store.merge(key, [bar(15000, 3), bar(1000, 1)]); // dup + older insert
    const all = store.load(key);
    assert.deepEqual(
      all.map((c) => c.openTime),
      [1000, 15000, 900000],
    );
    assert.equal(all.length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("append persists JSONL atomically; reload from disk returns merged set", () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-store-"));
  try {
    const store = new BarStore(dir);
    const key = { exchange: "BINANCE", ticker: "TESTUSDT", interval: "1h" };
    store.merge(key, [bar(1000, 1), bar(2000, 2)]);
    store.flush(key);
    // new store instance reads the same files (local-first offline behavior)
    const other = new BarStore(dir);
    const all = other.load(key);
    assert.equal(all.length, 2);
    const raw = readFileSync(
      join(dir, "bars", "BINANCE", "TESTUSDT", "1h.jsonl"),
      "utf8",
    );
    assert.match(raw, /"openTime":1000/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("offline CACHE_HIT: fresh store serves cached bars with no network", () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-store-"));
  try {
    const store = new BarStore(dir);
    const key = { exchange: "BINANCE", ticker: "OFFLINE", interval: "1d" };
    store.merge(key, [bar(0, 1), bar(86400000, 2)]);
    store.flush(key);
    const fresh = new BarStore(dir);
    assert.equal(fresh.load(key).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
