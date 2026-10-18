// hometrade — local-first stores (plain files, atomic writes; no external DB)

import {
  mkdirSync,
  writeFileSync,
  renameSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";

const atomicWrite = (file, data) => {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
};
export { atomicWrite };

export function barKeyStr(key) {
  return `${key.exchange}/${key.ticker}/${key.interval}`;
}

// Append-only JSONL bar cache with in-memory sorted merge. ":memory:" keeps state only in RAM.
export class BarStore {
  constructor(rootDir) {
    this.root = rootDir === ":memory:" ? null : rootDir;
    this.mem = new Map();
  }
  #file(key) {
    return join(
      this.root,
      "bars",
      key.exchange,
      key.ticker,
      `${key.interval}.jsonl`,
    );
  }
  #loadFromDisk(key) {
    if (!this.root) return [];
    const f = this.#file(key);
    if (!existsSync(f)) return [];
    const out = [];
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line.trim()) continue;
      out.push(JSON.parse(line));
    }
    return out;
  }
  merge(key, candles) {
    const k = barKeyStr(key);
    const have = this.mem.get(k) ?? this.#loadFromDisk(key);
    const map = new Map();
    for (const c of [...have, ...candles]) map.set(c.openTime, c); // dedupe, later wins
    const merged = [...map.values()].sort((a, b) => a.openTime - b.openTime);
    this.mem.set(k, merged);
    return merged;
  }
  load(key) {
    return this.merge(key, []);
  }
  flush(key) {
    if (!this.root) return;
    const cands = this.mem.get(barKeyStr(key)) ?? this.#loadFromDisk(key);
    if (cands.length) {
      atomicWrite(
        this.#file(key),
        cands.map((c) => JSON.stringify(c)).join("\n") + "\n",
      );
    }
  }
  flushAll() {
    if (this.root) rmSync(join(this.root, ".no-op"), { force: true });
  }
}

export class JsonRepo {
  constructor(file, fallback = []) {
    this.file = file;
    this.cache = null;
    this.fallback = fallback;
  }
  read() {
    if (this.cache) return this.cache;
    if (existsSync(this.file)) {
      try {
        this.cache = JSON.parse(readFileSync(this.file, "utf8"));
      } catch {
        this.cache = [...this.fallback];
      }
    } else {
      this.cache = [...this.fallback];
    }
    return this.cache;
  }
  write(list) {
    this.cache = list;
    atomicWrite(this.file, JSON.stringify(list, null, 2) + "\n");
    return list;
  }
}
