// hometrade — watchlists & annotations (agent-accessible local state)

import { uid } from "./util.js";

export class AnnotationBook {
  constructor(repo) {
    this.repo = repo;
    this._items = [];
  }
  async _sync() {
    this._items = await this.repo.read();
    return this._items;
  }
  async add({ symbol, interval, text, ts }) {
    await this._sync();
    const item = {
      id: uid(),
      symbol,
      interval,
      text: String(text).slice(0, 500),
      ts: Number(ts) || Date.now(),
    };
    await this.repo.write([...this._items, item]);
    await this._sync();
    return item;
  }
  async query({ symbol, interval } = {}) {
    await this._sync();
    let list = this._items;
    if (symbol) list = list.filter((a) => a.symbol === symbol);
    if (interval) list = list.filter((a) => a.interval === interval);
    return list.sort((a, b) => b.ts - a.ts);
  }
}

export class Watchlists {
  constructor(repo) {
    this.repo = repo;
    this._lists = [];
  }
  async _sync() {
    this._lists = await this.repo.read();
    return this._lists;
  }
  async upsert(name, symbols) {
    await this._sync();
    const clean = [
      ...new Set(
        String(symbols)
          .split(",")
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean),
      ),
    ];
    const key = String(name).toLowerCase();
    const next = [
      ...this._lists.filter((l) => l.name !== key),
      { name: key, symbols: clean },
    ];
    await this.repo.write(next);
    await this._sync();
    return next.find((l) => l.name === key);
  }
  all() {
    return this._lists;
  }
  get(name) {
    return (
      this._lists.find((l) => l.name === String(name).toLowerCase()) ?? null
    );
  }
}
