// Odds check: node build/balance.js
globalThis.window = globalThis;
require("../dex.js"); require("../evo.js"); require("../engine.js");
const E = globalThis.ENGINE;
const { DEX, byNum, TRAINERS, trainerTeam, winChance, evosOf, dailyChallenge } = E;
const rnd = a => a[Math.floor(Math.random() * a.length)];
const tierPool = t => DEX.filter(m => m.tier === t);
function pack() { const r = Math.random(); const hit = r < .05 ? 3 : r < .3 ? 2 : 1; return [0,0,0,1,hit].map(t => rnd(tierPool(t))); }
// evolve along the line as far as the level allows
function grow(num, lvl) { for (;;) { const e = evosOf(num).filter(x => x.lvl <= lvl); if (!e.length) return num; num = rnd(e).to; } }
function playerTeam(packs, lvl) {
  const kept = []; for (let i = 0; i < packs; i++) kept.push(pack().sort((a, b) => b.bst - a.bst)[0].num);
  return kept.map(n => grow(n, lvl)).sort((a, b) => byNum(b).bst - byNum(a).bst).slice(0, 6).map(num => ({ num, lvl }));
}
console.log("Brock with a Lv8 Charmander alone:", winChance([{ num: 4, lvl: 8 }], trainerTeam(TRAINERS[0]), 400).toFixed(2));
console.log("Brock with Charmander Lv8 + 6 Lv5 pulls:", winChance([{ num: 4, lvl: 8 }, ...playerTeam(6, 5).slice(0, 5)], trainerTeam(TRAINERS[0]), 400).toFixed(2));
console.log("\nidx trainer            L  size | win% team at L-3 / L / L+3  (packs ~ 6 + 2.5*idx)");
for (const t of TRAINERS) {
  if (t.k % 4 !== 0 && t.kind !== "champ") continue;
  const packs = Math.round(6 + 2.5 * t.idx), opp = trainerTeam(t);
  const w = [-3, 0, 3].map(d => { let s = 0; for (let i = 0; i < 6; i++) s += winChance(playerTeam(packs, Math.max(5, t.level + d)), opp, 40); return Math.round(s / 6 * 100); });
  console.log(String(t.idx).padStart(3), (t.region.name + " " + t.name).padEnd(20), String(t.level).padStart(2), String(t.size).padStart(4), " |", w.join(" / "), " ", opp.map(o => byNum(o.num).name).join(", "));
}
let rent = 0, strong = 0, n = 0;
for (let d = 1; d <= 30; d++) {
  const c = dailyChallenge(`2026-10-${String(d).padStart(2, "0")}`);
  rent += winChance(c.rentals.map(num => ({ num, lvl: 50 })), c.team, 60);
  const best = DEX.filter(m => c.rule.ok(m)).filter(() => Math.random() < .25).sort((a, b) => b.bst - a.bst).slice(0, 6).map(m => ({ num: m.num, lvl: 50 }));
  const team = [...best, ...c.rentals.map(num => ({ num, lvl: 50 }))].slice(0, 6);
  strong += winChance(team, c.team, 60); n++;
}
console.log(`\nDaily Challenge over 30 days: rentals only win ${Math.round(rent / n * 100)}%, a 25%-complete Pokédex's best 6 win ${Math.round(strong / n * 100)}%`);
