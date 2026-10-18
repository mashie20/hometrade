// hometrade — local MCP server (stdio JSON-RPC 2.0): agents operate the terminal.
// Tools (SPEC §8): load_symbol, get_bars, add_alert, list_alerts, delete_alert,
// rearm_alert, annotate, query_annotations, save_watchlist, get_watchlists.

import { createInterface } from "node:readline";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile as fsReadFile } from "node:fs/promises";
import { AlertsEngine } from "./alerts.js";
import { AnnotationBook, Watchlists } from "./books.js";
import { JsonRepo } from "./store.js";
import { CandleSession } from "./session.js";
import { resolveAlpacaKeys, createAlpacaBroker } from "./broker.js";

const PROTOCOL_VERSION = "2025-06-18";

const TOOLS = [
  {
    name: "load_symbol",
    description:
      "Bind the local chart session to EXCHANGE:TICKER at an interval (1m..1w, 1M). Returns header, bar count and last close.",
    inputSchema: {
      type: "object",
      properties: { symbol: { type: "string" }, interval: { type: "string" } },
      required: ["symbol", "interval"],
    },
  },
  {
    name: "get_bars",
    description:
      "Get the latest closed candles (OHLCV) for a symbol/interval from the local-first cache.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        interval: { type: "string" },
        limit: { type: "number" },
      },
      required: ["symbol", "interval"],
    },
  },
  {
    name: "add_alert",
    description:
      "Arm a price-cross alert for a symbol/interval (kind: above|below).",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        interval: { type: "string" },
        kind: { type: "string" },
        price: { type: "number" },
      },
      required: ["symbol", "interval", "kind", "price"],
    },
  },
  {
    name: "list_alerts",
    description: "List armed/triggered alert rules.",
    inputSchema: { type: "object", properties: { symbol: { type: "string" } } },
  },
  {
    name: "delete_alert",
    description: "Delete an alert rule by id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "rearm_alert",
    description: "Re-arm a triggered alert rule by id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "annotate",
    description:
      "Attach a timestamped text annotation to a symbol/interval view.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        interval: { type: "string" },
        text: { type: "string" },
        ts: { type: "number" },
      },
      required: ["symbol", "interval", "text"],
    },
  },
  {
    name: "query_annotations",
    description: "Query annotations, optionally filtered by symbol/interval.",
    inputSchema: {
      type: "object",
      properties: { symbol: { type: "string" }, interval: { type: "string" } },
    },
  },
  {
    name: "save_watchlist",
    description:
      "Create/replace a named watchlist (comma-separated EXCHANGE:TICKERs).",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, symbols: { type: "string" } },
      required: ["name", "symbols"],
    },
  },
  {
    name: "get_watchlists",
    description: "List saved watchlists.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "broker_status",
    description:
      "Report whether real-order Alpaca keys are configured (paper default). READ-ONLY: never returns secrets; order placement stays behind the typed-confirmation gate in the web UI.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "broker_account",
    description:
      "READ-ONLY broker snapshot: account status/cash/equity, open positions, open-order count via Alpaca (paper first). No order placement from MCP by design.",
    inputSchema: { type: "object", properties: {} },
  },
];

export function createMcpServer({
  sessionFactory,
  alertsRepo,
  annotationsRepo,
  watchlistsRepo,
  env = process.env,
  keysFile,
  log,
} = {}) {
  const sudoLog = log ?? (() => {});
  const here = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
  const alertsEngine = new AlertsEngine(
    alertsRepo ?? new JsonRepo(join(here, "alerts.json")),
    { toast: (t) => sudoLog(JSON.stringify({ alert_fired: t })) },
  );
  const annotations = new AnnotationBook(
    annotationsRepo ?? new JsonRepo(join(here, "annotations.json")),
  );
  const watchlists = new Watchlists(
    watchlistsRepo ?? new JsonRepo(join(here, "watchlists.json"), []),
  );
  let session = null;

  const getSession = async () => {
    if (session) return session;
    // factories may return: a session, the live stack {store, feed, session}
    // or the legacy triple {store, feed, fetcher} — all lazily, via promise
    const raw = await (sessionFactory?.() ?? defaultSessionFactory());
    const candidate =
      typeof raw.session?.load === "function" ? raw.session : raw;
    session =
      typeof candidate.load === "function"
        ? candidate
        : new CandleSession({
            store: raw.store,
            feed: raw.feed,
            fetcher: raw.fetcher,
          });
    return session;
  };

  async function call(name, args = {}) {
    switch (name) {
      case "load_symbol": {
        const s = await getSession();
        const r = await s.load(args.symbol, args.interval);
        const last = r.series.at(-1);
        return txt(
          `${r.header.exchange}:${r.header.symbol} @ ${r.header.interval} — ${r.series.length} candles; last close ${last ? last.close : "n/a"}; view ?symbol=${r.viewState.symbol}&interval=${r.viewState.interval}`,
        );
      }
      case "get_bars": {
        const s = await getSession();
        const r = await s.load(args.symbol, args.interval);
        const lim = Math.max(
          1,
          Math.min(Number(args.limit ?? 100), r.series.length),
        );
        return txt(
          JSON.stringify({
            header: r.header,
            candles: r.series.slice(-lim),
          }),
        );
      }
      case "add_alert": {
        const rule = await alertsEngine.add(args);
        await alertsEngine._sync(); // keep cross-call state fresh
        return txt(
          `alert added id=${rule.id} ${rule.symbol} ${rule.kind} ${rule.price}`,
        );
      }
      case "list_alerts": {
        await alertsEngine._sync();
        const list = alertsEngine.list(args.symbol);
        return txt(
          list.length
            ? list
                .map(
                  (r) =>
                    `${r.armed ? "armed" : `fired x${r.firedCount ?? 0}`} ${r.interval ? r.symbol + "@" + r.interval + " " : ""}${r.kind} ${r.price} id=${r.id}`,
                )
                .join("\n")
            : "no alerts",
        );
      }
      case "delete_alert":
        await alertsEngine.delete(args.id);
        return txt(`alert deleted id=${args.id}`);
      case "rearm_alert":
        await alertsEngine.rearm(args.id);
        return txt(`alert re-armed id=${args.id}`);
      case "annotate": {
        const item = await annotations.add(args);
        return txt(
          `annotation ${item.id} stored for ${item.symbol}@${item.interval}`,
        );
      }
      case "query_annotations": {
        const list = await annotations.query(args);
        return txt(JSON.stringify(list));
      }
      case "save_watchlist": {
        const w = await watchlists.upsert(args.name, args.symbols);
        return txt(`watchlist ${w.name} saved (n=${w.symbols.length})`);
      }
      case "get_watchlists":
        await watchlists._sync();
        return txt(JSON.stringify(watchlists.all()));
      case "broker_status": {
        const keys = await resolveAlpacaKeys({
          env,
          readFile: keysFile ? () => fsReadFile(keysFile, "utf8") : null,
        });
        if (!keys)
          return txt(
            "broker not configured — add Alpaca keys via env (HOMETRADE_ALPACA_KEY/HOMETRADE_ALPACA_SECRET) or data/keys.json; paper mode until keys say otherwise",
          );
        return txt(
          `alpaca ${keys.mode} active — key ${keys.key.slice(0, 6)}…; real orders require the typed-confirmation gate in the web UI (HR-01); MCP stays read-only`,
        );
      }
      case "broker_account": {
        const keys = await resolveAlpacaKeys({
          env,
          readFile: keysFile ? () => fsReadFile(keysFile, "utf8") : null,
        });
        if (!keys) return txt("broker not configured");
        const bk = createAlpacaBroker({ keys });
        const [acc, positions, orders] = await Promise.all([
          bk.getAccount().catch((e) => ({ error: e.message })),
          bk.listPositions().catch((e) => ({ error: e.message })),
          bk
            .listOrders({ status: "open", limit: 50 })
            .catch((e) => ({ error: e.message })),
        ]);
        return txt(
          JSON.stringify(
            {
              mode: keys.mode,
              account:
                acc && !acc.error
                  ? {
                      status: acc.status,
                      cash: acc.cash,
                      equity: acc.equity,
                      buyingPower: acc.buying_power,
                    }
                  : acc,
              positions: Array.isArray(positions)
                ? positions.map((p) => ({
                    symbol: p.symbol,
                    qty: +p.qty,
                    avg: +p.avg_entry_price,
                    pnl: +p.unrealized_pl,
                  }))
                : positions,
              openOrders: Array.isArray(orders) ? orders.length : orders,
            },
            null,
            1,
          ),
        );
      }
      default:
        throw new Error(`unknown tool ${name}`);
    }
  }

  return {
    async handle(msg) {
      if (msg === null || typeof msg !== "object") return null;
      const isNotification = msg.id === undefined || msg.id === null;
      const reply = (result) =>
        isNotification ? null : { jsonrpc: "2.0", id: msg.id, result };
      const err = (code, message) =>
        isNotification
          ? null
          : { jsonrpc: "2.0", id: msg.id, error: { code, message } };
      switch (msg.method) {
        case "initialize":
          return reply({
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "hometrade", version: "0.1.0" },
          });
        case "notifications/initialized":
        case "initialized":
          return null;
        case "tools/list":
          return reply({ tools: TOOLS });
        case "tools/call": {
          try {
            return reply({
              content: [
                await call(msg.params?.name, msg.params?.arguments ?? {}),
              ],
              isError: false,
            });
          } catch (e) {
            return reply({
              content: [{ type: "text", text: `error: ${e.message}` }],
              isError: true,
            });
          }
        }
        case "ping":
          return reply({});
        default:
          return err(-32601, `method not found: ${msg.method}`);
      }
    },
  };
}

const txt = (t) => ({ type: "text", text: t });

// default real session for CLI usage (built lazily on first call, never at boot)
function defaultSessionFactory() {
  return import("./live.js").then((m) => m.buildLiveStack());
}

// ---- stdio main ----
export async function main() {
  const srv = createMcpServer({
    sessionFactory: () => import("./live.js").then((m) => m.buildLiveStack()),
  });
  const lineIn = createInterface({ input: process.stdin });
  const out = process.stdout;
  let closed = false;
  let pending = 0;
  const maybeExit = () => {
    if (closed && pending === 0) process.exit(0);
  };
  lineIn.on("line", (line) => {
    if (!line.trim()) return;
    let msg = null;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    pending += 1;
    void (async () => {
      try {
        const res = await srv.handle(msg);
        if (res) out.write(JSON.stringify(res) + "\n");
      } finally {
        pending -= 1;
        maybeExit();
      }
    })();
  });
  lineIn.on("close", () => {
    closed = true;
    maybeExit(); // stdio contract: EOF -> shutdown after in-flight calls drain
  });
  process.stderr.write("hometrade mcp: stdio ready\n");
}

if (process.argv[1] && process.argv[1].endsWith("mcp_server.js")) {
  main();
}
