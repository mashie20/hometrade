// hometrade — Load & Render chain state machine (the traced spine, cleanroom).

import { EventEmitter } from "node:events";
import { exchangeSupportsInterval, resolveSymbol } from "./exchanges.js";
import { isInterval, bucketStart } from "./time.js";
import { aggregate } from "./aggregation.js";

const FETCH_LIMIT = 1000;

export class CandleSession extends EventEmitter {
  constructor({ store, feed, fetcher, limit = FETCH_LIMIT }) {
    super();
    this.store = store;
    this.feed = feed;
    this.fetcher = fetcher;
    this.limit = limit;
    this._symbol = null; // "EXCHANGE:TICKER"
    this._interval = null;
    this._chain = Promise.resolve();
    this._header = null;
    this._series = null;
    this._data = null;
    this._liveKeys = new Set();
  }

  viewState() {
    return { symbol: this._symbol, interval: this._interval };
  }
  currentRenderData() {
    return this._data;
  }

  async load(symbolKey, interval) {
    // serialize: concurrent loads (browser boot races) interleave validation,
    // fetch and transport subscribes -> corrupt shared view state
    const run = this._chain.then(() => this._load(symbolKey, interval));
    this._chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async _load(symbolKey, interval) {
    // 1) validation
    let info;
    try {
      info = resolveSymbol(symbolKey);
    } catch (e) {
      this.emit("invalid_symbol", { symbolKey, error: e.message });
      throw e;
    }
    if (!isInterval(interval)) {
      throw new Error(
        `unknown interval ${JSON.stringify(interval)} (catalog in time.js)`,
      );
    }
    if (!exchangeSupportsInterval(info.exchange, interval)) {
      throw new Error(`interval ${interval} not supported by ${info.exchange}`);
    }

    // 2) persistent stream session (idempotent; ONE connection)
    await this.feed.connect();

    // 3) fetch + local-first merge (memory cache works for ":memory:" stores too)
    const fetched = await this.fetcher(symbolKey, interval, this.limit);
    const storeKey = { exchange: info.exchange, ticker: info.ticker, interval };
    const cached = this.store.merge(storeKey, fetched.candles);
    if (cached.length === 0 && fetched.candles.length === 0) {
      throw new Error(`no bars available for ${symbolKey} ${interval}`);
    }
    if (fetched.cached) this.emit("cache_hit", { symbolKey, interval });
    if (this.store.root !== null && fetched.candles.length)
      this.store.flush(storeKey);

    // 4) stream attach — same socket; the feed decides fresh-vs-resubscribe
    await this.feed.subscribe(symbolKey, interval);
    if (!this._liveKeys.has(symbolKey)) {
      this._liveKeys.add(symbolKey);
      this.feed.onCandle(symbolKey, (c) =>
        this._onLiveCandle(storeKey, interval, c),
      );
    }

    // 5) aggregate + emit render data
    const series = aggregate(cached, interval);
    const prevSymbol = this._symbol;
    const prevInterval = this._interval;
    this._symbol = symbolKey;
    this._interval = interval;
    if (prevSymbol !== symbolKey) this.emit("symbol_changed", { symbolKey });
    if (prevInterval !== interval) this.emit("interval_changed", { interval });
    this._header = {
      symbol: info.ticker,
      exchange: info.exchange,
      interval,
      key: symbolKey,
      displayName: info.displayName,
    };
    this._series = series;
    this._data = { header: this._header, series, viewState: this.viewState() };
    this.emit("render_data", this._data);
    return this._data;
  }

  _onLiveCandle(storeKey, interval, c) {
    if (!this._series || !c || c.openTime === undefined) return;
    if (c.closed) {
      // completed bar -> durable merge (memory stores too) + honest re-aggregation
      this.store.merge(storeKey, [c]);
      if (this.store.root !== null) this.store.flush(storeKey);
      const cached = this.store.merge(storeKey, []);
      this._series = aggregate(cached, interval);
      this.emit("closed_candle", {
        symbolKey: `${storeKey.exchange}:${storeKey.ticker}`,
        interval,
        candle: c,
      });
    } else {
      // in-flight tick: evolve the tail bucket in place (cheap, 60fps-friendly)
      const bs = bucketStart(c.openTime, interval);
      let tail = this._series.at(-1);
      const growing = !tail || tail.openTime !== bs;
      if (growing && tail && tail.openTime > bs) return; // stale tick
      if (tail && !growing) {
        if (c.high > tail.high) tail.high = c.high;
        if (c.low < tail.low) tail.low = c.low;
        tail.close = c.close;
        tail.volume += c.volume ?? 0;
      } else {
        const next = {
          openTime: bs,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume ?? 0,
        };
        if (!tail) this._series.push(next);
        else if (bs > tail.openTime) this._series.push(next);
        else this._series[this._series.indexOf(tail)] = next;
      }
    }
    this._data = {
      header: this._header,
      series: this._series,
      viewState: this.viewState(),
    };
    this.emit("live_update", this._data);
  }
}
