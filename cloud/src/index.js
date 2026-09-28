// Pokédex Pack Draft cloud saves.
// The wdcardshop.com game page (templates/page.pokedex.liquid) signs "<customerId>.<unixTime>" with PD_SECRET via
// Liquid's hmac_sha256 and hands that token to the game iframe. This Worker checks the token and keeps one save per
// Shopify customer in D1, guarded by a revision number so one device can't silently overwrite another's newer save.
const ORIGINS = ["https://dustaris.github.io", "http://localhost:8766"];
const TOKEN_MAX_AGE = 7 * 86400; // seconds; the page mints a fresh token on every load
const MAX_BYTES = 256 * 1024;

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ORIGINS.includes(origin) ? origin : ORIGINS[0],
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    };
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const path = new URL(req.url).pathname;
    if (req.method !== "POST" || (path !== "/load" && path !== "/save")) return json({ error: "not_found" }, 404);

    const text = await req.text();
    if (text.length > MAX_BYTES) return json({ error: "too_large" }, 413);
    let body;
    try { body = JSON.parse(text); } catch { return json({ error: "bad_json" }, 400); }
    const cid = await verify(body.token, env.PD_SECRET);
    if (!cid) return json({ error: "unauthorized" }, 401);

    const current = () => env.DB.prepare("SELECT rev, updated, data FROM saves WHERE cid = ?").bind(cid).first();
    if (path === "/load") {
      const row = await current();
      return json(row ? { rev: row.rev, updatedAt: row.updated, save: JSON.parse(row.data) } : { rev: 0, updatedAt: null, save: null });
    }

    const { baseRev, data } = body;
    if (!Number.isInteger(baseRev) || baseRev < 0 || !data || typeof data !== "object" || data.v !== 2) return json({ error: "bad_request" }, 400);
    const now = new Date().toISOString(), payload = JSON.stringify(data);
    const res = baseRev === 0
      ? await env.DB.prepare("INSERT INTO saves (cid, rev, updated, data) VALUES (?, 1, ?, ?) ON CONFLICT(cid) DO NOTHING").bind(cid, now, payload).run()
      : await env.DB.prepare("UPDATE saves SET rev = rev + 1, updated = ?, data = ? WHERE cid = ? AND rev = ?").bind(now, payload, cid, baseRev).run();
    if (res.meta.changes === 1) return json({ rev: baseRev + 1, updatedAt: now });
    const row = await current(); // another device saved first
    return json({ error: "conflict", rev: row ? row.rev : 0, updatedAt: row ? row.updated : null, save: row ? JSON.parse(row.data) : null }, 409);
  },
};

async function verify(token, secret) {
  if (typeof token !== "string" || !secret) return null;
  const m = /^(\d{1,20})\.(\d{9,11})\.([0-9a-f]{64})$/.exec(token);
  if (!m) return null;
  const [, cid, ts, sig] = m;
  const age = Date.now() / 1000 - Number(ts);
  if (age > TOKEN_MAX_AGE || age < -300) return null;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${cid}.${ts}`)));
  const want = enc.encode([...mac].map(b => b.toString(16).padStart(2, "0")).join(""));
  const got = enc.encode(sig);
  return want.length === got.length && crypto.subtle.timingSafeEqual(want, got) ? cid : null;
}
