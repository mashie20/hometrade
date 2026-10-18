// Test doubles — shared fakes for session/feed tests. Written BEFORE implementation (TDD).
import { EventEmitter } from "node:events";
import { BarStore } from "../../src/store.js";

export class FakeTransport extends EventEmitter {
  constructor() {
    super();
    this.connects = 0;
    this.sent = [];
    this.closed = false;
  }
  async connect() {
    this.connects += 1;
    return this;
  }
  async send(msg) {
    this.sent.push(msg);
  }
  dispatchCandle(symbolKey, candle) {
    this.emit("candle", symbolKey, candle);
  }
  close() {
    this.closed = true;
  }
}

export function FakeFeed(bySymbol = {}) {
  let connects = 0;
  const subscribed = [],
    resubscribed = [];
  const transport = new FakeTransport();
  let binding = null;
  const feed = {
    stats: {
      get connects() {
        return connects;
      },
      get subscribed() {
        return subscribed;
      },
      get resubscribed() {
        return resubscribed;
      },
      transport,
    },
    async connect() {
      connects = 1;
      return feed;
    }, // idempotent persistent connection
    async subscribe(symbolKey, interval) {
      const next = `${symbolKey}@${interval}`;
      if (binding === null) subscribed.push([symbolKey, interval]);
      else if (binding !== next) resubscribed.push([symbolKey, interval]);
      binding = next;
      await transport.send({ type: "subscribe", symbolKey, interval });
      return feed;
    },
    async loadBars(symbolKey, interval, limit) {
      const src = bySymbol[symbolKey] || [];
      return { candles: src.slice(-limit), cached: false };
    },
    onCandle(symbolKey, cb) {
      transport.on("candle", (sk, c) => {
        if (sk === symbolKey) cb(c);
      });
    },
    emitCandle(symbolKey, c) {
      transport.dispatchCandle(symbolKey, c);
    },
    async close() {
      transport.close();
    },
  };
  const store = new BarStore(":memory:");
  const fake = { feed, store, fetcher: undefined, stats: feed.stats };
  fake.fetcher = async (symbolKey, interval, limit) =>
    feed.loadBars(symbolKey, interval, limit);
  fake.asSession = () => fake; // session takes {store, feed, fetcher}
  return fake;
}

// Minimal in-memory WebSocket double for transport adapters.
export class FakeWS {
  constructor() { this.sent = []; this.handlers = new Map(); this.opened = false; }
  addEventListener(ev, cb) { (this.handlers.get(ev) ?? this.handlers.set(ev, []).get(ev)).push(cb); }
  trigger(ev, arg) { for (const cb of this.handlers.get(ev) ?? []) cb(arg ?? {}); }
  send(s) { this.sent.push(s); }
  dispatch(obj) { for (const cb of this.handlers.get("message") ?? []) cb({ data: JSON.stringify(obj) }); }
  async openNow() { this.opened = true; this.trigger("open"); }
  close() { this.opened = false; this.trigger("close"); }
}
