// hometrade — time & interval catalog (public-domain conventions, original code)

export const INTERVALS = [
  "1m",
  "3m",
  "5m",
  "15m",
  "30m",
  "1h",
  "2h",
  "4h",
  "6h",
  "8h",
  "12h",
  "1d",
  "3d",
  "1w",
  "1M",
];

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

export function isInterval(x) {
  return INTERVALS.includes(x);
}

// Milliseconds per interval; null for calendar-month "1M".
export function intervalMs(interval) {
  if (interval === "1M") return null;
  const m = /^(\d+)([mhdw])$/.exec(interval);
  if (!m) throw new Error(`unknown interval ${JSON.stringify(interval)}`);
  return Number(m[1]) * UNIT_MS[m[2]];
}

// Returns the UTC-anchored bucket start for an epoch-ms timestamp.
//  - minute/hour: epoch multiples
//  - 1d: UTC midnight; 3d: epoch-anchored 3-day blocks; 1w: Monday 00:00 UTC
//  - 1M: first of the calendar month (UTC)
export function bucketStart(ms, interval) {
  switch (interval) {
    case "1d": {
      const days = Math.floor(ms / UNIT_MS.d);
      return days * UNIT_MS.d;
    }
    case "3d": {
      const days = Math.floor(ms / UNIT_MS.d);
      return (days - (days % 3)) * UNIT_MS.d;
    }
    case "1w": {
      const midnight = Math.floor(ms / UNIT_MS.d) * UNIT_MS.d;
      const weekday = new Date(midnight).getUTCDay(); // 0=Sun..6=Sat
      const shiftMon = (weekday + 6) % 7; // 0=Mon..6=Sun
      return midnight - shiftMon * UNIT_MS.d;
    }
    case "1M": {
      const d = new Date(ms);
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    }
    default: {
      const step = intervalMs(interval);
      return Math.floor(ms / step) * step;
    }
  }
}
