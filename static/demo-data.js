// hometrade — offline demo generator (GitHub Pages static mode only).
// Deterministic seeded random walk per symbol@interval; clearly synthetic:
// no remote fetches, no live pretense. Server mode (local Node) never uses it.

const STEP_MS = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "12h": 43_200_000,
  "1d": 86_400_000,
  "1w": 604_800_000,
  "1M": 2_592_000_000, // 30d buckets for demo grid
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function demoSeries(
  symbolKey,
  interval,
  count = 400,
  nowMs = Date.now(),
) {
  const step = STEP_MS[interval] ?? 60_000;
  const key = `${symbolKey}@${interval}`;
  let seed = 0;
  for (let i = 0; i < key.length; i++) {
    seed = (seed * 31 + key.charCodeAt(i)) >>> 0;
  }
  const rnd = mulberry32(seed);
  const end = Math.floor(nowMs / step) * step;
  // base price stable per symbol so demo numbers feel consistent across reloads
  const base =
    (typeof symbolKey === "string" ? symbolKey : "X")
      .split("")
      .reduce(
        (acc, ch) => (acc * 37 + ch.charCodeAt(0)) % 90_000,
        100 + ((seed % 90_000) | 0),
      ) + 1;
  const series = [];
  let price = base < 10 ? 50 : Math.abs(base);
  for (let i = typeof count === "number" ? count : 0; i > 0; i--) {
    const openTime = end - (i - 1) * step;
    const drift = (rnd() - 0.48) * 0.01;
    const o = price;
    const c = Math.max(0.0001, o * (1 + drift + (rnd() - 0.5) * 0.004));
    const hi = Math.max(o, c) * (1 + rnd() * 0.003);
    const lo = Math.min(o, c) * (1 - rnd() * 0.003);
    const v = 1 + rnd() * 99;
    series.push({
      openTime,
      open: o,
      high: hi,
      low: lo,
      close: c,
      volume: v,
    });
    price = c;
  }
  return series;
}
