// hometrade — local HTTP terminal server (static UI + API + SSE bridge).

import { createServer } from "node:http";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildLiveStack, DATA_DIR } from "./live.js";
import { AlertsEngine } from "./alerts.js";
import { AnnotationBook, Watchlists } from "./books.js";
import { JsonRepo } from "./store.js";
import {
  parseSymDir,
  searchUniverse,
  createPoller,
  yahooChartUrl,
  normalizeYahooChart,
} from "./market.js";
import { runLab } from "./lab.js";

const PORT = Number(process.env.HOMETRADE_PORT ?? 4444);
const STATIC_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "static",
);
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

const main = buildLiveStack();
const { feed, session } = main;
// watchlist price snapshots must not hijack the main view (own session+feed)
const snapStack = buildLiveStack();
const snapSession = snapStack.session;
const alertsEngine = new AlertsEngine(
  new JsonRepo(join(DATA_DIR, "alerts.json")),
  {
    toast: (t) => sseSend({ type: "toast", toast: t }),
  },
);
const annotations = new AnnotationBook(
  new JsonRepo(join(DATA_DIR, "annotations.json")),
);
const watchlists = new Watchlists(
  new JsonRepo(join(DATA_DIR, "watchlists.json"), []),
);

// closed candles -> alerts evaluation (SPEC §5: fire once on cross)
session.on("closed_candle", ({ symbolKey, candle }) => {
  void alertsEngine.evaluate(symbolKey, candle);
});

// ---- SSE ----
const sseClients = new Set();
function sseSend(obj) {
  // EventSource named events REQUIRE the wire `event:` line; otherwise
  // frames land as generic `message` events and client selectors never fire.
  const chunk = `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(chunk);
    } catch {
      sseClients.delete(res);
    }
  }
}
session.on("render_data", (d) => {
  sseSend({
    type: "render",
    header: d.header,
    url: `?symbol=${encodeURIComponent(d.viewState.symbol)}&interval=${d.viewState.interval}`,
  });
  pollMainSymbol = d.viewState.symbol;
});
session.on("live_update", (d) => {
  const last = d.series.at(-1);
  const prev = d.series.at(-2);
  sseSend({
    type: "tick",
    openTime: last.openTime,
    close: last.close,
    prevClose: prev ? prev.close : null,
  });
});
session.on("symbol_changed", (d) => {
  pollMainSymbol = d.symbolKey; // fast-lane poll targets the visible view
  sseSend({ type: "symbol_changed", symbol: d.symbolKey });
});
session.on("interval_changed", (d) =>
  sseSend({ type: "interval_changed", interval: d.interval }),
);

// ---- market poller (whole-market near-real-time snapshots -> SSE) ----

const marketPoller = createPoller({ fetchLast: fetchLastSnapshot });

marketPoller.onTick((symbolKey, snap) => {
  sseSend({
    type: "market_tick",
    symbol: symbolKey,
    price: snap.price,
    prevClose: snap.prevClose,
    ts: snap.openTime,
  });
  // alerts fire on quoted price crosses too (POLL cadence, single source of truth)
  void alertsEngine
    .evaluate(symbolKey, {
      openTime: snap.openTime,
      open: snap.prevClose,
      high: Math.max(snap.price, snap.prevClose),
      low: Math.min(snap.price, snap.prevClose),
      close: snap.price,
      volume: 0,
    })
    .catch?.(() => {});
});

// ---- helpers ----
function jsonRes(res, code, value) {
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value));
}
async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

const SYMBOL_CATALOG = [
  "COINBASE:BTCUSDT",
  "COINBASE:ETHUSDT",
  "COINBASE:SOLUSDT",
  "COINBASE:XRPUSDT",
  "COINBASE:ADAUSDT",
  "COINBASE:DOGEUSDT",
  "COINBASE:AVAXUSDT",
  "COINBASE:LINKUSDT",
];

// ---- whole-market universe (Nasdaq Trader SymDir, official + keyless) ----

const OFFLINE_UNIVERSE = [
  ["AAPL", "Apple Inc."],
  ["MSFT", "Microsoft Corporation"],
  ["NVDA", "NVIDIA Corporation"],
  ["AMZN", "Amazon.com, Inc."],
  ["TSLA", "Tesla, Inc."],
  ["GOOGL", "Alphabet Inc."],
  ["META", "Meta Platforms, Inc."],
  ["BRK-B", "Berkshire Hathaway Inc."],
  ["JPM", "JPMorgan Chase & Co."],
  ["AMD", "Advanced Micro Devices, Inc."],
  ["NFLX", "Netflix, Inc."],
  ["XOM", "Exxon Mobil Corporation"],
].map(([symbol, name]) => ({ symbol, name, exchange: "NASDAQ", etf: false }));

const UNIVERSE_FILE = join(DATA_DIR, "universe.json");
let UNIVERSE = OFFLINE_UNIVERSE;

async function refreshUniverse() {
  // 24h TTL; SymDir files are official nightly snapshots (point-in-time)
  try {
    const cached = JSON.parse(await readFile(UNIVERSE_FILE, "utf8"));
    if (Date.now() - cached.ts < 24 * 3600e3 && cached.rows?.length) {
      UNIVERSE = cached.rows;
      return UNIVERSE.length;
    }
  } catch {
    /* first run */
  }
  try {
    const [nasdaq, other] = await Promise.all([
      fetch(
        "https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt",
      ).then((r) => r.text()),
      fetch("https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt").then(
        (r) => r.text(),
      ),
    ]);
    const rows = [
      ...parseSymDir(nasdaq, "NASDAQ"),
      ...parseSymDir(other, "OTHER"),
    ];
    if (rows.length > 1000) {
      UNIVERSE = rows;
      await writeFile(UNIVERSE_FILE, JSON.stringify({ ts: Date.now(), rows }));
    }
  } catch {
    /* offline: builtin fallback already set */
  }
  return UNIVERSE.length;
}

// ---- market poller (whole-market near-real-time snapshots -> SSE) ----

// last price + prev close, per source, with the poller's own session
async function fetchLastSnapshot(symbolKey) {
  const exchange = /^([A-Z0-9_]+):/.exec(symbolKey)?.[1] ?? "";
  if (exchange === "YAHOO") {
    const res = await fetch(yahooChartUrl(symbolKey, "1d"));
    if (!res.ok) throw new Error(`yahoo ${res.status}`);
    const doc = await res.json();
    const meta = doc?.chart?.result?.[0]?.meta ?? {};
    const bars = normalizeYahooChart(doc);
    const price = +meta.regularMarketPrice || bars.at(-1)?.close;
    if (!price) return null;
    return {
      price,
      prevClose: bars.length >= 2 ? bars.at(-2).close : price,
      openTime: Date.now(),
    };
  }
  // crypto snapshot: last two daily candles from the public REST source
  const d = await snapSession.load(symbolKey, "1d");
  const s = d.series;
  if (!s.length) return null;
  return {
    price: s.at(-1).close,
    prevClose: s.length >= 2 ? s.at(-2).close : s.at(-1).open,
    openTime: Date.now(),
  };
}

let pollMainSymbol = null;
let pollRoundRobin = 0;

function trackedSymbols() {
  const list = [];
  if (pollMainSymbol?.startsWith("YAHOO:")) list.push(pollMainSymbol);
  let watch = [];
  try {
    watch = watchlists.all()[0]?.symbols ?? [];
  } catch {
    watch = [];
  }
  for (const s of watch)
    if (s !== pollMainSymbol && !list.includes(s)) list.push(s);
  // whole-market pulse even before any view is opened
  for (const s of ["YAHOO:AAPL", "COINBASE:BTCUSDT", "YAHOO:NVDA"]) {
    if (!list.includes(s)) list.push(s);
  }
  return list;
}

function startMarketPolling() {
  const TICK_MS = 3000;
  setInterval(async () => {
    try {
      const wanted = trackedSymbols();
      for (const s of marketPoller.list()) {
        if (!wanted.includes(s)) marketPoller.unsubscribe(s);
      }
      for (const s of wanted) marketPoller.subscribe(s);
      // fast lane: the equities main symbol every tick; one symbol rotates
      pollRoundRobin += 1;
      const rotating = wanted[pollRoundRobin % wanted.length];
      const targets = [...new Set([pollMainSymbol, rotating])].filter(
        (s) => s && wanted.includes(s),
      );
      await marketPoller.pump(targets);
    } catch {
      /* a failed poll round is non-fatal; next tick retries */
    }
  }, TICK_MS);
}

// ---- request router ----
async function route(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  const p = url.pathname;
  try {
    if (p === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      res.write(": ready\n\n");
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }
    if (p === "/api/symbols") {
      const q = (url.searchParams.get("query") ?? "")
        .toUpperCase()
        .replace(/[^A-Z0-9:\-_.]/g, "");
      // whole-market search across the universe (YAHOO routing) + crypto catalog
      const universeHits = searchUniverse(
        q.replace(/^[A-Z0-9_]+:/, ""),
        UNIVERSE,
        10,
      );
      const base = SYMBOL_CATALOG.filter((s) => s.includes(q));
      const any = /^[A-Z0-9_]+:[A-Z0-9_.-]+$/.test(q) ? [q] : [];
      const unified = universeHits.map((h) => {
        if (!q.includes(":")) {
          return { symbol: h.key, name: h.name };
        }
        return { symbol: h.key, name: h.name };
      });
      return jsonRes(res, 200, {
        matches: [...base, ...unified.map((u) => u.symbol)],
        details: unified,
        universeSize: UNIVERSE.length,
      });
    }
    if (p === "/api/load") {
      const symbol = url.searchParams.get("symbol");
      const interval = url.searchParams.get("interval") ?? "1m";
      const data = await session.load(symbol, interval);
      return jsonRes(res, 200, {
        header: data.header,
        series: data.series.slice(-2000),
        viewState: data.viewState,
      });
    }
    if (p === "/api/bars") {
      const symbol = url.searchParams.get("symbol");
      const interval = url.searchParams.get("interval") ?? "1m";
      const limit = Math.max(
        1,
        Math.min(Number(url.searchParams.get("limit") ?? 200), 2000),
      );
      const data = await snapSession.load(symbol, interval);
      return jsonRes(res, 200, {
        header: data.header,
        series: data.series.slice(-limit),
      });
    }
    if (p === "/api/alerts") {
      if (req.method === "GET") {
        await alertsEngine._sync();
        return jsonRes(res, 200, alertsEngine.list(undefined));
      }
      if (req.method === "POST") {
        const b = await body(req);
        if (b.action === "rearm") {
          await alertsEngine.rearm(b.id);
          return jsonRes(res, 200, { ok: true });
        }
        const rule = await alertsEngine.add({
          symbol: b.symbol,
          interval: b.interval ?? "1m",
          kind: b.kind,
          price: b.price,
        });
        return jsonRes(res, 200, rule);
      }
      if (req.method === "DELETE") {
        await alertsEngine.delete(url.searchParams.get("id"));
        return jsonRes(res, 200, { ok: true });
      }
    }
    if (p === "/api/annotations") {
      if (req.method === "GET") {
        return jsonRes(
          res,
          200,
          await annotations.query({
            symbol: url.searchParams.get("symbol") ?? undefined,
            interval: url.searchParams.get("interval") ?? undefined,
          }),
        );
      }
      if (req.method === "POST")
        return jsonRes(res, 200, await annotations.add(await body(req)));
    }
    if (p === "/api/watchlists") {
      if (req.method === "GET") {
        await watchlists._sync();
        return jsonRes(res, 200, watchlists.all());
      }
      if (req.method === "POST") {
        const b = await body(req);
        return jsonRes(res, 200, await watchlists.upsert(b.name, b.symbols));
      }
    }
    if (p === "/api/state") {
      return jsonRes(res, 200, {
        dataDir: DATA_DIR,
        viewState: session.viewState(),
        universeSize: UNIVERSE.length,
        sources: {
          crypto: "COINBASE (websocket, keyless)",
          equities: "YAHOO (polling, keyless)",
        },
      });
    }
    if (p === "/api/lab" && req.method === "POST") {
      const b = await body(req);
      const d = await snapSession.load(
        b.symbol ?? "COINBASE:BTCUSDT",
        b.interval ?? "15m",
      );
      const report = runLab({
        series: d.series,
        strategy: b.strategy ?? "sma_cross",
        params: b.params ?? {},
        costBps: Number(b.cost_bps ?? 2.5),
        slipBps: Number(b.slip_bps ?? 1.5),
        unitSize: 1,
      });
      return jsonRes(res, 200, report);
    }
    if (p === "/" || p === "/index.html") {
      const f = await readFile(join(STATIC_DIR, "index.html"));
      res.writeHead(200, { "content-type": MIME[".html"] });
      return res.end(f);
    }
    const staticFile = join(STATIC_DIR, p.slice(1));
    try {
      const st = await stat(staticFile);
      if (st.isFile()) {
        const f = await readFile(staticFile);
        res.writeHead(200, {
          "content-type":
            MIME[extname(staticFile)] ?? "application/octet-stream",
        });
        return res.end(f);
      }
    } catch {
      /* not found */
    }
    return jsonRes(res, 404, { error: `not found ${p}` });
  } catch (e) {
    return jsonRes(res, 400, { error: e.message });
  }
}

if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  // bind is loopback by default (local-first, safe); Docker image sets 0.0.0.0
  const HOST = process.env.HOMETRADE_HOST ?? "127.0.0.1";
  createServer((req, res) => route(req, res)).listen(PORT, HOST, () => {
    console.log(
      `hometrade running: http://${HOST === "0.0.0.0" ? "127.0.0.1" : HOST}:${PORT} (data: ${DATA_DIR})`,
    );
  });
  refreshUniverse()
    .then((n) => console.log(`universe: ${n} symbols (whole-market search)`))
    .catch(() => {});
  startMarketPolling(); // 3s cadence: equities fast lane + rotating watch row
  process.on("SIGINT", () => {
    feed.close();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    feed.close();
    process.exit(0);
  });
}
