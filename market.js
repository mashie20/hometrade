// hometrade — whole-market access: keyless Yahoo Finance polling adapter,
// Nasdaq Trader SymDir universe loader, and a deterministic staggered poller.
// Public data only; no keys; equities quotes arrive on a best-effort poll
// cadence (labeled POLL vs the WebSocket-powered LIVE of crypto sources).

import { resolveSymbol } from "./exchanges.js";

// our interval -> yahoo chart interval + range (bucket-cadence, point-in-time)
const CHART_STYLE = {
  "1m": { interval: "1m", range: "1d" },
  "5m": { interval: "5m", range: "5d" },
  "15m": { interval: "15m", range: "1mo" },
  "30m": { interval: "30m", range: "1mo" },
  "1h": { interval: "1h", range: "3mo" },
  "1d": { interval: "1d", range: "2y" },
  "1w": { interval: "1wk", range: "5y" },
  "1M": { interval: "1mo", range: "10y" },
};

export function yahooChartPath(symbolKey) {
  const info = resolveSymbol(symbolKey);
  return info.native.replace(/\^/g, "%5E");
}

export function yahooChartUrl(symbolKey, interval) {
  const style = CHART_STYLE[interval];
  if (!style) throw new Error(`no yahoo chart style for ${interval}`);
  const host = Math.random() < 0.5 ? "query1" : "query2";
  return `https://${host}.finance.yahoo.com/v8/finance/chart/${yahooChartPath(symbolKey)}?interval=${style.interval}&range=${style.range}&includePrePost=false&events=div%2Csplit`;
}

// Yahoo chart doc -> canonical candles (ascending, ms openTime, nulls dropped)
export function normalizeYahooChart(doc) {
  const r = doc?.chart?.result?.[0];
  if (!r) {
    const err = doc?.chart?.error?.description ?? "yahoo chart error";
    throw new Error(err);
  }
  const q = r.indicators?.quote?.[0] ?? {};
  const out = [];
  const ts = r.timestamp ?? [];
  for (let i = 0; i < ts.length; i++) {
    const close = q.close?.[i];
    if (close === null || close === undefined) continue; // pre-market gaps
    out.push({
      openTime: Number(ts[i]) * 1000,
      open: +q.open?.[i],
      high: +q.high?.[i],
      low: +q.low?.[i],
      close: +close,
      volume: +(q.volume?.[i] ?? 0),
    });
  }
  out.sort((a, b) => a.openTime - b.openTime);
  return out;
}

// ---- Nasdaq Trader SymDir universe (whole market, keyless, official) ----

export function parseSymDir(text, exchange) {
  const lines = String(text).split(/\r?\n/);
  const seen = new Set();
  const rows = [];
  for (const line of lines) {
    const c = line.split("|");
    if (c.length < 8 || c[0] === "Symbol" || c[0].startsWith("File Creation")) {
      continue;
    }
    const symbol = c[0].trim().toUpperCase();
    if (!symbol || c[3] === "Y") continue; // test issues are not tradable
    if (symbol.endsWith("$")) continue; // preferred-share placeholders
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    rows.push({
      symbol,
      name: c[1].trim(),
      exchange,
      etf: c[6] === "Y",
    });
  }
  return rows;
}

// prefix matches outrank name substrings; returns loadable symbol keys.
// Every listed exchange routes through the YAHOO polling source; the listing
// venue is kept for display.
export function searchUniverse(q, universe, limit = 12) {
  const query = String(q ?? "").toUpperCase();
  if (!query) return [];
  const scored = [];
  for (const row of universe) {
    const sym = row.symbol;
    let rank = -1;
    if (sym === query) rank = 0;
    else if (sym.startsWith(query)) rank = 1;
    else if (row.name?.toUpperCase().includes(query)) rank = 2;
    if (rank >= 0) scored.push({ row, rank });
  }
  scored.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.row.symbol.length - b.row.symbol.length ||
      a.row.symbol.localeCompare(b.row.symbol),
  );
  return scored.slice(0, limit).map(({ row }) => ({
    key: `YAHOO:${row.symbol}`,
    symbol: row.symbol,
    name: row.name,
    exchange: row.exchange, // listing venue (display only)
  }));
}

// ---- poller (injectable; staggered by caller) ----

export function createPoller({ fetchLast } = {}) {
  const subs = [];
  const listeners = new Set();
  return {
    subscribe(key) {
      if (!subs.includes(key)) subs.push(key);
    },
    unsubscribe(key) {
      const i = subs.indexOf(key);
      if (i > -1) subs.splice(i, 1);
    },
    list() {
      return [...subs];
    },
    onTick(cb) {
      listeners.add(cb);
    },
    async pump(keys) {
      for (const key of [...(keys ?? this.list())]) {
        if (!subs.includes(key)) continue;
        let snap = null;
        try {
          snap = await fetchLast(key);
        } catch {
          continue; // upstream wobble: skip this round
        }
        if (!snap) continue;
        for (const cb of listeners) cb(key, snap);
      }
    },
  };
}
