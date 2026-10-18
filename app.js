// hometrade — terminal UI: load & render chain, symbol dialog, interval menu,
// URL mirroring, SSE live tail, alerts + annotations panel. Original implementation.

import { drawChart, drawOverlay } from "./chart.js";
import { demoSeries } from "./demo-data.js";

const state = {
  series: [],
  view: null,
  barsOnScreen: 500,
  rightOffset: 0,
  header: null,
  server: false,
  dpr: Math.min(2, window.devicePixelRatio || 1),
};

const $ = (id) => document.getElementById(id);
const $$ = (sel) => document.querySelector(sel);
const chartCv = $("chart"),
  ovCv = $("overlay");

// ---- sizing ----
function sizeCanvases() {
  const r = chartCv.parentElement.getBoundingClientRect();
  for (const cv of [chartCv, ovCv]) {
    cv.width = Math.floor(r.width * state.dpr);
    cv.height = Math.floor(r.height * state.dpr);
    cv.style.width = `${r.width}px`;
    cv.style.height = `${r.height}px`;
    cv.getContext("2d").setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
  }
  state.dim = { width: r.width, height: r.height };
  repaint();
}
new ResizeObserver(sizeCanvases).observe(chartCv.parentElement);

// load(): server-backed when /api is alive; deterministic local demo otherwise
async function load(symbol, interval) {
  let data = null;
  if (state.server) {
    try {
      const res = await fetch(
        `/api/load?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}`,
      );
      if (res.ok) data = await res.json();
      else {
        toast({
          title: "Load failed",
          body: (await res.json()).error ?? res.status,
        });
        return;
      }
    } catch (e) {
      toast({ title: "Load failed", body: String(e && e.message) });
      return;
    }
  }
  if (!data) {
    // GitHub Pages / offline static mode: honestly-labelled local sample data
    const sep = String(symbol).indexOf(":");
    const exchange = sep > -1 ? symbol.slice(0, sep) : "DEMO";
    const ticker = sep > -1 ? symbol.slice(sep + 1) : symbol;
    data = {
      series: demoSeries(symbol, interval),
      header: {
        exchange,
        symbol: ticker,
        interval,
        key: symbol,
        demo: true,
      },
      viewState: { symbol, interval },
    };
  }
  state.series = data.series;
  state.header = data.header;
  $("symbol-btn").textContent = `${data.header.exchange}:${data.header.symbol}`;
  $("interval-btn").textContent = data.header.interval;
  const tkSymbol = document.getElementById("tk-symbol");
  if (tkSymbol) tkSymbol.value = data.header.key;
  renderLegend();
  renderSymbolInfo();
  syncUrl(data.viewState);
  updateMetrics();
  setSourceBadge();
  repaint();
  if (!data.header.demo) void refreshWatchlist(); // fresh watchlist per view
}

function setSourceBadge() {
  const badge = $("conn-badge");
  if (!state.header) return;
  if (state.header.demo) {
    badge.textContent = "DEMO";
    badge.className = "badge demo";
  } else if (state.header.exchange === "YAHOO") {
    badge.textContent = "POLL";
    badge.className = "badge poll";
  } else if (["LIVE", "POLL"].includes(badge.textContent)) {
    badge.className = badge.className.replace("demo", "");
  }
}

function repaint() {
  if (!state.dim) return;
  const ctx = chartCv.getContext("2d");
  state.view = drawChart(ctx, state.series, {
    width: state.dim.width,
    height: state.dim.height,
    barsOnScreen: state.barsOnScreen,
    rightOffset: state.rightOffset,
  });
  emitAnnotations();
}

function renderLegend() {
  const s = state.series.at(-1);
  if (!s || !state.header) {
    $("legend").textContent = "—";
    return;
  }
  const chg = s.close - s.open;
  const chgPct = ((chg / s.open) * 100).toFixed(2);
  const cls = chg >= 0 ? "up" : "down";
  $("legend").innerHTML =
    `<b>${state.header.exchange}:${state.header.symbol}</b> · ${state.header.interval} · ` +
    `O ${s.open.toFixed(2)} <span class="${cls}">C ${s.close.toFixed(2)} (${chgPct}%)</span>`;
}

async function renderSymbolInfo() {
  const s = state.series.at(-1);
  if (!s) return;
  $("symbol-info").innerHTML =
    `<div class="price">${fmtP(s.close)}</div>` +
    `<div class="sym-row"><span>${state.header.exchange}</span><span class="chg">${state.header.interval}</span></div>`;
}

function fmtP(p) {
  return p >= 1000
    ? p.toLocaleString(undefined, { maximumFractionDigits: 2 })
    : p.toFixed(4);
}

// ---- live dashboard metrics strip + status bar ----
function updateMetrics(prevClose = null) {
  const s = state.series.at(-1);
  if (!s || !state.header) return;
  const ref =
    prevClose ?? (state.series.at(-2) ? state.series.at(-2).close : s.open);
  $("m-price").textContent = fmtP(s.close);
  $("m-price").className = `metric ${s.close >= ref ? "up" : "down"}`;
  const pct = ((s.close - ref) / ref) * 100;
  const chgEl = $("m-chg");
  chgEl.textContent = `${s.close >= ref ? "+" : ""}${pct.toFixed(2)}%`;
  chgEl.className = `metric chg ${s.close >= ref ? "up" : "down"}`;
  let hi = -Infinity,
    lo = Infinity,
    span = 0;
  for (const b of state.series) {
    if (b.high > hi) hi = b.high;
    if (b.low < lo) lo = b.low;
    span += b.volume ?? 0;
  }
  $("m-hilo").textContent = `H ${fmtP(hi)}  L ${fmtP(lo)}`;
  const lastBar = state.series.at(-1);
  $("m-vol").textContent = `V ${fmtVol(lastBar?.volume ?? 0)}`;
  $("sb-bars").textContent =
    `${state.series.length} bars · ${state.header.exchange}`;
  $("m-src").textContent = srcLabel();
  $("sb-src").textContent = srcLabel();
}

function srcLabel() {
  if (!state.header) return "—";
  if (state.header.demo) return "local sample (deterministic)";
  return state.header.exchange === "YAHOO"
    ? "Yahoo Finance (poll ~3s, keyless)"
    : "Coinbase (websocket, keyless)";
}

function fmtVol(v) {
  if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(2) + "K";
  return (Math.round(v * 100) / 100).toString();
}

// ---- URL mirror (replaceState, our improvement over observed source behavior) ----
function syncUrl(vs) {
  const u = new URL(location.href);
  u.searchParams.set("symbol", vs.symbol);
  u.searchParams.set("interval", vs.interval);
  history.replaceState(null, "", u.pathname + "?" + u.searchParams.toString());
}

// ---- symbol dialog (keyboard-first; Enter commits; Esc cancels) ----
async function openSymbolDialog() {
  const dlg = $("dialog-sym"),
    input = $("sym-input");
  input.value = state.header
    ? `${state.header.exchange}:${state.header.symbol}`
    : "COINBASE:BTCUSDT";
  dlg.classList.remove("hidden");
  input.focus();
  input.select();
  const res = await fetch("/api/symbols?query=");
  const data = await res.json();
  $("sym-suggestions").innerHTML = data.matches
    .map((s) => `<option value="${s}">`)
    .join("");
}

function commitSymbol() {
  const v = $("sym-input").value.trim().toUpperCase();
  $("dialog-sym").classList.add("hidden");
  // bare ticker routing: crypto quotes -> Coinbase, else the equities universe
  const expanded = /^[A-Z0-9]+:(USDT|USD|EUR|BTC)[A-Z0-9]*$/.test(v)
    ? v
    : v.includes(":")
      ? v
      : /^(USDT|BUSD|FDUSD|USD)$/.test(v) || /USDT$|USD$/.test(v)
        ? `COINBASE:${v}`
        : `YAHOO:${v}`;
  if (/^[A-Z0-9_]+:[A-Z0-9_.-]+$/.test(expanded))
    load(expanded, state.header?.interval ?? "1m");
  else toast({ title: "Bad symbol", body: "expected EXCHANGE:TICKER" });
}

// ---- interval menu ----
function openIntervalMenu() {
  $("dialog-iv").classList.toggle("hidden");
}

// ---- events wiring ----
$("symbol-btn").addEventListener("click", openSymbolDialog);
$("sym-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") commitSymbol();
  if (e.key === "Escape") $("dialog-sym").classList.add("hidden");
});
$("interval-btn").addEventListener("click", openIntervalMenu);
document.querySelectorAll(".iv-row").forEach((row) => {
  row.addEventListener("click", () => {
    $("dialog-iv").classList.add("hidden");
    const iv = row.dataset.iv;
    if (state.header) load(state.header.key, iv);
  });
});
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && !e.repeat && !isInputFocused()) {
    e.preventDefault();
    openSymbolDialog();
  }
  if (e.key === "Escape" && !$("dialog-sym").classList.contains("hidden")) {
    $("dialog-sym").classList.add("hidden");
  }
});
function isInputFocused() {
  return ["INPUT", "TEXTAREA", "SELECT"].includes(
    document.activeElement?.tagName,
  );
}

// ---- wheel zoom (anchored) + drag pan ----
let dragging = null;
chartCv.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 1.12 : 0.89;
    state.barsOnScreen = Math.max(
      30,
      Math.min(2000, Math.round(state.barsOnScreen * factor)),
    );
    repaint();
  },
  { passive: false },
);
chartCv.addEventListener("mousedown", (e) => {
  dragging = { x: e.clientX, rightOffset: state.rightOffset };
});
window.addEventListener("mousemove", (e) => {
  if (dragging) {
    const barW = state.dim.width / state.barsOnScreen;
    state.rightOffset = Math.max(
      0,
      Math.min(
        state.series.length - 30,
        Math.round(dragging.rightOffset + (e.clientX - dragging.x) / barW),
      ),
    );
    repaint();
  }
  const r = chartCv.getBoundingClientRect();
  const mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
  drawOverlay(ovCv.getContext("2d"), state.view, mouse, state.header);
});
window.addEventListener("mouseup", () => {
  dragging = null;
});

// ---- SSE tail (server mode only; static Pages mode has no /events) ----
let lastTickTs = 0;
function initSSE() {
  const es = new EventSource("/events");
  es.onopen = () => {
    // (bugfix: chained && short-circuited — statements must be sequential)
    const badge = $("conn-badge");
    badge.textContent = state.header?.exchange === "YAHOO" ? "POLL" : "LIVE";
    badge.className = "badge live";
  };
  es.addEventListener("tick", (ev) => {
    ingestTick(JSON.parse(ev.data));
  });
  es.addEventListener("market_tick", (ev) => {
    ingestMarketTick(JSON.parse(ev.data));
  });
  es.addEventListener("toast", (ev) => {
    try {
      toast(JSON.parse(ev.data).toast);
    } catch {}
  });
  es.addEventListener("symbol_changed", (ev) => {
    const sym = JSON.parse(ev.data).symbol;
    if (state.header?.key && sym !== state.header.key) return; // stale echo
  });
  es.addEventListener("interval_changed", (ev) => {
    $("interval-btn").textContent = JSON.parse(ev.data).interval;
  });
}

function ingestTick(d) {
  lastTickTs = Date.now();
  $("sb-tick").textContent = wsFootprint();
  const tail = state.series.at(-1);
  if (tail && d.openTime === tail.openTime) {
    tail.close = d.close;
    if (d.close > tail.high) tail.high = d.close;
    if (d.close < tail.low) tail.low = d.close;
    tail.volume += 1e-6; // tick probe (server sends closed-only volume deltas later)
    if (d.prevClose) state.livePrevClose = d.prevClose;
  }
  updateMetrics(state.livePrevClose ?? d.prevClose ?? undefined);
  renderLegend();
  repaint();
  flashPanel("m-price");
}

function ingestMarketTick(d) {
  lastTickTs = Date.now();
  $("sb-tick").textContent = wsFootprint();
  // watchlist row update
  const row = document.querySelector(`#watchlist li[data-sym="${d.symbol}"]`);
  if (row) {
    const priceEl = row.querySelector(".wl-price");
    const chgEl = row.querySelector(".chg");
    const pct = d.prevClose
      ? ((d.price - d.prevClose) / d.prevClose) * 100
      : null;
    priceEl.textContent = fmtP(d.price);
    priceEl.className = `wl-price ${d.price >= (row._prev ?? d.price) ? "up" : "down"}`;
    row._prev = d.price;
    if (pct !== null) {
      chgEl.textContent = `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
      chgEl.className = `chg ${pct >= 0 ? "up" : "down"}`;
    }
    flashPanel(row);
    row.style.borderColor = "";
  }
  // main view: chart tail + metrics if the tick belongs to the visible symbol
  if (d.symbol === state.header?.key) {
    const tail = state.series.at(-1);
    if (tail) {
      tail.close = d.price;
      if (d.price > tail.high) tail.high = d.price;
      if (d.price < tail.low) tail.low = d.price;
    }
    state.livePrevClose = d.prevClose;
    updateMetrics(d.prevClose);
    renderLegend();
    repaint();
  }
  if (state.header && d.symbol === state.header.key) flashPanel("m-price");
  // account panel: held positions update live PnL off the same tick stream
  updatePositionPnl(d.symbol, d.price);
}

function wsFootprint() {
  return `last feed ${new Date(lastTickTs).toLocaleTimeString()} (${state.header?.exchange ?? "—"} · ${["COINBASE"].includes(state.header?.exchange) ? "WS" : "poll"})`;
}

function flashPanel(elishId) {
  const el = typeof elishId === "string" ? $(elishId) : elishId;
  if (!el) return;
  el.classList.remove("flash");
  void el.offsetWidth; // restart animation
  el.classList.add("flash");
}

// ---- alerts + annotations + watchlist panels ----
$("alert-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!state.header) return;
  await fetch("/api/alerts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      symbol: state.header.key,
      interval: state.header.interval,
      kind: $("alert-kind").value,
      price: Number($("alert-price").value),
    }),
  });
  refreshAlerts();
});
async function refreshAlerts() {
  const list = await (await fetch("/api/alerts")).json();
  $("alerts").innerHTML =
    list
      .map(
        (a) =>
          `<li title="${a.id}"><span>${a.armed ? "🟢" : "✅"} ${a.symbol.split(":")[1]} ${a.kind} ${a.price}</span><span data-del="${a.id}">✕</span></li>`,
      )
      .join("") || "<li class='dim'>no alerts</li>";
}
$("alerts").addEventListener("click", async (e) => {
  const id = e.target?.dataset?.del;
  if (!id) return;
  await fetch(`/api/alerts?id=${id}`, { method: "DELETE" });
  refreshAlerts();
});
$$("#toolrail [data-tool='alert']").addEventListener("click", () =>
  $("alert-price").focus(),
);
$$("#toolrail [data-tool='watch']").addEventListener("click", async () => {
  if (!state.header) return;
  await fetch("/api/watchlists", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "default", symbols: state.header.key }),
  });
  refreshWatchlist();
});
async function refreshWatchlist() {
  const lists = await (await fetch("/api/watchlists")).json();
  const symbols = lists[0]?.symbols ?? [
    "COINBASE:BTCUSDT",
    "COINBASE:ETHUSDT",
    "COINBASE:SOLUSDT",
    "YAHOO:AAPL",
    "YAHOO:NVDA",
  ];
  $("watchlist").innerHTML = symbols
    .map(
      (s, i) =>
        `<li data-sym="${s}" id="wl${i}"><span class="wl-sym">${s.split(":")[1]}</span><span class="wl-price" id="wlchg${i}">·</span><span class="chg" id="wlpct${i}">·</span></li>`,
    )
    .join("");
  symbols.forEach((s, i) => snapshotPrice(s, `wlchg${i}`, `wlpct${i}`));
  $("sb-universe").textContent = "whole-market search: / in the symbol box";
}
$("watchlist").addEventListener("click", (e) => {
  const sym = e.target?.closest("li")?.dataset?.sym;
  if (sym) load(sym, state.header?.interval ?? "1m");
});
async function snapshotPrice(sym, elId, pctId) {
  try {
    const res = await fetch(
      `/api/bars?symbol=${encodeURIComponent(sym)}&interval=1d&limit=2`,
    );
    const d = await res.json();
    const last = d.series?.at?.(-1);
    const prev = d.series?.at?.(-2);
    if (last && $(elId)) {
      $(elId).textContent = fmtP(last.close);
      if (prev && $(pctId)) {
        const pct = ((last.close - prev.close) / prev.close) * 100;
        $(pctId).textContent = `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
        $(pctId).className = `chg ${pct >= 0 ? "up" : "down"}`;
      }
    }
  } catch {
    /* offline ok */
  }
}
$$("#toolrail [data-tool='note']").addEventListener("click", async () => {
  if (!state.header) return;
  const text = prompt("annotation text for current view");
  if (!text) return;
  await fetch("/api/annotations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      symbol: state.header.key,
      interval: state.header.interval,
      text,
    }),
  });
  refreshAnnotations();
});
let annotationMarkers = [];
async function refreshAnnotations() {
  if (!state.header) return;
  annotationMarkers = await (
    await fetch(
      `/api/annotations?symbol=${encodeURIComponent(state.header.key)}`,
    )
  ).json();
}
function emitAnnotations() {
  // time-anchored markers over the visible window (cheap overlay, INSIDE the render pass)
  if (!state.view || !annotationMarkers.length) return;
  const ctx = ovCv.getContext("2d");
  ctx.font = "12px system-ui";
  for (const a of annotationMarkers) {
    const c = state.view.candles.find((k) => k.openTime >= a.ts);
    if (!c) continue;
    ctx.fillStyle = "#58a6ff";
    ctx.fillText("✓", c.x - 4, 14);
  }
}

// ---- toasts ----
function toast(t = {}) {
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `<div class="t-title"></div><div class="t-body"></div>`;
  el.querySelector(".t-title").textContent = t.title ?? "Notice";
  el.querySelector(".t-body").textContent = t.body ?? "";
  $("toasts").appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

// ---- Strategy Lab panel (HR-07 harness; research only) ----
$("lab-run").addEventListener("click", async () => {
  if (!state.header || state.header.demo) {
    $("lab-out").textContent =
      "needs a server-backed view (load a real symbol first)";
    return;
  }
  const out = $("lab-out");
  out.textContent = "running kill-list harness…";
  try {
    const r = await (
      await fetch("/api/lab", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          symbol: state.header.key,
          interval: state.header.interval,
          strategy: $("lab-strategy").value,
          cost_bps: Number($("lab-cost").value),
          slip_bps: Number($("lab-slip").value),
        }),
      })
    ).json();
    const pass = r.verdict === "PASS";
    out.innerHTML =
      `<div class="lab-verdict ${pass ? "pass" : "kill"}"><b>${r.verdict}</b>` +
      (r.failedHurdles.length
        ? ` — hurdles: ${r.failedHurdles.join(" ")}`
        : " — all hurdles green") +
      `</div>` +
      `<div class="dim">IS ${r.is.trades} trades, net ${r.is.netR.toFixed(4)}R · OOS ${r.oos.trades} trades, net ${r.oos.netR.toFixed(4)}R · train/holdout ${r.split.trainCount}/${r.split.holdoutCount}</div>` +
      `<div class="dim">${r.k7.detail}</div>` +
      `<div class="dim">${r.disclaimer}</div>`;
  } catch (e) {
    out.textContent = `lab error: ${e && e.message}`;
  }
});

// ---- static (Pages/offline) mode: honest simulated heartbeat ----
function startDemoTicks() {
  const badge = $("conn-badge");
  badge.textContent = "SIM";
  badge.className = "badge demo";
  setInterval(() => {
    const tail = state.series.at(-1);
    if (!tail || !state.header?.demo) return;
    // deterministic oscillation around the last close (SIM-labeled)
    const t = Date.now() / 1000;
    const drift = Math.sin(t / 20) * (tail.close * 0.0004);
    const tick = tail.close + drift;
    tail.close = tick;
    if (tick > tail.high) tail.high = tick;
    if (tick < tail.low) tail.low = tick;
    lastTickTs = Date.now();
    $("sb-tick").textContent =
      `last sim ${new Date(lastTickTs).toLocaleTimeString()}`;
    updateMetrics(tail.open);
    renderLegend();
    repaint();
  }, 1500);
}

state.server = await (async () => {
  try {
    const r = await fetch("/api/state");
    if (!r.ok) return false;
    const j = await r.json();
    state.universeSize = j.universeSize ?? 0;
    return !!j.dataDir;
  } catch {
    return false; // GitHub Pages / offline -> demo mode
  }
})();
if (state.server) {
  initSSE();
  refreshAlerts();
  refreshWatchlist();
  refreshAnnotations();
  $("sb-universe").textContent =
    state.universeSize > 0
      ? `universe: ${state.universeSize.toLocaleString()} listed symbols`
      : "universe loading…";
} else {
  startDemoTicks();
}
const u = new URL(location.href);
load(
  u.searchParams.get("symbol") ?? "COINBASE:BTCUSDT",
  u.searchParams.get("interval") ?? "1m",
);

// ================= auth + real-order ticket (Supabase + Alpaca) ==============

const authState = { user: null, configured: false, mode: "paper" };
let brokerLoop = null;
let pendingOrder = null;

function clientConfirmText(o) {
  // MUST stay identical to server's expectedConfirmText(); the gate is exact
  const q = String(Number(o.qty));
  const sym = String(o.symbol).toUpperCase();
  const head = authState.mode === "live" ? "CONFIRM LIVE" : "CONFIRM";
  return `${head} ${String(o.side).toUpperCase()} ${q} ${sym}${
    o.type === "limit" ? ` LIMIT ${Number(o.limitPrice).toFixed(2)}` : " MKT"
  }`;
}

function renderAuthChip() {
  const chip = $("auth-chip");
  if (!state.server) return; // Pages demo has no backend auth
  chip.classList.remove("hidden");
  if (authState.user) {
    chip.innerHTML = `<span class="who">${(authState.user.email ?? "").split("@")[0]}</span>
      <span class="badge ${authState.mode === "live" ? "livelive" : "paper"}" id="mode-badge">${authState.mode.toUpperCase()}</span>
      <button id="signout" class="ghost">logout</button>`;
    $("signout").addEventListener("click", doLogout);
  } else {
    chip.innerHTML = `<button id="auth-open" class="ghost">sign in · create account</button>`;
    $("auth-open").addEventListener("click", openAuthDialog);
  }
  const ticket = $("ticket");
  if (authState.user) ticket.classList.remove("hidden");
  document.getElementById("auth-open2").style.display = authState.user
    ? "none"
    : "";
}

function openAuthDialog() {
  $("dialog-auth").classList.remove("hidden");
  $("auth-email").focus();
}
function closeAuthDialog() {
  $("dialog-auth").classList.add("hidden");
}
$("auth-open").addEventListener("click", openAuthDialog);
document.getElementById("auth-open2").addEventListener("click", openAuthDialog);
$("auth-cancel").addEventListener("click", closeAuthDialog);
addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeAuthDialog();
    $("dialog-confirm").classList.add("hidden");
  }
});
function authMsg(text) {
  $("auth-msg").textContent = text;
}
async function submitAuth(kind) {
  const email = $("auth-email").value.trim();
  const pass = $("auth-pass").value;
  if (!email || !pass) return authMsg("email and password are both required");
  authMsg(kind === "register" ? "creating account…" : "signing in…");
  try {
    const r = await (
      await fetch(`/api/auth/${kind === "register" ? "register" : "login"}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email,
          password: pass,
          name: $("auth-name").value.trim(),
        }),
      })
    ).json();
    if (!r.ok) return authMsg(r.error ?? "failed");
    if (r.needsConfirm) {
      authMsg(r.message ?? "check your email to confirm, then sign in");
      return;
    }
    authState.user = r.user ?? { email };
    closeAuthDialog();
    renderAuthChip();
    beginBrokerLoop();
    toast({ title: "signed in", body: r.user?.email ?? "" });
  } catch (e) {
    authMsg(`network error: ${e && e.message}`);
  }
}
$("auth-login").addEventListener("click", () => submitAuth("login"));
$("auth-register").addEventListener("click", () => {
  $("auth-name").classList.remove("hidden");
  submitAuth("register");
});
async function doLogout() {
  await fetch("/api/auth/logout", { method: "POST" });
  authState.user = null;
  renderAuthChip();
  $("broker-body").innerHTML =
    `<button id="auth-open2" class="ghost dim">sign in to see your account</button>`;
  document
    .getElementById("auth-open2")
    .addEventListener("click", openAuthDialog);
  $("positions").innerHTML = "<li class='dim'>—</li>";
  $("orders").innerHTML = "<li class='dim'>—</li>";
  $("broker-chip").classList.add("hidden");
  $("ticket").classList.add("hidden");
  if (brokerLoop) clearInterval(brokerLoop);
}

// ---- broker panel ----
function money(v, cur = "USD") {
  const n = Number(v ?? 0);
  const abs = n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${n < 0 ? "-" : ""}$${abs}${cur !== "USD" ? ` ${cur}` : ""}`;
}

function renderBrokerBody(o) {
  const chip = $("broker-chip");
  chip.classList.remove("hidden");
  chip.textContent = o.mode === "live" ? "LIVE" : "PAPER";
  chip.className = `badge ${o.mode === "live" ? "livelive" : "paper"}`;
  authState.mode = o.mode;
  const mb = document.getElementById("mode-badge");
  if (mb) mb.textContent = o.mode.toUpperCase();

  const a = o.account;
  $("broker-body").innerHTML = a
    ? `<div class="acct-grid">
        <span>status</span><span>${a.status ?? "—"}</span>
        <span>cash</span><span id="acct-cash">${money(a.cash, a.currency)}</span>
        <span>equity</span><span id="acct-eq">${money(a.equity, a.currency)}</span>
        <span>buying power</span><span id="acct-bp">${money(a.buyingPower, a.currency)}</span>
      </div>
      <div class="dim smallrow">broker: Alpaca · mode: ${o.mode} · order gate: typed confirmation</div>`
    : `<div class="dim">account unreachable — broker error</div>`;
}

function renderPositions(positions) {
  const ul = $("positions");
  if (!positions.length) {
    ul.innerHTML = "<li class='dim'>no open positions</li>";
    return;
  }
  ul.innerHTML = positions
    .map(
      (p) =>
        `<li class="tabrow" data-pos="${p.symbol}" data-avg="${p.avgPrice}" data-qty="${p.qty}">
          <span class="wl-sym">${p.symbol}</span>
          <span class="dim">${p.qty} @ ${fmtP(p.avgPrice)}</span>
          <span class="chg" data-pnl>·</span>
        </li>`,
    )
    .join("");
  // seed last price from daily bars; live ticks take over from here
  positions.forEach(async (p) => {
    try {
      const res = await fetch(
        `/api/bars?symbol=${encodeURIComponent("YAHOO:" + p.symbol)}&interval=1d&limit=2`,
      );
      const d = await res.json();
      const last = d.series?.at?.(-1)?.close;
      if (last) updatePositionPnl(p.symbol, last);
    } catch {}
  });
}

function updatePositionPnl(symbol, price) {
  const row = document.querySelector(`#positions li[data-pos="${symbol}"]`);
  if (!row) return;
  const avg = Number(row.dataset.avg ?? 0);
  const qty = Number(row.dataset.qty ?? 0);
  const pnl = (price - avg) * qty;
  const pct = avg ? ((price - avg) / avg) * 100 : 0;
  const el = row.querySelector("[data-pnl]");
  el.textContent = `${money(pnl)} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)`;
  el.className = `chg ${pnl >= 0 ? "up" : "down"}`;
}

const OPEN_STATUS = new Set(["pending_new", "new", "partially_filled"]);
function renderOrders(orders) {
  const ul = $("orders");
  if (!orders.length) {
    ul.innerHTML = "<li class='dim'>no orders yet</li>";
    return;
  }
  ul.innerHTML = orders
    .slice(0, 12)
    .map((o) => {
      const open = OPEN_STATUS.has(o.status);
      const fill =
        o.status === "filled" && o.filledAvgPrice
          ? `fill ${fmtP(o.filledAvgPrice)}`
          : open
            ? `<button class="ghost xbtn" data-oid="${o.externalId ?? ""}">cancel</button>`
            : "";
      return `<li class="tabrow">
        <span class="wl-sym">${o.side?.toUpperCase()} ${o.qty} ${o.symbol}</span>
        <span class="badge ${open ? "poll" : o.status === "rejected" ? "demo" : "live"}">${o.status}</span>
        <span class="dim">${fill}</span>
      </li>`;
    })
    .join("");
  document.querySelectorAll("#orders .xbtn").forEach((b) =>
    b.addEventListener("click", async (e) => {
      const oid = e.target.dataset.oid;
      if (!oid) return;
      const r = await (
        await fetch("/api/broker/cancel", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: oid }),
        })
      ).json();
      toast({
        title: r.ok ? "cancel sent" : "cancel failed",
        body: r.error ?? "",
      });
      refreshBroker();
    }),
  );
}

function renderKeysForm(o) {
  $("broker-body").innerHTML = `
    <div class="info">
      <div class="hint">real orders need an Alpaca account. free paper keys:
        <a href="https://alpaca.markets" target="_blank" rel="noopener">alpaca.markets</a>
        — paste them here; they stay on this machine (data/keys.json)</div>
      <input id="kb-key" class="sym-field" placeholder="APCA-API-KEY-ID" autocomplete="off" />
      <input id="kb-secret" class="sym-field" type="password" placeholder="APCA-API-SECRET-KEY" autocomplete="off" />
      <div class="trow">
        <select id="kb-mode" class="tsmall">
          <option value="paper">paper</option>
          <option value="live">live</option>
        </select>
        <button id="kb-save" class="ghost">save keys</button>
      </div>
      <input id="kb-ack" class="sym-field hidden" type="text" placeholder='type "LIVE FUNDS" to enable live mode' />
      <div id="kb-msg" class="dim smallrow"></div>
    </div>`;
  const modeSel = document.getElementById("kb-mode");
  const ack = document.getElementById("kb-ack");
  modeSel.addEventListener("change", () =>
    ack.classList.toggle("hidden", modeSel.value !== "live"),
  );
  document.getElementById("kb-save").addEventListener("click", async () => {
    const r = await (
      await fetch("/api/broker/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          key: document.getElementById("kb-key").value,
          secret: document.getElementById("kb-secret").value,
          mode: modeSel.value,
          liveAck: ack.value,
        }),
      })
    ).json();
    const msg = document.getElementById("kb-msg");
    if (r.ok) {
      msg.textContent = `keys saved (${r.mode}) — opening trading…`;
      refreshBroker();
    } else msg.textContent = r.error ?? "failed to save keys";
  });
}

let brokerBusy = false;
async function refreshBroker() {
  if (!authState.user || brokerBusy) return;
  brokerBusy = true;
  try {
    const o = await (await fetch("/api/broker/overview")).json();
    if (!o.configured) {
      renderKeysForm(o);
      const chip = $("broker-chip");
      chip.classList.remove("hidden");
      chip.textContent = "NO KEYS";
      chip.className = "badge demo";
      authState.configured = false;
      authState.mode = "paper";
      $("positions").innerHTML = "<li class='dim'>—</li>";
      $("orders").innerHTML = "<li class='dim'>—</li>";
      $("tk-note").textContent = "add Alpaca keys to enable real orders";
      return;
    }
    authState.configured = true;
    renderBrokerBody(o);
    renderPositions(o.positions ?? []);
    renderOrders(o.orders ?? []);
    refreshEst();
    $("tk-note").textContent =
      o.mode === "live" ? "LIVE mode — real money at risk" : "";
  } catch {
    /* transient */
  } finally {
    brokerBusy = false;
  }
}

function beginBrokerLoop() {
  if (brokerLoop) clearInterval(brokerLoop);
  refreshBroker();
  brokerLoop = setInterval(refreshBroker, 8000);
}

// ---- order ticket ----
function lastPriceFor(sym) {
  if (state.header?.key === sym) return state.series.at(-1)?.close ?? null;
  const row = document.querySelector(
    `#watchlist li[data-sym="${sym}"] .wl-price`,
  );
  if (row) {
    const n = Number(String(row.textContent).replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}
function refreshEst() {
  const sym = $("tk-symbol").value.trim().toUpperCase();
  const qty = Number($("tk-qty").value);
  const px = lastPriceFor(sym);
  $("tk-est").textContent =
    Number.isFinite(qty) && qty > 0 && px
      ? `est: ${money(qty * px)} @ last ${fmtP(px)}`
      : "est: —";
}
["tk-qty", "tk-limit", "tk-type"].forEach((id) =>
  $(id).addEventListener("input", refreshEst),
);
$("tk-type").addEventListener("change", () => {
  $("tk-limit").classList.toggle("hidden", $("tk-type").value !== "limit");
  refreshEst();
});
$("tk-symbol").addEventListener("input", refreshEst);
["tk-buy", "tk-sell"].forEach((id) =>
  $(id).addEventListener("click", () => {
    $("tk-buy").classList.add("active");
    $("tk-sell").classList.remove("active");
    if (id === "tk-sell") {
      $("tk-sell").classList.add("active");
      $("tk-buy").classList.remove("active");
    }
    refreshEst();
  }),
);

$("ticket").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!authState.user) return openAuthDialog();
  if (!authState.configured) {
    toast({ title: "keys needed", body: "add Alpaca keys first" });
    return;
  }
  const symbol = $("tk-symbol").value.trim().toUpperCase();
  const qty = Number($("tk-qty").value);
  const type = $("tk-type").value;
  const limitPrice = type === "limit" ? Number($("tk-limit").value) : null;
  if (!symbol || !(qty > 0)) {
    toast({
      title: "ticket incomplete",
      body: "symbol and quantity are required",
    });
    return;
  }
  pendingOrder = {
    symbol,
    side: $("tk-sell").classList.contains("active") ? "sell" : "buy",
    qty,
    type,
    limitPrice,
  };
  pendingOrder.expected = clientConfirmText(pendingOrder);
  $("cf-summary").textContent = pendingOrder.expected;
  $("cf-echo").value = "";
  $("dialog-confirm").classList.remove("hidden");
  $("cf-echo").focus();
});
$("cf-cancel").addEventListener("click", () =>
  $("dialog-confirm").classList.add("hidden"),
);
$("cf-go").addEventListener("click", async () => {
  if (!pendingOrder) return;
  if ($("cf-echo").value.trim() !== pendingOrder.expected) {
    $("cf-summary").textContent = "typed text did not match — try again";
    return;
  }
  $("dialog-confirm").classList.add("hidden");
  $("tk-place").disabled = true;
  try {
    const r = await (
      await fetch("/api/broker/order", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...pendingOrder,
          confirmText: $("cf-echo").value.trim(),
        }),
      })
    ).json();
    if (r.ok) {
      toast({
        title: `order ${r.order.status}`,
        body: `${String(r.order.side).toUpperCase()} ${r.order.qty} ${r.order.symbol} @ ${r.order.mode || authState.mode}`,
      });
    } else {
      toast({ title: "order rejected", body: r.error ?? "broker error" });
    }
  } catch (e) {
    toast({ title: "network error", body: e && e.message });
  } finally {
    $("tk-place").disabled = false;
    pendingOrder = null;
    refreshBroker();
  }
});

// boot auth silently
if (state.server) {
  (async () => {
    try {
      const r = await (await fetch("/api/auth/me")).json();
      authState.user = r.user;
      renderAuthChip();
      if (authState.user) beginBrokerLoop();
    } catch {}
  })();
}
