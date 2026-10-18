// hometrade — exchange catalogs & symbol normalization (original)

import { INTERVALS } from "./time.js";

// Source granularity support is per-exchange; unsupported view intervals are
// rejected with a clear error (see supportedIntervals / policy check in session).
export const EXCHANGES = {
  BINANCE: {
    displayName: "Binance (public, keyless)",
    native: (ticker) => ticker.toUpperCase(),
    intervals: /* full public catalog */ Object.fromEntries(
      INTERVALS.map((iv) => [iv, iv]),
    ),
  },
  COINBASE: {
    displayName: "Coinbase (public, keyless)",
    native: (ticker) => tickerToProduct(ticker),
    granularity: {
      "1m": 60,
      "5m": 300,
      "15m": 900,
      "30m": 1800,
      "1h": 3600,
      "6h": 21600,
      "1d": 86400,
    },
  },
  YAHOO: {
    // whole US-market equities universe (NYSE/NASDAQ/AMEX) via the keyless
    // public chart endpoint; near-real-time by short-cadence polling.
    displayName: "Yahoo Finance (public, keyless, equities universe)",
    native: (ticker) => ticker.replace(/\./g, "-").toUpperCase(),
    intervals: {
      "1m": 60,
      "5m": 300,
      "15m": 900,
      "30m": 1800,
      "1h": 3600,
      "1d": 86400,
      "1w": 604800,
      "1M": 2592000,
    },
  },
};

function tickerToProduct(ticker) {
  const t = ticker.replace(/-/g, "").toUpperCase();
  // Coinbase spot product ids use USD as the quote (e.g. BTC-USD); our
  // catalog keys keep the USDT style, so USDT -> USD on the way out.
  const m = /^(.+?)(USDT|USD|EUR|GBP)$/.exec(t);
  if (m) return `${m[1]}-${m[2] === "USDT" ? "USD" : m[2]}`;
  return t;
}

export function resolveSymbol(symbolKey) {
  const m = /^([A-Z0-9_]+):([A-Z0-9_.-]+)$/.exec(symbolKey);
  if (!m)
    throw new Error(
      `invalid symbol key ${JSON.stringify(symbolKey)} (expected EXCHANGE:TICKER)`,
    );
  const [, exchange, ticker] = m;
  if (!EXCHANGES[exchange])
    throw new Error(
      `unknown exchange ${exchange} (supported: ${Object.keys(EXCHANGES).join(", ")})`,
    );
  return {
    exchange,
    ticker,
    displayName: ticker,
    native: EXCHANGES[exchange].native(ticker),
    key: symbolKey,
  };
}

export function sourceIntervalsFor(exchange) {
  const ex = EXCHANGES[exchange];
  if (!ex) throw new Error(`unknown exchange ${exchange}`);
  return ex.intervals ?? ex.granularity ?? {};
}

export function supportedIntervals(exchange) {
  return Object.keys(sourceIntervalsFor(exchange));
}

export function exchangeSupportsInterval(exchange, interval) {
  return supportedIntervals(exchange).includes(interval);
}

export function granularitySeconds(exchange, interval) {
  return sourceIntervalsFor(exchange)[interval];
}
