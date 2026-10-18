// V-MCP — local MCP stdio JSON-RPC surface. Tests written BEFORE implementation (TDD).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { FakeFeed } from "./helpers/fakes.js";
import { createMcpServer } from "../src/mcp_server.js";

const here = dirname(fileURLToPath(import.meta.url));

function rpc(server, msg) {
  return server.handle(msg);
}

test("initialize -> capabilities + tools/list exposes SPEC tools", async () => {
  const srv = createMcpServer({
    sessionFactory: () => FakeFeed({ "BINANCE:BTCUSDT": [] }).asSession(),
  });
  const init = await rpc(srv, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {},
  });
  assert.equal(init.jsonrpc, "2.0");
  assert.equal(init.result.serverInfo.name, "hometrade");
  const tools = await rpc(srv, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  });
  const names = tools.result.tools.map((t) => t.name);
  for (const required of [
    "load_symbol",
    "get_bars",
    "add_alert",
    "list_alerts",
    "delete_alert",
    "annotate",
    "query_annotations",
  ]) {
    assert.ok(names.includes(required), `missing tool ${required}`);
  }
});

test("tools/call load_symbol returns header + last close; add/list alerts persist", async () => {
  const fake = FakeFeed({
    "BINANCE:BTCUSDT": Array.from({ length: 5 }, (_, i) => ({
      openTime: i * 15000,
      open: 100,
      high: 110,
      low: 90,
      close: 100 + i,
      volume: 3,
    })),
  });
  let alerts = [];
  const srv = createMcpServer({
    sessionFactory: () => fake.asSession(),
    alertsRepo: {
      read: async () => alerts,
      write: async (a) => {
        alerts = a;
      },
    },
  });
  const loaded = await rpc(srv, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "load_symbol",
      arguments: { symbol: "BINANCE:BTCUSDT", interval: "15m" },
    },
  });
  assert.match(loaded.result.content[0].text, /BTCUSDT/);
  assert.match(
    loaded.result.content[0].text,
    /104/,
    "last close visible to agents",
  );

  const added = await rpc(srv, {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "add_alert",
      arguments: {
        symbol: "BINANCE:BTCUSDT",
        interval: "15m",
        kind: "above",
        price: 120,
      },
    },
  });
  assert.match(added.result.content[0].text, /added/i);
  const listed = await rpc(srv, {
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "list_alerts", arguments: {} },
  });
  assert.match(listed.result.content[0].text, /above 120/);
});

test("session factory may return a promise (live stack is lazily imported)", async () => {
  const fake = FakeFeed({
    "COINBASE:BTCUSDT": Array.from({ length: 5 }, (_, i) => ({
      openTime: i * 15000,
      open: 100,
      high: 110,
      low: 90,
      close: 100 + i,
      volume: 3,
    })),
  });
  const srv = createMcpServer({
    sessionFactory: () => Promise.resolve(fake.asSession()),
  });
  const loaded = await rpc(srv, {
    jsonrpc: "2.0",
    id: 10,
    method: "tools/call",
    params: {
      name: "load_symbol",
      arguments: { symbol: "COINBASE:BTCUSDT", interval: "1m" },
    },
  });
  assert.match(loaded.result.content[0].text, /BTCUSDT/);
  assert.match(loaded.result.content[0].text, /104/, "last close visible");
});

test("default stack shape: {store, feed, session} from the live composition root", async () => {
  const fake = FakeFeed({
    "COINBASE:BTCUSDT": Array.from({ length: 5 }, (_, i) => ({
      openTime: i * 15000,
      open: 100,
      high: 110,
      low: 90,
      close: 100 + i,
      volume: 3,
    })),
  });
  const { CandleSession } = await import("../src/session.js");
  const { BarStore } = await import("../src/store.js");
  const sess = new CandleSession({
    store: new BarStore(":memory:"),
    feed: fake.feed,
    fetcher: fake.fetcher,
  });
  const srv = createMcpServer({
    sessionFactory: () =>
      Promise.resolve({ store: null, feed: fake.feed, session: sess }),
  });
  const loaded = await rpc(srv, {
    jsonrpc: "2.0",
    id: 11,
    method: "tools/call",
    params: {
      name: "load_symbol",
      arguments: { symbol: "COINBASE:BTCUSDT", interval: "1m" },
    },
  });
  assert.match(loaded.result.content[0].text, /BTCUSDT/);
  assert.match(loaded.result.content[0].text, /104/, "last close visible");
});

test("stdio frame protocol: newline-delimited JSON-RPC round trip via real child process", async () => {
  const child = spawn(
    process.execPath,
    [join(here, "..", "src", "mcp_server.js"), "--smoke"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
  const collect = [];
  child.stdout.on("data", (d) => {
    for (const line of d.toString().split("\n")) {
      if (!line.trim()) continue;
      try {
        collect.push(JSON.parse(line));
      } catch {
        /* partial */
      }
    }
  });
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  await new Promise((res) => {
    const t = setInterval(() => {
      if (collect.some((m) => m.id === 2)) {
        clearInterval(t);
        res();
      }
    }, 100);
    setTimeout(() => {
      clearInterval(t);
      res();
    }, 4000);
  });
  child.kill();
  assert.ok(
    collect.some(
      (m) => m.id === 1 && m.result.serverInfo.name === "hometrade",
    ),
  );
  assert.ok(collect.some((m) => m.id === 2 && m.result.tools.length >= 7));
});
