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
const SHOP = "1marss-2m";
const STORE = "https://wdcardshop.com";

// WD Card Shop rewards. Codes are single-use, locked to the winner's customer account, and expire.
const REWARDS = {
  monthly: [{ place: 1, pct: 20 }, { place: 2, pct: 15 }, { place: 3, pct: 10 }],
  milestones: [{ key: "champ9", champs: 9, pct: 10, label: "Beat all 9 Champions" }],
  minSubtotal: 25, maxOff: 50, days: 30, // every code: $25+ order, never more than $50 off (enforced by the capped-reward function)
  monthlyMinDays: 10,        // ranked days played that month
  monthlyMinAccountDays: 7,  // account first seen at least this many days before the month ends
  milestoneMinAccountDays: 2,
};
const now = () => new Date().toISOString();
const daysSince = iso => (Date.now() - Date.parse(iso)) / 864e5;
const MAX_BYTES = 256 * 1024;

export default {
  // The 1st of each month just after midnight Pacific: queue last month's top 3 for review
  async scheduled(event, env, ctx) { ctx.waitUntil(monthlyPrizes(env)); },
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
    if (req.method === "POST" && path.startsWith("/admin/")) return admin(req, env, path);
    if (req.method !== "POST" || !["/load", "/save", "/challenge", "/leaderboard", "/name", "/rewards", "/eligibility", "/puzzle"].includes(path)) return json({ error: "not_found" }, 404);

    const text = await req.text();
    if (text.length > MAX_BYTES) return json({ error: "too_large" }, 413);
    let body;
    try { body = JSON.parse(text); } catch { return json({ error: "bad_json" }, 400); }
    const cid = await verify(body.token, env.PD_SECRET);
    if (path === "/leaderboard") return leaderboard(env, cid, json); // guests may look; cid is null for them
    if (path === "/puzzle") return puzzle(env, cid, body, json);      // today's puzzle (boss order hidden) or a past day's in full
    if (!cid) return json({ error: "unauthorized" }, 401);
    await env.DB.prepare("INSERT OR IGNORE INTO players (cid, first_seen) VALUES (?, ?)").bind(cid, now()).run();
    if (path === "/challenge") return rankedTry(env, cid, body, json);
    if (path === "/rewards") return json(await rewardsFor(env, cid));
    if (path === "/eligibility") {
      if (body.over18 !== true || body.us !== true || body.rules !== true) return json({ error: "must_agree" }, 400);
      await env.DB.prepare("UPDATE players SET eligible_at = COALESCE(eligible_at, ?) WHERE cid = ?").bind(now(), cid).run();
      return json(await rewardsFor(env, cid));
    }
    if (path === "/name") {
      const name = cleanName(body.name);
      if (!name) return json({ error: "name_rejected" }, 400);
      const wk = E.challengeWeek(E.challengeDay()); // rename across this week so the weekly board shows the new name
      await env.DB.prepare("UPDATE scores SET name = ? WHERE cid = ? AND day BETWEEN ? AND ?").bind(name, cid, wk.start, wk.end).run();
      return json({ name });
    }

    const current = () => env.DB.prepare("SELECT rev, updated, data FROM saves WHERE cid = ?").bind(cid).first();
    if (path === "/load") {
      const row = await current();
      return json(row ? { rev: row.rev, updatedAt: row.updated, save: JSON.parse(row.data) } : { rev: 0, updatedAt: null, save: null });
    }

    const { baseRev, data } = body;
    if (!Number.isInteger(baseRev) || baseRev < 0 || !data || typeof data !== "object" || data.v !== 2) return json({ error: "bad_request" }, 400);
    const at = now(), payload = JSON.stringify(data);
    const res = baseRev === 0
      ? await env.DB.prepare("INSERT INTO saves (cid, rev, updated, data) VALUES (?, 1, ?, ?) ON CONFLICT(cid) DO NOTHING").bind(cid, at, payload).run()
      : await env.DB.prepare("UPDATE saves SET rev = rev + 1, updated = ?, data = ? WHERE cid = ? AND rev = ?").bind(at, payload, cid, baseRev).run();
    if (res.meta.changes === 1) { await audit(env, cid, baseRev + 1, data); return json({ rev: baseRev + 1, updatedAt: at }); }
    const row = await current(); // another device saved first
    return json({ error: "conflict", rev: row ? row.rev : 0, updatedAt: row ? row.updated : null, save: row ? JSON.parse(row.data) : null }, 409);
  },
};

// ---------- Daily Puzzle ----------
const puzzleRow = (env, day) => env.DB.prepare("SELECT * FROM puzzles WHERE day = ?").bind(day).first();
function publicPuzzle(p, reveal) {
  const out = { day: p.day, n: p.n, label: p.label, boss: { name: p.boss_name, title: p.boss_title, region: p.boss_region },
    roster: JSON.parse(p.roster), bossSet: JSON.parse(p.boss_set) };
  if (reveal) Object.assign(out, { bossOrder: JSON.parse(p.boss_order), bestRaw: p.best_raw, bestCount: p.best_count });
  return out;
}
// Today's puzzle for everyone (without the boss order). Signed-in players also get their tries so far, and once they
// have battled, the boss order (their battle already showed it). Past days come back in full for practice.
async function puzzle(env, cid, body, json) {
  const today = E.challengeDay();
  const day = typeof body.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.day) && body.day < today ? body.day : today;
  const p = await puzzleRow(env, day);
  if (!p) return json({ error: "no_puzzle", day }, 404);
  if (day < today) return json({ ...publicPuzzle(p, true), past: true });
  const tries = cid ? (await env.DB.prepare("SELECT try, lineup, raw, score FROM attempts WHERE day = ? AND cid = ? ORDER BY try").bind(day, cid).all()).results : [];
  return json({ ...publicPuzzle(p, tries.length > 0), past: false,
    tries: tries.map(t => ({ try: t.try, lineup: JSON.parse(t.lineup), raw: t.raw, score: t.score })) });
}

// A ranked try: must be an ordering of today's 6; scored against the secret boss order; 3 per day
async function rankedTry(env, cid, body, json) {
  const day = E.challengeDay(), p = await puzzleRow(env, day);
  if (!p) return json({ error: "no_puzzle", day }, 404);
  const roster = JSON.parse(p.roster), order = Array.isArray(body.order) ? body.order : [];
  if (order.length !== 6 || new Set(order).size !== 6 || !order.every(n => roster.includes(n))) return json({ error: "bad_order" }, 400);
  const row = await env.DB.prepare("SELECT name, tries, best FROM scores WHERE day = ? AND cid = ?").bind(day, cid).first();
  const tryNo = row ? row.tries : 0;
  if (tryNo >= CHAL_TRIES) return json({ error: "no_tries", day, tries: tryNo, best: row.best }, 409);
  const bossOrder = JSON.parse(p.boss_order);
  const res = E.puzzleBattle(order, bossOrder, false), raw = E.challengeScore(res);
  const { perfect, pct, score } = E.puzzleScore(raw, p.best_raw, tryNo);
  const stars = E.puzzleStars(res.win, perfect, score);
  const name = cleanName(body.name) || (row && row.name) || `Trainer ${cid.slice(-4)}`;
  const at = now(), better = !row || score > row.best;
  await env.DB.prepare("INSERT INTO attempts (day, cid, try, lineup, raw, score, at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(day, cid, tryNo, JSON.stringify(order), raw, score, at).run();
  await env.DB.prepare(`INSERT INTO scores (day, cid, name, tries, best, stars, at) VALUES (?, ?, ?, 1, ?, ?, ?)
    ON CONFLICT(day, cid) DO UPDATE SET name = excluded.name, tries = tries + 1,
      best = CASE WHEN excluded.best > best THEN excluded.best ELSE best END,
      stars = CASE WHEN excluded.best > best OR (excluded.best = best AND excluded.stars > stars) THEN excluded.stars ELSE stars END,
      at = CASE WHEN excluded.best > best THEN excluded.at ELSE at END`).bind(day, cid, name, score, stars, at).run();
  return json({ day, try: tryNo, raw, pct, perfect, score, stars, win: res.win, kos: res.kos, bossOrder, tries: tryNo + 1, best: better ? score : row.best, name });
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
  return json({ day, players: total.n, top: top.results.map((r, i) => ({ rank: i + 1, name: r.name, best: r.best, stars: r.stars, me: r.cid === cid })), me,
    week: await weekBoard(env, cid, day), month: await periodBoard(env, cid, E.challengeMonth(day)) });
}

// Period boards: each player's best daily score, added up over the week or month (Pacific). Ties: more stars, then earlier.
async function weekBoard(env, cid, day) { return periodBoard(env, cid, E.challengeWeek(day)); }
async function periodBoard(env, cid, wk) {
  const W = `WITH w AS (SELECT cid, SUM(best) AS total, SUM(stars) AS stars, COUNT(*) AS days, MAX(at) AS last_at,
      (SELECT name FROM scores s2 WHERE s2.cid = s.cid AND s2.day BETWEEN ?1 AND ?2 ORDER BY s2.day DESC LIMIT 1) AS name
    FROM scores s WHERE day BETWEEN ?1 AND ?2 GROUP BY cid)`;
  const top = await env.DB.prepare(`${W} SELECT cid, name, total, stars, days FROM w ORDER BY total DESC, stars DESC, last_at ASC LIMIT 20`).bind(wk.start, wk.end).all();
  const count = await env.DB.prepare(`${W} SELECT COUNT(*) AS n FROM w`).bind(wk.start, wk.end).first();
  let me = null;
  if (cid) {
    const mine = await env.DB.prepare(`${W} SELECT name, total, stars, days, last_at FROM w WHERE cid = ?3`).bind(wk.start, wk.end, cid).first();
    if (mine) {
      const ahead = await env.DB.prepare(`${W} SELECT COUNT(*) AS n FROM w WHERE total > ?3 OR (total = ?3 AND stars > ?4) OR (total = ?3 AND stars = ?4 AND last_at < ?5)`).bind(wk.start, wk.end, mine.total, mine.stars, mine.last_at).first();
      me = { rank: ahead.n + 1, name: mine.name, total: mine.total, stars: mine.stars, days: mine.days };
    }
  }
  return { start: wk.start, end: wk.end, dayOfWeek: wk.dayOfWeek, dayOfMonth: wk.dayOfMonth, days: wk.days, players: count.n,
    top: top.results.map((r, i) => ({ rank: i + 1, name: r.name, total: r.total, stars: r.stars, days: r.days, me: r.cid === cid })), me };
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

async function hmacBytes(secret, msg) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}
async function secretSeed(env, msg) { const b = await hmacBytes(env.PD_SECRET, msg); return ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0; }

// ---------- Anti-cheat: plausibility checks on every accepted save ----------
function metrics(d) {
  const dex = Object.keys(d.dex || {}).map(Number);
  const box = Object.values(d.box || {});
  return { dex: dex.length, packs: d.packs || 0, bag: (d.bag || []).length, beaten: d.beaten || 0, rare: d.rare || 0,
    legends: dex.filter(n => E.byNum(n) && E.byNum(n).tier === 3).length,
    // copies spent on card grades across the box (each grade costs GRADE_COST copies); stored in audit.max_lvl
    copies: box.reduce((sum, b) => sum + E.GRADE_COST.slice(0, b.grade || 0).reduce((a, c) => a + c, 0) + (b.dupes || 0), 0) };
}
async function audit(env, cid, rev, data) {
  const m = metrics(data);
  const prev = await env.DB.prepare("SELECT dex_n, packs FROM audit WHERE cid = ? ORDER BY id DESC LIMIT 1").bind(cid).first();
  const p = await env.DB.prepare("SELECT first_seen FROM players WHERE cid = ?").bind(cid).first();
  const days = Math.floor(daysSince(p ? p.first_seen : now())) + 1;
  const flags = [];
  if (m.dex > 2 + m.packs * 1.8) flags.push("dex");                                                // more entries than packs + evolutions explain
  if (prev && m.dex - prev.dex_n > (m.packs - prev.packs) + 6) flags.push("dexjump");               // many entries appeared at once
  if (m.packs + m.bag > 15 + days * 8 + m.beaten * 5) flags.push("packs");                          // more packs than the calendar allows
  if (m.legends > 3 + m.packs * 0.15) flags.push("legend");                                          // far luckier than the pull rates
  if (m.copies > m.packs + 30 + days * 5) flags.push("grade");                                         // more upgrades than packs + Rare Candy explain
  await env.DB.prepare("INSERT INTO audit (cid, at, rev, dex_n, packs, bag_n, beaten, rare, legends, max_lvl, flags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(cid, now(), rev, m.dex, m.packs, m.bag, m.beaten, m.rare, m.legends, m.copies, flags.join(",") || null).run();
  if (flags.length) await env.DB.prepare("UPDATE players SET open_flags = open_flags + 1 WHERE cid = ?").bind(cid).run();
}

// ---------- Rewards ----------
// Re-battles the Champion with the player's saved lineup (secret seed, 3 attempts) so an edited save alone can't claim it
async function verifyChampion(env, cid, data, champs) {
  const t = E.TRAINERS[champs * 13 - 1];
  const side = (data.team || []).filter(n => data.box && data.box[n]).map(n => ({ num: n, grade: data.box[n].grade || 0 }));
  if (!t || !side.length) return false;
  for (let i = 0; i < 3; i++) if (E.battle(side, E.trainerTeam(t), E.mulberry32(await secretSeed(env, `verify|${cid}|${champs}|${i}`)), false).win) return true;
  return false;
}
async function rewardsFor(env, cid) {
  const player = await env.DB.prepare("SELECT first_seen, eligible_at, banned, open_flags FROM players WHERE cid = ?").bind(cid).first();
  const saved = await env.DB.prepare("SELECT data FROM saves WHERE cid = ?").bind(cid).first();
  const data = saved ? JSON.parse(saved.data) : {};
  const champs = Math.floor((data.beaten || 0) / 13);
  for (const m of REWARDS.milestones) if (champs >= m.champs)
    await env.DB.prepare("INSERT OR IGNORE INTO prizes (cid, kind, ref, pct, label, status, created) VALUES (?, 'milestone', ?, ?, ?, 'needs_eligibility', ?)").bind(cid, m.key, m.pct, m.label, now()).run();
  // Move milestone prizes along: eligibility first, then automatic checks; anything suspicious waits for review
  const open = await env.DB.prepare("SELECT * FROM prizes WHERE cid = ? AND kind = 'milestone' AND status = 'needs_eligibility'").bind(cid).all();
  for (const pz of open.results) {
    if (player.banned) { await setPrize(env, pz.id, "rejected", "Account banned"); continue; }
    if (!player.eligible_at) continue;
    const m = REWARDS.milestones.find(x => x.key === pz.ref);
    const reasons = [];
    if (player.open_flags) reasons.push(`${player.open_flags} anti-cheat flag(s)`);
    if (daysSince(player.first_seen) < REWARDS.milestoneMinAccountDays) reasons.push("account younger than " + REWARDS.milestoneMinAccountDays + " days");
    if (!(await verifyChampion(env, cid, data, m.champs))) reasons.push("saved lineup could not re-beat the Champion");
    if (reasons.length) await setPrize(env, pz.id, "review", reasons.join("; "));
    else await issue(env, pz);
  }
  const prizes = await env.DB.prepare("SELECT kind, ref, pct, label, status, code, expires FROM prizes WHERE cid = ? ORDER BY id DESC").bind(cid).all();
  return {
    config: { monthly: REWARDS.monthly, milestones: REWARDS.milestones, minSubtotal: REWARDS.minSubtotal, maxOff: REWARDS.maxOff, days: REWARDS.days, monthlyMinDays: REWARDS.monthlyMinDays },
    eligible: !!player.eligible_at, banned: !!player.banned, champs,
    prizes: prizes.results.map(p => ({ ...p, code: p.status === "issued" ? p.code : null })),
  };
}
const setPrize = (env, id, status, note) => env.DB.prepare("UPDATE prizes SET status = ?, note = ? WHERE id = ?").bind(status, note || null, id).run();

// Creates the Shopify discount: single use, this customer only, $X minimum, expires in N days
async function issue(env, pz) {
  if (!env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET) { await setPrize(env, pz.id, "review", "Shopify app not connected yet"); return false; }
  try {
    const readJSON = async (step, r) => { const t = await r.text(); try { return JSON.parse(t); } catch { throw new Error(`${step} HTTP ${r.status}: ${t.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300)}`); } };
    const tok = await readJSON("token", await fetch(`https://${SHOP}.myshopify.com/admin/oauth/access_token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: env.SHOPIFY_CLIENT_ID.trim(), client_secret: env.SHOPIFY_CLIENT_SECRET.trim() }) }));
    if (!tok.access_token) throw new Error("token: " + JSON.stringify(tok).slice(0, 200));
    const rand = [...crypto.getRandomValues(new Uint8Array(6))].map(b => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[b % 32]).join("");
    const code = `PDX-${pz.pct}-${rand}`, starts = now(), ends = new Date(Date.now() + REWARDS.days * 864e5).toISOString();
    // A code backed by the app's capped-reward discount function: pct% off, capped at maxOff, $minSubtotal minimum
    const q = `mutation($d: DiscountCodeAppInput!) { discountCodeAppCreate(codeAppDiscount: $d) { codeAppDiscount { discountId } userErrors { field message } } }`;
    const d = { title: `Pokédex Pack Draft reward: ${pz.label} (${pz.pct}% off, max $${REWARDS.maxOff})`, code, startsAt: starts, endsAt: ends,
      functionHandle: "capped-reward", discountClasses: ["ORDER"],
      context: { customers: { add: [`gid://shopify/Customer/${pz.cid}`] } },
      usageLimit: 1, appliesOncePerCustomer: true,
      metafields: [{ namespace: "$app", key: "config", type: "json", value: JSON.stringify({ pct: pz.pct, cap: REWARDS.maxOff, min: REWARDS.minSubtotal }) }] };
    const r = await fetch(`https://${SHOP}.myshopify.com/admin/api/2026-07/graphql.json`, { method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": tok.access_token }, body: JSON.stringify({ query: q, variables: { d } }) }).then(r => readJSON("graphql", r));
    const errs = (r.errors || []).concat(r.data && r.data.discountCodeAppCreate ? r.data.discountCodeAppCreate.userErrors : []);
    if (errs.length || !r.data) throw new Error(JSON.stringify(errs).slice(0, 300));
    await env.DB.prepare("UPDATE prizes SET status = 'issued', code = ?, issued = ?, expires = ?, note = NULL WHERE id = ?").bind(code, starts, ends, pz.id).run();
    return true;
  } catch (e) { await setPrize(env, pz.id, "review", "Code creation failed: " + String(e.message || e).slice(0, 300)); return false; }
}

// Monthly top 3 among eligible, unbanned players who played enough days; always held for your review
async function monthlyPrizes(env, monthDay) {
  const mo = E.challengeMonth(monthDay || E.challengeDay(new Date(Date.now() - 864e5)));
  const cutoff = new Date(Date.parse(mo.end + "T23:59:59Z") - REWARDS.monthlyMinAccountDays * 864e5).toISOString();
  const top = await env.DB.prepare(`SELECT s.cid, SUM(s.best) AS total, SUM(s.stars) AS stars, COUNT(*) AS days
      FROM scores s JOIN players p ON p.cid = s.cid
      WHERE s.day BETWEEN ? AND ? AND p.eligible_at IS NOT NULL AND p.banned = 0 AND p.first_seen <= ?
      GROUP BY s.cid HAVING COUNT(*) >= ? ORDER BY total DESC, stars DESC, MAX(s.at) ASC LIMIT 3`).bind(mo.start, mo.end, cutoff, REWARDS.monthlyMinDays).all();
  const monthName = new Date(mo.start + "T12:00:00Z").toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  const out = [];
  for (const [i, r] of top.results.entries()) {
    const w = REWARDS.monthly[i];
    await env.DB.prepare("INSERT OR IGNORE INTO prizes (cid, kind, ref, pct, label, status, note, created) VALUES (?, 'monthly', ?, ?, ?, 'review', ?, ?)")
      .bind(r.cid, mo.key, w.pct, `#${w.place} for ${monthName}`, `${r.total} pts, ${r.days} days, ${r.stars} stars`, now()).run();
    out.push({ place: w.place, cid: r.cid, total: r.total, days: r.days });
  }
  return { month: mo, winners: out };
}

// ---------- Admin (Bearer ADMIN_TOKEN; used by cloud/admin.sh) ----------
async function admin(req, env, path) {
  const j = (o, s = 200) => new Response(JSON.stringify(o, null, 2), { status: s, headers: { "Content-Type": "application/json" } });
  const auth = (req.headers.get("Authorization") || "").replace(/^Bearer /, "");
  const enc = new TextEncoder(), a = enc.encode(auth), b = enc.encode(env.ADMIN_TOKEN || "");
  if (!env.ADMIN_TOKEN || a.length !== b.length || !crypto.subtle.timingSafeEqual(a, b)) return j({ error: "unauthorized" }, 401);
  let body = {};
  try { body = await req.json(); } catch {}
  const player = async cid => ({
    player: await env.DB.prepare("SELECT * FROM players WHERE cid = ?").bind(cid).first(),
    recentFlags: (await env.DB.prepare("SELECT at, flags, dex_n, packs, bag_n, beaten, legends, max_lvl FROM audit WHERE cid = ? AND flags IS NOT NULL ORDER BY id DESC LIMIT 10").bind(cid).all()).results,
    latest: await env.DB.prepare("SELECT at, dex_n, packs, bag_n, beaten, rare, legends, max_lvl FROM audit WHERE cid = ? ORDER BY id DESC LIMIT 1").bind(cid).first(),
    admin: `https://admin.shopify.com/store/${SHOP}/customers/${cid}`,
  });
  if (path === "/admin/pending") {
    const rows = (await env.DB.prepare("SELECT * FROM prizes WHERE status IN ('review') ORDER BY id").all()).results;
    return j(await Promise.all(rows.map(async r => ({ prize: r, ...(await player(r.cid)) }))));
  }
  if (path === "/admin/prizes") return j((await env.DB.prepare("SELECT * FROM prizes ORDER BY id DESC LIMIT 50").all()).results);
  if (path === "/admin/player") return j(await player(String(body.cid)));
  if (path === "/admin/approve") {
    const pz = await env.DB.prepare("SELECT * FROM prizes WHERE id = ? AND status IN ('review','needs_eligibility')").bind(body.id).first();
    if (!pz) return j({ error: "no such prize awaiting review" }, 404);
    const ok = await issue(env, pz);
    return j(await env.DB.prepare("SELECT * FROM prizes WHERE id = ?").bind(body.id).first(), ok ? 200 : 502);
  }
  if (path === "/admin/reject") { await setPrize(env, body.id, "rejected", body.reason || "Rejected in review"); return j({ ok: true }); }
  if (path === "/admin/clear-flags") { await env.DB.prepare("UPDATE players SET open_flags = 0, note = ? WHERE cid = ?").bind(body.note || "Reviewed", String(body.cid)).run(); return j({ ok: true }); }
  if (path === "/admin/ban") {
    await env.DB.prepare("UPDATE players SET banned = 1, note = ? WHERE cid = ?").bind(body.reason || "Banned", String(body.cid)).run();
    await env.DB.prepare("DELETE FROM scores WHERE cid = ?").bind(String(body.cid)).run(); // off the leaderboards
    await env.DB.prepare("UPDATE prizes SET status = 'rejected', note = 'Account banned' WHERE cid = ? AND status != 'issued'").bind(String(body.cid)).run();
    return j({ ok: true });
  }
  if (path === "/admin/run-monthly") return j(await monthlyPrizes(env, body.day));
  if (path === "/admin/check-secrets") { // describes the stored Shopify credentials without revealing them
    const shape = v => v == null ? null : { length: v.length, trimmedLength: v.trim().length, startsWithShpss: v.trim().startsWith("shpss_"),
      hasWhitespace: /\s/.test(v), hasQuotes: /["'`]/.test(v), looksHex32: /^[0-9a-f]{32}$/.test(v.trim()) };
    return j({ clientId: shape(env.SHOPIFY_CLIENT_ID), clientSecret: shape(env.SHOPIFY_CLIENT_SECRET),
      secretEqualsClientId: !!env.SHOPIFY_CLIENT_ID && env.SHOPIFY_CLIENT_ID.trim() === (env.SHOPIFY_CLIENT_SECRET || "").trim() });
  }
  if (path === "/admin/test-code") { // checks the Shopify connection by issuing a 5% test code to a customer you choose
    const cid = String(body.cid);
    await env.DB.prepare("INSERT OR IGNORE INTO prizes (cid, kind, ref, pct, label, status, created) VALUES (?, 'test', ?, 5, 'Setup test', 'review', ?)").bind(cid, now(), now()).run();
    const pz = await env.DB.prepare("SELECT * FROM prizes WHERE cid = ? AND kind = 'test' ORDER BY id DESC LIMIT 1").bind(cid).first();
    await issue(env, pz);
    return j(await env.DB.prepare("SELECT * FROM prizes WHERE id = ?").bind(pz.id).first());
  }
  return j({ error: "not_found" }, 404);
}
