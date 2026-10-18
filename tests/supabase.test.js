// Supabase REST client contract: auth + PostgREST with user bearer tokens.
// Tests written BEFORE implementation; network always faked (pure modules).
import { test } from "node:test";
import assert from "node:assert/strict";

const URL = "https://unit.supabase.test";
const PK = "sb_publishable_unit_test";

function fakeFetch(calls) {
  return async (url, opts = {}) => {
    calls.push({
      url: String(url),
      method: opts.method ?? "GET",
      body: opts.body,
      headers: opts.headers,
    });
    const respond = {
      signup: {
        status: 200,
        json: {
          access_token: "at-1",
          refresh_token: "rt-1",
          user: { id: "u1", email: "a@b.c" },
        },
      },
      "token?grant_type=password": {
        status: 200,
        json: {
          access_token: "at-2",
          refresh_token: "rt-2",
          user: { id: "u1", email: "a@b.c" },
        },
      },
      "token?grant_type=refresh_token": {
        status: 200,
        json: {
          access_token: "at-3",
          refresh_token: "rt-3",
          user: { id: "u1" },
        },
      },
      logout: { status: 204, json: {} },
      user: { status: 200, json: { id: "u1", email: "a@b.c" } },
    };
    for (const [needle, shape] of Object.entries(respond)) {
      if (String(url).includes(needle)) {
        return {
          ok: shape.status < 400,
          status: shape.status,
          json: async () => shape.json,
          text: async () => JSON.stringify(shape.json),
        };
      }
    }
    return {
      ok: false,
      status: 404,
      json: async () => ({}),
      text: async () => "{}",
    };
  };
}

test("signup + signin send publishable key and return session", async () => {
  const calls = [];
  const { SupabaseClient } = await import("../src/supabase.js");
  const c = new SupabaseClient({
    url: URL,
    publishable: PK,
    fetcher: fakeFetch(calls),
  });
  const up = await c.signUp("a@b.c", "pw-1", { name: "Chief" });
  assert.equal(up.session?.access_token, "at-1");
  assert.match(calls[0].url, /\/auth\/v1\/signup$/);
  assert.equal(calls[0].headers.apikey, PK);
  const in1 = await c.signIn("a@b.c", "pw-1");
  assert.equal(in1.session?.access_token, "at-2");
  assert.match(calls[1].url, /token\?grant_type=password/);
});

test("postgrest CRUD: bearer token forwarded, returns representation, filters encoded", async () => {
  const calls = [];
  const { SupabaseClient } = await import("../src/supabase.js");
  const c = new SupabaseClient({
    url: URL,
    publishable: PK,
    fetcher: fakeFetch(calls),
  });
  calls.length = 0;
  const rows = [
    {
      id: "r1",
      user_id: "u1",
      symbol: "YAHOO:AAPL",
      side: "buy",
      status: "new",
    },
  ];
  const fetchable = async (url, opts = {}) => {
    calls.push({
      url: String(url),
      method: opts.method,
      body: opts.body,
      headers: opts.headers,
    });
    return {
      ok: true,
      status: 200,
      json: async () => (opts.method === "GET" ? rows : rows),
      text: async () => JSON.stringify(rows),
    };
  };
  const c2 = new SupabaseClient({
    url: URL,
    publishable: PK,
    fetcher: fetchable,
  });
  const got = await c2
    .db("orders", "at-2")
    .select("?user_id=eq.u1&order=created_at.desc");
  assert.deepEqual(got, rows);
  assert.equal(
    calls[0].headers.authorization,
    "Bearer at-2",
    "user bearer forwarded",
  );
  assert.equal(calls[0].headers.apikey, PK);
  const ins = await c2.db("orders", "at-2").insert({
    symbol: "YAHOO:AAPL",
    side: "buy",
    qty: 1,
    order_type: "market",
  });
  assert.match(String(ins.symbol), /AAPL/);
  assert.equal(calls[1].method, "POST");
  assert.equal(calls[1].headers.prefer, "return=representation");
  const upd = await c2
    .db("orders", "at-2")
    .update({ status: "filled" }, "?id=eq.r1");
  assert.equal(calls[2].method, "PATCH");
  const del = await c2.db("orders", "at-2").remove("?id=eq.r1");
  assert.equal(del.ok, true);
  assert.equal(calls[3].method, "DELETE");
});

test("jwt expiry decode: exp read from payload, no signature needed for routing", async () => {
  const { decodeJwtExp } = await import("../src/supabase.js");
  const payload = Buffer.from(
    JSON.stringify({ exp: 1792340000, sub: "u1" }),
  ).toString("base64url");
  const head = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const token = `${head}.${payload}.sig`;
  const dec = decodeJwtExp(token);
  assert.equal(dec.exp, 1792340000);
  assert.equal(dec.sub, "u1");
  assert.equal(decodeJwtExp("garbage").exp, null);
});

test("errors surface auth codes (invalid credentials, 429 rate limit)", async () => {
  const { SupabaseClient } = await import("../src/supabase.js");
  const c = new SupabaseClient({
    url: URL,
    publishable: PK,
    fetcher: async () => ({
      ok: false,
      status: 429,
      json: async () => ({
        code: 429,
        error_code: "over_request_rate_limit",
        msg: "slow down",
      }),
      text: async () => "{}",
    }),
  });
  const res = await c.signIn("a@b.c", "pw");
  assert.equal(res.ok, false);
  assert.match(res.error, /slow down|429|rate/i);
});
