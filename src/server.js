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
import { SupabaseClient, decodeJwtExp } from "./supabase.js";
import { resolveAlpacaKeys, createAlpacaBroker } from "./broker.js";
import { timingSafeEqual, createHash } from "node:crypto";
import { randomUUID } from "node:crypto";

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

// ---- auth + broker (Supabase backend + Alpaca execution) ----
// Design: the browser never sees any key. The user's Supabase access token
// rides an HttpOnly cookie and is forwarded to PostgREST so RLS (owner-only
// policies) enforces every read/write. Broker keys stay server-side of it.

const SESSION_COOKIE = "hometrade_session";
const supabase = new SupabaseClient();
const KEYS_FILE = join(DATA_DIR, "keys.json");
const liveHashCheck = (a, b) =>
  !a ||
  !b ||
  !timingSafeEqual(
    createHash("sha256").update(String(a)).digest(),
    createHash("sha256").update(String(b)).digest(),
  );

function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie ?? "";
  for (const part of h.split(/; */)) {
    const i = part.indexOf("=");
    if (i > 0) {
      try {
        out[part.slice(0, i)] = decodeURIComponent(part.slice(i + 1));
      } catch {
        /* bad cookie chunk ignored */
      }
    }
  }
  return out;
}

function packSessionCookie({ a, r, eMs }) {
  return `${SESSION_COOKIE}=${Buffer.from(
    JSON.stringify({ a, r, e: eMs }),
  ).toString("base64url")}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`;
}
function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

// resolves the session (refreshing it transparently when near/past expiry).
// returns {token, sub, email} and rotates the cookie on refresh.
async function withSession(req, res) {
  const raw = parseCookies(req)[SESSION_COOKIE];
  if (!raw) return null;
  let s = null;
  try {
    s = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!s?.a || !s?.r) return null;
  const payload = decodeJwtExp(s.a);
  const expMs = (payload.exp ?? 0) * 1000;
  const stale = Date.now() > expMs - 10 * 60e3;
  if (!stale) return { token: s.a, sub: payload.sub, email: payload.email };
  const r = await supabase.refresh(s.r);
  if (!r.ok || !r.session?.access_token) {
    res.setHeader("Set-Cookie", clearSessionCookie());
    return null;
  }
  const np = decodeJwtExp(r.session.access_token);
  res.setHeader(
    "Set-Cookie",
    packSessionCookie({
      a: r.session.access_token,
      r: r.session.refresh_token,
      eMs: (np.exp ?? 0) * 1000,
    }),
  );
  return { token: r.session.access_token, sub: np.sub, email: np.email };
}

async function requireUser(req, res) {
  const u = await withSession(req, res);
  if (!u) {
    jsonRes(res, 401, { error: "auth_required" });
    return null;
  }
  return u;
}

async function brokerKeys() {
  return await resolveAlpacaKeys({
    env: process.env,
    readFile: () => readFile(KEYS_FILE, "utf8"),
  });
}

// stable per-user paper account row (hook creates it at signup; this heals
// accounts that predate the hook)
async function getPaperAccount(u, db) {
  const rows = await db.select(
    "?user_id=eq." + u.sub + "&mode=eq.paper&limit=1",
  );
  if (rows.length) return rows[0];
  return await db.insert({
    user_id: u.sub,
    mode: "paper",
    broker: "alpaca",
    cash: 100000,
  });
}

// HR-01 typed confirmation string. Same builder on server and client.
function expectedConfirmText({ side, qty, symbol, type, limitPrice, mode }) {
  const q = String(Number(qty));
  const sym = String(symbol).toUpperCase();
  const head = mode === "live" ? "CONFIRM LIVE" : "CONFIRM";
  return `${head} ${String(side).toUpperCase()} ${q} ${sym}${
    type === "limit" ? ` LIMIT ${Number(limitPrice).toFixed(2)}` : " MKT"
  }`;
}

async function getBroker(u) {
  const keys = await brokerKeys();
  if (!keys) return { configured: false };
  return {
    configured: true,
    broker: createAlpacaBroker({ keys }),
    mode: keys.mode ?? "paper",
  };
}

// reconcile: broker truth -> our orders/positions rows (owner-scoped writes)
async function reconcileBroker(u, db, bk, accountId) {
  const [rows, brokerOrders, brokerPositions, account] = await Promise.all([
    db("orders", u.token)
      .select("?user_id=eq." + u.sub + "&order=created_at.desc&limit=100")
      .catch(() => []),
    bk.broker.listOrders({ status: "all", limit: 100 }).catch(() => []),
    bk.broker.listPositions().catch(() => []),
    bk.broker.getAccount().catch(() => null),
  ]);
  const mergedOrders = [];
  for (const bo of brokerOrders) {
    const row = rows.find((x) => x.id === bo.clientId) ?? null;
    if (row) {
      const patch = {};
      if (row.external_id !== bo.externalId) patch.external_id = bo.externalId;
      if (row.status !== bo.status) patch.status = bo.status;
      if (row.filled_qty != bo.filledQty) patch.filled_qty = bo.filledQty;
      if (row.filled_avg_price !== bo.filledAvgPrice)
        patch.filled_avg_price = bo.filledAvgPrice;
      if (Object.keys(patch).length) {
        await db("orders", u.token)
          .update(patch, "?id=eq." + row.id)
          .catch(() => {});
      }
    }
    mergedOrders.push({
      ...bo,
      confirmText: row?.confirm_text ?? null,
      ourId: row?.id ?? null,
    });
  }
  // positions upsert (patch-then-insert keeps it dependency-free)
  const positions = [];
  for (const p of brokerPositions) {
    const mapped = {
      symbol: p.symbol,
      qty: Number(p.qty ?? 0),
      avgPrice: Number(p.avg_entry_price ?? 0),
      marketValue: Number(p.market_value ?? 0),
      unrealizedPl: Number(p.unrealized_pl ?? 0),
      unrealizedPlpc: Number(p.unrealized_plpc ?? 0),
    };
    positions.push(mapped);
    const q = `?account_id=eq.${accountId}&symbol=eq.${encodeURIComponent(p.symbol)}`;
    const upd = await db("positions", u.token)
      .update(
        {
          qty: mapped.qty,
          avg_price: mapped.avgPrice,
          realized_pl: Number(p.realized_pl ?? 0),
        },
        q,
      )
      .catch(() => []);
    if (!upd.length) {
      await db("positions", u.token)
        .insert({
          user_id: u.sub,
          account_id: accountId,
          symbol: p.symbol,
          qty: mapped.qty,
          avg_price: mapped.avgPrice,
          realized_pl: Number(p.realized_pl ?? 0),
        })
        .catch(() => {});
    }
  }
  // live-quote tracking for open position symbols
  for (const p of positions) {
    if (p.qty) brokerTracked.add(`YAHOO:${p.symbol}`);
  }
  return { account, positions, orders: mergedOrders };
}

// symbols held in the broker account — polled for live PnL ticks
const brokerTracked = new Set();

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
  // held position symbols get live quotes too (PnL ticks in the account panel)
  for (const s of [...brokerTracked].slice(0, 12))
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

    // ---- auth (Supabase email+password; session lives in an HttpOnly cookie) ----
    if (p === "/api/auth/register" && req.method === "POST") {
      const b = await body(req);
      const email = String(b.email ?? "")
        .trim()
        .toLowerCase();
      const password = String(b.password ?? "");
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
        return jsonRes(res, 400, { ok: false, error: "enter a valid email" });
      if (password.length < 8)
        return jsonRes(res, 400, {
          ok: false,
          error: "password needs at least 8 characters",
        });
      const r = await supabase.signUp(email, password, {
        name: String(b.name ?? "").slice(0, 60) || "trader",
      });
      if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.error });
      if (r.session) {
        const pld = decodeJwtExp(r.session.access_token);
        res.setHeader(
          "Set-Cookie",
          packSessionCookie({
            a: r.session.access_token,
            r: r.session.refresh_token,
            eMs: (pld.exp ?? 0) * 1000,
          }),
        );
        return jsonRes(res, 200, {
          ok: true,
          user: { id: r.user?.id ?? pld.sub, email },
        });
      }
      return jsonRes(res, 200, {
        ok: true,
        needsConfirm: true,
        message:
          "account created — check your email for the confirmation link, then sign in",
      });
    }
    if (p === "/api/auth/login" && req.method === "POST") {
      const b = await body(req);
      const email = String(b.email ?? "")
        .trim()
        .toLowerCase();
      const password = String(b.password ?? "");
      const r = await supabase.signIn(email, password);
      if (!r.ok) return jsonRes(res, 401, { ok: false, error: r.error });
      const pld = decodeJwtExp(r.session.access_token);
      res.setHeader(
        "Set-Cookie",
        packSessionCookie({
          a: r.session.access_token,
          r: r.session.refresh_token,
          eMs: (pld.exp ?? 0) * 1000,
        }),
      );
      return jsonRes(res, 200, {
        ok: true,
        user: { id: r.user?.id ?? pld.sub, email },
      });
    }
    if (p === "/api/auth/logout" && req.method === "POST") {
      const u = await withSession(req, res);
      if (u) void supabase.logout(u.token).catch?.(() => {});
      res.setHeader("Set-Cookie", clearSessionCookie());
      return jsonRes(res, 200, { ok: true });
    }
    if (p === "/api/auth/me" && req.method === "GET") {
      const u = await withSession(req, res);
      return jsonRes(res, 200, {
        user: u ? { sub: u.sub, email: u.email } : null,
      });
    }

    // ---- broker (Alpaca; keys stay server-side) ----
    if (p === "/api/broker/status" && req.method === "GET") {
      const u = await requireUser(req, res);
      if (!u) return;
      const keys = await brokerKeys();
      if (!keys) return jsonRes(res, 200, { configured: false });
      return jsonRes(res, 200, {
        configured: true,
        mode: keys.mode ?? "paper",
        keyId: `${String(keys.key).slice(0, 6)}…`,
      });
    }
    if (p === "/api/broker/keys" && req.method === "POST") {
      const u = await requireUser(req, res);
      if (!u) return;
      const b = await body(req);
      const key = String(b.key ?? "").trim();
      const secret = String(b.secret ?? "").trim();
      const mode = b.mode === "live" ? "live" : "paper";
      if (
        !key.length ||
        key.length > 256 ||
        !secret.length ||
        secret.length > 512
      )
        return jsonRes(res, 400, {
          ok: false,
          error: "paste both Alpaca key id and secret",
        });
      if (mode === "live" && b.liveAck !== "LIVE FUNDS")
        return jsonRes(res, 400, {
          ok: false,
          error: 'live mode needs the typed acknowledgment "LIVE FUNDS"',
        });
      await writeFile(
        KEYS_FILE,
        JSON.stringify({ alpaca: { key, secret, mode } }, null, 2),
      );
      return jsonRes(res, 200, {
        ok: true,
        mode,
        keyId: `${key.slice(0, 6)}…`,
      });
    }
    if (p === "/api/broker/overview" && req.method === "GET") {
      const u = await requireUser(req, res);
      if (!u) return;
      const bk = await getBroker(u);
      if (!bk.configured) return jsonRes(res, 200, { configured: false });
      const db = (t) => supabase.db(t, u.token);
      const acc = await getPaperAccount(u, db);
      const r = await reconcileBroker(u, db, bk, acc?.id ?? null);
      return jsonRes(res, 200, {
        configured: true,
        mode: bk.mode,
        accountId: acc?.id ?? null,
        account: r.account
          ? {
              status: r.account.status,
              cash: r.account.cash,
              equity: r.account.equity,
              buyingPower: r.account.buying_power,
              portfolioValue: r.account.portfolio_value,
              currency: r.account.currency ?? "USD",
            }
          : null,
        positions: r.positions,
        orders: r.orders,
      });
    }
    if (p === "/api/broker/order" && req.method === "POST") {
      const u = await requireUser(req, res);
      if (!u) return;
      const b = await body(req);
      const bk = await getBroker(u);
      if (!bk.configured)
        return jsonRes(res, 400, {
          ok: false,
          error: "broker_not_configured",
          hint: "add Alpaca keys below, or set HOMETRADE_ALPACA_KEY/SECRET",
        });
      const type = b.type === "limit" ? "limit" : "market";
      const expected = expectedConfirmText({
        side: b.side,
        qty: b.qty,
        symbol: b.symbol,
        type,
        limitPrice: b.limitPrice,
        mode: bk.mode,
      });
      if (liveHashCheck(b.confirmText, expected))
        return jsonRes(res, 400, {
          ok: false,
          error: "confirm_text_mismatch",
          expected,
        });
      const orderId = randomUUID();
      const db = (t) => supabase.db(t, u.token);
      const acc = await getPaperAccount(u, db);
      let row;
      try {
        row = await db("orders").insert({
          user_id: u.sub,
          account_id: acc.id,
          symbol: String(b.symbol).toUpperCase(),
          side: b.side === "sell" ? "sell" : "buy",
          qty: Number(b.qty),
          order_type: type,
          limit_price: type === "limit" ? Number(b.limitPrice) : null,
          time_in_force: "day",
          status: "pending_new",
          confirm_text: expected,
        });
      } catch (e) {
        return jsonRes(res, 400, {
          ok: false,
          error: `order record failed: ${e && e.message}`,
        });
      }
      try {
        const placed = await bk.broker.placeOrder({
          id: orderId,
          symbol: b.symbol,
          side: b.side,
          qty: Number(b.qty),
          type,
          limitPrice: type === "limit" ? Number(b.limitPrice) : null,
        });
        await db("orders")
          .update(
            {
              external_id: placed.externalId,
              status: placed.status,
              filled_qty: placed.filledQty,
              filled_avg_price: placed.filledAvgPrice,
              error: null,
            },
            "?id=eq." + row.id,
          )
          .catch(() => {});
        return jsonRes(res, 200, {
          ok: true,
          order: { ...placed, ourId: row.id, confirmText: expected },
        });
      } catch (e) {
        await db("orders")
          .update({ status: "rejected", error: e.message }, "?id=eq." + row.id)
          .catch(() => {});
        return jsonRes(res, 502, {
          ok: false,
          error: e.message,
          status: "rejected",
          ourId: row.id,
        });
      }
    }
    if (p === "/api/broker/cancel" && req.method === "POST") {
      const u = await requireUser(req, res);
      if (!u) return;
      const b = await body(req);
      const bk = await getBroker(u);
      if (!bk.configured)
        return jsonRes(res, 400, { ok: false, error: "broker_not_configured" });
      try {
        await bk.broker.cancelOrder(b.id);
      } catch (e) {
        return jsonRes(res, 502, { ok: false, error: e.message });
      }
      const db = (t) => supabase.db(t, u.token);
      await db("orders")
        .update(
          { status: "canceled" },
          "?external_id=eq." + encodeURIComponent(b.id),
        )
        .catch(() => {});
      return jsonRes(res, 200, { ok: true });
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
