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
const BLOCK = /(fuck|shit|bitch|cunt|nigg|fag|dick|cock|pussy|slut|whore|rape|nazi|hitler|porn|sex)/i;
// Reads number-for-letter swaps (sh1t, 4ss) before checking the blocklist
const LEET = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t", 8: "b", 9: "g" };
const plain = n => n.toLowerCase().replace(/[0-9]/g, d => LEET[d] || "").replace(/[^a-z]/g, "");
const cleanName = n => (typeof n === "string" && /^[A-Za-z0-9][A-Za-z0-9 ._-]{1,15}$/.test(n.trim()) && !BLOCK.test(plain(n))) ? n.trim() : null;
const TOKEN_MAX_AGE = 7 * 86400; // seconds; the page mints a fresh token on every load
const SHOP = "1marss-2m";
const STORE = "https://wdcardshop.com";

// WD Card Shop rewards. Codes are single-use, locked to the winner's customer account, and expire.
// Prize cards in packs (signed-in players who joined rewards). Checked rarest first against one secret roll per pack.
const PACK_PRIZES = [
  { key: "credit20", odds: 1 / 500, type: "credit", amount: 20, label: "$20 store credit" },
  { key: "credit5", odds: 1 / 100, type: "credit", amount: 5, label: "$5 store credit" },
  { key: "code5", odds: 1 / 25, type: "code", pct: 5, label: "5% off your order" },
];
// Shop staff accounts (Shopify customer ids) that see the testing tools (Reset save, Test prizes)
const STAFF_CIDS = ["8534366486766"];
const PACKS_CFG = {
  dailyChances: 3, subscriberChances: 3,  // Golden Ticket chances come with packs: 3 when the daily packs are claimed, 3 once for subscribers, plus pack codes; they stay until used
  creditBudget: 150,                                      // max store credit awarded per calendar month (Pacific); after that, no credit prizes
  creditExpiresDays: 90,
  creditMinAccountDays: 7,                                // newer accounts' credit prizes wait for your review
};
const REWARDS = {
  monthly: [{ place: 1, pct: 20 }, { place: 2, pct: 15 }, { place: 3, pct: 10 }], // most collection points gained that month
  featured: 15,                                                                       // Showcase of the Month, picked by you
  sets: [],                                             // set-completion rewards retired 2026-09-28
  shiny: [],                                            // secret 10-Shiny reward: off while the game focuses on pack prizes
  monthlyEnabled: false,                                // monthly collectors + Showcase of the Month: off for now (flip to true to resume)
  minSubtotal: 25, maxOff: 50, days: 30, // every code: $25+ order, never more than $50 off (enforced by the capped-reward function)
  monthlyMinDays: 10,        // days the game saved that month
  monthlyMinAccountDays: 7,  // account first seen at least this many days before the month ends
  milestoneMinAccountDays: 7,
};
const now = () => new Date().toISOString();
const daysSince = iso => (Date.now() - Date.parse(iso)) / 864e5;
const MAX_BYTES = 256 * 1024;

export default {
  // The 1st of each month just after midnight Pacific: queue last month's top 3 for review
  async scheduled(event, env, ctx) { if (REWARDS.monthlyEnabled) ctx.waitUntil(monthlyPrizes(env)); },
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
    if (req.method !== "POST" || !["/load", "/save", "/leaderboard", "/name", "/rewards", "/eligibility", "/showcase", "/gallery", "/roll", "/redeem", "/reset", "/claim"].includes(path)) return json({ error: "not_found" }, 404);

    const text = await req.text();
    if (text.length > MAX_BYTES) return json({ error: "too_large" }, 413);
    let body;
    try { body = JSON.parse(text); } catch { return json({ error: "bad_json" }, 400); }
    const cid = await verify(body.token, env.PD_SECRET);
    if (path === "/leaderboard") return leaderboard(env, cid, json); // guests may look; cid is null for them
    if (path === "/gallery") return gallery(env, cid, json);
    if (!cid) return json({ error: "unauthorized" }, 401);
    await env.DB.prepare("INSERT OR IGNORE INTO players (cid, first_seen) VALUES (?, ?)").bind(cid, now()).run();
    if (path === "/showcase") return saveShowcase(env, cid, body, json);
    if (path === "/rewards") return json(await rewardsFor(env, cid));
    if (path === "/roll") return json(await rollPack(env, cid));
    if (path === "/redeem") return redeem(env, cid, body, json);
    if (path === "/claim") return json(await claimChances(env, cid));
    if (path === "/reset") { // staff only: wipe the game save; rewards membership, prizes, chances and codes stay
      if (!STAFF_CIDS.includes(cid)) return json({ error: "forbidden" }, 403);
      await env.DB.batch(["saves", "audit", "collection", "month_start", "active_days"].map(t => env.DB.prepare(`DELETE FROM ${t} WHERE cid = ?`).bind(cid)));
      return json({ ok: true });
    }
    if (path === "/eligibility") {
      if (body.over18 !== true || body.us !== true || body.rules !== true) return json({ error: "must_agree" }, 400);
      await env.DB.prepare("UPDATE players SET eligible_at = COALESCE(eligible_at, ?) WHERE cid = ?").bind(now(), cid).run();
      return json(await rewardsFor(env, cid));
    }
    if (path === "/name") {
      const name = cleanName(body.name);
      if (!name) return json({ error: "name_rejected" }, 400);
      await env.DB.prepare("INSERT INTO collection (cid, name) VALUES (?, ?) ON CONFLICT(cid) DO UPDATE SET name = excluded.name").bind(cid, name).run();
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
    if (res.meta.changes === 1) { await audit(env, cid, baseRev + 1, data); await trackCollection(env, cid, data); return json({ rev: baseRev + 1, updatedAt: at }); }
    const row = await current(); // another device saved first
    return json({ error: "conflict", rev: row ? row.rev : 0, updatedAt: row ? row.updated : null, save: row ? JSON.parse(row.data) : null }, 409);
  },
};

// ---------- Collection: score, monthly gains, boards, showcases ----------
const monthKey = () => E.challengeMonth(E.challengeDay()).key;
async function trackCollection(env, cid, data) {
  const score = E.collectionScore(data), month = monthKey(), day = E.challengeDay();
  const prev = await env.DB.prepare("SELECT score FROM collection WHERE cid = ?").bind(cid).first();
  // The first save of a month records where the player started, so the monthly board ranks points gained that month
  await env.DB.prepare("INSERT OR IGNORE INTO month_start (cid, month, start) VALUES (?, ?, ?)").bind(cid, month, prev ? prev.score : 0).run();
  await env.DB.prepare("INSERT OR IGNORE INTO active_days (cid, day) VALUES (?, ?)").bind(cid, day).run();
  await env.DB.prepare(`INSERT INTO collection (cid, score, shinies, caught, updated) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(cid) DO UPDATE SET score = excluded.score, shinies = excluded.shinies, caught = excluded.caught, updated = excluded.updated`)
    .bind(cid, score, E.shinyCount(data), Object.keys(data.dex || {}).length, now()).run();
}
const shownName = r => r.name || `Trainer ${String(r.cid).slice(-4)}`;
async function leaderboard(env, cid, json) {
  const month = monthKey();
  const gains = `SELECT c.cid, c.name, c.score - COALESCE(m.start, 0) AS gain, c.score FROM collection c
    LEFT JOIN month_start m ON m.cid = c.cid AND m.month = ?1 JOIN players p ON p.cid = c.cid
    WHERE p.banned = 0 AND c.updated >= ?2`;
  const since = month + "-01";
  const monthTop = (await env.DB.prepare(`${gains} ORDER BY gain DESC, c.updated ASC LIMIT 20`).bind(month, since).all()).results;
  const allTop = (await env.DB.prepare(`SELECT c.cid, c.name, c.score, c.caught, c.shinies FROM collection c JOIN players p ON p.cid = c.cid WHERE p.banned = 0 ORDER BY c.score DESC LIMIT 20`).all()).results;
  const counts = await env.DB.prepare(`SELECT (SELECT COUNT(*) FROM (${gains})) AS month, (SELECT COUNT(*) FROM collection) AS total`).bind(month, since).first();
  let me = null;
  if (cid) {
    const mine = await env.DB.prepare(`${gains} AND c.cid = ?3`).bind(month, since, cid).first();
    const all = await env.DB.prepare("SELECT score, caught, shinies, name FROM collection WHERE cid = ?").bind(cid).first();
    if (all) {
      const monthRank = mine ? (await env.DB.prepare(`SELECT COUNT(*) AS n FROM (${gains}) WHERE gain > ?3`).bind(month, since, mine.gain).first()).n + 1 : null;
      const allRank = (await env.DB.prepare("SELECT COUNT(*) AS n FROM collection WHERE score > ?").bind(all.score).first()).n + 1;
      me = { name: all.name, score: all.score, caught: all.caught, shinies: all.shinies, gain: mine ? mine.gain : 0, monthRank, allRank };
    }
  }
  return json({ month, players: counts.total, monthPlayers: counts.month,
    monthTop: monthTop.map((r, i) => ({ rank: i + 1, name: shownName(r), gain: r.gain, score: r.score, me: r.cid === cid })),
    allTop: allTop.map((r, i) => ({ rank: i + 1, name: shownName(r), score: r.score, caught: r.caught, shinies: r.shinies, me: r.cid === cid })), me });
}
// Up to 6 cards the player owns, checked against their saved collection
async function saveShowcase(env, cid, body, json) {
  const cards = Array.isArray(body.cards) ? body.cards : [];
  if (cards.length > 6 || new Set(cards).size !== cards.length || !cards.every(n => Number.isInteger(n) && n >= 1 && n <= 1025)) return json({ error: "bad_cards" }, 400);
  const saved = await env.DB.prepare("SELECT data FROM saves WHERE cid = ?").bind(cid).first();
  const data = saved ? JSON.parse(saved.data) : {};
  if (!cards.every(n => data.dex && data.dex[n])) return json({ error: "not_owned" }, 400);
  const show = cards.map(n => { const b = (data.box || {})[n] || {}, d = data.dex[n]; return { num: n, shiny: !!(d.shiny || b.shiny), grade: b.grade || 0 }; });
  await trackCollection(env, cid, data);
  await env.DB.prepare("UPDATE collection SET showcase = ?, showcase_at = ? WHERE cid = ?").bind(show.length ? JSON.stringify(show) : null, now(), cid).run();
  return json({ showcase: show });
}
async function gallery(env, cid, json) {
  const featured = await env.DB.prepare(`SELECT c.cid, c.name, c.score, c.caught, c.showcase, z.ref AS month FROM prizes z JOIN collection c ON c.cid = z.cid
    WHERE z.kind = 'featured' AND z.status != 'rejected' ORDER BY z.id DESC LIMIT 1`).first();
  const rows = (await env.DB.prepare(`SELECT c.cid, c.name, c.score, c.caught, c.showcase FROM collection c JOIN players p ON p.cid = c.cid
    WHERE c.showcase IS NOT NULL AND p.banned = 0 ORDER BY c.score DESC LIMIT 30`).all()).results;
  const out = r => ({ name: shownName(r), score: r.score, caught: r.caught, cards: JSON.parse(r.showcase || "[]"), me: r.cid === cid });
  return json({ featured: featured && featured.showcase ? { ...out(featured), month: featured.month } : null, showcases: rows.map(out) });
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

// ---------- Pack codes: free packs (and optionally Golden Ticket chances), once per account; the server keeps the count so the audit allows them ----------
const REDEEM_FAILS_PER_DAY = 10;
async function redeem(env, cid, body, json) {
  const code = String(body.code || "").trim().toUpperCase().replace(/\s+/g, "");
  const day = E.challengeDay();
  const fails = await env.DB.prepare("SELECT n FROM redeem_fails WHERE cid = ? AND day = ?").bind(cid, day).first();
  if (fails && fails.n >= REDEEM_FAILS_PER_DAY) return json({ error: "too_many_tries" }, 429);
  const fail = async error => {
    await env.DB.prepare("INSERT INTO redeem_fails (cid, day, n) VALUES (?, ?, 1) ON CONFLICT (cid, day) DO UPDATE SET n = n + 1").bind(cid, day).run();
    return json({ error }, 400);
  };
  if (!/^[A-Z0-9-]{3,32}$/.test(code)) return fail("invalid");
  const c = await env.DB.prepare("SELECT * FROM codes WHERE code = ?").bind(code).first();
  if (!c) return fail("invalid");
  if (c.expires && c.expires < now()) return json({ error: "expired" }, 400);
  if (c.max_uses != null && c.uses >= c.max_uses) return json({ error: "used_up" }, 400);
  const done = await env.DB.prepare("INSERT OR IGNORE INTO redemptions (code, cid, at) VALUES (?, ?, ?)").bind(code, cid, now()).run();
  if (!done.meta.changes) return json({ error: "already_redeemed" }, 400);
  await env.DB.batch([
    env.DB.prepare("UPDATE codes SET uses = uses + 1 WHERE code = ?").bind(code),
    env.DB.prepare("UPDATE players SET bonus_packs = bonus_packs + ?, bonus_chances = bonus_chances + ? WHERE cid = ?").bind(c.packs, c.chances || 0, cid),
  ]);
  return json({ code, packs: c.packs, chances: c.chances || 0 });
}

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
  const p = await env.DB.prepare("SELECT first_seen, bonus_packs FROM players WHERE cid = ?").bind(cid).first();
  const days = Math.floor(daysSince(p ? p.first_seen : now())) + 1, bonus = p ? p.bonus_packs || 0 : 0;
  const flags = [];
  if (m.dex > 2 + m.packs * 1.8) flags.push("dex");                                                // more entries than packs + evolutions explain
  if (prev && m.dex - prev.dex_n > (m.packs - prev.packs) + 6) flags.push("dexjump");               // many entries appeared at once
  if (m.packs + m.bag > 15 + days * 8 + m.beaten * 5 + bonus) flags.push("packs");                          // more packs than the calendar allows
  if (m.legends > 3 + m.packs * 0.15) flags.push("legend");                                          // far luckier than the pull rates
  if (m.copies > m.packs + 30 + days * 5) flags.push("grade");                                         // more upgrades than packs + Rare Candy explain
  await env.DB.prepare("INSERT INTO audit (cid, at, rev, dex_n, packs, bag_n, beaten, rare, legends, max_lvl, flags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(cid, now(), rev, m.dex, m.packs, m.bag, m.beaten, m.rare, m.legends, m.copies, flags.join(",") || null).run();
  if (flags.length) await env.DB.prepare("UPDATE players SET open_flags = open_flags + 1 WHERE cid = ?").bind(cid).run();
}

// ---------- Rewards ----------
async function rewardsFor(env, cid) {
  const player = await env.DB.prepare("SELECT first_seen, eligible_at, banned, open_flags, chances, chances_day, sub_bonus, bonus_chances FROM players WHERE cid = ?").bind(cid).first();
  const saved = await env.DB.prepare("SELECT data FROM saves WHERE cid = ?").bind(cid).first();
  const data = saved ? JSON.parse(saved.data) : {};
  const shinies = E.shinyCount(data);
  const add = (kind, ref, pct, label) => env.DB.prepare("INSERT OR IGNORE INTO prizes (cid, kind, ref, pct, label, status, created) VALUES (?, ?, ?, ?, ?, 'needs_eligibility', ?)").bind(cid, kind, ref, pct, label, now()).run();
  for (const st of REWARDS.sets) if (E.regionComplete(data, st)) await add("set", st.key, st.pct, st.label);
  for (const g of REWARDS.shiny) if (shinies >= g.count) await add("shiny", g.key, g.pct, `Collect ${g.count} Shiny Pokémon`);
  // Milestones move along automatically: eligibility first, then checks; anything suspicious waits for your review
  const open = await env.DB.prepare("SELECT * FROM prizes WHERE cid = ? AND kind IN ('set', 'shiny') AND status = 'needs_eligibility'").bind(cid).all();
  for (const pz of open.results) {
    if (player.banned) { await setPrize(env, pz.id, "rejected", "Account banned"); continue; }
    if (!player.eligible_at) continue;
    const reasons = [];
    if (player.open_flags) reasons.push(`${player.open_flags} anti-cheat flag(s)`);
    if (daysSince(player.first_seen) < REWARDS.milestoneMinAccountDays) reasons.push("account younger than " + REWARDS.milestoneMinAccountDays + " days");
    if (reasons.length) await setPrize(env, pz.id, "review", reasons.join("; "));
    else await issue(env, pz);
  }
  const prizes = await env.DB.prepare("SELECT kind, ref, pct, amount, label, status, code, expires, created FROM prizes WHERE cid = ? AND kind != 'test' ORDER BY id DESC").bind(cid).all();
  return {
    config: { monthly: REWARDS.monthly, featured: REWARDS.featured, sets: REWARDS.sets.map(({ key, pct, label, lo, hi }) => ({ key, pct, label, lo, hi })), shiny: REWARDS.shiny,
      minSubtotal: REWARDS.minSubtotal, maxOff: REWARDS.maxOff, days: REWARDS.days, monthlyMinDays: REWARDS.monthlyMinDays, monthlyEnabled: REWARDS.monthlyEnabled,
      packPrizes: PACK_PRIZES.map(({ label, odds, type, amount, pct }) => ({ label, odds, type, amount, pct })), creditExpiresDays: PACKS_CFG.creditExpiresDays, dailyChances: PACKS_CFG.dailyChances, subscriberChances: PACKS_CFG.subscriberChances },
    eligible: !!player.eligible_at, banned: !!player.banned, shinies, chances: await chancesFor(env, player), staff: STAFF_CIDS.includes(cid),
    prizes: prizes.results.map(p => ({ ...p, code: p.status === "issued" ? p.code : null })),
  };
}
const setPrize = (env, id, status, note) => env.DB.prepare("UPDATE prizes SET status = ?, note = ? WHERE id = ?").bind(status, note || null, id).run();

// Creates the Shopify discount: single use, this customer only, $X minimum, expires in N days
// ---------- Shopify Admin API ----------
const readJSON = async (step, r) => { const t = await r.text(); try { return JSON.parse(t); } catch { throw new Error(`${step} HTTP ${r.status}: ${t.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300)}`); } };
async function shopifyToken(env) {
  if (!env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET) throw new Error("Shopify app not connected yet");
  const tok = await readJSON("token", await fetch(`https://${SHOP}.myshopify.com/admin/oauth/access_token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: env.SHOPIFY_CLIENT_ID.trim(), client_secret: env.SHOPIFY_CLIENT_SECRET.trim() }) }));
  if (!tok.access_token) throw new Error("token: " + JSON.stringify(tok).slice(0, 200));
  return tok;
}
async function gql(env, query, variables) {
  const tok = await shopifyToken(env);
  const r = await fetch(`https://${SHOP}.myshopify.com/admin/api/2026-07/graphql.json`, { method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": tok.access_token }, body: JSON.stringify({ query, variables }) }).then(r => readJSON("graphql", r));
  if (r.errors && r.errors.length) throw new Error(JSON.stringify(r.errors).slice(0, 300));
  return r.data;
}
// Discount code prize: pct% off, capped at maxOff, $minSubtotal minimum, this customer only, single use
async function issue(env, pz) {
  try {
    const rand = [...crypto.getRandomValues(new Uint8Array(6))].map(b => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[b % 32]).join("");
    const code = `PDX-${pz.pct}-${rand}`, starts = now(), ends = new Date(Date.now() + REWARDS.days * 864e5).toISOString();
    const d = { title: `Pokédex Pack Draft reward: ${pz.label} (${pz.pct}% off, max $${REWARDS.maxOff})`, code, startsAt: starts, endsAt: ends,
      functionHandle: "capped-reward", discountClasses: ["ORDER"],
      context: { customers: { add: [`gid://shopify/Customer/${pz.cid}`] } },
      usageLimit: 1, appliesOncePerCustomer: true,
      metafields: [{ namespace: "$app", key: "config", type: "json", value: JSON.stringify({ pct: pz.pct, cap: REWARDS.maxOff, min: REWARDS.minSubtotal }) }] };
    const r = await gql(env, `mutation($d: DiscountCodeAppInput!) { discountCodeAppCreate(codeAppDiscount: $d) { codeAppDiscount { discountId } userErrors { field message } } }`, { d });
    if (r.discountCodeAppCreate.userErrors.length) throw new Error(JSON.stringify(r.discountCodeAppCreate.userErrors).slice(0, 300));
    await env.DB.prepare("UPDATE prizes SET status = 'issued', code = ?, issued = ?, expires = ?, note = NULL WHERE id = ?").bind(code, starts, ends, pz.id).run();
    return true;
  } catch (e) { await setPrize(env, pz.id, "review", "Code creation failed: " + String(e.message || e).slice(0, 300)); return false; }
}
// Store credit prize: added to the customer's store credit balance, used automatically at checkout
async function issueCredit(env, pz) {
  try {
    const expires = new Date(Date.now() + PACKS_CFG.creditExpiresDays * 864e5).toISOString().slice(0, 10);
    const r = await gql(env, `mutation($id: ID!, $c: StoreCreditAccountCreditInput!) { storeCreditAccountCredit(id: $id, creditInput: $c) { storeCreditAccountTransaction { amount { amount } } userErrors { field message } } }`,
      { id: `gid://shopify/Customer/${pz.cid}`, c: { creditAmount: { amount: Number(pz.amount).toFixed(2), currencyCode: "USD" }, expiresAt: expires, notify: true } });
    if (r.storeCreditAccountCredit.userErrors.length) throw new Error(JSON.stringify(r.storeCreditAccountCredit.userErrors).slice(0, 300));
    await env.DB.prepare("UPDATE prizes SET status = 'issued', issued = ?, expires = ?, note = NULL WHERE id = ?").bind(now(), expires, pz.id).run();
    return true;
  } catch (e) { await setPrize(env, pz.id, "review", "Store credit failed: " + String(e.message || e).slice(0, 300)); return false; }
}
const issueAny = (env, pz) => pz.amount > 0 ? issueCredit(env, pz) : issue(env, pz);
async function isSubscribed(env, cid) {
  try {
    const r = await gql(env, `query($id: ID!) { customer(id: $id) { emailMarketingConsent { marketingState } } }`, { id: `gid://shopify/Customer/${cid}` });
    return !!(r.customer && r.customer.emailMarketingConsent && r.customer.emailMarketingConsent.marketingState === "SUBSCRIBED");
  } catch { return false; }
}

// ---------- Prize cards in packs ----------
// One roll per opened pack, while the player has prize chances. The server decides; the game only shows the result.
async function rollPack(env, cid) {
  const p = await env.DB.prepare("SELECT first_seen, eligible_at, banned, open_flags, chances, chances_day, sub_bonus, bonus_chances FROM players WHERE cid = ?").bind(cid).first();
  if (!p || !p.eligible_at || p.banned) return { eligible: false, banned: !!(p && p.banned) };
  const day = E.challengeDay();
  let prize = null, bonus = p.bonus_chances || 0; // one pool of chances, filled when packs are claimed; kept until used
  if (bonus > 0) {
    bonus--;
    const r = crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
    let acc = 0, hit = null;
    for (const pr of PACK_PRIZES) { acc += pr.odds; if (r < acc) { hit = pr; break; } }
    if (hit && hit.type === "credit") { // monthly store-credit budget
      const start = E.challengeMonth(day).start;
      const used = await env.DB.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM prizes WHERE kind = 'pack' AND amount > 0 AND status != 'rejected' AND created >= ?").bind(start).first();
      if (used.s + hit.amount > PACKS_CFG.creditBudget) hit = null;
    }
    if (hit) {
      const ref = crypto.randomUUID();
      await env.DB.prepare("INSERT INTO prizes (cid, kind, ref, pct, amount, label, status, created) VALUES (?, 'pack', ?, ?, ?, ?, 'pending', ?)")
        .bind(cid, ref, hit.pct || 0, hit.amount || 0, hit.label, now()).run();
      const pz = await env.DB.prepare("SELECT * FROM prizes WHERE cid = ? AND kind = 'pack' AND ref = ?").bind(cid, ref).first();
      const hold = hit.type === "credit" && (p.open_flags || daysSince(p.first_seen) < PACKS_CFG.creditMinAccountDays);
      if (hold) await setPrize(env, pz.id, "review", p.open_flags ? `${p.open_flags} anti-cheat flag(s)` : `account younger than ${PACKS_CFG.creditMinAccountDays} days`);
      else await issueAny(env, pz);
      const done = await env.DB.prepare("SELECT label, pct, amount, status, code, expires FROM prizes WHERE id = ?").bind(pz.id).first();
      prize = { ...done, type: hit.type, code: done.status === "issued" ? done.code : null };
    }
  }
  await env.DB.prepare("UPDATE players SET bonus_chances = ? WHERE cid = ?").bind(bonus, cid).run();
  return { eligible: true, chances: bonus, prize };
}
// Golden Ticket chances waiting to be used (for the game's display)
async function chancesFor(env, p) {
  if (!p || !p.eligible_at) return 0;
  return p.bonus_chances || 0;
}
// Claiming the daily packs adds that day's chances (once per Pacific day); subscribing adds its chances once
async function claimChances(env, cid) {
  const p = await env.DB.prepare("SELECT chances_day, sub_bonus, bonus_chances FROM players WHERE cid = ?").bind(cid).first();
  const day = E.challengeDay();
  let add = 0, sub = p.sub_bonus, claimed = false;
  if (p.chances_day !== day) { add += PACKS_CFG.dailyChances; claimed = true; }
  if (!sub && await isSubscribed(env, cid)) { add += PACKS_CFG.subscriberChances; sub = 1; }
  await env.DB.prepare("UPDATE players SET bonus_chances = bonus_chances + ?, chances_day = ?, sub_bonus = ? WHERE cid = ?").bind(add, claimed ? day : p.chances_day, sub, cid).run();
  return { chances: (p.bonus_chances || 0) + add, added: add };
}

// Monthly top 3 by collection points gained, among eligible, unbanned players active on enough days; always reviewed by you
async function monthlyPrizes(env, monthDay) {
  const mo = E.challengeMonth(monthDay || E.challengeDay(new Date(Date.now() - 864e5)));
  const cutoff = new Date(Date.parse(mo.end + "T23:59:59Z") - REWARDS.monthlyMinAccountDays * 864e5).toISOString();
  // Gain = score at month end (the next month's starting point if it exists, else the current score) minus the month's start
  const top = await env.DB.prepare(`SELECT c.cid, COALESCE(nx.start, c.score) - COALESCE(m.start, 0) AS gain,
      (SELECT COUNT(*) FROM active_days a WHERE a.cid = c.cid AND a.day BETWEEN ?1 AND ?2) AS days
    FROM collection c JOIN players p ON p.cid = c.cid
    LEFT JOIN month_start m ON m.cid = c.cid AND m.month = ?3
    LEFT JOIN month_start nx ON nx.cid = c.cid AND nx.month = ?4
    WHERE p.eligible_at IS NOT NULL AND p.banned = 0 AND p.first_seen <= ?5
    GROUP BY c.cid HAVING days >= ?6 AND gain > 0 ORDER BY gain DESC LIMIT 3`)
    .bind(mo.start, mo.end, mo.key, E.challengeMonth(new Date(Date.parse(mo.end + "T12:00:00Z") + 2 * 864e5).toISOString().slice(0, 10)).key, cutoff, REWARDS.monthlyMinDays).all();
  const monthName = new Date(mo.start + "T12:00:00Z").toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  const out = [];
  for (const [i, r] of top.results.entries()) {
    const w = REWARDS.monthly[i];
    await env.DB.prepare("INSERT OR IGNORE INTO prizes (cid, kind, ref, pct, label, status, note, created) VALUES (?, 'monthly', ?, ?, ?, 'review', ?, ?)")
      .bind(r.cid, mo.key, w.pct, `#${w.place} collector for ${monthName}`, `+${r.gain} points, active ${r.days} days`, now()).run();
    out.push({ place: w.place, cid: r.cid, gain: r.gain, days: r.days });
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
    const ok = await issueAny(env, pz);
    return j(await env.DB.prepare("SELECT * FROM prizes WHERE id = ?").bind(body.id).first(), ok ? 200 : 502);
  }
  if (path === "/admin/reject") { await setPrize(env, body.id, "rejected", body.reason || "Rejected in review"); return j({ ok: true }); }
  if (path === "/admin/clear-flags") { await env.DB.prepare("UPDATE players SET open_flags = 0, note = ? WHERE cid = ?").bind(body.note || "Reviewed", String(body.cid)).run(); return j({ ok: true }); }
  if (path === "/admin/ban") {
    await env.DB.prepare("UPDATE players SET banned = 1, note = ? WHERE cid = ?").bind(body.reason || "Banned", String(body.cid)).run();
    await env.DB.prepare("UPDATE collection SET showcase = NULL WHERE cid = ?").bind(String(body.cid)).run(); // off the gallery (boards skip banned players)
    await env.DB.prepare("UPDATE prizes SET status = 'rejected', note = 'Account banned' WHERE cid = ? AND status != 'issued'").bind(String(body.cid)).run();
    return j({ ok: true });
  }
  if (path === "/admin/run-monthly") return j(await monthlyPrizes(env, body.day));
  if (path === "/admin/feature") { // Showcase of the Month: queues a prize for your review and pins the showcase in the gallery
    const cid = String(body.cid), month = body.day ? E.challengeMonth(body.day).key : monthKey();
    const c = await env.DB.prepare("SELECT showcase FROM collection WHERE cid = ?").bind(cid).first();
    if (!c || !c.showcase) return j({ error: "that player has no showcase" }, 404);
    await env.DB.prepare("INSERT OR IGNORE INTO prizes (cid, kind, ref, pct, label, status, created) VALUES (?, 'featured', ?, ?, ?, 'review', ?)").bind(cid, month, REWARDS.featured, `Showcase of the Month (${month})`, now()).run();
    return j(await env.DB.prepare("SELECT * FROM prizes WHERE cid = ? AND kind = 'featured' AND ref = ?").bind(cid, month).first());
  }
  if (path === "/admin/showcases") return j((await env.DB.prepare("SELECT cid, name, score, caught, shinies, showcase, showcase_at FROM collection WHERE showcase IS NOT NULL ORDER BY score DESC LIMIT 50").all()).results);
  if (path === "/admin/check-scopes") { try { const t = await shopifyToken(env); return j({ scope: t.scope }); } catch (e) { return j({ error: String(e.message || e) }, 502); } }
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
  if (path === "/admin/create-code") { // a pack code: create-code CODE packs [maxUses] [days valid]
    const code = String(body.code || "").trim().toUpperCase();
    const packs = Math.floor(Number(body.packs));
    if (!/^[A-Z0-9-]{3,32}$/.test(code) || !(packs >= 1 && packs <= 100)) return j({ error: "code must be 3-32 letters/numbers/dashes; packs 1-100" }, 400);
    const maxUses = body.maxUses ? Math.floor(Number(body.maxUses)) : null;
    const expires = body.days ? new Date(Date.now() + Number(body.days) * 864e5).toISOString() : null;
    const chances = Math.max(0, Math.min(100, Math.floor(Number(body.chances) || 0))); // Golden Ticket chances that come with the code
    await env.DB.prepare("INSERT INTO codes (code, packs, max_uses, expires, note, created, chances) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (code) DO UPDATE SET packs = excluded.packs, max_uses = excluded.max_uses, expires = excluded.expires, chances = excluded.chances")
      .bind(code, packs, maxUses, expires, body.note || null, now(), chances).run();
    return j(await env.DB.prepare("SELECT * FROM codes WHERE code = ?").bind(code).first());
  }
  if (path === "/admin/whois") { // the Shopify customer behind a customer id (for reviewing prizes)
    try { const r = await gql(env, `query($id: ID!) { customer(id: $id) { email: defaultEmailAddress { emailAddress } firstName lastName createdAt } }`, { id: `gid://shopify/Customer/${body.cid}` }); return j(r.customer); }
    catch (e) { return j({ error: String(e.message || e) }, 502); }
  }
  if (path === "/admin/codes") return j((await env.DB.prepare("SELECT * FROM codes ORDER BY created DESC").all()).results);
  if (path === "/admin/test-credit") { // checks store credit by adding $1 to a customer you choose
    const cid = String(body.cid), t = now();
    await env.DB.prepare("INSERT INTO prizes (cid, kind, ref, pct, amount, label, status, created) VALUES (?, 'test', ?, 0, 1, '$1 store credit (setup test)', 'review', ?)").bind(cid, "credit-" + t, t).run();
    const pz = await env.DB.prepare("SELECT * FROM prizes WHERE cid = ? AND kind = 'test' ORDER BY id DESC LIMIT 1").bind(cid).first();
    await issueCredit(env, pz);
    return j(await env.DB.prepare("SELECT * FROM prizes WHERE id = ?").bind(pz.id).first());
  }
  return j({ error: "not_found" }, 404);
}
