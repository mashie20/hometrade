// hometrade — canvas renderer (original drawing code)
import { computeView } from "./view.js"; // browser-side copy of the shared pure math

export function drawChart(
  ctx,
  series,
  { width, height, barsOnScreen, rightOffset, dpr = 1 },
) {
  ctx.clearRect(0, 0, width, height);
  if (!series.length) return;
  const view = computeView(series, {
    width,
    height,
    barsOnScreen,
    rightOffset,
  });
  const { candles, barW, stripH, chartH } = view;

  // grid + price axis
  const steps = 6;
  ctx.font = "11px system-ui";
  for (let i = 0; i <= steps; i++) {
    const p = view.minPrice + ((view.maxPrice - view.minPrice) * i) / steps;
    const y = view.priceToY(p);
    ctx.strokeStyle = "#1b222b";
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
    ctx.fillStyle = "#7f8c98";
    ctx.textAlign = "left";
    ctx.fillText(fmt(p), 4, y - 4);
  }

  // candles + volume strip
  for (const c of candles) {
    const color = c.up ? "#3ddc97" : "#ff6b6b";
    wick(ctx, c, color);
    body(ctx, c, color);
    vol(ctx, c, color, stripH, chartH);
  }

  // time axis along bottom
  ctx.fillStyle = "#7f8c98";
  ctx.textAlign = "center";
  const every = Math.max(
    1,
    Math.floor(candles.length / Math.max(4, Math.floor(width / 90))),
  );
  for (let i = 0; i < candles.length; i += every) {
    const c = candles[i];
    ctx.fillText(
      new Date(c.openTime).toISOString().slice(5, 16).replace("T", " "),
      c.x,
      height - 8,
    );
  }

  // last price ladder line
  const last = candles.at(-1);
  ctx.strokeStyle = "#58a6ff88";
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(0, last.yC);
  ctx.lineTo(width, last.yC);
  ctx.stroke();
  ctx.setLineDash([]);

  return view;
}

function wick(ctx, c, color) {
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.moveTo(c.x, c.yH);
  ctx.lineTo(c.x, c.yL);
  ctx.stroke();
}
function body(ctx, c, color) {
  ctx.fillStyle = color;
  const yTop = Math.min(c.yO, c.yC);
  const h = Math.max(1, Math.abs(c.yC - c.yO));
  ctx.fillRect(c.x - c.barW / 2, yTop, c.barW, h);
}
function vol(ctx, c, color, stripH, chartH) {
  const y0 = chartH;
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = color;
  ctx.fillRect(c.x - c.barW / 2, y0, c.barW, Math.max(1, stripH));
  ctx.globalAlpha = 1;
  void c.yVol;
}

export function drawOverlay(ctx, view, mouse, header) {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  if (!mouse || !view) return;
  ctx.strokeStyle = "#7f8c9888";
  ctx.beginPath();
  ctx.moveTo(0, mouse.y);
  ctx.lineTo(ctx.canvas.width, mouse.y);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(mouse.x, 0);
  ctx.lineTo(mouse.x, ctx.canvas.height);
  ctx.stroke();
  if (view.priceToY && header) {
    const price = yToPrice(view, mouse.y, ctx.canvas.height - view.stripH);
    if (price !== null) {
      ctx.fillStyle = "#1a2129";
      ctx.fillRect(ctx.canvas.width - 74, mouse.y - 9, 72, 18);
      ctx.fillStyle = "#d9e1e8";
      ctx.textAlign = "center";
      ctx.fillText(fmt(price), ctx.canvas.width - 38, mouse.y + 4);
    }
  }
}

function yToPrice(view, y, chartH) {
  const t = (chartH - y) / chartH;
  if (t < -0.05 || t > 1.05) return null;
  return view.minPrice + t * (view.maxPrice - view.minPrice);
}

function fmt(p) {
  return p >= 1000 ? p.toFixed(1) : p >= 1 ? p.toFixed(2) : p.toPrecision(5);
}
