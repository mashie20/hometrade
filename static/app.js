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
  renderLegend();
  renderSymbolInfo();
  syncUrl(data.viewState);
  repaint();
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
  if (/^[A-Z0-9_]+:[A-Z0-9_.-]+$/.test(v))
    load(v, state.header?.interval ?? "1m");
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
function initSSE() {
  const es = new EventSource("/events");
  es.onopen = () =>
    $("conn-badge").classList.add("live") &&
    ($("conn-badge").textContent = "LIVE");
  es.addEventListener("tick", (ev) => {
    const d = JSON.parse(ev.data);
    const tail = state.series.at(-1);
    if (tail && d.openTime === tail.openTime) {
      tail.close = d.close;
      if (d.close > tail.high) tail.high = d.close;
      if (d.close < tail.low) tail.low = d.close;
      tail.volume += 1e-6; // tick probe (server sends closed-only volume deltas later)
    }
    renderLegend();
    repaint();
  });
  es.addEventListener("toast", (ev) => {
    try {
      toast(JSON.parse(ev.data).toast);
    } catch {}
  });
  es.addEventListener("interval_changed", (ev) => {
    $("interval-btn").textContent = JSON.parse(ev.data).interval;
  });
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
  ];
  $("watchlist").innerHTML = symbols
    .map(
      (s, i) =>
        `<li data-sym="${s}"><span>${s.split(":")[1]}</span><span class="chg" id="wlchg${i}">·</span></li>`,
    )
    .join("");
  symbols.forEach((s, i) => snapshotPrice(s, `wlchg${i}`));
}
$("watchlist").addEventListener("click", (e) => {
  const sym = e.target?.closest("li")?.dataset?.sym;
  if (sym) load(sym, state.header?.interval ?? "1m");
});
async function snapshotPrice(sym, elId) {
  try {
    const res = await fetch(
      `/api/bars?symbol=${encodeURIComponent(sym)}&interval=1d&limit=1`,
    );
    const d = await res.json();
    const last = d.series?.at?.(-1);
    if (last) $(elId).textContent = fmtP(last.close);
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

// ---- boot ----
sizeCanvases();
state.server = await (async () => {
  try {
    const r = await fetch("/api/state");
    if (!r.ok) return false;
    const j = await r.json();
    return !!j.dataDir;
  } catch {
    return false; // GitHub Pages / offline -> demo mode
  }
})();
if (state.server) initSSE();
else $("conn-badge").textContent = "DEMO";
const u = new URL(location.href);
load(
  u.searchParams.get("symbol") ?? "COINBASE:BTCUSDT",
  u.searchParams.get("interval") ?? "1m",
).then(async () => {
  if (!state.server) return; // panels need the local server; demo mode shows chart only
  try {
    refreshAlerts();
    refreshWatchlist();
    refreshAnnotations();
  } catch {}
});
