// hometrade — alerts engine (fires once on closed-candle cross; explicit re-arm only)

const KINDS = new Set(["above", "below"]);

export class AlertsEngine {
  constructor(repo, { toast } = {}) {
    this.repo = repo; // async read() -> [rule]; async write(list)
    this.toastHost = toast || null;
    this._rules = [];
  }
  async _sync() {
    this._rules = await this.repo.read();
    return this._rules;
  }

  async add({ symbol, interval, kind, price }) {
    await this._sync();
    if (!KINDS.has(kind))
      throw new Error(`kind must be one of ${[...KINDS].join("|")}`);
    const num = Number(price);
    if (!Number.isFinite(num) || num <= 0)
      throw new Error("price must be a positive number");
    const rule = {
      id: cryptoRandom(),
      symbol,
      interval,
      kind,
      price: num,
      armed: true,
      firedCount: 0,
      ts: Date.now(),
    };
    await this.repo.write([...this._rules, rule]);
    await this._sync();
    return rule;
  }
  list(symbol) {
    const all = this._rules;
    return symbol ? all.filter((r) => r.symbol === symbol) : all;
  }
  async delete(id) {
    await this._sync();
    await this.repo.write(this._rules.filter((r) => r.id !== id));
    await this._sync();
  }
  async rearm(id) {
    await this._sync();
    await this.repo.write(
      this._rules.map((r) => (r.id === id ? { ...r, armed: true } : r)),
    );
    await this._sync();
  }

  // evaluate ONE closed candle for a symbol; fires cross rules once (armed -> fired)
  async evaluate(symbolKey, candle) {
    await this._sync();
    const close = candle.close;
    let dirty = false;
    for (const r of this._rules) {
      if (!r.armed || r.symbol !== symbolKey) continue;
      const hit = r.kind === "above" ? close >= r.price : close <= r.price;
      if (hit) {
        r.armed = false;
        r.firedCount += 1;
        r.lastFired = { ts: Date.now(), close };
        dirty = true;
        this.toastHost?.({
          title: `Alert: ${r.symbol} ${r.kind} ${r.price}`,
          body: `close ${close}`,
          id: r.id,
        });
      }
    }
    if (dirty) {
      await this.repo.write(this._rules);
      await this._sync();
    }
    return dirty;
  }
}

function cryptoRandom() {
  const bytes = new Uint8Array(8);
  (
    globalThis.crypto ??
    globalThis.__cfCrypto ?? { getRandomValues: () => bytes }
  ).getRandomValues?.(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
