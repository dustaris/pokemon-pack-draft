// Builds Daily Puzzles ahead of time and writes them to D1 (the boss order stays secret in the database).
//   node puzzles.js 2026-09-28 400          -> writes puzzles.sql for 400 days starting that date
//   npx wrangler d1 execute pokedex-saves --remote --file puzzles.sql
// A day is accepted when its best order wins, at most 2 orders tie for best, and 3%–45% of the 720 orders win.
const crypto = require("crypto");
globalThis.window = globalThis;
require("../dex.js"); require("../evo.js"); require("../engine.js");
const E = globalThis.ENGINE, { DEX, byNum, dailyChallenge, puzzleBattle, challengeScore, permutations, mulberry32, hashStr } = E;
const EVO = globalThis.EVO;
const finalForm = m => !EVO[m.num];
const shuffle = (a, rnd) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const draw = (pool, n, rnd) => shuffle(pool, rnd).slice(0, n).map(m => m.num);

function evaluate(roster, bossOrder) {
  const raws = permutations(roster).map(o => challengeScore(puzzleBattle(o, bossOrder, false)));
  const best = Math.max(...raws);
  return { best, bestCount: raws.filter(r => r === best).length, winFrac: raws.filter(r => r >= 50).length / raws.length };
}
const good = v => v.best >= 50 && v.bestCount <= 2 && v.winFrac >= 0.03 && v.winFrac <= 0.45;

function build(day) {
  const base = dailyChallenge(day); // public theme + boss trainer
  for (let attempt = 0; attempt < 80; attempt++) {
    const rnd = mulberry32(hashStr(`puzzle-${day}-${attempt}`));
    const ok = attempt < 50 ? base.rule.ok : (m => !m.legend); // themes that never work fall back to "No Legendaries"
    const label = attempt < 50 ? base.rule.label : "No Legendaries";
    const rosterPool = DEX.filter(m => ok(m) && !m.legend && finalForm(m) && m.bst >= 430 && m.bst <= 525);
    const bossTyped = m => !base.boss.type || m.types.includes(base.boss.type);
    let bossPool = DEX.filter(m => !m.legend && finalForm(m) && m.bst >= 450 && m.bst <= 540 && bossTyped(m));
    if (bossPool.length < 6) bossPool = DEX.filter(m => !m.legend && finalForm(m) && m.bst >= 450 && m.bst <= 540);
    if (rosterPool.length < 6) continue;
    const roster = draw(rosterPool, 6, rnd), boss = draw(bossPool, 6, rnd);
    // Pick the boss order secretly: random, not derived from anything public
    const orders = shuffle(permutations(boss), () => crypto.randomInt(1 << 30) / (1 << 30)).slice(0, 40);
    for (const bossOrder of orders) {
      const v = evaluate(roster, bossOrder);
      if (good(v)) return { day, n: base.n, label, boss: base.boss, roster: roster.sort((a, b) => a - b), bossSet: boss.slice().sort((a, b) => a - b), bossOrder, ...v };
    }
  }
  throw new Error("no puzzle for " + day);
}

if (require.main === module) {
  const [start, count] = [process.argv[2], +(process.argv[3] || 30)];
  const q = s => "'" + String(s).replace(/'/g, "''") + "'";
  const rows = [];
  const t0 = Date.now();
  for (let i = 0; i < count; i++) {
    const d = new Date(start + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + i);
    const day = d.toISOString().slice(0, 10), p = build(day);
    rows.push(`INSERT OR REPLACE INTO puzzles VALUES (${q(p.day)}, ${p.n}, ${q(p.label)}, ${q(p.boss.name)}, ${q(p.boss.title)}, ${q(p.boss.region)}, ${q(JSON.stringify(p.roster))}, ${q(JSON.stringify(p.bossSet))}, ${q(JSON.stringify(p.bossOrder))}, ${p.best}, ${p.bestCount}, ${p.winFrac.toFixed(4)});`);
    if (i < 5 || i % 50 === 0) console.error(day, p.label.padEnd(26), "best", p.best, "x" + p.bestCount, "win%", Math.round(p.winFrac * 100), `(${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }
  require("fs").writeFileSync(__dirname + "/puzzles.sql", rows.join("\n") + "\n");
  console.error(`wrote ${rows.length} puzzles to puzzles.sql`);
}
module.exports = { build };
