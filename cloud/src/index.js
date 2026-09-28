// Pokédex Pack Draft cloud saves.
// The wdcardshop.com game page (templates/page.pokedex.liquid) signs "<customerId>.<unixTime>" with PD_SECRET via
// Liquid's hmac_sha256 and hands that token to the game iframe. This Worker checks the token and keeps one save per
// Shopify customer in D1, guarded by a revision number so one device can't silently overwrite another's newer save.
import "./shim.js";
import "../../dex.js";
import "../../evo.js";
import "../../engine.js";

const E = globalThis.ENGINE;
const ORIGINS = ["https://dustaris.github.io", "http://localhost:8766"];
const CHAL_TRIES = 3;
const BLOCK = /(fuck|shit|bitch|cunt|nigg|fag|dick|cock|pussy|slut|whore|rape|nazi|hitler|porn|sex)/i;
// Reads number-for-letter swaps (sh1t, 4ss) before checking the blocklist
const LEET = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t", 8: "b", 9: "g" };
const plain = n => n.toLowerCase().replace(/[0-9]/g, d => LEET[d] || "").replace(/[^a-z]/g, "");
const cleanName = n => (typeof n === "string" && /^[A-Za-z0-9][A-Za-z0-9 ._-]{1,15}$/.test(n.trim()) && !BLOCK.test(plain(n))) ? n.trim() : null;
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
    if (req.method !== "POST" || !["/load", "/save", "/challenge", "/leaderboard", "/name"].includes(path)) return json({ error: "not_found" }, 404);

    const text = await req.text();
    if (text.length > MAX_BYTES) return json({ error: "too_large" }, 413);
    let body;
    try { body = JSON.parse(text); } catch { return json({ error: "bad_json" }, 400); }
    const cid = await verify(body.token, env.PD_SECRET);
    if (path === "/leaderboard") return leaderboard(env, cid, json); // guests may look; cid is null for them
    if (!cid) return json({ error: "unauthorized" }, 401);
    if (path === "/challenge") return rankedTry(env, cid, body, json);
    if (path === "/name") {
      const name = cleanName(body.name);
      if (!name) return json({ error: "name_rejected" }, 400);
      await env.DB.prepare("UPDATE scores SET name = ? WHERE cid = ? AND day = ?").bind(name, cid, E.challengeDay()).run();
      return json({ name });
    }

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

// Runs a ranked Daily Challenge try on the server: the lineup must follow today's rule and be in the player's
// cloud-saved Pokédex, tries are capped here, and the battle is seeded so the game can replay it exactly.
async function rankedTry(env, cid, body, json) {
  const day = E.challengeDay(), ch = E.dailyChallenge(day);
  const picks = Array.isArray(body.picks) ? body.picks : [];
  if (picks.length > 6 || new Set(picks).size !== picks.length || !picks.every(n => Number.isInteger(n) && n >= 1 && n <= 1025 && ch.rule.ok(E.byNum(n)))) return json({ error: "bad_lineup" }, 400);
  if (picks.length) {
    const saved = await env.DB.prepare("SELECT data FROM saves WHERE cid = ?").bind(cid).first();
    const dex = saved ? JSON.parse(saved.data).dex || {} : {};
    if (!picks.every(n => dex[n])) return json({ error: "not_owned" }, 400);
  }
  const row = await env.DB.prepare("SELECT name, tries, best, stars, at FROM scores WHERE day = ? AND cid = ?").bind(day, cid).first();
  const tryNo = row ? row.tries : 0;
  if (tryNo >= CHAL_TRIES) return json({ error: "no_tries", day, tries: tryNo, best: row.best }, 409);
  const seed = E.challengeSeed(day, cid, tryNo);
  const res = E.battle(E.challengeSide(ch, picks), ch.team, E.mulberry32(seed), false);
  const score = E.challengeScore(res), stars = E.challengeTier(res.win, res.kos, score);
  const name = cleanName(body.name) || (row && row.name) || `Trainer ${cid.slice(-4)}`;
  const now = new Date().toISOString(), better = !row || score > row.best;
  await env.DB.prepare(`INSERT INTO scores (day, cid, name, tries, best, stars, at) VALUES (?, ?, ?, 1, ?, ?, ?)
    ON CONFLICT(day, cid) DO UPDATE SET name = excluded.name, tries = tries + 1,
      best = CASE WHEN excluded.best > best THEN excluded.best ELSE best END,
      stars = CASE WHEN excluded.best > best THEN excluded.stars ELSE stars END,
      at = CASE WHEN excluded.best > best THEN excluded.at ELSE at END`).bind(day, cid, name, score, stars, now).run();
  return json({ day, try: tryNo, seed, score, win: res.win, kos: res.kos, stars, tries: tryNo + 1, best: better ? score : row.best, name });
}

async function leaderboard(env, cid, json) {
  const day = E.challengeDay();
  const top = await env.DB.prepare("SELECT cid, name, best, stars FROM scores WHERE day = ? ORDER BY best DESC, at ASC LIMIT 20").bind(day).all();
  const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM scores WHERE day = ?").bind(day).first();
  let me = null;
  if (cid) {
    const mine = await env.DB.prepare("SELECT name, best, stars, at, tries FROM scores WHERE day = ? AND cid = ?").bind(day, cid).first();
    if (mine) {
      const ahead = await env.DB.prepare("SELECT COUNT(*) AS n FROM scores WHERE day = ? AND (best > ? OR (best = ? AND at < ?))").bind(day, mine.best, mine.best, mine.at).first();
      me = { rank: ahead.n + 1, name: mine.name, best: mine.best, stars: mine.stars, tries: mine.tries };
    }
  }
  return json({ day, players: total.n, top: top.results.map((r, i) => ({ rank: i + 1, name: r.name, best: r.best, stars: r.stars, me: r.cid === cid })), me });
}

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
