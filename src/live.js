// hometrade — live stack: real public exchange feed + local-first store wiring.
// Public, keyless endpoints only; original wire parsing; local caching to data/.
// Source is selectable: HOMETRADE_SOURCE=COINBASE|BINANCE (default COINBASE,
// because our reference network is outside Binance's service region).

import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { BarStore } from "./store.js";
import { BinanceFeed } from "./feed.js";
import { CandleSession } from "./session.js";
import { isInterval, bucketStart } from "./time.js";
import {
  EXCHANGES,
  exchangeSupportsInterval,
  resolveSymbol,
} from "./exchanges.js";
import { buildKlinesUrl, normalizeSourceRows } from "./feed.js";

export const DATA_DIR =
  process.env.HOMETRADE_DATA ??
  join(dirname(fileURLToPath(import.meta.url)), "..", "data");

// ---- source-specific stream naming ----

// Binance combined stream: <native>@kline_<interval>
export function streamName(symbolKey, interval) {
  const m = /^([A-Z0-9_]+):([A-Z0-9_.-]+)$/.exec(symbolKey);
  const native = (m ? m[2] : symbolKey).toLowerCase();
  const iv = String(interval ?? "1m");
  return `${native}@kline_${isInterval(iv) ? iv : "1m"}`;
}

// ---- REST fetcher (works for every source with a URL-shaped catalog) ----

// Reject view intervals the source cannot serve, build the public URL, fetch,
// and normalize source-shaped rows into our canonical candles (ascending).
export async function fetchBars(symbolKey, interval, limit = 1000) {
  const info = resolveSymbol(symbolKey);
  if (!exchangeSupportsInterval(info.exchange, interval)) {
    throw new Error(
      `interval ${interval} not supported by ${info.exchange} — try one of ` +
        supportedHints(info.exchange),
    );
  }
  const url = buildKlinesUrl(symbolKey, interval, limit);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`bars fetch ${res.status} ${res.statusText}`);
  const rows = await res.json();
  return { cached: false, candles: normalizeSourceRows(url, rows) };
}

function supportedHints(exchange) {
  const ivs = Object.keys(
    EXCHANGES[exchange].intervals ?? EXCHANGES[exchange].granularity ?? {},
  ).filter((iv) => iv !== "1M" || exchange !== "COINBASE");
  return ivs.join(", ");
}

// ---- Coinbase transport (public ticker channel; trades -> interval candles) ----

export function coinbaseTransport(makeWs = null) {
  const WS =
    makeWs ??
    (() =>
      globalThis.WebSocket
        ? new globalThis.WebSocket("wss://ws-feed.exchange.coinbase.com")
        : null);
  let ws = null;
  let opened = false;
  const queue = [];
  const listeners = new Set(); // cb(symbolKey, candle)
  const acc = new Map(); // symbolKey -> { interval, bucketMs, candle }

  const emit = (symbolKey, candle) => {
    for (const cb of listeners) cb(symbolKey, candle);
  };

  const ingest = (symbolKey, entry, tradeMs, price, size) => {
    const bucketMs = bucketStart(tradeMs, entry.interval);
    if (!entry.candle || entry.bucketMs !== bucketMs) {
      if (entry.candle) emit(symbolKey, { ...entry.candle, closed: true });
      entry.bucketMs = bucketMs;
      entry.candle = {
        openTime: bucketMs,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: 0,
        closed: false,
      };
    }
    const c = entry.candle;
    if (price > c.high) c.high = price;
    if (price < c.low) c.low = price;
    c.close = price;
    c.volume += size;
    emit(symbolKey, c);
  };

  return {
    async connect() {
      if (!ws) {
        ws = WS();
        if (!ws) return false;
        // gate: "open" is the ONLY truth for a live socket (a connecting socket
        // throws "Sent before connected." on send)
        const gate = new Promise((resolve, reject) => {
          ws.addEventListener("open", () => {
            opened = true;
            resolve();
            while (queue.length) queue.shift()();
          });
          ws.addEventListener("close", () => {
            opened = false;
            ws = null;
            reject(new Error("coinbase socket closed before open"));
          });
          ws.addEventListener("error", () => {
            opened = false;
            reject(new Error("coinbase socket error before open"));
          });
        });
        ws.addEventListener("message", (ev) => {
          try {
            const msg = JSON.parse(String(ev.data));
            if (msg?.type === "match") {
              const symbolKey = keyForProduct(msg.product_id);
              const entry = acc.get(symbolKey);
              if (entry)
                ingest(
                  symbolKey,
                  entry,
                  Date.parse(msg.time),
                  +msg.price,
                  +msg.size,
                );
            }
          } catch {
            /* ignore malformed frames */
          }
        });
        try {
          await ws.openNow?.(); // test doubles open immediately -> fires "open"
          if (!opened) await gate; // real WebSocket: wait for the open event
        } catch {
          ws = null; // degrade: REST + local cache still work; live ticks off
          return false;
        }
      }
      return true;
    },
    async send(msg) {
      if (!msg || msg.type !== "subscribe") return;
      const info = resolveSymbol(msg.symbolKey);
      const product = EXCHANGES[info.exchange].native(info.ticker);
      if (msg.wasResubscribe) acc.delete(msg.symbolKey); // switch: restart accumulator
      if (!acc.has(msg.symbolKey))
        acc.set(msg.symbolKey, {
          interval: msg.interval,
          bucketMs: null,
          candle: null,
        });
      registerKey(msg.symbolKey);
      const flush = () =>
        ws.send(
          JSON.stringify({
            type: "subscribe",
            product_ids: [product],
            channels: ["ticker"],
          }),
        );
      if (opened) flush();
      else queue.push(flush);
    },
    on(a, b) {
      // both call styles: on(cb) and on("candle", cb)
      let wrapped;
      if (typeof b === "undefined") wrapped = a;
      else if (a === "candle") wrapped = (sk, c) => b(sk, c);
      else return;
      listeners.add(wrapped);
      return () => listeners.delete(wrapped);
    },
    close() {
      try {
        ws?.close();
      } catch {
        /* noop */
      }
      ws = null;
      opened = false;
    },
  };
}

const productIndex = new Map(); // symbolKey -> product
function registerKey(symbolKey) {
  if (productIndex.has(symbolKey)) return;
  const info = resolveSymbol(symbolKey);
  productIndex.set(symbolKey, EXCHANGES[info.exchange].native(info.ticker));
}
function keyForProduct(product) {
  for (const [key, p] of productIndex) if (p === product) return key;
  return product;
}

// ---- Binance transport (combined stream adapter) ----

// Translates our protocol messages into the public stream's verbs
// (SUBSCRIBE/unSUBSCRIBE on `<symbol>@kline_<interval>`), normalizes kline
// payloads into our candle events, and degrades gracefully without WebSocket.
export function binanceTransport() {
  const WS = globalThis.WebSocket;
  if (!WS) return null; // REST still works; live ticks disabled
  let ws = null;
  let opened = false;
  const queue = [];
  const streamToKey = new Map(); // "<native>@<iv>" -> symbolKey
  const listeners = new Set();
  let msgId = 0;

  const attach = () => {
    if (ws) return;
    ws = new WS("wss://stream.binance.com:9443/stream");
    ws.addEventListener("open", () => {
      opened = true;
      while (queue.length) queue.shift()();
    });
    ws.addEventListener("message", (ev) => {
      try {
        const parsed = JSON.parse(String(ev.data));
        const d = parsed?.data ?? parsed;
        const kv = d && (d.e === "kline" ? d : d.k ? d : null);
        const k = kv && kv.k ? kv.k : null;
        if (!k) return;
        const stream = String(parsed?.stream ?? ""); // "<native>@<iv>"
        const symbolKey = streamToKey.get(stream) ?? stream;
        const iv = /@kline_(.+)$/.exec(stream)?.[1] ?? "";
        const candle = {
          openTime: +k.t,
          open: +k.o,
          high: +k.h,
          low: +k.l,
          close: +k.c,
          volume: +k.v,
          closed: !!k.x,
          interval: iv,
        };
        for (const l of listeners) l(symbolKey, candle);
      } catch {
        /* ignore malformed frames */
      }
    });
    ws.addEventListener("close", () => {
      opened = false;
      ws = null;
    });
    ws.addEventListener("error", () => {
      opened = false;
    });
  };

  return {
    async connect() {
      attach();
      return true;
    },
    async send(msg) {
      if (!msg || msg.type !== "subscribe") return;
      const stream = streamName(msg.symbolKey, msg.interval);
      streamToKey.set(stream, msg.symbolKey);
      const verb = msg.wasResubscribe ? "unSUBSCRIBE" : "SUBSCRIBE";
      const flush = () => {
        try {
          ws.send(
            JSON.stringify({ method: verb, params: [stream], id: ++msgId }),
          );
        } catch {
          /* socket gone; next connect re-flushes */
        }
      };
      if (opened) flush();
      else queue.push(flush);
    },
    on(a, b) {
      // both call styles: on(cb) and on("candle", cb)
      let wrapped;
      if (typeof b === "undefined") wrapped = a;
      else if (a === "candle") wrapped = (sk, c) => b(sk, c);
      else return;
      listeners.add(wrapped);
      return () => listeners.delete(wrapped);
    },
    close() {
      try {
        ws?.close();
      } catch {
        /* noop */
      }
      ws = null;
      opened = false;
    },
  };
}

// ---- composition root ----

export function buildLiveStack(env = process.env) {
  const source = String(env.HOMETRADE_SOURCE ?? "coinbase").toUpperCase();
  if (source !== "COINBASE" && source !== "BINANCE") {
    throw new Error(
      `unknown HOMETRADE_SOURCE ${source} (supported: COINBASE, BINANCE)`,
    );
  }
  const store = new BarStore(DATA_DIR);
  const transport =
    source === "COINBASE" ? coinbaseTransport : binanceTransport;
  const feed = new BinanceFeed({ transport, fetcher: fetchBars });
  const session = new CandleSession({ store, feed, fetcher: fetchBars });
  return { store, feed, session, source };
}
