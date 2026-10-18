// hometrade — Strategy Lab: HR-07 kill-list harness (research/paper only).
// Path rule (K-1): signals read bar-i CLOSE (bar fully closed), fill at bar
// i+1 OPEN with slippage. The final series bar is in-flight and NEVER used.
// Split rule (K-5): first 70% train, last 30% holdout — touched exactly once,
// at the end, then sealed. Neighbors (K-6) run on TRAIN data only.

import { sma, rsi } from "./indicators.js";

const TRAIN_FRACTION = 0.7;

export function runLab({
  series,
  strategy = "sma_cross",
  params = {},
  costBps = 2.5,
  slipBps = 1.5,
  unitSize = 1,
} = {}) {
  const closed = series.slice(0, -1); // K-1: drop in-flight final bar
  const n = closed.length;
  const closes = closed.map((c) => c.close);
  const sigs = buildSignals(strategy, params, closes);

  // K-5 split
  const trainCount = Math.max(1, Math.floor(n * TRAIN_FRACTION));
  const holdoutCount = n - trainCount;

  // trades: K-1 audited fills (entry at next-bar open, both sides)
  const trades = [];
  let holding = null;
  for (let i = 0; i < n; i++) {
    const want = sigs[i]; // signal ON BAR CLOSE i
    const fillBar = closed[i + 1]; // executable at open of i+1
    if (want === "long" && holding === null && fillBar) {
      holding = {
        entryOpenTime: fillBar.openTime,
        entryPrice: slip(fillBar.open, +slipBps), // buy at open + slippage
        entryIdx: i + 1,
      };
    } else if (want === "flat" && holding !== null) {
      if (fillBar) {
        trades.push(
          closeTrade(holding, slip(fillBar.open, -slipBps), i + 1, costBps),
        );
      } else {
        trades.push(closeTrade(holding, closed[i].close, i, costBps)); // final mark
      }
      holding = null;
    } else if (
      want === "long" &&
      holding !== null &&
      sigs[i - 1] !== "long" &&
      fillBar
    ) {
      // re-entry gap (kept flat between signals)
    }
  }
  if (holding !== null)
    trades.push(closeTrade(holding, closed[n - 1].close, n - 1, costBps)); // final mark

  // segment returns (K-5: single evaluation of holdout)
  const inTrades = trades.filter((t) => t.entryIdx < trainCount);
  const holdTrades = trades.filter((t) => t.entryIdx >= trainCount);
  const is = stats(inTrades, closed.slice(0, trainCount));
  const oos = stats(holdTrades, closed.slice(trainCount), true);
  oos.viewCount = 1; // exactly-once evaluation
  oos.sealed = true;

  // K-4: costs survival (already inside trade pnl; gross for the audit trail)
  const k4 = {
    costBps,
    slipBps,
    pass:
      is.netR > 0 || is.trades === 0
        ? oos.trades === 0
          ? true
          : oos.netR > 0
        : false,
    detail: `gross ${is.grossR.toFixed(4)}R vs net ${is.netR.toFixed(4)}R (${is.trades} r.t. @ ${(costBps + slipBps).toFixed(1)}bps/side)${oos.trades ? `, OOS net ${oos.netR.toFixed(4)}R` : ""}`,
  };

  // K-6: neighbors on TRAIN only
  const nbSpecs = neighborSpecs(strategy, params);
  const neighbors = nbSpecs.map(({ label, params: p }) => {
    const s = buildSignals(strategy, p, closes.slice(0, trainCount));
    const tr = simulateTrades(s, closed.slice(0, trainCount), costBps, slipBps);
    return { label, touchedHoldout: false, netR: stats(tr, []).netR };
  });
  const baseIn = is.netR;
  const dispersion =
    neighbors.length > 0
      ? Math.max(
          ...neighbors.map(
            (nb) =>
              Math.abs(nb.netR - baseIn) / Math.max(1e-9, Math.abs(baseIn)),
          ),
        )
      : 0;
  const k6 = {
    neighbors,
    dispersion,
    plateau: neighbors.length > 0 && dispersion <= 0.5,
    detail: `neighbor dispersion ${(dispersion * 100).toFixed(1)}% (plateau ≤ 50%)`,
  };

  // K-7: capacity vs observed bar volume
  const advUnits =
    closed.reduce((acc, c) => acc + c.volume, 0) / Math.max(1, closed.length);
  const tradedVolume = trades.length * unitSize * 2; // entry+exit both consume flow
  const k7 = {
    advUnits,
    tradedVolume,
    pass: tradedVolume <= advUnits * 0.05 * n,
    detail: `flow ${((tradedVolume / Math.max(1e-9, advUnits * n)) * 100).toFixed(2)}% of cumulative volume (ceiling 5%)`,
  };

  const failedHurdles = [];
  if (is.trades === 0 || holdTrades.length === 0) {
    // K-0: no statable evidence — a rule that did not trade in BOTH regimes
    // can never demonstrate edge, so it can never pass.
    failedHurdles.push("K-0");
  }
  if (!k4.pass) failedHurdles.push("K-4");
  if (!k6.plateau) failedHurdles.push("K-6");
  if (!k7.pass) failedHurdles.push("K-7");
  if (holdTrades.length > 0 && oos.netR <= 0) failedHurdles.push("K-5:S");
  const verdict = failedHurdles.length === 0 ? "PASS" : "KILL";

  return {
    symbol: undefined,
    strategy,
    params,
    verdict,
    failedHurdles,
    droppedLastBar: series.length !== closed.length,
    trades,
    split: {
      trainCount,
      holdoutCount,
      sealed: true,
      holdoutViewCount: oos.viewCount,
    },
    is,
    oos,
    k1: {
      pass: true,
      rule: "signal on closed bar close; fill next-bar open ± slippage",
    },
    k2: {
      pass: true,
      rule: "single fixed input set; no tuning loop; no re-selection",
    },
    k3: {
      note: "single-symbol lab; universe selection not in scope here",
      pass: null,
    },
    k4,
    k5: { pass: true, sealedAtEval: true },
    k6,
    k7,
    disclaimer:
      "Paper-only research harness per HR-07. PASS here ≠ investable strategy; capacity, market-structure and regime risk remain owner-side duties.",
  };
}

function buildSignals(strategy, params, closes) {
  if (strategy === "rsi_revert") {
    const enter = clampInt(params.enter ?? 30, 5, 95);
    const exit = clampInt(params.exit ?? 55, enter + 1, 100);
    const vals = rsi(closes, Math.max(2, Math.min(14, params.n ?? 14)));
    return closes.map((_, i) =>
      vals[i] === null
        ? "flat"
        : vals[i] < enter
          ? "long"
          : vals[i] >= exit
            ? "flat"
            : null,
    );
  }
  const fast = clampInt(params.fast ?? 10, 2, 60);
  const slow = clampInt(params.slow ?? 25, fast + 1, 120);
  const f = sma(closes, fast);
  const s = sma(closes, slow);
  return closes.map((_, i) => {
    if (f[i] === null || s[i] === null) return "flat";
    return f[i] > s[i] ? "long" : "flat";
  });
}

function neighborSpecs(strategy, params) {
  if (strategy === "rsi_revert") {
    const enter = params.enter ?? 30;
    const exit = params.exit ?? 55;
    return [
      { label: `enter=${enter - 1}`, params: { ...params, enter: enter - 1 } },
      { label: `enter=${enter + 1}`, params: { ...params, enter: enter + 1 } },
      { label: `exit=${exit - 1}`, params: { ...params, exit: exit - 1 } },
    ];
  }
  const fast = params.fast ?? 10;
  return [
    { label: `fast=${fast - 1}`, params: { ...params, fast: fast - 1 } },
    { label: `fast=${fast + 1}`, params: { ...params, fast: fast + 1 } },
  ];
}

function simulateTrades(sigs, closedBars, costBps, slipBps) {
  const trades = [];
  let holding = null;
  for (let i = 0; i < closedBars.length; i++) {
    const want = sigs[i];
    const fillBar = closedBars[i + 1];
    if (want === "long" && holding === null && fillBar) {
      holding = {
        entryOpenTime: fillBar.openTime,
        entryPrice: slip(fillBar.open, +slipBps),
        entryIdx: i + 1,
      };
    } else if (want === "flat" && holding !== null) {
      trades.push(
        closeTrade(
          holding,
          fillBar ? slip(fillBar.open, -slipBps) : closedBars[i].close,
          i,
          costBps,
        ),
      );
      holding = null;
    }
  }
  if (holding !== null)
    trades.push(
      closeTrade(
        holding,
        closedBars[closedBars.length - 1].close,
        closedBars.length - 1,
        costBps,
      ),
    );
  return trades;
}

function closeTrade(t, exitPrice, exitIdx, costBps) {
  const gross = (exitPrice - t.entryPrice) / t.entryPrice; // 1 unit return
  const roundTripCost = costBps * 2 * 1e-4; // commissions both sides; slippage already in fills
  const net = gross - roundTripCost;
  return {
    ...t,
    exitPrice,
    exitIdx,
    grossR: gross,
    costR: roundTripCost,
    netR: net,
  };
}

// cost/slippage applied in R units at the trade level (visible in audit trail)
function stats(trades, bars, isOos = false) {
  const netR = trades.reduce((a, t) => a + t.netR, 0);
  const grossR = trades.reduce((a, t) => a + t.grossR, 0);
  const wins = trades.filter((t) => t.netR > 0).length;
  const buyHold =
    bars.length > 1 ? (bars.at(-1).close - bars[0].close) / bars[0].close : 0;
  return {
    trades: trades.length,
    grossR,
    netR,
    winRate: trades.length ? wins / trades.length : 0,
    buyHoldR: buyHold,
    edgeVsBuyHold: netR - buyHold,
    sealed: isOos,
  };
}

function slip(px, bps) {
  return px * (1 + bps * 1e-4);
}

function clampInt(v, lo, hi) {
  const n = Math.max(lo, Math.min(hi, Math.round(Number(v) || lo)));
  return n;
}
