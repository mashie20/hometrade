// hometrade — time aggregation (public-domain OHLCV bucketing, original code)
import { bucketStart } from "./time.js";

/**
 * aggregate(baseCandles, interval) -> [candle]
 * Invariants (SPEC §3):
 *  - open = first bar open; close = last bar close; high = max; low = min; volume = sum
 *  - never mutates input; output ascending by openTime; tolerates out-of-order input
 */
export function aggregate(baseCandles, interval) {
  const sorted = [...baseCandles].sort((a, b) => a.openTime - b.openTime);
  const out = [];
  let cur = null,
    curKey = null;
  for (const c of sorted) {
    const key = bucketStart(c.openTime, interval);
    if (curKey !== key) {
      if (cur) out.push(cur);
      curKey = key;
      cur = {
        openTime: key,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      };
    } else {
      if (c.high > cur.high) cur.high = c.high;
      if (c.low < cur.low) cur.low = c.low;
      cur.close = c.close;
      cur.volume += c.volume;
    }
  }
  if (cur) out.push(cur);
  return out;
}
