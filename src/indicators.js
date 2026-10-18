// hometrade — public-domain indicator math (original implementation)

export function sma(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

export function ema(values, n) {
  const out = new Array(values.length).fill(null);
  const alpha = 2 / (n + 1);
  let seedSum = 0,
    seedCount = 0,
    prev = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null || v === undefined) continue;
    if (prev === null) {
      seedSum += v;
      seedCount++;
      if (seedCount === n) {
        prev = seedSum / n;
        out[i] = prev;
      }
    } else {
      prev = prev + alpha * (v - prev);
      out[i] = prev;
    }
  }
  return out;
}

// Wilder's RSI: seed averages over the first n changes, then smoothed recursion.
export function rsi(values, n = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length <= n) return out;
  let avgGain = 0,
    avgLoss = 0;
  for (let i = 1; i <= n; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0) avgGain += d;
    else avgLoss -= d;
  }
  avgGain /= n;
  avgLoss /= n;
  const emit = (i) => {
    if (avgGain === 0 && avgLoss === 0) {
      out[i] = 50;
      return;
    }
    if (avgLoss === 0) {
      out[i] = 100;
      return;
    }
    if (avgGain === 0) {
      out[i] = 0;
      return;
    }
    const rs = avgGain / avgLoss;
    out[i] = 100 - 100 / (1 + rs);
  };
  emit(n);
  for (let i = n + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    avgGain = (avgGain * (n - 1) + (d > 0 ? d : 0)) / n;
    avgLoss = (avgLoss * (n - 1) + (d < 0 ? -d : 0)) / n;
    emit(i);
  }
  return out;
}

export function macd(values, fast = 12, slow = 26, sig = 9) {
  const ef = ema(values, fast);
  const es = ema(values, slow);
  const line = values.map((_, i) =>
    ef[i] === null || es[i] === null ? null : ef[i] - es[i],
  );
  const signal = ema(line, sig);
  const hist = line.map((v, i) =>
    v === null || signal[i] === null ? null : v - signal[i],
  );
  return { macd: line, signal, hist };
}

export function bollinger(values, n = 20, k = 2) {
  const basis = sma(values, n);
  const upper = new Array(values.length).fill(null);
  const lower = new Array(values.length).fill(null);
  for (let i = n - 1; i < values.length; i++) {
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += values[j];
    const mean = s / n;
    let v = 0;
    for (let j = i - n + 1; j <= i; j++) {
      const d = values[j] - mean;
      v += d * d;
    }
    const std = Math.sqrt(v / n); // population std
    upper[i] = basis[i] + k * std;
    lower[i] = basis[i] - k * std;
  }
  return { basis, upper, lower };
}
