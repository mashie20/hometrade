// Alpaca broker adapter contract: order payload shaping, paper/live base URLs,
// fill mapping. Tests BEFORE implementation; network faked.
import { test } from "node:test";
import assert from "node:assert/strict";

test("order payload: valid market order shapes into Alpaca wire format", async () => {
  const { buildAlpacaOrderPayload } = await import("../src/broker.js");
  const p = buildAlpacaOrderPayload({
    symbol: "AAPL",
    side: "buy",
    qty: 5,
    type: "market",
    clientOrderId: "ht-11112222-3333-4444-5555-666677778888",
  });
  assert.deepEqual(p, {
    symbol: "AAPL",
    qty: "5",
    side: "buy",
    type: "market",
    time_in_force: "day",
    client_order_id: "ht-11112222-3333-4444-5555-666677778888",
  });
  const lim = buildAlpacaOrderPayload({
    symbol: "MSFT",
    side: "sell",
    qty: 2.5,
    type: "limit",
    limitPrice: 521.3,
    clientOrderId: "ht-lim-1",
  });
  assert.equal(lim.type, "limit");
  assert.equal(lim.limit_price, "521.30", "limit price formatted to 2dp");
  assert.equal(lim.qty, "2.5");
});

test("order payload: rejects bad side, non-positive qty, limit without price", async () => {
  const { buildAlpacaOrderPayload } = await import("../src/broker.js");
  assert.throws(
    () =>
      buildAlpacaOrderPayload({
        symbol: "AAPL",
        side: "straddle",
        qty: 1,
        type: "market",
      }),
    /side/,
  );
  assert.throws(
    () =>
      buildAlpacaOrderPayload({
        symbol: "AAPL",
        side: "buy",
        qty: 0,
        type: "market",
      }),
    /qty/,
  );
  assert.throws(
    () =>
      buildAlpacaOrderPayload({
        symbol: "AAPL",
        side: "buy",
        qty: 1,
        type: "limit",
      }),
    /limit/,
  );
  assert.throws(
    () =>
      buildAlpacaOrderPayload({
        symbol: "AAPL",
        side: "buy",
        qty: 1,
        type: "market",
      }),
    /client_order_id|clientOrderId/,
  );
});

test("config: paper base by default, live only with explicit mode", async () => {
  const { brokerBaseUrl } = await import("../src/broker.js");
  assert.equal(brokerBaseUrl("paper"), "https://paper-api.alpaca.markets");
  assert.equal(brokerBaseUrl("live"), "https://api.alpaca.markets");
  assert.throws(() => brokerBaseUrl("yolo"), /paper|live/);
});

test("keys: env wins; keys file read as fallback; missing -> not_configured", async () => {
  const { resolveAlpacaKeys } = await import("../src/broker.js");
  const env = {
    HOMETRADE_ALPACA_KEY: "key-env",
    HOMETRADE_ALPACA_SECRET: "sec-env",
    HOMETRADE_BROKER_MODE: "paper",
  };
  const fromEnv = resolveAlpacaKeys({
    env,
    readFile: async () => {
      throw new Error("no file");
    },
  });
  assert.deepEqual(await fromEnv, {
    key: "key-env",
    secret: "sec-env",
    mode: "paper",
  });
  const fromFile = resolveAlpacaKeys({
    env: {},
    readFile: async () =>
      JSON.stringify({ alpaca: { key: "k", secret: "s", mode: "paper" } }),
  });
  assert.deepEqual(await fromFile, { key: "k", secret: "s", mode: "paper" });
  const missing = resolveAlpacaKeys({
    env: {},
    readFile: async () => {
      throw new Error("no file");
    },
  });
  assert.equal(await missing, null);
});

test("broker client: placeOrder posts wire payload with keys, maps accepted order", async () => {
  const calls = [];
  const { createAlpacaBroker } = await import("../src/broker.js");
  const fake = async (url, opts = {}) => {
    calls.push({
      url: String(url),
      method: opts.method,
      body: opts.body?.length ? JSON.parse(opts.body) : null,
      headers: opts.headers,
    });
    if (String(url).endsWith("/v2/orders") && opts.method === "POST") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: "alp-1",
          client_order_id: "ht-2",
          symbol: "AAPL",
          qty: "5",
          side: "buy",
          type: "market",
          status: "new",
          filled_qty: "0",
          filled_avg_price: null,
          created_at: "2026-10-18T14:00:00Z",
        }),
      };
    }
    return {
      ok: false,
      status: 404,
      json: async () => ({ message: "not found" }),
    };
  };
  const b = createAlpacaBroker({
    keys: { key: "kid", secret: "sec", mode: "paper" },
    fetcher: fake,
  });
  const o = await b.placeOrder({
    id: "ht-2",
    symbol: "AAPL",
    side: "buy",
    qty: 5,
    type: "market",
  });
  assert.equal(o.status, "new");
  assert.equal(o.externalId, "alp-1");
  assert.equal(calls[0].headers["APCA-API-KEY-ID"], "kid");
  assert.equal(calls[0].headers["APCA-API-SECRET-KEY"], "sec");
  assert.match(calls[0].url, /paper-api\.alpaca\.markets\/v2\/orders$/);
});

test("broker client: rejection surfaces broker message verbatim for the ticket UI", async () => {
  const { createAlpacaBroker } = await import("../src/broker.js");
  const b = createAlpacaBroker({
    keys: { key: "kid", secret: "sec", mode: "paper" },
    fetcher: async () => ({
      ok: false,
      status: 403,
      text: async () =>
        JSON.stringify({ code: 40310000, message: "not enough buying power" }),
      json: async () => ({
        code: 40310000,
        message: "not enough buying power",
      }),
    }),
  });
  await assert.rejects(
    () =>
      b.placeOrder({
        id: "ht-3",
        symbol: "AAPL",
        side: "buy",
        qty: 9999,
        type: "market",
      }),
    /not enough buying power/,
  );
});

test("account + positions + open orders mapping", async () => {
  const { createAlpacaBroker } = await import("../src/broker.js");
  let call = 0;
  const b = createAlpacaBroker({
    keys: { key: "kid", secret: "sec", mode: "paper" },
    fetcher: async (url) => {
      call += 1;
      if (String(url).endsWith("/v2/account")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: "ACTIVE",
            cash: "100000",
            equity: "101250",
            buying_power: "200000",
            portfolio_value: "101250",
          }),
        };
      }
      if (String(url).includes("/v2/positions")) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              symbol: "AAPL",
              qty: "5",
              avg_entry_price: "343.46",
              market_value: "1720",
              unrealized_pl: "7.9",
              unrealized_plpc: "0.0046",
            },
          ],
        };
      }
      if (String(url).includes("/v2/orders")) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              id: "alp-9",
              client_order_id: "ht-9",
              symbol: "AAPL",
              qty: "5",
              side: "buy",
              type: "market",
              status: "filled",
              filled_qty: "5",
              filled_avg_price: "343.62",
              created_at: "2026-10-18T14:05:00Z",
            },
          ],
        };
      }
      throw new Error("unexpected " + url);
    },
  });
  const acc = await b.getAccount();
  assert.equal(acc.status, "ACTIVE");
  assert.equal(acc.equity, "101250");
  const pos = await b.listPositions();
  assert.equal(pos[0].symbol, "AAPL");
  assert.equal(pos[0].qty, "5");
  const ord = await b.listOrders();
  assert.equal(ord[0].status, "filled");
  assert.equal(ord[0].clientId, "ht-9");
});
