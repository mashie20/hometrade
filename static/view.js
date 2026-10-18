// hometrade — pure viewport math (layout contract used by the canvas renderer)

export const AXIS = { timeH: 26, panePad: 0.05 };

/**
 * computeView(series, {width, height, barsOnScreen, rightOffset})
 * Maps the last N bars into canvas coordinates: candle geometry + volume strip.
 * Pure: no DOM, no input mutation. Volume strip overlays the price pane bottom.
 */
export function computeView(
  series,
  { width = 1280, height = 720, barsOnScreen, rightOffset = 0 } = {},
) {
  const n = Math.max(barsOnScreen ?? series.length, 1);
  const end = Math.max(1, series.length - rightOffset);
  const start = Math.max(0, end - n);
  const visible = series.slice(start, end);
  const barW = width / n;
  const strip = Math.max(18, Math.floor(height * 0.12));
  const chartH = Math.max(50, height - AXIS.timeH - strip);
  let min = Infinity,
    max = -Infinity,
    volMax = 0;
  for (const c of visible) {
    if (c.low < min) min = c.low;
    if (c.high > max) max = c.high;
    if (c.volume > volMax) volMax = c.volume;
  }
  if (!Number.isFinite(min) || min === max) {
    min = min === max ? (min || 0) - 1 : min;
    max += 1;
  }
  const pad = (max - min) * AXIS.panePad;
  min -= pad;
  max += pad;
  const y = (p) => chartH - ((p - min) / (max - min)) * chartH;
  const yVol = (v) => strip - (volMax ? (v / volMax) * strip : 0);
  const candles = visible.map((c, i) => ({
    openTime: c.openTime,
    x: i * barW + barW / 2,
    yO: y(c.open),
    yC: y(c.close),
    yH: y(c.high),
    yL: y(c.low),
    yVol: yVol(c.volume),
    up: c.close >= c.open,
    barW: Math.max(1, barW * 0.66),
  }));
  return {
    candles,
    barW,
    minPrice: min,
    maxPrice: max,
    priceToY: y,
    timeToX: (openTime) => {
      const idx = visible.findIndex((c) => c.openTime === openTime);
      return idx === -1 ? null : candles[idx].x;
    },
    stripH: strip,
    chartH,
  };
}
