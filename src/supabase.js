// hometrade — Supabase backend client (zero-dep, REST only).
// Publishable key is safe to ship; the user's access token is forwarded on
// every PostgREST call so RLS (owner-scoped policies) does the authorization.

export const SUPABASE_URL =
  process.env.HOMETRADE_SUPABASE_URL ??
  "https://edbiogqsytkhbmohacqa.supabase.co";
export const SUPABASE_PUBLISHABLE =
  process.env.HOMETRADE_SUPABASE_PK ??
  "sb_publishable_Gvh65iTO3LECy7DSXdU4Cg_dsf3cUOA";

// the bearer is the user's; never embed a secret key in anything shippable.
export class SupabaseClient {
  constructor({
    url = SUPABASE_URL,
    publishable = SUPABASE_PUBLISHABLE,
    fetcher = null,
  } = {}) {
    this.url = String(url).replace(/\/$/, "");
    this.pk = publishable;
    this.fetch = fetcher ?? globalThis.fetch;
  }

  async #call(
    path,
    { method = "GET", body = null, token = null, prefer = null } = {},
  ) {
    const headers = {
      "content-type": "application/json",
      apikey: this.pk,
    };
    if (token) headers.authorization = `Bearer ${token}`;
    if (prefer) headers.prefer = prefer;
    const res = await this.fetch(`${this.url}${path}`, {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body),
    });
    let parsed = null;
    try {
      const text = await res.text();
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = {};
    }
    const ok = res.ok;
    const error = ok
      ? null
      : (parsed.msg ??
        parsed.message ??
        parsed.error_description ??
        `${res.status}`);
    return {
      ok,
      status: res.status,
      data: ok ? (parsed.data ?? parsed) : null,
      error,
      raw: parsed,
    };
  }

  async signUp(email, password, metadata = {}) {
    const r = await this.#call("/auth/v1/signup", {
      method: "POST",
      body: { email, password, data: metadata },
    });
    if (!r.ok) return { ok: false, error: r.error, needsConfirm: false };
    return {
      ok: true,
      session: r.data.access_token ? r.data : null,
      user: r.data.user ?? null,
      needsConfirm: !r.data.access_token,
    };
  }

  async signIn(email, password) {
    const r = await this.#call("/auth/v1/token?grant_type=password", {
      method: "POST",
      body: { email, password },
    });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, session: r.data, user: r.data.user };
  }

  async refresh(token) {
    const r = await this.#call("/auth/v1/token?grant_type=refresh_token", {
      method: "POST",
      body: { refresh_token: token },
    });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, session: r.data };
  }

  async logout(token) {
    return await this.#call("/auth/v1/logout", { method: "POST", token });
  }

  // PostgREST surface, always with the USER's bearer (RLS decides ownership).
  // Never use `this.#call` as a method on the returned handle — `this` there
  // would be the handle, not this client instance.
  db(table, token) {
    const path = `/rest/v1/${table}`;
    const client = {
      select: async (qs = "") => {
        const r = await this.#call(`${path}${qs}`, { token });
        if (!r.ok) throw new Error(`db ${table} select: ${r.error}`);
        return r.data ?? [];
      },
      insert: async (row) => {
        const r = await this.#call(path, {
          method: "POST",
          body: row,
          token,
          prefer: "return=representation",
        });
        if (!r.ok) throw new Error(`db ${table} insert: ${r.error}`);
        return Array.isArray(r.data) ? r.data[0] : r.data;
      },
      update: async (patch, qs = "") => {
        const r = await this.#call(`${path}${qs}`, {
          method: "PATCH",
          body: patch,
          token,
          prefer: "return=representation",
        });
        if (!r.ok) throw new Error(`db ${table} update: ${r.error}`);
        return r.data ?? [];
      },
      remove: async (qs = "") => {
        const r = await this.#call(`${path}${qs}`, { method: "DELETE", token });
        if (!r.ok) throw new Error(`db ${table} delete: ${r.error}`);
        return { ok: true, status: r.status };
      },
    };
    return client;
  }
}

// decode ONLY the payload for operational routing (expiry/uid); authorization
// itself is never trusted from this decode — Supabase validates on the wire.
export function decodeJwtExp(token) {
  try {
    const [, payloadRaw] = String(token).split(".");
    return JSON.parse(Buffer.from(payloadRaw, "base64url").toString("utf8"));
  } catch {
    return { exp: null, sub: null };
  }
}
