// hometrade — feed adapters. Cleanroom wire semantics: ONE persistent connection;
// the client drives subscribes/resubscribes on view changes. REST bar normalization
// is per-source; the wire protocols of remote sources remain outside our contracts.

import {
  resolveSymbol,
  EXCHANGES,
  exchangeSupportsInterval,
  granularitySeconds,
} from "./exchanges.js";
import { isInterval } from "./time.js";
import { yahooChartUrl, normalizeYahooChart } from "./market.js";

export function buildKlinesUrl(symbolKey, interval, limit = 1000) {
  const info = resolveSymbol(symbolKey);
  if (!isInterval(interval)) throw new Error(`unknown interval ${interval}`);
  if (!exchangeSupportsInterval(info.exchange, interval)) {
    throw new Error(`interval ${interval} not supported by ${info.exchange}`);
  }
  const native = EXCHANGES[info.exchange].native(info.ticker);
  if (info.exchange === "COINBASE") {
    const sec = granularitySeconds("COINBASE", interval);
    return `https://api.exchange.coinbase.com/products/${native}/candles?granularity=${sec}`;
  }
  if (info.exchange === "YAHOO") {
    return yahooChartUrl(symbolKey, interval);
  }
  // BINANCE (and any future URL-shaped source): klines shape
  const url = new URL("https://api.binance.com/api/v3/klines");
  url.searchParams.set("symbol", native);
  url.searchParams.set("interval", interval);
  url.searchParams.set("limit", String(limit));
  return url.toString();
}

// Normalize source-specific candle rows into our canonical candle shape (ascending).
export function normalizeSourceRows(url, rows) {
  if (/api\.exchange\.coinbase\.com/.test(url)) {
    // [ time(s), low, high, open, close, volume ] — source returns descending
    return rows
      .map((r) => ({
        openTime: Number(r[0]) * 1000,
        open: +r[3],
        high: +r[2],
        low: +r[1],
        close: +r[4],
        volume: +r[5],
      }))
      .sort((a, b) => a.openTime - b.openTime);
  }
  if (/finance\.yahoo\.com\/v8\/finance\/chart/.test(url)) {
    // Yahoo replies with a chart document, not row arrays
    return normalizeYahooChart(rows);
  }
  // binance klines: [ openTime, o, h, l, c, v, ... ]
  return rows.map((k) => ({
    openTime: +k[0],
    open: +k[1],
    high: +k[2],
    low: +k[3],
    close: +k[4],
    volume: +k[5],
  }));
}

export class BinanceFeed {
  constructor({ transport, fetcher } = {}) {
    this._makeTransport = transport || null; // () => transport instance
    this._fetcher = fetcher || null; // async (url) => source-shaped rows
    this._transport = null;
    this._connected = false;
    this._binding = null;
  }

  nativeSymbol(symbolKey) {
    const info = resolveSymbol(symbolKey);
    return EXCHANGES[info.exchange].native(info.ticker);
  }

  async connect() {
    if (!this._transport && this._makeTransport)
      this._transport = this._makeTransport();
    if (this._transport && !this._connected) {
      await this._transport.connect?.();
      this._connected = true;
    }
  }

  async loadBars(symbolKey, interval, limit = 1000) {
    if (!this._fetcher) throw new Error("no fetcher configured");
    return this._fetcher(buildKlinesUrl(symbolKey, interval, limit));
  }

  async subscribe(symbolKey, interval) {
    await this.connect();
    if (!this._transport) throw new Error("no transport configured");
    const next = `${symbolKey}@${interval}`;
    const isSwitch = this._binding !== null && this._binding !== next;
    this._binding = next;
    await this._transport.send({
      type: "subscribe",
      symbolKey,
      interval,
      wasResubscribe: isSwitch,
    });
  }

  onCandle(symbolKey, cb) {
    this._transport?.on?.("candle", (sk, c) => {
      if (sk === symbolKey) cb(c);
    });
  }

  async close() {
    this._transport?.close?.();
    this._connected = false;
  }
}
