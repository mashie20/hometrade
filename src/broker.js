// hometrade — Alpaca broker adapter (real order lifecycle, paper default).
// Keys come from env or data/keys.json (gitignored). The secret key never
// reaches the browser; only the server-side client uses it.

const BASES = {
  paper: "https://paper-api.alpaca.markets",
  live: "https://api.alpaca.markets",
};

export function brokerBaseUrl(mode = "paper") {
  const base = BASES[String(mode ?? "paper").toLowerCase()];
  if (!base)
    throw new Error(
      `broker mode must be paper or live, got ${JSON.stringify(mode)}`,
    );
  return base;
}

export function buildAlpacaOrderPayload({
  symbol,
  side,
  qty,
  type = "market",
  limitPrice = null,
  timeInForce = "day",
  clientOrderId,
} = {}) {
  if (!/^buy$|^sell$/.test(String(side)))
    throw new Error(`bad side ${JSON.stringify(side)}`);
  const q = Number(qty);
  if (!Number.isFinite(q) || q <= 0)
    throw new Error(`bad qty ${JSON.stringify(qty)}`);
  const t = String(type).toLowerCase();
  if (t !== "market" && t !== "limit")
    throw new Error(`bad type ${JSON.stringify(type)}`);
  const payload = {
    symbol: String(symbol).toUpperCase(),
    qty: String(q),
    side: String(side),
    type: t,
    time_in_force: String(timeInForce ?? "day").toLowerCase(),
  };
  if (t === "limit") {
    const lp = Number(limitPrice);
    if (!Number.isFinite(lp) || lp <= 0)
      throw new Error("limit orders need a positive limit price");
    payload.limit_price = lp.toFixed(2);
  }
  if (!clientOrderId)
    throw new Error(
      "client_order_id required (our order id drives reconciliation)",
    );
  payload.client_order_id = String(clientOrderId);
  return payload;
}

export async function resolveAlpacaKeys({ env = process.env, readFile } = {}) {
  const k = env.HOMETRADE_ALPACA_KEY;
  const s = env.HOMETRADE_ALPACA_SECRET;
  if (k && s && /^[A-Z0-9]/i.test(k))
    return {
      key: k,
      secret: s,
      mode: String(env.HOMETRADE_BROKER_MODE ?? "paper").toLowerCase(),
    };
  if (typeof readFile !== "function") return null;
  try {
    const raw = await readFile();
    const a = JSON.parse(raw).alpaca;
    if (a?.key && a?.secret)
      return {
        key: a.key,
        secret: a.secret,
        mode: String(a.mode ?? "paper").toLowerCase(),
      };
    return null;
  } catch {
    return null;
  }
}

export function createAlpacaBroker({ keys, fetcher = globalThis.fetch } = {}) {
  if (!keys?.key || !keys?.secret) throw new Error("broker keys required");
  const base = `${brokerBaseUrl(keys.mode ?? "paper")}`;

  const call = async (path, { method = "GET", body = null } = {}) => {
    const headers = {
      "APCA-API-KEY-ID": keys.key,
      "APCA-API-SECRET-KEY": keys.secret,
      "content-type": "application/json",
    };
    const res = await fetcher(`${base}${path}`, {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body),
    });
    let text = null;
    try {
      text = res.text ? await res.text() : JSON.stringify(await res.json());
    } catch {
      text = null;
    }
    let parsed = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = {};
    }
    if (!res.ok) {
      const message =
        parsed.message ?? parsed.error?.message ?? `broker ${res.status}`;
      const err = new Error(message);
      err.status = res.status;
      err.brokerCode = parsed.code;
      throw err;
    }
    return parsed;
  };

  const mapOrder = (o) => ({
    externalId: o.id,
    clientId: o.client_order_id,
    symbol: o.symbol,
    side: o.side,
    qty: Number(o.qty ?? o.notional ?? 0),
    type: o.type,
    status: o.status,
    filledQty: Number(o.filled_qty ?? 0),
    filledAvgPrice:
      o.filled_avg_price === null || o.filled_avg_price === undefined
        ? null
        : Number(o.filled_avg_price),
    createdAt: o.created_at,
    raw: {
      limit_price: o.limit_price ?? null,
      submitted_at: o.submitted_at ?? null,
    },
  });

  return {
    mode: keys.mode ?? "paper",
    async getAccount() {
      return await call("/v2/account");
    },
    async listPositions() {
      return await call("/v2/positions");
    },
    async listOrders({ status = "open", limit = 50 } = {}) {
      const qs = new URLSearchParams({ status, limit: String(limit) });
      const rows = await call(`/v2/orders?${qs.toString()}`);
      return rows.map(mapOrder);
    },
    async placeOrder({ id, symbol, side, qty, type, limitPrice, timeInForce }) {
      const payload = buildAlpacaOrderPayload({
        symbol,
        side,
        qty,
        type,
        limitPrice,
        timeInForce,
        clientOrderId: id,
      });
      const o = await call("/v2/orders", { method: "POST", body: payload });
      return mapOrder(o);
    },
    async cancelOrder(externalId) {
      return await call(`/v2/orders/${externalId}`, { method: "DELETE" });
    },
  };
}
