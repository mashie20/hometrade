// hometrade — local HTTP terminal server (static UI + API + SSE bridge).

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildLiveStack, DATA_DIR } from "./live.js";
import { AlertsEngine } from "./alerts.js";
import { AnnotationBook, Watchlists } from "./books.js";
import { JsonRepo } from "./store.js";

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
  const chunk = `data: ${JSON.stringify(obj)}\n\n`;
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
session.on("symbol_changed", (d) =>
  sseSend({ type: "symbol_changed", symbol: d.symbolKey }),
);
session.on("interval_changed", (d) =>
  sseSend({ type: "interval_changed", interval: d.interval }),
);

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
        .replace(/[^A-Z0-9:_-]/g, "");
      const base = SYMBOL_CATALOG.filter((s) => s.includes(q));
      const any =
        /^[A-Z0-9_]+:[A-Z0-9_.-]+$/.test(q) && !base.includes(q) ? [q] : [];
      return jsonRes(res, 200, { matches: [...base, ...any].slice(0, 20) });
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
      });
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
  process.on("SIGINT", () => {
    feed.close();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    feed.close();
    process.exit(0);
  });
}
